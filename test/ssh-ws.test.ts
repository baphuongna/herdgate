import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

import { startCloud } from "../src/cloud/gateway.ts";
import { encode } from "../src/protocol/envelope.ts";

interface Recv {
  t: string;
  [k: string]: unknown;
}

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
  async expect(t: string, timeoutMs = 5_000): Promise<Recv> {
    for (;;) {
      const hit = this.#inbox.shift();
      if (hit) return hit;
      const m = await this.next(timeoutMs);
      if (m.t === t) return m;
    }
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
  close(): void {
    this.ws.close();
  }
}

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

/**
 * The ssh-ws leg: when the TCP leg is unreachable (IPv4-only network vs an
 * AAAA-only host), the client wraps the system ssh in a ProxyCommand that pipes
 * the raw SSH stream through wss://gate/v1/ssh/ws. Auth, strikes and the
 * read-only allowlist must behave exactly as on the TCP leg.
 */
test("ssh over websocket: system ssh through the herdgate-via wrapper authenticates and opens the channel", async () => {
  const ACCOUNT = "ssh-ws-account-tok";
  const dir = mkdtempSync(join(tmpdir(), "herdgate-sshws-"));
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
  try {
    const code = (await fetch(`${base}/v1/agent/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ssh-host" }) }).then((r) => r.json())) as { code: string };
    await fetch(`${base}/v1/agent/approve`, { method: "POST", headers: { authorization: `Bearer ${ACCOUNT}`, "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
    const roomId = await roomIdOf(base, ACCOUNT);
    const sock = new DeviceSock(base.replace("http", "ws") + "/v1/device/ws");
    await sock.send({ t: "hello", accountToken: ACCOUNT, name: "ws-ssh" });
    await sock.expect("hello");
    sock.send({ t: "pair.begin", roomId, name: "ws-ssh", scope: "read" });
    const granted = (await sock.expect("pair.granted")) as unknown as { device: { id: string }; deviceSecret?: string };
    sock.close();
    assert.ok(granted.deviceSecret, "pair.granted carries the device secret");
    const reg = await fetch(`${base}/v1/device/sshkey`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: granted.device.id, deviceSecret: granted.deviceSecret, pubkey: pub }) });
    assert.equal(reg.status, 200);

    // (1) the wrapper's tunnel+ssh must authenticate and reach the exec channel:
    //     `exit` is the sshd no-op, so success = a clean exit 0 with no output.
    const via = join(import.meta.dirname, "..", "templates", "herdgate-via.mjs");
    // ssh resolves ~ from the passwd entry (not $HOME), so pin known-hosts to the
    // test's temp dir — the machine's real file must never learn test host keys.
    const known = join(dir, "known_hosts");
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn("node", args, { env: { ...process.env, HOME: dir, USERPROFILE: dir } });
        let out = "";
        p.stdout.on("data", (d: Buffer) => (out += d));
        p.stderr.on("data", (d: Buffer) => (out += d));
        const t = setTimeout(() => p.kill("SIGKILL"), 15_000);
        p.on("exit", (c) => { clearTimeout(t); resolve({ code: c, out }); });
      });
    const res = await run([
      via, "--gate", base, "--user", granted.device.id, "--key", keyPath, "--known-hosts", known, "--", "exit",
    ]);
    // No agent, so exec answers "host not connected" (exit 111) — what matters:
    // AUTH went through the websocket leg (no 255, no denial).
    assert.notEqual(res.code, 255, `ssh failed before the channel: ${res.out.slice(0, 300)}`);
    assert.ok(!res.out.includes("Permission denied"), res.out.slice(0, 300));
    assert.ok(res.out.includes("the host is not connected"), `the channel opened: ${res.out.slice(0, 300)}`);

    // (2) the probe mode must see the SSH banner over the same road.
    const probe = await run([via, "--probe", "--gate", base]);
    assert.ok(probe.code === 0 && /ok: .* speaks SSH-/.test(probe.out), `probe output: ${probe.out.slice(0, 200)}`);

    // (3) a bad key must be refused — auth is not skipped just because the
    //     socket came from a websocket.
    const badKey = join(dir, "bad_ed25519");
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ssh-keygen", ["-t", "ed25519", "-f", badKey, "-N", "", "-q"]);
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("ssh-keygen failed"))));
    });
    const bad = await run([via, "--gate", base, "--user", granted.device.id, "--key", badKey, "--known-hosts", known, "--", "exit"]);
    assert.equal(bad.code, 255);
    assert.ok(bad.out.includes("Permission denied"), bad.out.slice(0, 200));
  } finally {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
