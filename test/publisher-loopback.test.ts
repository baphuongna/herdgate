import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

const INDEX = new URL("../plugin/server/index.mjs", import.meta.url);
const MOBILE = new URL("../src/host/mobile-tui.ts", import.meta.url);

test("Mobile TUI publisher can authenticate via loopback with its own room token and the public Host", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const publicHost = "mobile.herdgate.invalid";
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== publicHost || req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn, req));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  const timeout = AbortSignal.timeout(4_000);
  const hello = once(ws, "connection", { signal: timeout }).then(([conn]) => once(conn, "message", { signal: timeout }));
  const child = spawn(process.execPath, [MOBILE.pathname], {
    env: { ...process.env, HERDGATE_URL: `https://${publicHost}`, HERDGATE_ROOM_TOKEN: "mobile-fixture-token", HERDGATE_AGENT_LOOPBACK_PORT: String(addr.port) },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    const [data] = await hello;
    const message = JSON.parse(String(data));
    assert.equal(message.t, "hello");
    assert.equal(message.roomToken, "mobile-fixture-token");
    assert.equal(message.info.version, "tui-core-pilot");
  } finally {
    for (const conn of ws.clients) conn.terminate();
    child.kill();
    await exited;
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("publisher can authenticate over loopback while retaining the public gate Host header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-loopback-"));
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const publicHost = "herdgate.invalid";
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.host !== publicHost || req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (conn) => ws.emit("connection", conn, req));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  writeFileSync(join(dir, "herdgate.env"), [
    `HERDGATE_URL=https://${publicHost}`,
    `HERDGATE_AGENT_LOOPBACK_PORT=${addr.port}`,
    "HERDGATE_ROOM_TOKEN=fixture-token",
  ].join("\n"));
  const timeout = AbortSignal.timeout(4_000);
  const hello = once(ws, "connection", { signal: timeout }).then(([conn]) => once(conn, "message", { signal: timeout }));
  const child = spawn(process.execPath, [INDEX.pathname, "serve"], {
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDGATE_PUBLISHER_CHILD: "1" },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    const [data] = await hello;
    const message = JSON.parse(String(data));
    assert.equal(message.t, "hello");
    assert.equal(message.roomToken, "fixture-token");
  } finally {
    child.kill();
    await exited;
    for (const conn of ws.clients) conn.terminate();
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
