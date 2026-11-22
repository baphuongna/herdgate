#!/usr/bin/env node
// herdgate-mirror — the other half of the relay: run on ANY machine's Herdr,
// pair into a room as a device, and mirror the fleet. The pane command is the
// sidebar (agents, statuses, panes); `stream` mirrors one remote pane locally
// (typing needs an act grant, and predictive echo only after the screen has
// confirmed it twice — predict.mjs carries those rules).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { drawFleet, sanitizeFleet } from "./panel.mjs";
import { PredEcho, looksFullScreen } from "./predict.mjs";
import { mirrorWorkspaceLabel, planMirrors, streamCommandLine, MIRROR_TAB_PREFIX } from "./reconcile.mjs";

const run = promisify(execFile);
const NAME = "herdgate-mirror";

function configDir() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), ".config", "herdgate-mirror");
}
function configFile() {
  return join(configDir(), "mirror.json");
}

function readConfig() {
  try {
    const cfg = JSON.parse(readFileSync(configFile(), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** One device WebSocket to the gate. `onFrame(payload)` receives op payloads;
 *  `onOpen`/`onClose` track the lane. Resolves once the socket closes. */
function deviceWs(cfg, { onFrame, onOpen, onClose }) {
  return new Promise((resolve) => {
    let settled = false;
    const url = String(cfg.url).replace(/^http/, "ws") + "/v1/device/ws";
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onClose?.(e instanceof Error ? e.message : String(e));
      resolve();
      return;
    }
    let lastAt = 0;
    let askTimer = 0;
    const ask = () => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ v: 1, t: "frame", payload: { op: "fleet.detail" } }));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, t: "hello", device: cfg.device, deviceSecret: cfg.secret }));
      lastAt = Date.now();
      onOpen?.();
    };
    ws.onmessage = (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.t !== "frame" || !m.payload || typeof m.payload !== "object") return;
      lastAt = Date.now();
      onFrame(m.payload);
    };
    ws.onclose = () => {
      clearInterval(askTimer);
      if (!settled) { settled = true; onClose?.(); resolve(); }
    };
    ws.onerror = () => { /* onclose follows */ };
    // The panel is poll-shaped (the room pushes views every few seconds, but a
    // mirror wants detail on its own clock): ask on open, then every interval.
    const intervalMs = Number(process.env.HERDGATE_MIRROR_MS) || 5000;
    askTimer = setInterval(() => {
      if (Date.now() - lastAt > 30_000) return; // silence: the close handler owns retries
      ask();
    }, intervalMs);
    if (askTimer.unref) askTimer.unref();
    ws._ask = ask;
    ws._close = () => { try { ws.close(); } catch { /* already gone */ } };
    return ws;
  });
}

function paint(lines) {
  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
}

async function cmdPair() {
  const url = process.env.HERDGATE_MIRROR_URL;
  const roomId = process.env.HERDGATE_MIRROR_ROOM;
  const token = process.env.HERDGATE_ACCOUNT_TOKEN || process.env.HERDGATE_MIRROR_TOKEN;
  const scope = process.env.HERDGATE_MIRROR_SCOPE === "act" ? "act" : "read";
  if (!url || !roomId || !token) {
    console.error(`${NAME}: cần HERDGATE_MIRROR_URL, HERDGATE_MIRROR_ROOM và HERDGATE_ACCOUNT_TOKEN (hoặc HERDGATE_MIRROR_TOKEN)`);
    process.exit(2);
  }
  const name = `${hostname().slice(0, 24)}-mirror`;
  const granted = await new Promise((resolve, reject) => {
    const ws = new WebSocket(String(url).replace(/^http/, "ws") + "/v1/device/ws");
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("pair timeout")); }, 20_000);
    ws.onopen = () => ws.send(JSON.stringify({ v: 1, t: "hello", accountToken: token }));
    ws.onmessage = (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.t === "hello") ws.send(JSON.stringify({ v: 1, t: "pair.begin", roomId, scope, name }));
      if (m.t === "pair.granted") { clearTimeout(timer); ws.close(); resolve(m); }
      if (m.t === "pair.denied") { clearTimeout(timer); ws.close(); reject(new Error(`denied: ${m.reason}`)); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("không nối được gate")); };
  });
  writeConfig({ v: 1, url, roomId, device: granted.device.id, secret: granted.deviceSecret, scope, name, pairedAt: new Date().toISOString() });
  console.log(`${NAME}: đã pair ${granted.device.id} (scope ${scope}) vào ${roomId} — mở pane "herdgate mirror" để xem fleet.`);
}

function cmdStatus() {
  const cfg = readConfig();
  const masked = { ...cfg, secret: cfg.secret ? "••••" : undefined, account: undefined };
  console.log(JSON.stringify({ config: masked, configured: Boolean(cfg.url && cfg.device && cfg.secret) }, null, 2));
}

async function cmdPane(once) {
  const cfg = readConfig();
  if (!cfg.url || !cfg.device || !cfg.secret) {
    paint([`${NAME}: chưa pair — chạy action "pair" trước (HERDGATE_MIRROR_URL + HERDGATE_MIRROR_ROOM + token).`, "", "q đóng"]);
    keyToClose();
    await new Promise(() => {}); // a TTY pane waits for q; --once callers use the timeout
  }
  const view = { fleet: null, takenAt: 0, error: null };
  let closed = false;
  const askNow = { fn: null };
  const stdin = keyToClose(() => { closed = true; }, (k) => { if (k === "r") askNow.fn?.(); });
  const paintNow = () => paint(drawFleet(view.fleet, { room: cfg.roomId, ageMs: view.takenAt ? Date.now() - view.takenAt : null, error: view.error }));
  while (!closed) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const ws = deviceWs(cfg, {
        onOpen: () => { askNow.fn = () => { try { ws._ask?.(); } catch {} }; },
        onFrame: (payload) => {
          if (payload.op === "fleet.detail.result") {
            view.fleet = sanitizeFleet(payload);
            view.takenAt = Date.now();
            view.error = null;
          } else if (payload.op === "error" && payload.code !== "busy") {
            view.error = payload.message ?? payload.code;
          }
          if (once && (payload.op === "fleet.detail.result" || payload.op === "error")) {
            try { ws._close?.(); } catch { /* already gone */ }
            finish();
          } else if (!closed && !once) {
            paintNow();
          }
        },
        onClose: finish,
      });
      if (once) { const t = setTimeout(finish, 8_000); if (t.unref) t.unref(); }
    });
    if (closed || once) break;
    view.error = view.error ?? "mất kết nối gate — thử lại sau 3s";
    paintNow();
    await sleep(3_000);
  }
  paintNow();
  stdin.stop?.();
}

/** `stream <paneId>` — mirror one remote pane: poll term.read, repaint, and
 *  (only when the device holds act and HERDGATE_MIRROR_TYPE=1) type with
 *  predictive echo. Read-only mirrors need no grant — same rule as the PWA. */
async function cmdStream(target) {
  const cfg = readConfig();
  if (!cfg.url || !cfg.device || !cfg.secret) { console.error(`${NAME}: chưa pair`); process.exit(2); }
  if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(String(target ?? ""))) { console.error(`${NAME}: pane id không hợp lệ`); process.exit(2); }
  const typing = process.env.HERDGATE_MIRROR_TYPE === "1" && cfg.scope === "act";
  const predict = new PredEcho();
  const url = String(cfg.url).replace(/^http/, "ws") + "/v1/device/ws";
  const ws = new WebSocket(url);
  const send = (payload) => { if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, t: "frame", payload })); };
  let screen = "";
  let lastTitle = "";
  ws.onopen = () => ws.send(JSON.stringify({ v: 1, t: "hello", device: cfg.device, deviceSecret: cfg.secret }));
  ws.onmessage = (event) => {
    let m;
    try { m = JSON.parse(String(event.data)); } catch { return; }
    if (m.t !== "frame" || !m.payload || typeof m.payload !== "object") return;
    const p = m.payload;
    if (p.op === "term.read") {
      screen = String(p.ansi ?? "");
      const tail = stripAnsi(screen).slice(-400);
      if (looksFullScreen(screen, lastTitle)) predict.disable();
      else predict.confirm(tail);
      paintStream();
    } else if (p.op === "error" && p.code !== "busy") {
      screen = `lỗi: ${p.message ?? p.code}`;
      paintStream();
    }
  };
  let stopped = false;
  const ask = () => send({ op: "term.read", target, lines: 40 });
  ws.onclose = () => { if (!stopped) { screen = "mất kết nối gate — thoát (q)"; paintStream(); } };
  const poll = setInterval(ask, 1600);
  if (poll.unref) poll.unref();
  setTimeout(ask, 150);

  const buffer = []; // typed chars awaiting a batch send (150ms)
  let flushTimer = 0;
  const flush = () => {
    flushTimer = 0;
    if (!buffer.length) return;
    const text = buffer.splice(0).join("");
    send({ op: "term.send", target, text });
  };
  keyToClose(() => { stopped = true; clearInterval(poll); try { ws.close(); } catch {} process.exit(0); }, (k) => {
    if (!typing) return;
    if (k === "\r") {
      flush();
      predict.key("\n");
      send({ op: "term.keys", target, keys: ["Enter"] });
    } else if (k === "\u007f" || k === "\b") {
      predict.key("");
      send({ op: "term.keys", target, keys: ["Backspace"] });
    } else if (k >= " ") {
      predict.key(k);
      buffer.push(k);
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    }
    paintStream();
  });

  function paintStream() {
    const lines = String(screen).split("\n");
    const overlay = typing ? predict.pendingView() : "";
    const head = `⌨ ${target}${typing ? " (act, echo " + (predict.enabled ? "on" : "off") + ")" : " (đọc)"}`;
    paint([head, ...lines.slice(0, 38)].concat(overlay ? ["", "\x1b[2m" + overlay + "\x1b[0m"] : []));
  }
  function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][B0]/g, ""); }
}


/** One api-bridge call: one process, one JSON request on stdin (the pattern
 *  the pane-driver proved on both platforms). */
async function herdrApi(method, params) {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  const session = process.env.HERDGATE_MIRROR_SESSION || "default";
  const id = "m" + Math.random().toString(36).slice(2, 8);
  // A .mjs stub (tests) is not executable on its own — it rides the node binary.
  const argv = ["--session", session, "remote-api-bridge"];
  const child = bin.endsWith(".mjs")
    ? spawn(process.execPath, [bin, ...argv], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn(bin, argv, { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`api ${method} timeout`)); }, 8_000);
    child.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === id) { clearTimeout(timer); try { child.kill(); } catch {} resolve(m); return; }
        } catch { /* partial line */ }
      }
    });
    child.stderr.setEncoding("utf8").on("data", () => {});
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    child.stdin.end();
  });
}

/** The watch loop: poll fleet.detail, reconcile the mirror workspace's tabs.
 *  Ownership is by label — our workspace (🏠 <room>), our tabs (M:<paneId>) —
 *  nothing else on this Herdr is ever touched. */
async function cmdWatch(args) {
  const cfg = readConfig();
  if (!cfg.url || !cfg.device || !cfg.secret) { console.error(`${NAME}: chưa pair`); process.exit(2); }
  if (args.includes("--stop")) {
    const label = mirrorWorkspaceLabel(cfg.roomId);
    const listed = await herdrApi("workspace.list", {});
    const ours = (listed?.result?.workspaces ?? listed?.result ?? []).find?.((w) => w?.label === label);
    if (!ours) { console.log(`${NAME}: không có workspace mirror để dọn`); return; }
    const closed = await herdrApi("workspace.close", { workspace_id: ours.workspace_id });
    console.log(`${NAME}: đã đóng ${ours.workspace_id} (${JSON.stringify(closed?.result ?? closed?.error).slice(0, 80)})`);
    return;
  }
  const once = args.includes("--once");
  const selfDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const label = mirrorWorkspaceLabel(cfg.roomId);
  let wsId = null;
  const tabsByLabel = async () => {
    const listed = await herdrApi("tab.list", {});
    const tabs = (listed?.result?.tabs ?? []).filter((t) => typeof t?.tab_id === "string" && t.workspace_id === wsId);
    return tabs.map((t) => ({ tabId: t.tab_id, label: typeof t.label === "string" ? t.label : "" }));
  };
  const ensureWorkspace = async () => {
    const listed = await herdrApi("workspace.list", {});
    const all = listed?.result?.workspaces ?? [];
    const found = all.find((w) => w?.label === label);
    if (found) return found.workspace_id;
    const created = await herdrApi("workspace.create", {});
    const id = created?.result?.workspace?.workspace_id;
    if (!id) throw new Error("workspace.create: " + JSON.stringify(created).slice(0, 120));
    await herdrApi("workspace.rename", { workspace_id: id, label });
    return id;
  };
  const reconcile = async (fleet) => {
    wsId = wsId ?? (await ensureWorkspace());
    const plan = planMirrors(fleet, await tabsByLabel());
    for (const tab of plan.close) {
      await herdrApi("tab.close", { tab_id: tab.tabId });
      console.log(`${NAME}: − ${tab.paneId} (pane remote biến mất)`);
    }
    for (const paneId of plan.create) {
      const created = await herdrApi("tab.create", { workspace_id: wsId, label: MIRROR_TAB_PREFIX + paneId });
      const pane = created?.result?.root_pane?.pane_id;
      if (!pane) { console.error(`${NAME}: tab.create lỗi cho ${paneId}`); continue; }
      // The tab's shell has none of our env — the command carries its own.
      await herdrApi("pane.send_text", { pane_id: pane, text: streamCommandLine(configDir(), selfDir, paneId) + "\r" });
      console.log(`${NAME}: + ${paneId} → tab ${created?.result?.tab?.tab_id}`);
    }
    return plan;
  };
  if (once) {
    const fleet = await askFleetOnce(cfg);
    const plan = await reconcile(fleet);
    console.log(`${NAME}: reconcile xong — giữ ${plan.keep.length}, tạo ${plan.create.length}, đóng ${plan.close.length}`);
    return;
  }
  // Long watch: fleet WS in the foreground, reconcile each answer.
  let stopped = false;
  keyToClose(() => { stopped = true; });
  let ws;
  const intervalMs = Number(process.env.HERDGATE_MIRROR_MS) || 5_000;
  while (!stopped) {
    await new Promise((resolve) => {
      ws = new WebSocket(String(cfg.url).replace(/^http/, "ws") + "/v1/device/ws");
      let lastFrame = 0;
      ws.onopen = () => ws.send(JSON.stringify({ v: 1, t: "hello", device: cfg.device, deviceSecret: cfg.secret }));
      ws.onmessage = async (event) => {
        let m;
        try { m = JSON.parse(String(event.data)); } catch { return; }
        if (m.t !== "frame" || !m.payload || typeof m.payload !== "object") return;
        lastFrame = Date.now();
        const p = m.payload;
        if (p.op === "fleet.detail.result") {
          try { await reconcile(sanitizeFleet(p)); } catch (e) { console.error(`${NAME}: reconcile — ${e instanceof Error ? e.message : String(e)}`); }
          if (once) { try { ws.close(); } catch {} }
        }
      };
      ws.onclose = () => resolve();
      ws.onerror = () => {};
      const ask = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, t: "frame", payload: { op: "fleet.detail" } })); };
      setTimeout(ask, 150);
      const iv = setInterval(() => { if (stopped || Date.now() - lastFrame > 30_000) { clearInterval(iv); try { ws.close(); } catch {} } else ask(); }, intervalMs);
      if (iv.unref) iv.unref();
    });
    if (stopped) break;
    console.log(`${NAME}: mất kết nối gate — 3s nữa thử lại`);
    await sleep(3_000);
  }
}

async function askFleetOnce(cfg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(String(cfg.url).replace(/^http/, "ws") + "/v1/device/ws");
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("fleet.detail timeout")); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ v: 1, t: "hello", device: cfg.device, deviceSecret: cfg.secret }));
    ws.onmessage = (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.t === "hello") {
        // The public gate's TLS handshake can outlast any fixed delay — ask
        // only once the room has answered the hello.
        ws.send(JSON.stringify({ v: 1, t: "frame", payload: { op: "fleet.detail" } }));
        return;
      }
      if (m.t === "frame" && m.payload?.op === "fleet.detail.result") { clearTimeout(timer); ws.close(); resolve(sanitizeFleet(m.payload)); }
      if (m.t === "frame" && m.payload?.op === "error") { clearTimeout(timer); ws.close(); reject(new Error(m.payload.message ?? m.payload.code)); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("không nối được gate")); };
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Raw-mode key watching: any handler may call stop; returns {stop}. */
function keyToClose(onClose, onKey) {
  if (!process.stdin.isTTY) return { stop() {} };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const onData = (b) => {
    const k = String(b);
    if (k === "q" || k === "\u0003") {
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("data", onData);
      onClose?.();
      if (process.stdin.isTTY) process.stdin.pause();
      return;
    }
    onKey?.(k);
  };
  process.stdin.on("data", onData);
  return { stop() { process.stdin.removeListener("data", onData); process.stdin.setRawMode?.(false); } };
}

const cmd = process.argv[2] ?? "";
const arg = process.argv[3] ?? "";
if (cmd === "--help" || cmd === "" || cmd === "help") {
  console.log(`${NAME} — mirror a herdgate room into this Herdr

  pair     pair into a room (env: HERDGATE_MIRROR_URL, HERDGATE_MIRROR_ROOM, HERDGATE_ACCOUNT_TOKEN|HERDGATE_MIRROR_TOKEN, HERDGATE_MIRROR_SCOPE=read|act)
  status   JSON: pairing state (secrets masked)
  pane     the fleet sidebar (q đóng · r làm mới; --once vẽ một khung rồi thoát)
  stream   mirror one remote pane: stream <paneId> (typing cần act + HERDGATE_MIRROR_TYPE=1)
  watch    reconcile workspace 🏠 <room> + tab M:<paneId> per remote pane (--once một vòng; --stop dọn sạch)`);
  process.exit(0);
}
const commands = { pair: cmdPair, status: cmdStatus, pane: () => cmdPane(arg === "--once"), stream: () => cmdStream(arg), watch: () => cmdWatch(process.argv.slice(3)) };
try {
  await commands[cmd]?.();
} catch (e) {
  console.error(`${NAME}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
