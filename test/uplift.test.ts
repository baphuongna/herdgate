/**
 * The uplift after the 25/11 review (spec: docs/specs/2026-11-25-uplift.md).
 *
 * A real cloud, real sockets — the rules, not the plumbing:
 *
 *   - a refusal is said once, on the right leg, with its reason and the client's address —
 *     never the token that was refused — and a flood folds into one summary line;
 *   - an agent's disconnect line says why (code, reason, lifetime) and STILL reads as the
 *     line operations grep (`agent r_x disconnected`);
 *   - the owner can ask the gate how much it is refusing (overview.gate.health);
 *   - `lastSeen` survives a restart and is written at most once a minute per device;
 *   - API answers are never cached, every answer carries the baseline headers, and HSTS is
 *     sent only behind the edge;
 *   - the owner can ring a subscribed device from the admin page, and is told when it cannot.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createECDH, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { startCloud } from "../src/cloud/gateway.ts";
import { State } from "../src/cloud/stores.ts";
import { generateVapidKeys } from "../src/cloud/vapid.ts";
import type { sendPush } from "../src/cloud/push.ts";
import { DeviceSock } from "./util2.ts";

const ACCOUNT = "owner-account-token-UPPER-lower-9";
const OWNER = { authorization: `Bearer ${ACCOUNT}` };
const WEB = new URL("../src/web/", import.meta.url).pathname;
const CF = "cf-connecting-ip";
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { ...OWNER, "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(base + path, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
}

/** A raw websocket leg with client headers (the edge's address header, in trusted-proxy mode). */
function dial(base: string, path: string, headers: Record<string, string> = {}): { ws: WebSocket; opened: Promise<void>; response: Promise<number | null> } {
  const ws = new WebSocket(base.replace("http", "ws") + path, { headers, handshakeTimeout: 5_000 });
  ws.on("error", () => {});
  let upgraded: boolean | null = null;
  let respond: (n: number | null) => void = () => {};
  const response = new Promise<number | null>((res) => { respond = res; });
  ws.on("unexpected-response", (_req, res) => { upgraded = false; respond(res.statusCode ?? 0); });
  const opened = new Promise<void>((res, rej) => {
    ws.once("open", () => { upgraded = true; respond(null); res(); });
    ws.once("unexpected-response", () => rej(new Error("the upgrade was refused before it began")));
    ws.once("error", (e) => { if (upgraded === null) rej(e); });
  });
  opened.catch(() => {}); // a refused upgrade rejects `opened`; `response` carries the status
  return { ws, opened, response };
}

const closedWith = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((res) => ws.once("close", (code, reason) => res({ code, reason: String(reason) })));

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "herdgate-uplift-"));
}

/** One refused hello: open, say the wrong thing, get the close. */
async function refusedHello(base: string, path: string, ip: string, hello: Record<string, unknown>): Promise<{ code: number; reason: string }> {
  const { ws, opened } = dial(base, path, { [CF]: ip });
  await opened;
  const closed = closedWith(ws);
  ws.send(JSON.stringify({ v: 1, t: "hello", ...hello }));
  return closed;
}

test("refusals: said once per reason on the right leg, never with the refused secret, folded under a flood", { timeout: 30_000 }, async () => {
  const dir = tmp();
  const lines: string[] = [];
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), trustedProxy: true, realIpHeader: CF,
    helloTimeoutMs: 300, logBudget: { lines: 20, windowMs: 400 }, log: (l) => lines.push(l),
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    assert.deepEqual(await refusedHello(base, "/v1/agent/ws", "203.0.113.10", { roomToken: "SECRET-room-token-value", info: {} }), { code: 4001, reason: "unknown room token" });
    assert.deepEqual(await refusedHello(base, "/v1/agent/ws", "203.0.113.10", { accountToken: "x" }), { code: 4001, reason: "bad hello" });
    assert.deepEqual(await refusedHello(base, "/v1/device/ws", "203.0.113.11", { device: "d_nope", deviceSecret: "SECRET-device-secret" }), { code: 4001, reason: "unknown device credentials" });
    assert.deepEqual(await refusedHello(base, "/v1/device/ws", "203.0.113.12", { accountToken: "SECRET-account-token" }), { code: 4001, reason: "unknown account token" });
    assert.deepEqual(await refusedHello(base, "/v1/bridge/ws", "203.0.113.13", { bridgeToken: "SECRET-bridge-token" }), { code: 4001, reason: "unknown bridge token" });

    // A client that opens the socket and says nothing: the hello deadline refuses it.
    const made: WebSocket[] = [];
    const silent = dial(base, "/v1/agent/ws", { [CF]: "203.0.113.14" });
    made.push(silent.ws);
    await silent.opened;
    assert.deepEqual(await closedWith(silent.ws), { code: 4001, reason: "hello timeout" });

    // A client over the message budget.
    const loud = dial(base, "/v1/device/ws", { [CF]: "203.0.113.15" });
    made.push(loud.ws);
    await loud.opened;
    const loudClosed = closedWith(loud.ws);
    loud.ws.send(JSON.stringify({ v: 1, t: "hello", accountToken: ACCOUNT, name: "owner" }));
    await delay(30);
    for (let i = 0; i < 300; i++) loud.ws.send(JSON.stringify({ v: 1, t: "frame", payload: { n: i } }));
    assert.deepEqual(await loudClosed, { code: 1008, reason: "rate" });

    // Five bad hellos from one address block it for a minute; the sixth never gets an upgrade.
    for (let i = 0; i < 5; i++) await refusedHello(base, "/v1/agent/ws", "203.0.113.16", { roomToken: "nope" });
    const sixth = dial(base, "/v1/agent/ws", { [CF]: "203.0.113.16" });
    made.push(sixth.ws);
    assert.equal(await sixth.response, 429, "a blocked address is refused before the websocket exists");
    await until(() => lines.includes("refused agent 203.0.113.16 blocked"), "the blocked line");
    loud.ws.terminate();

    const refused = (leg: string, ip: string, reason: string) => lines.includes(`refused ${leg} ${ip} ${reason}`);
    assert.ok(refused("agent", "203.0.113.10", "unknown room token"));
    assert.ok(refused("agent", "203.0.113.10", "bad hello"));
    assert.ok(refused("device", "203.0.113.11", "unknown device credentials"));
    assert.ok(refused("device", "203.0.113.12", "unknown account token"));
    assert.ok(refused("bridge", "203.0.113.13", "unknown bridge token"));
    assert.ok(refused("agent", "203.0.113.14", "hello timeout"));
    assert.ok(refused("device", "203.0.113.15", "rate"));
    assert.ok(refused("agent", "203.0.113.16", "blocked"));
    assert.ok(lines.includes("blocked 203.0.113.16 for 60s after 5 failed hellos"), "the block itself is announced");
    for (const secret of ["SECRET-room-token-value", "SECRET-device-secret", "SECRET-account-token", "SECRET-bridge-token"]) {
      assert.equal(lines.some((l) => l.includes(secret)), false, `no log line carries ${secret}`);
    }
    // One line per refusal: nothing is said twice for the same event.
    assert.equal(lines.filter((l) => l === "refused agent 203.0.113.14 hello timeout").length, 1);

    // A flood: 41 addresses, each refused once. Twenty lines are said, the rest folded.
    await delay(450); // a fresh log window, so the count below is exactly the budget
    const before = (await call(base, "/v1/admin/overview", { headers: OWNER })).body.gate.health.refused.total;
    const flood = Array.from({ length: 41 }, (_, i) => `203.0.113.${200 + i}`);
    const sockets = flood.map((ip) => { const d = dial(base, "/v1/agent/ws", { [CF]: ip }); d.opened.then(() => d.ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: "nope" }))).catch(() => {}); made.push(d.ws); return d; });
    await until(() => lines.some((l) => /^refused: \d+ more suppressed/.test(l)), "the summary line", 4_000);
    const said = lines.filter((l) => /^refused agent 203\.0\.113\.2\d\d unknown room token$/.test(l)).length;
    const folded = Number(lines.find((l) => /^refused: \d+ more suppressed/.test(l))!.match(/\d+/)![0]);
    assert.equal(said, 20, "exactly the budget is said in the window");
    assert.equal(said + folded, 41, "the summary accounts for every silent one");
    const health = (await call(base, "/v1/admin/overview", { headers: OWNER })).body.gate.health;
    assert.equal(health.refused.total - before, 41, "every refusal is counted, said or folded");
    assert.equal(health.refused.hello, 51, "bad hellos and dead tokens: 3 + 1 + 1 + 1 + 5 + 41");
    assert.equal(health.refused.timeout, 1);
    assert.equal(health.refused.rate, 1);
    assert.equal(health.refused.blocked, 1);
    assert.equal(health.blockedNow, 1, "one address is inside its minute");
    assert.equal(health.node, process.version);
    assert.equal(health.ws.agent, 0);
    assert.ok(Number.isInteger(health.ws.device) && health.ws.device >= 0);
    for (const ws of made) ws.terminate();
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent's disconnect line says why — and still reads as the line operations grep", { timeout: 20_000 }, async () => {
  const dir = tmp();
  const lines: string[] = [];
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"), log: (l) => lines.push(l) });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const code = await call(base, "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "laptop-a" }) });
    await call(base, "/v1/agent/approve", post({ code: code.body.code }));
    const roomToken = (await call(base, `/v1/agent/code/${code.body.code}/status`)).body.roomToken as string;

    const hello = async (): Promise<WebSocket> => {
      const { ws, opened } = dial(base, "/v1/agent/ws");
      await opened;
      const first = new Promise<Record<string, unknown>>((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
      ws.send(JSON.stringify({ v: 1, t: "hello", roomToken, info: { name: "LAPTOP-A", version: "t" } }));
      assert.equal((await first).t, "hello");
      return ws;
    };

    // A path that dies without a close frame.
    const cut = await hello();
    await delay(1_100);
    const cutSeen = new Promise<void>((res) => { const t = setInterval(() => { if (lines.some((l) => /disconnected code=1006/.test(l))) { clearInterval(t); res(); } }, 15); });
    cut.terminate();
    await cutSeen;
    // A clean goodbye with a reason of its own.
    const bye = await hello();
    const byeSeen = new Promise<void>((res) => { const t = setInterval(() => { if (lines.some((l) => /disconnected code=1000 reason="going away" after=/.test(l))) { clearInterval(t); res(); } }, 15); });
    await delay(1_050);
    bye.close(1000, "going away");
    await byeSeen;

    const cutLine = lines.find((l) => /disconnected code=1006/.test(l))!;
    assert.match(cutLine, /^agent r_[0-9a-f]+ disconnected code=1006 reason="" after=1s$/, "code, an empty reason, whole seconds");
    assert.match(cutLine, /^agent r_[0-9a-f]+ disconnected/, "the prefix tunnel-ab/compare.sh and laptop-stab/stats.py read is untouched");
    const byeLine = lines.find((l) => /disconnected code=1000/.test(l))!;
    assert.match(byeLine, /^agent r_[0-9a-f]+ disconnected code=1000 reason="going away" after=1s$/);
    assert.equal(lines.filter((l) => /^agent r_[0-9a-f]+ disconnected/.test(l)).length, 2, "one line per disconnect, the detail rides the same line");
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastSeen: written at most once a minute, kept across gate restarts, read back into the roster", { timeout: 20_000 }, async () => {
  const dir = tmp();
  const path = join(dir, "state.json");
  const accounts = [{ id: "a1", name: "owner", token: ACCOUNT }];

  // The store's rule, on its own.
  const st = new State(accounts, path);
  const { room } = st.addRoom("a1", "laptop-a");
  const { device } = st.addDevice(room, "phone", "read");
  assert.equal(st.touchDeviceSeen(device.id, "web"), true, "the first sighting is written");
  const first = JSON.parse(readFileSync(path, "utf8")).devices[0].seen as { at: string; leg: string };
  assert.equal(first.leg, "web");
  assert.ok(Math.abs(Date.now() - Date.parse(first.at)) < 2_000, "the time is now, in ISO form");
  const mtime = statSync(path).mtimeMs;
  assert.equal(st.touchDeviceSeen(device.id, "web"), false, "the same leg, under a minute later: nothing is written");
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.equal(st.touchDeviceSeen(device.id, "ssh"), true, "a change of leg is worth a write");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).devices[0].seen.leg, "ssh");
  assert.equal(st.touchDeviceSeen("d_nope", "web"), false, "an unknown device is not an error");

  // A second device, paired before the gate starts, never written yet.
  const tablet = st.addDevice(room, "tablet", "read");

  // The gateway's legs feed it, and a restart does not forget.
  const cfg = { accounts, statePath: path, webRoot: WEB, log: () => {} };
  const cloud = await startCloud(cfg);
  const seenOf = (id: string): { at: string; leg: string } | undefined =>
    (JSON.parse(readFileSync(path, "utf8")).devices as { id: string; seen?: { at: string; leg: string } }[]).find((d) => d.id === id)?.seen;
  let seenAt = 0;
  try {
    const live = new DeviceSock(`http://127.0.0.1:${cloud.port}`.replace("http", "ws") + "/v1/device/ws");
    assert.equal((await live.hello({ device: tablet.device.id, deviceSecret: tablet.secret })).t, "hello");
    await until(() => seenOf(tablet.device.id)?.leg === "web", "the web leg to be remembered");
    seenAt = Date.parse(seenOf(tablet.device.id)!.at);
    live.close();
  } finally {
    await cloud.close();
  }
  const again = await startCloud(cfg);
  try {
    const o = (await call(`http://127.0.0.1:${again.port}`, "/v1/admin/overview", { headers: OWNER })).body;
    const phone = o.devices.find((d: { id: string }) => d.id === device.id);
    const tab = o.devices.find((d: { id: string }) => d.id === tablet.device.id);
    assert.deepEqual(phone.lastSeen, { leg: "ssh", at: phone.lastSeen.at }, "the phone keeps the leg the store wrote; the restart is not a sighting");
    assert.ok(Math.abs(phone.lastSeen.at - Date.parse(first.at)) < 5_000, "…at the time of that sighting, not of the restart");
    assert.equal(tab.lastSeen.leg, "web");
    assert.ok(Math.abs(tab.lastSeen.at - seenAt) < 5_000, "the tablet's last sighting is the one from before the restart");
    assert.equal(phone.connected, false, "remembered is not connected");
  } finally {
    await again.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A raw request, so the Host and proxy headers are exactly what we choose. */
function raw(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: "GET", headers, signal: AbortSignal.timeout(3000) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

const BASELINE = ["x-content-type-options", "referrer-policy", "permissions-policy"];

test("headers: API answers are never cached, everything carries the baseline, HSTS only behind the edge", { timeout: 20_000 }, async () => {
  const dir = tmp();
  const host = "gate.fixture.invalid";
  const accounts = [{ id: "a1", name: "owner", token: ACCOUNT }];
  const plain = await startCloud({ accounts, statePath: join(dir, "state.json"), webRoot: WEB, expectedHost: host });
  const edge = await startCloud({ accounts, statePath: join(dir, "edge.json"), webRoot: WEB, expectedHost: host, trustedProxy: true, realIpHeader: CF });
  try {
    const p = `http://127.0.0.1:${plain.port}`;
    const e = `http://127.0.0.1:${edge.port}`;
    const H = { Host: host };

    const api = await raw(p, "/v1/admin/overview", { ...H, authorization: `Bearer ${ACCOUNT}` });
    assert.equal(api.status, 200);
    assert.equal(api.headers["cache-control"], "no-store", "an API answer is never cached");
    assert.equal(api.headers["content-type"], "application/json");
    for (const name of BASELINE) assert.ok(api.headers[name], `${name} on the API`);
    assert.equal(api.headers["strict-transport-security"], undefined);

    const refused = await raw(p, "/v1/admin/overview", H);
    assert.equal(refused.status, 401);
    assert.equal(refused.headers["cache-control"], "no-store", "a refusal is not cached either");
    for (const name of BASELINE) assert.ok(refused.headers[name], `${name} on a 401`);

    const shell = await raw(p, "/", H);
    assert.equal(shell.status, 200);
    assert.ok(shell.headers["content-security-policy"], "the PWA shell keeps its CSP");
    for (const name of BASELINE) assert.ok(shell.headers[name], `${name} on the shell`);
    assert.equal(shell.headers["cache-control"], "no-store");

    const missing = await raw(p, "/nope.js", H);
    assert.equal(missing.status, 404);
    for (const name of BASELINE) assert.ok(missing.headers[name], `${name} on a 404`);

    const stray = await raw(p, "/healthz", { Host: "other.fixture.invalid" });
    assert.equal(stray.status, 421);
    for (const name of BASELINE) assert.ok(stray.headers[name], `${name} even on a misdirected request`);
    assert.equal(stray.headers["cache-control"], undefined, "healthz keeps its bare answer");

    // Without trust in a proxy, a client's own x-forwarded-proto is worth nothing.
    const lied = await raw(p, "/healthz", { ...H, "x-forwarded-proto": "https" });
    assert.equal(lied.headers["strict-transport-security"], undefined, "HSTS is not handed out on a client's say-so");

    // Behind the edge: https gets HSTS, plain http does not.
    const viaEdge = await raw(e, "/admin", { ...H, "x-forwarded-proto": "https", [CF]: "203.0.113.9" });
    assert.match(String(viaEdge.headers["strict-transport-security"]), /^max-age=31536000/, "a year of https-only once the edge says https");
    assert.equal(viaEdge.status, 200);
    const viaEdgeHttp = await raw(e, "/admin", { ...H, "x-forwarded-proto": "http", [CF]: "203.0.113.9" });
    assert.equal(viaEdgeHttp.headers["strict-transport-security"], undefined);
  } finally {
    await plain.close();
    await edge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin push-test: the owner rings a subscribed device, and is told when it cannot be rung", { timeout: 20_000 }, async () => {
  const dir = tmp();
  const keys = generateVapidKeys();
  const calls: Parameters<typeof sendPush>[] = [];
  let fail = false;
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }], statePath: join(dir, "state.json"),
    push: { keys, sub: "mailto:test@herdgate.invalid", send: async (...args) => { calls.push(args); if (fail) throw new Error("push provider rejected wake"); } },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  const socks: DeviceSock[] = [];
  try {
    const code = await call(base, "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "laptop-a" }) });
    const approved = await call(base, "/v1/agent/approve", post({ code: code.body.code }));
    const pair = async (name: string): Promise<{ id: string; secret: string }> => {
      const sock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
      await sock.hello({ accountToken: ACCOUNT, name: "owner" });
      await sock.send({ t: "pair.begin", roomId: approved.body.roomId, name, scope: "read" });
      const g = (await sock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };
      socks.push(sock);
      return { id: g.device.id, secret: g.deviceSecret };
    };
    const keyed = await pair("phone-keyed");
    const keyless = await pair("phone-keyless");
    const silent = await pair("phone-unsubscribed");
    const p256dh = createECDH("prime256v1").generateKeys().toString("base64url"); // a real P-256 point, as a browser would send
    const auth = randomBytes(16).toString("base64url");
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    assert.equal((await call(base, "/v1/device/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: keyed.id, deviceSecret: keyed.secret, endpoint, p256dh, auth }) })).status, 200);
    assert.equal((await call(base, "/v1/device/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: keyless.id, deviceSecret: keyless.secret, endpoint }) })).status, 200);

    const ring = (device: string, init: RequestInit = post({ device })) => call(base, "/v1/admin/push-test", init);
    assert.equal((await ring(keyed.id, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401, "the account token, like every owner write");
    assert.equal((await ring(keyed.id, { method: "GET", headers: OWNER })).status, 405);
    assert.equal((await ring("d_nope")).status, 404);
    assert.equal(calls.length, 0, "nothing was sent for a refused request");
    const notSubscribed = await ring(silent.id);
    assert.deepEqual([notSubscribed.status, notSubscribed.body], [409, { ok: false, error: "device has no push subscription" }]);

    const r1 = await ring(keyed.id);
    assert.deepEqual([r1.status, r1.body], [200, { ok: true }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].href, endpoint, "the device's own subscription");
    assert.ok(Buffer.isBuffer(calls[0][3]) && calls[0][3].length > 0, "a keyed subscription gets the encrypted payload");
    assert.equal(calls[0][4], "normal", "a test ring is not urgent");
    const r2 = await ring(keyless.id);
    assert.deepEqual([r2.status, r2.body], [200, { ok: true }]);
    assert.equal(calls[1][3], null, "a keyless subscription gets the silent ping");

    fail = true;
    const r3 = await ring(keyed.id);
    assert.deepEqual([r3.status, r3.body], [502, { ok: false, error: "push provider rejected wake" }], "a provider refusal is the owner's to see, not a hang");

    const events = await call(base, "/v1/admin/events?after=0", { headers: OWNER });
    assert.ok(events.body.items.some((e: { line: string }) => e.line === `push: test wake to ${keyed.id} by owner`), "every ring is on the record");
  } finally {
    for (const s of socks) s.ws.close();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository no longer carries the stray fake-hc.tmp.mjs (committed by mistake in c8af832)", () => {
  assert.throws(() => readFileSync(new URL("../fake-hc.tmp.mjs", import.meta.url)), /ENOENT/, "the file is gone; test/fake-hc.helper.mjs is the one tests use");
  assert.match(readFileSync(new URL("./fake-hc.helper.mjs", import.meta.url), "utf8"), /FAKE_HC_LOG/, "the helper the tests do use is still here");
});
