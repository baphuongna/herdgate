// Per-user controls for the TUI publisher. No control port, service, or PID-based kill.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const lockPath = (dir) => join(dir, "publisher-tui.lock");
const logPath = (dir) => join(dir, "publisher-tui.log");
const marker = (dir, run, kind) => join(dir, `publisher-tui-${run}.${kind}`);

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

export function publisherStatus(dir) {
  const own = ownerOf(dir);
  const log = logPath(dir);
  if (!own) return { state: existsSync(lockPath(dir)) ? "starting" : "stopped", log };
  const { pid, run } = own;
  const state = !isAlive(pid) ? "stale" : existsSync(marker(dir, run, "stop")) ? "stopping" :
    existsSync(marker(dir, run, "connected")) ? "connected" : "connecting";
  return { state, pid, log };
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
  const initial = publisherStatus(dir);
  if (initial.state !== "stopped") return initial;
  const fd = openSync(logPath(dir), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, HERDGATE_TUI_RUN_ID: randomUUID() },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } finally {
    closeSync(fd);
  }
  child.unref();
  // Do not confuse a spawned Node process with successful authentication.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = publisherStatus(dir);
    if (status.state === "connected" || (status.pid && status.pid !== child.pid)) return status;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(125);
  }
  const status = publisherStatus(dir);
  if (status.state === "connecting") return status;
  throw new Error(`publisher did not start; see ${logPath(dir)}`);
}

export async function stopPublisher(dir) {
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
