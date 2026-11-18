/**
 * herdgate plugin for Herdr — commands behind the manifest.
 *
 * The plugin calls Herdr through `HERDR_BIN_PATH` (the official CLI) and publishes the
 * resulting metadata to a herdgate cloud over one outbound WebSocket. Read-only: the
 * plugin never sends a keystroke, reads a pane's content, or runs an agent.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import { dirs, readConfig, writeConfig, readState, writeState, herdrSnapshot, summarize } from "./common.mjs";

const D = dirs();
const NAME = process.env.HERDGATE_HOST_NAME || hostname();
const log = (line) => console.error(`herdgate: ${line}`);

/** The publisher runs as a detached child of `serve`, recording its pid in state. */
const pidPath = D.stateDir ? join(D.stateDir, "publisher.pid") : "";

async function cloudUrl() {
  const cfg = readConfig(D.configPath);
  const url = process.env.HERDGATE_URL || cfg.HERDGATE_URL || "";
  if (!url) throw new Error("no cloud configured — set HERDGATE_URL in the plugin config");
  return url.replace(/\/$/, "");
}

async function roomToken() {
  const cfg = readConfig(D.configPath);
  const t = process.env.HERDGATE_ROOM_TOKEN || cfg.HERDGATE_ROOM_TOKEN || "";
  if (!t) throw new Error("not paired — run the 'pair' action first");
  return t;
}

/** --- pair: device flow through the herdgate cloud, then save the room token. --- */
async function pair() {
  const url = await cloudUrl();
  const res = await fetch(`${url}/v1/agent/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: NAME }),
  });
  if (!res.ok) throw new Error(`cloud refused the pairing code: HTTP ${res.status}`);
  const minted = await res.json();
  console.log(`Approve this Herdr host in your herdgate dashboard:`);
  console.log(`  ${minted.url}`);
  console.log(`  code: ${minted.code}   (expires in ${Math.round((minted.expiresIn ?? 600) / 60)} min)`);
  console.log("");
  console.log("Waiting for approval… (Ctrl+C to cancel; the code expires on its own)");

  const deadline = Date.now() + (minted.expiresIn ?? 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const st = await (await fetch(`${url}/v1/agent/code/${minted.code}/status`)).json();
    if (st.status === "approved" && st.roomToken) {
      const cfg = readConfig(D.configPath);
      cfg.HERDGATE_URL = url;
      cfg.HERDGATE_ROOM_TOKEN = st.roomToken;
      writeConfig(D.configPath, cfg);
      console.log(`Paired. Room ${st.roomId} saved to the plugin config (mode 0600).`);
      console.log(`The publisher starts at the next Herdr server start, or run the 'stop' then 'serve' action.`);
      return;
    }
    if (st.status === "unknown") throw new Error("the pairing code expired before it was approved");
  }
  throw new Error("pairing timed out");
}

/** --- status: what is configured, what the cloud would see, is it running. --- */
async function status() {
  const cfg = readConfig(D.configPath);
  const state = readState(D.statePath);
  const out = {
    plugin: D.pluginId,
    config: {
      path: D.configPath || "(HERDR_PLUGIN_CONFIG_DIR unset)",
      cloud: cfg.HERDGATE_URL ?? "(not set)",
      paired: Boolean(cfg.HERDGATE_ROOM_TOKEN),
    },
    publisher: { pid: runningPid() ?? null, running: Boolean(runningPid()) },
    lastPublish: state.lastPublish ?? null,
    herdr: null,
    error: null,
  };
  try {
    out.herdr = summarize(await herdrSnapshot(D.herdrBin));
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.error) process.exitCode = 1;
}

function runningPid() {
  if (!pidPath || !existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // stale
  }
}

/** --- serve: the startup hook. Start the publisher once, then exit (Herdr's hook is one-shot). --- */
async function serve() {
  if (process.env.HERDGATE_PUBLISHER_CHILD === "1") return publisherLoop(); // the child
  const pid = runningPid();
  if (pid) {
    log(`publisher already running (pid ${pid}); nothing to do`);
    return;
  }
  const cfg = readConfig(D.configPath);
  if (!cfg.HERDGATE_URL || !cfg.HERDGATE_ROOM_TOKEN) {
    // Not paired yet: the startup hook must not fail the server.
    log("not paired — run the 'pair' action to publish this Herdr");
    return;
  }
  const child = spawn(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, "serve"], {
    env: { ...process.env, HERDGATE_PUBLISHER_CHILD: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (pidPath) {
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(child.pid));
  }
  log(`publisher started (pid ${child.pid})`);
}

/**
 * The long-lived publisher: read Herdr metadata and push it to every paired device.
 * Reconnects with bounded backoff. Uses Node's global WebSocket so the plugin needs no
 * node_modules — `herdr plugin install` checks out the manifest directory alone.
 */
async function publisherLoop() {
  const cfg = readConfig(D.configPath);
  const url = cfg.HERDGATE_URL.replace(/\/$/, "");
  const wsUrl = url.replace(/^http/, "ws") + "/v1/agent/ws";
  const token = cfg.HERDGATE_ROOM_TOKEN;
  let backoff = 1_000;
  let lastSig = "";
  let devices = [];
  let timer = null;

  const snapshotPayload = async () => {
    let snap;
    try {
      snap = await herdrSnapshot(D.herdrBin);
    } catch (e) {
      log(`herdr read failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const sig = JSON.stringify([snap?.workspaces, snap?.agents, snap?.focused_workspace_id]);
    const summary = summarize(snap);
    if (sig !== lastSig) {
      lastSig = sig;
      writeState(D.statePath, { lastPublish: { at: new Date().toISOString(), summary } });
    }
    return { op: "view", view: { v: 1, source: "herdr", takenAt: new Date().toISOString(), summary } };
  };

  const publish = async (ws) => {
    if (ws.readyState !== 1 || devices.length === 0) return;
    const payload = await snapshotPayload();
    if (!payload) return;
    for (const d of devices) ws.send(JSON.stringify({ v: 1, t: "frame", device: d.id, payload }));
  };

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    let helloed = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: token, info: { name: NAME, version: "0.1.0", capabilities: ["dev.herdgate.host", "read-only"] } }));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!helloed && m.t === "hello") {
        helloed = true;
        backoff = 1_000;
        devices = m.devices ?? [];
        log(`connected to ${url} (room ${m.roomId}, ${devices.length} device(s))`);
        void publish(ws);
        if (timer) clearInterval(timer);
        timer = setInterval(() => void publish(ws), 30_000);
        timer.unref?.();
        return;
      }
      if (m.t === "room.update") {
        devices = m.devices ?? [];
        void publish(ws);
        return;
      }
      if (m.t === "frame") {
        // A device asked for something. Read-only plugin: only `view` and `ping` exist.
        const op = m.payload && typeof m.payload === "object" ? m.payload.op : undefined;
        const replyTo = (payload) => ws.send(JSON.stringify({ v: 1, t: "frame", device: m.device, payload }));
        if (op === "ping") return replyTo({ op: "pong", n: m.payload.n ?? null, at: new Date().toISOString() });
        if (op === "view") {
          // Answer this device now, even if the view has not changed since the last push.
          lastSig = "";
          return void publish(ws);
        }
        replyTo({ op: "error", code: "read-only", message: `dev.herdgate.host has no op ${String(op)}` });
        return;
      }
      if (m.t === "pair.request") {
        // Read-only plugin: `act` is never granted.
        ws.send(JSON.stringify({ v: 1, t: "pair.response", requestId: m.requestId, ok: false }));
        return;
      }
      if (m.t === "ping") ws.send(JSON.stringify({ v: 1, t: "pong", n: m.n ?? 0 }));
    };
    ws.onclose = () => {
      if (timer) clearInterval(timer);
      timer = null;
      devices = [];
      const wait = Math.min(30_000, backoff) + Math.random() * 500;
      backoff *= 2;
      log(`disconnected; retrying in ${Math.round(wait)}ms`);
      setTimeout(connect, wait).unref?.();
    };
    ws.onerror = () => {}; // onclose carries the retry
  };
  connect();
  // Keep the child alive while the socket reconnects.
  setInterval(() => {}, 1 << 30);
}

/** --- stop: end the publisher. --- */
async function stop() {
  const pid = runningPid();
  if (!pid) {
    log("publisher is not running");
  } else {
    try {
      process.kill(pid, "SIGTERM");
      log(`stopped publisher (pid ${pid})`);
    } catch (e) {
      log(`could not stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (pidPath && existsSync(pidPath)) rmSync(pidPath, { force: true });
}

/** --- pane: the surface inside Herdr. Honest lines, refreshed on a light poll. --- */
async function pane() {
  const draw = async () => {
    const cfg = readConfig(D.configPath);
    const state = readState(D.statePath);
    const pid = runningPid();
    const lines = [];
    lines.push(`herdgate · ${NAME}`);
    lines.push(`cloud: ${cfg.HERDGATE_URL ?? "not configured"}`);
    lines.push(`pairing: ${cfg.HERDGATE_ROOM_TOKEN ? "paired" : "not paired"}`);
    lines.push(`publisher: ${pid ? `running (pid ${pid})` : "stopped"}`);
    if (state.lastPublish) {
      const s = state.lastPublish.summary;
      lines.push(`last publish: ${state.lastPublish.at}`);
      lines.push(`  herdr ${s.herdr} · ${s.workspaces} workspaces · ${s.agents} agents`);
    }
    try {
      const s = summarize(await herdrSnapshot(D.herdrBin));
      lines.push(`herdr now: ${s.workspaces} workspaces · ${s.agents} agents (${s.working} working, ${s.blocked} blocked)`);
    } catch (e) {
      lines.push(`herdr now: unreadable — ${e instanceof Error ? e.message : String(e)}`);
    }
    lines.push("");
    lines.push(cfg.HERDGATE_ROOM_TOKEN ? "press q to close" : "run the 'pair' action to publish this Herdr");
    return lines;
  };
  let closed = false;
  const paint = async () => {
    if (closed) return;
    const lines = await draw();
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
  };
  await paint();
  const iv = setInterval(() => void paint(), 10_000);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (b) => {
      const k = String(b);
      if (k === "q" || k === "\u0003") {
        closed = true;
        clearInterval(iv);
        process.stdin.setRawMode?.(false);
        process.exit(0);
      }
    });
  }
}

/** Dispatch — the manifest's commands map onto these. */
const commands = { pair, status, serve, stop, pane };
const cmd = process.argv[2] ?? "";
if (cmd === "" || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`herdgate ${D.pluginId} — plugin commands (Herdr launches these from herdr-plugin.toml)

  pair     pair this Herdr to a cloud (device flow), storing the room token in the config dir
  status   JSON: config, publisher pid, last publish, current Herdr summary
  serve    start the publisher once (the [[startup]] hook); exits after spawning it
  stop     stop the publisher
  pane     the split-pane surface (light 10s poll, q closes)`);
  process.exit(0);
}
try {
  const handler = commands[cmd];
  if (!handler) {
    console.error(`herdgate: unknown command "${cmd}"`);
    process.exit(2);
  }
  await handler();
} catch (e) {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
