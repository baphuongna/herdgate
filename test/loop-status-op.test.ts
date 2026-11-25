/**
 * C21 — device op `loop.status`: the shipped dev-loop plugin's state, visible
 * from a phone. Drives the REAL publisher `serve` against a fake gate WS (the
 * publisher-loopback pattern): hello with one read device, relay the device's
 * frame, collect the reply frame. No real herdr, no gate, no SSH — temp dirs.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

const INDEX = new URL("../plugin/server/index.mjs", import.meta.url);

type Frame = { v: number; t: string; device: string; payload: Record<string, unknown> };

/** Fake gate: hello with one read device; record every agent frame; let the
 *  test relay device frames in and await the matching reply op. */
async function fakeGate(dir: string, extraEnv: Record<string, string | undefined> = {}) {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const device = { id: "d_c21", name: "c21", scope: "read" };
  const frames: Frame[] = [];
  let conn: WebSocket | null = null;
  ws.on("connection", (c) => {
    conn = c;
    c.on("message", (data) => {
      const m = JSON.parse(String(data)) as Frame;
      if (m.t === "hello") {
        c.send(JSON.stringify({ v: 1, t: "hello", roomId: "r_c21", devices: [device] }));
      } else if (m.t === "frame") {
        frames.push(m);
      }
    });
  });
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/agent/ws") return socket.destroy();
    ws.handleUpgrade(req, socket, head, (c) => ws.emit("connection", c));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  // The publisher's pairing file rides the config dir (the loopback pattern),
  // pointing the outbound WS at this process's loopback port.
  writeFileSync(join(dir, "herdgate.env"), [
    "HERDGATE_URL=https://herdgate.invalid",
    `HERDGATE_AGENT_LOOPBACK_PORT=${addr.port}`,
    "HERDGATE_ROOM_TOKEN=fixture-token",
  ].join("\n"));
  // Fake herdr: a valid minimal snapshot for the initial publish tick.
  writeFileSync(join(dir, "herdr-fake"),
    `#!/bin/sh\nprintf '%s' '{"snapshot":{"workspaces":[],"agents":[],"focused_workspace_id":null}}'\n`,
    { mode: 0o755 });
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.HERDGATE_LOOP_STATE_DIR; // no loop env may leak in from this process
  delete env.HERDR_LOOP_STATE_DIR;
  const child = spawn(process.execPath, [INDEX.pathname, "serve"], {
    env: {
      ...env,
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      HERDGATE_PUBLISHER_CHILD: "1",
      HERDGATE_PUBLISH_MS: "60000",
      HERDR_BIN_PATH: join(dir, "herdr-fake"),
      ...extraEnv,
    },
    stdio: "ignore",
  });
  // Under `--test-concurrency=4` a cold plugin spawn can exceed 8 s (measured flakes on
  // 25–26/11: 'no loop.status reply within 8000ms' with a healthy publisher). 30 s stays a real bound.
  const deadline = Date.now() + 30_000;
  while (!conn && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(conn, "publisher never connected to the fake gate");
  /** Send a device op; resolve with the first frame after that whose payload op matches. */
  const ask = async (op: string, timeoutMs = 30_000): Promise<Record<string, unknown>> => {
    const seen = frames.length;
    conn!.send(JSON.stringify({ v: 1, t: "frame", device: device.id, payload: { op } }));
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = frames.slice(seen).find((f) => (f.payload as { op?: string }).op === op);
      if (hit) return hit.payload;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`no ${op} reply within ${timeoutMs}ms`);
  };
  return {
    frames, child, device, ask,
    async close() {
      child.kill();
      await once(child, "exit");
      for (const c of ws.clients) c.terminate();
      ws.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function writeLoopState(base: string, state: Record<string, unknown>, bom = false): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "state.json"), (bom ? "\uFEFF" : "") + JSON.stringify(state));
}

test("loop.status: state dir with state.json + a 30-line loop.log answers the capped shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c21-"));
  const loopBase = join(dir, "loop");
  writeLoopState(loopBase, {
    paneId: "w1:p9", workspaceId: "w1", status: "running", paused: true,
    pausedBy: "owner", cycles: 7, lastNudgeAt: 1_700_000_000_000,
  });
  const line = "2026-11-23T00:00:00.000Z nudge #1 ok (pane w1:p9) — a perfectly ordinary loop decision line";
  writeFileSync(join(loopBase, "loop.log"), Array.from({ length: 30 }, (_, i) => `${i + 1} ${line}`).join("\n") + "\n");
  const gate = await fakeGate(dir, { HERDGATE_LOOP_STATE_DIR: loopBase });
  try {
    const payload = await gate.ask("loop.status") as { op: string; loop: Record<string, unknown> };
    assert.equal(payload.op, "loop.status");
    const loop = payload.loop as Record<string, unknown>;
    assert.equal(loop.ok, true);
    assert.deepEqual(loop.pane, { id: "w1:p9", alive: null }, "alive is honestly null — this op never calls herdr");
    assert.equal(loop.status, "running");
    assert.equal(loop.paused, true);
    assert.equal(loop.pausedBy, "owner");
    assert.equal(loop.cycles, 7);
    assert.equal(loop.lastNudgeAt, 1_700_000_000_000);
    const tail = loop.logTail as string[];
    assert.ok(Array.isArray(tail) && tail.length <= 20, `logTail capped at 20, got ${tail?.length}`);
    assert.ok(tail.every((l) => typeof l === "string" && l.length <= 200), "every tail line is <= 200 chars");
    assert.ok(tail.at(-1)?.startsWith("30 "), "the tail keeps the NEWEST lines (file order)");
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop.status: no state dir anywhere -> honest unknown, and the server stays alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c21-"));
  // The sibling path (dirname(HERDR_PLUGIN_STATE_DIR)/dev.herdgate.loop) does not exist.
  const gate = await fakeGate(dir);
  try {
    const payload = await gate.ask("loop.status") as { op: string; loop: Record<string, unknown> };
    assert.equal(payload.op, "loop.status");
    assert.deepEqual(payload.loop, { ok: false, error: "unknown" });
    // Server alive: a view op afterwards still comes back as a snapshot push.
    const before = gate.frames.filter((f) => (f.payload as { op?: string }).op === "view").length;
    const view = await gate.ask("view") as Record<string, unknown>;
    assert.equal(view.op, "view");
    const total = gate.frames.filter((f) => (f.payload as { op?: string }).op === "view").length;
    assert.ok(total >= before + 1, `a view frame arrived after the unknown reply (before ${before}, after ${total})`);
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop.status: HERDR_LOOP_STATE_DIR wins over the sibling dev.herdgate.loop path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c21-"));
  const sibling = join(dir, "dev.herdgate.loop");
  writeLoopState(sibling, { status: "sibling-marker", cycles: 1 });
  const override = join(dir, "override");
  writeLoopState(override, { status: "env-marker", cycles: 3 });
  const gate = await fakeGate(dir, { HERDR_LOOP_STATE_DIR: override });
  try {
    const payload = await gate.ask("loop.status") as { loop: { status: string; cycles: number } };
    assert.equal(payload.loop.status, "env-marker", "the env dir answers, not the sibling");
    assert.equal(payload.loop.cycles, 3);
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop.status: a BOM-prefixed state.json still parses (the C12 lesson, mirrored here)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c21-"));
  const loopBase = join(dir, "loop");
  writeLoopState(loopBase, { paneId: "w2:p1", status: "done", paused: false, cycles: 2, lastNudgeAt: 0 }, true);
  const gate = await fakeGate(dir, { HERDGATE_LOOP_STATE_DIR: loopBase });
  try {
    const payload = await gate.ask("loop.status") as { loop: Record<string, unknown> };
    assert.equal(payload.loop.ok, true, "a BOM must not become 'unknown'");
    assert.equal(payload.loop.status, "done");
    assert.equal(payload.loop.cycles, 2);
    assert.equal(payload.loop.paused, false);
    assert.equal(payload.loop.lastNudgeAt, null, "0/absent lastNudgeAt is null, not a fake epoch");
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop.status: a log line longer than 200 chars is cut, not dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c21-"));
  const loopBase = join(dir, "loop");
  writeLoopState(loopBase, { status: "running", cycles: 1 });
  const long = "x".repeat(500);
  writeFileSync(join(loopBase, "loop.log"), `short line\n${long}\n`);
  const gate = await fakeGate(dir, { HERDGATE_LOOP_STATE_DIR: loopBase });
  try {
    const payload = await gate.ask("loop.status") as { loop: { logTail: string[] } };
    const tail = payload.loop.logTail;
    assert.equal(tail.length, 2);
    assert.equal(tail[1]!.length, 200);
    assert.ok(tail[1]!.startsWith("xxx"));
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop.status: deferredUntil surfaces additively (C23) — epoch ms when scheduled, null when not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-c23-"));
  const loopBase = join(dir, "loop");
  writeLoopState(loopBase, {
    paneId: "w3:p1", status: "running", cycles: 2, lastNudgeAt: 1_700_000_000_000,
    deferredUntil: 1_900_000_000_000, deferredId: "c23a0001-0000-4000-8000-000000000001",
  });
  const gate = await fakeGate(dir, { HERDGATE_LOOP_STATE_DIR: loopBase });
  try {
    const payload = await gate.ask("loop.status") as { loop: Record<string, unknown> };
    const loop = payload.loop;
    assert.equal(loop.ok, true);
    assert.equal(loop.deferredUntil, 1_900_000_000_000, "when the deferred nudge fires is visible from a phone");
    assert.equal(loop.status, "running");
    assert.equal(loop.lastNudgeAt, 1_700_000_000_000, "the old fields are unchanged (additive only)");

    // No schedule in state: null, never undefined/absent-key drift.
    writeLoopState(loopBase, { paneId: "w3:p1", status: "running", cycles: 2, lastNudgeAt: 1_700_000_000_000 });
    const again = await gate.ask("loop.status") as { loop: Record<string, unknown> };
    assert.equal((again.loop).deferredUntil, null);
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
