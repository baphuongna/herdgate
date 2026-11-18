/**
 * The host side of the SSH leg: turn a phone's SSH session into a real `hc` process.
 *
 * The cloud relays `ssh.*` payloads opaquely; THIS module is the trusted decision point:
 *
 *   - a channel runs exactly one command, and only `hc …` (argv split, `shell: false`) —
 *     never a shell, never anything else;
 *   - a `read` device gets a filtered plain-mode channel: mutating JSON-RPC methods are
 *     refused AT THIS GATE (the phone sees an honest JSON-RPC error; herdr-core never
 *     sees the call), a `framed: true` hello is downgraded to plain mode, and a stream
 *     of garbage is cut off;
 *   - an `act` device (approved by a human on this host) gets byte-transparent access —
 *     framed mode, attach, everything herdr-core offers;
 *   - output back to the phone is coalesced (~20 ms) so a chatty terminal stays under
 *     the wire's frame-rate limits.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Methods a `read` device may call on herdr-core. Everything else is refused here. */
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

export interface SshBridgeOptions {
  /** Route an opaque payload to one device. */
  send(device: string, payload: Record<string, unknown>): void;
  /** The device's scope in this room (`null` when unknown). */
  scopeOf(device: string): "read" | "act" | null;
  log?(line: string): void;
  /** Where herdr-core is; resolved once per channel by default. */
  resolveHc?: () => string | null;
  spawnImpl?: (bin: string, args: string[], opts: { stdio: ("pipe" | null)[]; shell: boolean }) => ChildProcess;
}

interface HostChannel {
  device: string;
  ch: string;
  scope: "read" | "act";
  proc: ChildProcess | null;
  /** Bytes from the phone awaiting a newline (read scope parses line by line). */
  inBuf: Buffer;
  /** Bytes from hc awaiting the next flush. */
  outBuf: Buffer;
  flushTimer: NodeJS.Timeout | null;
  malformed: number;
  closed: boolean;
}

export interface SshBridge {
  /** Handle one frame payload; returns true when it was an ssh.* op this module owns. */
  handle(device: string, payload: unknown): boolean;
  /** Drop every channel of a device (device disconnected from the cloud). */
  dropDevice(device: string): void;
  closeAll(): void;
}


/** Extract `hc <verb>` from herdr-core's known machine-add probes (null = not one). */
export function translateBootstrap(cmd: string): string | null {
  // POSIX: sh -c 'p=$(command -v herdr-core) …; exec "$p" connect'
  const posix = cmd.match(/exec "\$p"\s+([^'"\n]+?)['"]?\s*$/);
  if (posix) {
    const args = posix[1].trim();
    // Strict whitelist: flags, words, equals — never shell metacharacters.
    if (/^[-a-z0-9][-a-z0-9 =]*$/i.test(args)) return `hc ${args}`;
  }
  // Windows: cmd /d /c "…herdr-core.exe connect) …"
  const win = cmd.match(/herdr-core\.exe\)?\s+\(?([a-z][a-z0-9-]*)\)/);
  if (win) return `hc ${win[1]}`;
  return null;
}

export function createSshBridge(o: SshBridgeOptions): SshBridge {
  const log = o.log ?? (() => {});
  const spawnFn = o.spawnImpl ?? spawn;
  const channels = new Map<string, HostChannel>();
  const key = (device: string, ch: string): string => `${device}:${ch}`;

  const resolveHc =
    o.resolveHc ??
    ((): string | null => {
      const env = process.env.HERDGATE_HC_BIN?.trim();
      if (env && existsSync(env)) return env;
      const local = join(homedir(), ".local", "bin", "hc");
      if (existsSync(local)) return local;
      return existsSync("/usr/bin/hc") ? "/usr/bin/hc" : "hc"; // let spawn report ENOENT honestly
    });

  const sendOut = (c: HostChannel, final: boolean, code?: number, reason?: string): void => {
    if (c.outBuf.length > 0) {
      o.send(c.device, { op: "ssh.data", ch: c.ch, b64: c.outBuf.toString("base64") });
      c.outBuf = Buffer.alloc(0);
    }
    if (final) {
      o.send(c.device, { op: "ssh.closed", ch: c.ch, ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) });
    }
  };

  const scheduleFlush = (c: HostChannel): void => {
    if (c.flushTimer) return;
    c.flushTimer = setTimeout(() => {
      c.flushTimer = null;
      if (!c.closed) sendOut(c, false);
    }, FLUSH_MS);
    c.flushTimer.unref?.();
  };

  const deny = (c: HostChannel, reason: string): void => {
    o.send(c.device, { op: "ssh.denied", ch: c.ch, reason });
  };

  /** A refused call never reaches herdr-core: the phone gets a real JSON-RPC error. */
  const refuseCall = (c: HostChannel, id: unknown, method: string): void => {
    const err = JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32600, message: `herdgate: "${method}" needs the act scope (this device is read-only)`, data: { kind: "forbidden", method } },
    });
    c.outBuf = Buffer.concat([c.outBuf, Buffer.from(`${err}\n`)]);
    scheduleFlush(c);
  };

  /** Feed phone bytes into the channel; `read` scope parses, `act` pipes blind. */
  const feed = (c: HostChannel, buf: Buffer): void => {
    if (c.closed || !c.proc?.stdin) return;
    if (c.scope === "act") {
      c.proc.stdin.write(buf);
      return;
    }
    c.inBuf = Buffer.concat([c.inBuf, buf]);
    for (;;) {
      const nl = c.inBuf.indexOf(0x0a);
      if (nl < 0) break;
      const line = c.inBuf.subarray(0, nl);
      c.inBuf = c.inBuf.subarray(nl + 1);
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let msg: { method?: unknown; id?: unknown; params?: Record<string, unknown> } | null = null;
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
      const method = msg.method;
      if (method === "hello" && msg.params && typeof msg.params === "object") {
        // Live terminals (framed attach) are byte streams a read-only device must not
        // write into; downgrade to plain mode so list/read still work honestly.
        if (msg.params.framed === true) {
          msg.params.framed = false;
          log(`ssh: ${c.device}/${c.ch} hello framed:true downgraded (read scope)`);
        }
      }
      if (!READ_METHODS.has(method)) {
        refuseCall(c, msg.id, method);
        continue;
      }
      c.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  };

  const kill = (c: HostChannel, reason: string): void => {
    c.closed = true;
    if (c.flushTimer) clearTimeout(c.flushTimer);
    c.proc?.kill("SIGKILL");
    channels.delete(key(c.device, c.ch));
    sendOut(c, true, 130, reason);
  };

  const handle = (device: string, payload: unknown): boolean => {
    if (typeof payload !== "object" || payload === null) return false;
    const op = (payload as { op?: unknown }).op;
    if (typeof op !== "string" || !op.startsWith("ssh.")) return false;
    const p = payload as Record<string, unknown>;
    const ch = typeof p.ch === "string" ? p.ch : "";

    if (op === "ssh.open") {
      const scope = o.scopeOf(device);
      if (!scope) {
        o.send(device, { op: "ssh.denied", ch, reason: "this device is not paired to this room" });
        return true;
      }
      const cmd = typeof p.cmd === "string" ? p.cmd.trim() : "";
      // herdr-core's `machine add` probes with shell wrappers that locate a binary
      // named `herdr-core` and `exec` it (POSIX and Windows templates). We never run
      // shell lines: translate the KNOWN templates to the equivalent `hc <verb>` and
      // let the normal path spawn it. Anything else shell-shaped is refused below.
      const bootstrap = cmd.includes("herdr-core") ? translateBootstrap(cmd) : null;
      const parts = (bootstrap ?? cmd).split(/\s+/).filter(Boolean);
      if (parts.length > 0 && parts[0] === "exit" && (parts.length === 1 || parts[1] === "0")) {
        // SSH clients end probe sessions with `exit` — acknowledge and close clean.
        o.send(device, { op: "ssh.granted", ch, scope });
        o.send(device, { op: "ssh.closed", ch, code: 0 });
        return true;
      }
      if (parts.length === 0 || parts[0] !== "hc") {
        // One command family only: the phone speaks herdr-core through this leg.
        o.send(device, { op: "ssh.denied", ch, reason: `herdgate bridges "hc …" only, got "${cmd.slice(0, 60) || "(empty)"}"` });
        return true;
      }
      const bin = resolveHc();
      const args = parts.slice(1);
      let proc: ChildProcess;
      try {
        proc = spawnFn(bin ?? "hc", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
      } catch (e) {
        o.send(device, { op: "ssh.denied", ch, reason: `could not start herdr-core: ${e instanceof Error ? e.message : String(e)}` });
        return true;
      }
      const c: HostChannel = { device, ch, scope, proc, inBuf: Buffer.alloc(0), outBuf: Buffer.alloc(0), flushTimer: null, malformed: 0, closed: false };
      channels.set(key(device, ch), c);

      proc.stdout?.on("data", (chunk: Buffer) => {
        c.outBuf = Buffer.concat([c.outBuf, chunk]);
        scheduleFlush(c);
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        // herdr-core writes diagnostics to stderr; the phone shows them as output too.
        c.outBuf = Buffer.concat([c.outBuf, chunk]);
        scheduleFlush(c);
      });
      proc.on("error", (e) => {
        const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
        log(`ssh: spawn failed for ${device}/${ch}: ${e.message}`);
        channels.delete(key(device, ch));
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        o.send(device, {
          op: "ssh.denied",
          ch,
          reason: enoent ? "herdr-core (hc) was not found on this host" : `could not start herdr-core: ${e.message}`,
        });
      });
      proc.on("close", (code, signal) => {
        if (c.closed) return;
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        channels.delete(key(device, ch));
        sendOut(c, true, code ?? (signal ? 130 : 1), signal ? `terminated by ${signal}` : undefined);
      });

      o.send(device, { op: "ssh.granted", ch, scope });
      log(`ssh: ${device}/${ch} → ${cmd} (${scope})`);
      return true;
    }

    if (op === "ssh.data") {
      const c = channels.get(key(device, ch));
      if (!c) return true; // unknown or already closed: drop
      const b64 = typeof p.b64 === "string" ? p.b64 : "";
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

    return false; // an ssh.* op we don't know: tell the adapter layer it's not ours to read
  };

  return {
    handle,
    dropDevice(device: string): void {
      for (const [k, c] of [...channels]) {
        if (c.device === device) {
          c.closed = true;
          if (c.flushTimer) clearTimeout(c.flushTimer);
          c.proc?.kill("SIGTERM");
          channels.delete(k);
        }
      }
    },
    closeAll(): void {
      for (const [, c] of [...channels]) {
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        c.proc?.kill("SIGTERM");
      }
      channels.clear();
    },
  };
}
