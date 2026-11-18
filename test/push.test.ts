/**
 * Push wake: a device subscribes its endpoint, the host asks for a wake, the cloud
 * POSTs a silent VAPID-signed push (no payload) to that endpoint — only when the
 * device is actually away. Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import type { AgentAdapter } from "../src/agent/adapter.ts";
import { encode } from "../src/protocol/envelope.ts";
import { generateVapidKeys, vapidVerify } from "../src/cloud/vapid.ts";

const ACCOUNT_TOKEN = "push-account-token";

interface Recv {
  t: string;
  [k: string]: unknown;
}

class Sock {
  readonly ws: WebSocket;
  readonly #inbox: Recv[] = [];
  readonly #waiters: ((m: Recv) => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
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
  async expect(t: string, timeoutMs = 5_000): Promise<Recv> {
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

/** A stand-in push service: records POSTs, answers 201. */
async function fakePushService(): Promise<{ server: Server; url: string; posts: { url: string; auth: string }[] }> {
  const posts: { url: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    posts.push({ url: req.url ?? "/", auth: String(req.headers.authorization ?? "") });
    res.writeHead(201);
    res.end();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}/push/wake`, posts };
}

test("push: subscribe, wake an away device with a valid VAPID push, skip the connected one", async () => {
  const keys = generateVapidKeys();
  const push = await fakePushService();
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "bom", token: ACCOUNT_TOKEN }],
    push: { keys, sub: "mailto:test@herdgate.invalid" },
    log: () => {},
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  const wsBase = base.replace("http", "ws");

  const adapter: AgentAdapter = {
    info: () => ({ name: "bom-mac", version: "0.1.0" }),
    onFrame: () => {},
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
    headers: { authorization: `Bearer ${ACCOUNT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ code: code.code }),
  });
  const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string; roomId?: string };
  const roomToken = st.roomToken!;
  const roomId = st.roomId!;
  const agent = new HerdGateAgent({ endpoint: `${wsBase}/v1/agent/ws`, roomToken, adapter, log: () => {} });
  agent.start();
  await agent.firstHello;

  // The public key endpoint serves the same key the pushes will sign with.
  const pk = await fetch(`${base}/v1/push/key`).then((r) => r.json() as Promise<{ publicKey: string }>);
  assert.equal(pk.publicKey, keys.publicBase64Url);

  // A device pairs and subscribes its endpoint.
  const d = new Sock(`${wsBase}/v1/device/ws`);
  await d.opened;
  d.send({ t: "hello", accountToken: ACCOUNT_TOKEN, name: "phone" });
  await d.expect("hello");
  d.send({ t: "pair.begin", roomId, name: "phone", scope: "read" });
  const granted = (await d.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };

  const badSub = await fetch(`${base}/v1/device/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: granted.device.id, deviceSecret: "wrong" }),
  });
  assert.equal(badSub.status, 401, "wrong device secret is refused");

  const sub = await fetch(`${base}/v1/device/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: granted.device.id, deviceSecret: granted.deviceSecret, endpoint: push.url }),
  });
  assert.equal(sub.status, 200);

  // The device goes away, the host asks for a wake → exactly one silent push.
  d.close();
  await new Promise((r) => setTimeout(r, 200));
  agent.wake(granted.device.id);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(push.posts.length, 1, "one wake push for the away device");
  assert.equal(push.posts[0].url, "/push/wake");
  const claims = vapidVerify(push.posts[0].auth);
  assert.ok(claims, "the VAPID JWT verifies against its own key");
  assert.equal(claims.aud, `http://127.0.0.1:${new URL(push.url).port}`, "audience is the push service origin");
  assert.equal(claims.sub, "mailto:test@herdgate.invalid");

  // A wake for a device that is connected delivers nothing.
  const d2 = new Sock(`${wsBase}/v1/device/ws`);
  await d2.opened;
  d2.send({ t: "hello", device: granted.device.id, deviceSecret: granted.deviceSecret, name: "phone" });
  await d2.expect("hello");
  await new Promise((r) => setTimeout(r, 200));
  agent.wake(granted.device.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(push.posts.length, 1, "no push for a connected device");

  // Unsubscribe: the next wake delivers nothing.
  d2.close();
  await new Promise((r) => setTimeout(r, 200));
  const unsub = await fetch(`${base}/v1/device/push`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: granted.device.id, deviceSecret: granted.deviceSecret }),
  });
  assert.equal(unsub.status, 200);
  agent.wake(granted.device.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(push.posts.length, 1, "no push after unsubscribe");

  agent.stop();
  await cloud.close();
  await new Promise<void>((res) => push.server.close(() => res()));
});
