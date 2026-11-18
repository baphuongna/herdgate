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
import { createSshBridge } from "./ssh.mjs";
import { HostChannel, b64d, b64e, fingerprint, generateKeyPair } from "./e2e.mjs";

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

  let wsRef = null;

  // ---- E2E payloads: the host speaks Noise_XX to every paired device ----
  // Handshake + transport live inside frame.payload; the cloud routes them blind.
  // A device that has not completed the handshake keeps working in the clear —
  // the plaintext path stays the compat fallback.
  const e2eKeyPath = D.stateDir ? join(D.stateDir, "e2e-host.json") : "";
  let e2eSelf = null;
  const e2eSelfKey = async () => {
    if (e2eSelf) return e2eSelf;
    try {
      const j = JSON.parse(readFileSync(e2eKeyPath, "utf8"));
      e2eSelf = { jwk: j.jwk, pub: b64d(j.pub) };
      return e2eSelf;
    } catch {
      /* mint a fresh identity below */
    }
    e2eSelf = await generateKeyPair();
    try {
      mkdirSync(dirname(e2eKeyPath), { recursive: true });
      writeFileSync(e2eKeyPath, JSON.stringify({ jwk: e2eSelf.jwk, pub: b64e(e2eSelf.pub) }), { mode: 0o600 });
    } catch (e) {
      log(`e2e: could not persist host key (${e instanceof Error ? e.message : String(e)})`);
    }
    return e2eSelf;
  };
  const e2eSessions = new Map(); // deviceId → HostChannel
  /** null = not an e2e payload; {reply} = handshake answer to send; {inner} = decrypted device payload. */
  const e2eOnDevice = async (device, payload) => {
    if (payload && typeof payload === "object" && typeof payload.op === "string" && payload.op.startsWith("e2e")) log(`e2e: op ${payload.op} from ${device}`);
    if (!payload || typeof payload !== "object") return null;
    if (payload.op === "e2e.init") {
      const ch = new HostChannel(await e2eSelfKey());
      e2eSessions.set(device, ch);
      return { reply: { op: "e2e.reply", ...(await ch.acceptInit(payload)) } };
    }
    if (payload.op === "e2e.finish") {
      const ch = e2eSessions.get(device);
      if (!ch) return { reply: { op: "error", code: "e2e", message: "no handshake in progress" } };
      await ch.acceptFinish(payload);
      log(`e2e: session up with ${device} (host fp ${fingerprint((await e2eSelfKey()).pub)})`);
      // The ack is the start signal: the device encrypts nothing before it, so no
      // transport frame can race the handshake's last step and desync the counters.
      return { reply: { op: "e2e.ready" } };
    }
    if (payload.op === "e2e") {
      const ch = e2eSessions.get(device);
      if (!ch?.ready()) return { reply: { op: "error", code: "e2e", message: "no session" } };
      try {
        return { inner: await ch.recv(payload) };
      } catch {
        // A decrypt failure means the counters can never resync: drop the session and
        // make the device renegotiate.
        e2eSessions.delete(device);
        log(`e2e: dropped session with ${device} (decrypt failed — renegotiate)`);
        return { reply: { op: "error", code: "e2e", message: "session dropped — renegotiate" } };
      }
    }
    return null;
  };
  /** Encrypt for this device when a session exists; passthrough otherwise. */
  const e2eToDevice = async (device, payload) => {
    const ch = e2eSessions.get(device);
    return ch?.ready() ? ch.send(payload) : payload;
  };

  const ssh = createSshBridge({
    send: (device, payload) => {
      void (async () => {
        if (wsRef && wsRef.readyState === 1) {
          wsRef.send(JSON.stringify({ v: 1, t: "frame", device, payload: await e2eToDevice(device, payload) }));
        }
      })();
    },
    scopeOf: (device) => devices.find((d) => d.id === device)?.scope ?? null,
    log,
  });
  const publish = async (ws) => {
    if (ws.readyState !== 1 || devices.length === 0) return;
    const payload = await snapshotPayload();
    if (!payload) return;
    for (const d of devices) {
      ws.send(JSON.stringify({ v: 1, t: "frame", device: d.id, payload: await e2eToDevice(d.id, payload) }));
    }
  };

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    wsRef = ws;
    let helloed = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: token, info: { name: NAME, version: "0.1.0", capabilities: ["dev.herdgate.host", "read-only"] } }));
    };
    ws.onmessage = (ev) => {
      void (async () => {
        try {
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
        // SSH-leg ops are the bridge's; e2e ops are the crypto bridge's; everything
        // else: only `view` and `ping` exist. Encrypted devices unwrap first.
        const rawOp = m.payload && typeof m.payload === "object" ? m.payload.op : undefined;
        if (typeof rawOp === "string" && rawOp.startsWith("ssh.")) {
          ssh.handle(m.device, m.payload);
          return;
        }
        const unwrapped = await e2eOnDevice(m.device, m.payload);
        if (unwrapped) {
          if (unwrapped.reply !== null && unwrapped.reply !== undefined) {
            ws.send(JSON.stringify({ v: 1, t: "frame", device: m.device, payload: unwrapped.reply }));
          }
          if (unwrapped.inner === undefined) return; // handshake bookkeeping
        }
        const payload = unwrapped?.inner ?? m.payload;
        const op = payload && typeof payload === "object" ? payload.op : undefined;
        const replyTo = async (out) => {
          ws.send(JSON.stringify({ v: 1, t: "frame", device: m.device, payload: await e2eToDevice(m.device, out) }));
        };
        if (op === "ping") return void replyTo({ op: "pong", n: payload.n ?? null, at: new Date().toISOString() });
        if (op === "view") {
          // Answer this device now, even if the view has not changed since the last push.
          lastSig = "";
          return void publish(ws);
        }
        return void replyTo({ op: "error", code: "read-only", message: `dev.herdgate.host has no op ${String(op)}` });
      }
      if (m.t === "pair.request") {
        // Read-only plugin: `act` is never granted.
        ws.send(JSON.stringify({ v: 1, t: "pair.response", requestId: m.requestId, ok: false }));
        return;
      }
      if (m.t === "ping") ws.send(JSON.stringify({ v: 1, t: "pong", n: m.n ?? 0 }));
      } catch (e) {
        log(`frame handler: ${e instanceof Error ? e.message : String(e)}`);
      }
      })().catch(() => {});
    };
    ws.onclose = () => {
      if (timer) clearInterval(timer);
      timer = null;
      ssh.closeAll();
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
