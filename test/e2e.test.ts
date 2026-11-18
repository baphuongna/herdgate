/**
 * End-to-end smoke: one cloud, one host agent (via the SDK), two device
 * sockets. Covers provisioning, both pairing paths, presence and opaque frame
 * round-trips. Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import type { AgentAdapter } from "../src/agent/adapter.ts";
import { encode } from "../src/protocol/envelope.ts";

const ACCOUNT_TOKEN = "test-account-token";

interface Recv {
  t: string;
  [k: string]: unknown;
}

/** A raw device socket with promise-based receive (sends wait for open). */
class DeviceSock {
  readonly ws: WebSocket;
  readonly #inbox: Recv[] = [];
  readonly #waiters: ((m: Recv) => void)[] = [];
  readonly opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {}); // surfaced via `opened`/close instead of uncaught
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
  close(): void {
    this.ws.close();
  }
}

const waitFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("e2e: provision, pair read + act, frames both ways, presence", async () => {
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "bom", token: ACCOUNT_TOKEN }],
    log: () => {},
  });
  const base = `http://127.0.0.1:${cloud.port}`;

  try {
    // -- 1. Host provisions via device flow (approve with the account token). --
    const code = await fetch(`${base}/v1/agent/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bom-mac" }),
    }).then((r) => r.json() as Promise<{ code: string }>);
    const approve = await fetch(`${base}/v1/agent/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCOUNT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ code: code.code }),
    });
    assert.equal(approve.status, 200);
    const status = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { status: string; roomToken?: string };
    assert.equal(status.status, "approved");
    assert.ok(typeof status.roomToken === "string" && status.roomToken.length > 20);
    const again = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string };
    assert.equal(again.roomToken, undefined, "room token is single-retrieval");

    // Wrong account token is refused.
    const bad = await fetch(`${base}/v1/agent/approve`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: JSON.stringify({ code: "ZZZZZZZZ" }),
    });
    assert.equal(bad.status, 401);

    // -- 2. The host agent connects with the room token. --
    const framesIn: { device: string; payload: unknown }[] = [];
    const adapter: AgentAdapter = {
      info: () => ({ name: "bom-mac", version: "0.0.1" }),
      onFrame: (device, payload) => {
        framesIn.push({ device, payload });
      },
      onDevices: () => {},
      onPairAsk: (ask) => ask.scope === "act", // approve every act pair in the test
    };
    const agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: status.roomToken, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;

    // -- 3. A device connects, sees the host, pairs read-only. --
    const d1 = new DeviceSock(`${base.replace("http", "ws")}/v1/device/ws`);
    await d1.send({ t: "hello", accountToken: ACCOUNT_TOKEN, name: "iPad" });
    const hello1 = await d1.expect("hello") as unknown as { agents: { roomId: string; online: boolean }[] };
    assert.equal(hello1.agents.length, 1);
    const room = (hello1.agents as { roomId: string; online: boolean }[])[0];
    assert.equal(room.online, true);

    await d1.send({ t: "pair.begin", roomId: room.roomId, name: "iPad", scope: "read" });
    const g1 = await d1.expect("pair.granted") as unknown as { device: { id: string; scope: string } };
    assert.equal(g1.device.scope, "read");

    // Frames: device → host (opaque), host → device.
    await d1.send({ t: "frame", payload: { kind: "tap", x: 3 } });
    await waitFor(200);
    assert.equal(framesIn.length, 1);
    assert.deepEqual(framesIn[0].payload, { kind: "tap", x: 3 });
    agent.send(framesIn[0].device, { kind: "tree", n: 1 });
    const f1 = await d1.expect("frame");
    assert.deepEqual(f1.payload, { kind: "tree", n: 1 });

    // The host saw the device in its list.
    assert.equal(agent.devices.length, 1);
    assert.equal(agent.scopeOf(framesIn[0].device), "read");

    // -- 4. A second device pairs act: the host must approve. --
    const d2 = new DeviceSock(`${base.replace("http", "ws")}/v1/device/ws`);
    await d2.send({ t: "hello", accountToken: ACCOUNT_TOKEN, name: "iPhone" });
    await d2.expect("hello");
    await d2.send({ t: "pair.begin", roomId: room.roomId, name: "iPhone", scope: "act" });
    const g2 = await d2.expect("pair.granted") as unknown as { device: { id: string; scope: string } };
    assert.equal(g2.device.scope, "act");

    // -- 5. Unknown account tokens are refused on the WS leg. --
    const d3 = new DeviceSock(`${base.replace("http", "ws")}/v1/device/ws`);
    await d3.send({ t: "hello", accountToken: "wrong" });
    const closed = new Promise<number>((res) => d3.ws.on("close", (c) => res(c)));
    assert.equal(await closed, 4001);

    // -- 6. Presence: host disconnect propagates. --
    d1.close();
    d2.close();
    agent.stop();
    await waitFor(150);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await cloud.close();
  }
});
