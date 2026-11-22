import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

const INDEX = new URL("../plugin/server/index.mjs", import.meta.url);
const MOBILE = new URL("../src/host/mobile-tui.ts", import.meta.url);

test("Mobile TUI publisher can authenticate via loopback with its own room token and the public Host", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const publicHost = "mobile.herdgate.invalid";
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== publicHost || req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn, req));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  const timeout = AbortSignal.timeout(4_000);
  const hello = once(ws, "connection", { signal: timeout }).then(([conn]) => once(conn, "message", { signal: timeout }));
  const child = spawn(process.execPath, [MOBILE.pathname], {
    env: { ...process.env, HERDGATE_URL: `https://${publicHost}`, HERDGATE_ROOM_TOKEN: "mobile-fixture-token", HERDGATE_AGENT_LOOPBACK_PORT: String(addr.port) },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    const [data] = await hello;
    const message = JSON.parse(String(data));
    assert.equal(message.t, "hello");
    assert.equal(message.roomToken, "mobile-fixture-token");
    assert.equal(message.info.version, "tui-core-pilot");
  } finally {
    for (const conn of ws.clients) conn.terminate();
    child.kill();
    await exited;
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("publisher can authenticate over loopback while retaining the public gate Host header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-loopback-"));
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const publicHost = "herdgate.invalid";
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== publicHost || req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn, req));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  writeFileSync(join(dir, "herdgate.env"), [
    `HERDGATE_URL=https://${publicHost}`,
    `HERDGATE_AGENT_LOOPBACK_PORT=${addr.port}`,
    "HERDGATE_ROOM_TOKEN=fixture-token",
  ].join("\n"));
  const timeout = AbortSignal.timeout(4_000);
  const hello = once(ws, "connection", { signal: timeout }).then(([conn]) => once(conn, "message", { signal: timeout }));
  const child = spawn(process.execPath, [INDEX.pathname, "serve"], {
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDGATE_PUBLISHER_CHILD: "1" },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    const [data] = await hello;
    const message = JSON.parse(String(data));
    assert.equal(message.t, "hello");
    assert.equal(message.roomToken, "fixture-token");
  } finally {
    child.kill();
    await exited;
    for (const conn of ws.clients) conn.terminate();
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- view freshness cache + push cadence (perf) ----

/** A fake gate: hello with one read device, relayed view ops, frame counter. */
async function fakeGateForView(opts: { freshMs?: number; publishMs?: number; herdrCalls: string }) {
  const dir = mkdtempSync(join(tmpdir(), "hg-viewcache-"));
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const publicHost = "herdgate.invalid";
  const device = { id: "d_perf", name: "perf", scope: "read" };
  const frames: Array<Record<string, unknown>> = [];   // every t:"frame" from the agent
  const views = () => frames.filter((f) => (f.payload as { op?: string })?.op === "view").length;
  ws.on("connection", (conn) => {
    conn.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.t === "hello") {
        conn.send(JSON.stringify({ v: 1, t: "hello", roomId: "r_perf", devices: [device] }));
      } else if (m.t === "frame") {
        frames.push(m);
      }
    });
  });
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== publicHost || req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  // A fake herdr that prints a valid snapshot and logs one line per invocation.
  const fakeBin = join(dir, "herdr-fake");
  writeFileSync(fakeBin, `#!/bin/sh\necho x >> "${opts.herdrCalls}"\nprintf '%s' '{"snapshot":{"workspaces":[],"agents":[],"focused_workspace_id":null}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, "herdgate.env"), [
    `HERDGATE_URL=https://${publicHost}`,
    `HERDGATE_AGENT_LOOPBACK_PORT=${addr.port}`,
    "HERDGATE_ROOM_TOKEN=fixture-token",
  ].join("\n"));
  const child = spawn(process.execPath, [INDEX.pathname, "serve"], {
    // HERDR_BIN_PATH / cadence knobs ride the environment (as the systemd unit does), not the config file.
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDGATE_PUBLISHER_CHILD: "1",
      HERDR_BIN_PATH: fakeBin,
      ...(opts.freshMs !== undefined ? { HERDGATE_SNAPSHOT_FRESH_MS: String(opts.freshMs) } : {}),
      ...(opts.publishMs !== undefined ? { HERDGATE_PUBLISH_MS: String(opts.publishMs) } : {}) },
    stdio: "ignore",
  });
  return { dir, http, ws, frames, views, child, device, async close() {
    child.kill();
    await once(child, "exit");
    for (const conn of ws.clients) conn.terminate();
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("view op inside the freshness window replays the snapshot without another herdr spawn", async () => {
  const calls = join(tmpdir(), `hg-calls-${Date.now()}.log`);
  const gate = await fakeGateForView({ freshMs: 60_000, herdrCalls: calls });
  try {
    await waitFor(() => gate.views() >= 1, 4_000); // initial publish → 1 spawn
    const before = gate.views();
    const conn = firstConn(gate.ws);
    conn.send(JSON.stringify({ v: 1, t: "frame", device: gate.device.id, payload: { op: "view" } }));
    await waitFor(() => gate.views() >= before + 1, 4_000); // replayed from cache
    const lines = readCalls(calls);
    assert.equal(lines, 1, `expected exactly 1 herdr spawn, got ${lines}`);
  } finally { await gate.close(); rmSync(calls, { force: true }); }
});

test("view op past the freshness window falls back to a fresh publish", async () => {
  const calls = join(tmpdir(), `hg-calls-${Date.now()}.log`);
  const gate = await fakeGateForView({ freshMs: 0, herdrCalls: calls, publishMs: 60_000 });
  try {
    await waitFor(() => gate.views() >= 1, 4_000);
    const before = gate.views();
    const conn = firstConn(gate.ws);
    conn.send(JSON.stringify({ v: 1, t: "frame", device: gate.device.id, payload: { op: "view" } }));
    await waitFor(() => gate.views() >= before + 1, 4_000);
    const lines = readCalls(calls);
    assert.ok(lines >= 2, `expired window must spawn again, got ${lines}`);
  } finally { await gate.close(); rmSync(calls, { force: true }); }
});

test("HERDGATE_PUBLISH_MS sets the push cadence", async () => {
  const calls = join(tmpdir(), `hg-calls-${Date.now()}.log`);
  const gate = await fakeGateForView({ publishMs: 2_000, herdrCalls: calls });
  try {
    // minimum clamp is 2s: within ~5s we must see the initial push plus at least one tick.
    await waitFor(() => gate.views() >= 2, 6_000);
    assert.ok(true);
  } finally { await gate.close(); rmSync(calls, { force: true }); }
});

function firstConn(wss: WebSocketServer): import("ws").WebSocket {
  const conn = [...wss.clients][0];
  assert.ok(conn, "publisher not connected");
  return conn;
}
function readCalls(path: string): number {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
}
async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(cond(), "condition never became true");
}
