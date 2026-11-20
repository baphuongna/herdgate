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
import { MARKER, resolveHerdr, translateHerdr } from "./herdr-ssh.mjs";
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


/** Extract `hc <verb>` from herdr-core's known machine-add probes (null = not one). */
export function translateBootstrap(cmd) {
  const posix = cmd.match(/exec "\$p"\s+([^'"\n]+?)['"]?\s*$/);
  if (posix) {
    const args = posix[1].trim();
    // Strict whitelist: flags, words, equals — never shell metacharacters.
    if (/^[-a-z0-9][-a-z0-9 =]*$/i.test(args)) return `hc ${args}`;
  }
  const win = cmd.match(/herdr-core\.exe\)?\s+\(?([a-z][a-z0-9-]*)\)/);
  if (win) return `hc ${win[1]}`;
  return null;
}

// The Mobile opt-in only maps fixed probes to argv, never to a shell.
const winCore = String.raw`.\AppData\Local\Programs\herdr-core\herdr-core.exe`;
const coreWinConnect = `cmd /d /c "if exist ${winCore} (${winCore} connect) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"`;
const corePosixConnect = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; exec "$p" connect'`;
const mobileCoreArgs = new Map([
  ["connect", ["connect"]],
  ["connect --json", ["connect", "--json"]],
  ["--version", ["--version"]],
  ["-V", ["-V"]],
  ["server status", ["server", "status"]],
  ["server status --json", ["server", "status", "--json"]],
]);
function translateMobileCore(cmd) {
  if (cmd === coreWinConnect || cmd === corePosixConnect) return ["connect"];
  const match = cmd.match(/^(?:hc|herdr-core)(?:\.exe)?[ \t]+(.+)$/);
  return match ? mobileCoreArgs.get(match[1]) : null;
}

export function createSshBridge({ send, scopeOf, log = () => {}, resolve = resolveHc, resolveHerdrBin = resolveHerdr, session = process.env.HERDGATE_HERDR_SESSION || process.env.HERDR_SESSION || "default", platform = process.platform, tuiOnly = false, mobileHcBin = null, mobileTuiAdapter = null, trustedReadCore = null, spawnImpl = spawn }) {
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
      if (c.closed || !c.outBuf.length) return;
      sendOut(c, false);
      // On a busy interactive channel keep batching subsequent chunks. After
      // an idle period, the next response can leave without the batch delay.
      if (c.lowLatency) scheduleFlush(c);
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
    if (c.closed || !c.proc?.stdin?.writable) return;
    if (c.proc.stdin.writableLength + buf.length > 1024 * 1024) return kill(c, "input queue limit");
    if (c.scope === "act" || c.trustedReadCore) return void c.proc.stdin.write(buf);
    c.inBuf = Buffer.concat([c.inBuf, buf]);
    if (c.inBuf.length > 1024 * 1024) return kill(c, "input line too long");
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
    if (c.deadline) clearTimeout(c.deadline);
    c.proc?.kill("SIGKILL");
    channels.delete(key(c.device, c.ch));
    sendOut(c, true, 130, reason);
  };

  const start = (device, ch, scope, bin, args, tui = false, closeStdin = false, mobile = false) => {
    const env = tui || mobile ? { ...process.env, HERDR_SESSION: session } : undefined;
    if (mobile) {
      delete env.HERDGATE_ROOM_TOKEN;
      delete env.HERDGATE_ACCOUNT_TOKEN;
      delete env.HERDGATE_BRIDGE_TOKEN;
    }
    let proc;
    try {
      proc = spawnImpl(bin, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, ...(env ? { env } : {}) });
    } catch (e) {
      send(device, { op: "ssh.denied", ch, reason: `could not start bridged process: ${e.message}` });
      return;
    }
    // Only the dedicated local read-only adapter may parse framed read RPC itself.
    const trusted = !tui && scope === "read" && (trustedReadCore === bin || mobile);
    const lowLatency = mobile && scope === "act" && args.includes("connect");
    const c = { device, ch, scope, proc, trustedReadCore: trusted, lowLatency, inBuf: Buffer.alloc(0), outBuf: Buffer.alloc(0), flushTimer: null, malformed: 0, closed: false };
    channels.set(key(device, ch), c);
    const onData = (chunk) => {
      c.outBuf = c.outBuf.length ? Buffer.concat([c.outBuf, chunk]) : chunk;
      if (c.lowLatency && !c.flushTimer) {
        sendOut(c, false);
        scheduleFlush(c);
      } else if (c.outBuf.length >= FLUSH_BYTES) sendOut(c, false);
      else scheduleFlush(c);
    };
    proc.stdout?.on("data", onData);
    if (tui || trusted) {
      if (tui) send(device, { op: "ssh.data", ch, b64: Buffer.from(MARKER).toString("base64") });
      proc.stderr?.on("data", (buf) => {
        if (!c.closed) send(device, { op: "ssh.data", ch, stderr: true, b64: buf.toString("base64") });
      });
    } else {
      proc.stderr?.on("data", onData);
    }
    proc.stdin?.on("error", () => { /* child exited before consuming all input */ });
    if (closeStdin) proc.stdin?.end();
    if (closeStdin && !args.includes("remote-client-bridge")) {
      c.deadline = setTimeout(() => kill(c, "Herdr probe timed out"), 8000);
      c.deadline.unref();
    }
    proc.on("error", (e) => {
      if (c.closed) return;
      const enoent = e.code === "ENOENT";
      log(`ssh: spawn failed for ${device}/${ch}: ${e.message}`);
      channels.delete(key(device, ch));
      c.closed = true;
      if (c.flushTimer) clearTimeout(c.flushTimer);
      if (c.deadline) clearTimeout(c.deadline);
      send(device, { op: "ssh.denied", ch, reason: enoent ? `${tui ? "Herdr" : "herdr-core (hc)"} was not found on this host` : `could not start bridged process: ${e.message}` });
    });
    proc.on("close", (code, signal) => {
      if (c.closed) return;
      c.closed = true;
      if (c.flushTimer) clearTimeout(c.flushTimer);
      if (c.deadline) clearTimeout(c.deadline);
      channels.delete(key(device, ch));
      sendOut(c, true, code ?? (signal ? 130 : 1), signal ? `terminated by ${signal}` : undefined);
    });
    log(`ssh: ${device}/${ch} → ${tui ? "herdr " : "hc "}${args.join(" ")} (${scope})`);
  };

  const handleTui = (device, ch, scope, bin, result) => {
    if (result.reply !== undefined) {
      if (result.reply) send(device, { op: "ssh.data", ch, b64: Buffer.from(result.reply).toString("base64") });
      send(device, { op: "ssh.closed", ch, code: result.code ?? 0 });
    } else {
      start(device, ch, scope, bin, result.args, true, result.closeStdin);
    }
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
        if (!ch || channels.has(key(device, ch))) return true;
        if (scope === "act") {
          const bin = resolveHerdrBin();
          const result = translateHerdr(cmd, { bin, session, os: platform });
          const script = bin && cmd === "/bin/sh -s";
          if (result || script) {
            send(device, { op: "ssh.granted", ch, scope });
            if (result) {
              handleTui(device, ch, scope, bin, result);
            } else {
              const c = { device, ch, scope, bin, script: Buffer.alloc(0), outBuf: Buffer.alloc(0), closed: false };
              channels.set(key(device, ch), c);
              c.deadline = setTimeout(() => kill(c, "Herdr probe stdin timed out"), 8000);
              c.deadline.unref();
            }
            return true;
          }
        }
        // herdr-core's `machine add` probes with shell wrappers that locate a binary
        // named `herdr-core` and `exec` it. We never run shell lines: translate the
        // KNOWN templates to `hc <verb>`; anything else shell-shaped is refused below.
        const bootstrap = cmd.includes("herdr-core") ? translateBootstrap(cmd) : null;
        const parts = (bootstrap ?? cmd).split(/\s+/).filter(Boolean);
        if (parts.length > 0 && parts[0] === "exit" && (parts.length === 1 || parts[1] === "0")) {
          // SSH clients end probe sessions with `exit` — acknowledge and close clean.
          send(device, { op: "ssh.granted", ch, scope });
          send(device, { op: "ssh.closed", ch, code: 0 });
          return true;
        }
        if (tuiOnly && mobileTuiAdapter?.device === device) {
          const args = translateMobileCore(cmd);
          if (args && scope === (mobileTuiAdapter.scope ?? "read")) {
            send(device, { op: "ssh.granted", ch, scope });
            const mode = scope === "act" ? ["--interactive"] : [];
            start(device, ch, scope, process.execPath, [mobileTuiAdapter.script, ...mode, ...args], false, false, true);
            return true;
          }
        }
        if (tuiOnly && platform === "win32" && mobileHcBin && scope === "act") {
          const args = translateMobileCore(cmd);
          if (args) {
            send(device, { op: "ssh.granted", ch, scope });
            start(device, ch, scope, mobileHcBin, args);
            return true;
          }
        }
        if (tuiOnly || parts.length === 0 || parts[0] !== "hc") {
          send(device, { op: "ssh.denied", ch, reason: scope === "read" ? "this command is not available to read devices" : "not a supported Herdr or herdr-core command" });
          return true;
        }
        send(device, { op: "ssh.granted", ch, scope });
        start(device, ch, scope, resolve() ?? "hc", parts.slice(1));
        return true;
      }

      if (op === "ssh.data") {
        const c = channels.get(key(device, ch));
        if (!c) return true;
        if (scopeOf(device) !== c.scope) {
          kill(c, "device permission changed");
          return true;
        }
        const b64 = typeof payload.b64 === "string" ? payload.b64 : "";
        if (b64.length > 400_000) return true;
        const buf = Buffer.from(b64, "base64");
        if (c.script) {
          if (c.script.length + buf.length > 8192) kill(c, "Herdr probe stdin limit");
          else c.script = Buffer.concat([c.script, buf]);
        } else {
          feed(c, buf);
        }
        return true;
      }

      if (op === "ssh.eof") {
        const c = channels.get(key(device, ch));
        if (!c) return true;
        if (c.script) {
          clearTimeout(c.deadline);
          channels.delete(key(device, ch));
          const result = scopeOf(device) === "act" && translateHerdr(c.script.toString("utf8"), { bin: c.bin, session, stdin: true, os: platform });
          if (result) {
            handleTui(device, ch, c.scope, c.bin, result);
          } else {
            log(`ssh: ${device}/${ch} rejected Herdr stdin probe (${c.script.length} bytes)`);
            const b64 = Buffer.from("herdgate: unsupported Herdr probe or device permission changed; no shell executed\n").toString("base64");
            send(device, { op: "ssh.data", ch, b64, stderr: true });
            send(device, { op: "ssh.closed", ch, code: 111 });
          }
        } else if (c.proc?.stdin?.writable) {
          c.proc.stdin.end();
        }
        return true;
      }

      if (op === "ssh.close") {
        const c = channels.get(key(device, ch));
        if (!c) return true;
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        if (c.deadline) clearTimeout(c.deadline);
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
          if (c.deadline) clearTimeout(c.deadline);
          c.proc?.kill("SIGTERM");
          channels.delete(k);
        }
      }
    },
    closeAll() {
      for (const [, c] of [...channels]) {
        c.closed = true;
        if (c.flushTimer) clearTimeout(c.flushTimer);
        if (c.deadline) clearTimeout(c.deadline);
        c.proc?.kill("SIGTERM");
      }
      channels.clear();
    },
  };
}
