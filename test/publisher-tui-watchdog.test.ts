import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** C8 — the Windows TUI publisher (run-id lock model) must be babysat like the
 *  serve path was in C7: respawn on death, adopt a live lineage, heal a stale
 *  lock, honest stop that stands the supervisor down too. */
const moduleUrl = new URL("../plugin/server/publisher-tui-lifecycle.mjs", import.meta.url).href;
const NODE = process.execPath;

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, deadlineMs: number, fn: () => T | Promise<T | null | undefined | false> | null | undefined | false): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

/** Scratch state dir + a controller script that drives the lifecycle module,
 *  and a worker mode that registers exactly like the real TUI publisher. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hg-tui-watchdog-"));
  const script = join(dir, "controller.mjs");
  writeFileSync(script, `
    import { startPublisher, publisherStatus, stopPublisher, registerPublisher } from ${JSON.stringify(moduleUrl)};
    const [action, dir] = process.argv.slice(2);
    if (action === 'worker') {
      const lifecycle = registerPublisher(dir, process.env.HERDGATE_TUI_RUN_ID, () => {
        lifecycle.release();
        process.exit(0);
      });
      lifecycle.setConnected(true);
    } else {
      const state = action === 'start'
        ? await startPublisher(dir, [process.argv[1], 'worker', dir])
        : action === 'stop' ? await stopPublisher(dir) : publisherStatus(dir);
      console.log(JSON.stringify(state));
    }
  `);
  return { dir, script };
}

const ctl = async (script: string, dir: string, action: string, env: Record<string, string> = {}): Promise<{ state: string; pid?: number; supervised?: boolean }> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const out = await promisify(execFile)(NODE, [script, action, dir], { env: { ...process.env, ...env }, timeout: 9_000 });
  return JSON.parse(String(out.stdout));
};

const heartbeat = (dir: string) => join(dir, "publisher-tui.supervisor.json");
const supervisorStop = (dir: string) => join(dir, "publisher-tui.supervisor.stop");
const supervisorAliveIn = (dir: string) => {
  if (!existsSync(heartbeat(dir))) return false;
  try {
    const { pid, pollMs, at } = JSON.parse(readFileSync(heartbeat(dir), "utf8"));
    return isAlive(pid) && Date.now() - at < Math.max(3 * pollMs, 3_000);
  } catch { return false; }
};
const lockRun = (dir: string) => {
  try { return JSON.parse(readFileSync(join(dir, "publisher-tui.lock"), "utf8")).run as string; }
  catch { return null; }
};

/** A worker started the old way: directly, no supervisor anywhere. */
function directWorker(script: string, dir: string) {
  return spawn(NODE, [script, "worker", dir], {
    env: { ...process.env, HERDGATE_TUI_RUN_ID: randomUUID() }, stdio: "ignore",
  });
}

const FAST = { HERDGATE_WATCHDOG_POLL_MS: "200", HERDGATE_WATCHDOG_BACKOFF_BASE_MS: "100" };

async function teardown(dir: string, script: string) {
  await ctl(script, dir, "stop").catch(() => {});
  // The supervisor markerstop path covers the normal cases; anything still
  // holding the lock after that is a bug — kill by the lock's pid, best effort.
  try {
    const own = JSON.parse(readFileSync(join(dir, "publisher-tui.lock"), "utf8"));
    if (own?.pid) process.kill(own.pid, "SIGKILL");
  } catch { /* nothing to clean */ }
  try {
    if (existsSync(heartbeat(dir))) {
      const { pid } = JSON.parse(readFileSync(heartbeat(dir), "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    }
  } catch { /* nothing to clean */ }
  await sleep(150);
  rmSync(dir, { force: true, recursive: true });
}

test("tui watchdog: SIGKILL the publisher → respawn with a fresh run, evidence in the log", { timeout: 20_000 }, async () => {
  const { dir, script } = fixture();
  try {
    const s1 = await ctl(script, dir, "start", FAST);
    assert.equal(s1.state, "connected");
    assert.ok(s1.pid && isAlive(s1.pid));
    assert.ok(supervisorAliveIn(dir), "a supervisor heartbeats beside the publisher");
    const run1 = lockRun(dir);

    process.kill(s1.pid!, "SIGKILL");
    const s2 = await waitFor("respawned publisher", 10_000, () => {
      if (!existsSync(heartbeat(dir))) return null;
      return ctl(script, dir, "status").then((st) => st.state === "connected" && st.pid !== s1.pid ? st : null).catch(() => null);
    });
    assert.ok(s2.pid && isAlive(s2.pid), "the new publisher is a live, different process");
    assert.notEqual(lockRun(dir), run1, "the respawned publisher claims a fresh run id");

    const log = readFileSync(join(dir, "publisher-tui.log"), "utf8");
    assert.match(log, /exited/, "the death leaves a trace");
    assert.match(log, /respawn/, "the respawn leaves a trace");
    await teardown(dir, script);
  } catch (e) {
    await teardown(dir, script);
    throw e;
  }
});

test("tui watchdog: stop stands the supervisor down too — no markers left, no respawn", { timeout: 20_000 }, async () => {
  const { dir, script } = fixture();
  try {
    const s = await ctl(script, dir, "start", FAST);
    assert.equal(s.state, "connected");
    const stopped = await ctl(script, dir, "stop", FAST);
    assert.equal(stopped.state, "stopped");
    assert.ok(!existsSync(heartbeat(dir)), "supervisor heartbeat removed");
    assert.ok(!existsSync(supervisorStop(dir)), "supervisor stop marker removed");
    await sleep(400); // 2× the fast poll — a stray supervisor would have respawned
    const still = await ctl(script, dir, "status");
    assert.equal(still.state, "stopped");
    assert.equal(still.supervised, false);
    rmSync(dir, { force: true, recursive: true });
  } catch (e) {
    await teardown(dir, script);
    throw e;
  }
});

test("tui watchdog: crash budget — after MAX deaths the supervisor gives up loudly", { timeout: 30_000 }, async () => {
  const { dir, script } = fixture();
  const env = { ...FAST, HERDGATE_WATCHDOG_MAX: "2", HERDGATE_WATCHDOG_WINDOW_MS: "30000" };
  try {
    let s = await ctl(script, dir, "start", env);
    assert.equal(s.state, "connected");
    for (let i = 0; i < 3; i++) { // two respawns, the third death must exhaust the budget
      process.kill(s.pid!, "SIGKILL");
      if (i < 2) s = await waitFor(`respawn ${i + 1}`, 10_000, () =>
        ctl(script, dir, "status").then((st) => st.state === "connected" && st.pid !== s.pid ? st : null).catch(() => null));
    }
    await waitFor("supervisor to give up", 10_000, () => !existsSync(heartbeat(dir)));
    const log = readFileSync(join(dir, "publisher-tui.log"), "utf8");
    assert.match(log, /giving up/, "the give-up is loud");
    await sleep(600); // backoff was 100/200ms — a confused supervisor would respawn here
    const after = await ctl(script, dir, "status");
    assert.equal(after.state, "stopped", "no publisher after give-up");
    rmSync(dir, { force: true, recursive: true });
  } catch (e) {
    await teardown(dir, script);
    throw e;
  }
});

test("tui watchdog: adopts a live publisher started without a supervisor, then babysits it", { timeout: 20_000 }, async () => {
  const { dir, script } = fixture();
  try {
    const worker = directWorker(script, dir);
    const first = await waitFor("direct worker connected", 10_000, () =>
      ctl(script, dir, "status").then((st) => st.state === "connected" && st.pid === worker.pid ? st : null).catch(() => null));
    assert.equal(first.supervised, false, "no supervisor yet");

    const started = await ctl(script, dir, "start", FAST); // must not spawn a second publisher
    assert.equal(started.state, "connected");
    assert.equal(started.pid, worker.pid, "the existing publisher is adopted, not replaced");
    assert.ok(supervisorAliveIn(dir), "the adopter supervisor heartbeats");

    process.kill(worker.pid, "SIGKILL"); // now the adopted lineage must be respawned
    const next = await waitFor("adopted publisher respawned", 10_000, () =>
      ctl(script, dir, "status").then((st) => st.state === "connected" && st.pid !== worker.pid ? st : null).catch(() => null));
    assert.ok(next.pid && isAlive(next.pid));
    const log = readFileSync(join(dir, "publisher-tui.log"), "utf8");
    assert.match(log, /adopt/, "the adoption leaves a trace");
    await teardown(dir, script);
  } catch (e) {
    await teardown(dir, script);
    throw e;
  }
});

test("tui watchdog: a stale lock (dead publisher, no supervisor) heals on start", { timeout: 20_000 }, async () => {
  const { dir, script } = fixture();
  try {
    const worker = directWorker(script, dir);
    await waitFor("direct worker connected", 10_000, () =>
      ctl(script, dir, "status").then((st) => st.state === "connected" && st.pid === worker.pid ? st : null).catch(() => null));
    process.kill(worker.pid, "SIGKILL"); // no exit handler → the lock survives as stale
    const stale = await waitFor("lock gone stale", 10_000, () =>
      ctl(script, dir, "status").then((st) => st.state === "stale" ? st : null).catch(() => null));
    assert.ok(stale.pid);

    const healed = await ctl(script, dir, "start", FAST); // must reap + respawn, not error out
    assert.equal(healed.state, "connected");
    assert.notEqual(healed.pid, stale.pid, "a fresh publisher, not the corpse");
    assert.ok(isAlive(healed.pid!));
    const log = readFileSync(join(dir, "publisher-tui.log"), "utf8");
    assert.match(log, /respawn/, "the heal goes through the respawn path");
    await teardown(dir, script);
  } catch (e) {
    await teardown(dir, script);
    throw e;
  }
});
