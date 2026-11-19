/**
 * The owner's device roster and un-pairing: GET /v1/devices lists a room's devices
 * (scope, live, key count) for the account token only; POST /v1/device/revoke
 * removes the device, kicks its open socket, and its SSH key dies with it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import { type AgentAdapter } from "../src/agent/adapter.ts";
import { DeviceSock } from "./util2.ts";

test("devices: roster lists pairs; revoke kills access and the socket", async () => {
  const ACCOUNT = "roster-account-tok";
  const dir = mkdtempSync(join(tmpdir(), "herdgate-roster-"));
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: () => {},
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  let agent: InstanceType<typeof HerdGateAgent> | null = null;
  let readSock: DeviceSock | null = null;
  let actSock: DeviceSock | null = null;
  try {
    // A machine and two devices (one read, one act) on its room.
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "roster-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const status = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string };
    assert.ok(status.roomToken, "approve mints a single-retrieval room token");
    // The host answers act pairs (as the publisher does when allowAct is on).
    const adapter: AgentAdapter = {
      info: () => ({ name: "roster-host", version: "0" }),
      onFrame: () => {},
      onDevices: () => {},
      onPairAsk: (ask) => ask.scope === "act",
    };
    agent = new HerdGateAgent({ endpoint: `${base.replace("http", "ws")}/v1/agent/ws`, roomToken: status.roomToken!, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const hello = (await new DeviceSock(base.replace("http", "ws") + "/v1/device/ws").hello({ accountToken: ACCOUNT, name: "probe" })) as unknown as { agents: { roomId: string }[] };
    const roomId = hello.agents[0].roomId;

    readSock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await readSock.hello({ accountToken: ACCOUNT, name: "owner" });
    await readSock.send({ t: "pair.begin", roomId, name: "phone", scope: "read" });
    const read = (await readSock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };

    actSock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await actSock.hello({ accountToken: ACCOUNT, name: "owner2" });
    await actSock.send({ t: "pair.begin", roomId, name: "laptop", scope: "act" });
    const act = (await actSock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };

    // Roster: account token sees both, live; a stranger sees nothing.
    const roster = (await (await fetch(`${base}/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${ACCOUNT}` } })).json()) as { devices: { id: string; name: string; scope: string; connected: boolean; keys: number }[] };
    assert.equal(roster.devices.length, 2);
    assert.ok(roster.devices.every((d) => d.connected), "both sockets are live");
    assert.deepEqual(roster.devices.map((d) => d.scope).sort(), ["act", "read"]);
    const noAuth = await fetch(`${base}/v1/devices?room=${roomId}`);
    assert.equal(noAuth.status, 401);

    // Revoke the act device: its socket closes, its credentials stop working.
    const rev = await fetch(`${base}/v1/device/revoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ACCOUNT}` }, body: JSON.stringify({ device: act.device.id }) });
    assert.equal(rev.status, 200);
    await actSock.expectClose(5_000);
    const reProbe = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    const reHello = (await reProbe.hello({ device: act.device.id, deviceSecret: act.deviceSecret })) as { t?: string; error?: string; device?: unknown };
    assert.ok(reHello.device === undefined, `a revoked secret must not re-attach (got ${JSON.stringify(reHello).slice(0, 120)})`);
    reProbe.close();

    // The read device survives untouched.
    const after = (await (await fetch(`${base}/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${ACCOUNT}` } })).json()) as { devices: { id: string }[] };
    assert.deepEqual(after.devices.map((d) => d.id), [read.device.id]);
  } finally {
    agent?.stop();
    readSock?.close();
    actSock?.close();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
