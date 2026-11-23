// Per-user controls for the TUI publisher. No control port, service, or PID-based kill.
// The lock is run-scoped: the publisher writes {run, pid} itself (wx), stop goes
// through a marker only that run answers to — a reused PID is never signaled.
// C8: a supervisor process babysits the lineage — respawn on death, adopt a live
// publisher, heal a stale lock. Liveness of the babysitter itself is decided by
// heartbeat freshness, not PID liveness (Windows recycles PIDs aggressively).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const lockPath = (dir) => join(dir, "publisher-tui.lock");
const logPath = (dir) => join(dir, "publisher-tui.log");
const heartbeatPath = (dir) => join(dir, "publisher-tui.supervisor.json");
const supervisorStopPath = (dir) => join(dir, "publisher-tui.supervisor.stop");
const marker = (dir, run, kind) => join(dir, `publisher-tui-${run}.${kind}`);
/** Crash evidence stays bounded: rotate the log above this size at start time. */
const TUI_LOG_MAX_BYTES = 512 * 1024;

function ownerOf(dir) {
  try {
    const { run, pid } = JSON.parse(readFileSync(lockPath(dir), "utf8"));
    if (typeof run === "string" && /^[a-f0-9-]{36}$/.test(run) && Number.isSafeInteger(pid) && pid > 0) return { run, pid };
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  return null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === "ESRCH") return false; throw e; }
}

function rotateLog(dir) {
  try {
    if (statSync(logPath(dir)).size > TUI_LOG_MAX_BYTES) {
      rmSync(`${logPath(dir)}.old`, { force: true });
      renameSync(logPath(dir), `${logPath(dir)}.old`);
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
}

function readSupervisor(dir) {
  try {
    const s = JSON.parse(readFileSync(heartbeatPath(dir), "utf8"));
    if (Number.isSafeInteger(s.pid) && s.pid > 0 && Number.isSafeInteger(s.pollMs) && s.pollMs > 0 && Number.isSafeInteger(s.at)) {
      return { pid: s.pid, pollMs: s.pollMs, at: s.at };
    }
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  return null;
}

/** Fresh — not merely alive: the heartbeat is the single source of truth for
 *  "a supervisor is watching", because a recycled PID would answer kill(0). */
const supervisorFresh = (s) => Date.now() - s.at < Math.max(3 * s.pollMs, 3_000);

export function supervisorAlive(dir) {
  const s = readSupervisor(dir);
  return Boolean(s && isAlive(s.pid) && supervisorFresh(s));
}

export function publisherStatus(dir) {
  const own = ownerOf(dir);
  const log = logPath(dir);
  const supervised = supervisorAlive(dir);
  if (!own) return { state: existsSync(lockPath(dir)) ? "starting" : "stopped", log, supervised };
  const { pid, run } = own;
  const state = !isAlive(pid) ? "stale" : existsSync(marker(dir, run, "stop")) ? "stopping" :
    existsSync(marker(dir, run, "connected")) ? "connected" : "connecting";
  return { state, pid, log, supervised };
}

export function registerPublisher(dir, run, requestStop) {
  if (typeof run !== "string" || !/^[a-f0-9-]{36}$/.test(run)) throw new Error("invalid publisher run id; use start");
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir), JSON.stringify({ run, pid: process.pid }), { flag: "wx", mode: 0o600 });
  const connected = marker(dir, run, "connected");
  const stop = marker(dir, run, "stop");
  const poll = setInterval(() => {
    if (existsSync(stop)) requestStop();
  }, 250);
  const release = () => {
    clearInterval(poll);
    rmSync(connected, { force: true });
    rmSync(stop, { force: true });
    if (ownerOf(dir)?.run === run) rmSync(lockPath(dir), { force: true });
  };
  process.once("exit", release);
  return {
    release,
    setConnected(ok) {
      if (ok) writeFileSync(connected, "", { mode: 0o600 });
      else rmSync(connected, { force: true });
    },
  };
}

export async function startPublisher(dir, args, env = process.env) {
  mkdirSync(dir, { recursive: true });
  rotateLog(dir);
  const initial = publisherStatus(dir);
  if (initial.state === "stopping") return initial; // a stop is in flight; be honest about it
  // Ensure the babysitter exists, then let it do the spawning: it adopts a live
  // publisher instead of double-spawning, and heals a stale lock (the old flow
  // just reported "stale" until someone ran stop by hand).
  if (!supervisorAlive(dir)) {
    const fd = openSync(logPath(dir), "a", 0o600);
    let sup;
    try {
      sup = spawn(process.execPath, [import.meta.filename, "--supervise", dir, "--", ...args], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        env: { ...env, HERDGATE_TUI_SUPERVISOR: "1" },
      });
      await new Promise((resolve, reject) => { sup.once("spawn", resolve); sup.once("error", reject); });
    } finally {
      closeSync(fd); // the supervisor inherits the fd; the launcher does not need it
    }
    sup.unref();
    // Let the babysitter claim the watch before answering, so the returned
    // status (and its supervised flag) describes a world that already exists.
    const claimDeadline = Date.now() + 3_000;
    while (Date.now() < claimDeadline && !existsSync(heartbeatPath(dir))) await delay(50);
  }
  // Do not confuse a spawned Node process with successful authentication: wait
  // for the connected marker (or a supervisor-booted lineage) before answering.
  const timeoutMs = Math.max(1_000, Number.parseInt(env.HERDGATE_TUI_START_TIMEOUT_MS ?? "10000", 10) || 10_000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = publisherStatus(dir);
    if (status.state === "connected") return status;
    if (Date.now() > deadline) {
      if (status.state === "connecting" || status.state === "starting") return status;
      throw new Error(`publisher did not start; see ${logPath(dir)}`);
    }
    await delay(125);
  }
}

/** --- supervise(): keep exactly one publisher lineage alive, or die loudly.
 *  A deliberate poller — no sockets, no handles into anyone else's state: it
 *  watches the run-scoped lock, so it adopts a publisher an older version (or
 *  a foreground run) started as easily as one it spawned itself. Env knobs
 *  share names with the serve-path supervisor (C7) so operators learn one set. --- */
export async function supervise(dir, args, env = process.env) {
  const int = (name, dflt, min) => Math.max(min, Number.parseInt(env[name] ?? String(dflt), 10) || dflt);
  const POLL_MS = int("HERDGATE_WATCHDOG_POLL_MS", 1_000, 100);
  const MAX_DEATHS = int("HERDGATE_WATCHDOG_MAX", 5, 1);
  const WINDOW_MS = int("HERDGATE_WATCHDOG_WINDOW_MS", 600_000, 5_000);
  const BACKOFF_BASE_MS = int("HERDGATE_WATCHDOG_BACKOFF_BASE_MS", 1_000, 50);
  const BOOT_TIMEOUT_MS = int("HERDGATE_WATCHDOG_BOOT_TIMEOUT_MS", 15_000, 1_000);
  const BACKOFF_MAX_MS = 60_000;
  const STABLE_MS = 60_000; // a publisher that lived this long resets the backoff ladder
  const slog = (line) => console.error(`herdgate supervisor: ${new Date().toISOString()} ${line}`);
  const hb = heartbeatPath(dir);
  const stop = supervisorStopPath(dir);

  mkdirSync(dir, { recursive: true });
  // Single-writer heartbeat: claim with wx, steal only from a dead or stale
  // owner. Two supervisors racing end up with exactly one watching; the spare
  // exits on its next beat() when it sees a fresh foreign heartbeat.
  const beat = () => {
    const cur = readSupervisor(dir);
    if (cur && cur.pid !== process.pid && isAlive(cur.pid) && supervisorFresh(cur)) return false;
    writeFileSync(hb, JSON.stringify({ pid: process.pid, pollMs: POLL_MS, at: Date.now() }), { mode: 0o600 });
    return true;
  };
  for (let attempts = 0; ; attempts++) {
    try {
      writeFileSync(hb, JSON.stringify({ pid: process.pid, pollMs: POLL_MS, at: Date.now() }), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const cur = readSupervisor(dir);
      if (cur && cur.pid !== process.pid && isAlive(cur.pid) && supervisorFresh(cur)) {
        slog("another supervisor owns the watch; exiting");
        return;
      }
      if (attempts > 4) throw new Error("cannot claim the supervisor heartbeat");
      rmSync(hb, { force: true }); // stale or dead owner — steal it
    }
  }
  const cleanExit = () => { rmSync(hb, { force: true }); rmSync(stop, { force: true }); };
  process.once("exit", cleanExit);

  const logFd = openSync(logPath(dir), "a", 0o600); // every child generation inherits this fd
  let lastRun = null; // the run id under our watch
  let armed = false; // a lineage existed at some point under our watch
  let expecting = null; // { run, pid, at } — spawned child not yet registered
  let childGone = false; // the spawned child process exited (also the zombie reaper flag)
  const deaths = []; // epoch ms of deaths inside the budget window
  let consecutive = 0;
  let bornAt = 0;

  /** Run-scoped reap, same protocol as stopPublisher: the wx reap marker
   *  serializes concurrent reapers, and the lock is only removed while it
   *  still names this run — a reused PID can never be orphaned by mistake. */
  const reapRun = (run) => {
    const reap = marker(dir, run, "reap");
    try { writeFileSync(reap, "", { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e.code === "EEXIST") return; throw e; }
    try {
      rmSync(marker(dir, run, "connected"), { force: true });
      rmSync(marker(dir, run, "stop"), { force: true });
      if (ownerOf(dir)?.run === run) rmSync(lockPath(dir), { force: true });
    } finally { rmSync(reap, { force: true }); }
  };

  const registerDeath = () => {
    const now = Date.now();
    if (bornAt && now - bornAt >= STABLE_MS) consecutive = 0; // it had a good life
    while (deaths.length && now - deaths[0] > WINDOW_MS) deaths.shift();
    if (deaths.length >= MAX_DEATHS) return false;
    deaths.push(now);
    consecutive += 1;
    return true;
  };

  const spawnChild = () => {
    const run = randomUUID();
    const cenv = { ...env, HERDGATE_TUI_RUN_ID: run };
    delete cenv.HERDGATE_TUI_SUPERVISOR;
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: cenv });
    child.unref();
    childGone = false;
    // The exit listener is both the zombie reaper (a detached child no one
    // reaps answers kill(pid,0) forever — C7 lesson) and the boot-death signal.
    child.once("exit", (code, signal) => { childGone = true; slog(`publisher pid ${child.pid} exited (${signal ?? `code ${code}`})`); });
    child.once("error", (e) => { childGone = true; slog(`spawn failed: ${e instanceof Error ? e.message : String(e)}`); });
    if (!child.pid) {
      slog("spawn returned no pid; giving up");
      process.exitCode = 1;
      cleanExit();
      return false;
    }
    expecting = { run, pid: child.pid, at: Date.now() };
    lastRun = run;
    armed = true;
    bornAt = 0;
    slog(`publisher starting (pid ${child.pid}, run ${run.slice(0, 8)})`);
    return true;
  };

  /** Account a death and back off; false means stop (give-up or stop raced in). */
  const respawn = async (why) => {
    slog(why);
    if (!registerDeath()) {
      slog(`giving up — ${deaths.length} crashes within ${Math.round(WINDOW_MS / 1000)}s; run 'start' to try again`);
      process.exitCode = 1;
      cleanExit();
      return false;
    }
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (consecutive - 1), BACKOFF_MAX_MS);
    slog(`respawn ${deaths.length}/${MAX_DEATHS} in ${backoff}ms`);
    await delay(backoff);
    if (existsSync(stop)) { // a stop raced in during the backoff — do not orphan a fresh child
      slog("stop requested during backoff");
      cleanExit();
      return false;
    }
    return true;
  };

  slog(`watching (poll ${POLL_MS}ms, budget ${MAX_DEATHS}/${Math.round(WINDOW_MS / 1000)}s)`);
  const first = ownerOf(dir);
  if (first) {
    lastRun = first.run;
    armed = true;
    bornAt = isAlive(first.pid) ? Date.now() : 0;
    slog(`adopting publisher (pid ${first.pid}, run ${first.run.slice(0, 8)})`);
  } else if (!spawnChild()) return;

  for (;;) {
    await delay(POLL_MS);
    if (!beat()) { slog("another supervisor owns the watch; exiting"); return; }
    if (existsSync(stop)) { slog("stop requested"); cleanExit(); return; }
    const own = ownerOf(dir);
    if (!own) {
      if (expecting) {
        if (childGone) {
          if (!(await respawn("publisher died before registering"))) return;
          if (!spawnChild()) return;
        } else if (Date.now() - expecting.at > BOOT_TIMEOUT_MS) {
          // This pid is ours from spawn — no reuse risk signaling it directly.
          slog(`publisher pid ${expecting.pid} never registered after ${Math.round(BOOT_TIMEOUT_MS / 1000)}s; terminating`);
          try { process.kill(expecting.pid, "SIGTERM"); } catch { /* already gone */ }
        }
      } else if (armed) {
        // The lock vanished with no stop intent: uncaught exceptions still run
        // the exit handler, so a "clean" exit under our watch is a death.
        if (!(await respawn("publisher lock vanished; counting the lineage as dead"))) return;
        if (!spawnChild()) return;
      }
      continue;
    }
    if (own.run !== lastRun) {
      // A foreign lineage appeared (an older version's publisher, a foreground
      // run, or a racing supervisor's child that won the wx lock) — babysit it.
      lastRun = own.run;
      armed = true;
      expecting = null;
      bornAt = isAlive(own.pid) ? Date.now() : 0;
      slog(`adopting publisher (pid ${own.pid}, run ${own.run.slice(0, 8)})`);
      continue;
    }
    if (expecting && !childGone) {
      expecting = null; // registration landed
      bornAt = Date.now();
      slog(`publisher started (pid ${own.pid})`);
      continue;
    }
    if (!isAlive(own.pid)) {
      if (existsSync(marker(dir, own.run, "stop"))) {
        // It died while honoring a stop request — help the cleanup along, then go.
        reapRun(own.run);
        slog("publisher stopped");
        cleanExit();
        return;
      }
      reapRun(own.run); // stale lock left by SIGKILL/OOM — a fresh child cannot register over it
      if (!(await respawn(`publisher pid ${own.pid} died; lock left behind`))) return;
      if (!spawnChild()) return;
      continue;
    }
    if (bornAt && Date.now() - bornAt >= STABLE_MS) consecutive = 0;
  }
}

/** Ask the babysitter to stand down before stopping the publisher itself, so a
 *  stop cannot race a respawn. A hung supervisor (still fresh after 10s) is
 *  terminated — freshness proves the pid in the heartbeat is still its own. */
async function standDownSupervisor(dir) {
  const hb = heartbeatPath(dir);
  const stop = supervisorStopPath(dir);
  const s = readSupervisor(dir);
  if (s && isAlive(s.pid) && supervisorFresh(s)) {
    writeFileSync(stop, "", { mode: 0o600 });
    for (let i = 0; i < 80 && existsSync(hb); i++) await delay(125); // ≤10s to stand down
    const s2 = readSupervisor(dir);
    if (existsSync(hb) && s2 && isAlive(s2.pid) && supervisorFresh(s2)) {
      try { process.kill(s2.pid, "SIGTERM"); } catch { /* gone */ }
      for (let i = 0; i < 16 && existsSync(hb); i++) await delay(125);
    }
  }
  rmSync(hb, { force: true });
  rmSync(stop, { force: true });
}

export async function stopPublisher(dir) {
  await standDownSupervisor(dir);
  const own = ownerOf(dir);
  if (!own) return publisherStatus(dir);
  const stop = marker(dir, own.run, "stop");
  if (isAlive(own.pid)) {
    // The run-specific request cannot signal a new publisher or a reused PID.
    writeFileSync(stop, "", { mode: 0o600 });
    for (let i = 0; i < 32 && ownerOf(dir)?.run === own.run && isAlive(own.pid); i++) await delay(125);
  }
  if (ownerOf(dir)?.run === own.run && !isAlive(own.pid)) {
    const reap = marker(dir, own.run, "reap");
    try { writeFileSync(reap, "", { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e.code === "EEXIST") return publisherStatus(dir); throw e; }
    try {
      rmSync(marker(dir, own.run, "connected"), { force: true });
      rmSync(stop, { force: true });
      if (ownerOf(dir)?.run === own.run) rmSync(lockPath(dir), { force: true });
    } finally {
      rmSync(reap, { force: true });
    }
  } else if (ownerOf(dir)?.run !== own.run) {
    rmSync(stop, { force: true });
  }
  return publisherStatus(dir);
}

// Supervisor entry point: node publisher-tui-lifecycle.mjs --supervise <dir> -- <args…>
const isMain = (() => {
  try {
    return typeof process.argv[1] === "string" &&
      realpathSync(process.argv[1]).toLowerCase() === import.meta.filename.toLowerCase();
  } catch { return false; }
})();
if (isMain && process.argv[2] === "--supervise") {
  const dir = process.argv[3];
  const rest = process.argv.slice(4);
  if (!dir || rest[0] !== "--") {
    console.error("usage: publisher-tui-lifecycle.mjs --supervise <stateDir> -- <child args…>");
    process.exitCode = 1;
  } else {
    supervise(dir, rest.slice(1)).catch((e) => {
      console.error(`herdgate supervisor: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
  }
}
