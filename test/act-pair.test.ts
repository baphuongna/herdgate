/**
 * The act-pairing answer: `pair.request` from the cloud must be denied while the
 * owner's switch (settings.allowAct, written by the panel) is off, and approved
 * when it is on — read fresh, so flipping the switch takes effect without a
 * publisher restart. Driven through the real publisher loop and a fake cloud.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";

const run = promisify(execFile);
const INDEX = new URL("../plugin/server/index.mjs", import.meta.url).pathname;

/** A fake herdr binary whose `api snapshot` prints the given JSON. */
function fakeHerdr(dir: string): string {
  const p = join(dir, "herdr");
  const snap = { id: "cli:api:snapshot", result: { snapshot: { version: "0.9.5", protocol: 22, workspaces: [], agents: [] } } };
  writeFileSync(p, `#!/bin/sh\n[ "$1" = "api" ] && [ "$2" = "snapshot" ] && cat <<'JSON'\n${JSON.stringify(snap)}\nJSON\n`, { mode: 0o755 });
  return p;
}

test("plugin: pair.request denied without allowAct, approved with it (read fresh)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-act-"));
  const settingsPath = join(dir, "settings.json");
  // A cloud that says hello and records pair.responses.
  const asks: { scope: string; ok: boolean }[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { t: string; roomToken?: string; requestId?: string; scope?: string; ok?: boolean };
      if (m.t === "hello") {
        assert.equal(m.roomToken, "room-tok");
        ws.send(JSON.stringify({ v: 1, t: "hello", roomId: "r_test", devices: [] }));
        // Ask right away, while the switch is off.
        ws.send(JSON.stringify({ v: 1, t: "pair.request", requestId: "pr1", device: { name: "laptop" }, scope: "act" }));
        return;
      }
      if (m.t === "pair.response") asks.push({ scope: "act", ok: m.ok === true });
    });
  }));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;

  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(configDir, "herdgate.env"), `HERDGATE_URL=http://127.0.0.1:${port}\nHERDGATE_ROOM_TOKEN=room-tok\n`);
  const env = {
    ...process.env,
    HERDR_ENV: "1",
    HERDR_PLUGIN_ID: "dev.herdgate.host",
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_BIN_PATH: fakeHerdr(dir),
    HERDGATE_SETTINGS: settingsPath,
  };
  const child = spawn(process.execPath, [INDEX, "serve"], { env: { ...env, HERDGATE_PUBLISHER_CHILD: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d));
  try {
    // 1. switch off → denied
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no pair.response in time — stderr: ${stderr.slice(0, 300)}`)), 10_000);
      const iv = setInterval(() => {
        if (asks.length >= 1) { clearTimeout(t); clearInterval(iv); res(); }
      }, 100);
    });
    assert.equal(asks[0].ok, false, "act must be denied while allowAct is off");

    // 2. flip the switch (as the panel does) → the running publisher must see it
    writeFileSync(settingsPath, JSON.stringify({ cloud: "x", allowAct: true }));
    wss.clients.forEach((ws) => ws.send(JSON.stringify({ v: 1, t: "pair.request", requestId: "pr2", device: { name: "laptop" }, scope: "act" })));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no second pair.response — stderr: ${stderr.slice(0, 300)}`)), 10_000);
      const iv = setInterval(() => {
        if (asks.length >= 2) { clearTimeout(t); clearInterval(iv); res(); }
      }, 100);
    });
    assert.equal(asks[1].ok, true, "act must be approved once allowAct is on (read fresh, no restart)");
    assert.match(stderr, /approved \(allowAct\)/);
    void run; // keep the import honest if unused elsewhere
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((res) => server.close(() => res()));
    wss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
