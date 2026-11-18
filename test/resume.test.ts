/**
 * Resume: a device that drops and comes back replays its room's stream from where
 * it stopped. Covers the happy tail, the ephemeral contract (ssh.* never replayed),
 * the gap path (buffer overflowed), and generation invalidation (gateway restarted).
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import type { AgentAdapter } from "../src/agent/adapter.ts";
import { encode } from "../src/protocol/envelope.ts";

const ACCOUNT_TOKEN = "resume-account-token";

interface Recv {
  t: string;
  [k: string]: unknown;
}

/** Same raw device socket as e2e.test.ts, local to this file on purpose. */
class DeviceSock {
  readonly ws: WebSocket;
  readonly #inbox: Recv[] = [];
  readonly #waiters: ((m: Recv) => void)[] = [];
  readonly opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", (e) => rej(e));
    });
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
      const w = this.#waiters.shift();
      if (w) w(m);
      else this.#inbox.push(m);
    });
  }
  async send(m: Record<string, unknown>): Promise<void> {
    await this.opened;
    this.ws.send(encode(m));
  }
  next(timeoutMs = 5_000): Promise<Recv> {
    const hit = this.#inbox.shift();
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("device socket: no message in time")), timeoutMs);
      this.#waiters.push((m) => {
        clearTimeout(t);
        res(m);
      });
    });
  }
  async expect(t: string, timeoutMs = 5_000): Promise<Recv> {
    for (;;) {
      const m = await this.next(timeoutMs);
      if (m.t === t) return m;
    }
  }
  /** All messages seen so far; the hello is the first one, captured for resume. */
  helloSeen(): Recv | null {
    return this.#inbox.find((m) => m.t === "hello") ?? null;
  }
  close(): void {
    this.ws.close();
  }
}

/** Device-flow provisioning (mint + approve + status) over REST. */
async function provision(base: string, token: string, name: string): Promise<{ roomToken: string; roomId: string }> {
  const code = await fetch(`${base}/v1/agent/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => r.json() as Promise<{ code: string }>);
  await fetch(`${base}/v1/agent/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ code: code.code }),
  });
  const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as {
    status: string;
    roomToken?: string;
    roomId?: string;
  };
  if (st.status !== "approved" || !st.roomToken || !st.roomId) throw new Error("provision failed");
  return { roomToken: st.roomToken, roomId: st.roomId };
}

test("resume: the missed tail replays in order; ssh.* stays ephemeral; gaps and stale gens degrade to re-sync", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "bom", token: ACCOUNT_TOKEN }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const wsBase = base.replace("http", "ws");

  const adapter: AgentAdapter = {
    info: () => ({ name: "bom-mac", version: "0.0.1" }),
    onFrame: () => {},
    onDevices: () => {},
    onPairAsk: () => false,
  };
  const { roomToken, roomId } = await provision(base, ACCOUNT_TOKEN, "bom-mac");
  const agent = new HerdGateAgent({ endpoint: `${wsBase}/v1/agent/ws`, roomToken, adapter, log: () => {} });
  agent.start();
  await agent.firstHello;

  // A device pairs, reads two frames, then "loses wifi".
  const d1 = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d1.send({ t: "hello", accountToken: ACCOUNT_TOKEN, name: "phone" });
  await d1.expect("hello");
  await d1.send({ t: "pair.begin", roomId, name: "phone", scope: "read" });
  const granted = (await d1.expect("pair.granted")) as unknown as { device: { id: string } };
  agent.send(granted.device.id, { op: "view", view: { n: 1 } });
  const f1 = await d1.expect("frame");
  agent.send(granted.device.id, { op: "view", view: { n: 2 } });
  const f2 = await d1.expect("frame");
  const seq1 = f1.seq as number;
  const seq2 = f2.seq as number;
  assert.equal(typeof seq1, "number");
  assert.equal(seq2, seq1 + 1, "seq advances per room message");
  // The hello carried the stream header (gen + position). The device socket here
  // is owner-authed until pairing; the header appears once a device is attached,
  // so read it off the pair.granted follow-up hello — i.e. reconnect once before
  // going offline and capture what the cloud told this device.
  d1.close();
  await new Promise((r) => setTimeout(r, 150));
  const d1b = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d1b.send({ t: "hello", device: granted.device.id, deviceSecret: (granted as unknown as { deviceSecret: string }).deviceSecret, name: "phone" });
  const h1 = (await d1b.expect("hello")) as unknown as { resumed: boolean; stream: { gen: string; seq: number } };
  assert.equal(h1.resumed, false, "first device-key attach has nothing to resume");
  assert.ok(h1.stream && typeof h1.stream.gen === "string", "device hello carries the stream header");
  d1b.close();
  await new Promise((r) => setTimeout(r, 150));

  // Offline now. The host sends two frames (buffered for the device) and an
  // ssh.data frame (ephemeral: no stamp, no buffer, no replay).
  d1.close();
  await new Promise((r) => setTimeout(r, 150));
  agent.send(granted.device.id, { op: "view", view: { n: 3 } });
  agent.send(granted.device.id, { op: "view", view: { n: 4 } });
  agent.send(granted.device.id, { op: "ssh.data", ch: "c1", b64: "AAAA" });
  await new Promise((r) => setTimeout(r, 150));

  // Reconnect with resume → the tail replays in order, sans ssh.*.
  const d2 = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d2.send({ t: "hello", device: granted.device.id, deviceSecret: (granted as unknown as { deviceSecret: string }).deviceSecret, name: "phone", resume: { room: roomId, gen: h1.stream.gen, seq: seq2 } });
  const h2 = (await d2.expect("hello")) as unknown as { resumed: boolean; stream: { gen: string; seq: number; gap: boolean } };
  assert.equal(h2.resumed, true, "resume accepted");
  assert.equal(h2.stream.gap, false);
  const r1 = await d2.expect("frame");
  const r2 = await d2.expect("frame");
  assert.deepEqual(r1.payload, { op: "view", view: { n: 3 } });
  assert.deepEqual(r2.payload, { op: "view", view: { n: 4 } });
  assert.equal((r1.seq as number) + 1, r2.seq, "replay keeps seq order");
  assert.equal(h2.stream.seq, r2.seq, "the stream header names the newest seq");
  // Nothing else follows: the ephemeral ssh frame is not replayed.
  await assert.rejects(() => d2.next(300), { message: /no message in time/ });
  d2.close();

  // A resume from before the buffer kept (forced eviction) reports a gap.
  const d3 = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d3.send({ t: "hello", device: granted.device.id, deviceSecret: (granted as unknown as { deviceSecret: string }).deviceSecret, name: "phone" });
  const h3 = (await d3.expect("hello")) as unknown as { stream: { gen: string; seq: number } };
  const before = h3.stream.seq;
  d3.close();
  // Two oversized-but-legal frames (150KB each) overflow the 256KB buffer.
  agent.send(granted.device.id, { op: "view", view: { blob: "x".repeat(150_000) } });
  agent.send(granted.device.id, { op: "view", view: { blob: "y".repeat(150_000) } });
  await new Promise((r) => setTimeout(r, 150));
  const d4 = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d4.send({ t: "hello", device: granted.device.id, deviceSecret: (granted as unknown as { deviceSecret: string }).deviceSecret, name: "phone", resume: { room: roomId, gen: h3.stream.gen, seq: before } });
  const h4 = (await d4.expect("hello")) as unknown as { resumed: boolean; stream: { gap: boolean } };
  assert.equal(h4.resumed, true);
  assert.equal(h4.stream.gap, true, "evicted frames become a declared gap");
  // Replay may still carry what survived; the device re-syncs on its own.
  d4.close();

  // A gen the gateway never minted (restart simulation) degrades to a fresh hello.
  const d5 = new DeviceSock(`${wsBase}/v1/device/ws`);
  await d5.send({ t: "hello", device: granted.device.id, deviceSecret: (granted as unknown as { deviceSecret: string }).deviceSecret, name: "phone", resume: { room: roomId, gen: "g_other", seq: 3 } });
  const h5 = (await d5.expect("hello")) as unknown as { resumed: boolean };
  assert.equal(h5.resumed, false, "unknown gen → fresh hello, not an error");
  d5.close();

  // The owner socket's hello has no stream header (owners are not stream readers).
  const owner = new DeviceSock(`${wsBase}/v1/device/ws`);
  await owner.send({ t: "hello", accountToken: ACCOUNT_TOKEN, name: "desktop" });
  const ho = (await owner.expect("hello")) as unknown as { stream?: unknown };
  assert.equal(ho.stream, undefined);
  owner.close();

  agent.stop();
  await cloud.close();
});
