/**
 * herdgate plugin for Herdr — commands behind the manifest.
 *
 * The plugin calls Herdr through `HERDR_BIN_PATH` (the official CLI) and publishes the
 * resulting metadata to a herdgate cloud over one outbound WebSocket. Device
 * permissions are checked before dispatching any interactive bridge commands.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirs, readConfig, writeConfig, readState, writeState, herdrSnapshot, summarize, herdrPanes, herdrRead } from "./common.mjs";
import { createSshBridge } from "./ssh.mjs";
import { findBody, findReceipt, journalBase as receiptJournalBase, publicReceipt, watchReceipts } from "./pi-receipts.mjs";
import { searchReceipts, sessionRoots as piSessionRoots } from "./pi-receipt-search.mjs";
import { openWatchStore } from "./pi-receipt-watch.mjs";
import { JOB_ID, MAX_PENDING, MAX_PROMPT, WORKSPACE_NAME, appendJob, jobsFile, publicJob, queueDepth, readHeartbeat, readJobs, workerBase } from "./pi-worker.mjs";
import { registerPublisher } from "./publisher-tui-lifecycle.mjs";
import { HostChannel, b64d, b64e, fingerprint, generateKeyPair } from "./e2e.mjs";

const D = dirs();
const NAME = process.env.HERDGATE_HOST_NAME || hostname();
const log = (line) => console.error(`herdgate: ${line}`);
/** The panel's settings file (app home herdgate dir) — the owner's switches live
 *  there. HERDGATE_SETTINGS lets tests point somewhere else. */
const SETTINGS =
  process.env.HERDGATE_SETTINGS ?? join(homedir(), ".config", "herdr-app", "herdgate", "settings.json");

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
 * Reconnects with bounded backoff. The default transport uses Node's global
 * WebSocket, so a standalone `herdr plugin install` needs no node_modules.
 */
async function publisherLoop() {
  const cfg = readConfig(D.configPath);
  const url = cfg.HERDGATE_URL.replace(/\/$/, "");
  const wsUrl = url.replace(/^http/, "ws") + "/v1/agent/ws";
  let openSocket = () => new WebSocket(wsUrl);
  const loopbackPort = cfg.HERDGATE_AGENT_LOOPBACK_PORT;
  if (loopbackPort) {
    if (!/^[1-9]\d{0,4}$/.test(loopbackPort) || Number(loopbackPort) > 65_535) {
      throw new Error("HERDGATE_AGENT_LOOPBACK_PORT must be a port from 1 to 65535");
    }
    // Only for co-located publisher/gate deployments. Node's native WebSocket
    // won't set Host; use the gateway's existing ws dependency for this mode.
    const { default: LocalWebSocket } = await import("ws");
    const host = new URL(url).host;
    const endpoint = `ws://127.0.0.1:${loopbackPort}/v1/agent/ws`;
    openSocket = () => new LocalWebSocket(endpoint, {
      headers: { Host: host }, agent: false, handshakeTimeout: 5_000, perMessageDeflate: false,
    });
  }
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
    let changed = false;
    if (sig !== lastSig) {
      changed = true;
      lastSig = sig;
      writeState(D.statePath, { lastPublish: { at: new Date().toISOString(), summary } });
    }
    if (changed) wakeAway(true);
    return { op: "view", view: { v: 1, source: "herdr", takenAt: new Date().toISOString(), summary } };
  };

  let wsRef = null;

  // ---- E2E payloads: the host speaks Noise_XX to every paired device ----
  // Handshake + transport live inside frame.payload; the cloud routes them blind.
  // A device that has not completed the handshake keeps working in the clear —
  // the plaintext path stays the compat fallback.
  const e2eKeyPath = D.stateDir ? join(D.stateDir, "e2e-host.json") : "";
  let e2eIdentity;
  const e2eSelfKey = () => e2eIdentity ??= (async () => {
    try {
      const j = JSON.parse(readFileSync(e2eKeyPath, "utf8"));
      return { jwk: j.jwk, pub: b64d(j.pub) };
    } catch (e) {
      if (e.code !== "ENOENT") throw new Error("cannot load existing E2E host identity");
    }
    const key = await generateKeyPair();
    mkdirSync(dirname(e2eKeyPath), { recursive: true, mode: 0o700 });
    writeFileSync(e2eKeyPath, JSON.stringify({ jwk: key.jwk, pub: b64e(key.pub) }), { mode: 0o600, flag: "wx" });
    return key;
  })();
  const e2eSessions = new Map();
  const acceptingFinish = new WeakSet();
  /** Per-device last-call times for the subprocess-backed term.* ops (1/s each). */
  const termThrottle = new Map();
  /** null = not an e2e payload; {reply} = handshake answer to send; {inner} = decrypted device payload. */
  const e2eOnDevice = async (ws, device, payload) => {
    if (payload && typeof payload === "object" && typeof payload.op === "string" && payload.op.startsWith("e2e")) log(`e2e: op ${payload.op} from ${device}`);
    if (!payload || typeof payload !== "object") return null;
    if (payload.op === "e2e.init") {
      const prior = e2eSessions.get(device);
      if (prior?.ready()) log(`e2e: rotating session with ${device} (lifetime bound reached on the device)`);
      const ch = new HostChannel(await e2eSelfKey());
      if (wsRef !== ws || ws.readyState !== 1 || !devices.some(d => d.id === device)) return { reply: null };
      e2eSessions.set(device, ch);
      const reply = await ch.acceptInit(payload);
      return e2eSessions.get(device) === ch ? { reply: { op: "e2e.reply", ...reply } } : { reply: null };
    }
    if (payload.op === "e2e.finish") {
      const ch = e2eSessions.get(device);
      if (!ch || ch.ready() || acceptingFinish.has(ch)) return { reply: null };
      acceptingFinish.add(ch);
      try {
        const fp = await fingerprint((await e2eSelfKey()).pub);
        await ch.acceptFinish(payload);
        if (e2eSessions.get(device) === ch && wsRef === ws && ws.readyState === 1) {
          // Queue the ack before allowing the first ciphertext to be sent.
          ws.send(JSON.stringify({ v: 1, t: "frame", device, payload: { op: "e2e.ready" } }));
          log(`e2e: session up with ${device} (host fp ${fp})`);
        }
        return { reply: null };
      } finally { acceptingFinish.delete(ch); }
    }
    if (payload.op === "e2e") {
      const ch = e2eSessions.get(device);
      if (!ch?.ready()) return { reply: { op: "error", code: "e2e", message: "no session" } };
      try {
        return { inner: await ch.recv(payload) };
      } catch {
        // A decrypt failure means the counters can never resync: drop the session and
        // make the device renegotiate.
        if (e2eSessions.get(device) !== ch) return { reply: null };
        e2eSessions.delete(device);
        log(`e2e: dropped session with ${device} (decrypt failed — renegotiate)`);
        return { reply: { op: "error", code: "e2e", message: "session dropped — renegotiate" } };
      }
    }
    return null;
  };
  /** Encrypt for this device when a session exists; passthrough for legacy clients. */
  const sendPayload = async (ws, device, payload) => {
    if (wsRef !== ws || ws.readyState !== 1 || !devices.some(d => d.id === device)) return;
    const ch = e2eSessions.get(device);
    if (acceptingFinish.has(ch)) return;
    const wire = ch?.ready() ? await ch.send(payload) : payload;
    if (wsRef === ws && ws.readyState === 1 && e2eSessions.get(device) === ch) {
      ws.send(JSON.stringify({ v: 1, t: "frame", device, payload: wire }));
    }
  };

  const ssh = createSshBridge({
    session: cfg.HERDGATE_HERDR_SESSION || undefined,
    tuiOnly: process.env.HERDGATE_TUI_ONLY === "1",
    mobileHcBin: process.env.HERDGATE_MOBILE_HC_BIN || null,
    mobileTuiAdapter: process.env.HERDGATE_MOBILE_TUI_DEVICE ? {
      device: process.env.HERDGATE_MOBILE_TUI_DEVICE,
      scope: process.env.HERDGATE_MOBILE_TUI_SCOPE === "act" ? "act" : "read",
      script: fileURLToPath(new URL("./mobile-tui-core.mjs", import.meta.url)),
    } : null,
    send: (device, payload) => {
      // sshd is the SSH endpoint; a concurrent PWA session must not seal these frames.
      if (wsRef?.readyState === 1) wsRef.send(JSON.stringify({ v: 1, t: "frame", device, payload }));
    },
    scopeOf: (device) => devices.find((d) => d.id === device)?.scope ?? null,
    log,
  });
  const publish = async (ws) => {
    if (ws.readyState !== 1 || devices.length === 0) return;
    const payload = await snapshotPayload();
    if (!payload) return;
    for (const d of devices) {
      await sendPayload(ws, d.id, payload);
    }
  };

  /** Push receipt settles only to devices that registered a durable watch for
   *  that request (Paseo-style finish subscriptions): delivery targets the
   *  subscriber, survives publisher restarts, and only an ack retires the
   *  intent. No broadcast to the whole room. */
  let receiptWatch = null;
  let watchStore = null;
  const receiptsEnabled = () => process.env.HERDGATE_PI_RECEIPTS === "1";
  const receiptBodyEnabled = () => receiptsEnabled() && process.env.HERDGATE_PI_RECEIPT_BODY === "1";
  const watches = () => {
    if (!receiptsEnabled()) return null;
    watchStore ??= openWatchStore(receiptJournalBase());
    return watchStore;
  };
  const pushReceiptTo = (device, entry) => {
    const body = receiptBodyEnabled() && entry.status === "replied" ? findBody(receiptJournalBase(), entry.id) : null;
    log(`receipts: pushed ${entry.status} ${entry.id} -> ${device}${body ? " (+body)" : ""}`);
    void sendPayload(wsRef, device, { op: "receipt.push", hasBody: Boolean(body), ...publicReceipt(entry) });
  };
  const flushWatches = (device) => {
    const store = watches();
    if (!store) return;
    store.sweep();
    let replayed = 0;
    for (const sub of store.pendingFor(device)) {
      const entry = findReceipt(receiptJournalBase(), sub.requestId);
      if (!entry) continue; // not settled yet; the watcher routes the settle
      store.markDelivered(device, sub.requestId);
      pushReceiptTo(device, entry);
      replayed++;
    }
    if (replayed) log(`receipts: replayed ${replayed} unacknowledged push(es) to ${device}`);
  };
  const pushReceipt = (entry) => {
    const store = watches();
    if (!store) return;
    store.sweep();
    const targets = store.pendingAll().filter(sub => sub.requestId === entry.id);
    if (!targets.length) return log(`receipts: settled ${entry.status} ${entry.id} (no subscriber)`);
    for (const sub of targets) {
      store.markDelivered(sub.device, entry.id);
      pushReceiptTo(sub.device, entry);
      // A phone with the app closed misses the frame; the wake push brings it
      // back so flushWatches can replay the settle (throttled per device).
      const known = devices.find(d => d.id === sub.device);
      if (known && known.connected !== false) continue;
      log(`receipts: wake ${sub.device} (settle while offline)`);
      wakeAway(true);
    }
  };

  /** Wake phones that are away when something actually changed (throttled per device). */
  const lastWake = new Map(); // deviceId → epoch ms
  const wakeAway = (changed) => {
    if (!changed) return;
    const now = Date.now();
    for (const d of devices) {
      if (d.connected !== false) continue;
      const at = lastWake.get(d.id) ?? 0;
      if (now - at < 5 * 60_000) continue;
      lastWake.set(d.id, now);
      if (wsRef && wsRef.readyState === 1) wsRef.send(JSON.stringify({ v: 1, t: "wake", device: d.id }));
    }
  };

  const shutdown = () => {
    ssh.closeAll();
    if (wsRef?.readyState === 1) wsRef.close();
    process.exit(0);
  };
  const tuiOnly = process.env.HERDGATE_TUI_ONLY === "1";
  const lifecycle = tuiOnly && process.env.HERDGATE_TUI_RUN_ID
    ? registerPublisher(D.stateDir, process.env.HERDGATE_TUI_RUN_ID, shutdown)
    : null;

  const connect = () => {
    const ws = openSocket();
    wsRef = ws;
    let helloed = false;
    ws.onopen = () => {
      // Advertise honestly: `act` only when the owner's switch allows it.
      let allowAct = false;
      try { allowAct = (JSON.parse(readFileSync(SETTINGS, "utf8")) ?? {}).allowAct === true; } catch { /* no settings yet */ }
      ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: token, info: { name: NAME, version: "0.1.0", capabilities: ["dev.herdgate.host", allowAct ? "act" : "read-only"] } }));
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
        lifecycle?.setConnected(true);
        log(`connected to ${url}${loopbackPort ? ` via loopback 127.0.0.1:${loopbackPort}` : ""} (room ${m.roomId}, ${devices.length} device(s))`);
        if (process.env.HERDGATE_PI_RECEIPTS === "1" && !receiptWatch) {
          receiptWatch = watchReceipts(receiptJournalBase(), pushReceipt);
          log(`receipts: journal push enabled (${receiptJournalBase()})`);
        }
        for (const d of devices) flushWatches(d.id);
        void publish(ws);
        if (timer) clearInterval(timer);
        timer = setInterval(() => void publish(ws), 30_000);
        timer.unref?.();
        return;
      }
      if (m.t === "room.update") {
        const next = m.devices ?? [];
        for (const d of devices) if (!next.some((n) => n.id === d.id && n.scope === d.scope)) {
          ssh.dropDevice(d.id);
          e2eSessions.delete(d.id);
        }
        devices = next;
        for (const d of devices) flushWatches(d.id);
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
        const unwrapped = await e2eOnDevice(ws, m.device, m.payload);
        if (unwrapped) {
          if (unwrapped.reply !== null && unwrapped.reply !== undefined) {
            ws.send(JSON.stringify({ v: 1, t: "frame", device: m.device, payload: unwrapped.reply }));
          }
          if (unwrapped.inner === undefined) return; // handshake bookkeeping
        }
        const payload = unwrapped?.inner ?? m.payload;
        const op = payload && typeof payload === "object" ? payload.op : undefined;
        const replyTo = (out) => sendPayload(ws, m.device, out).catch(e => log(`payload send failed: ${e.message}`));
        if (op === "ping") return void replyTo({ op: "pong", n: payload.n ?? null, at: new Date().toISOString() });
        if (op === "receipt.get") {
          // Experimental (opt-in HERDGATE_PI_RECEIPTS=1): answer from the local Pi
          // receipt journal written by the experiments/pi-receipt observer.
          // Metadata only — the observer itself never opens a socket.
          const id = typeof payload.id === "string" ? payload.id : "";
          const enabled = process.env.HERDGATE_PI_RECEIPTS === "1";
          const entry = enabled ? findReceipt(receiptJournalBase(), id) : null;
          log(`receipts: ${m.device} queried ${id || "?"} -> ${entry ? entry.status : "unknown"}`);
          return void replyTo({ op: "receipt.result", id: id || null,
            ...publicReceipt(entry), ...(enabled ? {} : { reason: "pi_receipts_disabled" }) });
        }
        if (op === "receipt.search") {
          // Experimental (opt-in HERDGATE_PI_RECEIPTS=1): BM25 keyword search over
          // the journal; bodies and transcripts score host-side only. Hits are
          // publicReceipt-shaped (id, score, status, reason, usage) — no snippet,
          // no sessionId, no session file, no timestamps. Search finds ids; the
          // gated receipt.body op serves any text.
          const enabled = process.env.HERDGATE_PI_RECEIPTS === "1";
          const query = typeof payload.query === "string" ? payload.query.slice(0, 200) : "";
          const limit = Number(payload.limit);
          const hits = enabled && query.trim()
            ? searchReceipts({ base: receiptJournalBase(), sessionsRoot: piSessionRoots(), query,
                limit: Number.isFinite(limit) ? limit : 10, all: payload.all === true })
            : [];
          log(`receipts: ${m.device} search ${JSON.stringify(query)} -> ${hits.length} hit(s)`);
          return void replyTo({ op: "receipt.search.result",
            ...(enabled ? { hits } : { hits: [], reason: "pi_receipts_disabled" }) });
        }
        if (op === "receipt.watch" || op === "receipt.ack") {
          // Experimental (opt-in HERDGATE_PI_RECEIPTS=1): durable per-request push
          // subscriptions. Registering targets receipt.push at this device only;
          // an ack retires the intent after the controller has handled the report.
          const id = typeof payload.id === "string" && JOB_ID.test(payload.id) ? payload.id : "";
          if (!receiptsEnabled()) return void replyTo({ op: "receipt.watched", id: id || null, status: "unknown", reason: "pi_receipts_disabled" });
          if (!id) return void replyTo({ op: "error", code: "receipt.watch", message: "invalid request id" });
          const store = watches();
          if (op === "receipt.ack") {
            const retired = Boolean(store?.ack(m.device, id));
            log(`receipts: ack ${id} from ${m.device} -> ${retired ? "retired" : "no pending intent"}`);
            return void replyTo({ op: "receipt.acked", id, retired });
          }
          let subscription;
          try {
            subscription = store.register({ device: m.device, requestId: id, wantBody: payload.wantBody === true,
              ...(Number.isFinite(payload.ttlMs) && payload.ttlMs > 0 ? { ttlMs: Math.min(payload.ttlMs, 24 * 60 * 60 * 1000) } : {}) });
          } catch (error) {
            return void replyTo({ op: "error", code: "receipt.watch", message: error.message });
          }
          const entry = findReceipt(receiptJournalBase(), id);
          log(`receipts: ${m.device} watches ${id}${subscription.wantBody ? " (+body)" : ""} -> ${entry ? entry.status : "pending"}`);
          return void replyTo({ op: "receipt.watched", id, ...(entry ? publicReceipt(entry) : { pending: true }) });
        }
        if (op === "worker.health") {
          // Experimental (opt-in HERDGATE_PI_WORKER=1): liveness for the owner — queue
          // depth plus the last heartbeat written by the scheduler/worker experiment.
          // Metadata only; read scope is enough; missing heartbeat is reported as null.
          const enabled = process.env.HERDGATE_PI_WORKER === "1";
          let queued = null;
          let running = null;
          let beat = null;
          if (enabled) {
            try { const depth = queueDepth(readJobs(jobsFile(workerBase()))); queued = depth.queued; running = depth.running; }
            catch { /* unreadable queue -> null, fail closed */ }
            beat = readHeartbeat(workerBase());
          }
          const age = beat ? Math.max(0, Math.round((Date.now() - beat.ts) / 1000)) : null;
          log(`worker: ${m.device} health -> queued ${queued ?? "?"} running ${running ?? "?"} heartbeat ${beat ? `${age}s ago` : "none"}`);
          return void replyTo({ op: "worker.health.result", enabled,
            ...(enabled
              ? { queued, running, heartbeat: beat ? { ts: beat.ts, source: beat.source, ageSeconds: age } : null }
              : { reason: "pi_worker_disabled" }) });
        }
        if (op === "receipt.body") {
          // Experimental: serving archived replies is separate from metadata push.
          const id = typeof payload.id === "string" && JOB_ID.test(payload.id) ? payload.id : "";
          const base = receiptJournalBase();
          const body = receiptBodyEnabled() && id && findReceipt(base, id)?.status === 'replied' ? findBody(base, id) : null;
          log(`receipts: ${m.device} body ${id || "?"} -> ${body ? `${body.bytes}B${body.truncated ? " (capped)" : ""}` : "none"}`);
          return void replyTo({ op: "receipt.body.result", id: id || null,
            ...(body
              ? { text: body.text, bytes: body.bytes, truncated: body.truncated }
              : { reason: receiptBodyEnabled() ? "body_not_retained"
                : process.env.HERDGATE_PI_RECEIPTS === "1" ? "pi_receipt_body_disabled" : "pi_receipts_disabled" }) });
        }
        if (op === "worker.submit" || op === "worker.status") {
          // Experimental (opt-in HERDGATE_PI_WORKER=1): admission to the local Pi worker
          // queue (plugin/server/pi-worker.mjs). The publisher never runs Pi itself — a
          // separately started experiments/pi-worker drains the queue and journals receipts.
          // worker.submit carries a prompt, so it is a control operation (act scope only).
          const enabled = process.env.HERDGATE_PI_WORKER === "1";
          const file = jobsFile(workerBase());
          const id = typeof payload.id === "string" && JOB_ID.test(payload.id) ? payload.id : "";
          if (op === "worker.status") {
            let job = null;
            if (enabled && id) {
              try { job = readJobs(file).get(id) ?? null; } catch { job = null; }
            }
            log(`worker: ${m.device} status ${id || "?"} -> ${job ? job.state : "unknown"}`);
            return void replyTo({ op: "worker.status.result", id: id || null, ...publicJob(job),
              ...(enabled ? {} : { reason: "pi_worker_disabled" }) });
          }
          if (!enabled) {
            return void replyTo({ op: "error", code: "pi_worker_disabled", message: "the Pi worker queue is not enabled on this host" });
          }
          if (devices.find(d => d.id === m.device)?.scope !== "act") {
            return void replyTo({ op: "error", code: "requires-act", message: "worker.submit needs an act device" });
          }
          const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
          if (!prompt.trim() || prompt.length > MAX_PROMPT) {
            return void replyTo({ op: "error", code: "bad-prompt", message: `worker.submit needs a prompt of 1..${MAX_PROMPT} chars` });
          }
          // Optional routing key: a NAME from the host's workspaces.json allowlist —
          // never a raw path. Unknown names fail closed on the worker side.
          const workspaceName = payload.workspace;
          if (workspaceName !== undefined && (typeof workspaceName !== "string" || !WORKSPACE_NAME.test(workspaceName))) {
            return void replyTo({ op: "error", code: "bad-workspace", message: "worker.submit workspace must be a short lowercase name" });
          }
          let jobs;
          try { jobs = readJobs(file); }
          catch (e) {
            return void replyTo({ op: "error", code: "worker-queue", message: `queue unreadable: ${e instanceof Error ? e.message : String(e)}` });
          }
          const existing = id ? jobs.get(id) : undefined;
          const settled = !existing && id ? findReceipt(receiptJournalBase(), id) : null;
          if (existing || settled) {
            const state = existing ? existing.state : String(settled?.status);
            log(`worker: ${m.device} resubmitted ${id} -> ${state} (duplicate)`);
            return void replyTo({ op: "worker.submitted", id, state, duplicate: true });
          }
          const pending = [...jobs.values()].filter(j => j.state === "queued" || j.state === "running").length;
          if (pending >= MAX_PENDING) {
            return void replyTo({ op: "error", code: "queue-full", message: `worker queue is full (${MAX_PENDING} pending)` });
          }
          const jobId = id || randomUUID();
          try { appendJob(file, { v: 1, id: jobId, prompt, ts: Date.now(), state: "queued", principal: `device:${m.device}`,
            ...(workspaceName !== undefined ? { workspace: workspaceName } : {}) }); }
          catch (e) {
            return void replyTo({ op: "error", code: "worker-queue", message: `queue append failed: ${e instanceof Error ? e.message : String(e)}` });
          }
          log(`worker: ${m.device} submitted ${jobId} (${prompt.length} chars${workspaceName ? `, ws ${workspaceName}` : ""})`);
          return void replyTo({ op: "worker.submitted", id: jobId, state: "queued", duplicate: false });
        }
        if (op === "view") {
          // Answer this device now, even if the view has not changed since the last push.
          lastSig = "";
          return void publish(ws);
        }
        // Live terminal access, read-only: the panes list and one pane's ANSI screen.
        // Subprocess-backed, so both ops are throttled per device (a phone's poll must
        // not fork `herdr` in a tight loop) and the target string is whitelisted hard.
        if (op === "term.list") {
          const now = Date.now();
          const last = termThrottle.get(`list:${m.device}`) ?? 0;
          if (now - last < 1_000) return void replyTo({ op: "error", code: "busy", message: "term.list is throttled (1/s)" });
          termThrottle.set(`list:${m.device}`, now);
          try {
            const panes = await herdrPanes(D.herdrBin);
            return void replyTo({ op: "term.list", panes });
          } catch (e) {
            return void replyTo({ op: "error", code: "herdr", message: `pane list failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        if (op === "term.read") {
          const target = typeof payload.target === "string" ? payload.target : "";
          const lines = Math.max(10, Math.min(120, Number(payload.lines) || 40));
          if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(target)) {
            return void replyTo({ op: "error", code: "bad-target", message: "term.read needs a pane id" });
          }
          const now = Date.now();
          const last = termThrottle.get(`read:${m.device}`) ?? 0;
          if (now - last < 1_000) return void replyTo({ op: "error", code: "busy", message: "term.read is throttled (1/s)" });
          termThrottle.set(`read:${m.device}`, now);
          try {
            const ansi = await herdrRead(D.herdrBin, target, lines);
            return void replyTo({ op: "term.read", target, ansi });
          } catch (e) {
            return void replyTo({ op: "error", code: "herdr", message: `read failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        return void replyTo({ op: "error", code: "read-only", message: `dev.herdgate.host has no op ${String(op)}` });
      }
      if (m.t === "pair.request") {
        // `act` (control) is the owner's call, made ON THIS MACHINE: the settings'
        // allowAct switch. Read fresh — the panel can flip it while we run.
        let allow = false;
        try { allow = (JSON.parse(readFileSync(SETTINGS, "utf8")) ?? {}).allowAct === true; } catch { /* not configured */ }
        const ok = allow && m.scope === "act";
        log(`pair request from ${m.device?.name ?? "?"} for ${m.scope}: ${ok ? "approved (allowAct)" : "denied"}`);
        ws.send(JSON.stringify({ v: 1, t: "pair.response", requestId: m.requestId, ok }));
        return;
      }
      if (m.t === "ping") ws.send(JSON.stringify({ v: 1, t: "pong", n: m.n ?? 0 }));
      } catch (e) {
        log(`frame handler: ${e instanceof Error ? e.message : String(e)}`);
      }
      })().catch(() => {});
    };
    // One retry per socket: an error while still CONNECTING (e.g. the cloud is
    // restarting and refuses) never produces a close event on this WebSocket
    // implementation — waiting for onclose alone stalled the publisher forever.
    let retried = false;
    const retry = (why) => {
      if (retried) return;
      retried = true;
      lifecycle?.setConnected(false);
      if (timer) clearInterval(timer);
      timer = null;
      ssh.closeAll();
      e2eSessions.clear();
      devices = [];
      const wait = Math.min(30_000, backoff) + Math.random() * 500;
      backoff *= 2;
      log(`${why}; retrying in ${Math.round(wait)}ms`);
      setTimeout(connect, wait).unref?.();
    };
    ws.onclose = () => retry("disconnected");
    ws.onerror = () => retry("ws error");
  };
  if (tuiOnly) for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
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
