// Native Herdr terminal controller. Never interprets a shell command. --takeover makes the
// latest viewer own the stream: Herdr allows one controller per terminal, and this way a
// reconnect or a second viewer (phone, desktop) replaces the old one instead of failing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const maxLine = 1024 * 1024;

/** The persistent shell must be a real POSIX sh — the framing (`{ cmd ; }
 *  </dev/null; printf …`) is sh syntax. On Windows that means Git-for-Windows'
 *  sh.exe; auto-detect the common install roots, HERDR_SHELL wins. Return null
 *  when nothing qualifies so the manager can fail loudly instead of exiting
 *  code 1 on every `herdr pane …` (the live laptop failure: /bin/sh does not
 *  exist there, so every mobile command died as "exited 1"). */
export function defaultShell(platform = process.platform, env = process.env, io = {}) {
  if (env.HERDR_SHELL) return env.HERDR_SHELL;
  if (platform !== "win32") return "/bin/sh";
  const exists = io.exists ?? ((p) => existsSync(p));
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : null].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, "Git", "bin", "sh.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

export async function openTerminal(bin, id, cols, rows) {
  const child = spawn(bin, ["terminal", "session", "control", id, "--takeover", "--cols", String(cols), "--rows", String(rows)], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false,
  });
  child.on("error", () => child.stdout.destroy());
  child.stdin.on("error", () => child.stdout.destroy());
  const frames = readFrames(child.stdout);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    child.stdin.end(); // EOF asks Herdr to release the controller.
    const kill = setTimeout(() => child.kill(), 750);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  }
  const deadline = setTimeout(() => child.stdout.destroy(new Error("Herdr attach timed out")), 4000);
  try {
    const first = await frames.next();
    if (first.done) throw new Error("Herdr declined terminal attach");
    return {
      first: first.value, frames, close,
      send: (message) => new Promise((resolve, reject) => {
        if (closed || !child.stdin.writable) return reject(new Error("Herdr terminal closed"));
        child.stdin.write(JSON.stringify(message) + "\n", (err) => err ? reject(err) : resolve());
      }),
    };
  } catch (err) {
    close();
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

async function* readFrames(stdout) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stdout) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end > maxLine || (end < 0 && pending.length > maxLine)) throw new Error("Herdr terminal frame too large");
      if (end < 0) break;
      const msg = JSON.parse(pending.subarray(0, end).toString("utf8"));
      pending = pending.subarray(end + 1);
      if (msg.type === "terminal.closed") return;
      if (msg.type !== "terminal.frame" || msg.encoding !== "ansi" || typeof msg.bytes !== "string") continue;
      if (!validDimension(msg.width) || !validDimension(msg.height)) throw new Error("Invalid Herdr terminal geometry");
      yield { cols: msg.width, rows: msg.height, bytes: Buffer.from(msg.bytes, "base64") };
    }
  }
}

export function validDimension(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

// POSIX cksum (CRC-32 0x04C11DB7 + byte length, the same `cksum` coreutils prints):
// a content stamp that needs no stat and survives any transport. `readChangedCommand`
// stamps file reads with exactly this, so the phone can ask "same as before?" in one line.
const cksumTable = new Uint32Array(256).map((_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = ((c << 1) ^ ((c & 0x80000000) !== 0 ? 0x04c11db7 : 0)) >>> 0;
  return c >>> 0;
});
export function cksum(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ cksumTable[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  let len = bytes.length;
  while (len > 0) { // the length rides the same CRC, low byte first, no leading zeros
    crc = ((crc << 8) ^ cksumTable[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len = Math.floor(len / 256);
  }
  return `${(crc ^ 0xffffffff) >>> 0} ${bytes.length}`;
}

const newMarker = () => "HC_" + randomBytes(16).toString("hex");

/** One persistent `/bin/sh` with marker framing: every request is `<command> </dev/null`
 *  followed by a printf that emits `\n<unique marker> <exit code>\n`. stdin is detached
 *  per command so a hungry command cannot swallow the next request; a reply is decoded
 *  only once its whole delimiter is present, so chunked output never corrupts multibyte
 *  text. The shell is probed with `true` before it counts as alive; any channel failure
 *  (write error, early exit, timeout, over-limit) kills the whole generation — the
 *  written request is never retried, later requests fall back to one exec per command,
 *  and only an explicit reinit() may open the next generation. */
export function openShellManager({
  exec,
  shell = defaultShell(),
  probeCommand = "true",
  timeoutMs = 4_000,
  limitBytes = 8 * 1024 * 1024,
} = {}) {
  const noShell = shell == null
    ? Object.assign(new Error("no POSIX shell found: install Git for Windows or set HERDR_SHELL"), { kind: "no_shell" })
    : null;
  const fallbackRun = exec || ((command) => new Promise((resolve) => {
    if (noShell) throw noShell;
    execFile(shell, ["-c", command], { timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true }, (err, stdout) => {
      resolve({ stdout: Buffer.from(stdout ?? ""), code: err && typeof err.code === "number" ? err.code : err ? 1 : 0 });
    });
  }));
  let generation = 1;
  let state = "idle"; // idle | opening | live | dead
  let fails = 0;
  let child = null;
  let buffer = Buffer.alloc(0);
  let waiting = []; // framed requests in submission order; head is decoded first
  const stats = { shells: 0, shellRequests: 0, fallbackRequests: 0 };

  const failChannel = (reason) => {
    if (state === "dead") return;
    const written = [];
    const unwritten = [];
    for (const req of waiting) (req.written ? written : unwritten).push(req);
    waiting = [];
    state = "dead";
    fails++;
    buffer = Buffer.alloc(0);
    if (child) { try { child.stdin.end(); } catch { /* already gone */ } child.kill(); child = null; }
    for (const req of written) {
      clearTimeout(req.timer);
      req.reject(Object.assign(new Error(`persistent shell failed: ${reason}`), { kind: "shell_failed", noRetry: true }));
    }
    // These were never written, so running them through the fallback is not a retry.
    for (const req of unwritten) fallbackRun(req.command).then(req.resolve, req.reject);
  };

  const open = () => {
    if (noShell) { state = "dead"; return; }
    stats.shells++;
    state = "opening";
    const kid = spawn(shell, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child = kid;
    kid.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > limitBytes) return failChannel("frame over limit");
      for (;;) {
        const head = waiting[0];
        if (!head || !head.written) break;
        const start = buffer.indexOf(head.delimiter);
        if (start < 0) break;
        const end = buffer.indexOf(10, start + head.delimiter.length);
        if (end < 0) break;
        const code = Number.parseInt(buffer.subarray(start + head.delimiter.length, end).toString("ascii"), 10);
        if (!Number.isInteger(code) || code < 0) return failChannel("corrupt frame");
        const stdout = buffer.subarray(0, start);
        buffer = buffer.subarray(end + 1);
        waiting.shift();
        clearTimeout(head.timer);
        if (head.probe) {
          if (code !== 0) return failChannel("probe failed");
          state = "live";
        }
        head.resolve({ stdout, code });
        pump();
      }
    });
    kid.stdin.on("error", () => { if (child === kid) failChannel("stdin write failed"); });
    kid.on("error", () => { if (child === kid) failChannel("shell did not start"); });
    kid.on("exit", () => { if (child === kid && state !== "dead") failChannel("shell exited"); });
    const probe = { probe: true, command: probeCommand, marker: newMarker(), written: false };
    probe.delimiter = Buffer.from(`\n${probe.marker} `);
    probe.promise = new Promise((resolve, reject) => { probe.resolve = resolve; probe.reject = reject; });
    waiting.push(probe);
    probe.promise.catch(() => {}); // the probe's own failure is reported by failChannel
  };

  function pump() {
    if (state === "dead" || !child) return;
    const head = waiting[0];
    if (!head || head.written) return;
    if (!head.probe && state !== "live") return; // nothing runs before the probe answers
    head.written = true;
    stats.shellRequests++;
    head.timer = setTimeout(() => failChannel("request timed out"), timeoutMs);
    head.timer.unref?.();
    // The redirect wraps the whole command (braces), so pipelines keep their stdin while
    // no command can ever read the marker stream meant for the next request.
    const frame = `{ ${head.command} ; } </dev/null\nprintf '\\n%s %s\\n' '${head.marker}' "$?"\n`;
    child.stdin.write(frame, (err) => { if (err) failChannel("stdin write failed"); });
  }

  return {
    execute(command) {
      if (state === "idle") open();
      // Covers both a previously failed generation and open()'s no-shell guard:
      // never queue a request no shell will ever answer (that would hang).
      if (state === "dead") { stats.fallbackRequests++; return fallbackRun(command); }
      const req = { command, marker: newMarker(), written: false };
      req.delimiter = Buffer.from(`\n${req.marker} `);
      const promise = new Promise((resolve, reject) => { req.resolve = resolve; req.reject = reject; });
      req.promise = promise;
      waiting.push(req);
      pump();
      return promise;
    },
    // The only way a failed generation comes back: an explicit new one.
    reinit() {
      failChannel("reinit");
      generation++;
      fails = 0;
      state = "idle";
    },
    // End of the line for this manager: close the shell without failing anyone.
    close() {
      if (!child) { state = "dead"; return; }
      const kid = child;
      child = null;
      state = "dead";
      try { kid.stdin.end(); } catch { /* already gone */ }
      kid.kill();
    },
    get generation() { return generation; },
    get state() { return state; },
    get fails() { return fails; },
    stats,
  };
}

const resyncError = (reason = "pane input needs resync; re-read, never replay") =>
  Object.assign(new Error(reason), { kind: "needs_resync" });

/** Keystrokes from the phone ride a bounded FIFO (PaneLiveInputQueue semantics): adjacent
 *  keystroke batches for the same pane coalesce Nagle-style, every input is acknowledged
 *  in submission order before the next batch is written, and any ambiguous failure —
 *  delivery unknown, or the queue overflows — flips the whole queue to needsResync and
 *  drops it: the client must resync from a fresh read, and old input is never replayed. */
export class PaneLiveInputQueue {
  constructor(apply, { limit = 256 } = {}) {
    if (typeof apply !== "function") throw new Error("PaneLiveInputQueue needs an apply function");
    this.apply = apply;
    this.limit = limit;
    this.state = "live"; // live | needsResync
    this.enqueuedCount = 0;
    this.acknowledgedCount = 0;
    this.droppedCount = 0;
    this.pending = [];
    this.pumping = false;
  }

  enqueue(paneId, kind, payload = {}) {
    if (this.state !== "live") return Promise.reject(resyncError());
    if (this.pending.length >= this.limit) {
      this.resync("input queue overflow");
      return Promise.reject(resyncError("input queue overflow"));
    }
    const tail = this.pending[this.pending.length - 1];
    if (kind === "keys" && tail && !tail.sent && tail.paneId === paneId && tail.kind === "keys" && Array.isArray(payload.keys)) {
      tail.keys = tail.keys.concat(payload.keys); // one send-keys for a burst of keystrokes
      return this.claim(tail);
    }
    const event = { paneId, kind, text: payload.text, keys: payload.keys ? [...payload.keys] : undefined, sent: false, waiters: [] };
    this.pending.push(event);
    const promise = this.claim(event);
    queueMicrotask(() => this.pump()); // a beat to gather a burst before the write starts
    return promise;
  }

  /** Drop not-yet-sent input for a pane (the viewer switched away from it). */
  abandon(paneId) {
    if (this.state !== "live") return;
    this.pending = this.pending.filter((event) => {
      if (event.paneId !== paneId || event.sent) return true;
      this.droppedCount += event.waiters.length;
      for (const waiter of event.waiters) waiter.reject(Object.assign(new Error("pane input abandoned"), { kind: "abandoned" }));
      return false;
    });
  }

  resync(reason = "pane input needs resync") {
    if (this.state !== "live") return;
    this.state = "needsResync";
    const events = this.pending;
    this.pending = [];
    for (const event of events) {
      this.droppedCount += event.waiters.length;
      for (const waiter of event.waiters) waiter.reject(resyncError(reason));
    }
  }

  claim(event) {
    const seq = ++this.enqueuedCount;
    return new Promise((resolve, reject) => event.waiters.push({ seq, resolve, reject }));
  }

  async pump() {
    if (this.pumping || this.state !== "live") return;
    this.pumping = true;
    try {
      while (this.pending.length && this.state === "live") {
        const event = this.pending[0];
        event.sent = true;
        let failure = null;
        try {
          await this.apply({ paneId: event.paneId, kind: event.kind, text: event.text, keys: event.keys });
        } catch (err) {
          // The host answered no: a refusal is a refusal — this input is done, the rest drain on.
          // Anything ambiguous (delivery unknown) leaves the channel untrustworthy: resync.
          if (err && err.definitive === true) failure = err;
          else return this.resync(err?.message ?? "pane input delivery failed");
        }
        this.pending.shift();
        this.acknowledge(event, failure);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Acks come back strictly in submission order, one count per accepted input. */
  acknowledge(event, failure) {
    for (const waiter of event.waiters) {
      this.acknowledgedCount++;
      if (failure) waiter.reject(failure);
      else waiter.resolve(this.acknowledgedCount);
    }
  }
}
