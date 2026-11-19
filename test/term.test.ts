/**
 * Live terminals: the publisher answers term.list (panes mapped from `herdr pane
 * list`) and term.read (ANSI from `herdr agent read`), throttled to 1/s per device
 * — a poll loop must not fork the CLI hot — and refuses junk targets.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";

const INDEX = new URL("../plugin/server/index.mjs", import.meta.url).pathname;

/** A fake herdr: snapshot + pane list + agent read, all via stdout JSON/ANSI. */
function fakeHerdr(dir: string): string {
  const p = join(dir, "herdr");
  const snap = { id: "cli:api:snapshot", result: { snapshot: { version: "0.9.5", protocol: 22, workspaces: [], agents: [] } } };
  const panes = {
    id: "cli:pane:list",
    result: {
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", agent: "pi", agent_status: "working", cwd: "/src", terminal_title_stripped: "π - source", terminal_id: "t1" },
        { pane_id: "w2:p2", workspace_id: "w2", cwd: "/tmp", terminal_title: "bash", terminal_id: "t2" },
      ],
    },
  };
  const body = `#!/bin/sh
case "$1 $2" in
  "api snapshot") cat <<'JSON'
${JSON.stringify(snap)}
JSON
;;
  "pane list") cat <<'JSON'
${JSON.stringify(panes)}
JSON
;;
esac
if [ "$1" = "agent" ] && [ "$2" = "read" ] && [ "$3" = "w1:p1" ]; then
  printf '\\033[38;2;211;134;155mworking on it\\033[0m plain\\n'
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "read" ]; then
  echo "no agent in that pane" >&2; exit 1
fi
`;
  writeFileSync(p, body, { mode: 0o755 });
  return p;
}

interface Recv { t: string; [k: string]: unknown }

test("publisher: term.list and term.read answer, throttle, and refuse junk targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-term-"));
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const fromHost: Recv[] = [];
  server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
      if (m.t === "hello") {
        ws.send(JSON.stringify({ v: 1, t: "hello", roomId: "r", devices: [{ id: "d1", name: "phone", scope: "read" }] }));
        return;
      }
      if (m.t === "frame" && m.device === "d1") fromHost.push(m.payload as Recv);
    });
  }));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;

  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(configDir, "herdgate.env"), `HERDGATE_URL=http://127.0.0.1:${port}\nHERDGATE_ROOM_TOKEN=rt\n`);
  const child = spawn(process.execPath, [INDEX, "serve"], {
    env: {
      ...process.env,
      HERDR_ENV: "1",
      HERDR_PLUGIN_ID: "dev.herdgate.host",
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: fakeHerdr(dir),
      HERDGATE_SETTINGS: join(dir, "settings.json"),
      HERDGATE_PUBLISHER_CHILD: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d));

  const waitOp = async (op: string, since = 0, timeoutMs = 10_000): Promise<Recv> => {
    const t0 = Date.now();
    for (;;) {
      const hit = fromHost.slice(since).find((p) => p && (p as { op?: string }).op === op);
      if (hit) return hit;
      if (Date.now() - t0 > timeoutMs) throw new Error(`no ${op} in time — stderr: ${stderr.slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const sendOp = (payload: Record<string, unknown>): void => {
    wss.clients.forEach((ws) => ws.send(JSON.stringify({ v: 1, t: "frame", device: "d1", payload })));
  };

  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no hello — stderr: ${stderr.slice(0, 300)}`)), 10_000);
      const iv = setInterval(() => {
        if (fromHost.length >= 0 && wss.clients.size > 0 && stderr.includes("connected")) {
          clearTimeout(t);
          clearInterval(iv);
          res();
        }
      }, 100);
    });

    // 1. term.list — mapped panes.
    sendOp({ op: "term.list" });
    const list = (await waitOp("term.list")) as unknown as { panes: { id: string; agent: string | null; title: string }[] };
    assert.equal(list.panes.length, 2);
    assert.deepEqual(list.panes.map((p) => p.id), ["w1:p1", "w2:p2"]);
    assert.equal(list.panes[0].agent, "pi");
    assert.equal(list.panes[1].agent, null);
    assert.equal(list.panes[1].title, "bash");

    // 2. immediate second call hits the 1/s throttle.
    let mark = fromHost.length;
    sendOp({ op: "term.list" });
    const busy = (await waitOp("error", mark)) as unknown as { code: string };
    assert.equal(busy.code, "busy");

    // 3. term.read passes ANSI through untouched.
    await new Promise((r) => setTimeout(r, 1_100));
    sendOp({ op: "term.read", target: "w1:p1", lines: 20 });
    const read = (await waitOp("term.read")) as unknown as { target: string; ansi: string };
    assert.equal(read.target, "w1:p1");
    assert.ok(read.ansi.includes("\u001b[38;2;211;134;155mworking on it\u001b[0m plain"), `ansi passthrough: ${JSON.stringify(read.ansi)}`);

    // 4. junk target refused before any subprocess runs (target check precedes the throttle).
    mark = fromHost.length;
    sendOp({ op: "term.read", target: "x; rm -rf /" });
    const bad2 = (await waitOp("error", mark)) as unknown as { code: string };
    assert.equal(bad2.code, "bad-target");
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((res) => server.close(() => res()));
    wss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
