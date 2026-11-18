/**
 * The SSH bridge: a reachable front door relaying raw SSH over the cloud's wss.
 * Proves the whole chain without any inbound port on the "gate": a bridge (as if on
 * a VPS) dials out, a phone pairs over wss, then SSH-es to the BRIDGE's port and
 * speaks herdr-core JSON-RPC — device-key auth, read-only allowlist and all.
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { startSshBridge } from "../src/cloud/ssh-bridge.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import type { AgentAdapter } from "../src/agent/adapter.ts";
import { createSshBridge } from "../src/host/ssh.ts";
import { encode } from "../src/protocol/envelope.ts";

const FAKE_HC = new URL("./fake-hc.helper.mjs", import.meta.url).pathname;
const ACCOUNT = "bridge-account-tok";

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

test("ssh bridge: phone SSH-es the bridge, not the gate; auth and read-only live in the cloud", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-sb-"));
  const hcLog = join(dir, "hc-methods.log");
  process.env.FAKE_HC_LOG = hcLog;

  const bridge = createSshBridge({
    send: (device, payload) => agent.send(device, payload),
    scopeOf: (device) => agent.scopeOf(device),
    log: () => {},
    resolveHc: () => "hc",
    spawnImpl: (bin, args, opts) => spawn(process.execPath, [FAKE_HC, ...args], opts) as ChildProcess,
  });
  const adapter: AgentAdapter = {
    info: () => ({ name: "bridged-host", version: "0.0.0" }),
    onFrame: (device, payload) => {
      if (bridge.handle(device, payload)) return;
    },
    onDevices: () => {},
    onPairAsk: () => false,
  };
  let agent: HerdGateAgent;

  const logs: string[] = [];
  // The gate's own SSH port is bound loopback — as if the gate machine had no open
  // ports at all. The bridge is the only way in.
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: (l) => logs.push(l),
    ssh: { port: 0, bind: "127.0.0.1", keyPath: join(dir, "hostkey.json") },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  const wsBase = base.replace("http", "ws");

  const code = await fetch(`${base}/v1/agent/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bridged-host" }),
  }).then((r) => r.json() as Promise<{ code: string }>);
  await fetch(`${base}/v1/agent/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" },
    body: JSON.stringify({ code: code.code }),
  });
  const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string; roomId?: string };
  agent = new HerdGateAgent({ endpoint: `${wsBase}/v1/agent/ws`, roomToken: st.roomToken!, adapter, log: () => {} });
  agent.start();
  await agent.firstHello;

  // No bridge yet: the device hello advertises the gate's own (loopback!) address.
  const peek1 = new Sock(`${wsBase}/v1/device/ws`);
  await peek1.opened;
  peek1.send({ t: "hello", accountToken: ACCOUNT, name: "peek" });
  const h1 = await peek1.expect("hello");
  assert.equal((h1.ssh as { port: number }).port, cloud.ssh?.port, "without a bridge the hello names the gate's port");
  assert.equal((h1.ssh as { host?: string }).host, undefined, "no host is advertised when none is configured");
  peek1.close();

  // The bridge: as if on a VPS — outbound wss only, advertising a public address.
  const br = await startSshBridge({
    cloudUrl: base,
    token: ACCOUNT,
    bind: "127.0.0.1",
    port: 0,
    advertise: { host: "gate-bridge.example", port: 2299 },
    log: () => {},
  });
  assert.ok(br.port > 0);
  await br.whenReady; // the cloud accepted the bridge's hello — phones can dial

  // A device pairs, and its hello now points phones at the BRIDGE.
  const d = new Sock(`${wsBase}/v1/device/ws`);
  await d.opened;
  d.send({ t: "hello", accountToken: ACCOUNT, name: "phone" });
  const hello = await d.expect("hello");
  assert.deepEqual(hello.ssh, { host: "gate-bridge.example", port: 2299 }, "a live bridge's advertised address wins");
  d.send({ t: "pair.begin", roomId: st.roomId, name: "phone", scope: "read" });
  const granted = (await d.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret: string };
  d.close();

  // The phone SSH-es the BRIDGE's port; the raw bytes ride the cloud wss into the
  // gate's sshd, which authenticates the device and relays to the host's hc.
  const out = await new Promise<string>((resolve, reject) => {
    const conn = new Client();
    let buf = "";
    const finish = (): void => {
      try {
        conn.end();
      } catch {
        /* already gone */
      }
      resolve(buf);
    };
    const timer = setTimeout(finish, 6_000); // reply-driven, not close-driven
    conn
      .on("ready", () => {
        conn.exec("hc connect", (err, stream) => {
          if (err) return reject(err);
          stream.on("data", (x: Buffer) => (buf += x.toString()));
          stream.stderr?.on?.("data", (x: Buffer) => (buf += x.toString()));
          stream.on("close", () => {
            clearTimeout(timer);
            finish();
          });
          stream.write(JSON.stringify({ v: 1, id: 1, method: "hello", params: {} }) + "\n");
          setTimeout(() => stream.write(JSON.stringify({ v: 1, id: 2, method: "terminal.list", params: {} }) + "\n"), 500);
          setTimeout(() => stream.write(JSON.stringify({ v: 1, id: 3, method: "terminal.send", params: { id: "t1", text: "rm -rf /" } }) + "\n"), 1_100);
          setTimeout(() => stream.end(), 2_600);
        });
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: br.port, username: granted.device.id, password: granted.deviceSecret, readyTimeout: 10_000 });
  });
  const replies = out.split("\n").map((l) => {
    try {
      return JSON.parse(l) as { id?: number; result?: unknown; error?: unknown };
    } catch {
      return null;
    }
  });
  const byId = (id: number) => replies.find((r) => r?.id === id);
  assert.ok(byId(1)?.result, "hello answered through the bridge");
  assert.ok(byId(2)?.result, "terminal.list (read) answered through the bridge");
  const denied = byId(3);
  assert.ok(denied && (denied.error || JSON.stringify(denied).includes("read-only")), "the mutation is refused — scope enforcement survives the bridge");
  assert.ok(!readFileSync(hcLog, "utf8").includes("terminal.send"), "the mutation never reached herdr-core");

  // A wrong bridge token never becomes a front door.
  const bad = await startSshBridge({ cloudUrl: base, token: "wrong-token", bind: "127.0.0.1", port: 0, log: () => {} }).catch(() => null);
  if (bad) {
    // give the bad bridge a moment to be refused, then confirm it forwards nothing
    const refused = await new Promise<boolean>((resolve) => {
      const c = new Client();
      c.on("ready", () => { c.end(); resolve(false); })
        .on("error", () => resolve(true))
        .connect({ host: "127.0.0.1", port: bad.port, username: "x", password: "y", readyTimeout: 3_000 });
    });
    assert.ok(refused, "a bridge with a bad token forwards nothing");
    await bad.close();
  }

  // Teardown: the bridge gone, the hello falls back to the gate's own address.
  await br.close();
  let fellBack = false;
  for (let i = 0; i < 10 && !fellBack; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const peek2 = new Sock(`${wsBase}/v1/device/ws`);
    await peek2.opened;
    peek2.send({ t: "hello", accountToken: ACCOUNT, name: "peek" });
    const h2 = await peek2.expect("hello");
    peek2.close();
    fellBack = (h2.ssh as { port: number }).port === cloud.ssh?.port;
  }
  assert.ok(fellBack, "without a live bridge the gate's port returns");
  assert.ok(logs.some((l) => l.includes("bridge") && l.includes("connected")), "the cloud logged the bridge");

  agent.stop();
  await cloud.close();
});
