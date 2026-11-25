/**
 * The owner's admin page, server side (spec: docs/specs/2026-11-25-web-admin.md).
 *
 * A real cloud, a real agent, real device sockets and a real ssh client — the rules, not just
 * the plumbing:
 *
 *   - everything under /v1/admin and every new write is the owner's (account token) alone;
 *   - one overview answers what the page shows, pending pairing codes included;
 *   - the event tail is bounded, incremental, and classified by the log's own prefixes;
 *   - names are validated (no control/format characters, no overlong);
 *   - removing a room cascades: devices go and are kicked, the agent is told it is unpaired
 *     and stops redialing, the room token is dead for good, the state file agrees;
 *   - scope only goes DOWN: an act grant is the host's, the gate withdraws it and kicks the
 *     device's live legs (websocket 4003, every ssh connection), which then re-attach as read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import WebSocket from "ws";

import { startCloud } from "../src/cloud/gateway.ts";
import { EventRing, eventKind } from "../src/cloud/events.ts";
import { State } from "../src/cloud/stores.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import { type AgentAdapter } from "../src/agent/adapter.ts";
import { DeviceSock } from "./util2.ts";

const ACCOUNT = "admin-account-tok";
const OWNER = { authorization: `Bearer ${ACCOUNT}` };
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { ...OWNER, "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

async function pairMachine(base: string, name: string): Promise<{ roomId: string; roomToken: string }> {
  const code = await call(base, "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const approve = await call(base, "/v1/agent/approve", post({ code: code.body.code }));
  assert.equal(approve.status, 200, "the owner approves the code");
  const status = await call(base, `/v1/agent/code/${code.body.code}/status`);
  return { roomId: approve.body.roomId, roomToken: status.body.roomToken as string };
}

async function pairDevice(base: string, roomId: string, name: string, scope: "read" | "act"): Promise<{ sock: DeviceSock; id: string; secret: string }> {
  const sock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
  await sock.hello({ accountToken: ACCOUNT, name: "owner" });
  await sock.send({ t: "pair.begin", roomId, name, scope });
  const granted = (await sock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };
  return { sock, id: granted.device.id, secret: granted.deviceSecret };
}

/** The close (code + reason) a websocket is about to receive. */
const closedWith = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((res) => ws.once("close", (code, reason) => res({ code, reason: String(reason) })));

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "herdgate-admin-"));
}

test("events: the ring is bounded and incremental; kinds come from the log's own prefixes", () => {
  const ring = new EventRing(5);
  for (let i = 0; i < 8; i++) ring.push(`device d_${i} connected`, `2026-11-25T00:00:0${i}.000Z`);
  assert.equal(ring.length, 5, "only the newest `cap` lines survive");
  assert.deepEqual(ring.since(0).map((e) => e.seq), [4, 5, 6, 7, 8], "seq keeps counting past what is kept");
  assert.equal(ring.since(6).length, 2, "`after` yields only the new tail");
  assert.equal(ring.since("x").length, 5, "a non-integer `after` means everything kept");
  assert.equal(ring.since(-1).length, 5, "a negative `after` means everything kept");
  assert.deepEqual([eventKind("room r_1 (host) approved by owner"), eventKind("agent r_1 (host) connected"), eventKind("device d_1 paired to r_1 (read)"), eventKind("ssh: device d_1 authenticated"), eventKind("ssh: listening on :::2299"), eventKind("gate started (v1)"), eventKind("something else")], ["pair", "agent", "device", "ssh", "gate", "gate", "other"]);
  assert.equal(new EventRing(0).cap, 1, "a zero cap still keeps one line");
});

test("admin: the owner's token guards every admin route and write", async () => {
  const dir = tmp();
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const anon = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    for (const [path, init] of [
      ["/v1/admin/overview", undefined],
      ["/v1/admin/events", undefined],
      ["/v1/agent/deny", anon],
      ["/v1/room/rename", anon],
      ["/v1/room/remove", anon],
      ["/v1/device/rename", anon],
      ["/v1/device/scope", anon],
    ] as const) {
      const r = await call(base, path as string, init as RequestInit | undefined);
      assert.equal(r.status, 401, `${path} without the account token`);
    }
    assert.equal((await call(base, "/v1/admin/overview", { method: "POST", ...OWNER, body: "{}" })).status, 405, "overview is a GET");
    assert.equal((await call(base, "/v1/room/remove", { method: "GET", headers: OWNER })).status, 405, "removal is a POST, never a link");
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin: one overview lists rooms, devices, live legs and pending codes with the gate's facts", async () => {
  const dir = tmp();
  const lines: string[] = [];
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), ssh: { port: 0, keyPath: join(dir, "hostkey.json") }, log: (l) => lines.push(l) });
  const base = `http://127.0.0.1:${cloud.port}`;
  let agent: InstanceType<typeof HerdGateAgent> | null = null;
  const socks: DeviceSock[] = [];
  try {
    const machine = await pairMachine(base, "laptop-a");
    const adapter: AgentAdapter = { info: () => ({ name: "LAPTOP-A", version: "0.14.0-test" }), onFrame: () => {}, onDevices: () => {}, onPairAsk: (ask) => ask.scope === "act" };
    agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: machine.roomToken, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const reader = await pairDevice(base, machine.roomId, "phone", "read");
    const actor = await pairDevice(base, machine.roomId, "tablet", "act");
    socks.push(reader.sock, actor.sock);
    // A second machine is asked for but not approved yet: the page must show it waiting.
    const waiting = await call(base, "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "new-host" }) });

    const r = await call(base, "/v1/admin/overview", { headers: OWNER });
    assert.equal(r.status, 200);
    const o = r.body;
    assert.equal(o.gate.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "the gate names its package version");
    assert.ok(o.gate.uptimeSec >= 0 && typeof o.gate.startedAt === "string");
    assert.deepEqual(o.gate.ssh, { enabled: true, publicPort: cloud.ssh!.port }, "the ssh leg's public port is the one clients dial");
    assert.equal(o.gate.push, false);
    assert.equal(o.gate.web, false, "no webRoot configured in this test");
    assert.deepEqual(o.counts, { rooms: 1, devices: 2, agentsOnline: 1, devicesLive: 2, pendingCodes: 1 });
    assert.equal(o.rooms.length, 1);
    assert.deepEqual(o.rooms[0].host, { name: "LAPTOP-A", version: "0.14.0-test" }, "host info is the agent's last hello");
    assert.equal(o.rooms[0].connected, true);
    assert.deepEqual(o.rooms[0].devices, { total: 2, live: 2 });
    assert.deepEqual(o.devices.map((d: { name: string; scope: string; legs: string[]; roomName: string; keys: number; push: boolean; connected: boolean }) => [d.name, d.roomName, d.scope, d.legs, d.keys, d.push, d.connected]).sort(), [["phone", "laptop-a", "read", ["web"], 0, false, true], ["tablet", "laptop-a", "act", ["web"], 0, false, true]]);
    assert.equal(o.pairing.pending.length, 1);
    assert.equal(o.pairing.pending[0].code, waiting.body.code, "the owner sees the code to approve");
    assert.equal(o.pairing.pending[0].hostName, "new-host");
    assert.ok(o.pairing.pending[0].ageSec < 5 && o.pairing.pending[0].expiresIn > 0);
  } finally {
    for (const s of socks) s.ws.close();
    agent?.stop();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin: the event tail is bounded at 300, increments with `after`, and names its kinds", async () => {
  const dir = tmp();
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const machine = await pairMachine(base, "flapper");
    // Each supersede writes two lines ("agent … connected" + the old one's "disconnected").
    for (let i = 0; i < 160; i++) {
      const ws = new WebSocket(`${base.replace("http", "ws")}/v1/agent/ws`);
      await new Promise<void>((res, rej) => {
        ws.once("open", () => ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: machine.roomToken, info: { name: "flapper", version: String(i) } })));
        ws.once("message", (d) => { if (JSON.parse(String(d)).t === "hello") res(); });
        ws.once("error", rej);
      });
      ws.close();
    }
    // The last socket's "disconnected" lands a tick after its close: read until the tail is still.
    let all = await call(base, "/v1/admin/events", { headers: OWNER });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const again = await call(base, "/v1/admin/events", { headers: OWNER });
      if (again.body.latest === all.body.latest) break;
      all = again;
    }
    assert.equal(all.status, 200);
    assert.equal(all.body.capped, 300);
    assert.equal(all.body.items.length, 300, "exactly the ring's capacity, oldest dropped");
    const seqs = all.body.items.map((e: { seq: number }) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: 300 }, (_, i) => seqs[0] + i), "seq is dense and increasing");
    assert.equal(all.body.latest, seqs[299]);
    assert.ok(all.body.items.some((e: { kind: string }) => e.kind === "agent"), "agent lines are classified");
    assert.ok(all.body.items.every((e: { at: string; line: string; kind: string }) => typeof e.at === "string" && typeof e.line === "string" && typeof e.kind === "string"));

    const tail = await call(base, `/v1/admin/events?after=${seqs[297]}`, { headers: OWNER });
    assert.deepEqual(tail.body.items.map((e: { seq: number }) => e.seq), [seqs[298], seqs[299]], "only what came after the cursor");
    assert.equal((await call(base, `/v1/admin/events?after=${seqs[299]}`, { headers: OWNER })).body.items.length, 0, "nothing new is an empty list, not an error");
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin: a machine whose publisher is away says so — online is the agent's socket, nothing else", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  let agent: InstanceType<typeof HerdGateAgent> | null = null;
  try {
    const machine = await pairMachine(base, "ghost");
    const before = (await call(base, "/v1/admin/overview", { headers: OWNER })).body;
    assert.equal(before.counts.agentsOnline, 0, "approved, but nobody is publishing yet");
    assert.equal(before.rooms[0].connected, false);
    assert.equal(before.rooms[0].host, null, "no hello, no host info — honest absence");

    const adapter: AgentAdapter = { info: () => ({ name: "GHOST", version: "1" }), onFrame: () => {}, onDevices: () => {}, onPairAsk: () => true };
    agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: machine.roomToken, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const during = (await call(base, "/v1/admin/overview", { headers: OWNER })).body;
    assert.equal(during.rooms[0].connected, true);
    assert.equal(during.counts.agentsOnline, 1);

    agent.stop();
    agent = null;
    for (let i = 0; i < 100 && (await call(base, "/v1/admin/overview", { headers: OWNER })).body.rooms[0].connected; i++) await new Promise((r) => setTimeout(r, 30));
    const after = (await call(base, "/v1/admin/overview", { headers: OWNER })).body;
    assert.equal(after.rooms[0].connected, false, "the socket closed: offline at once, no heartbeat wait");
    assert.equal(after.counts.agentsOnline, 0);
    assert.equal(after.rooms[0].host.version, "1", "the last hello's host info survives the disconnect");
  } finally {
    agent?.stop();
    await cloud.close();
  }
});

test("admin: first event of a fresh gate says it started", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], log: () => {} });
  try {
    const r = await call(`http://127.0.0.1:${cloud.port}`, "/v1/admin/events", { headers: OWNER });
    assert.equal(r.body.items[0].kind, "gate");
    assert.match(r.body.items[0].line, /^gate started \(v[\d.]+\)$/);
  } finally {
    await cloud.close();
  }
});

test("admin: a pending code can be refused from the page, and is then gone", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const minted = await call(base, "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stranger" }) });
    assert.equal((await call(base, "/v1/agent/deny", post({ code: minted.body.code.toLowerCase() }))).status, 200, "deny matches the code case-insensitively");
    assert.equal((await call(base, "/v1/admin/overview", { headers: OWNER })).body.counts.pendingCodes, 0);
    assert.equal((await call(base, "/v1/agent/approve", post({ code: minted.body.code }))).status, 404, "a refused code can no longer create a room");
    assert.equal((await call(base, "/v1/agent/deny", post({ code: minted.body.code }))).status, 404, "refusing twice is a 404, not a 500");
    const ev = await call(base, "/v1/admin/events", { headers: OWNER });
    assert.ok(ev.body.items.some((e: { line: string }) => e.line === `pairing code ${minted.body.code} denied by owner`), "the refusal is on the record");
  } finally {
    await cloud.close();
  }
});

test("admin: names are validated the same way for rooms and devices", async () => {
  const dir = tmp();
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const socks: DeviceSock[] = [];
  try {
    const machine = await pairMachine(base, "laptop-b");
    const d = await pairDevice(base, machine.roomId, "phone", "read");
    socks.push(d.sock);
    const renameRoom = (name: unknown) => call(base, "/v1/room/rename", post({ room: machine.roomId, name }));
    const renameDev = (name: unknown) => call(base, "/v1/device/rename", post({ device: d.id, name }));

    assert.equal((await renameRoom("  Laptop khác  ")).body.name, "Laptop khác", "trimmed, unicode kept");
    assert.equal((await renameDev("điện thoại")).status, 200);
    for (const bad of ["", "   ", "x".repeat(65), "bell\u0007char", "zero\u200bwidth", "tab\tname", 42, null, undefined]) {
      assert.equal((await renameRoom(bad)).status, 400, `room name rejected: ${JSON.stringify(bad)}`);
      assert.equal((await renameDev(bad)).status, 400, `device name rejected: ${JSON.stringify(bad)}`);
    }
    const o = (await call(base, "/v1/admin/overview", { headers: OWNER })).body;
    assert.equal(o.rooms[0].name, "Laptop khác", "a rejected name changes nothing");
    assert.equal(o.devices[0].name, "điện thoại");
    assert.equal((await call(base, "/v1/room/rename", post({ room: "r_nope", name: "x" }))).status, 404);
    assert.equal((await call(base, "/v1/device/rename", post({ device: "d_nope", name: "x" }))).status, 404);
    // Another account's ids are not this owner's to rename.
    const stranger = await startCloud({ accounts: [{ id: "a2", name: "someone", token: "other-tok" }], log: () => {} });
    try {
      assert.equal((await call(`http://127.0.0.1:${stranger.port}`, "/v1/room/rename", { method: "POST", headers: { authorization: "Bearer other-tok", "content-type": "application/json" }, body: JSON.stringify({ room: machine.roomId, name: "x" }) })).status, 404, "a stranger's cloud has no such room");
    } finally {
      await stranger.close();
    }
  } finally {
    for (const s of socks) s.ws.close();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin: removing a room cascades — devices kicked, agent unpaired and silent, token dead, disk agrees", async () => {
  const dir = tmp();
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), ssh: { port: 0, keyPath: join(dir, "hostkey.json") }, log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const agentLog: string[] = [];
  let agent: InstanceType<typeof HerdGateAgent> | null = null;
  let sshConn: Client | null = null;
  try {
    const machine = await pairMachine(base, "old-machine");
    const adapter: AgentAdapter = { info: () => ({ name: "OLD", version: "1" }), onFrame: () => {}, onDevices: () => {}, onPairAsk: (ask) => ask.scope === "act" };
    agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: machine.roomToken, adapter, backoff: { minMs: 50, maxMs: 100 }, log: (l) => agentLog.push(l) });
    agent.start();
    await agent.firstHello;
    const d = await pairDevice(base, machine.roomId, "phone", "act");
    // Its ssh leg is up too: both legs must end with the room.
    sshConn = new Client();
    await new Promise<void>((res, rej) => {
      sshConn!.on("ready", res).on("error", rej);
      sshConn!.connect({ host: "127.0.0.1", port: cloud.ssh!.port!, username: d.id, password: d.secret, readyTimeout: 8_000 });
    });
    const sshClosed = new Promise<void>((res) => sshConn!.on("close", () => res()));
    const wsClosed = closedWith(d.sock.ws);

    const r = await call(base, "/v1/room/remove", post({ room: machine.roomId }));
    assert.deepEqual([r.status, r.body], [200, { ok: true, devicesRemoved: 1 }]);
    assert.deepEqual(await wsClosed, { code: 4001, reason: "revoked" }, "the device's websocket is closed as a revocation");
    await sshClosed;
    await until(() => agent!.unpaired, "the agent to learn it is unpaired");
    assert.ok(agentLog.some((l) => l.includes("no longer paired")), "the agent says what happened and what to do");
    const retriesBefore = agentLog.filter((l) => l.includes("retry in")).length;
    await new Promise((r) => setTimeout(r, 400)); // two full backoff windows (50–100 ms)
    assert.equal(agentLog.filter((l) => l.includes("retry in")).length, retriesBefore, "no redial was ever scheduled after the refusal");

    // The room token is dead: a fresh hello with it is refused in those exact words.
    const again = new WebSocket(`${base.replace("http", "ws")}/v1/agent/ws`);
    again.on("open", () => again.send(JSON.stringify({ v: 1, t: "hello", roomToken: machine.roomToken, info: { name: "OLD", version: "1" } })));
    again.on("error", () => {});
    const refused = await closedWith(again);
    assert.deepEqual(refused, { code: 4001, reason: "unknown room token" });

    const o = (await call(base, "/v1/admin/overview", { headers: OWNER })).body;
    assert.deepEqual(o.counts, { rooms: 0, devices: 0, agentsOnline: 0, devicesLive: 0, pendingCodes: 0 });
    const disk = new State([{ id: "a1", name: "owner", token: ACCOUNT }], join(dir, "state.json"));
    assert.equal(disk.rooms.length, 0, "the state file has no trace of the room");
    assert.equal(disk.devices.length, 0, "…nor of its devices");
    const ev = (await call(base, "/v1/admin/events", { headers: OWNER })).body;
    assert.ok(ev.items.some((e: { line: string }) => e.line === `room ${machine.roomId} (old-machine) removed by owner with 1 device(s)`), "the removal is on the record");
    assert.equal((await call(base, "/v1/room/remove", post({ room: machine.roomId }))).status, 404, "twice is a 404");
  } finally {
    sshConn?.end();
    agent?.stop();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin: scope only goes down — a withdrawn act device is kicked on both legs and returns as read", async () => {
  const dir = tmp();
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), ssh: { port: 0, keyPath: join(dir, "hostkey.json") }, log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  let agent: InstanceType<typeof HerdGateAgent> | null = null;
  let sshConn: Client | null = null;
  try {
    const machine = await pairMachine(base, "laptop-c");
    const adapter: AgentAdapter = { info: () => ({ name: "LAPTOP-C", version: "1" }), onFrame: () => {}, onDevices: () => {}, onPairAsk: (ask) => ask.scope === "act" };
    agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: machine.roomToken, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const d = await pairDevice(base, machine.roomId, "tablet", "act");
    await until(() => agent!.scopeOf(d.id) === "act", "the host to be told the grant");
    sshConn = new Client();
    await new Promise<void>((res, rej) => {
      sshConn!.on("ready", res).on("error", rej);
      sshConn!.connect({ host: "127.0.0.1", port: cloud.ssh!.port!, username: d.id, password: d.secret, readyTimeout: 8_000 });
    });

    const scope = (body: Record<string, unknown>) => call(base, "/v1/device/scope", post({ device: d.id, ...body }));
    assert.equal((await scope({ scope: "act" })).status, 422, "the gate does not hand out act");
    assert.match((await scope({ scope: "act" })).body.error, /granted by the host at pairing/);
    assert.equal((await scope({ scope: "root" })).status, 400);
    assert.equal((await scope({ scope: "admin" })).status, 400);
    assert.equal((await call(base, "/v1/device/scope", post({ device: "d_nope", scope: "read" }))).status, 404);

    const sshClosed = new Promise<void>((res) => sshConn!.on("close", () => res()));
    const wsClosed = closedWith(d.sock.ws);
    const r = await scope({ scope: "read" });
    assert.deepEqual([r.status, r.body], [200, { ok: true, scope: "read" }]);
    assert.deepEqual(await wsClosed, { code: 4003, reason: "scope changed" }, "not 4001: the device keeps its pairing and simply re-attaches");
    await sshClosed;
    await until(() => agent!.scopeOf(d.id) === "read", "the host to learn the withdrawal");

    // It re-attaches on both legs, as read.
    const back = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    const hello = (await back.hello({ device: d.id, deviceSecret: d.secret })) as unknown as { t: string; device: { scope: string } };
    assert.equal(hello.t, "hello");
    assert.equal(hello.device.scope, "read");
    const ssh2 = new Client();
    await new Promise<void>((res, rej) => {
      ssh2.on("ready", res).on("error", rej);
      ssh2.connect({ host: "127.0.0.1", port: cloud.ssh!.port!, username: d.id, password: d.secret, readyTimeout: 8_000 });
    });
    ssh2.end();
    back.ws.close();

    // Idempotent: withdrawing again is a no-op that kicks nothing.
    const still = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await still.hello({ device: d.id, deviceSecret: d.secret });
    assert.deepEqual(await scope({ scope: "read" }), { status: 200, body: { ok: true, scope: "read" } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(still.ws.readyState, WebSocket.OPEN, "an already-read device is not kicked");
    still.ws.close();
    const disk = new State([{ id: "a1", name: "owner", token: ACCOUNT }], join(dir, "state.json"));
    assert.equal(disk.deviceById(d.id)?.scope, "read", "the withdrawal is on disk");
  } finally {
    sshConn?.end();
    agent?.stop();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
