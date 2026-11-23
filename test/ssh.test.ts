/**
 * The SSH leg end to end: a real SSH client (ssh2), the cloud's real sshd, and the real
 * host bridge spawning a stand-in herdr-core. Covers the rules, not just the plumbing:
 *
 *   - auth is per-device (id + the secret pair.granted issued once), not the account token;
 *   - `act` (human-approved on the host) is byte-transparent — framed stays framed;
 *   - `read` is filtered AT THE HOST: mutating JSON-RPC methods never reach herdr-core,
 *     the phone gets an honest error, and a `framed: true` hello is downgraded;
 *   - only `hc …` runs; anything else is refused with the reason on the wire;
 *   - wrong device key = auth failure.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "ssh2";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import { type AgentAdapter, type PairAsk } from "../src/agent/adapter.ts";
import { createSshBridge } from "../src/host/ssh.ts";
import { encode } from "../src/protocol/envelope.ts";

const FAKE_HC = join(import.meta.dirname, "fake-hc.helper.mjs");

interface Recv {
  t: string;
  [k: string]: unknown;
}

/** A raw device socket with promise-based receive (mirrors test/e2e.test.ts). */
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
      const t = setTimeout(() => rej(new Error("no message in time")), timeoutMs);
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

/** Pair one device over the device leg; returns { id, secret, sock }. */
async function pairDevice(base: string, token: string, roomId: string, name: string, scope: "read" | "act") {
  const sock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
  await sock.send({ t: "hello", accountToken: token, name });
  await sock.expect("hello");
  sock.send({ t: "pair.begin", roomId, name, scope });
  const granted = (await sock.expect("pair.granted")) as unknown as { device: { id: string; roomId: string }; deviceSecret?: string };
  assert.ok(granted.deviceSecret, "pair.granted carries the one-time device secret");
  return { id: granted.device.id, roomId: granted.device.roomId, secret: granted.deviceSecret!, sock };
}

interface ExecResult {
  code: number | null;
  out: string;
}

/** One exec over a fresh SSH connection. Rejects on auth failure. */
function sshExec(opts: { port: number; username: string; password: string; cmd: string; write?: string[]; maxMs?: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = "";
    const done = (r: ExecResult) => {
      try {
        conn.end();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ code: null, out }), opts.maxMs ?? 8_000);
    conn
      .on("ready", () => {
        conn.exec(opts.cmd, (err, stream) => {
          if (err) return done({ code: -1, out: String(err) });
          stream.on("data", (d: Buffer) => (out += d.toString()));
          stream.stderr?.on?.("data", (d: Buffer) => (out += d.toString()));
          stream.on("close", (code: number | null) => {
            clearTimeout(timer);
            done({ code, out });
          });
          if (opts.write) {
            let i = 0;
            const iv = setInterval(() => {
              if (i >= opts.write!.length) return clearInterval(iv);
              stream.write(opts.write![i]);
              i += 1;
            }, 30);
          }
        });
      })
      .on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      })
      .connect({ host: "127.0.0.1", port: opts.port, username: opts.username, password: opts.password, readyTimeout: 8_000 });
  });
}

test("ssh leg: per-device auth, act passthrough, read filtering, hc-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-ssh-"));
  const hcLog = join(dir, "hc-methods.log");
  process.env.FAKE_HC_LOG = hcLog;
  const ACCOUNT = "ssh-account-tok";
  let cloudSshPort = 0;

  // The host: an agent whose adapter is the real bridge over the stand-in herdr-core.
  const bridge = createSshBridge({
    send: (device, payload) => agent.send(device, payload),
    scopeOf: (device) => agent.scopeOf(device),
    log: () => {},
    resolveHc: () => "hc",
    spawnImpl: (bin, args, opts) => spawn(process.execPath, [FAKE_HC, ...args], opts),
  });
  const adapter: AgentAdapter = {
    info: () => ({ name: "ssh-host", version: "0.0.0" }),
    onFrame: (device, payload) => {
      if (bridge.handle(device, payload)) return;
      // The Herdr adapter would refuse everything else; nothing else arrives in this test.
    },
    onDevices: () => {},
    onPairAsk: (ask: PairAsk) => ask.scope === "act",
  };
  let agent: HerdGateAgent;

  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: () => {},
    ssh: { port: 0, keyPath: join(dir, "hostkey.json") }, // port 0 = an ephemeral listener
  });
  cloudSshPort = cloud.ssh?.port ?? 0;
  assert.ok(cloudSshPort > 0, "the ssh listener came up");
  assert.match(cloud.ssh?.hostKeyFingerprint ?? "", /^SHA256:/, "the host key fingerprint is reported");

  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    // Provision the room through the device flow.
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ssh-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string };
    agent = new HerdGateAgent({ endpoint: base.replace("http", "ws") + "/v1/agent/ws", roomToken: st.roomToken!, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;

    const roomId = await roomIdOf(base, ACCOUNT);
    const act = await pairDevice(base, ACCOUNT, roomId, "phone-act", "act");
    const read = await pairDevice(base, ACCOUNT, roomId, "phone-read", "read");
    assert.equal(read.roomId, roomId);

    // -- 1. act device: framed stays framed, mutations pass (human approved this one). --
    const r1 = await sshExec({
      port: cloudSshPort,
      username: act.id,
      password: act.secret,
      cmd: "hc connect",
      write: [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "terminal.send", params: { terminal: "t1", text: "hi" } }) + "\n",
      ],
      maxMs: 5_000,
    });
    assert.ok(r1.out.includes('"echo":"hello"'), `act got the hello reply: ${r1.out.slice(0, 200)}`);
    assert.ok(r1.out.includes('"framed":true'), "act keeps framed mode (byte-transparent)");
    assert.ok(r1.out.includes('"echo":"terminal.send"'), "act may mutate");
    assert.ok(readFileSync(hcLog, "utf8").includes("terminal.send"), "herdr-core received the act call");

    // -- 2. read device: framed downgraded, mutations refused AT THE HOST. --
    unlinkSync(hcLog);
    const r2 = await sshExec({
      port: cloudSshPort,
      username: read.id,
      password: read.secret,
      cmd: "hc connect",
      write: [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "terminal.send", params: { terminal: "t1", text: "rm -rf" } }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "terminal.list", params: {} }) + "\n",
      ],
      maxMs: 5_000,
    });
    assert.ok(r2.out.includes('"echo":"hello"'), "read got the hello reply");
    assert.ok(r2.out.includes('"framed":false'), "read was downgraded to plain mode");
    assert.ok(r2.out.includes('"forbidden"') && r2.out.includes("terminal.send"), "the refused call explains itself");
    assert.ok(!r2.out.includes('"echo":"terminal.send"'), "the mutation never executed");
    assert.ok(r2.out.includes('"echo":"terminal.list"'), "reads pass");
    const seen = existsSync(hcLog) ? readFileSync(hcLog, "utf8") : "";
    assert.ok(!seen.includes("terminal.send"), "herdr-core never saw the refused method");
    assert.match(seen, /"framed":false/, "herdr-core saw the downgraded hello");

    // -- 3. only hc runs. --
    const r3 = await sshExec({
      port: cloudSshPort,
      username: act.id,
      password: act.secret,
      cmd: "rm -rf /tmp/x",
      maxMs: 5_000,
    });
    assert.equal(r3.code, 111, "a non-hc command is refused with exit 111");
    assert.match(r3.out, /not a supported Herdr or herdr-core command/);

    // -- 4. a wrong device key is an auth failure. --
    await assert.rejects(
      () => sshExec({ port: cloudSshPort, username: read.id, password: "wrong-key", cmd: "hc connect", maxMs: 5_000 }),
      /All authentication methods failed|authentication/,
      "a bad device key must not open the gate",
    );

    // -- 5. the account token is NOT an SSH credential. --
    await assert.rejects(
      () => sshExec({ port: cloudSshPort, username: "a1", password: ACCOUNT, cmd: "hc connect", maxMs: 5_000 }),
      /All authentication methods failed|authentication/,
      "the account token does not open the SSH leg",
    );

    // -- 6. a paired device reconnects with its own key (no account token anywhere). --
    const d3 = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await d3.send({ t: "hello", device: read.id, deviceSecret: read.secret, name: "phone-read" });
    const hello3 = (await d3.expect("hello")) as unknown as { device: { id: string } | null };
    assert.equal(hello3.device?.id, read.id, "device-key hello re-attaches identity");
    d3.send({ t: "pair.begin", roomId: read.roomId, name: "x", scope: "act" });
    const err = await d3.expect("error");
    assert.equal(err.code, "owner-only", "device-key sockets cannot pair");

    read.sock.close();
    act.sock.close();
    d3.close();
    bridge.closeAll();
    agent.stop();
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The room id via the owner's device-leg hello (the agent's device list is private). */
async function roomIdOf(base: string, token: string): Promise<string> {
  const ws = new WebSocket(base.replace("http", "ws") + "/v1/device/ws");
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.send(encode({ t: "hello", accountToken: token, name: "prober" }));
  const hello = await new Promise<Recv>((res, rej) => {
    const t = setTimeout(() => rej(new Error("no hello")), 5_000);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
      if (m.t === "hello") {
        clearTimeout(t);
        res(m);
      }
    });
  });
  ws.close();
  return (hello.agents as { roomId: string }[])[0].roomId;
}

test("translateBootstrap maps herdr-core probes to hc, refuses shell tricks", async () => {
  const { translateBootstrap } = await import("../src/host/ssh.ts");
  const posix = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; exec "$p" connect'`;
  const sess = `sh -c 'p=$(command -v herdr-core); exec "$p" --session work connect'`;
  const win = `cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"`;
  assert.equal(translateBootstrap(posix), "hc connect");
  assert.equal(translateBootstrap(sess), "hc --session work connect");
  assert.equal(translateBootstrap(win), "hc connect");
  assert.equal(translateBootstrap(`sh -c 'exec "$p" connect; rm -rf /'`), null);
  assert.equal(translateBootstrap(`sh -c 'rm -rf /'`), null);
  assert.equal(translateBootstrap(`hc connect`), null); // not a wrapper — normal path
});

test("ssh leg: an authenticated connection is live in the roster — and the roster separates host-alive", async () => {
  // Caught live on 2026-11-23: an ssh device (the herdr machine lane, ssh probes)
  // never showed `connected` — the roster only counted the PWA websocket leg —
  // and the operator reading 0/6 live concluded "laptop disconnected" while the
  // publisher was connected with fresh hostInfo. Presence must count the ssh
  // leg too, and the roster must carry the host's own aliveness separately.
  const dir = mkdtempSync(join(tmpdir(), "herdgate-ssh-presence-"));
  const ACCOUNT = "ssh-presence-tok";
  const adapter: AgentAdapter = {
    info: () => ({ name: "ssh-host", version: "0.0.0" }),
    onFrame: () => {},
    onDevices: () => {},
    onPairAsk: (ask: PairAsk) => ask.scope === "act",
  };
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: () => {},
    ssh: { port: 0, keyPath: join(dir, "hostkey.json") },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "presence-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string };
    const agent = new HerdGateAgent({ endpoint: base.replace("http", "ws") + "/v1/agent/ws", roomToken: st.roomToken!, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const roomId = await roomIdOf(base, ACCOUNT);
    const dev = await pairDevice(base, ACCOUNT, roomId, "ssh-probe", "read");
    dev.sock.close(); // the pairing websocket is itself a live leg — we are testing the ssh one
    await waitFor(300); // let the close reach the gate before asserting the baseline

    const roster = async (): Promise<{ host?: { connected?: boolean }; devices: { id: string; connected: boolean; legs?: string[] }[] }> =>
      (await fetch(`${base}/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${ACCOUNT}` } }).then((r) => r.json()));

    // Before any connection: not live, but the HOST is online — two different axes.
    const r0 = await roster();
    assert.equal(r0.devices.find((d) => d.id === dev.id)?.connected, false, "no connection, not live");
    assert.equal(r0.host?.connected, true, "the roster carries publisher-alive (agent ws) separately");

    // An authenticated ssh connection — held open, no exec needed.
    const conn = new Client();
    const ready = new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ssh connect timeout")), 8_000);
      conn.on("ready", () => { clearTimeout(t); res(); }).on("error", rej);
    });
    conn.connect({ host: "127.0.0.1", port: cloud.ssh!.port!, username: dev.id, password: dev.secret, readyTimeout: 8_000 });
    await ready;

    const r1 = await roster();
    const mine = r1.devices.find((d) => d.id === dev.id)!;
    assert.equal(mine.connected, true, "an authenticated ssh connection counts as live");
    assert.ok(mine.legs?.includes("ssh"), `legs names the ssh lane: ${JSON.stringify(mine.legs)}`);
    assert.equal(r1.host?.connected, true);

    conn.end();
    await waitFor(400);
    const r2 = await roster();
    assert.equal(r2.devices.find((d) => d.id === dev.id)?.connected, false, "closing the ssh connection flips live off");
    assert.equal(r2.host?.connected, true, "host liveness is its own axis — it never moved");

    await agent.stop();
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ssh leg: publickey auth — register a key, log in without a password", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-sshkey-"));
  process.env.FAKE_HC_LOG = join(dir, "hc-methods.log");
  const ACCOUNT = "ssh-key-account-tok";
  const { generateKeyPairSync } = (await import("ssh2")).default.utils as unknown as {
    generateKeyPairSync: (t: string) => { private: string; public: string };
  };
  const good = generateKeyPairSync("ed25519");
  const bad = generateKeyPairSync("ed25519");

  const bridge = createSshBridge({
    send: (device, payload) => agent?.send(device, payload) ?? false,
    scopeOf: (device) => agent?.scopeOf(device) ?? "read",
    log: () => {},
    resolveHc: () => "hc",
    spawnImpl: (bin, args, opts) => spawn(process.execPath, [FAKE_HC, ...args], opts),
  });
  const adapter: AgentAdapter = {
    info: () => ({ name: "ssh-host", version: "0.0.0" }),
    onFrame: (device, payload) => void bridge.handle(device, payload),
    onDevices: () => {},
    onPairAsk: (ask: PairAsk) => ask.scope === "act",
  };
  let agent: HerdGateAgent | undefined;
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: () => {},
    ssh: { port: 0, keyPath: join(dir, "hostkey.json") },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  const port = cloud.ssh?.port ?? 0;
  try {
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ssh-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const st = (await fetch(`${base}/v1/agent/code/${code.code}/status`).then((r) => r.json())) as { roomToken?: string };
    agent = new HerdGateAgent({ endpoint: base.replace("http", "ws") + "/v1/agent/ws", roomToken: st.roomToken!, adapter, log: () => {} });
    agent.start();
    await agent.firstHello;
    const roomId = await roomIdOf(base, ACCOUNT);
    const dev = await pairDevice(base, ACCOUNT, roomId, "key-phone", "act");

    // REST rejects garbage, accepts a real line.
    const badReq = await fetch(`${base}/v1/device/sshkey`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: dev.id, deviceSecret: dev.secret, pubkey: "ssh-ed25519 AAAA not-a-key" }) });
    assert.equal(badReq.status, 400, "garbage pubkey rejected");
    const okReq = await fetch(`${base}/v1/device/sshkey`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: dev.id, deviceSecret: dev.secret, pubkey: good.public }) });
    assert.equal(okReq.status, 200);
    const listed = (await (await fetch(`${base}/v1/device/sshkey?device=${dev.id}`, { headers: { "x-herdgate-secret": dev.secret } })).json()) as { keys: { fp: string }[] };
    assert.equal(listed.keys.length, 1);
    assert.match(listed.keys[0].fp, /^SHA256:/);

    // A fresh SSH connection with ONLY the private key (no password) reaches hc.
    const r = await new Promise<ExecResult>((resolve, reject) => {
      const conn = new Client();
      let out = "";
      const done = (x: ExecResult) => { try { conn.end(); } catch { /* closed */ } resolve(x); };
      const timer = setTimeout(() => done({ code: null, out }), 8_000);
      conn.on("ready", () => {
        conn.exec("hc connect", (err, stream) => {
          if (err) return done({ code: -1, out: String(err) });
          stream.on("data", (d: Buffer) => (out += d.toString()));
          stream.on("close", (c: number | null) => { clearTimeout(timer); done({ code: c, out }); });
          stream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: {} }) + "\n");
        });
      }).on("error", (e) => { clearTimeout(timer); reject(e); })
        .connect({ host: "127.0.0.1", port, username: dev.id, privateKey: good.private, readyTimeout: 8_000 });
    });
    assert.ok(r.out.includes('"echo":"hello"'), `key auth reached hc: ${r.out.slice(0, 200)}`);

    // An UNREGISTERED key never gets in.
    const expectKeyReject = (priv: string, why: string) =>
      assert.rejects(
        () =>
          new Promise<ExecResult>((resolve, reject) => {
            const conn = new Client();
            conn.on("error", (e) => {
              try {
                conn.end();
              } catch {
                /* closed */
              }
              reject(e);
            }).on("ready", () => {
              conn.end();
              reject(new Error(why));
            }).connect({ host: "127.0.0.1", port, username: dev.id, privateKey: priv, readyTimeout: 5_000 });
          }),
        /All configured authentication methods failed/,
      );
    await expectKeyReject(bad.private, "authenticated with a wrong key");

    // Removing one key must also close its already-authenticated connections,
    // without affecting connections authenticated with the device password.
    const open = async (credentials: { privateKey: string } | { password: string }) => {
      const conn = new Client();
      const ready = once(conn, "ready", { signal: AbortSignal.timeout(4000) });
      conn.connect({ host: "127.0.0.1", port, username: dev.id, readyTimeout: 3000, ...credentials });
      await ready;
      return conn;
    };
    const active = await open({ privateKey: good.private });
    const withPassword = await open({ password: dev.secret });
    const keyClosed = once(active, "close", { signal: AbortSignal.timeout(4000) });
    const afterAdd = (await (await fetch(`${base}/v1/device/sshkey?device=${dev.id}`, { headers: { "x-herdgate-secret": dev.secret } })).json()) as { keys: { b64: string }[] };
    const del = await fetch(`${base}/v1/device/sshkey`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: dev.id, deviceSecret: dev.secret, b64: afterAdd.keys[0].b64 }) });
    assert.equal(del.status, 200);
    await keyClosed;
    await expectKeyReject(good.private, "authenticated after key removal");
    const passwordClosed = once(withPassword, "close", { signal: AbortSignal.timeout(4000) });
    const revoked = await fetch(`${base}/v1/device/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" },
      body: JSON.stringify({ device: dev.id }),
    });
    assert.equal(revoked.status, 200);
    await passwordClosed;
  } finally {
    agent?.stop();
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ssh leg: publickey via the real OpenSSH client (regression: ssh2's broken server-sig-algs)", async () => {
  if (process.platform !== "linux") return; // needs the system `ssh`
  const dir = mkdtempSync(join(tmpdir(), "herdgate-ssh-sys-"));
  const ACCOUNT = "ssh-sys-account-tok";
  const keyPath = join(dir, "id_ed25519");
  const pub = await new Promise<string>((resolve, reject) => {
    const p = spawn("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);
    p.on("exit", (c) => (c === 0 ? resolve(readFileSync(keyPath + ".pub", "utf8").trim()) : reject(new Error("ssh-keygen failed"))));
  });

  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: ACCOUNT }],
    log: () => {},
    ssh: { port: 0, keyPath: join(dir, "hostkey.json") },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  const port = cloud.ssh?.port ?? 0;
  try {
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ssh-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const roomId = await roomIdOf(base, ACCOUNT);
    const sock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await sock.send({ t: "hello", accountToken: ACCOUNT, name: "sys-ssh" });
    await sock.expect("hello");
    sock.send({ t: "pair.begin", roomId, name: "sys-ssh", scope: "read" });
    const granted = (await sock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret?: string };
    sock.close();
    const reg = await fetch(`${base}/v1/device/sshkey`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: granted.device.id, deviceSecret: granted.deviceSecret, pubkey: pub }) });
    assert.equal(reg.status, 200);

    // BatchMode = the app's world: no TTY, no agent help, only the key. `exit` is the
    // sshd's no-op, so a successful run is a clean exit 0 with no output.
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn("ssh", [
        "-p", String(port),
        "-o", "BatchMode=yes",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "StrictHostKeyChecking=no",
        "-o", `IdentityFile=${keyPath}`,
        "-o", "IdentitiesOnly=yes",
        `${granted.device.id}@127.0.0.1`,
        "exit",
      ]);
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.stderr.on("data", (d: Buffer) => (out += d));
      const t = setTimeout(() => p.kill("SIGKILL"), 10_000);
      p.on("exit", (c) => { clearTimeout(t); resolve({ code: c, out }); });
    });
    // No agent in this test, so exec ends with the honest "host not connected"
    // (exit 111) — what matters is that AUTH succeeded: no denial, no ssh-level 255.
    assert.notEqual(res.code, 255, `system ssh failed before the channel: ${res.out.slice(0, 200)}`);
    assert.ok(!res.out.includes("Permission denied"), res.out.slice(0, 200));
    assert.ok(res.out.includes("the host is not connected"), `the channel opened: ${res.out.slice(0, 200)}`);
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("translateMobileCore: older phones send the adapter path verbatim — map by verb, never spawn the path", async () => {
  const { translateMobileCore } = (await import("../plugin/server/ssh.mjs")) as { translateMobileCore: (cmd: string) => string[] | null };
  // Live shape from the laptop report 2026-11-23 18:07: phone app build sends the
  // full adapter path; tuiOnly publishers must recognize it, DROP the path, and
  // map only the verb through the fixed whitelist.
  const live = "hc C:\\Users\\phuongnb\\AppData\\Local\\HerdrPilot\\releases\\tui-43508dc7d2bbc2ea\\plugin\\server\\mobile-tui-core.mjs --interactive connect";
  assert.deepEqual(translateMobileCore(live), ["connect"]);
  assert.deepEqual(translateMobileCore('hc "/opt/h g/mobile-tui-core.mjs" --interactive server status --json'), ["server", "status", "--json"]);
  assert.deepEqual(translateMobileCore("hc /x/y/mobile-tui-core.mjs connect"), ["connect"]);
  assert.equal(translateMobileCore("hc /x/mobile-tui-core.mjs rm -rf /"), null, "verb must come from the whitelist");
  assert.equal(translateMobileCore("hc /x/other-core.mjs connect"), null, "only the mobile-tui-core adapter script counts");
  assert.equal(translateMobileCore("hc /x/mobile-tui-core.mjs --interactive connect; rm -rf /"), null, "trailing junk is not a whitelisted verb");
  assert.deepEqual(translateMobileCore("hc connect"), ["connect"], "the new bare-verb form keeps working");
});
