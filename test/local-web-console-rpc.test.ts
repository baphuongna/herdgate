import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { createConsoleRpc } from "../plugin/server/console/rpc.mjs";

const snapshot = { version: "0.9.5", protocol: 22, workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1" }], layouts: [], agents: [] };

type Scenario = (request: Record<string, unknown>, socket: net.Socket) => void;
async function harness(scenario: Scenario) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const request = JSON.parse(buffer.slice(0, nl));
      scenario(request, socket);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    connect: () => net.createConnection({ host: "127.0.0.1", port: address.port }),
    close: async () => { server.close(); await once(server, "close"); },
  };
}
const reply = (socket: net.Socket, request: Record<string, unknown>, result: unknown) => {
  socket.end(JSON.stringify({ id: request.id, result }) + "\n");
};

test("RPC uses only the explicit read allowlist and sends confirmed pane.read shape", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const server = await harness((request, socket) => {
    seen.push(request);
    if (request.method === "session.snapshot") reply(socket, request, { snapshot });
    else reply(socket, request, { read: { pane_id: "w1:p1", text: "ansi", truncated: false, revision: 3 } });
  });
  t.after(server.close);
  const rpc = createConsoleRpc({ connect: server.connect });
  await rpc.snapshot();
  assert.deepEqual(await rpc.readPane("w1:p1"), { pane_id: "w1:p1", text: "ansi", truncated: false, revision: 3 });
  assert.deepEqual(seen.map((r) => [r.method, r.params]), [
    ["session.snapshot", {}],
    ["pane.read", { pane_id: "w1:p1", source: "visible", lines: 120, format: "ansi" }],
  ]);
  assert.equal("call" in rpc, false, "no arbitrary method dispatcher");
  await assert.rejects(rpc.readPane("w1:p2"), /confirmed by the latest snapshot/);
});

test("concurrent snapshots coalesce; last successful snapshot controls pane authorization", async (t) => {
  let snapshotRequests = 0;
  const server = await harness((request, socket) => {
    if (request.method === "pane.read") {
      reply(socket, request, { read: { pane_id: "old", text: "mirror", truncated: false, revision: 1 } });
      return;
    }
    snapshotRequests++;
    const count = snapshotRequests;
    const value = count === 1 || count === 2
      ? { ...snapshot, panes: [{ pane_id: "old" }] }
      : { ...snapshot, panes: [] };
    const send = () => reply(socket, request, { snapshot: value });
    // If the implementation races two refreshes, B responds [] before A returns [old].
    if (count === 2) setTimeout(send, 35);
    else if (count === 3) setTimeout(send, 0);
    else send();
  });
  t.after(server.close);
  let connectorCalls = 0;
  const connect = () => { connectorCalls++; return server.connect(); };
  const rpc = createConsoleRpc({ connect });

  await rpc.snapshot();
  const firstRefresh = rpc.snapshot();
  const secondRefresh = rpc.snapshot();
  let readDuringRefresh: unknown;
  const inFlightRead = rpc.readPane("old").then((value) => { readDuringRefresh = value; }, (error) => { readDuringRefresh = error; });
  const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);
  await inFlightRead;

  assert.equal(snapshotRequests, 2, "two concurrent snapshot callers share one RPC");
  assert.deepEqual(firstResult, secondResult, "coalesced callers receive the same snapshot result");
  assert.deepEqual(readDuringRefresh, { pane_id: "old", text: "mirror", truncated: false, revision: 1 }, "the last confirmed pane remains readable while refresh is pending");
  assert.equal(connectorCalls, 3, "initial snapshot + one coalesced refresh + one pane read");

  const empty = await rpc.snapshot();
  assert.deepEqual(empty.panes, [], "a later successful snapshot replaces the authorization set");
  await assert.rejects(rpc.readPane("old"), /confirmed by the latest snapshot/);
  assert.equal(snapshotRequests, 3);
});

test("failed refresh revokes the previous pane authorization", async (t) => {
  let snapshots = 0;
  let paneReads = 0;
  const server = await harness((request, socket) => {
    if (request.method === "pane.read") paneReads++;
    if (++snapshots === 1) reply(socket, request, { snapshot: { ...snapshot, panes: [{ pane_id: "old" }] } });
    else socket.end(JSON.stringify({ id: request.id, error: { code: "permission_denied", message: "refresh denied" } }) + "\n");
  });
  t.after(server.close);
  const rpc = createConsoleRpc({ connect: server.connect });
  await rpc.snapshot();
  await assert.rejects(rpc.snapshot(), /permission_denied/);
  await assert.rejects(rpc.readPane("old"), /confirmed by the latest snapshot/);
  assert.equal(paneReads, 0, "revoked pane authorization never reaches pane.read");
});

test("reply ID mismatch fails closed", async (t) => {
  const server = await harness((request, socket) => socket.end(JSON.stringify({ id: "wrong", result: { snapshot } }) + "\n"));
  t.after(server.close);
  await assert.rejects(createConsoleRpc({ connect: server.connect }).snapshot(), /reply id mismatch/);
});

test("JSONL split over chunks is reassembled including split UTF-8", async (t) => {
  const server = await harness((request, socket) => {
    const data = Buffer.from(JSON.stringify({ id: request.id, result: { snapshot: { ...snapshot, note: "một" } } }) + "\n");
    const at = data.indexOf(Buffer.from("ộ")) + 1;
    socket.write(data.subarray(0, at));
    setTimeout(() => socket.end(data.subarray(at)), 5);
  });
  t.after(server.close);
  const result = await createConsoleRpc({ connect: server.connect }).snapshot();
  assert.equal(result.note, "một");
});

test("malformed, unterminated and oversized replies fail closed", async (t) => {
  const malformed = await harness((_request, socket) => socket.end("{bad}\n"));
  t.after(malformed.close);
  await assert.rejects(createConsoleRpc({ connect: malformed.connect }).snapshot(), /valid UTF-8 JSON/);
  const unterminated = await harness((_request, socket) => socket.end('{"id":"x","result":{}'));
  t.after(unterminated.close);
  await assert.rejects(createConsoleRpc({ connect: unterminated.connect }).snapshot(), /unterminated/);
  const large = await harness((request, socket) => socket.end(JSON.stringify({ id: request.id, result: { snapshot, padding: "x".repeat(2048) } }) + "\n"));
  t.after(large.close);
  await assert.rejects(createConsoleRpc({ connect: large.connect, maxFrameBytes: 1024 }).snapshot(), /frame too large/);
});

test("deadline closes a stalled connection", async (t) => {
  let client: net.Socket | undefined;
  const server = await harness((_request, _socket) => {});
  t.after(server.close);
  const connect = () => { client = server.connect(); return client; };
  const started = Date.now();
  await assert.rejects(createConsoleRpc({ connect, timeoutMs: 30 }).snapshot(), /timed out/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(client?.destroyed, true);
});

test("permission and connector failures reject without retry", async (t) => {
  let calls = 0;
  const denied = await harness((request, socket) => {
    calls++;
    socket.end(JSON.stringify({ id: request.id, error: { code: "permission_denied", message: "read denied" } }) + "\n");
  });
  t.after(denied.close);
  await assert.rejects(createConsoleRpc({ connect: denied.connect }).snapshot(), /permission_denied/);
  assert.equal(calls, 1);
  await assert.rejects(createConsoleRpc({ connect: () => { throw new Error("EACCES"); } }).snapshot(), /connect failed/);
});

test("unknown operation cannot be requested through the public client", () => {
  const rpc = createConsoleRpc({ connect: () => { throw new Error("must not connect"); } });
  assert.equal("request" in rpc, false);
  assert.equal("call" in rpc, false);
  assert.equal("write" in rpc, false);
});
