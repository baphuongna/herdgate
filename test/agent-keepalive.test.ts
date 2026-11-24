/**
 * The host must notice a cloud that went silent.
 *
 * The agent sent a `ping` every 25 s but never looked at the answer, so a connection that
 * died without a reset — a path that black-holes instead of resetting — stayed "OPEN" until
 * Linux TCP gave up retransmitting, ~15–30 minutes. The gate drops its side in ~16 s
 * (8 s heartbeat, one missed pong), so the room shows offline while the host still believes
 * it is publishing. Caught in the journal, 2026-11-21: the gate lost the home agent at
 * 23:07:55, the tunnel was registered again at 23:11:37, and the agent only redialed at
 * 23:21:04 — the network had been back for nine minutes.
 *
 * Rule: a ping every interval, and silence for three intervals means gone. `terminate`
 * fires `close`, which already owns the redial and its backoff.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HerdGateAgent } from "../src/agent/index.ts";
import { quietCloud, sleep, waitFor } from "./util-keepalive.ts";

const adapter = {
  info: () => ({ name: "keepalive-host", version: "0.0.0" }),
  onFrame: () => {},
  onDevices: () => {},
  onPairAsk: () => false,
};

test("agent: on a healthy link the keepalive never causes a redial", async () => {
  const cloud = await quietCloud();
  const lines: string[] = [];
  const agent = new HerdGateAgent({
    endpoint: `ws://127.0.0.1:${cloud.port}/v1/agent/ws`,
    roomToken: "keepalive-fixture-token",
    adapter,
    log: (l) => lines.push(l),
    backoff: { minMs: 20, maxMs: 50 },
    keepaliveMs: 40,
  });
  try {
    agent.start();
    await agent.firstHello;
    await sleep(500);
    assert.ok(cloud.pings() >= 3, `pings keep flowing (${cloud.pings()})`);
    assert.equal(cloud.conns(), 1, `one connection, no redial: ${lines.join(" | ")}`);
  } finally {
    agent.stop();
    await cloud.close();
  }
});

test("agent: a cloud that goes silent while the socket stays open is redialed", async () => {
  const cloud = await quietCloud();
  const lines: string[] = [];
  const agent = new HerdGateAgent({
    endpoint: `ws://127.0.0.1:${cloud.port}/v1/agent/ws`,
    roomToken: "keepalive-fixture-token",
    adapter,
    log: (l) => lines.push(l),
    backoff: { minMs: 20, maxMs: 50 },
    keepaliveMs: 40,
  });
  try {
    agent.start();
    await agent.firstHello;
    cloud.mute();
    await waitFor(() => cloud.conns() >= 2, 4_000, "a second connection after the cloud went silent");
    assert.match(lines.join("\n"), /silent.*redialing/, "the verdict is on the record");
  } finally {
    agent.stop();
    await cloud.close();
  }
});
