import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

/** C7 — the serve path (the [[startup]] hook) must babysit its publisher:
 *  crash evidence in publisher.log, respawn on death, honest stop. */
const INDEX = new URL("../plugin/server/index.mjs", import.meta.url);
const NODE = process.execPath;

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, deadlineMs: number, fn: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

/** A local stand-in gate on the loopback port: counts hellos, keeps conns. */
function fakeGate() {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const hellos: Array<Record<string, unknown>> = [];
  const conns = new Set<import("ws").WebSocket>();
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn, req));
  });
  ws.on("connection", (conn: import("ws").WebSocket) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    conn.on("message", (data: { toString(): string }) => {
      try {
        const m = { t: String(JSON.parse(String(data)).t) };
        if (m.t === "hello") hellos.push(m);
      } catch { /* not our concern */ }
    });
  });
  return {
    hellos,
    conns,
    async start(): Promise<number> {
      http.listen(0, "127.0.0.1");
      await new Promise<void>((r) => http.once("listening", r));
      const addr = http.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      return addr.port;
    },
    async close(): Promise<void> {
      for (const c of ws.clients) c.terminate();
      await new Promise<void>((r) => http.close(() => r()));
      ws.close();
    },
  };
}

function scratchConfig(port: number, extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "hg-watchdog-"));
  writeFileSync(join(dir, "herdgate.env"), [
    "HERDGATE_URL=https://herdgate.invalid",
    `HERDGATE_AGENT_LOOPBACK_PORT=${port}`,
    "HERDGATE_ROOM_TOKEN=watchdog-fixture-token",
    ...extra,
  ].join("\n"));
  return dir;
}

/** Best-effort teardown: marker-stop like the CLI, then force-kill leftovers. */
async function forceStop(dir: string) {
  const marker = join(dir, "publisher.stop");
  try { writeFileSync(marker, ""); } catch { /* gone already */ }
  for (const f of ["publisher.pid", "publisher.supervisor.pid"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try { process.kill(Number(readFileSync(p, "utf8").trim()), "SIGKILL"); } catch { /* dead */ }
    try { rmSync(p, { force: true }); } catch { /* racing cleanup */ }
  }
  await sleep(200);
  try { rmSync(marker, { force: true }); } catch { /* fine */ }
}

const serveHook = (dir: string, env: Record<string, string> = {}) => spawn(NODE, [INDEX.pathname, "serve"], {
  env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, ...env },
  stdio: "ignore",
});

test("serve babysits the publisher: crash log, respawn after SIGKILL, clean stop", async () => {
  const gate = fakeGate();
  const port = await gate.start();
  const dir = scratchConfig(port);
  // M1 rotation: an oversized log from a previous life must rotate away.
  writeFileSync(join(dir, "publisher.log"), "x".repeat(600 * 1024));
  try {
    // The hook is one-shot: serve exits after spawning the supervisor.
    const hook = serveHook(dir, {
      HERDGATE_WATCHDOG_POLL_MS: "250",
      HERDGATE_WATCHDOG_BACKOFF_BASE_MS: "100",
    });
    await new Promise((r) => hook.once("exit", r));
    assert.equal(hook.exitCode, 0, "the [[startup]] hook must exit 0");

    const supPath = join(dir, "publisher.supervisor.pid");
    const pidPath = join(dir, "publisher.pid");
    const pid1 = await waitFor("publisher.pid + first hello", 15_000, () => {
      if (!existsSync(pidPath) || !existsSync(supPath)) return null;
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      return isAlive(pid) && gate.hellos.length >= 1 ? pid : null;
    });
    assert.ok(isAlive(Number(readFileSync(supPath, "utf8").trim())), "supervisor alive");

    // M1: rotation happened, and the supervisor has said something.
    assert.ok(existsSync(join(dir, "publisher.log.old")), "oversized log rotated to .old");
    const earlyLog = readFileSync(join(dir, "publisher.log"), "utf8");
    assert.ok(earlyLog.length < 600 * 1024, "fresh log, not the rotated monster");
    assert.match(earlyLog, /supervisor/, "supervisor leaves a trace in the log");

    // M2: SIGKILL the publisher — the supervisor must respawn it.
    process.kill(pid1, "SIGKILL");
    const pid2 = await waitFor("respawned publisher", 15_000, () => {
      if (!existsSync(pidPath)) return null;
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      return pid !== pid1 && isAlive(pid) && gate.hellos.length >= 2 ? pid : null;
    });
    const afterCrash = readFileSync(join(dir, "publisher.log"), "utf8");
    assert.match(afterCrash, /respawn/i, "the crash is recorded");

    // M3: stop drains everything — both pidfiles gone, nothing reconnects.
    const stop = spawn(NODE, [INDEX.pathname, "stop"], {
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir },
      stdio: "ignore",
    });
    await new Promise((r) => stop.once("exit", r));
    await waitFor("pidfiles cleaned", 8_000, () => !existsSync(pidPath) && !existsSync(supPath));
    await sleep(700);
    assert.ok(!isAlive(pid2), "publisher child stopped");
    const hellosAtStop = gate.hellos.length;
    await sleep(1_200);
    assert.equal(gate.hellos.length, hellosAtStop, "no zombie reconnects after stop");
    assert.ok(!existsSync(join(dir, "publisher.stop")), "stop marker consumed");
  } finally {
    await forceStop(dir);
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor gives up honestly when the publisher crash-loops past its budget", async () => {
  const gate = fakeGate();
  const port = await gate.start();
  const dir = scratchConfig(port);
  try {
    const hook = serveHook(dir, {
      HERDGATE_WATCHDOG_POLL_MS: "150",
      HERDGATE_WATCHDOG_MAX: "2",
      HERDGATE_WATCHDOG_WINDOW_MS: "600000",
      HERDGATE_WATCHDOG_BACKOFF_BASE_MS: "50",
    });
    await new Promise((r) => hook.once("exit", r));

    const pidPath = join(dir, "publisher.pid");
    const supPath = join(dir, "publisher.supervisor.pid");
    // Kill the live publisher, then wait for the pidfile to move on — the
    // supervisor only rewrites it on its next poll (and removes it when the
    // budget is spent), so "alive pid in pidfile" alone races the zombie window.
    const killCurrent = async () => {
      for (;;) {
        const pid = await waitFor("a live publisher", 15_000, () =>
          existsSync(pidPath) && isAlive(Number(readFileSync(pidPath, "utf8").trim()))
            ? Number(readFileSync(pidPath, "utf8").trim()) : null);
        try { process.kill(pid, "SIGKILL"); }
        catch { continue; /* raced a respawn swapping the pid */ }
        await waitFor(`pidfile past ${pid}`, 15_000, () => {
          if (!existsSync(pidPath)) return true; // budget spent: supervisor cleans up
          const now = Number(readFileSync(pidPath, "utf8").trim());
          return now !== pid && isAlive(now) ? true : null;
        });
        return pid;
      }
    };
    await killCurrent(); // death 1 → respawn 1
    await killCurrent(); // death 2 → respawn 2
    await killCurrent(); // death 3 → budget spent
    await waitFor("supervisor exits after giving up", 15_000, () => {
      if (existsSync(supPath)) {
        const pid = Number(readFileSync(supPath, "utf8").trim());
        return !isAlive(pid);
      }
      return !existsSync(pidPath) || true;
    });
    const log = readFileSync(join(dir, "publisher.log"), "utf8");
    assert.match(log, /giving up/i, "the surrender is on the record");
  } finally {
    await forceStop(dir);
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a publisher started by an older version is adopted, not duplicated", async () => {
  const gate = fakeGate();
  const port = await gate.start();
  const dir = scratchConfig(port);
  try {
    // The pre-watchdog world: serve spawned the child itself and wrote the pid.
    const legacy = spawn(NODE, [INDEX.pathname, "serve"], {
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDGATE_PUBLISHER_CHILD: "1" },
      stdio: "ignore",
    });
    const legacyPid = await waitFor("legacy publisher hello", 15_000, () =>
      gate.hellos.length >= 1 ? legacy.pid : null);
    writeFileSync(join(dir, "publisher.pid"), String(legacyPid));

    const hook = serveHook(dir, { HERDGATE_WATCHDOG_POLL_MS: "250" });
    await new Promise((r) => hook.once("exit", r));
    await sleep(1_500); // adoption means: no second publisher while one lives
    assert.equal(gate.hellos.length, 1, "the running publisher was adopted, not duplicated");
    assert.equal(readFileSync(join(dir, "publisher.pid"), "utf8").trim(), String(legacyPid));

    // ...and once it dies, the supervisor takes over the lineage.
    process.kill(legacyPid, "SIGKILL");
    await new Promise((r) => legacy.once("exit", r));
    const pidPath = join(dir, "publisher.pid");
    await waitFor("adopted lineage respawned", 15_000, () => {
      if (!existsSync(pidPath)) return null;
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      return pid !== legacyPid && isAlive(pid) && gate.hellos.length >= 2 ? pid : null;
    });
  } finally {
    await forceStop(dir);
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
