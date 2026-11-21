/**
 * E2E payloads: the Noise_XX crypto module and its path through the wire.
 *
 * Layers proven here, cheapest first:
 *   1. the canonical module and the PWA copy never drift (byte-equal bodies);
 *   2. Node↔Node handshake + transport (both roles, tamper and counter rejection);
 *   3. the full device → gateway → publisher-crypto → gateway → device loop, with a
 *      real HostChannel driving the same code the plugin's publisher uses.
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import type { AgentAdapter } from "../src/agent/adapter.ts";
import { encode } from "../src/protocol/envelope.ts";

// A plugin .mjs imported from a TS test: fine under Node 22's native TS loader.
const E2E = await import("../plugin/server/e2e.mjs");
const { DeviceChannel, HostChannel, generateKeyPair, fingerprint, b64e, b64d, NOISE_NAME } = E2E;

const PLUGIN_E2E = new URL("../plugin/server/e2e.mjs", import.meta.url).pathname;
const WEB_E2E = new URL("../src/web/e2e.js", import.meta.url).pathname;

const stripHeader = (s: string): string => s.slice(s.indexOf("*/") + 2);

test("e2e: the PWA copy of the crypto module is byte-identical to the plugin's", () => {
  const a = readFileSync(PLUGIN_E2E, "utf8");
  const b = readFileSync(WEB_E2E, "utf8");
  assert.equal(stripHeader(a), stripHeader(b), "plugin/server/e2e.mjs and src/web/e2e.js drifted");
});

const recv = async (produce: Promise<unknown>): Promise<Record<string, unknown>> =>
  (await produce) as Record<string, unknown>;

test("e2e: handshake and transport, both roles, plus tamper and counter rejection", async () => {
  const host = await generateKeyPair();
  const device = await generateKeyPair();
  assert.equal(NOISE_NAME, "Noise_XX_P256_AESGCM_SHA256");
  const hostPin = await fingerprint(host.pub);
  assert.match(hostPin, /^SHA256:/);
  assert.notEqual(hostPin, await fingerprint(host.pub.slice(0, 32)), "the pin covers the whole public key");

  const dev = new DeviceChannel(device);
  const hos = new HostChannel(host);

  const m1 = await recv(dev.begin()); // {op:'e2e.init', e}
  assert.equal(m1.op, undefined);
  const m2 = await hos.acceptInit(m1 as { e: string }); // {e, c}
  const m3 = await dev.acceptReply({ e: (m2 as { e: string }).e, c: (m2 as { c: string }).c }); // {c}
  await hos.acceptFinish({ c: (m3 as { c: string }).c });
  assert.ok(dev.ready() && hos.ready());
  assert.equal(dev.hostFingerprint, hostPin, "the device learns the host fp from the handshake");
  assert.equal(hos.deviceFingerprint, await fingerprint(device.pub));

  // Transport both directions, interleaved.
  const w1 = await dev.send({ op: "view" });
  const got1 = await hos.recv(w1);
  assert.deepEqual(got1, { op: "view" });
  const w2 = await hos.send({ op: "view", view: { n: 1 } });
  const got2 = await dev.recv(w2);
  assert.deepEqual(got2, { op: "view", view: { n: 1 } });

  // Counter: replaying an old frame must fail (nonce reuse detection).
  await assert.rejects(() => dev.recv(w2), /invalid nonce counter/);
  const batch = await Promise.all(Array.from({ length: 12 }, (_, i) => hos.send({ i })));
  assert.deepEqual(batch.map(wire => wire.n), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(await Promise.all(batch.map(wire => dev.recv(wire))), Array.from({ length: 12 }, (_, i) => ({ i })));

  // Tamper with a fresh frame at the expected counter: verify its GCM tag fails.
  const fresh = await hos.send({ op: "view" });
  await assert.rejects(() => dev.recv({ op: fresh.op, c: fresh.c }), /invalid nonce counter/);
  const bytes = b64d(fresh.c);
  bytes[5] ^= 0xff;
  await assert.rejects(() => dev.recv({ ...fresh, c: b64e(bytes) }), /decrypt|operation failed|The operation/i);
  assert.deepEqual(await dev.recv(fresh), { op: "view" });

  // A different static key cannot complete the handshake to the same session.
  const stranger = new DeviceChannel(await generateKeyPair());
  const s1 = await stranger.begin();
  const strangerHost = new HostChannel(host);
  const s2 = await strangerHost.acceptInit(s1);
  const wrong = new DeviceChannel(device);
  const wrongHost = new HostChannel(await generateKeyPair());
  await assert.rejects(() => wrong.begin().then(init => wrongHost.acceptInit(init)).then(reply => wrong.acceptReply(reply, hostPin)), { code: "host-key-changed" });
  assert.equal(wrong.ready(), false);
  const oldPin = b64e(host.pub.slice(0, 8)).replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 12);
  const s3 = await stranger.acceptReply(s2, oldPin);
  assert.equal(stranger.hostFingerprint, hostPin, "existing legacy pin upgrades in place");
  await strangerHost.acceptFinish(s3);
  const rogue = await stranger.send({ op: "view" });
  await assert.rejects(() => hos.recv(rogue), /invalid nonce counter|decrypt|operation failed|The operation/i);
});

test("e2e: session lifetime — usage tracking, rekey predicate, rotation swaps both keys", async () => {
  const { REKEY_AFTER_MESSAGES, REKEY_AFTER_MS, needsRekey } = E2E;
  const host = await generateKeyPair();
  const device = await generateKeyPair();
  const up = async () => {
    const dev = new DeviceChannel(device);
    const hos = new HostChannel(host);
    const m2 = await hos.acceptInit(await dev.begin());
    await hos.acceptFinish(await dev.acceptReply(m2 as { e: string; c: string }));
    return { dev, hos };
  };
  const { dev, hos } = await up();
  assert.ok(needsRekey(dev) === false && needsRekey(hos) === false, "a fresh session needs no rotation");
  assert.equal(dev.handshakeAt > 0 && hos.handshakeAt > 0, true, "the rotation clock starts at ready");
  await dev.send({ op: "ping" });
  await hos.send({ op: "pong" });
  assert.equal(dev.usage(), 1, "usage counts messages under the current keys");
  // Age bound: rewind the clock past the lifetime.
  const aged = Date.now() - REKEY_AFTER_MS - 1;
  dev.handshakeAt = aged;
  hos.handshakeAt = aged;
  assert.ok(needsRekey(dev) && needsRekey(hos), "an expired session needs rotation");
  // Message bound: below-exhaustion threshold, checked without aging.
  dev.handshakeAt = Date.now();
  hos.handshakeAt = Date.now();
  (dev as unknown as { sendCs: { n: number } }).sendCs.n = REKEY_AFTER_MESSAGES;
  assert.ok(needsRekey(dev) && !needsRekey(hos), "the message bound trips per channel");
  // Rotation is just a fresh handshake: new keys, counters reset, same identities.
  const next = await up();
  const wire = await next.dev.send({ op: "view" });
  assert.equal(wire.n, 0, "the rotated channel starts its counters over");
  assert.deepEqual(await next.hos.recv(wire), { op: "view" });
  await assert.rejects(() => hos.recv(wire), /invalid nonce counter|decrypt|operation failed|The operation/i,
    "the OLD channel cannot read the rotated traffic");
  assert.equal(next.dev.hostFingerprint, dev.hostFingerprint, "the host pin survives rotation (same static key)");
});

interface WireRecv {
  t: string;
  [k: string]: unknown;
}

/** Minimal device socket (same shape as resume.test.ts's). */
class Sock {
  readonly ws: import("ws").WebSocket;
  readonly #inbox: WireRecv[] = [];
  readonly #waiters: ((m: WireRecv) => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as WireRecv;
      const w = this.#waiters.shift();
      if (w) w(m);
      else this.#inbox.push(m);
    });
  }
  get opened(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  send(m: Record<string, unknown>): void {
    this.ws.send(encode(m));
  }
  async expect(t: string, timeoutMs = 5_000): Promise<WireRecv> {
    const hit = this.#inbox.find((m) => m.t === t);
    if (hit) {
      this.#inbox.splice(this.#inbox.indexOf(hit), 1);
      return hit;
    }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`no ${t} in time`)), timeoutMs);
      this.#waiters.push((m) => {
        clearTimeout(timer);
        res(m);
      });
    });
  }
  close(): void {
    this.ws.close();
  }
}

test("e2e: a paired device handshakes through the gate and the view arrives encrypted", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "bom", token: "tok-e2e" }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const wsBase = base.replace("http", "ws");

  // The host side runs the REAL publisher crypto: a HostChannel per device behind the
  // adapter's onFrame, exactly how plugin/server/index.mjs wraps it.
  const host = await generateKeyPair();
  const channels = new Map<string, InstanceType<typeof HostChannel>>();
  let live: HerdGateAgent | null = null;
  const sendTo = (device: string, payload: unknown): void => live?.send(device, payload as Record<string, unknown>);
  const adapter: AgentAdapter = {
    info: () => ({ name: "bom-mac", version: "0.1.0" }),
    onFrame: (device, payload) => {
      const p = payload as Record<string, unknown>;
      void (async () => {
        if (p.op === "e2e.init") {
          const ch = channels.get(device) ?? new HostChannel(host);
          channels.set(device, ch);
          const msg2 = await ch.acceptInit(p as { e: string });
          sendTo(device, { op: "e2e.reply", ...msg2 });
          return;
        }
        if (p.op === "e2e.finish") {
          await channels.get(device)!.acceptFinish(p as { c: string });
          // The ack is the device's start signal; then push the view, encrypted.
          sendTo(device, { op: "e2e.ready" });
          void channels.get(device)!.send({ op: "view", view: { secret: "the-tree" } }).then((w) => sendTo(device, w));
          return;
        }
        if (p.op === "e2e") {
          const inner = await channels.get(device)!.recv(p as { op: string; c: string });
          if (inner.op === "view") void channels.get(device)!.send({ op: "view", view: { secret: "the-tree" } }).then((w) => sendTo(device, w));
          return;
        }
      })().catch(() => {});
    },
    onDevices: () => {},
    onPairAsk: () => false,
  };

  const code = await fetch(`${base}/v1/agent/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bom-mac" }),
  }).then((r) => r.json() as Promise<{ code: string }>);
  await fetch(`${base}/v1/agent/approve`, {
    method: "POST",
    headers: { authorization: "Bearer tok-e2e", "content-type": "application/json" },
    body: JSON.stringify({ code: code.code }),
  });
  const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string; roomId?: string };
  const roomToken = st.roomToken!;
  live = new HerdGateAgent({ endpoint: `${wsBase}/v1/agent/ws`, roomToken, adapter, log: () => {} });
  live.start();
  await live.firstHello;

  const d = new Sock(`${wsBase}/v1/device/ws`);
  await d.opened;
  d.send({ t: "hello", accountToken: "tok-e2e", name: "phone" });
  const hello = await d.expect("hello");
  const room = (hello.agents as { roomId: string }[])[0];
  d.send({ t: "pair.begin", roomId: room.roomId, name: "phone", scope: "read" });
  const granted = (await d.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };
  d.close();

  // Reattach with the device key and run the handshake over the wire.
  const dev2 = await generateKeyPair();
  const ch = new DeviceChannel(dev2);
  const sock = new Sock(`${wsBase}/v1/device/ws`);
  await sock.opened;
  sock.send({ t: "hello", device: granted.device.id, deviceSecret: granted.deviceSecret, name: "phone" });
  await sock.expect("hello");
  const m1 = await ch.begin();
  sock.send({ t: "frame", payload: { op: "e2e.init", ...m1 } });
  const reply = (await sock.expect("frame")) as unknown as { payload: { op: string; e: string; c: string } };
  assert.equal(reply.payload.op, "e2e.reply");
  const m3 = await ch.acceptReply({ e: reply.payload.e, c: reply.payload.c });
  sock.send({ t: "frame", payload: { op: "e2e.finish", ...m3 } });
  assert.equal(ch.hostFingerprint, await fingerprint(host.pub));

  // The device sends nothing encrypted until the host acks.
  const ready = (await sock.expect("frame")) as unknown as { payload: { op: string } };
  assert.equal(ready.payload.op, "e2e.ready", "the host acks before any encrypted traffic");

  // The host pushes the view encrypted right after the handshake completes.
  const pushed = (await sock.expect("frame")) as unknown as { payload: { op: string; c: string } };
  assert.equal(pushed.payload.op, "e2e");
  assert.deepEqual(await ch.recv(pushed.payload), { op: "view", view: { secret: "the-tree" } });

  // Ask again, encrypted, and get the encrypted answer.
  sock.send({ t: "frame", payload: await ch.send({ op: "view" }) });
  const answer = (await sock.expect("frame")) as unknown as { payload: { op: string; c: string } };
  assert.equal(answer.payload.op, "e2e");
  assert.deepEqual(await ch.recv(answer.payload), { op: "view", view: { secret: "the-tree" } });

  sock.close();
  live.stop();
  await cloud.close();
});
