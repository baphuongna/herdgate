// Scratch benchmark: gate-side SSH-leg handshake cost, split by phase. Not part of the repo.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { startCloud } from "../../../../src/cloud/gateway.ts";
import { HerdGateAgent } from "../../../../src/agent/index.ts";
import { createSshBridge } from "../../../../src/host/ssh.ts";
import { encode } from "../../../../src/protocol/envelope.ts";

const ROOT = process.env.HERDGATE_BENCH_ROOT ?? mkdtempSync(join(tmpdir(), "herdgate-conn-bench-"));
console.log("scratch:", ROOT);
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_HC = join(HERE, "../../../../test/fake-hc.helper.mjs");
const ACCOUNT = "bench-account-token";
const dir = mkdtempSync(join(ROOT, "state-"));
rmSync(join(ROOT, "params.json"), { force: true });

let agent;
const bridge = createSshBridge({
  send: (device, payload) => agent.send(device, payload),
  scopeOf: (device) => agent.scopeOf(device),
  log: () => {},
  resolveHc: () => "hc",
  spawnImpl: (bin, args, opts) => spawn(process.execPath, [FAKE_HC, ...args], opts),
});
const adapter = {
  info: () => ({ name: "bench-host", version: "0.0.0" }),
  onFrame: (d, p) => { bridge.handle(d, p); },
  onDevices: () => {},
  onPairAsk: (ask) => ask.scope === "act",
};

const cloud = await startCloud({
  accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
  log: () => {},
  ssh: { port: 0, keyPath: join(dir, "hostkey.json") },
});
const base = "http://127.0.0.1:" + cloud.port;
const J = (r) => r.json();
const code = await fetch(base + "/v1/agent/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "bench-host" }) }).then(J);
await fetch(base + "/v1/agent/approve", { method: "POST", headers: { authorization: "Bearer " + ACCOUNT, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
const st = await fetch(base + "/v1/agent/code/" + code.code + "/status").then(J);
agent = new HerdGateAgent({ endpoint: base.replace("http", "ws") + "/v1/agent/ws", roomToken: st.roomToken, adapter, log: () => {} });
agent.start();
await agent.firstHello;

// Pair an act device and register an ed25519 key for it (what production clients use).
const ws = new WebSocket(base.replace("http", "ws") + "/v1/device/ws");
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const inbox = [];
ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
const next = async (t) => {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no " + t);
};
ws.send(encode({ t: "hello", accountToken: ACCOUNT, name: "bench" }));
const hello = await next("hello");
const roomId = hello.agents[0].roomId;
ws.send(encode({ t: "pair.begin", roomId, name: "bench-act", scope: "act" }));
const g = await next("pair.granted");
ws.close();

const keyPath = join(ROOT, "id_bench");
if (!existsSync(keyPath)) spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bench", "-f", keyPath]);
const pubkey = readFileSync(keyPath + ".pub", "utf8").trim();
const addKey = await fetch(base + "/v1/device/sshkey", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ device: g.device.id, deviceSecret: g.deviceSecret, pubkey }),
}).then(J);
writeFileSync(join(ROOT, "params.json"), JSON.stringify({ sshPort: cloud.ssh.port, httpPort: cloud.port, deviceId: g.device.id, keyPath, fp: addKey.fp }));
writeFileSync(join(ROOT, "bench.pid"), String(process.pid));
console.log("ready");

const stop = () => {
  try { agent.stop?.(); } catch {}
  cloud.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
