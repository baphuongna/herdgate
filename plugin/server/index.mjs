/**
 * herdgate plugin for Herdr — commands behind the manifest.
 *
 * The plugin calls Herdr through `HERDR_BIN_PATH` (the official CLI) and publishes the
 * resulting metadata to a herdgate cloud over one outbound WebSocket. Device
 * permissions are checked before dispatching any interactive bridge commands.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, realpathSync, renameSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirs, readConfig, writeConfig, readState, writeState, herdrSnapshot, summarize, herdrPanes, herdrRead, pkgVersion, nextPublishDelay, withTimeout } from "./common.mjs";
import { gitRead, diffRepoDir } from "./git-safe.mjs";
import { createSshBridge } from "./ssh.mjs";
import { findBody, findReceipt, journalBase as receiptJournalBase, publicReceipt, watchReceipts } from "./pi-receipts.mjs";
import { listAttachments, saveAttachment } from "./attachments.mjs";
import { searchReceipts, sessionRoots as piSessionRoots, findSessionFile } from "./pi-receipt-search.mjs";
import { usageRollup } from "./pi-usage.mjs";
import { readAllSpawns } from "./pi-wake.mjs";
import { sysSnapshot } from "./sysmon.mjs";
import { attributePorts } from "./port-attr.mjs";
import { parsePiTranscript } from "./pi-transcript.mjs";
import { openWatchStore } from "./pi-receipt-watch.mjs";
import { JOB_ID, MAX_PENDING, MAX_PROMPT, WORKSPACE_NAME, appendJob, jobsFile, publicJob, queueDepth, readHeartbeat, readJobs, workerBase } from "./pi-worker.mjs";
import { registerPublisher } from "./publisher-tui-lifecycle.mjs";
import { HostChannel, b64d, b64e, fingerprint, generateKeyPair } from "./e2e.mjs";

const D = dirs();
const execFile = promisify(execFileCb);
const run = execFile; // term.send/term.keys: argv arrays, never a shell
/** diff.get ships at most 128 KiB of `git show` output, marked truncated beyond. */
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_PANES = 200; // pane-carrying replies (term.list, fleet.detail) — a tab storm must not push the reply past the gate's 256KiB frame cap
const MAX_ATTACHMENTS = 200; // attachment.list reply cap — attachments accumulate monthly; the newest 200 are a screen's worth
const MAX_FILE_ENTRIES = 5000; // file.tree cap — the fuzzy finder ranks within this
const MAX_FILE_BYTES = 128 * 1024; // file.read cap — same class as diffs, and well under the gate's 256KiB frame limit
const MAX_REVIEW_FILES = 5000; // review.files entries cap (one screen's worth of scrolling)
const MAX_REVIEW_COMMENTS = 50; // review.send comments per batch — a review, not a prompt
const MAX_LOOP_LOG_TAIL = 20; // loop.status log tail — a screenful of loop decisions, bounded by construction
const MAX_LOOP_LOG_LINE = 200; // one loop.log line, cut not dropped — the whole reply stays ≈4KiB, far under the frame cap
const NAME = process.env.HERDGATE_HOST_NAME || hostname();
const log = (line) => console.error(`herdgate: ${line}`);
/** The panel's settings file (app home herdgate dir) — the owner's switches live
 *  there. HERDGATE_SETTINGS lets tests point somewhere else. */
const SETTINGS =
  process.env.HERDGATE_SETTINGS ?? join(homedir(), ".config", "herdr-app", "herdgate", "settings.json");

/** The publisher runs as a detached child of `serve`, recording its pid in state.
 *  A supervisor process (C7) keeps that lineage alive: respawn on death, honest
 *  stop via a marker file. Hosts under systemd pass HERDGATE_PUBLISHER_CHILD=1
 *  themselves and never meet the supervisor. */
const pidPath = D.stateDir ? join(D.stateDir, "publisher.pid") : "";
const supervisorPidPath = D.stateDir ? join(D.stateDir, "publisher.supervisor.pid") : "";
const stopMarkerPath = D.stateDir ? join(D.stateDir, "publisher.stop") : "";
const publisherLogPath = D.stateDir ? join(D.stateDir, "publisher.log") : "";
/** Crash evidence stays bounded: rotate the log above this size at serve time. */
const PUBLISHER_LOG_MAX_BYTES = 512 * 1024;

const delayMs = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readPidFile(path) {
  if (!path || !existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return pid && pidAlive(pid) ? pid : null;
}

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
    publisher: { pid: runningPid() ?? null, running: Boolean(runningPid()), supervised: Boolean(runningSupervisorPid()) },
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
  return readPidFile(pidPath);
}

function runningSupervisorPid() {
  return readPidFile(supervisorPidPath);
}

/** Open (rotating) the publisher crash log. The supervisor and every publisher
 *  it spawns share this fd — a dying publisher finally leaves a stack trace. */
function openPublisherLog() {
  try {
    if (existsSync(publisherLogPath) && statSync(publisherLogPath).size > PUBLISHER_LOG_MAX_BYTES) {
      rmSync(`${publisherLogPath}.old`, { force: true });
      renameSync(publisherLogPath, `${publisherLogPath}.old`);
    }
  } catch { /* rotation is best effort */ }
  return openSync(publisherLogPath, "a", 0o600);
}

/** --- Wave 2 observer wiring: sysmon / port-attr / pi-transcript behind ops --- */

/** Raw `herdr pane list` rows, every field kept. common.mjs's herdrPanes is the
 *  PWA picker view and drops fields on purpose; the observers need `pid`, which
 *  a Herdr build may or may not expose — "no pid column" must stay
 *  distinguishable from "no live children". Returns null when the CLI fails. */
async function paneRowsWithPids() {
  try {
    const { stdout } = await execFile(D.herdrBin, ["pane", "list"], { timeout: 8_000, maxBuffer: 8 << 20 });
    const parsed = JSON.parse(stdout);
    const panes = parsed?.result?.panes ?? parsed?.panes ?? [];
    return Array.isArray(panes) ? panes.filter((p) => p && typeof p.pane_id === "string") : [];
  } catch {
    return null;
  }
}

/** Every spawn-registry record across scopes; unreadable registry → [] (the
 *  observers fail closed, they never take the host down). */
function spawnRecords() {
  try {
    return readAllSpawns(receiptJournalBase());
  } catch {
    return [];
  }
}

/** Live spawn children joined with their pane rows: one row per live child,
 *  newest record per id. The registry stores pane ids, never pids — a pid
 *  exists only when this Herdr's pane list carries one. */
function liveSpawnChildren(panes) {
  const byId = new Map();
  for (const record of spawnRecords()) {
    const prior = byId.get(record.id);
    if (!prior || (record.ts ?? 0) >= (prior.ts ?? 0)) byId.set(record.id, record);
  }
  const byPane = new Map(panes.map((p) => [p.pane_id, p]));
  const rows = [];
  for (const record of byId.values()) {
    const pane = record.paneId ? byPane.get(record.paneId) : undefined;
    if (!pane) continue; // pane gone → child not live
    const pid = Number(pane.pid);
    rows.push({ key: record.name, paneId: record.paneId, pid: Number.isInteger(pid) && pid > 0 ? pid : null });
  }
  return rows;
}

/** The transcript behind one receipt: the spawn record's own sessionFile when
 *  it exists (records may predate the field), else Pi's standard session roots.
 *  Returns null when nothing is found — the caller answers a clear error op. */
function transcriptFor(entry) {
  const record = spawnRecords()
    .filter((s) => s.sessionId === entry.sessionId && typeof s.sessionFile === "string")
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
  if (record && existsSync(record.sessionFile)) return record.sessionFile;
  return findSessionFile(piSessionRoots(), entry.sessionId);
}

/** Which Herdr argv focuses a pane — probed once from --help (pane focus, else the
 *  tab equivalent), null when this Herdr supports neither. Never throws. */
let paneFocusArgv;
async function paneFocusArgvProbe() {
  if (paneFocusArgv !== undefined) return paneFocusArgv;
  const help = async (...args) => {
    try {
      const { stdout } = await execFile(D.herdrBin, args, { timeout: 5_000 });
      return stdout;
    } catch {
      return "";
    }
  };
  if (/\bfocus\b/.test(await help("pane", "--help"))) return (paneFocusArgv = ["pane", "focus"]);
  const tabHelp = await help("tab", "--help");
  if (/\bfocus\b/.test(tabHelp)) return (paneFocusArgv = ["tab", "focus"]);
  if (/\bselect\b/.test(tabHelp)) return (paneFocusArgv = ["tab", "select"]);
  return (paneFocusArgv = null);
}

/** --- serve: the startup hook. Spawn the supervisor, then exit (Herdr's hook is one-shot).
 *  The supervisor owns the publisher lineage from here on — see supervisorLoop. --- */
async function serve() {
  if (process.env.HERDGATE_PUBLISHER_CHILD === "1") return publisherLoop(); // the publisher itself
  if (process.env.HERDGATE_PUBLISHER_SUPERVISOR === "1") return supervisorLoop(); // its babysitter
  const sup = runningSupervisorPid();
  if (sup) {
    log(`publisher supervisor already running (pid ${sup}); nothing to do`);
    return;
  }
  const cfg = readConfig(D.configPath);
  if (!cfg.HERDGATE_URL || !cfg.HERDGATE_ROOM_TOKEN) {
    // Not paired yet: the startup hook must not fail the server.
    log("not paired — run the 'pair' action to publish this Herdr");
    return;
  }
  mkdirSync(D.stateDir, { recursive: true });
  const logFd = openPublisherLog();
  let child;
  try {
    child = spawn(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, "serve"], {
      env: { ...process.env, HERDGATE_PUBLISHER_SUPERVISOR: "1" },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd); // the supervisor inherits the fd, serve does not need it
  }
  child.unref();
  if (supervisorPidPath) writeFileSync(supervisorPidPath, String(child.pid));
  log(`publisher supervisor started (pid ${child.pid}); crash log at ${publisherLogPath}`);
}

/** --- supervisorLoop: keep exactly one publisher alive, or die trying.
 *  A deliberate poller — no sockets, no handles into the child: it watches the
 *  pidfile, so it adopts a publisher an older version started just as easily
 *  as one it spawned itself (SIGKILL and OOM deaths included). Env knobs follow
 *  the PUBLISH_MS pattern so tests can shrink every deadline. --- */
async function supervisorLoop() {
  const int = (name, dflt, min) => Math.max(min, Number.parseInt(process.env[name] ?? String(dflt), 10) || dflt);
  const POLL_MS = int("HERDGATE_WATCHDOG_POLL_MS", 1_000, 100);
  const MAX_DEATHS = int("HERDGATE_WATCHDOG_MAX", 5, 1);
  const WINDOW_MS = int("HERDGATE_WATCHDOG_WINDOW_MS", 600_000, 5_000);
  const BACKOFF_BASE_MS = int("HERDGATE_WATCHDOG_BACKOFF_BASE_MS", 1_000, 50);
  const BACKOFF_MAX_MS = 60_000;
  const STABLE_MS = 60_000; // a child that lived this long resets the backoff ladder
  const slog = (line) => console.error(`herdgate supervisor: ${new Date().toISOString()} ${line}`);
  const cfg = readConfig(D.configPath);
  if (!cfg.HERDGATE_URL || !cfg.HERDGATE_ROOM_TOKEN) {
    slog("not paired — exiting");
    return;
  }
  const deaths = []; // epoch ms of publisher deaths inside the budget window
  let consecutive = 0; // quick deaths in a row → exponential backoff
  let bornAt = 0;
  const cleanFiles = () => {
    if (stopMarkerPath) rmSync(stopMarkerPath, { force: true });
    if (pidPath) rmSync(pidPath, { force: true });
    if (supervisorPidPath) rmSync(supervisorPidPath, { force: true });
  };
  slog(`watching (poll ${POLL_MS}ms, budget ${MAX_DEATHS}/${Math.round(WINDOW_MS / 1000)}s)`);
  for (;;) {
    await delayMs(POLL_MS);
    if (existsSync(stopMarkerPath)) {
      slog("stop requested");
      const pid = readPidFile(pidPath);
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        for (let i = 0; i < 40 && pidAlive(pid); i++) await delayMs(125);
        if (pidAlive(pid)) {
          slog(`publisher pid ${pid} ignored SIGTERM for 5s; killing`);
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }
      }
      cleanFiles();
      slog("stopped");
      return;
    }
    const pid = readPidFile(pidPath);
    if (pid) continue; // alive — adopted or ours, same lineage
    const hadOne = Boolean(pidPath && existsSync(pidPath)) || bornAt > 0; // a death, not a first boot
    if (hadOne) {
      const now = Date.now();
      if (bornAt && now - bornAt >= STABLE_MS) consecutive = 0; // it had a good life
      while (deaths.length && now - deaths[0] > WINDOW_MS) deaths.shift();
      if (deaths.length >= MAX_DEATHS) {
        slog(`giving up — ${deaths.length} crashes within ${Math.round(WINDOW_MS / 1000)}s; run the 'serve' action to try again`);
        cleanFiles();
        process.exitCode = 1;
        return;
      }
      deaths.push(now);
      consecutive += 1;
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (consecutive - 1), BACKOFF_MAX_MS);
      slog(`publisher died; respawn ${deaths.length}/${MAX_DEATHS} in ${backoff}ms`);
      await delayMs(backoff);
      if (existsSync(stopMarkerPath)) continue; // stop raced in during the backoff
    } else {
      slog("starting publisher");
    }
    const env = { ...process.env, HERDGATE_PUBLISHER_CHILD: "1" };
    delete env.HERDGATE_PUBLISHER_SUPERVISOR;
    const child = spawn(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, "serve"], {
      env,
      detached: true,
      stdio: "inherit", // → publisher.log, via the fd serve handed down
    });
    child.unref();
    // An 'exit' listener keeps libuv reaping this child — without it a SIGKILLed
    // publisher lingers as a zombie, and kill(pid, 0) still answers, so the
    // poller below would forever think a dead publisher is alive.
    child.once("exit", (code, signal) => slog(`publisher pid ${child.pid} exited (${signal ?? `code ${code}`})`));
    child.once("error", (e) => slog(`spawn failed: ${e instanceof Error ? e.message : String(e)}`));
    if (!child.pid) {
      slog("spawn returned no pid; exiting");
      cleanFiles();
      process.exitCode = 1;
      return;
    }
    bornAt = Date.now();
    if (pidPath) {
      mkdirSync(dirname(pidPath), { recursive: true });
      writeFileSync(pidPath, String(child.pid));
    }
    slog(`publisher started (pid ${child.pid})`);
  }
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
  // Push cadence and view-request freshness. The 30s default is gentle on a
  // battery-powered host; a plugged-in one sets HERDGATE_PUBLISH_MS=5000 so a
  // phone sees a settle within seconds instead of half a minute. A `view` op
  // inside the freshness window replays the last snapshot instead of spawning
  // `herdr api snapshot` again (bimodal view latency: 4ms cached vs 150ms cold).
  const PUBLISH_MS = Math.max(2_000, Number.parseInt(process.env.HERDGATE_PUBLISH_MS ?? "30000", 10) || 30000);
  const PUBLISH_MAX_MS = Math.max(PUBLISH_MS, Number.parseInt(process.env.HERDGATE_PUBLISH_MAX_MS ?? "60000", 10) || 60000);
  const SNAPSHOT_FRESH_MS = Math.max(0, Number.parseInt(process.env.HERDGATE_SNAPSHOT_FRESH_MS ?? "2000", 10) || 0);
  // The wedge guard (2026-11-23): one hung tick must not kill the adaptive
  // chain — abandon the attempt, log it, keep ticking with a fresh one.
  const PUBLISH_GUARD_MS = Math.max(5_000, Number.parseInt(process.env.HERDGATE_PUBLISH_GUARD_MS ?? "20000", 10) || 20000);
  let snapshotInflight = null;
  let snapshotCached = null; // { payload, at }
  // Adaptive cadence state (nextPublishDelay decides every tick): busy agents
  // or a changed snapshot keep the fast lane; quiet streaks relax ×1.5/tick.
  let cadenceBusy = false;
  let cadenceChanged = false;
  let quietStreak = 0;

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
    cadenceBusy = (summary.working + summary.blocked) > 0;
    let changed = false;
    if (sig !== lastSig) {
      changed = true;
      lastSig = sig;
      writeState(D.statePath, { lastPublish: { at: new Date().toISOString(), summary } });
    }
    cadenceChanged = changed;
    if (changed) wakeAway(true);
    const payload = { op: "view", view: { v: 1, source: "herdr", takenAt: new Date().toISOString(), summary } };
    snapshotCached = { payload, at: Date.now() };
    return payload;
  };

  /** Single-flight: concurrent demands (interval tick + a device's view op)
   * share one `herdr api snapshot` spawn instead of stampeding. */
  const snapshotOnce = () => {
    if (!snapshotInflight) {
      snapshotInflight = withTimeout(snapshotPayload(), PUBLISH_GUARD_MS, "snapshot")
        .catch((e) => {
          if (e?.kind === "timeout_guard") { log(`snapshot wedged — ${e.message}`); return null; }
          throw e;
        })
        .finally(() => { snapshotInflight = null; });
    }
    return snapshotInflight;
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
    const payload = await snapshotOnce();
    if (!payload) return;
    for (const d of devices) {
      await sendPayload(ws, d.id, payload);
    }
  };

  /** The adaptive tick chain: publish, then schedule the next tick by how busy
   *  and how quiet the room is. One timer at a time; events (hello, room.update)
   *  publish out-of-band and reschedule so changes are seen at once. */
  const scheduleNext = () => {
    if (timer) clearTimeout(timer);
    const delay = nextPublishDelay({ baseMs: PUBLISH_MS, maxMs: PUBLISH_MAX_MS, busy: cadenceBusy, quietStreak, changed: cadenceChanged });
    timer = setTimeout(() => {
      void (async () => {
        await withTimeout(publish(wsRef), PUBLISH_GUARD_MS, "publish tick")
          .catch((e) => { if (e?.kind === "timeout_guard") log(`publish tick wedged — ${e.message}`); else log(`publish failed: ${e?.message ?? e}`); });
        quietStreak = !cadenceBusy && !cadenceChanged ? quietStreak + 1 : 0;
        scheduleNext();
      })();
    }, delay);
    timer.unref?.();
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
  /** Settle-anchored git heads — the `turn` review scope without a ref write
   *  (reviewr keeps its baseline in refs/reviewr/*; herdgate journals settle
   *  heads BESIDE the repo instead). Receipts carry no hashes, so this journal
   *  is the honest baseline: every settle records HEAD; `turn` diffs the two
   *  newest anchors = exactly the last settled agent turn. */
  const gitAnchorsFile = () => (D.statePath ? join(D.statePath, "..", "git-anchors.json") : "");
  // Phone-opened tabs (ownership map): a device may close only the tabs it
  // created — the user's own tabs are never touchable from a phone.
  const phoneTabsFile = () => (D.statePath ? join(D.statePath, "..", "phone-tabs.json") : "");
  const recordGitAnchor = async (reason) => {
    const file = gitAnchorsFile();
    if (!file) return;
    try {
      const { stdout } = await gitRead(["rev-parse", "HEAD"], diffRepoDir(), 5_000);
      const head = String(stdout).trim();
      if (!/^[0-9a-f]{7,40}$/.test(head)) return;
      const prior = readState(file);
      const anchors = Array.isArray(prior.anchors) ? prior.anchors : [];
      if (anchors[anchors.length - 1]?.head === head) return; // no new commits since
      anchors.push({ head, at: Date.now(), reason });
      writeState(file, { v: 1, anchors: anchors.slice(-8) });
      log(`review: anchor ${head.slice(0, 8)} (${reason})`);
    } catch { /* not a repo — `turn` will say so honestly */ }
  };
  const pushReceipt = (entry) => {
    void recordGitAnchor("settle"); // journal the turn boundary first — subscriber fan-out is separate
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
      wakeAway(true, { kind: "settle", agent: entry.title ?? undefined });
    }
  };

  /** Wake phones that are away when something actually changed (throttled per device). */
  const lastWake = new Map(); // deviceId → epoch ms
  const wakeAway = (changed, note = { kind: "activity" }) => {
    if (!changed) return;
    if (note?.kind === "settle") void recordGitAnchor("settle"); // event-hook settles journal too
    const now = Date.now();
    for (const d of devices) {
      if (d.connected !== false) continue;
      const at = lastWake.get(d.id) ?? 0;
      if (now - at < 5 * 60_000) continue;
      lastWake.set(d.id, now);
      if (wsRef && wsRef.readyState === 1) wsRef.send(JSON.stringify({ v: 1, t: "wake", device: d.id, note }));
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
      ws.send(JSON.stringify({ v: 1, t: "hello", roomToken: token, info: { name: NAME, version: pkgVersion(), capabilities: ["dev.herdgate.host", allowAct ? "act" : "read-only"] } }));
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
        log(`connected to ${url}${loopbackPort ? ` via loopback 127.0.0.1:${loopbackPort}` : ""} (room ${m.roomId}, ${devices.length} device(s), publish ${PUBLISH_MS}ms adaptive→${PUBLISH_MAX_MS}ms)`);
        if (process.env.HERDGATE_PI_RECEIPTS === "1" && !receiptWatch) {
          // Settles push to subscribed devices only. Parent wakes no longer ride
          // this watcher — the child-cooperative design (arm/marker/observer)
          // missed three times live. Herdr now reports through the [[events]]
          // hooks (server/wake-event.mjs): wake survives a child that never
          // arms, and a pane that dies before settling still reports.
          receiptWatch = watchReceipts(receiptJournalBase(), (entry) => {
            pushReceipt(entry);
          });
          log(`receipts: journal push enabled (${receiptJournalBase()})`);
          log(`wake: herdr event hooks (pane.agent_status_changed/exited/closed)`);
        }
        for (const d of devices) flushWatches(d.id);
        void publish(ws);
        quietStreak = 0; // a fresh connection is not quiet — start on the fast lane
        scheduleNext();
        void recordGitAnchor("boot"); // seed the first boundary so turn 1 is diffable
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
        scheduleNext(); // device churn is activity — reschedule now
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
        if (op === "usage.rollup") {
          // The PWA's Timeline/Usage views: the receipt journal rolled into daily
          // buckets and per-principal spend (the raw usageRollup shape). Aggregates
          // only and usageRollup fails closed to a zeroed result, so read scope is
          // enough and a missing journal answers zeros, never an error.
          const n = Number(payload.days);
          const days = Number.isFinite(n) ? Math.min(31, Math.max(1, Math.floor(n))) : 7;
          const rollup = usageRollup({ base: receiptJournalBase(), days });
          log(`usage: ${m.device} roll-up ${days}d -> ${rollup.total.requests} request(s), ${rollup.total.tokens} token(s)`);
          return void replyTo({ op: "usage.rollup.result", ...rollup });
        }
        if (op === "sysmon.snapshot") {
          // READ-ONLY machine observation (sysmon.mjs): CPU/RAM per live spawn
          // child. Roots are the registry's live panes joined with pane rows —
          // the registry stores no pids, so roots exist only when herdr's pane
          // list carries a pid; without pids the answer is [] plus a note, never
          // a guess. The sampler itself fails closed to []. Subprocess-backed
          // (one pane list), so throttled like term.*.
          const now = Date.now();
          const last = termThrottle.get(`sysmon:${m.device}`) ?? 0;
          if (now - last < 1_000) return void replyTo({ op: "error", code: "busy", message: "sysmon.snapshot is throttled (1/s)" });
          termThrottle.set(`sysmon:${m.device}`, now);
          const panes = await paneRowsWithPids();
          let note = null;
          let roots = [];
          if (panes === null) {
            note = "herdr pane list failed — no live child could be resolved";
          } else {
            const withPid = liveSpawnChildren(panes).filter((row) => row.pid);
            if (withPid.length === 0) {
              note = panes.some((p) => Number.isInteger(Number(p.pid)) && Number(p.pid) > 0)
                ? "no live spawn child exposes a pid — nothing to sample"
                : "herdr pane list carries no pid field — CPU/RAM roots unavailable";
            } else {
              roots = withPid.map((row) => ({ pid: row.pid, key: row.key }));
            }
          }
          const agents = sysSnapshot(roots);
          log(`sysmon: ${m.device} snapshot -> ${agents.length} agent row(s)${note ? ` (${note})` : ""}`);
          return void replyTo({ op: "sysmon.snapshot.result", at: new Date().toISOString(), agents, ...(note ? { note } : {}) });
        }
        if (op === "ports.list") {
          // READ-ONLY listener attribution (port-attr.mjs): every LISTEN socket,
          // attributed to the live spawn child it descends from. Without shell
          // pids nothing can be attributed — the module answers the unattributed
          // list and a note says why; an owner is never invented. Throttled 1/s.
          const now = Date.now();
          const last = termThrottle.get(`ports:${m.device}`) ?? 0;
          if (now - last < 1_000) return void replyTo({ op: "error", code: "busy", message: "ports.list is throttled (1/s)" });
          termThrottle.set(`ports:${m.device}`, now);
          const panes = await paneRowsWithPids();
          let shellPids = [];
          let note = null;
          if (panes === null) {
            note = "herdr pane list failed — every listener stays unattributed";
          } else {
            shellPids = liveSpawnChildren(panes).filter((row) => row.pid).map((row) => ({ pid: row.pid, key: row.key }));
            if (shellPids.length === 0) {
              note = panes.some((p) => Number.isInteger(Number(p.pid)) && Number(p.pid) > 0)
                ? "no live spawn child exposes a pid — every listener stays unattributed"
                : "herdr pane list carries no pid field — every listener stays unattributed";
            }
          }
          const { attributed, unattributed } = attributePorts(shellPids);
          log(`ports: ${m.device} list -> ${attributed.length} attributed, ${unattributed.length} unattributed${note ? ` (${note})` : ""}`);
          return void replyTo({ op: "ports.list.result", attributed, unattributed, ...(note ? { note } : {}) });
        }
        if (op === "receipt.enrich") {
          // Experimental (opt-in HERDGATE_PI_RECEIPTS=1): transcript facts for one
          // receipt — model, context size, turns, usage totals, last activity —
          // parsed from the session transcript of the spawn registry record
          // matching the receipt's sessionId (Pi's session roots as fallback).
          // Metadata only; a missing or unreadable transcript is a clear error
          // op, never a throw and never a guessed number.
          const id = typeof payload.id === "string" && JOB_ID.test(payload.id) ? payload.id : "";
          if (!receiptsEnabled()) {
            return void replyTo({ op: "receipt.enrich.result", id: id || null, reason: "pi_receipts_disabled" });
          }
          if (!id) return void replyTo({ op: "error", code: "receipt.enrich", message: "receipt.enrich needs a request id" });
          const entry = findReceipt(receiptJournalBase(), id);
          if (!entry) {
            log(`receipts: ${m.device} enrich ${id} -> no receipt`);
            return void replyTo({ op: "error", code: "receipt.enrich", message: `no receipt ${id} in the journal` });
          }
          const file = transcriptFor(entry);
          const parsed = file ? parsePiTranscript(file) : null;
          if (!parsed || parsed.error) {
            log(`receipts: ${m.device} enrich ${id} -> no transcript (session ${entry.sessionId})`);
            return void replyTo({ op: "error", code: "receipt.enrich", message: `no readable transcript for session ${entry.sessionId}` });
          }
          log(`receipts: ${m.device} enrich ${id} -> ${parsed.model ?? "?"}, ${parsed.turns} turn(s), ${parsed.usageTotal.totalTokens} token(s)`);
          return void replyTo({ op: "receipt.enrich.result", id, sessionId: entry.sessionId,
            model: parsed.model ?? null, contextTokens: parsed.contextTokens ?? null,
            turns: parsed.turns, usageTotal: parsed.usageTotal, lastTs: parsed.lastTs });
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
        if (op === "loop.status") {
          // READ-ONLY presence for the shipped dev-loop plugin (dev.herdgate.loop):
          // its state dir sits next to ours in the same herdr home (or comes in via
          // env for probes/tests). One state.json read plus a capped log tail — no
          // herdr call, no write, so `pane.alive` is honestly null (pane liveness
          // is what view/fleet.detail already answer). A missing or unreadable
          // state is an `unknown` loop, never a throw and never a broken socket.
          const loopBase = process.env.HERDGATE_LOOP_STATE_DIR || process.env.HERDR_LOOP_STATE_DIR
            || (process.env.HERDR_PLUGIN_STATE_DIR
              ? join(dirname(process.env.HERDR_PLUGIN_STATE_DIR), "dev.herdgate.loop")
              : "");
          let loop = { ok: false, error: "unknown" };
          try {
            if (loopBase) {
              // Same BOM rule the loop plugin itself learned in C12: a Windows-written
              // state.json must not read back as "not found".
              const st = JSON.parse(readFileSync(join(loopBase, "state.json"), "utf8").replace(/^\uFEFF/, ""));
              if (st && typeof st === "object" && !Array.isArray(st)) {
                let logTail = [];
                try {
                  logTail = readFileSync(join(loopBase, "loop.log"), "utf8").split("\n")
                    .filter((l) => l.length > 0).slice(-MAX_LOOP_LOG_TAIL).map((l) => l.slice(0, MAX_LOOP_LOG_LINE));
                } catch { /* no log yet — the state file is still the truth */ }
                loop = { ok: true, pane: { id: typeof st.paneId === "string" ? st.paneId : null, alive: null },
                  status: typeof st.status === "string" ? st.status : "unknown",
                  paused: st.paused === true,
                  pausedBy: typeof st.pausedBy === "string" ? st.pausedBy : null,
                  cycles: Number(st.cycles) || 0,
                  lastNudgeAt: Number(st.lastNudgeAt) > 0 ? Number(st.lastNudgeAt) : null,
                  // C23: when the next deferred nudge fires (epoch ms | null) —
                  // additive only; a cooldown-blocked settle now schedules one
                  // instead of being dropped, and this is how a phone sees it.
                  deferredUntil: Number(st.deferredUntil) > 0 ? Number(st.deferredUntil) : null,
                  logTail };
              }
            }
          } catch { loop = { ok: false, error: "unknown" }; }
          log(`loop: ${m.device} status -> ${loop.ok ? `${loop.status} cycles=${loop.cycles} tail=${loop.logTail.length}` : "unknown"}`);
          return void replyTo({ op: "loop.status", loop });
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
        if (op === "attachment.upload" || op === "attachment.list") {
          // Wave C3 — photo/file attachments from the PWA composer (the herdcats
          // lesson: the upload lands ON THE AGENT MACHINE under the plugin's
          // private state dir; the reply carries a path hint, and the Pi agent
          // opens the file with its own read tool — image bytes never ride the
          // prompt). Client names are never trusted: saveAttachment stores
          // <uuid>.<ext> with the ext sniffed from magic bytes, inside
          // stateDir/attachments/<yyyy-mm>/ (0700 per level, file 0600).
          if (!D.stateDir) {
            return void replyTo({ op: "error", code: "attachment", message: "no plugin state dir — attachments unavailable" });
          }
          if (op === "attachment.list") {
            const all = listAttachments(D.stateDir);
            const capped = all.length > MAX_ATTACHMENTS;
            const attachments = capped ? all.slice(0, MAX_ATTACHMENTS) : all;
            log(`attachment: ${m.device} list -> ${all.length} file(s)${capped ? ` (capped at ${MAX_ATTACHMENTS})` : ""}`);
            return void replyTo({ op: "attachment.list.result", attachments, capped, total: all.length });
          }
          const name = typeof payload.name === "string" ? payload.name.trim() : "";
          const dataBase64 = typeof payload.dataBase64 === "string" ? payload.dataBase64 : "";
          if (!name || name.length > 255 || !dataBase64) {
            return void replyTo({ op: "error", code: "attachment", message: "attachment.upload needs a name and base64 data" });
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
            log(`attachment: ${m.device} upload refused: bad base64`);
            return void replyTo({ op: "error", code: "attachment", message: "attachment.upload data is not valid base64" });
          }
          let bytes;
          try { bytes = Buffer.from(dataBase64, "base64"); }
          catch (e) {
            return void replyTo({ op: "error", code: "attachment", message: `attachment.upload data is not valid base64 (${e.code ?? "decode"})` });
          }
          try {
            const saved = saveAttachment(D.stateDir, { name, bytes });
            log(`attachment: ${m.device} uploaded ${name} (${bytes.length}B) -> ${saved.id}`);
            return void replyTo({ op: "attachment.uploaded", id: saved.id, path: saved.path,
              hint: `Please open and inspect this image: ${saved.path}` });
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            log(`attachment: ${m.device} upload refused: ${why}`);
            return void replyTo({ op: "error", code: "attachment", message: `attachment.upload failed: ${why}` });
          }
        }
        if (op === "view") {
          // Answer this device now. Inside the freshness window replay the last
          // snapshot (no spawn, no lastSig reset — so the next full tick cannot
          // re-detect a "change" and wake away phones for nothing).
          if (snapshotCached && Date.now() - snapshotCached.at < SNAPSHOT_FRESH_MS) {
            for (const d of devices) await sendPayload(ws, d.id, snapshotCached.payload);
            return;
          }
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
            const all = await herdrPanes(D.herdrBin);
            const capped = all.length > MAX_PANES;
            return void replyTo({ op: "term.list", panes: capped ? all.slice(0, MAX_PANES) : all, panesCapped: capped, total: all.length });
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
        if (op === "fleet.detail") {
          // READ-ONLY fleet detail for mirrors (the sidebar phase): per-agent rows
          // plus the pane index — richer than the pushed `view` summary, still a
          // single throttled herdr read. No secrets, no session paths.
          const now = Date.now();
          const last = termThrottle.get(`fleet:${m.device}`) ?? 0;
          if (now - last < 2_000) return void replyTo({ op: "error", code: "busy", message: "fleet.detail is throttled (1/2s)" });
          termThrottle.set(`fleet:${m.device}`, now);
          try {
            const [snap, allPanes] = await Promise.all([herdrSnapshot(D.herdrBin), herdrPanes(D.herdrBin)]);
            const agents = (Array.isArray(snap?.agents) ? snap.agents : [])
              .filter((a) => a && typeof a.agent === "string")
              .slice(0, 50)
              .map((a) => ({
                agent: String(a.agent).slice(0, 32),
                status: typeof a.agent_status === "string" ? a.agent_status.slice(0, 16) : "unknown",
                pane: typeof a.pane_id === "string" ? a.pane_id : "",
                title: typeof a.terminal_title_stripped === "string" ? a.terminal_title_stripped.slice(0, 96) : "",
                cwd: typeof a.cwd === "string" ? a.cwd.slice(0, 96) : "",
              }));
            const panesCapped = allPanes.length > MAX_PANES;
            const panes = panesCapped ? allPanes.slice(0, MAX_PANES) : allPanes;
            return void replyTo({ op: "fleet.detail.result", takenAt: new Date().toISOString(),
              herdr: snap ? `${snap.version ?? "?"} (protocol ${snap.protocol ?? "?"})` : "?",
              agents, panes, panesCapped, total: allPanes.length });
          } catch (e) {
            return void replyTo({ op: "error", code: "herdr", message: `snapshot failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        if (op === "term.send" || op === "term.keys") {
          // ACT — the typing lane for mirrors. Text goes through `herdr pane
          // send-text` (argv array, no shell), keys through `herdr pane send-keys`;
          // both only after the device holds an act grant from the owner.
          if (devices.find((d) => d.id === m.device)?.scope !== "act") {
            return void replyTo({ op: "error", code: "requires-act", message: `${op} needs an act device` });
          }
          const target = typeof payload.target === "string" ? payload.target : "";
          if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(target)) {
            return void replyTo({ op: "error", code: "bad-target", message: `${op} needs a pane id` });
          }
          const argv = ["pane"];
          if (op === "term.send") {
            const text = typeof payload.text === "string" ? payload.text : "";
            if (!text || text.length > 4096) {
              return void replyTo({ op: "error", code: "bad-text", message: "term.send needs text of 1..4096 chars" });
            }
            argv.push("send-text", target, text);
          } else {
            const keys = Array.isArray(payload.keys) ? payload.keys : [];
            if (!keys.length || keys.length > 8 || !keys.every((k) => typeof k === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(k))) {
              return void replyTo({ op: "error", code: "bad-keys", message: "term.keys needs 1..8 keys (Enter, Tab, C-c, …)" });
            }
            argv.push("send-keys", target, ...keys);
          }
          try {
            await run(D.herdrBin, argv, { timeout: 8_000 });
            log(`term: ${m.device} ${op} ${target}${op === "term.send" ? ` (${String(payload.text).length} chars)` : ` ${payload.keys.join(" ")}`}`);
            return void replyTo({ op: op === "term.send" ? "term.sent" : "term.keyed", target });
          } catch (e) {
            return void replyTo({ op: "error", code: "herdr", message: `${op} failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        if (op === "diff.get") {
          // READ-ONLY code archeology: one `git show --stat --patch` of a host-local
          // ref (hash/branch/tag) in the plugin's repo dir (HERDGATE_DIFF_REPO_DIR
          // lets a test point elsewhere). The ref is whitelisted hard and the git
          // call itself goes through gitRead — scrubbed env, no ext-diff/textconv,
          // fsmonitor/hooks neutralized, no payload-chosen cwd — so hostile repo
          // config can never execute through this op.
          const ref = typeof payload.ref === "string" ? payload.ref : "";
          if (!/^[A-Za-z0-9._/~^-]{1,64}$/.test(ref)) {
            return void replyTo({ op: "error", code: "bad-ref", message: "diff.get needs a git ref of [A-Za-z0-9._/-], 1..64 chars" });
          }
          const repoDir = diffRepoDir();
          try {
            const { stdout } = await gitRead(["show", "--no-color", "--stat", "--patch", ref], repoDir, 10_000);
            const bytes = Buffer.byteLength(stdout, "utf8");
            const truncated = bytes > MAX_DIFF_BYTES;
            const text = truncated ? Buffer.from(stdout, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8") : stdout;
            log(`diff: ${m.device} show ${ref} -> ${bytes}B${truncated ? " (capped at 128KiB)" : ""}`);
            return void replyTo({ op: "diff.result", ref, text, bytes, truncated });
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const stderr = String(e?.stderr ?? "");
            const noRepo = /not a git repository/i.test(`${err.message}\n${stderr}`);
            log(`diff: ${m.device} show ${ref} refused: ${err.message}`);
            return void replyTo({ op: "error", code: noRepo ? "diff.repo" : "diff.ref",
              message: noRepo ? "the plugin directory is not a git repository"
                : stderr.split("\n")[0] || err.message });
          }
        }
        if (op === "file.tree") {
          // READ-ONLY file index (filev pattern): tracked files from `git ls-files`
          // (already .gitignore-aware) with `git status --porcelain` markers overlaid.
          // Same hardened gitRead as diff.get — no payload-chosen cwd, scrubbed env.
          // Untracked files are invisible by design: only what git tracks can be read.
          const repoDir = diffRepoDir();
          try {
            const [files, status] = await Promise.all([
              gitRead(["ls-files"], repoDir, 10_000),
              gitRead(["status", "--porcelain"], repoDir, 10_000),
            ]);
            // XY status + path; rename lines take the "-> " target. Quoted paths
            // (git quotes specials) are unquoted minimally — markers are advisory.
            const markers = new Map();
            for (const line of String(status.stdout).split("\n")) {
              const m = /^([ MARDRCU?!]{1,2})\s+(.+)$/.exec(line);
              if (!m || !m[1].trim()) continue; // "??" and blank lead chars alike
              let target = m[2].split(" -> ").pop() ?? m[2];
              if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
              markers.set(target, m[1].trim());
            }
            const all = String(files.stdout).split("\n").filter(Boolean);
            const capped = all.length > MAX_FILE_ENTRIES;
            const entries = (capped ? all.slice(0, MAX_FILE_ENTRIES) : all)
              .map((path) => ({ path, status: markers.get(path) ?? null }))
              .sort((a, b) => a.path.localeCompare(b.path));
            return void replyTo({ op: "file.tree.result", files: entries, capped, total: all.length });
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const stderr = String(e?.stderr ?? "");
            const noRepo = /not a git repository/i.test(`${err.message}\n${stderr}`);
            log(`files: ${m.device} tree refused: ${err.message}`);
            return void replyTo({ op: "error", code: noRepo ? "diff.repo" : "files.tree",
              message: noRepo ? "the plugin directory is not a git repository"
                : stderr.split("\n")[0] || err.message });
          }
        }
        if (op === "file.read") {
          // READ-ONE-FILE with filev's hardening rules: git-tracked paths only (the
          // tree above is the whitelist), no leading /, no .., no NUL, ≤ 255 chars,
          // realpath must stay under the repo (a symlink planted inside must not
          // read outside), size capped — and the bytes go back as text, nothing else.
          const path = typeof payload.path === "string" ? payload.path : "";
          if (!/^[^/\0][^\0]{0,254}$/.test(path) || path.split("/").includes("..")) {
            return void replyTo({ op: "error", code: "bad-path", message: "file.read needs a root-relative path without .." });
          }
          const repoDir = diffRepoDir();
          try {
            const repoReal = realpathSync(repoDir);
            const full = join(repoDir, path);
            let st;
            try { st = statSync(full); } catch { st = null; }
            if (!st || !st.isFile()) {
              return void replyTo({ op: "error", code: "no-file", message: "no such file in the repo" });
            }
            if (!realpathSync(full).startsWith(repoReal + "/")) {
              return void replyTo({ op: "error", code: "bad-path", message: "path escapes the repo" });
            }
            const tracked = await gitRead(["ls-files", "--", path], repoDir, 10_000);
            if (!String(tracked.stdout).trim()) {
              return void replyTo({ op: "error", code: "no-file", message: "not a tracked file" });
            }
            const truncated = st.size > MAX_FILE_BYTES;
            const buf = readFileSync(full);
            let text = truncated ? buf.subarray(0, MAX_FILE_BYTES).toString("utf8") : buf.toString("utf8");
            // JSON escaping can inflate a hostile file several-fold (\u0000 = 6x);
            // shrink until the ENVELOPE fits the gate's 256KiB frame cap — a reply
            // that kills the publisher's own socket is worse than a shorter view.
            while (Buffer.byteLength(JSON.stringify({ t: "frame", payload: { op: "file.read.result", path, text } })) > 240 * 1024 && text.length > 0) {
              text = text.slice(0, Math.floor(text.length * 0.8));
            }
            const lines = text.length ? text.split("\n").length : 0;
            return void replyTo({ op: "file.read.result", path, text, lines, bytes: st.size, truncated: truncated || Buffer.byteLength(text) < Math.min(st.size, MAX_FILE_BYTES) });
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            log(`files: ${m.device} read ${path} refused: ${err.message}`);
            return void replyTo({ op: "error", code: "files.read", message: err.message });
          }
        }
        if (op === "review.files" || op === "review.diff") {
          // READ-ONLY review scopes — the reviewr pattern, mobile: `uncommitted`,
          // `branch` (three-dot vs upstream/main — merge-base for free), `turn`
          // (diff of the last settled agent turn, anchored by the git-anchors
          // journal — no ref writes). All git flows through the hardened gitRead.
          const scope = typeof payload.scope === "string" ? payload.scope : "";
          if (!["uncommitted", "branch", "turn"].includes(scope)) {
            return void replyTo({ op: "error", code: "bad-scope", message: "review.* needs scope uncommitted | branch | turn" });
          }
          const repoDir = diffRepoDir();
          try {
            let range;
            let base = null;
            if (scope === "uncommitted") {
              range = ["HEAD"];
            } else if (scope === "branch") {
              // Candidates avoid ref-expression braces (@{upstream}, ^{commit}) —
              // gitRead's arg grammar keeps them out, so plain names only.
              for (const cand of ["origin/main", "origin/master", "main", "master"]) {
                try {
                  const { stdout } = await gitRead(["rev-parse", "--verify", cand], repoDir, 5_000);
                  const sha = String(stdout).trim();
                  if (/^[0-9a-f]{7,40}$/.test(sha)) { base = sha; break; }
                } catch { /* try the next candidate */ }
              }
              if (!base) {
                return void replyTo({ op: "error", code: "no-base", message: "không thấy upstream/main — không định vị được scope branch" });
              }
              range = [`${base}...HEAD`];
            } else {
              const anchors = readState(gitAnchorsFile()).anchors;
              if (!Array.isArray(anchors) || anchors.length < 2) {
                return void replyTo({ op: "error", code: "no-anchor", message: "chưa đủ 2 mốc settle — chờ agent settle thêm một lượt để có diff lượt cuối" });
              }
              const from = anchors[anchors.length - 2].head;
              const to = anchors[anchors.length - 1].head;
              range = [`${from}..${to}`];
              base = from;
            }
            if (op === "review.files") {
              const numstat = await gitRead(["diff", "--no-color", "--numstat", ...range], repoDir, 10_000);
              const files = [];
              for (const line of String(numstat.stdout).split("\n")) {
                const nm = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
                if (!nm) continue;
                let path = nm[3].split(" -> ").pop() ?? nm[3];
                if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
                files.push({ path, plus: nm[1] === "-" ? null : Number(nm[1]), minus: nm[2] === "-" ? null : Number(nm[2]) });
              }
              let untracked = 0;
              if (scope === "uncommitted") {
                // `git diff` never sees untracked files; the porcelain overlay adds
                               // them as zero-stat rows so the review list matches reality.
                const status = await gitRead(["status", "--porcelain"], repoDir, 10_000);
                for (const line of String(status.stdout).split("\n")) {
                  const sm = /^\?\?\s+(.+)$/.exec(line);
                  if (!sm) continue;
                  let path = sm[1].split(" -> ").pop() ?? sm[1];
                  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
                  if (files.some((f) => f.path === path)) continue;
                  files.push({ path, plus: null, minus: null, status: "??" });
                  untracked++;
                }
              }
              files.sort((a, b) => a.path.localeCompare(b.path));
              const capped = files.length > MAX_REVIEW_FILES;
              log(`review: ${m.device} files ${scope}${base ? ` @${String(base).slice(0, 8)}` : ""} -> ${files.length} file${untracked ? ` (${untracked} chưa track)` : ""}`);
              return void replyTo({ op: "review.files.result", scope, base, files: capped ? files.slice(0, MAX_REVIEW_FILES) : files, capped });
            }
            const path = typeof payload.path === "string" ? payload.path : "";
            if (!/^[^/\0][^\0]{0,254}$/.test(path) || path.split("/").includes("..")) {
              return void replyTo({ op: "error", code: "bad-path", message: "review.diff needs a root-relative path without .." });
            }
            const { stdout } = await gitRead(["diff", "--no-color", "--patch", ...range, "--", path], repoDir, 10_000);
            const bytes = Buffer.byteLength(stdout, "utf8");
            const truncated = bytes > MAX_DIFF_BYTES;
            const text = truncated ? Buffer.from(stdout, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8") : stdout;
            log(`review: ${m.device} diff ${scope} ${path} -> ${bytes}B${truncated ? " (capped at 128KiB)" : ""}`);
            return void replyTo({ op: "review.diff.result", scope, path, base, text, bytes, truncated });
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const stderr = String(e?.stderr ?? "");
            const noRepo = /not a git repository/i.test(`${err.message}\n${stderr}`);
            log(`review: ${m.device} ${op} ${scope} refused: ${err.message}`);
            return void replyTo({ op: "error", code: noRepo ? "diff.repo" : "review",
              message: noRepo ? "the plugin directory is not a git repository" : stderr.split("\n")[0] || err.message });
          }
        }
        if (op === "review.send") {
          // ACT — ship the phone's line comments to the agent. The Pi worker queue
          // is the one delivery leg that already exists (receipts, wake-on-settle);
          // the comments ride as a <file-comments> block the agent reads structurally.
          if (process.env.HERDGATE_PI_WORKER !== "1") {
            return void replyTo({ op: "error", code: "pi_worker_disabled", message: "host chưa bật Pi worker — review.send cần HERDGATE_PI_WORKER=1" });
          }
          if (devices.find((d) => d.id === m.device)?.scope !== "act") {
            return void replyTo({ op: "error", code: "requires-act", message: "review.send needs an act device" });
          }
          const comments = Array.isArray(payload.comments) ? payload.comments : [];
          if (!comments.length || comments.length > MAX_REVIEW_COMMENTS) {
            return void replyTo({ op: "error", code: "bad-comments", message: `review.send needs 1..${MAX_REVIEW_COMMENTS} comments` });
          }
          for (const c of comments) {
            const okPath = typeof c?.path === "string" && /^[^/\0][^\0]{0,254}$/.test(c.path) && !c.path.split("/").includes("..");
            const okLine = Number.isInteger(c?.line) && c.line >= 1 && c.line <= 1e6;
            const okEnd = c?.endLine === undefined || (Number.isInteger(c.endLine) && c.endLine >= c.line && c.endLine <= 1e6);
            const okText = typeof c?.text === "string" && c.text.trim().length > 0 && c.text.length <= 500;
            if (!okPath || !okLine || !okEnd || !okText) {
              return void replyTo({ op: "error", code: "bad-comment", message: "comment needs { path, line 1..1e6, endLine?, text 1..500 }" });
            }
          }
          const body = comments.map((c) => `${c.path}:${c.line}${c.endLine ? `-${c.endLine}` : ""} — ${c.text}`).join("\n");
          const prompt = `Xử lý review comments trên diff từ mobile:\n\n<file-comments>\n${body}\n</file-comments>\n\nTừng comment: xem chỗ chỉ dẫn, sửa nếu đúng, chạy test liên quan, commit nếu đạt. Báo lại ngắn gọn từng dòng đã xử lý thế nào.`;
          const file = jobsFile(workerBase());
          let jobs;
          try { jobs = readJobs(file); }
          catch (e) {
            return void replyTo({ op: "error", code: "worker-queue", message: `queue unreadable: ${e instanceof Error ? e.message : String(e)}` });
          }
          const pending = [...jobs.values()].filter((j) => j.state === "queued" || j.state === "running").length;
          if (pending >= MAX_PENDING) {
            return void replyTo({ op: "error", code: "queue-full", message: `worker queue is full (${MAX_PENDING} pending)` });
          }
          const jobId = randomUUID();
          try {
            appendJob(file, { v: 1, id: jobId, prompt, ts: Date.now(), state: "queued", principal: `device:${m.device}`, kind: "review" });
          } catch (e) {
            return void replyTo({ op: "error", code: "worker-queue", message: `queue append failed: ${e instanceof Error ? e.message : String(e)}` });
          }
          log(`review: ${m.device} sent ${comments.length} comment(s) as job ${jobId}`);
          return void replyTo({ op: "review.sent", id: jobId, state: "queued", count: comments.length });
        }
        if (op === "tab.create" || op === "tab.close") {
          // ACT — phone-opened tabs, with ownership: the publisher remembers
          // which device opened which tab (state file, capped) and a device
          // may only close its own. Nothing else on this Herdr is touchable.
          if (devices.find((d) => d.id === m.device)?.scope !== "act") {
            return void replyTo({ op: "error", code: "requires-act", message: `${op} needs an act device` });
          }
          const map = readState(phoneTabsFile());
          const tabs = Array.isArray(map.tabs) ? map.tabs : [];
          if (op === "tab.create") {
            const label = typeof payload.label === "string" && payload.label.trim() ? payload.label : "phone";
            // No control characters — the label becomes a tab title on a real screen.
            if (label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) {
              return void replyTo({ op: "error", code: "bad-label", message: "tab.create label: 1..64 chars, no control characters" });
            }
            try {
              const { stdout } = await run(D.herdrBin, ["tab", "create", "--label", label], { timeout: 8_000 });
              const parsed = JSON.parse(stdout);
              const tabId = parsed?.result?.tab?.tab_id;
              const paneId = parsed?.result?.root_pane?.pane_id;
              if (typeof tabId !== "string" || typeof paneId !== "string") throw new Error("unexpected tab create output");
              tabs.push({ tabId, device: m.device, at: Date.now() });
              while (tabs.length > 64) tabs.shift(); // FIFO — a map, not a ledger
              writeState(phoneTabsFile(), { v: 1, tabs });
              log(`tab: ${m.device} created ${tabId} (pane ${paneId}) label ${JSON.stringify(label)}`);
              return void replyTo({ op: "tab.created", tabId, paneId, label });
            } catch (e) {
              return void replyTo({ op: "error", code: "herdr", message: `tab.create failed: ${e instanceof Error ? e.message : String(e)}` });
            }
          }
          const tabId = typeof payload.tabId === "string" ? payload.tabId : "";
          if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(tabId)) {
            return void replyTo({ op: "error", code: "bad-tab", message: "tab.close needs a tab id" });
          }
          const mine = tabs.find((t) => t && t.tabId === tabId && t.device === m.device);
          if (!mine) {
            return void replyTo({ op: "error", code: "not-yours", message: "that tab was not opened by this device" });
          }
          try {
            await run(D.herdrBin, ["tab", "close", tabId], { timeout: 8_000 });
            writeState(phoneTabsFile(), { v: 1, tabs: tabs.filter((t) => t !== mine) });
            log(`tab: ${m.device} closed ${tabId}`);
            return void replyTo({ op: "tab.closed", tabId });
          } catch (e) {
            return void replyTo({ op: "error", code: "herdr", message: `tab.close failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        if (op === "pane.focus") {
          // ACT — steering the user's screen is an intervention; read devices
          // must not be able to yank focus. Fire-and-forget spawn, never
          // awaited: a phone must not hang on a TUI command. argv comes from
          // the --help probe.
          if (devices.find((d) => d.id === m.device)?.scope !== "act") {
            return void replyTo({ op: "error", code: "requires-act", message: "pane.focus needs an act device" });
          }
          const paneId = typeof payload.paneId === "string" ? payload.paneId : "";
          if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(paneId)) {
            return void replyTo({ op: "error", code: "bad-pane", message: "pane.focus needs a pane id" });
          }
          const argv = await paneFocusArgvProbe();
          if (!argv) {
            return void replyTo({ op: "error", code: "pane.focus", message: "this Herdr has no pane focus command" });
          }
          const child = spawn(D.herdrBin, [...argv, paneId], { stdio: "ignore", detached: true });
          child.on("error", (e) => log(`pane: focus spawn failed: ${e.message}`));
          child.unref();
          log(`pane: ${m.device} focus ${paneId} via \`${argv.join(" ")}\``);
          return void replyTo({ op: "pane.focused", paneId, via: argv.join(" ") });
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
      if (timer) clearTimeout(timer);
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

/** --- stop: end the publisher. The supervisor (if any) owns the teardown —
 *  the marker tells it to drain and clean up; without one we do it ourselves,
 *  and never leave an orphaned marker behind to ambush the next `serve`. --- */
async function stop() {
  const sup = runningSupervisorPid();
  const pid = runningPid();
  if (!sup && !pid) {
    log("publisher is not running");
    if (stopMarkerPath) rmSync(stopMarkerPath, { force: true });
    if (pidPath && existsSync(pidPath)) rmSync(pidPath, { force: true }); // stale
    if (supervisorPidPath && existsSync(supervisorPidPath)) rmSync(supervisorPidPath, { force: true }); // stale
    return;
  }
  if (stopMarkerPath) {
    mkdirSync(dirname(stopMarkerPath), { recursive: true });
    writeFileSync(stopMarkerPath, "", { mode: 0o600 });
  }
  if (sup) {
    for (let i = 0; i < 44 && existsSync(supervisorPidPath); i++) await delayMs(125);
    if (!existsSync(supervisorPidPath)) {
      log(`stopped publisher (supervisor pid ${sup} drained it)`);
      return;
    }
    log("supervisor did not drain in time; stopping the publisher directly");
  }
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      log(`stopped publisher (pid ${pid})`);
    } catch (e) {
      log(`could not stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!runningSupervisorPid()) { // a live supervisor still cleans up on its next poll
    if (stopMarkerPath) rmSync(stopMarkerPath, { force: true });
    if (pidPath && existsSync(pidPath)) rmSync(pidPath, { force: true });
    if (supervisorPidPath && existsSync(supervisorPidPath)) rmSync(supervisorPidPath, { force: true });
  }
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
    const sup = runningSupervisorPid();
    lines.push(`publisher: ${pid ? `running (pid ${pid}${sup ? ", supervised" : ""})` : "stopped"}`);
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
  serve    start the supervised publisher (the [[startup]] hook); exits after spawning the supervisor
  stop     stop the publisher (the supervisor drains and cleans up)
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
