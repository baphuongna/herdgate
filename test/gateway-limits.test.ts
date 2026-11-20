/**
 * Regression tests for the shared-address availability audit findings
 * (gateway:shared-address-ip-controls, pairing:unbounded-code-mint).
 *
 * Reproductions of the exact loopback scenarios from security-audit run-1:
 *   1. five bad hellos from one socket must NOT block a client on another socket
 *      (previously: the victim upgrade was refused with HTTP 429);
 *   2. SSH-over-WSS tunnels from one shared address are bounded per connection and
 *      by a configurable global total (previously: hard 6-per-address cap → the
 *      7th tunnel was closed 1013 busy for everyone behind a proxy);
 *   3. pairing-code minting is bounded per client and in total (previously:
 *      300/300 rapid mints accepted).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { AgentCodes } from "../src/cloud/pairing.ts";
import { DeviceSock } from "./util2.ts";

const accounts = [{ id: "a", name: "owner", token: "limits-test-owner" }];

/** A raw socket that resolves its upgrade outcome and swallows stray errors. */
const open = (base: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ ws: WebSocket; result: string }>((resolve) => {
    const ws = new WebSocket(base + path, { headers });
    ws.on("error", () => {});
    ws.once("open", () => resolve({ ws, result: "open" }));
    ws.once("unexpected-response", (_q, res) => resolve({ ws, result: `HTTP ${res.statusCode}` }));
    ws.once("close", (c, r) => resolve({ ws, result: `closed ${c} ${r}` }));
  });

const badHello = async (base: string, headers: Record<string, string> = {}): Promise<void> => {
  const { ws, result } = await open(base, "/v1/device/ws", headers);
  assert.equal(result, "open", `the attacker socket must upgrade (got ${result})`);
  ws.send(JSON.stringify({ v: 1, t: "hello", accountToken: "wrong" }));
  await new Promise((res) => ws.once("close", res));
};

test("loopback clients never share strike budgets: an attacker cannot lock out another socket", async () => {
  const cloud = await startCloud({ accounts, log: () => {} });
  const base = `ws://127.0.0.1:${cloud.port}`;
  try {
    for (let i = 0; i < 5; i++) await badHello(base);
    const victim = new DeviceSock(base + "/v1/device/ws");
    const hello = await victim.hello({ accountToken: accounts[0].token });
    assert.equal(hello.t, "hello", "a legitimate client on another socket must not be blocked");
    victim.close();
  } finally {
    await cloud.close();
  }
});

test("a trusted proxy header restores per-client strike budgets", async () => {
  const cloud = await startCloud({ accounts, trustedProxy: true, realIpHeader: "X-Client-Ip", log: () => {} });
  const base = `ws://127.0.0.1:${cloud.port}`;
  try {
    for (let i = 0; i < 5; i++) await badHello(base, { "X-Client-Ip": "203.0.113.9" });
    const attacker = await open(base, "/v1/device/ws", { "X-Client-Ip": "203.0.113.9" });
    assert.match(attacker.result, /^HTTP 429$/, "the blocked key is refused");
    attacker.ws.terminate();
    // A different client behind the same proxy is unaffected...
    const other = new DeviceSock(base + "/v1/device/ws", );
    const hello = await other.hello({ accountToken: accounts[0].token });
    assert.equal(hello.t, "hello");
    other.close();
    // ...and a missing or malformed header never shares anyone's budget.
    const variants: Array<Record<string, string>> = [{}, { "X-Client-Ip": "not an ip" }, { "X-Client-Ip": "9.9.9.9, 8.8.8.8" }];
    for (const header of variants) {
      const stranger = await open(base, "/v1/device/ws", header);
      assert.equal(stranger.result, "open", `header ${JSON.stringify(header)} must upgrade`);
      stranger.ws.close();
    }
  } finally {
    await cloud.close();
  }
});

test("ssh-ws tunnels from one shared address are bounded per connection and by a configurable total", async () => {
  const cloud = await startCloud({ accounts, ssh: { port: 0 }, log: () => {} });
  const base = `ws://127.0.0.1:${cloud.port}`;
  const hold: WebSocket[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const { ws, result } = await open(base, "/v1/ssh/ws");
      assert.equal(result, "open");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(ws.readyState, WebSocket.OPEN, `tunnel ${i + 1} must stay open (regression: was closed 1013 busy from #7)`);
      hold.push(ws);
    }
  } finally {
    for (const ws of hold) ws.terminate();
    await cloud.close();
  }

  // The global total still bounds the whole Gate and is configurable for edge deployments.
  const small = await startCloud({ accounts, ssh: { port: 0 }, sshTunnelLimits: { total: 2 }, log: () => {} });
  const smallBase = `ws://127.0.0.1:${small.port}`;
  const keep: WebSocket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const { ws, result } = await open(smallBase, "/v1/ssh/ws");
      assert.equal(result, "open");
      keep.push(ws);
    }
    const third = await open(smallBase, "/v1/ssh/ws");
    assert.equal(third.result, "open");
    await new Promise((res) => {
      const timer = setTimeout(() => res(assert.fail("the third tunnel over the total was not refused")), 2_000);
      third.ws.once("close", (code, reason) => {
        clearTimeout(timer);
        res(assert.equal(`${code} ${reason}`, "1013 busy"));
      });
    });
  } finally {
    for (const ws of keep) ws.terminate();
    await small.close();
  }
});

test("pairing-code minting is bounded per client and in total", async () => {
  // Unit: the pending inventory refuses beyond its cap.
  let now = 1_000_000;
  const codes = new AgentCodes(() => now, null, 3);
  assert.ok(codes.mint("a"));
  assert.ok(codes.mint("b"));
  assert.ok(codes.mint("c"));
  assert.equal(codes.mint("d"), null, "pending cap reached");
  now += 11 * 60_000;
  assert.ok(codes.mint("d"), "expired entries free the inventory");

  // Route: per-client rate plus the global pending cap.
  const cloud = await startCloud({ accounts, trustedProxy: true, realIpHeader: "X-Client-Ip", maxPendingCodes: 64, log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const mint = (ip: string) => fetch(base + "/v1/agent/code", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Client-Ip": ip },
      body: JSON.stringify({ name: "x" }),
    });
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await mint("203.0.113.10");
      if (res.status === 200) ok++;
      else if (res.status === 429) limited++;
      else assert.fail(`unexpected mint status ${res.status}`);
    }
    assert.equal(ok, 10, "the per-client budget allows a burst of ten");
    assert.equal(limited, 2, "the 11th rapid mint from one client is refused");
    const other = await mint("203.0.113.11");
    assert.equal(other.status, 200, "a different client can still mint");
  } finally {
    await cloud.close();
  }
});
