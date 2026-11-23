import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

/** C24 — shipped code must resolve its own file URL via fileURLToPath, never
 *  a raw .pathname (F7: broken on Windows — /C:/ and undecoded %20). The loop
 *  plugin was fixed in C23; this closes the rest of the shipped tree. */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(REPO, "plugin");
const NODE = process.execPath;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitFor<T>(what: string, deadlineMs: number, fn: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

/** T1 — tripwire: no shipped .mjs resolves a file URL through .pathname. */
test("c24 T1: no new URL(...).pathname anywhere under plugin/", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(PLUGIN);
  assert.ok(files.length >= 3, `walked the shipped tree (found ${files.length} .mjs files)`);
  const offenders = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n")
      .map((line, i) => ({ f, line: i + 1, text: line }))
      .filter(({ text }) => /new\s+URL\s*\([^)]*\)\s*\.\s*pathname/.test(text)));
  assert.deepEqual(offenders.map(({ f, line }) => `${f}:${line}`), [],
    "file-URL .pathname breaks Windows (%20, /C:/) — use fileURLToPath");
});

/** T2 — behavioral: serve() must babysit a publisher even when the shipped
 *  tree itself lives under a path with a space (where .pathname keeps %20
 *  and node cannot load the module). Fake-gate harness à la publisher-watchdog. */
test("c24 T2: supervisor + publisher start from a path containing a space", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const hellos: number[] = [];
  const conns = new Set<import("ws").WebSocket>();
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/agent/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (conn) => wss.emit("connection", conn, req));
  });
  wss.on("connection", (conn: import("ws").WebSocket) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    conn.on("message", (data: { toString(): string }) => {
      try { if (String(JSON.parse(String(data)).t) === "hello") hellos.push(1); } catch { /* not ours */ }
    });
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;

  const base = mkdtempSync(join(tmpdir(), "hg-selfpath-"));
  const spaced = join(base, "with space x");
  const serverDir = join(spaced, "server");
  const cfgDir = join(spaced, "cfg");
  const stateDir = join(spaced, "state");
  mkdirSync(spaced);
  cpSync(join(PLUGIN, "server"), serverDir, { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(spaced, "node_modules"), "dir"); // dynamic import("ws")
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(cfgDir, "herdgate.env"), [
    "HERDGATE_URL=https://herdgate.invalid",
    `HERDGATE_AGENT_LOOPBACK_PORT=${port}`,
    "HERDGATE_ROOM_TOKEN=selfpath-fixture-token",
  ].join("\n"));

  const supPath = join(stateDir, "publisher.supervisor.pid");
  const pidPath = join(stateDir, "publisher.pid");
  const logPath = join(stateDir, "publisher.log");
  const logTail = () => { try { return readFileSync(logPath, "utf8").slice(-400); } catch { return "(no publisher.log yet)"; } };
  try {
    const hook = spawn(NODE, [join(serverDir, "index.mjs"), "serve"], {
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: cfgDir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDGATE_WATCHDOG_POLL_MS: "250" },
      stdio: "ignore",
    });
    await new Promise((r) => hook.once("exit", r));
    assert.equal(hook.exitCode, 0, "the [[startup]] hook must exit 0");

    await waitFor("a live supervisor and one hello from the spaced path", 15_000, () => {
      if (!existsSync(supPath) || !existsSync(pidPath)) return null;
      const sup = Number(readFileSync(supPath, "utf8").trim());
      const pub = Number(readFileSync(pidPath, "utf8").trim());
      return isAlive(sup) && isAlive(pub) && hellos.length >= 1;
    });
    assert.doesNotMatch(logTail(), /Cannot find module/, `publisher.log must not show a spawn-path failure: ${logTail()}`);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}; publisher.log tail: ${logTail()}`);
  } finally {
    try { writeFileSync(join(stateDir, "publisher.stop"), ""); } catch { /* gone */ }
    for (const f of [pidPath, supPath]) {
      if (!existsSync(f)) continue;
      try { process.kill(Number(readFileSync(f, "utf8").trim()), "SIGKILL"); } catch { /* dead */ }
    }
    await sleep(200);
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => http.close(() => r()));
    wss.close();
    rmSync(base, { recursive: true, force: true });
  }
});
