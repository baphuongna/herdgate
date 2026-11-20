import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const run = promisify(execFile);
const moduleUrl = new URL("../plugin/server/publisher-tui-lifecycle.mjs", import.meta.url).href;
const indexPath = join(import.meta.dirname, "../plugin/server/index.mjs");

test("publisher lifecycle: detached worker survives launcher exit, status distinguishes connection, stop targets that worker", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-pub-life-"));
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
  const command = async (action: string) => JSON.parse((await run(process.execPath, [script, action, dir], { timeout: 9_000 })).stdout);
  try {
    assert.equal((await command("status")).state, "stopped");
    const started = await command("start");
    assert.equal(started.state, "connected");
    assert.equal((await command("status")).pid, started.pid);
    assert.equal((await command("start")).pid, started.pid);
    assert.equal((await command("stop")).state, "stopped");
    assert.equal((await command("status")).state, "stopped");
  } finally {
    await command("stop").catch(() => {});
    rmSync(dir, { force: true, recursive: true });
  }
});

test("background publisher only reports connected after the gate hello; local stop disconnects it", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-pub-gate-"));
  const script = join(dir, "controller.mjs");
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  writeFileSync(join(dir, "herdgate.env"), `HERDGATE_URL=http://127.0.0.1:${addr.port}\nHERDGATE_ROOM_TOKEN=test-token\n`);
  writeFileSync(script, `
    import { startPublisher, publisherStatus, stopPublisher } from ${JSON.stringify(moduleUrl)};
    const [action, dir, index] = process.argv.slice(2);
    console.log(JSON.stringify(action === 'start'
      ? await startPublisher(dir, [index, 'serve'])
      : action === 'stop' ? await stopPublisher(dir) : publisherStatus(dir)));
  `);
  const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDGATE_PUBLISHER_CHILD: "1", HERDGATE_TUI_ONLY: "1" };
  const command = async (action: string) => JSON.parse((await run(process.execPath, [script, action, dir, indexPath], { env, timeout: 9_000 })).stdout);
  try {
    const conn = once(wss, "connection", { signal: AbortSignal.timeout(5_000) }).then(async ([ws]) => {
      const [raw] = await once(ws, "message", { signal: AbortSignal.timeout(2_000) });
      assert.equal(JSON.parse(String(raw)).roomToken, "test-token");
      return ws;
    });
    const pending = command("start");
    const socket = await conn;
    assert.equal((await command("status")).state, "connecting");
    socket.send(JSON.stringify({ v: 1, t: "hello", roomId: "fixture", devices: [] }));
    assert.equal((await pending).state, "connected");
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) });
    assert.equal((await command("stop")).state, "stopped");
    await closed;
  } finally {
    await command("stop").catch(() => {});
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { force: true, recursive: true });
  }
});
