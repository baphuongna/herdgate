/**
 * The host side of the SSH leg for the plugin publisher — the same rules as
 * src/host/ssh.ts, self-contained (a Herdr plugin ships this directory alone).
 *
 * The cloud relays `ssh.*` payloads opaquely; this module is the trusted decision point:
 * only `hc …` runs (argv, shell:false); a `read` device gets a filtered plain-mode
 * channel (mutating JSON-RPC methods refused here, framed downgraded, garbage cut off);
 * an `act` device approved on this host gets byte-transparent access.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const READ_METHODS = new Set([
  "hello",
  "rpc.discover",
  "server.status",
  "terminal.list",
  "terminal.get",
  "terminal.read",
  "terminal.wait",
  "templates.list",
  "events.subscribe",
  "doc.get",
  "machine.list",
]);

const FLUSH_MS = 20;
const FLUSH_BYTES = 64 * 1024;
const MAX_MALFORMED = 50;

export function resolveHc(env = process.env) {
  const bin = (env.HERDGATE_HC_BIN ?? "").trim();
  if (bin && existsSync(bin)) return bin;
  const local = join(homedir(), ".local", "bin", "hc");
  if (existsSync(local)) return local;
  return existsSync("/usr/bin/hc") ? "/usr/bin/hc" : "hc";
}

export function createSshBridge({ send, scopeOf, log = () => {}, resolve = resolveHc, spawnImpl = spawn }) {
  const channels = new Map();
  const key = (device, ch) => `${device}:${ch}`;

  const sendOut = (c, final, code, reason) => {
    if (c.outBuf.length > 0) {
      send(c.device, { op: "ssh.data", ch: c.ch, b64: c.outBuf.toString("base64") });
      c.outBuf = Buffer.alloc(0);
    }
    if (final) {
      send(c.device, { op: "ssh.closed", ch: c.ch, ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) });
    }
  };
  const scheduleFlush = (c) => {
    if (c.flushTimer) return;
    c.flushTimer = setTimeout(() => {
      c.flushTimer = null;
      if (!c.closed) sendOut(c, false);
    }, FLUSH_MS);
    c.flushTimer.unref?.();
  };

  const refuseCall = (c, id, method) => {
    const err = JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32600, message: `herdgate: "${method}" needs the act scope (this device is read-only)`, data: { kind: "forbidden", method } },
    });
    c.outBuf = Buffer.concat([c.outBuf, Buffer.from(err + "\n")]);
    scheduleFlush(c);
  };

  const feed = (c, buf) => {
    if (c.closed || !c.proc?.stdin) return;
    if (c.scope === "act") return void c.proc.stdin.write(buf);
    c.inBuf = Buffer.concat([c.inBuf, buf]);
    for (;;) {
      const nl = c.inBuf.indexOf(0x0a);
      if (nl < 0) break;
      const line = c.inBuf.subarray(0, nl);
      c.inBuf = c.inBuf.subarray(nl + 1);
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = null;
      }
      if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
        c.malformed += 1;
        if (c.malformed > MAX_MALFORMED) {
          log(`ssh: ${c.device}/${c.ch} cut off after ${c.malformed} malformed lines`);
          kill(c, "too much malformed input");
          return;
        }
        continue;
      }
      const { method } = msg;
      if (method === "hello" && msg.params && typeof msg.params === "object" && msg.params.framed === true) {
        msg.params.framed = false; // live terminals are write streams; read stays plain
        log(`ssh: ${c.device}/${c.ch} hello framed:true downgraded (read scope)`);
      }
      if (!READ_METHODS.has(method)) {
        refuseCall(c, msg.id, method);
        continue;
      }
      c.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  };

  const kill = (c, reason) => {
    c.closed = true;
    if (c.flushTimer) clearTimeout(c.flushTimer);
    c.proc?.kill("SIGKILL");
    channels.delete(key(c.device, c.ch));
    sendOut(c, true, 130, reason);
  };

  return {
    handle(device, payload) {
      if (typeof payload !== "object" || payload === null) return false;
      const op = payload.op;
      if (typeof op !== "string" || !op.startsWith("ssh.")) return false;
      const ch = typeof payload.ch === "string" ? payload.ch : "";

      if (op === "ssh.open") {
        const scope = scopeOf(device);
        if (!scope) {
          send(device, { op: "ssh.denied", ch, reason: "this device is not paired to this room" });
          return true;
        }
        const cmd = typeof payload.cmd === "string" ? payload.cmd.trim() : "";
        const parts = cmd.split(/\s+/).filter(Boolean);
        if (parts.length === 0 || parts[0] !== "hc") {
          send(device, { op: "ssh.denied", ch, reason: `herdgate bridges "hc …" only, got "${cmd.slice(0, 60) || "(empty)"}"` });
          return true;
        }
        let proc;
        try {
          proc = spawnImpl(resolve(), parts.slice(1), { stdio: ["pipe", "pipe", "pipe"], shell: false });
        } catch (e) {
          send(device, { op: "ssh.denied", ch, reason: `could not start herdr-core: ${e.message}` });
          return true;
        }
        const c = { device, ch, scope, proc, inBuf: Buffer.alloc(0), outBuf: Buffer.alloc(0), flushTimer: null, malformed: 0, closed: false };
        channels.set(key(device, ch), c);
        const onData = (chunk) => {
          c.outBuf = Buffer.concat([c.outBuf, chunk]);
          if (c.outBuf.length >= FLUSH_BYTES) sendOut(c, false);
          else scheduleFlush(c);
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", (e) => {
          const enoent = e.code === "ENOENT";
          log(`ssh: spawn failed for ${device}/${ch}: ${e.message}`);
          channels.delete(key(device, ch));
          c.closed = true;
          if (c.flushTimer) clearTimeout(c.flushTimer);
          send(device, { op: "ssh.denied", ch, reason: enoent ? "herdr-core (hc) was not found on this host" : `could not start herdr-core: ${e.message}` });
        });
        proc.on("close", (code, signal) => {
          if (c.closed) return;
          c.closed = true;
          if (c.flushTimer) clearTimeout(c.flushTimer);
          channels.delete(key(device, ch));
          sendOut(c, true, code ?? (signal ? 130 : 1), signal ? `terminated by ${signal}` : undefined);
        });
        send(device, { op: "ssh.granted", ch, scope });
        log(`ssh: ${device}/${ch} → ${cmd} (${scope})`);
        return true;
      }

      if (op === "ssh.data") {
        const c = channels.get(key(device, ch));
        if (!c) return true;
        const b64 = typeof payload.b64 === "string" ? payload.b64 : "";
        if (b64.length > 400_000) return true;
        feed(c, Buffer.from(b64, "base64"));
        return true;
      }

      if (op === "ssh.close") {
        const c = channels.get(key(device, ch));
        if (!c) return true;
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        c.proc?.kill("SIGTERM");
        channels.delete(key(device, ch));
        sendOut(c, true, 0, "closed by the device");
        return true;
      }

      return false;
    },
    dropDevice(device) {
      for (const [k, c] of [...channels]) {
        if (c.device === device) {
          c.closed = true;
          if (c.flushTimer) clearTimeout(c.flushTimer);
          c.proc?.kill("SIGTERM");
          channels.delete(k);
        }
      }
    },
    closeAll() {
      for (const [, c] of [...channels]) {
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        c.proc?.kill("SIGTERM");
      }
      channels.clear();
    },
  };
}
