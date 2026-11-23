// herdgate PWA — the device side of the gate.
//
// What it does: signs in with an account token, lists the machines (rooms) that account
// has, manages a separate pairing per machine, and shows
// the read-only view the host publishes.
//
// House rules it respects:
//   - the cloud routes opaque payloads, so the *host* decides what an op means; this client
//     only ever asks for `{op:"view"}` and `{op:"ping"}`, and shows what comes back;
//   - every string from the wire is rendered with `textContent`, never `innerHTML`;
//   - the token lives in localStorage on this device and is never sent anywhere but the
//     cloud's own WS endpoint.

const BUILD = "v0.9.34-web.3";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "herdgate.token";
const CLOUD_KEY = "herdgate.cloud";
const DEVICE_KEY = "herdgate.device";
const DEVICE_SECRET_KEY = "herdgate.deviceSecret";
const PAIRS_KEY = "herdgate.roomPairs";

function roomPairs() {
  try { return new Map(JSON.parse(localStorage.getItem(PAIRS_KEY) ?? "[]")); }
  catch { return new Map(); }
}

function savePair(roomId, pair) {
  const pairs = roomPairs();
  if (pair) pairs.set(roomId, pair);
  else pairs.delete(roomId);
  localStorage.setItem(PAIRS_KEY, JSON.stringify([...pairs]));
}

function clearLegacyPair() {
  localStorage.removeItem(DEVICE_KEY);
  localStorage.removeItem(DEVICE_SECRET_KEY);
}

import { DeviceChannel, generateKeyPair, needsRekey } from "/e2e.js";
import { hgFuzzy } from "/fuzzy.js";

// E2E payloads: this device's Noise_XX identity (kept locally, never sent to the cloud
// in the clear) and the host fingerprints it has pinned (TOFU per room).
const E2E_KEY = "herdgate.e2ekey";
const e2eFpKey = (roomId) => `herdgate.e2efp.${roomId}`;

async function e2eSelfKey() {
  try {
    const v = JSON.parse(localStorage.getItem(E2E_KEY) ?? "null");
    if (v?.jwk?.kty === "EC" && typeof v.pub === "string") return { jwk: v.jwk, pub: e2eB64d(v.pub) };
  } catch {
    /* mint below */
  }
  const self = await generateKeyPair();
  localStorage.setItem(E2E_KEY, JSON.stringify({ jwk: self.jwk, pub: e2eB64e(self.pub) }));
  return self;
}
function e2eB64e(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function e2eB64d(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Per-room channel state; reset when the socket drops. The channel only carries
// traffic after the host's `e2e.ready` ack — nothing may race the handshake's
// last step, or the transport counters desync for good.
const e2e = { ch: null, initing: false, ready: false, verified: false, epoch: 0, keyChanged: false, beganAt: 0 };
const pinnedHost = () => state.deviceRoom && localStorage.getItem(e2eFpKey(state.deviceRoom));
function e2eReset() {
  e2e.epoch++;
  e2e.ch = null;
  e2e.initing = false;
  e2e.ready = false;
  e2e.verified = false;
  e2e.keyChanged = false;
  e2e.beganAt = 0;
}

/** Begin (or restart) the Noise_XX handshake with this room's host. */
async function e2eBegin() {
  if (e2e.ready || e2e.initing || e2e.keyChanged || Date.now() - e2e.beganAt < 5000) return;
  if (!(state.deviceSecret && state.deviceId && state.roomId)) return;
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const epoch = e2e.epoch;
  e2e.initing = true;
  e2e.beganAt = Date.now();
  try {
    const self = await e2eSelfKey();
    const ch = new DeviceChannel(self);
    const init = await ch.begin();
    if (epoch !== e2e.epoch) return;
    e2e.ch = ch;
    send({ t: "frame", payload: { op: "e2e.init", e: init.e } });
  } catch {
    // A pinned room stays closed to plaintext even if WebCrypto is unavailable.
  } finally {
    if (epoch === e2e.epoch) e2e.initing = false;
  }
}

/** Rotate the Noise session when a lifetime bound is hit (Paseo: handshake
 *  lifetime). A fresh handshake swaps both directional keys and resets the
 *  counters, fencing forward secrecy to the slice since the last rotation.
 *  Runs after sends; the receive path checks on every inbound ciphertext. */
function maybeRotateE2e() {
  if (!e2e.ready || e2e.initing || e2e.keyChanged) return;
  const ch = e2e.ch;
  if (!ch?.ready() || !needsRekey(ch)) return;
  console.info("e2e: rotating session (lifetime bound)");
  e2eReset();
  void e2eBegin();
}

// Resume bookkeeping: where this device stopped reading each room's stream, so a
// reconnect can replay what it missed. Keyed per room; cleared when the cloud
// says the stream's generation moved (gateway restart) or the state went stale.
const streamKey = (roomId) => `herdgate.stream.${roomId}`;
function loadStream(roomId) {
  if (!roomId) return null;
  try {
    const v = JSON.parse(localStorage.getItem(streamKey(roomId)) ?? "null");
    return v && typeof v.gen === "string" && typeof v.seq === "number" && v.seq >= 0 ? v : null;
  } catch {
    return null;
  }
}
function saveStream(roomId, gen, seq) {
  if (!roomId || typeof gen !== "string" || typeof seq !== "number" || seq < 0) return;
  localStorage.setItem(streamKey(roomId), JSON.stringify({ gen, seq }));
}
function clearStream(roomId) {
  if (roomId) localStorage.removeItem(streamKey(roomId));
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  cloud: localStorage.getItem(CLOUD_KEY) ?? "",
  deviceId: localStorage.getItem(DEVICE_KEY) ?? "",
  deviceSecret: localStorage.getItem(DEVICE_SECRET_KEY) ?? "",
  deviceRoom: null,
  pairRoom: null,
  pairSocket: null,
  ws: null,
  hello: null,
  roomId: null,
  view: null,
  viewError: null,
  roomUi: null,
  terms: null,
  termTarget: null,
  termAnsi: null,
  termTimer: null,
  termBody: null,
  termPre: null,
  retry: 0,
  worker: { health: null, jobs: new Map(), error: null, search: null, searchError: null, tab: "jobs", usage: null, chatError: null, bodyError: null, draft: null, enrich: null, files: { tree: null, total: 0, capped: false, loading: false, error: null, query: "", open: null, text: null, lines: 0, truncated: false, goto: null, search: "" }, review: { scope: "uncommitted", files: null, base: null, capped: false, loading: false, error: null, open: null, diff: null, truncated: false, comments: {}, boxLine: null, sending: false, sent: null } },
  diff: null,
  chat: { filter: null, spawn: null },
};

// ---- fetch discipline: generation tokens + in-flight sharing ----------------
// Every rendered fetch is fenced by the generation of the view that asked for
// it (a fresh uuid per room mount). A reply answering an older generation is
// dropped on arrival — it can never overwrite newer state. Identical calls
// already in flight are joined instead of re-sent; `fresh: true` marks a read
// that must start AFTER writes that already left, so it never joins an older
// flight. Transport-level failures keep the last snapshot and raise a banner —
// a list never silently blanks.

const OP_TIMEOUT_MS = 15_000;
const fetches = { gen: "", inflight: new Map(), pending: new Map() };

/** A local fault marker (never a wire op): transport loss, a late host, or a
 *  flight superseded by a fresher read. Callers keep their snapshot and say so. */
function faultOf(p) {
  return p && typeof p === "object" && typeof p.fault === "string" ? p.fault : null;
}
const isTransportFault = (p) => {
  const fault = faultOf(p);
  return fault === "transport" || fault === "fetch-timeout";
};
const USAGE_ERR_CODES = new Set(["usage-unavailable", "usage.rollup"]);
const SEARCH_ERR_CODES = new Set(["pi_receipts_disabled", "receipt.search"]);
const BODY_ERR_CODES = new Set(["pi_receipts_disabled", "pi_receipt_body_disabled", "receipt.body"]);

function cryptoUUID() {
  const uuid = globalThis.crypto?.randomUUID; // globalThis: no ReferenceError where crypto is absent
  return typeof uuid === "function" ? uuid.call(globalThis.crypto) : `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A fresh generation per view mount; replies from older ones fall into the void. */
function newGeneration() {
  fetches.gen = cryptoUUID();
  return fetches.gen;
}
function currentGeneration() {
  return fetches.gen || newGeneration();
}
function generationCurrent(gen) {
  return gen === fetches.gen;
}

function transportOpen() {
  return Boolean(state.ws?.readyState === WebSocket.OPEN && state.roomId && !e2e.keyChanged);
}

/**
 * One fenced op call. The same op already flying under the same generation is
 * joined rather than re-sent (one wire call, many surfaces); `fresh: true`
 * refuses to join a flight that started before the caller's writes — the older
 * flight is superseded instead. Host refusals resolve as `{op:"error"}`
 * payloads; transport faults resolve with a local `{fault}` marker so callers
 * keep their snapshot and say so.
 */
function opFetch(op, replyOp, payload = {}, { fresh = false, key = op, errCodes = null } = {}) {
  const gen = currentGeneration();
  const flying = fetches.inflight.get(key);
  if (flying && flying.gen === gen && (!fresh || flying.fresh)) return flying.promise;
  if (flying) finishFetch(flying, { fault: "superseded", message: "một lượt đọc mới hơn đã thay thế lượt này" });
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const entry = { key, op, replyOp, gen, fresh, promise, errCodes, settle, timer: 0 };
  fetches.inflight.set(key, entry);
  const stack = fetches.pending.get(replyOp) ?? [];
  stack.push(entry);
  fetches.pending.set(replyOp, stack);
  entry.timer = setTimeout(
    () => finishFetch(entry, { fault: "fetch-timeout", message: "máy không trả lời kịp — giữ dữ liệu gần nhất" }),
    OP_TIMEOUT_MS,
  );
  if (transportOpen()) sendPayload({ op, ...payload });
  else finishFetch(entry, { fault: "transport", message: "mất kết nối tới máy — giữ dữ liệu gần nhất" });
  return promise;
}

function finishFetch(entry, payload) {
  clearTimeout(entry.timer);
  if (fetches.inflight.get(entry.key) === entry) fetches.inflight.delete(entry.key);
  const stack = fetches.pending.get(entry.replyOp);
  const at = stack ? stack.indexOf(entry) : -1;
  if (at !== -1) stack.splice(at, 1);
  entry.settle(payload);
}

/** Hand an inbound payload to the waiting fetch, if any. True = consumed: the
 *  surface that asked applies the answer itself, after its generation check. */
function routeFencedReply(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.op !== "string") return false;
  let consumed = false;
  if (payload.op !== "error") {
    const entry = fetches.pending.get(payload.op)?.shift();
    if (entry) {
      finishFetch(entry, payload);
      consumed = true;
    }
  } else if (typeof payload.code === "string") {
    for (const stack of fetches.pending.values()) {
      for (const entry of [...stack]) {
        if (entry.errCodes?.has(payload.code)) {
          finishFetch(entry, payload);
          consumed = true;
        }
      }
    }
  }
  return consumed;
}

/** The socket died: every waiting fetch keeps its caller's snapshot and hears why. */
function failAllFencedFetches(message) {
  for (const stack of [...fetches.pending.values()]) {
    for (const entry of [...stack]) finishFetch(entry, { fault: "transport", message });
  }
}

/** The cloud base: an explicit setting, else this page's origin (same-origin deployment). */
function cloudBase() {
  const raw = (state.cloud || location.origin).replace(/\/$/, "");
  return raw;
}

function wsUrl() {
  return `${cloudBase().replace(/^http/, "ws")}/v1/device/ws`;
}

// ---- tiny DOM helpers (no innerHTML anywhere) ------------------------------

function show(id, on) {
  $(id).hidden = !on;
}
function text(id, value) {
  $(id).textContent = value ?? "";
}
function setStatus(label, kind) {
  const el = $("status");
  el.textContent = label;
  el.dataset.kind = kind ?? "";
}

function showError(id, message) {
  const el = $(id);
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

// ---- screens ---------------------------------------------------------------

function render() {
  const signedIn = Boolean(state.token);
  show("signin", !signedIn);
  show("rooms", signedIn && !state.roomId && !state.pairRoom);
  show("room", signedIn && Boolean(state.roomId) && !state.pairRoom);

  if (signedIn && !state.roomId) renderRooms();
  if (state.roomId) renderRoom();
}

function renderRooms() {
  const list = $("room-list");
  list.replaceChildren();
  const agents = state.hello?.agents ?? [];
  const pairs = roomPairs();
  show("rooms-empty", agents.length === 0);

  for (const room of agents) {
    const node = $("room-row").content.cloneNode(true);
    node.querySelector(".name").textContent = room.name || room.roomId;
    const meta = [];
    meta.push(room.online ? "online" : "offline");
    const scope = pairs.get(room.roomId)?.scope;
    if (scope) meta.push(`paired · ${scope}`);
    node.querySelector(".meta").textContent = meta.join(" · ");
    node.querySelector(".row").dataset.roomId = room.roomId;
    node.querySelector(".rowbtn").addEventListener("click", () => {
      const pairing = roomPairs().get(room.roomId);
      if (pairing) selectRoom(room.roomId, pairing);
      else openPair(room.roomId);
    });
    list.append(node);
  }
}

function renderRoom() {
  if (!state.roomId) return;
  const room = (state.hello?.agents ?? []).find((r) => r.roomId === state.roomId);
  text("room-name", room?.name || state.roomId);
  text("room-state", room ? (room.online ? "host online" : "host offline") : "unknown room");

  // E2E status: the pinned host fingerprint, or a loud note when it changed.
  const e2eNote = $("e2e-note");
  const pinned = state.roomId ? localStorage.getItem(e2eFpKey(state.roomId)) : null;
  const current = e2e.verified ? e2e.ch.hostFingerprint : null;
  if (e2e.keyChanged) {
    e2eNote.hidden = false;
    e2eNote.className = "error small";
    e2eNote.textContent = "Host key changed. Pane data is blocked. Verify the key with the host administrator.";
  } else if (current || pinned) {
    e2eNote.hidden = false;
    e2eNote.className = "muted small";
    e2eNote.textContent = current ? `end-to-end encrypted · host key ${current}` : "Waiting for an encrypted connection to the pinned host…";
  } else {
    e2eNote.hidden = true;
  }

  if (!state.roomUi) {
    const summary = document.createElement("div");
    const live = document.createElement("div");
    const worker = document.createElement("div");
    const controls = document.createElement("div");
    $("view").replaceChildren(summary, live, worker, controls);
    const updateSshHint = renderRoomControls(controls);
    const updateWorker = renderWorkerBox(worker);
    state.roomUi = { summary, live, worker, controls, updateSshHint, updateWorker };
  }
  const ui = state.roomUi;
  const online = Boolean(room?.online);
  if (ui.online !== online || ui.view !== state.view || ui.error !== state.viewError) {
    ui.online = online;
    ui.view = state.view;
    ui.error = state.viewError;
    ui.summary.replaceChildren();
    renderHostView(ui.summary, room);
  }
  const { live, updateSshHint, updateWorker } = ui;
  renderLiveTerminals(live, online);
  updateWorker?.(online);
  updateSshHint?.();
}

function renderHostView(box, room) {
  if (!room?.online) {
    box.append(note("The host is not connected. Start its publisher — in Herdr, press Publish."));
    return;
  }
  if (state.viewError) {
    box.append(note(state.viewError, "error"));
    return;
  }
  if (!state.view) {
    box.append(note("Waiting for the host…"));
    return;
  }

  const v = state.view;
  const summary = v.summary ?? v;
  if (!summary || typeof summary !== "object") {
    box.append(note("The host answered something this app does not understand."));
    return;
  }

  const grid = document.createElement("dl");
  grid.className = "grid";
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    grid.append(dt, dd);
  };
  add("herdr", summary.herdr);
  add("spaces", summary.workspaces);
  add("agents", summary.agents);
  add("working", summary.working);
  add("blocked", summary.blocked);
  box.append(grid);

  if (Array.isArray(summary.labels) && summary.labels.length > 0) {
    const list = document.createElement("ul");
    list.className = "chips";
    for (const label of summary.labels) {
      const li = document.createElement("li");
      li.textContent = String(label);
      list.append(li);
    }
    box.append(list);
  }
  if (v.takenAt) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `as of ${new Date(v.takenAt).toLocaleTimeString()}`;
    box.append(p);
  }
}

function renderLiveTerminals(box, online) {
  box.hidden = !online;
  if (online && !state.termBody) {
    const tblock = document.createElement("details");
    tblock.className = "terms";
    const ts = document.createElement("summary");
    ts.textContent = "Live terminals — this machine's panes, read-only";
    tblock.append(ts);
    const tbody = document.createElement("div");
    tbody.className = "termbody";
    tblock.append(tbody);
    tblock.addEventListener("toggle", () => {
      if (tblock.open && !state.terms) sendPayload({ op: "term.list" });
    });
    box.append(tblock);
    state.termBody = tbody;
    renderTerms();
  }
}

// ---- Pi worker panel (experimental) -----------------------------------------
// Submit/health/status against the host's opt-in worker queue (HERDGATE_PI_WORKER=1)
// plus per-request receipt watches: the settle report pushes back, no polling loop.

const WORKER_ERROR_CODES = new Set([
  "pi_worker_disabled", "requires-act", "bad-prompt", "bad-workspace", "queue-full", "worker-queue",
  "receipt.watch", "pi_receipts_disabled", "pi_receipt_body_disabled",
]);

// Diff/pane refusals are scoped the same way: they fault one view, never the room.
const DIFF_ERROR_CODES = new Set(["bad-ref", "diff", "diff.ref", "diff.repo"]);
const PANE_ERROR_CODES = new Set(["pane.focus", "bad-pane"]); // no surface yet — swallow, never blank the room
// Attachment refusals fault the 📎 pick only — the composer and its draft stay.
const ATTACH_ERROR_CODES = new Set(["attachment"]);

/** One transient line at the bottom of the screen — upload refusals and reader
 *  faults say so without blanking any view. Gone on its own after a few seconds. */
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 5_000);
}

// Recap answers "đến lượt ai?" — whose move it is — for every tracked job; Usage
// rolls the host's receipt journal into daily and per-principal tables.
const RECAP_GROUPS = [
  { key: "working", title: "Working" },
  { key: "needs-you", title: "Needs you" },
  { key: "fixing", title: "Needs fixing" },
  { key: "done", title: "Done" },
];

function recapBucket(job) {
  const opened = typeof job.body === "string"; // the report was opened on this device
  if (job.status === "queued" || job.status === "running" || job.status === "pending") return "working";
  if (job.status === "failed") return "fixing";
  if (job.status === "replied") return opened || job.duplicate ? "done" : "needs-you";
  return "done"; // canceled or unknown verdicts — nothing waits on us
}

// Herdr's status glyphs — one verdict per row in every list (Recap, Jobs/Receipts,
// Search): ◉ needs you (an unopened reply, an unknown or failed request),
// ◐ working, ● done (replied and read), ✓ idle (nothing waits on anyone).
function statusGlyph(job) {
  const status = job?.status;
  if (status === "queued" || status === "running" || status === "pending") return { glyph: "◐", cls: "glyph-working", title: "working" };
  if (status === "unknown" || status === "failed") return { glyph: "◉", cls: "glyph-needs", title: status === "failed" ? "needs fixing" : "needs you" };
  if (status === "replied") {
    const opened = typeof job.body === "string" || job.duplicate || job.opened === true;
    return opened ? { glyph: "●", cls: "glyph-done", title: "done" } : { glyph: "◉", cls: "glyph-needs", title: "needs you" };
  }
  return { glyph: "✓", cls: "glyph-idle", title: "idle" }; // canceled — nothing waits on us
}

function glyphNode(job) {
  const g = statusGlyph(job);
  const span = document.createElement("span");
  span.className = `glyph ${g.cls}`;
  span.textContent = g.glyph;
  span.title = g.title;
  return span;
}

const usageUsd = (value) => `$${(Number.isFinite(value) ? value : 0).toFixed(4)}`;
const usageClock = (ts) => {
  const at = new Date(ts);
  return Number.isFinite(at.getTime())
    ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    : "";
};

// ---- receipt.enrich: the detail panel under a receipt row ---------------------
// Transcript facts for one receipt (model · context · turns · usage · last
// activity). The context bar only renders when a real window cap is known —
// the host never sends one and we do not invent thresholds, so
// CONTEXT_WINDOW_MAX stays null and the tokens render bare.
const CONTEXT_WINDOW_MAX = null;

/** 12345 -> "12,345" without betting the runtime on ICU locale data. */
const fmtTokens = (n) => (Number.isFinite(n) && n >= 0 ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : null);

/** Context fill % against a known cap; null without one (never a guessed bar). */
function contextPctOf(tokens, max = CONTEXT_WINDOW_MAX) {
  if (!Number.isFinite(tokens) || !(tokens >= 0) || !Number.isFinite(max) || !(max > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((tokens / max) * 100)));
}

/** receipt.enrich.result → the panel's display rows (string-or-null; null hides). */
function enrichRows(result) {
  const r = result && typeof result === "object" ? result : {};
  const ctx = Number.isFinite(r.contextTokens) ? r.contextTokens : null;
  const pct = contextPctOf(ctx);
  const u = r.usageTotal && typeof r.usageTotal === "object" ? r.usageTotal : {};
  const usageTokens = fmtTokens(u.totalTokens);
  return {
    model: typeof r.model === "string" && r.model ? r.model : null,
    context: ctx !== null ? `${fmtTokens(ctx)} tokens${pct !== null ? ` · ${pct}%` : ""}` : null,
    contextPct: pct,
    turns: Number.isFinite(r.turns) ? String(r.turns) : null,
    usage: usageTokens !== null ? `${usageTokens} tokens${Number.isFinite(u.costUsd) ? ` · ${usageUsd(u.costUsd)}` : ""}` : null,
    last: Number.isFinite(r.lastTs) ? usageClock(r.lastTs) : null,
  };
}

function renderWorkerRecap(box, w) {
  box.replaceChildren();
  const buckets = new Map(RECAP_GROUPS.map((group) => [group.key, []]));
  for (const job of w.jobs.values()) {
    buckets.get(recapBucket(job))?.push(job);
  }
  let shown = 0;
  for (const group of RECAP_GROUPS) {
    const items = buckets.get(group.key);
    if (!items || items.length === 0) continue; // empty groups stay hidden
    shown += items.length;
    const head = document.createElement("p");
    head.textContent = `${group.title} (${items.length})`;
    const list = document.createElement("ul");
    list.className = "list";
    for (const job of items) {
      const row = document.createElement("li");
      row.className = "row";
      const span = document.createElement("span");
      span.textContent = `${job.id.slice(0, 8)} · ${job.status}${job.reason ? ` (${job.reason})` : ""}`;
      row.append(span, glyphNode(job));
      attachReceiptDetail(row, job.id);
      list.append(row);
    }
    box.append(head, list);
  }
  if (shown === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "no jobs yet — submit one from the Jobs tab";
    box.append(empty);
    return;
  }
  const u = w.usage;
  const today = !u || u.unavailable ? null : (Array.isArray(u.days) ? u.days[0] : null);
  if (today && (today.requests ?? 0) > 0) {
    const line = document.createElement("p");
    line.className = "muted small";
    line.textContent = `hôm nay: ${today.requests ?? 0} requests, ${today.tokens ?? 0} tokens, ${usageUsd(today.costUsd)}`;
    box.append(line);
  }
}

function renderWorkerUsage(box, w, online) {
  box.replaceChildren();
  const fetchUsage = document.createElement("button");
  fetchUsage.type = "button";
  fetchUsage.textContent = "Fetch usage";
  fetchUsage.addEventListener("click", () => fetchChatUsage(true));
  box.append(fetchUsage);
  const line = (text) => {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = text;
    box.append(p);
  };
  if (!online) {
    line("host offline");
    return;
  }
  const u = w.usage;
  if (!u) {
    line("7-day roll-up over the host's receipt journal.");
    return;
  }
  if (u.unavailable) {
    line("usage unavailable on this host");
    return;
  }
  const rowOf = (tag, cells) => {
    const tr = document.createElement("tr");
    for (const value of cells) {
      const cell = document.createElement(tag);
      cell.textContent = String(value);
      tr.append(cell);
    }
    return tr;
  };
  const days = document.createElement("table");
  days.className = "usage-days";
  days.append(rowOf("th", ["date", "req", "replied", "failed", "tokens", "$"]));
  for (const day of Array.isArray(u.days) ? u.days : []) {
    days.append(rowOf("td", [day.date, day.requests ?? 0, day.replied ?? 0, day.failed ?? 0, day.tokens ?? 0, usageUsd(day.costUsd)]));
  }
  const byPrincipal = document.createElement("table");
  byPrincipal.className = "usage-principals";
  byPrincipal.append(rowOf("th", ["principal", "req", "tokens", "$", "last"]));
  for (const p of Array.isArray(u.byPrincipal) ? u.byPrincipal : []) {
    byPrincipal.append(rowOf("td", [p.principal, p.requests ?? 0, p.tokens ?? 0, usageUsd(p.costUsd), usageClock(p.lastTs)]));
  }
  box.append(days, byPrincipal);
}

// Chat (the Timeline tab, re-imagined as threads): one thread per session over
// data the host already serves. A locally submitted job is a session this device
// knows end-to-end — prompt bubble, folded tool-run receipt events, reply bubble.
// Background spawn principals roll up into Delegation cards (name + status +
// tokens); clicking one filters the chat to that subagent. Anything the data
// lacks simply does not render — no spinners, no invented rows.
function renderWorkerChat(box, w, online) {
  box.replaceChildren();
  const head = document.createElement("p");
  head.textContent = "Chat — mỗi session một thread";
  const again = document.createElement("button");
  again.type = "button";
  again.className = "link";
  again.textContent = "tải lại";
  again.addEventListener("click", () => fetchChatUsage(true));
  box.append(head, again);
  if (w.chatError) box.append(note(w.chatError, "error")); // transport fault: the data below stays
  const u = w.usage;
  const today = !u || u.unavailable ? null : (Array.isArray(u.days) ? u.days[0] : null);
  if (today && (today.requests ?? 0) > 0) {
    const line = document.createElement("p");
    line.className = "muted small";
    line.textContent = `hôm nay: ${today.requests ?? 0} requests, ${today.tokens ?? 0} tokens, ${usageUsd(today.costUsd)}`;
    box.append(line);
  }
  // Delegation cards — one per background `spawn:<id>` principal in the roll-up.
  const byPrincipal = !u || u.unavailable ? [] : (Array.isArray(u.byPrincipal) ? u.byPrincipal : []);
  const spawns = byPrincipal.filter((p) => /^spawn:[A-Za-z0-9._-]{1,64}$/.test(String(p.principal ?? "")));
  if (spawns.length) {
    const cards = document.createElement("div");
    cards.className = "subagent-cards";
    for (const s of spawns) cards.append(subagentCard(s, online));
    box.append(cards);
  }
  const filter = state.chat.filter;
  if (filter) box.append(spawnThread(filter, online));
  const jobs = [...w.jobs.values()].filter((job) => !filter || job.principal === filter).slice(-12).reverse();
  const threads = document.createElement("div");
  threads.className = "threads";
  for (const job of jobs) threads.append(chatThread(job));
  box.append(threads);
  if (!jobs.length) {
    box.append(note(filter
      ? `không có session nào của ${filter} trên máy này`
      : "chưa có session nào — gửi một job từ tab Jobs", "muted"));
  }
}

function subagentStatus(p) {
  if (Number.isFinite(p.lastTs) && Date.now() - p.lastTs < 5 * 60_000) return "running";
  const failed = p.failed ?? 0;
  return failed > 0 ? `failed ×${failed}` : `done ×${p.replied ?? 0}`;
}

/** A Delegation card for one `spawn:<id>` principal: name, status, tokens.
 *  Click filters the chat to that subagent (and fetches its receipts). */
function subagentCard(s, online) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "subagent" + (state.chat.filter === s.principal ? " active" : "");
  const name = document.createElement("span");
  name.className = "subagent-name";
  name.textContent = s.principal.slice("spawn:".length);
  const status = document.createElement("span");
  status.className = "subagent-status";
  status.textContent = subagentStatus(s);
  const tokens = document.createElement("span");
  tokens.className = "subagent-tokens";
  tokens.textContent = `${s.tokens ?? 0} tokens · ${usageUsd(s.costUsd)}`;
  card.append(name, status, tokens);
  card.addEventListener("click", () => {
    state.chat.filter = state.chat.filter === s.principal ? null : s.principal;
    if (state.chat.filter) fetchSpawnReceipts(state.chat.filter);
    state.roomUi?.updateWorker?.(online);
  });
  return card;
}

/** The filtered view of one subagent: its receipts, listed like tool-runs. */
function spawnThread(principal, online) {
  const box = document.createElement("div");
  box.className = "spawn-thread";
  const head = document.createElement("p");
  head.textContent = `Delegation · ${principal}`;
  box.append(head);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "link";
  clear.textContent = "bỏ lọc";
  clear.addEventListener("click", () => {
    state.chat.filter = null;
    state.roomUi?.updateWorker?.(online);
  });
  box.append(clear);
  const spawn = state.chat.spawn?.principal === principal ? state.chat.spawn : null;
  if (spawn?.error) box.append(note(spawn.error, "error")); // transport: the hits above stay
  if (spawn?.settled) {
    if (Array.isArray(spawn.hits) && spawn.hits.length) {
      const rows = document.createElement("ul");
      rows.className = "list";
      for (const hit of spawn.hits) {
        const row = document.createElement("li");
        row.className = "row";
        const span = document.createElement("span");
        span.textContent = `${hit.id.slice(0, 8)} · ${hit.status}${hit.reason ? ` (${hit.reason})` : ""} · ${hit.usage?.totalTokens ?? 0} tokens`;
        row.append(span, glyphNode(hit));
        rows.append(row);
      }
      box.append(rows);
    } else if (!spawn.error) {
      box.append(note("chưa có receipt nào của subagent này", "muted"));
    }
  } else {
    box.append(note("đang tải receipts của subagent…", "muted"));
  }
  return box;
}

/** One session: user prompt → folded tool-run receipt events → assistant reply. */
function chatThread(job) {
  const thread = document.createElement("div");
  thread.className = "thread";
  if (job.prompt) {
    const user = document.createElement("div");
    user.className = "msg user";
    user.textContent = job.prompt;
    thread.append(user);
  }
  const events = Array.isArray(job.events) ? job.events : [];
  if (events.length) {
    // tool-run FOLD: one muted line; click opens the run underneath it.
    const fold = document.createElement("details");
    fold.className = "fold toolrun";
    const sum = document.createElement("summary");
    sum.textContent = `⚙ tool-run · receipt ${job.id.slice(0, 8)} · ${events.length} sự kiện`;
    fold.append(sum);
    const body = document.createElement("div");
    body.className = "folddetail";
    for (const ev of events) {
      const line = document.createElement("div");
      line.className = "toolevent";
      line.textContent = `${usageClock(ev.at)} · ${ev.status}${ev.reason ? ` (${ev.reason})` : ""}${ev.tokens ? ` · ${ev.tokens} tokens` : ""}`;
      body.append(line);
    }
    fold.append(body);
    thread.append(fold);
  }
  const reply = document.createElement("div");
  reply.className = "msg assistant";
  if (typeof job.body === "string") {
    appendLinkedText(reply, job.body); // `path:line` in a reply jumps into the Diff view
  } else if (job.body && typeof job.body === "object") {
    reply.textContent = `report not available (${job.body.reason ?? "unavailable"})`;
  } else {
    const line = document.createElement("span");
    line.textContent = `${job.status ?? "unknown"}${job.reason ? ` (${job.reason})` : ""}`;
    reply.append(glyphNode(job), line);
  }
  thread.append(reply);
  return thread;
}

const PATH_LINE_RE = /((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})(?::(\d{1,7})(?:-\d{1,7})?|#L\d{1,7}(?:-L?\d{1,7})?)/g;

/** Text with `path:line` tokens becomes text nodes + jump links (no innerHTML). */
function appendLinkedText(box, text) {
  const src = String(text ?? "");
  let at = 0;
  for (const m of src.matchAll(PATH_LINE_RE)) {
    box.append(src.slice(at, m.index));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link pathline";
    btn.textContent = m[0];
    btn.addEventListener("click", () => gotoDiffLine(m[0]));
    box.append(btn);
    at = m.index + m[0].length;
  }
  box.append(src.slice(at));
}

/** usage.rollup behind the fence: the Chat and Usage surfaces share one flight. */
function fetchChatUsage(fresh = false) {
  const gen = currentGeneration();
  opFetch("usage.rollup", "usage.rollup.result", { days: 7 }, { key: "chat-usage", fresh, errCodes: USAGE_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return; // a newer mount owns the screen now
      if (faultOf(p) === "superseded") return; // a fresher flight replaces this one
      if (isTransportFault(p)) {
        state.worker.chatError = p.message; // the snapshot below stays
      } else if (p.op === "error") {
        state.worker.usage = { unavailable: true }; // scoped refusal, not a transport fault
        state.worker.chatError = null;
      } else {
        state.worker.usage = p;
        state.worker.chatError = null;
      }
      state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    });
}

/** Receipt search behind the fence; a transport fault keeps the last hits. */
function fetchReceiptSearch(query) {
  const gen = currentGeneration();
  opFetch("receipt.search", "receipt.search.result", { query, limit: 8 }, { key: "search", fresh: true, errCodes: SEARCH_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      if (faultOf(p) === "superseded") return;
      if (isTransportFault(p)) {
        state.worker.searchError = p.message; // the hit list stays
      } else if (p.op === "error") {
        state.worker.search = { hits: [], reason: p.code };
        state.worker.searchError = null;
      } else {
        state.worker.search = { hits: Array.isArray(p.hits) ? p.hits : [], reason: p.reason ?? null };
        state.worker.searchError = null;
      }
      state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    });
}

/** One retained report behind the fence; a transport fault leaves the rows as they were. */
function fetchReceiptBody(id) {
  const gen = currentGeneration();
  opFetch("receipt.body", "receipt.body.result", { id }, { key: `body:${id}`, errCodes: BODY_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      if (faultOf(p) === "superseded") return;
      if (isTransportFault(p)) {
        state.worker.bodyError = p.message; // rows keep their state, a banner says why
      } else {
        state.worker.bodyError = null;
        applyBodyResult(p); // a refusal is also an answer (report not available)
      }
    });
}

/** Receipt enrich behind the fence: transcript facts for the row's detail
 *  panel. A host refusal is also an answer — its message shows verbatim
 *  ("no readable transcript…" is data, not a bug to swallow); a transport
 *  fault keeps the shared never-blank banner instead of closing the panel. */
const ENRICH_ERR_CODES = new Set(["receipt.enrich", "pi_receipts_disabled"]);
const FILE_ERR_CODES = new Set(["diff.repo", "files.tree", "files.read", "bad-path", "no-file", "file.tree", "file.read"]);
const REVIEW_ERR_CODES = new Set(["diff.repo", "review", "bad-scope", "no-base", "no-anchor", "bad-path", "no-file"]);

function fetchReceiptEnrich(id) {
  state.worker.enrich = { id, loading: true, error: null, result: null };
  const online = () => Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online);
  const gen = currentGeneration();
  opFetch("receipt.enrich", "receipt.enrich.result", { id }, { key: `enrich:${id}`, errCodes: ENRICH_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      if (faultOf(p) === "superseded") return;
      const cur = state.worker.enrich;
      if (!cur || cur.id !== id) return; // another receipt owns the detail now
      if (isTransportFault(p)) {
        state.worker.enrich = { id, loading: false, error: p.message, result: null };
      } else if (p.op === "error") {
        state.worker.enrich = { id, loading: false, error: p.message ?? p.code ?? "receipt.enrich bị từ chối", result: null };
      } else if (typeof p.reason === "string") {
        state.worker.enrich = { id, loading: false, error: `receipt enrich không khả dụng (${p.reason})`, result: null };
      } else {
        state.worker.enrich = { id, loading: false, error: null, result: p };
      }
      state.roomUi?.updateWorker?.(online());
    });
  state.roomUi?.updateWorker?.(online());
}

/** Tap a receipt row → toggle its detail; opening one closes any other. */
function toggleReceiptEnrich(id) {
  if (state.worker.enrich?.id === id) state.worker.enrich = null;
  else fetchReceiptEnrich(id);
}

/** The detail expansion itself: loading line, verbatim refusal, or the facts. */
function receiptDetailNode(id) {
  const box = document.createElement("div");
  box.className = "receipt-detail";
  const e = state.worker.enrich;
  if (!e || e.id !== id) return box; // closed — the row stays a row
  if (e.loading) {
    box.append(note("đang tải chi tiết phiên…"));
    return box;
  }
  if (e.error) {
    box.append(note(e.error, "error")); // the host's words, kept visible
    return box;
  }
  const rows = enrichRows(e.result);
  const dl = document.createElement("dl");
  const add = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  };
  add("model", rows.model);
  add("context", rows.context);
  add("turns", rows.turns);
  add("usage", rows.usage);
  add("last", rows.last);
  box.append(dl);
  if (rows.contextPct !== null) { // only with a real cap — never a guessed bar
    const bar = document.createElement("div");
    bar.className = "ctxbar";
    const fill = document.createElement("i");
    fill.style.width = `${rows.contextPct}%`;
    bar.append(fill);
    box.append(bar);
  }
  return box;
}

/** A receipt row opens its detail on tap — anywhere except its own buttons. */
function attachReceiptDetail(row, id) {
  row.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    toggleReceiptEnrich(id);
    state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
  });
  row.append(receiptDetailNode(id));
}

/** Fold a receipt.body answer back into the job row and the search hit that asked. */
function applyBodyResult(payload) {
  workerJobTouched(payload.id, payload.text !== undefined
    ? { body: payload.text }
    : { body: { reason: payload.reason ?? payload.code ?? "unavailable" } });
  const s = state.worker.search;
  const hit = Array.isArray(s?.hits) ? s.hits.find((h) => h.id === payload.id) : null;
  if (hit) {
    hit.body = payload.text !== undefined ? payload.text : { reason: payload.reason ?? payload.code ?? "unavailable" };
    state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
  }
}

/** Receipts of one spawn principal (the Delegation filter's backing data). */
function fetchSpawnReceipts(principal) {
  const gen = currentGeneration();
  const prior = state.chat.spawn?.principal === principal ? state.chat.spawn : null;
  state.chat.spawn = { principal, settled: false, hits: prior?.hits ?? null, error: null };
  opFetch("receipt.search", "receipt.search.result", { query: principal, limit: 12 }, { key: `spawn:${principal}`, fresh: true, errCodes: SEARCH_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      if (faultOf(p) === "superseded") return;
      const keep = state.chat.spawn?.principal === principal ? state.chat.spawn : null;
      if (p.op === "error") {
        state.chat.spawn = { principal, settled: true, hits: [], error: `subagent search bị từ chối (${p.code})` };
      } else {
        const hits = (Array.isArray(p.hits) ? p.hits : []).filter((h) => h?.principal === principal);
        state.chat.spawn = { principal, settled: true, hits, error: null };
      }
      if (isTransportFault(p)) {
        state.chat.spawn = { principal, settled: true, hits: keep?.hits ?? null, error: p.message }; // the hits stay
      }
      state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    });
}

/** filev open_target `parse_line_suffix`, web form: `src/app.rs:42`, `:42-48`,
 *  `#L42`, `#L42-L48` → {path, line, end}. Null when the target names no file. */
function parseLineSuffix(target) {
  const m = /^(.+?)(?::(\d{1,7})(?:-(\d{1,7}))?|#L(\d{1,7})(?:-L?(\d{1,7}))?)$/.exec(String(target ?? "").trim());
  if (!m) return null;
  const path = m[1];
  if (!path || path.length > 512 || /\s/.test(path) || !/[A-Za-z\u00C0-\u024F]/.test(path)) return null;
  const line = Number(m[2] ?? m[4]);
  const end = Number(m[3] ?? m[5] ?? line);
  if (!(line >= 1) || end < line) return null;
  return { path, line, end };
}

function diffGotoPathMatches(file, path) {
  return file === path || file.endsWith(`/${path}`) || (!path.includes("/") && file.split("/").pop() === path);
}

/** Row indexes of `path:line(-end)` inside a unified diff's patch lines: walk
 *  the file headers, then each `@@ -a,b +c,d @@` hunk counting the NEW side.
 *  An absent path simply yields no rows — the caller says so, gently. */
function diffGotoIndexes(lines, goto) {
  if (!Array.isArray(lines) || !goto || !goto.path || !(goto.line >= 1)) return [];
  const file = goto.path;
  const end = Math.max(goto.line, goto.end ?? goto.line);
  const hits = [];
  let current = null;
  let newline = 0;
  let inHunk = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = String(lines[i] ?? "");
    if (t.startsWith("diff --git ")) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(t.trim());
      current = m ? m[2] : null;
      inHunk = false;
      continue;
    }
    if (current === null || !diffGotoPathMatches(current, file)) {
      inHunk = false;
      continue;
    }
    if (t.startsWith("@@")) {
      const m = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(t);
      newline = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (t.startsWith("-")) continue; // old-side only: it carries no new-side number
    if (newline >= goto.line && newline <= end) hits.push(i); // + and context rows alike
    newline += 1;
  }
  return hits;
}

/** Load a diff behind the fence. `goto` (a path:line deep-link) survives the
 *  round-trip; a transport fault restores the last good patch, never a blank. */
function loadDiff(ref, goto = null) {
  const prev = state.diff && typeof state.diff.text === "string" ? state.diff : null;
  state.diff = { ref, text: null, truncated: false, bytes: 0, error: null, loading: true, goto, prev };
  const gen = currentGeneration();
  opFetch("diff.get", "diff.result", { ref }, { key: "diff", fresh: true, errCodes: DIFF_ERROR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      if (faultOf(p) === "superseded") return;
      if (isTransportFault(p)) {
        // transport: keep the last good patch and say so — never a silent blank.
        const message = p.message;
        state.diff = prev
          ? { ...prev, error: message, loading: false }
          : { ref, text: null, truncated: false, bytes: 0, error: message, loading: false, goto };
      } else if (p.op === "error") {
        const message = p.message ?? p.code ?? "the host refused";
        state.diff = { ref, text: null, truncated: false, bytes: 0, error: message, loading: false, goto };
      } else {
        state.diff = {
          ref: typeof p.ref === "string" ? p.ref : ref,
          text: typeof p.text === "string" ? p.text : "",
          bytes: p.bytes ?? 0,
          truncated: p.truncated === true,
          error: null,
          loading: false,
          goto,
        };
      }
      state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    });
  state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
}

/** A `path:line` deep-link (Cmd+K palette or a chat-card link) → the Diff view. */
function gotoDiffLine(target) {
  const goto = parseLineSuffix(target);
  if (!goto) return false;
  state.openWorkerTab?.("diff");
  loadDiff(state.diff?.ref || "HEAD", goto);
  return true;
}

// ---- Files (filev): fuzzy find, read one, smartcase in-file search -------------

function fetchFileTree() {
  const w = state.worker.files;
  w.loading = true;
  const gen = currentGeneration();
  opFetch("file.tree", "file.tree.result", {}, { key: "file-tree", fresh: true, errCodes: FILE_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      w.loading = false;
      if (isTransportFault(p)) { w.error = p.message; return; }
      if (p.op === "error") { w.error = p.message; return; }
      w.error = null;
      w.tree = p.files ?? [];
      w.total = p.total ?? w.tree.length;
      w.capped = Boolean(p.capped);
    })
    .catch(() => { if (generationCurrent(gen)) { w.loading = false; w.error = "file.tree không trả lời"; } });
}

function openFileAt(path, goto) {
  const w = state.worker.files;
  state.openWorkerTab?.("files");
  w.open = path;
  w.text = null;
  w.error = null;
  w.goto = goto ?? null;
  w.search = "";
  const gen = currentGeneration();
  opFetch("file.read", "file.read.result", { path }, { key: `file-read:${path}`, fresh: true, errCodes: FILE_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen) || w.open !== path) return;
      if (isTransportFault(p)) { w.error = p.message; return; }
      if (p.op === "error") { w.error = p.message; return; }
      w.error = null;
      w.text = typeof p.text === "string" ? p.text : "";
      w.lines = p.lines ?? 0;
      w.truncated = Boolean(p.truncated);
    })
    .catch(() => { if (generationCurrent(gen) && w.open === path) w.error = "file.read không trả lời"; });
}

/** Render the Files surface into its slot: the fuzzy list, or the open file with
 *  line numbers, search highlighting and a path:line flash. Wire-only — the
 *  scoring lives in /fuzzy.js, the hardening on the host. */
function renderWorkerFiles(out, w) {
  out.replaceChildren();
  if (w.error) {
    out.append(note(w.error, "error"));
    const back = document.createElement("button");
    back.type = "button";
    back.className = "link";
    back.textContent = "← danh sách file";
    back.addEventListener("click", () => { const f = state.worker.files; f.error = null; f.open = null; f.text = null; });
    out.append(back);
    return;
  }
  if (w.open) {
    renderFileBody(out, w);
    return;
  }
  if (w.loading) {
    out.append(note("đang đọc cây file…"));
    return;
  }
  if (!w.tree) {
    out.append(note("chưa có cây file — mở tab Files khi host online."));
    return;
  }
  const paths = w.tree.map((f) => f.path);
  const statusOf = new Map(w.tree.map((f) => [f.path, f.status]));
  const ranked = w.query ? hgFuzzy.matchAndRank(w.query, paths) : paths.map((_, i) => i);
  const shown = ranked.slice(0, 100).map((i) => w.tree[i]);
  if (w.capped) out.append(note(`cây bị giới hạn ${w.tree.length}/${w.total} file — tìm mờ để lọc.`));
  const list = document.createElement("ul");
  list.className = "files-list";
  for (const f of shown) {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    const mark = document.createElement("span");
    mark.className = `fstat ${f.status ? "fstat-" + f.status[0] : ""}`;
    mark.textContent = f.status ? f.status[0] : "·";
    const name = document.createElement("span");
    name.className = "fpath";
    name.textContent = f.path;
    row.append(mark, name);
    row.addEventListener("click", () => openFileAt(f.path));
    li.append(row);
    list.append(li);
  }
  out.append(list);
  if (!shown.length) out.append(note(w.query ? "không file nào khớp truy vấn." : "repo rỗng (không có file nào được git theo dõi)."));
}

function renderFileBody(out, w) {
  const head = document.createElement("div");
  head.className = "files-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "link";
  back.textContent = "← files";
  back.addEventListener("click", () => { w.open = null; w.text = null; w.goto = null; });
  const title = document.createElement("span");
  title.className = "fpath";
  title.textContent = w.open;
  head.append(back, title);
  if (w.truncated) head.append(note(" (capped 256KiB)", "small"));
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "tìm trong file (smartcase)";
  search.maxLength = 128;
  search.className = "file-search";
  search.value = w.search;
  search.addEventListener("input", () => { w.search = search.value; });
  head.append(search);
  out.append(head);
  if (w.text === null) {
    out.append(note(`đang đọc ${w.open}…`));
    return;
  }
  const lines = w.text.split("\n");
  const body = document.createElement("div");
  body.className = "file-body";
  let firstHit = -1;
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("div");
    row.className = "file-line";
    const no = document.createElement("span");
    no.className = "line-no";
    no.textContent = String(i + 1);
    row.append(no);
    const text = lines[i] || " ";
    if (w.search) {
      const hits = hgFuzzy.searchLine(text, w.search);
      let at = 0;
      for (const [s, e] of hits) {
        if (s > at) row.append(document.createTextNode(text.slice(at, s)));
        const hit = document.createElement("span");
        hit.className = "file-hit";
        hit.textContent = text.slice(s, e);
        row.append(hit);
        at = e;
        if (firstHit === -1) firstHit = i;
      }
      row.append(document.createTextNode(text.slice(at)));
    } else {
      row.append(document.createTextNode(text));
    }
    body.append(row);
  }
  out.append(body);
  // path:line flash (the same 3s reveal the diff uses) — goto wins over search.
  const target = w.goto;
  w.goto = null;
  const flashRows = body.children;
  const applyFlash = (idx) => {
    for (let k = Math.max(0, idx - 2); k <= Math.min(flashRows.length - 1, idx + 2); k++) flashRows[k]?.classList?.add?.("flash");
    flashRows[idx]?.scrollIntoView?.({ block: "center" });
    setTimeout(() => {
      for (let k = 0; k < flashRows.length; k++) flashRows[k]?.classList?.remove?.("flash");
    }, 3000);
  };
  if (target && target.line >= 1 && target.line <= lines.length) applyFlash(target.line - 1);
  else if (firstHit >= 0) applyFlash(firstHit);
}

// ---- Review (reviewr mobile): scoped change lists, per-line comments, send ---

const REVIEW_SCOPES = [["uncommitted", "Chưa commit"], ["branch", "Chưa đẩy"], ["turn", "Lượt cuối"]];

/** Unified diff → typed rows with old/new line numbers. Pure — the wire gives
 *  text, the view needs structure (hunk headers, +/-/ctx, numbering). */
function parseUnifiedDiff(text) {
  const rows = [];
  let a = 0;
  let b = 0;
  for (const line of String(text ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { a = Number(hunk[1]); b = Number(hunk[2]); rows.push({ type: "hunk", text: line }); continue; }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\ No newline")) { rows.push({ type: "meta", text: line }); continue; }
    if (line.startsWith("+")) { rows.push({ type: "add", b, text: line.slice(1) }); b++; continue; }
    if (line.startsWith("-")) { rows.push({ type: "del", a, text: line.slice(1) }); a++; continue; }
    if (line.startsWith(" ")) { rows.push({ type: "ctx", a, b, text: line.slice(1) }); a++; b++; continue; }
    rows.push({ type: "meta", text: line }); // diff/index/---/+++ headers and \ No newline
  }
  return rows;
}

function fetchReviewFiles(scope) {
  const w = state.worker.review;
  w.scope = scope;
  w.loading = true;
  w.error = null;
  w.files = null;
  w.open = null;
  w.diff = null;
  const gen = currentGeneration();
  opFetch("review.files", "review.files.result", { scope }, { key: `review-files:${scope}`, fresh: true, errCodes: REVIEW_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen)) return;
      w.loading = false;
      if (isTransportFault(p)) { w.error = p.message; return; }
      if (p.op === "error") { w.error = p.message; return; }
      w.error = null;
      w.files = p.files ?? [];
      w.base = p.base ?? null;
      w.capped = Boolean(p.capped);
    })
    .catch(() => { if (generationCurrent(gen)) { w.loading = false; w.error = "review.files không trả lời"; } });
}

function openReviewDiff(path) {
  const w = state.worker.review;
  w.open = path;
  w.diff = null;
  w.error = null;
  w.boxLine = null;
  const gen = currentGeneration();
  opFetch("review.diff", "review.diff.result", { scope: w.scope, path }, { key: `review-diff:${w.scope}:${path}`, fresh: true, errCodes: REVIEW_ERR_CODES })
    .then((p) => {
      if (!generationCurrent(gen) || w.open !== path) return;
      if (isTransportFault(p)) { w.error = p.message; return; }
      if (p.op === "error") { w.error = p.message; return; }
      w.error = null;
      w.diff = typeof p.text === "string" ? p.text : "";
      w.truncated = Boolean(p.truncated);
    })
    .catch(() => { if (generationCurrent(gen) && w.open === path) w.error = "review.diff không trả lời"; });
}

/** Session-only comment store — nothing crosses the wire until Send (the
 *  reviewr discipline: the worktree and the gate stay untouched while reviewing). */
function setReviewComment(path, line, text) {
  const w = state.worker.review;
  const key = `${path}:${line}`;
  if (!text || !text.trim()) delete w.comments[key];
  else w.comments[key] = [{ path, line, text: text.trim().slice(0, 500) }];
  w.boxLine = null;
  state.roomUi?.updateWorker?.(true);
}

function sendReviewComments() {
  const w = state.worker.review;
  const all = Object.values(w.comments ?? {}).flat();
  if (!all.length || w.sending) return;
  w.sending = true;
  w.sent = null;
  w.error = null;
  sendPayload({ op: "review.send", comments: all });
  // The reply (review.sent) or refusal lands in the frame router above.
}

function renderWorkerReview(out, w) {
  out.replaceChildren();
  const r = w.review;
  if (r.error) out.append(note(r.error, "error"));
  const chips = document.createElement("div");
  chips.className = "rev-scopes";
  for (const [key, label] of REVIEW_SCOPES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `rev-chip${r.scope === key ? " active" : ""}`;
    chip.textContent = label;
    chip.addEventListener("click", () => { if (r.scope !== key) fetchReviewFiles(key); });
    chips.append(chip);
  }
  out.append(chips);
  if (r.open) { renderReviewDiff(out, r); return; }
  if (r.loading) { out.append(note("đang đọc danh sách thay đổi…")); return; }
  if (r.sent) {
    const sent = note(`đã gửi ${r.sent.count} comment — job ${String(r.sent.id).slice(0, 8)} (xem Jobs/Chat)`);
    sent.classList.add("rev-sent");
    out.append(sent);
  }
  if (!r.files) {
    if (!r.error) out.append(note("chọn scope: thay đổi chưa commit / cả nhánh / đúng lượt agent vừa settle."));
    return;
  }
  const list = document.createElement("ul");
  list.className = "rev-list";
  for (const f of r.files) {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    const name = document.createElement("span");
    name.className = "fpath";
    name.textContent = f.path;
    row.append(name);
    if (f.status === "??") {
      const badge = document.createElement("span");
      badge.className = "rev-stat new";
      badge.textContent = "mới";
      row.append(badge);
    } else if (f.plus !== null && f.plus !== undefined) {
      const stat = document.createElement("span");
      stat.className = "rev-stat";
      stat.textContent = `+${f.plus} −${f.minus}`;
      row.append(stat);
    }
    const nComments = Object.keys(r.comments).filter((k) => k.startsWith(`${f.path}:`)).length;
    if (nComments) {
      const c = document.createElement("span");
      c.className = "rev-stat comments";
      c.textContent = `✎ ${nComments}`;
      row.append(c);
    }
    row.addEventListener("click", () => openReviewDiff(f.path));
    li.append(row);
    list.append(li);
  }
  out.append(list);
  if (r.capped) out.append(note("danh sách bị giới hạn 5000 file."));
  if (!r.files.length && !r.error) out.append(note("scope này không có thay đổi nào."));
}

function renderReviewDiff(out, r) {
  const head = document.createElement("div");
  head.className = "files-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "link";
  back.textContent = "← review";
  back.addEventListener("click", () => { r.open = null; r.diff = null; r.boxLine = null; });
  const title = document.createElement("span");
  title.className = "fpath";
  title.textContent = r.open;
  head.append(back, title);
  if (r.truncated) head.append(note(" (capped 128KiB)", "small"));
  out.append(head);
  if (r.diff === null) { out.append(note(`đang đọc diff ${r.open}…`)); return; }
  const body = document.createElement("div");
  body.className = "file-body rev-diff";
  const hint = document.createElement("div");
  hint.className = "rev-hint";
  hint.textContent = "chạm một dòng để comment";
  body.append(hint);
  for (const row of parseUnifiedDiff(r.diff)) {
    if (row.type === "meta") continue; // headers hidden — the path is in the title
    const line = document.createElement("div");
    line.className = `rev-row ${row.type === "hunk" ? "dhunk" : `d${row.type}`}`;
    if (row.type === "hunk") {
      line.textContent = row.text;
      body.append(line);
      continue;
    }
    const num = row.type === "del" ? row.a : row.b;
    const no = document.createElement("span");
    no.className = "line-no";
    no.textContent = num ?? "";
    const text = document.createElement("span");
    text.className = "rev-text";
    text.textContent = row.text;
    line.append(no, text);
    if (row.type !== "del") line.addEventListener("click", () => {
      r.boxLine = r.boxLine === num ? null : num;
      state.roomUi?.updateWorker?.(true);
    });
    body.append(line);
    const lineComments = r.comments[`${r.open}:${num}`];
    if (lineComments) for (const c of lineComments) {
      const chip = document.createElement("div");
      chip.className = "rev-chip-comment";
      const label = document.createElement("span");
      label.textContent = `✎ ${c.text}`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link";
      del.textContent = "×";
      del.addEventListener("click", () => setReviewComment(r.open, num, null));
      chip.append(label, del);
      body.append(chip);
    }
    if (r.boxLine === num) {
      const box = document.createElement("div");
      box.className = "rev-cbox";
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.maxLength = 500;
      ta.placeholder = `comment cho dòng ${num}`;
      ta.value = r.comments[`${r.open}:${num}`]?.[0]?.text ?? "";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Lưu";
      save.addEventListener("click", () => { if (ta.value.trim()) setReviewComment(r.open, num, ta.value); });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "link";
      cancel.textContent = "Đóng";
      cancel.addEventListener("click", () => { r.boxLine = null; state.roomUi?.updateWorker?.(true); });
      box.append(ta, save, cancel);
      body.append(box);
    }
  }
  out.append(body);
  const count = Object.values(r.comments).flat().length;
  const send = document.createElement("button");
  send.type = "button";
  send.className = "rev-send";
  send.textContent = r.sending ? "đang gửi…" : `Gửi ${count} comment về agent`;
  send.disabled = !count || r.sending;
  send.addEventListener("click", sendReviewComments);
  out.append(send);
}

// Diff: render one `git show --stat --patch` answer — the stat block first, then
// the patch with + green, - red, @@ purple. A truncated patch says so plainly.
function renderWorkerDiff(out, d) {
  out.replaceChildren();
  if (!d) {
    out.append(note("Nhập một ref (hash / branch / tag) rồi Load — diff chạy `git show --stat --patch` trên máy, chỉ đọc."));
    return;
  }
  if (d.loading) {
    out.append(note(`đang tải ${d.ref}…`));
    return;
  }
  if (d.error) {
    out.append(note(d.error, "error"));
    return;
  }
  const text = typeof d.text === "string" ? d.text : "";
  const statLines = [];
  const patchLines = [];
  let inPatch = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) inPatch = true;
    (inPatch ? patchLines : statLines).push(line);
  }
  if (statLines.length) {
    const stat = document.createElement("pre");
    stat.className = "diff-stat";
    stat.textContent = statLines.join("\n");
    out.append(stat);
  }
  if (d.truncated) {
    const warn = document.createElement("p");
    warn.className = "muted small";
    warn.textContent = `patch quá dài — đã cắt còn 128KB (bản đầy đủ ${d.bytes ?? "?"} bytes)`;
    out.append(warn);
  }
  const patch = document.createElement("div");
  patch.className = "diff-patch";
  const rows = [];
  for (const line of patchLines) {
    const row = document.createElement("div");
    if (line.startsWith("+")) row.className = "diff-add";
    else if (line.startsWith("-")) row.className = "diff-del";
    else if (line.startsWith("@@")) row.className = "diff-hunk";
    else row.className = "diff-ctx";
    row.textContent = line || " ";
    rows.push(row);
    patch.append(row);
  }
  out.append(patch);
  // path:line deep-link: scroll the target row into view and flash it for 3s
  // (filev OpenRangeFlash — the highlight fades on its own).
  if (d.goto) {
    const hit = diffGotoIndexes(patchLines, d.goto);
    if (hit.length) {
      for (const i of hit) rows[i]?.classList?.add?.("flash");
      rows[hit[0]]?.scrollIntoView?.({ block: "center" });
      setTimeout(() => {
        for (const i of hit) rows[i]?.classList?.remove?.("flash");
      }, 3_000);
    } else {
      const miss = document.createElement("p");
      miss.className = "muted small";
      miss.textContent = `${d.goto.path}:${d.goto.line} không nằm trong diff này`;
      out.append(miss);
      const direct = document.createElement("button");
      direct.type = "button";
      direct.className = "link";
      direct.textContent = "mở trực tiếp file này →";
      direct.addEventListener("click", () => {
        const goto = d.goto;
        d.goto = null;
        openFileAt(goto.path, goto);
      });
      out.append(direct);
    }
    d.goto = null; // one reveal per deep-link, not per re-render
  }
}

function renderWorkerBox(box) {
  const details = document.createElement("details");
  details.className = "worker";
  const summary = document.createElement("summary");
  summary.textContent = "Pi worker (experimental)";
  const health = document.createElement("p");
  health.className = "muted small";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "link";
  refresh.textContent = "refresh";
  // Activity bar: Jobs / Search / Recap / Usage share one surface; the chosen tab
  // lives in state.worker.tab. Jobs keeps its old DOM slots — submit form first,
  // jobs list last — so long-standing expectations keep matching.
  const bar = document.createElement("div");
  bar.className = "activity-bar";
  const tabButtons = new Map();
  for (const [key, label] of [["jobs", "Jobs"], ["search", "Search"], ["recap", "Recap"], ["usage", "Usage"], ["timeline", "Chat"], ["diff", "Diff"], ["files", "Files"], ["review", "Review"]]) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = label;
    bar.append(tab);
    tabButtons.set(key, tab);
  }
  const form = document.createElement("form");
  form.autocomplete = "off";
  const promptLabel = document.createElement("label");
  promptLabel.textContent = "Prompt for a fresh worker run (one job, one session)";
  const prompt = document.createElement("textarea");
  prompt.rows = 3;
  prompt.maxLength = 16384;
  prompt.required = true;
  prompt.placeholder = "e.g. summarize today's commits in 5 bullets";
  const wsLabel = document.createElement("label");
  wsLabel.textContent = "Workspace (optional name from the host allowlist)";
  const workspace = document.createElement("input");
  workspace.type = "text";
  workspace.maxLength = 64;
  workspace.placeholder = "default";
  workspace.pattern = "[a-z0-9][a-z0-9-]{0,63}";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Submit job";
  // 📎 — attach a photo from the phone: capped 4MB client-side, read as base64,
  // uploaded to the AGENT MACHINE (attachment.upload), and the returned hint
  // ("Please open and inspect this image: <path>") lands in the prompt box so
  // the user sees — and sends — exactly the instruction the agent will act on.
  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = "attach";
  attach.textContent = "📎";
  attach.title = "Đính kèm ảnh (image/*, tối đa 4MB) — tải về máy agent";
  const attachFile = document.createElement("input");
  attachFile.type = "file";
  attachFile.accept = "image/*";
  attachFile.hidden = true;
  attach.addEventListener("click", () => attachFile.click());
  attachFile.addEventListener("change", () => {
    const picked = attachFile.files && attachFile.files[0];
    attachFile.value = ""; // allow re-picking the same file
    if (!picked) return;
    if (picked.size > 4 * 1024 * 1024) {
      toast("Ảnh quá lớn — tối đa 4MB");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast("Không đọc được ảnh đã chọn");
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      const dataBase64 = comma >= 0 ? url.slice(comma + 1) : "";
      if (!dataBase64) {
        toast("Không đọc được ảnh đã chọn");
        return;
      }
      void (async () => {
        const reply = await opFetch("attachment.upload", "attachment.uploaded",
          { name: picked.name || "photo", dataBase64 },
          { key: `attach:${picked.name}:${picked.size}:${picked.lastModified}`, fresh: true, errCodes: ATTACH_ERROR_CODES });
        if (!reply || reply.op !== "attachment.uploaded" || typeof reply.hint !== "string") {
          toast((reply && reply.message) || "Không tải được ảnh lên máy agent");
          return; // nothing is inserted into the prompt
        }
        prompt.value = prompt.value ? `${prompt.value.replace(/\s+$/, "")}\n${reply.hint}` : reply.hint;
      })();
    };
    reader.readAsDataURL(picked);
  });
  const formError = document.createElement("p");
  formError.className = "error small";
  formError.hidden = true;
  form.append(promptLabel, prompt, wsLabel, workspace, attach, attachFile, submit, formError);
  const jobs = document.createElement("ul");
  jobs.className = "list";
  // Receipt search: BM25 over the host journal (receipt.search op). Metadata
  // hits only — the device fetches a retained reply per-hit through receipt.body,
  // exactly like the job rows above. A plain tab view now, not a nested disclosure.
  const search = document.createElement("div");
  search.className = "receipt-search";
  const searchForm = document.createElement("form");
  const searchLabel = document.createElement("label");
  searchLabel.textContent = "Find previous work by content";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "noise rekey, cron bucket, …";
  searchInput.maxLength = 200;
  const searchButton = document.createElement("button");
  searchButton.type = "submit";
  searchButton.textContent = "Search";
  searchForm.append(searchLabel, searchInput, searchButton);
  const searchHits = document.createElement("ul");
  searchHits.className = "list";
  search.append(searchForm, searchHits);
  const recap = document.createElement("div");
  recap.className = "recap-view";
  recap.hidden = true;
  const usageView = document.createElement("div");
  usageView.className = "usage-view";
  usageView.hidden = true;
  // Timeline (usage.rollup as daily mini bars) and Diff (git show of one ref)
  // share the same activity-bar surface; both stay above the jobs list.
  const timelineView = document.createElement("div");
  timelineView.className = "chat-view";
  timelineView.hidden = true;
  const diffView = document.createElement("div");
  diffView.className = "diff-view";
  diffView.hidden = true;
  const diffForm = document.createElement("form");
  diffForm.autocomplete = "off";
  const diffLabel = document.createElement("label");
  diffLabel.textContent = "Diff — một ref (hash / branch / tag) trên máy, chỉ đọc";
  const diffInput = document.createElement("input");
  diffInput.type = "text";
  diffInput.maxLength = 64;
  diffInput.placeholder = "HEAD · main · v1.2.0 · <commit sha>";
  const diffButton = document.createElement("button");
  diffButton.type = "submit";
  diffButton.textContent = "Load";
  diffForm.append(diffLabel, diffInput, diffButton);
  const diffOut = document.createElement("div");
  diffOut.className = "diff-out";
  diffView.append(diffForm, diffOut);

  // Files (filev pattern): the host repo's tracked files — fuzzy find, read one
  // file, smartcase in-file search, path:line jump. Read-only like every view op.
  const filesView = document.createElement("div");
  filesView.className = "files-view";
  filesView.hidden = true;
  const filesForm = document.createElement("form");
  filesForm.autocomplete = "off";
  const filesLabel = document.createElement("label");
  filesLabel.textContent = "Files — repo trên máy, chỉ đọc (tìm mờ · enter mở file đầu tiên)";
  const filesInput = document.createElement("input");
  filesInput.type = "text";
  filesInput.maxLength = 128;
  filesInput.placeholder = "vd: index.mjs · wake · test/push";
  filesForm.append(filesLabel, filesInput);
  const filesOut = document.createElement("div");
  filesOut.className = "files-out";
  filesView.append(filesForm, filesOut);

  // Review (reviewr mobile): scoped change lists, tap-line comments, one Send.
  const reviewView = document.createElement("div");
  reviewView.className = "review-view";
  reviewView.hidden = true;
  const reviewOut = document.createElement("div");
  reviewOut.className = "review-out";
  reviewView.append(reviewOut);
  details.append(summary, health, refresh, bar, form, formError, search, recap, usageView, timelineView, diffView, filesView, reviewView, jobs);
  box.append(details);

  filesForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = state.worker.files;
    f.query = filesInput.value.trim();
    // Enter opens the best match — the fuzzy finder's one-keystroke path.
    if (f.tree && f.query) {
      const best = hgFuzzy.matchAndRank(f.query, f.tree.map((x) => x.path))[0];
      if (best !== undefined) openFileAt(f.tree[best].path);
    }
  });
  filesInput.addEventListener("input", () => {
    state.worker.files.query = filesInput.value.trim();
  });

  const askHealth = () => sendPayload({ op: "worker.health" });
  refresh.addEventListener("click", askHealth);
  details.addEventListener("toggle", () => { if (details.open) askHealth(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    formError.hidden = true;
    const text = prompt.value.trim();
    if (!text) return;
    state.worker.draft = text; // the thread's user bubble when the host echoes the id
    sendPayload({ op: "worker.submit", prompt: text, ...(workspace.value.trim() ? { workspace: workspace.value.trim() } : {}) });
    prompt.value = "";
  });
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    state.worker.lastQuery = query;
    fetchReceiptSearch(query);
  });
  diffForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const ref = diffInput.value.trim();
    if (!ref) return;
    const goto = parseLineSuffix(ref); // a path:line typed straight into the box
    if (goto) loadDiff(state.diff?.ref || "HEAD", goto);
    else loadDiff(ref);
  });

  const ui = { details, health, jobs, formError, asked: false };
  let liveOnline = false;
  for (const [key, tab] of tabButtons) {
    tab.addEventListener("click", () => {
      state.worker.tab = key;
      if (key === "timeline" && !state.worker.usage) fetchChatUsage();
      update(liveOnline);
    });
  }
  // The Cmd+K palette jumps here: open the surface, pick the tab, fetch on demand.
  state.openWorkerTab = (key) => {
    details.open = true;
    state.worker.tab = key;
    if (key === "timeline" && !state.worker.usage) fetchChatUsage();
    update(liveOnline);
  };
  const update = (online) => {
    liveOnline = online;
    const w = state.worker;
    const tab = ["search", "recap", "usage", "timeline", "diff", "files", "review"].includes(w.tab) ? w.tab : "jobs";
    const working = [...w.jobs.values()].filter((job) => ["queued", "running", "pending"].includes(job.status)).length;
    tabButtons.get("jobs").textContent = `Jobs (${working})`;
    for (const [key, button] of tabButtons) button.className = key === tab ? "active" : "";
    form.hidden = !online || tab !== "jobs";
    search.hidden = !online || tab !== "search";
    recap.hidden = tab !== "recap";
    usageView.hidden = tab !== "usage";
    timelineView.hidden = tab !== "timeline";
    diffView.hidden = tab !== "diff";
    filesView.hidden = tab !== "files";
    reviewView.hidden = tab !== "review";
    jobs.hidden = tab !== "jobs";
    if (online && tab === "files" && !w.files.tree && !w.files.loading) fetchFileTree();
    if (online && tab === "review" && !w.review.files && !w.review.loading) fetchReviewFiles(w.review.scope);
    if (state.diff?.ref && diffInput.value !== state.diff.ref) diffInput.value = state.diff.ref;
    if (online && details.open && !ui.asked) { ui.asked = true; askHealth(); }
    const h = w.health;
    if (!online) {
      health.textContent = "host offline";
    } else if (!h) {
      health.textContent = h === null ? "asking the host…" : "";
    } else if (!h.enabled) {
      health.textContent = "worker queue disabled on this host (HERDGATE_PI_WORKER)";
    } else {
      const beat = h.heartbeat ? ` · heartbeat ${h.heartbeat.source} ${h.heartbeat.ageSeconds}s ago` : " · no heartbeat";
      health.textContent = `queue ${h.queued ?? "?"} waiting, ${h.running ?? "?"} running${beat}`;
    }
    formError.hidden = !w.error;
    formError.textContent = w.error ?? "";
    searchHits.replaceChildren();
    if (w.searchError) {
      const banner = document.createElement("li");
      banner.className = "error small";
      banner.textContent = w.searchError; // transport fault — the hits below stay
      searchHits.append(banner);
    }
    const s = w.search;
    if (s) {
      if (Array.isArray(s.hits) && s.hits.length) {
        for (const hit of s.hits) {
          const row = document.createElement("li");
          row.className = "row";
          const head = document.createElement("span");
          head.textContent = `${hit.id.slice(0, 8)} · ${hit.status}${hit.reason ? ` (${hit.reason})` : ""}`
            + `${hit.principal ? ` · ${hit.principal}` : ""} · score ${hit.score}`;
          row.append(head, glyphNode(hit));
          if (hit.status === "replied") {
            const view = document.createElement("button");
            view.type = "button";
            view.className = "link";
            view.textContent = hit.body === undefined ? "view report" : "hide report";
            view.addEventListener("click", () => {
              if (hit.body === undefined) fetchReceiptBody(hit.id);
              else hit.body = undefined;
              update(online);
            });
            row.append(" ", view);
            if (typeof hit.body === "string") {
              const pre = document.createElement("pre");
              pre.textContent = hit.body;
              row.append(pre);
            } else if (hit.body && typeof hit.body === "object") {
              const why = document.createElement("span");
              why.className = "muted small";
              why.textContent = `report not available (${hit.body.reason ?? "unavailable"})`;
              row.append(why);
            }
          }
          if (hit.status === "unknown") {
            // An unknown receipt may be a settle this device never saw: ack retires
            // the push intent, receipt.get refreshes the row's verdict in place.
            const ack = document.createElement("button");
            ack.type = "button";
            ack.className = "link";
            ack.textContent = "ack";
            ack.addEventListener("click", () => {
              sendPayload({ op: "receipt.ack", id: hit.id });
              sendPayload({ op: "receipt.get", id: hit.id });
            });
            row.append(" ", ack);
          }
          attachReceiptDetail(row, hit.id);
          searchHits.append(row);
        }
      } else {
        const none = document.createElement("li");
        none.className = "muted small";
        none.textContent = s.reason === "pi_receipts_disabled"
          ? "receipt search disabled on this host (HERDGATE_PI_RECEIPTS)"
          : s.hits && s.hits.length === 0 ? "no receipts match" : "search failed";
        searchHits.append(none);
      }
    }
    jobs.replaceChildren();
    for (const job of [...w.jobs.values()].slice(-12).reverse()) {
      const row = document.createElement("li");
      row.className = "row";
      const head = document.createElement("span");
      head.textContent = `${job.id.slice(0, 8)} · ${job.status}${job.reason ? ` (${job.reason})` : ""}${job.duplicate ? " · duplicate" : ""}`;
      row.append(head, glyphNode(job));
      if (job.status === "replied" && job.hasBody) {
        const view = document.createElement("button");
        view.type = "button";
        view.className = "link";
        view.textContent = job.body === undefined ? "view report" : "hide report";
        view.addEventListener("click", () => {
          if (job.body === undefined) fetchReceiptBody(job.id);
          else job.body = undefined;
          update(online);
        });
        row.append(" ", view);
        if (typeof job.body === "string") {
          const pre = document.createElement("pre");
          pre.textContent = job.body;
          row.append(pre);
        } else if (job.body && typeof job.body === "object") {
          const why = document.createElement("span");
          why.className = "muted small";
          why.textContent = `report not available (${job.body.reason ?? "unavailable"})`;
          row.append(why);
        }
      }
      if (job.status === "unknown") {
        const ack = document.createElement("button");
        ack.type = "button";
        ack.className = "link";
        ack.textContent = "ack";
        ack.addEventListener("click", () => {
          sendPayload({ op: "receipt.ack", id: job.id });
          sendPayload({ op: "receipt.get", id: job.id });
        });
        row.append(" ", ack);
      }
      attachReceiptDetail(row, job.id);
      jobs.append(row);
    }
    renderWorkerRecap(recap, w);
    renderWorkerUsage(usageView, w, online);
    renderWorkerChat(timelineView, w, online);
    renderWorkerDiff(diffOut, state.diff);
    renderWorkerFiles(filesOut, w.files);
    renderWorkerReview(reviewOut, w);
  };
  return update;
}

function workerJobTouched(id, fields) {
  const job = state.worker.jobs.get(id);
  if (!job) return;
  const prevStatus = job.status;
  Object.assign(job, fields);
  if (fields.status && fields.status !== prevStatus) {
    // The receipt machinery running under a thread: one line in the chat, the
    // detail (status, reason, tokens) folded behind it.
    (job.events ??= []).push({
      at: Date.now(),
      status: fields.status,
      reason: fields.reason ?? null,
      tokens: fields.usage?.totalTokens ?? null,
    });
  }
  state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
}

function renderRoomControls(box) {
  let updateSshHint;
  // The SSH leg: this device's own key dials the gate. In the Herdr phone app, add a
  // machine with this host/port and the key shown once at pair time.
  if (state.deviceSecret && state.deviceId) {
    const details = document.createElement("details");
    details.className = "ssh";
    // Open after pairing; live frames never replace the user's controls.
    details.open = state.showSecretOnce === true;
    const summary = document.createElement("summary");
    summary.textContent = "SSH for the Herdr app";
    const pre = document.createElement("pre");
    const host = location.hostname || "your-gate";
    // The port comes from the cloud's hello (its SSH leg); the host is whatever the
    // person typed to reach this page. The cloud advertises the SSH hostname it
    // wants phones to use (bridge / AAAA name); only without one do we fall back
    // to this page's host.
    const { deviceId, deviceSecret, roomId, token } = state;
    const base = cloudBase();
    let selected = deviceId;
    const allowed = new Set([deviceId]);
    const chooser = document.createElement("label");
    chooser.textContent = "SSH username ";
    const picker = document.createElement("select");
    picker.className = "ssh-user-select";
    const option = (id, label) => {
      const item = document.createElement("option");
      item.value = id;
      item.textContent = label;
      return item;
    };
    picker.append(option(deviceId, `${deviceId} (this browser)`));
    picker.value = deviceId;
    picker.disabled = true;
    chooser.append(picker);
    details.append(summary, chooser, pre);

    // The device secret is the SSH password. Reveal only on request and only
    // for the device that owns this panel.
    const keyRow = document.createElement("div");
    keyRow.className = "keyrow";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "link";
    reveal.textContent = "Show this device's key";
    reveal.addEventListener("click", () => {
      const keyEl = document.createElement("pre");
      keyEl.textContent = deviceSecret;
      keyEl.setAttribute("aria-label", "device key");
      keyRow.replaceChildren(keyEl);
    });
    keyRow.append(reveal);
    details.append(keyRow);

    // Registered SSH PUBLIC keys: the machine that runs `hc machine add` can then log
    // in with its key (system ssh prefers keys/agent) — no password prompt, which the
    // app's non-interactive add screen requires.
    const keysBlock = document.createElement("div");
    keysBlock.className = "sshkeys";
    const keysTitle = document.createElement("p");
    keysTitle.className = "muted small";
    keysTitle.textContent = "Public keys — paste the output of `cat ~/.ssh/id_ed25519.pub` from the machine that will add this one:";
    keysBlock.append(keysTitle);
    const keyList = document.createElement("div");
    keysBlock.append(keyList);
    const addRow = document.createElement("div");
    addRow.className = "keyrow";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "ssh-ed25519 AAAA… your@machine";
    addInput.setAttribute("autocomplete", "off");
    addInput.setAttribute("spellcheck", "false");
    addInput.className = "pubkey-input";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add key";
    addBtn.className = "primary";
    addRow.append(addInput, addBtn);
    keysBlock.append(addRow);
    const cfgHint = document.createElement("p");
    cfgHint.className = "muted small";
    updateSshHint = () => {
      const port = state.sshPort ?? 2222;
      const sshHost = state.sshHost || host;
      const command = `ssh -p ${port} ${selected}@${sshHost}`;
      if (pre.textContent === command) return;
      pre.textContent = command;
      cfgHint.textContent = `Herdr Mobile: SSH username ${selected}, port ${port}. Register the public key shown by the phone for this username.`;
    };
    keysBlock.append(cfgHint);
    details.append(keysBlock);

    const status = document.createElement("p");
    status.className = "muted small";
    status.setAttribute("role", "status");
    keysBlock.append(status);
    const keyAuth = (id) => id === deviceId ? { "x-herdgate-secret": deviceSecret } : { authorization: `Bearer ${token}` };
    let keyRequest = 0;

    const renderKeys = (keys, owner) => {
      keyList.replaceChildren();
      for (const k of keys) {
        const row = document.createElement("div");
        row.className = "keyrow";
        const pre = document.createElement("pre");
        pre.textContent = `${k.fp} ${k.comment}`.trim();
        row.append(pre);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "link";
        rm.textContent = "remove";
        rm.addEventListener("click", async () => {
          if (selected !== owner) return;
          try {
            const response = await fetch(`${base}/v1/device/sshkey`, {
              method: "DELETE",
              headers: { "content-type": "application/json", ...keyAuth(owner) },
              body: JSON.stringify({ device: owner, b64: k.b64 }),
            });
            if (selected === owner) {
              if (response.ok) void loadKeys();
              else status.textContent = `Could not remove key (HTTP ${response.status}).`;
            }
          } catch {
            if (selected === owner) status.textContent = "Could not reach the gate.";
          }
        });
        row.append(rm);
        keyList.append(row);
      }
      if (!keys.length) {
        const none = document.createElement("p");
        none.className = "muted small";
        none.textContent = "No public key registered for this username.";
        keyList.append(none);
      }
    };
    const loadKeys = async () => {
      const target = selected;
      const request = ++keyRequest;
      try {
        const r = await fetch(`${base}/v1/device/sshkey?device=${encodeURIComponent(target)}`, { headers: keyAuth(target) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { keys = [] } = await r.json();
        if (request === keyRequest) renderKeys(keys, target);
      } catch {
        if (request === keyRequest) status.textContent = "Could not load public keys.";
      }
    };
    const selectUsername = (id) => {
      if (!allowed.has(id) || id === selected) return;
      selected = id;
      keyRow.hidden = id !== deviceId;
      // Require a fresh paste when switching recipients to avoid granting access to the wrong device.
      addInput.value = "";
      status.textContent = "";
      keyList.replaceChildren();
      updateSshHint();
      void loadKeys();
    };
    picker.addEventListener("change", () => selectUsername(picker.value));
    let pickerRequest = 0;
    const loadUsernames = async () => {
      if (!token || !roomId) return;
      const request = ++pickerRequest;
      try {
        const r = await fetch(`${base}/v1/devices?room=${encodeURIComponent(roomId)}`, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const { devices = [] } = await r.json();
        if (request !== pickerRequest) return;
        allowed.clear();
        allowed.add(deviceId);
        const options = [option(deviceId, `${deviceId} (this browser)`)];
        for (const d of devices) {
          if (allowed.has(d.id)) continue;
          allowed.add(d.id);
          options.push(option(d.id, `${d.name} · ${d.scope} · ${d.id}`));
        }
        if (!allowed.has(selected)) selectUsername(deviceId);
        picker.replaceChildren(...options);
        picker.value = selected;
        picker.disabled = options.length === 1;
      } catch { /* existing pairing still works */ }
    };
    details.addEventListener("toggle", () => { if (details.open) void loadUsernames(); });
    addBtn.addEventListener("click", async () => {
      const pubkey = addInput.value.trim();
      const target = selected;
      if (!pubkey || !allowed.has(target)) return;
      status.textContent = "";
      try {
        const r = await fetch(`${base}/v1/device/sshkey`, {
          method: "POST",
          headers: { "content-type": "application/json", ...keyAuth(target) },
          body: JSON.stringify({ device: target, pubkey }),
        });
        const result = await r.json().catch(() => ({}));
        if (selected !== target) return;
        if (!r.ok) {
          status.textContent = result.error ?? `Could not add key (HTTP ${r.status}).`;
          return;
        }
        if (addInput.value.trim() === pubkey) addInput.value = "";
        status.textContent = `Key saved for ${target}.`;
        void loadKeys();
      } catch {
        if (selected === target) status.textContent = "Could not reach the gate.";
      }
    });
    void loadKeys();
    void loadUsernames();
    details.append(keysBlock);
    box.append(details);
  }

  // The owner's roster for this machine: every paired device, its scope, live dot,
  // public-key count — and the two things the owner always needs: pairing one more
  // device (e.g. an `act` one) and un-pairing (revoke). Works with the account
  // token, so it is here even when this browser itself is only a read device.
  if (state.token && state.roomId) {
    const block = document.createElement("details");
    block.className = "devices";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "Devices — paired phones, browsers and machines";
    block.append(summaryEl);
    const roster = document.createElement("div");
    block.append(roster);
    const pairMore = document.createElement("button");
    pairMore.type = "button";
    pairMore.className = "primary";
    pairMore.textContent = "Pair another device (pick act for full control)";
    pairMore.addEventListener("click", () => openPair(state.roomId));
    block.append(pairMore);
    box.append(block);

    const loadDevices = async () => {
      try {
        const r = await fetch(`${cloudBase()}/v1/devices?room=${encodeURIComponent(state.roomId)}`, {
          headers: { authorization: `Bearer ${state.token}` },
        });
        if (!r.ok) return;
        const rosterJson = await r.json();
        const devices = rosterJson.devices ?? [];
        roster.replaceChildren();
        // The publisher's own hello info, when the room reports it: one muted
        // line — "which build is this machine running" without driving it.
        if (rosterJson.host?.version) {
          roster.append(note(`publisher ${rosterJson.host.version}${rosterJson.host.name ? ` · ${rosterJson.host.name}` : ""}`, "muted"));
        }
        for (const d of devices) {
          const row = document.createElement("div");
          row.className = "keyrow";
          const pre = document.createElement("pre");
          pre.textContent = `${d.name}  ·  ${d.scope}${d.connected ? "  ·  live" : ""}  ·  ${d.keys} key(s)  ·  ${d.id}${d.id === state.deviceId ? "  (this browser)" : ""}`;
          row.append(pre);
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "link danger";
          rm.textContent = "revoke";
          rm.addEventListener("click", async () => {
            if (!confirm(`Revoke ${d.name}? Its key and access die immediately.`)) return;
            const result = await fetch(`${cloudBase()}/v1/device/revoke`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
              body: JSON.stringify({ device: d.id }),
            });
            if (!result.ok) return;
            if (d.id === state.deviceId) dropDevice();
            else loadDevices();
          });
          row.append(rm);
          roster.append(row);
        }
        if (!devices.length) roster.append(note("none yet — pair a device below", "muted"));
      } catch {
        /* offline: the section stays as-is */
      }
    };
    block.addEventListener("toggle", () => { if (block.open) void loadDevices(); });
  }
  return updateSshHint;
}

// ---- live terminals (read; typing when this browser holds an act grant) ----

/** Tabs this browser opened on the machine (session-only memory): the server
 *  enforces ownership; this is just the UI's own note of what to offer. */
function phoneTabs() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(`hg-phone-tabs:${state.deviceRoom}`) ?? "[]");
    return new Map(Array.isArray(raw) ? raw.filter((e) => Array.isArray(e) && typeof e[0] === "string") : []);
  } catch {
    return new Map();
  }
}
function savePhoneTabs(map) {
  try { sessionStorage.setItem(`hg-phone-tabs:${state.deviceRoom}`, JSON.stringify([...map.entries()])); } catch { /* private mode: the server still owns the truth */ }
}

function startTerm(target) {
  stopTerm(false);
  state.termTarget = target;
  state.termAnsi = null;
  sendPayload({ op: "term.read", target, lines: 40 });
  state.termTimer = setInterval(() => {
    if (!state.termTarget || !state.roomId) return stopTerm();
    sendPayload({ op: "term.read", target: state.termTarget, lines: 40 });
  }, 2_000);
  renderTerms();
}

function stopTerm(rerender = true) {
  if (state.termTimer) clearInterval(state.termTimer);
  state.termTimer = null;
  state.termTarget = null;
  state.termAnsi = null;
  if (rerender) renderTerms();
}

/** The panes list + the live pane, inside the details' body (survives view re-renders). */
function renderTerms() {
  const body = state.termBody;
  if (!body) return;
  body.replaceChildren();
  if (state.termTarget) {
    const bar = document.createElement("div");
    bar.className = "termbar";
    const name = document.createElement("span");
    name.className = "muted small";
    name.textContent = `${state.termTarget} — live, refreshes every 2s`;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "link";
    stop.textContent = "close";
    stop.addEventListener("click", () => stopTerm());
    bar.append(name, stop);
    if (state.deviceScope === "act") {
      // One-line typing: the text rides term.send, the next frame shows the
      // result — no client-side echo, the screen stays authoritative.
      const form = document.createElement("form");
      form.className = "termtype";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "gõ một dòng lệnh…";
      input.maxLength = 2000;
      input.autocomplete = "off";
      const send = document.createElement("button");
      send.type = "submit";
      send.className = "primary";
      send.textContent = "Gửi";
      form.append(input, send);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value;
        if (!text || !state.termTarget) return;
        sendPayload({ op: "term.send", target: state.termTarget, text: text + "\n" });
        input.value = "";
      });
      bar.append(form);
    }
    body.append(bar);
    const pre = document.createElement("pre");
    pre.className = "termscreen";
    pre.textContent = state.termAnsi ?? "waiting for the pane…";
    body.append(pre);
    state.termPre = pre;
    paintTerm();
    return;
  }
  const list = document.createElement("div");
  list.className = "termlist";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link";
  btn.textContent = "refresh the pane list";
  btn.addEventListener("click", () => sendPayload({ op: "term.list" }));
  list.append(btn);
  if (state.deviceScope === "act") {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "link";
    open.textContent = "+ tab trên máy";
    open.addEventListener("click", () => sendPayload({ op: "tab.create" }));
    list.append(open);
  }
  const panes = state.terms ?? null;
  if (panes === null) {
    list.append(note("loading…", "muted"));
  } else if (!panes.length) {
    list.append(note("no panes — is a workspace open on the machine?", "muted"));
  } else {
    const labels = new Map((state.view?.workspaces ?? []).map((w) => [w.id, w.label]));
    for (const p of panes) {
      const row = document.createElement("div");
      row.className = "keyrow termrow";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "link termname";
      const ws = labels.get(p.workspace) || p.workspace;
      label.textContent = `${ws} · ${p.agent ? `${p.agent} (${p.status})` : p.title || "terminal"}`;
      label.title = `${p.cwd} — ${p.id}`;
      label.addEventListener("click", () => startTerm(p.id));
      row.append(label);
      list.append(row);
    }
  }
  const mine = phoneTabs();
  if (mine.size) {
    list.append(note("tab bạn mở từ điện thoại:", "muted"));
    for (const [tabId, t] of mine) {
      const row = document.createElement("div");
      row.className = "keyrow";
      const pre = document.createElement("pre");
      pre.textContent = `${t.label} · ${t.paneId ?? tabId}`;
      row.append(pre);
      if (t.paneId) {
        const view = document.createElement("button");
        view.type = "button";
        view.className = "link";
        view.textContent = "xem";
        view.addEventListener("click", () => startTerm(t.paneId));
        row.append(view);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "link danger";
      rm.textContent = "đóng";
      rm.addEventListener("click", () => sendPayload({ op: "tab.close", tabId }));
      row.append(rm);
      list.append(row);
    }
  }
  if (state.termError) list.append(note(state.termError, "muted"));
  body.append(list);
}

function paintTerm() {
  const pre = state.termPre;
  if (!pre || !state.termAnsi) return;
  pre.replaceChildren(...ansiToNodes(state.termAnsi));
  pre.scrollTop = pre.scrollHeight;
}

/** SGR-only ANSI → DOM nodes: colors (palette + truecolor), bold. Cursor and other
 *  sequences are dropped — this is a reading view, not an emulator. No innerHTML:
 *  every byte from the wire becomes text nodes, never markup. */
function ansiToNodes(s) {
  const pal = ["#5b5b5b", "#d54e53", "#5db542", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#acacac", "#8a8a8a", "#ff6f6f", "#8ce07d", "#ffe08a", "#93c5fd", "#e2a2ff", "#8be9fd", "#ffffff"];
  const out = [];
  let fg = null;
  let bg = null;
  let bold = false;
  let i = 0;
  s = String(s).replace(/\r\n?/g, "\n");
  const flush = (text) => {
    if (!text) return;
    if (fg === null && bg === null && !bold) {
      out.push(document.createTextNode(text));
      return;
    }
    const span = document.createElement("span");
    if (fg) span.style.color = bold ? `color-mix(in srgb, ${fg} 70%, white)` : fg;
    if (bg) span.style.background = bg;
    if (bold && !fg) span.style.fontWeight = "600";
    span.textContent = text;
    out.push(span);
  };
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      const rest = s.slice(i);
      let m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(rest);
      if (m) {
        if (m[2] === "m") {
          const parts = m[1] === "" ? [0] : m[1].split(";").map((x) => (x === "" ? 0 : Number(x)));
          for (let k = 0; k < parts.length; k += 1) {
            const p = parts[k];
            if (p === 0) { fg = bg = null; bold = false; }
            else if (p === 1) bold = true;
            else if (p === 22) bold = false;
            else if (p === 39) fg = null;
            else if (p === 49) bg = null;
            else if (p >= 30 && p <= 37) fg = pal[p - 30];
            else if (p >= 90 && p <= 97) fg = pal[p - 90 + 8];
            else if (p >= 40 && p <= 47) bg = pal[p - 40];
            else if (p >= 100 && p <= 107) bg = pal[p - 100 + 8];
            else if ((p === 38 || p === 48) && parts[k + 1] === 2) {
              const c = `rgb(${parts[k + 2] || 0},${parts[k + 3] || 0},${parts[k + 4] || 0})`;
              if (p === 38) fg = c; else bg = c;
              k += 4;
            } else if ((p === 38 || p === 48) && parts[k + 1] === 5) {
              const n8 = parts[k + 2] || 0;
              const c = pal[n8 % 16];
              if (p === 38) fg = c; else bg = c;
              k += 2;
            }
          }
        }
        i += m[0].length;
        continue;
      }
      m = /^\x1b\][^\x07]*(?:\x07|\x1b\\)/.exec(rest) || /^\x1b./.exec(rest);
      i += m ? m[0].length : 1;
      continue;
    }
    let j = s.indexOf("\x1b", i);
    if (j < 0) j = s.length;
    flush(s.slice(i, j));
    i = j;
  }
  return out;
}

function note(message, kind) {
  const p = document.createElement("p");
  p.className = kind === "error" ? "error" : "muted";
  p.textContent = message;
  return p;
}

// ---- the room socket -------------------------------------------------------

function disconnect() {
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  e2eReset();
}

function selectRoom(roomId, pair, fresh = false) {
  resetRoomView();
  state.roomId = roomId;
  state.showSecretOnce = fresh;
  if (state.deviceRoom !== roomId || state.deviceId !== pair.id) {
    disconnect();
    state.deviceRoom = roomId;
    state.deviceId = pair.id;
    state.deviceSecret = pair.secret;
    state.retry = 0;
    connect();
  }
  render();
  if (state.hello && state.ws?.readyState === WebSocket.OPEN) askView();
}

function dropDevice() {
  const roomId = state.deviceRoom;
  if (roomId && roomPairs().get(roomId)?.id === state.deviceId) savePair(roomId, null);
  clearLegacyPair();
  disconnect();
  state.deviceRoom = null;
  state.deviceId = "";
  state.deviceScope = null;
  state.deviceSecret = "";
  goMachines();
  connect();
}

function connect() {
  if (!state.token || state.ws) return;
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    return retryLater();
  }
  state.ws = ws;
  setStatus("connecting", "wait");

  ws.addEventListener("open", () => {
    // A paired device re-attaches with its own key; the account token is the owner path
    // (first sign-in, pairing, management). A device that knows where it stopped reading
    // also asks to resume its room's stream.
    if (state.ws !== ws) return;
    const hello = state.deviceSecret && state.deviceId
      ? { device: state.deviceId, deviceSecret: state.deviceSecret }
      : { accountToken: state.token };
    const resume = loadStream(state.deviceRoom);
    ws.send(JSON.stringify({
      v: 1,
      t: "hello",
      ...hello,
      name: deviceName(),
      ...(resume ? { resume: { room: state.deviceRoom, gen: resume.gen, seq: resume.seq } } : {}),
    }));
  });

  ws.addEventListener("message", (event) => {
    if (state.ws !== ws) return;
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    void onMessage(m, ws);
  });

  ws.addEventListener("close", (event) => {
    if (state.ws !== ws) return;
    state.ws = null;
    e2eReset();
    failAllFencedFetches("mất kết nối tới máy — giữ dữ liệu gần nhất"); // snapshots stay
    if (state.roomId && pinnedHost()) clearRoomPayload();
    if (event.code === 4001 && ["unknown device credentials", "revoked"].includes(event.reason)) {
      dropDevice();
      return;
    }
    if (event.code === 4001 && event.reason === "unknown account token") {
      setStatus("signed out", "bad");
      forgetToken();
      return;
    }
    setStatus("offline", "bad");
    retryLater();
  });

  ws.addEventListener("error", () => {
    /* close carries the retry */
  });
}

async function onMessage(m, ws) {
  // Track the room stream so the next reconnect resumes from here.
  if (typeof m.seq === "number" && (m.t === "frame" || m.t === "presence")) {
    const rid = m.t === "presence" ? m.roomId : state.deviceRoom;
    const cur = loadStream(rid);
    if (cur && m.seq > cur.seq) saveStream(rid, cur.gen, m.seq);
  }
  switch (m.t) {
    case "hello": {
      state.retry = 0;
      state.hello = { agents: Array.isArray(m.agents) ? m.agents : [] };
      if (m.device?.id) {
        const { roomId, id, scope } = m.device;
        state.deviceScope = scope === "act" ? "act" : "read";
        if (!state.deviceRoom) {
          // Migrate the legacy single pairing only after the gate identifies its room.
          savePair(roomId, { id, secret: state.deviceSecret, scope });
          clearLegacyPair();
          state.roomId = roomId;
        }
        state.deviceRoom = roomId;
      }
      // Resume outcome: the stream header carries the cloud's position; when the
      // replay had a hole (too long away), askView() below re-fetches the state.
      const rid = m.device?.roomId ?? null;
      if (m.ssh && typeof m.ssh.port === "number") {
        state.sshPort = m.ssh.port;
        if (typeof m.ssh.host === "string") state.sshHost = m.ssh.host;
      }
      if (m.resumed === true && m.stream && typeof m.stream.seq === "number") {
        saveStream(rid, m.stream.gen, m.stream.seq);
      } else if (rid) {
        if (m.stream && typeof m.stream.seq === "number") saveStream(rid, m.stream.gen, m.stream.seq);
        else clearStream(rid);
      }
      setStatus("online", "good");
      render();
      if (state.roomId) {
        void e2eBegin();
        askView();
      }
      return;
    }
    case "frame": {
      const payload = m.payload;
      if (payload && typeof payload === "object" && payload.op === "e2e.reply") {
        await onE2eReply(payload);
        return;
      }
      if (payload?.op === "e2e.ready") {
        if (!e2e.ch?.ready() || e2e.ready || e2e.initing || e2e.keyChanged) return;
        e2e.ready = true;
        renderRoom();
        void askView();
        return;
      }
      if (payload?.op === "e2e") {
        const ch = e2e.ch;
        if (!e2e.ready || !ch?.ready()) return;
        try {
          const inner = await ch.recv(payload);
          if (state.ws !== ws || e2e.ch !== ch) return;
          if (!e2e.verified) {
            // The plaintext ready ack only starts transport. A valid encrypted
            // response proves the peer has the static key before we store the pin.
            localStorage.setItem(e2eFpKey(state.deviceRoom), ch.hostFingerprint);
            e2e.verified = true;
            renderRoom();
          }
          applyPayload(inner);
        } catch {
          if (state.ws === ws && e2e.ch === ch) restartEncryptedRoom();
          return;
        }
        maybeRotateE2e();
        return;
      }
      if (e2e.keyChanged) return;
      if (pinnedHost() || e2e.ch?.ready()) {
        // Plaintext after a publisher restart may trigger renegotiation, but is never displayed.
        if (e2e.ready && (payload?.code === "e2e" || payload?.op === "view")) restartEncryptedRoom();
        else if (!e2e.ready) void e2eBegin();
        return;
      }
      applyPayload(payload);
      return;
    }
    case "presence": {
      const room = (state.hello?.agents ?? []).find((r) => r.roomId === m.roomId);
      if (room) room.online = m.online === true;
      if (state.roomId === m.roomId) {
        renderRoom();
        if (m.online === true) askView();
      } else {
        renderRooms();
      }
      return;
    }
    case "error": {
      // A protocol-level complaint (bad message, not paired, …).
      if (m.code === "not-paired") state.roomId = null;
      render();
      return;
    }
    default:
      return;
  }
}

function retryLater() {
  const wait = Math.min(30_000, 1_000 * 2 ** state.retry) + Math.random() * 500;
  state.retry += 1;
  setTimeout(connect, wait);
}

/** Ask the host for its view: the only op this app ever sends (encrypted when up). */
function clearRoomPayload() {
  state.view = null;
  state.viewError = null;
  state.terms = null;
  state.termAnsi = null;
  renderRoom();
  renderTerms();
}

function restartEncryptedRoom() {
  e2eReset();
  clearRoomPayload();
  void e2eBegin();
}

async function sendPayload(message) {
  const ws = state.ws;
  if (ws?.readyState !== WebSocket.OPEN || !state.roomId || e2e.keyChanged) return;
  const ch = e2e.ch;
  if (ch?.ready() && e2e.ready) {
    try {
      const payload = await ch.send(message);
      if (state.ws === ws && e2e.ch === ch) send({ t: "frame", payload });
    } catch {
      if (state.ws === ws && e2e.ch === ch) restartEncryptedRoom();
    }
    maybeRotateE2e();
    return;
  }
  void e2eBegin();
  if (!pinnedHost() && !ch?.ready()) send({ t: "frame", payload: message });
}

function askView() {
  return sendPayload({ op: "view" });
}
function applyPayload(payload) {
  if (routeFencedReply(payload)) return; // fenced: the surface that asked applies it
  // The plaintext (or decrypted) payload from the host lands here.
  if (payload && typeof payload === "object" && payload.op === "view") {
    if (state.pendingFileLink) {
      const link = state.pendingFileLink;
      state.pendingFileLink = null;
      openFileAt(link.path, link.goto);
    }
    state.view = payload.view;
    state.viewError = null;
  } else if (payload && typeof payload === "object" && payload.op === "term.list") {
    state.terms = Array.isArray(payload.panes) ? payload.panes : [];
    renderTerms();
    return;
  } else if (payload && typeof payload === "object" && payload.op === "tab.created") {
    if (typeof payload.tabId === "string") {
      const map = phoneTabs();
      map.set(payload.tabId, { paneId: typeof payload.paneId === "string" ? payload.paneId : null, label: typeof payload.label === "string" ? payload.label : "phone", at: Date.now() });
      savePhoneTabs(map);
      renderTerms();
    }
    return;
  } else if (payload && typeof payload === "object" && payload.op === "tab.closed") {
    const map = phoneTabs();
    map.delete(payload.tabId);
    savePhoneTabs(map);
    renderTerms();
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && ["not-yours", "bad-tab", "bad-label"].includes(payload.code)) {
    state.termError = payload.message ?? payload.code;
    renderTerms();
    setTimeout(() => { state.termError = null; renderTerms(); }, 6_000);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "term.read") {
    if (payload.target === state.termTarget && typeof payload.ansi === "string") {
      state.termAnsi = payload.ansi;
      paintTerm();
    }
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.health.result") {
    state.worker.health = payload;
    state.worker.error = payload.enabled === false ? payload.message ?? "worker queue disabled on this host" : null;
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && payload.code === "pi_worker_disabled" && state.worker.review?.sending) {
    // A refused review.send faults the Review tab only — the comments stay.
    state.worker.review.sending = false;
    state.worker.review.error = payload.message ?? payload.code ?? "host từ chối review.send";
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && ["requires-act", "bad-comments", "bad-comment", "queue-full", "worker-queue"].includes(payload.code) && state.worker.review?.sending) {
    state.worker.review.sending = false;
    state.worker.review.error = payload.code === "requires-act" ? "cần cấp quyền act cho điện thoại để gửi review" : payload.message ?? payload.code;
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "review.sent") {
    const r = state.worker.review;
    if (r) {
      r.sending = false;
      r.sent = { id: payload.id, count: payload.count, at: Date.now() };
      r.comments = {}; // delivered — the queue owns them now
      r.boxLine = null;
      r.open = null; // back to the list; the job lands in Jobs/Chat like any turn
    }
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.submitted") {
    state.worker.jobs.set(payload.id, {
      id: payload.id,
      status: payload.state,
      duplicate: payload.duplicate === true,
      hasBody: false,
      prompt: state.worker.draft ?? undefined, // the session's user bubble, when we typed it
      ts: Date.now(),
      principal: state.deviceId ? `device:${state.deviceId}` : null,
      events: [],
    });
    state.worker.draft = null;
    sendPayload({ op: "receipt.watch", id: payload.id, wantBody: true });
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.status.result") {
    workerJobTouched(payload.id, { status: payload.state, ...(payload.reason ? { reason: payload.reason } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.watched") {
    workerJobTouched(payload.id, payload.pending
      ? { status: "pending" }
      : { status: payload.status, ...(payload.reason ? { reason: payload.reason } : {}), ...(payload.usage ? { usage: payload.usage } : {}) });
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.push") {
    workerJobTouched(payload.id, { status: payload.status, ...(payload.reason ? { reason: payload.reason } : {}), hasBody: payload.hasBody === true, ...(payload.usage ? { usage: payload.usage } : {}) });
    sendPayload({ op: "receipt.ack", id: payload.id }); // displayed — retire the intent
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.search.result") {
    // Metadata hits (id/score/status/reason/usage/principal); snippets and session
    // files are host-local privileges the channel never carries.
    state.worker.search = { hits: Array.isArray(payload.hits) ? payload.hits : [], reason: payload.reason ?? null };
    state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.body.result") {
    applyBodyResult(payload); // unfenced fallback (pushes); fenced replies apply at their caller
    return;
  } else if (payload && typeof payload === "object" && payload.op === "diff.result") {
    state.diff = {
      ref: typeof payload.ref === "string" ? payload.ref : (state.diff?.ref ?? ""),
      text: typeof payload.text === "string" ? payload.text : "",
      bytes: payload.bytes ?? 0,
      truncated: payload.truncated === true,
      error: null,
      loading: false,
    };
    state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.result") {
    // An ack/refresh follow-up: fold the verdict back into the row that asked.
    if (payload.id) {
      workerJobTouched(payload.id, { status: payload.status ?? "unknown", ...(payload.reason ? { reason: payload.reason } : {}) });
      const s = state.worker.search;
      const hit = Array.isArray(s?.hits) ? s.hits.find((h) => h.id === payload.id) : null;
      if (hit) {
        hit.status = payload.status ?? "unknown";
        if (payload.reason) hit.reason = payload.reason;
        state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
      }
    }
    return;
  } else if (payload && typeof payload === "object" && payload.op === "usage.rollup.result") {
    state.worker.usage = payload;
    state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error"
    && (payload.code === "usage-unavailable" || payload.reason === "usage-unavailable" || payload.code === "usage.rollup")) {
    // Older hosts have no usage roll-up wired: scoped to the Usage tab, never the room.
    state.worker.usage = { unavailable: true };
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && payload.code === "busy") {
    return; // our poll raced the host's 1/s throttle — the next tick catches up
  } else if (payload && typeof payload === "object" && payload.op === "error" && DIFF_ERROR_CODES.has(payload.code)) {
    // A refused diff faults only the Diff view, never the room.
    state.diff = { ...(state.diff ?? { ref: "", text: null }), error: payload.message ?? payload.code ?? "the host refused", loading: false };
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && PANE_ERROR_CODES.has(payload.code)) {
    return; // no pane-focus surface yet — the refusal is not the room's problem
  } else if (payload && typeof payload === "object" && payload.op === "error" && WORKER_ERROR_CODES.has(payload.code)) {
    // Scoped to the worker panel: a refused submit/watch must not blank the room view.
    state.worker.error = payload.message ?? payload.code ?? "the host refused";
    state.worker.health = null;
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error") {
    // The host refused or could not answer: an op we may not use, or its Herdr is down.
    state.viewError = payload.message ?? payload.code ?? "the host refused";
    state.view = null;
  } else {
    return;
  }
  renderRoom();
}

// ---- push wake ---------------------------------------------------------------

/** Subscribe this device to silent wake pushes; ask for permission only once paired.
 *  The subscription's p256dh/auth keys ride along so the gate can send ENCRYPTED
 *  payloads (RFC 8291) — and if the gate ever rotates its VAPID keypair, the old
 *  subscription would silently stop delivering, so the key is checked every time
 *  and a mismatch re-subscribes fresh (a subscription is bound to its birth key). */
async function subscribePush() {
  const { deviceId, deviceSecret } = state;
  const base = cloudBase();
  if (!(deviceSecret && deviceId)) return; // paired devices only
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch(`${base}/v1/push/key`);
    if (!keyRes.ok) return; // push disabled on this cloud
    const { publicKey } = await keyRes.json();
    const raw = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    if (sub && !keysMatch(sub.options.applicationServerKey, raw)) {
      await sub.unsubscribe(); // born under an older VAPID key — dead weight
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    }
    const endpoint = sub.endpoint;
    if (cloudBase() !== base || state.deviceId !== deviceId) return;
    const j = sub.toJSON();
    await fetch(`${base}/v1/device/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: deviceId, deviceSecret, endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth }),
    });
  } catch {
    /* permission denied or push unavailable: the gate still works without it */
  }
}

/** A push subscription is permanently bound to the VAPID key it was created with.
 *  Byte-compare the subscription's key with the server's current one. */
function keysMatch(existing, serverKey) {
  if (!existing) return false;
  const a = "buffer" in existing ? new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength) : new Uint8Array(0);
  if (a.length !== serverKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== serverKey[i]) return false;
  return true;
}

/** The host answered our handshake: finish it, pin its fingerprint (TOFU). */
async function onE2eReply(payload) {
  const ch = e2e.ch;
  const roomId = state.deviceRoom;
  if (!ch || !roomId || ch.ready() || e2e.initing || e2e.keyChanged) return;
  e2e.initing = true;
  try {
    const finish = await ch.acceptReply(payload, pinnedHost());
    if (e2e.ch !== ch) return;
    clearRoomPayload();
    send({ t: "frame", payload: { op: "e2e.finish", c: finish.c } });
  } catch (err) {
    if (e2e.ch !== ch) return;
    e2eReset();
    if (err?.code === "host-key-changed") {
      e2e.keyChanged = true;
      clearRoomPayload();
    }
  } finally {
    if (e2e.ch === ch) e2e.initing = false;
  }
}

function send(message) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify({ v: 1, ...message }));
  return true;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac browser";
  return "browser";
}

// ---- Cmd+K fuzzy jump -------------------------------------------------------

// The palette's fixed destinations: the activity-bar views of the open room.
const CMDK_VIEWS = [
  ["jobs", "Jobs — hàng đợi và receipts"],
  ["search", "Search — tìm receipt theo nội dung"],
  ["recap", "Recap — đến lượt ai?"],
  ["usage", "Usage — bảng 7 ngày"],
  ["timeline", "Chat — thread mỗi session"],
  ["diff", "Diff — git show một ref"],
];

/** Subsequence match with a small score: earlier + consecutive hits win. */
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    qi += 1;
    streak = last === ti - 1 ? streak + 1 : 1;
    score += 1 + streak * 2 + (ti === 0 ? 3 : 0);
    last = ti;
  }
  return qi === q.length ? score - t.length * 0.05 : -1;
}

/** Everything Enter can open right now: views, recent receipts/jobs, and — when
 *  the query itself is a legal ref — a diff of exactly that ref. */
function cmdkItems(query) {
  const items = [];
  for (const [key, label] of CMDK_VIEWS) {
    items.push({ label: `View · ${label}`, score: fuzzyScore(query, `${key} ${label}`), run: () => state.openWorkerTab?.(key) });
  }
  const goto = parseLineSuffix(query);
  if (goto) {
    items.push({
      label: `Goto · ${goto.path}:${goto.line}${goto.end > goto.line ? `-${goto.end}` : ""}`,
      score: 2,
      run: () => gotoDiffLine(query),
    });
  }
  for (const job of [...state.worker.jobs.values()].slice(-10).reverse()) {
    items.push({
      label: `Receipt · ${job.id.slice(0, 8)} · ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
      score: fuzzyScore(query, `${job.id} ${job.status} ${job.reason ?? ""}`),
      run: () => {
        state.openWorkerTab?.("jobs");
        if (job.status === "replied") fetchReceiptBody(job.id);
        else if (job.status === "unknown") sendPayload({ op: "receipt.get", id: job.id });
      },
    });
  }
  if (/^[A-Za-z0-9._\/-]{3,64}$/.test(query)) {
    items.push({ label: `Diff · git show ${query}`, score: 0.5, run: () => openDiffRef(query) });
  }
  return items.filter((item) => item.score >= 0).sort((a, b) => b.score - a.score).slice(0, 9);
}

/** Jump straight to the Diff view with a ref (palette or URL hand-off). */
function openDiffRef(ref) {
  state.openWorkerTab?.("diff");
  loadDiff(ref);
}

let cmdk = null;

function ensureCmdk() {
  if (cmdk) return cmdk;
  const root = document.createElement("div");
  root.className = "cmdk";
  root.hidden = true;
  const box = document.createElement("div");
  box.className = "cmdk-box";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "nhảy tới… (view, receipt, git ref)";
  const list = document.createElement("ul");
  list.className = "cmdk-list";
  const hint = document.createElement("p");
  hint.className = "muted small";
  hint.textContent = "↑ ↓ chọn · Enter mở · Esc đóng";
  box.append(input, list, hint);
  root.append(box);
  root.addEventListener("click", (event) => {
    if (event.target === root) closeCmdk();
  });
  document.documentElement.append(root);
  const ui = { root, input, list, items: [], sel: 0 };
  input.addEventListener("input", () => {
    ui.sel = 0;
    renderCmdk(ui);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      ui.sel = Math.min(ui.sel + 1, ui.items.length - 1);
      renderCmdk(ui);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      ui.sel = Math.max(ui.sel - 1, 0);
      renderCmdk(ui);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = ui.items[ui.sel];
      if (item) {
        closeCmdk();
        item.run();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeCmdk();
    }
  });
  cmdk = ui;
  return ui;
}

function renderCmdk(ui) {
  ui.items = cmdkItems(ui.input.value.trim());
  if (ui.sel >= ui.items.length) ui.sel = Math.max(0, ui.items.length - 1);
  ui.list.replaceChildren();
  ui.items.forEach((item, i) => {
    const row = document.createElement("li");
    row.className = i === ui.sel ? "active" : "";
    row.textContent = item.label;
    row.addEventListener("click", () => {
      closeCmdk();
      item.run();
    });
    ui.list.append(row);
  });
  if (!ui.items.length) {
    const none = document.createElement("li");
    none.className = "muted small";
    none.textContent = "không có gì khớp";
    ui.list.append(none);
  }
}

function openCmdk() {
  const ui = ensureCmdk();
  ui.root.hidden = false;
  ui.input.value = "";
  ui.sel = 0;
  renderCmdk(ui);
  ui.input.focus();
}

function closeCmdk() {
  if (cmdk) cmdk.root.hidden = true;
}

function toggleCmdk() {
  if (cmdk && !cmdk.root.hidden) closeCmdk();
  else openCmdk();
}

// The standard web chord, captured wherever it lands; the header button says so.
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && String(event.key ?? "").toLowerCase() === "k") {
    event.preventDefault();
    toggleCmdk();
  }
});
$("cmdk-open")?.addEventListener("click", () => toggleCmdk());

// ---- pairing ---------------------------------------------------------------

function openPair(roomId) {
  state.pairRoom = roomId;
  show("pair", true);
  show("rooms", false);
  show("room", false);
  showError("pair-error", null);
  const name = $("pair-name");
  if (!name.value) name.value = deviceName();
  name.focus();
}

function pairStatus(message = "") {
  text("pair-status", message);
  show("pair-status", Boolean(message));
}

function closePair() {
  state.pairSocket?.cancel();
  pairStatus();
  state.pairRoom = null;
  show("pair", false);
  showError("pair-error", null);
}

$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.pairSocket || !state.pairRoom || !state.token) return;
  showError("pair-error", null);
  const { pairRoom: roomId, token: accountToken } = state;
  const name = $("pair-name").value.trim() || deviceName();
  const scope = $("pair-scope").value === "act" ? "act" : "read";
  // Pairing is an owner operation. Do not promote or replace the room socket.
  let ws;
  try { ws = new WebSocket(wsUrl()); }
  catch { return showError("pair-error", "Could not connect to the gate"); }
  const button = $("pair-form").querySelector("button");
  button.disabled = true;
  pairStatus("Connecting to the gate…");
  let requested = false;
  const operation = { cancel: () => finish() };
  state.pairSocket = operation;
  const timeout = setTimeout(() => finish("Pairing timed out"), 70_000);
  function finish(error) {
    if (state.pairSocket !== operation) return;
    state.pairSocket = null;
    button.disabled = false;
    pairStatus();
    clearTimeout(timeout);
    ws.close();
    if (error) showError("pair-error", error);
  }
  const sendPair = (message) => ws.send(JSON.stringify({ v: 1, ...message }));
  ws.addEventListener("open", () => {
    if (state.pairSocket === operation) sendPair({ t: "hello", accountToken, name: deviceName() });
  });
  ws.addEventListener("close", (event) => finish(event.reason || "Pairing connection closed"));
  ws.addEventListener("message", (event) => {
    if (state.pairSocket !== operation) return;
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m?.t === "hello" && !requested) {
      requested = true;
      pairStatus(scope === "act" ? "Waiting for the host to approve control…" : "Pairing…");
      sendPair({ t: "pair.begin", roomId, name, scope });
    } else if (m?.t === "pair.denied" || m?.t === "error") {
      finish(m.reason || m.message || "Pairing refused");
    } else if (m?.t === "pair.granted" && requested) {
      if (m.device?.roomId !== roomId || m.device.scope !== scope || typeof m.device.id !== "string" || typeof m.deviceSecret !== "string") {
        return finish("Invalid pairing reply");
      }
      const pairing = { id: m.device.id, secret: m.deviceSecret, scope };
      savePair(roomId, pairing);
      closePair();
      selectRoom(roomId, pairing, true);
      void subscribePush();
    }
  });
});

// ---- sign-in, settings -----------------------------------------------------

$("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  if (!token) return showError("signin-error", "a token is required");
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  showError("signin-error", null);
  $("token").value = "";
  render();
  connect();
});

// Approve a new machine: the owner types the code its herdgate panel shows.
$("addmachine").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("addmachine-code").value.trim();
  const noteEl = $("addmachine-note");
  noteEl.hidden = false;
  noteEl.className = "muted small";
  noteEl.textContent = "approving…";
  try {
    const r = await fetch(`${cloudBase()}/v1/agent/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    $("addmachine-code").value = "";
    noteEl.textContent = "approved — the machine appears when its publisher connects";
    // A fresh hello lists the new room (rooms come from hello).
    disconnect();
    connect();
  } catch (e) {
    noteEl.className = "error small";
    noteEl.textContent = String(e.message ?? e);
  }
});

$("menu").addEventListener("click", () => {
  $("cloud").value = state.cloud;
  $("settings").showModal();
});

$("settings-form").addEventListener("submit", () => {
  const value = $("cloud").value.trim().replace(/\/$/, "");
  if (value !== state.cloud) {
    // Never forward credentials from one cloud to another.
    forgetToken();
    state.cloud = value;
    if (value) localStorage.setItem(CLOUD_KEY, value);
    else localStorage.removeItem(CLOUD_KEY);
  }
});

$("signout").addEventListener("click", () => forgetToken());

/** Back to the machine list — from the pair screen or the room screen.
 * Delegated at the document level so it works no matter what rebuilt the DOM
 * (and with a generous tap target; see .backbtn in the CSS). */
function resetRoomView() {
  stopTerm(false);
  state.terms = null;
  state.termBody = null;
  state.termPre = null;
  state.view = null;
  state.viewError = null;
  state.roomUi = null;
  state.diff = null;
  state.chat = { filter: null, spawn: null };
  state.worker.chatError = null;
  state.worker.searchError = null;
  state.worker.bodyError = null;
  state.worker.enrich = null;
  state.openWorkerTab = null;
  newGeneration(); // a new mount: replies answering the old generation are dropped
  $("view").replaceChildren();
}

const goMachines = () => {
  resetRoomView();
  state.roomId = null;
  closePair();
  render();
};
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("#back, #pair-back") : null;
  if (target) goMachines();
});

function forgetToken() {
  state.token = "";
  state.deviceId = "";
  state.deviceScope = null;
  state.deviceSecret = "";
  state.deviceRoom = null;
  state.hello = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PAIRS_KEY);
  clearLegacyPair();
  disconnect();
  goMachines();
  $("settings").close();
}

// ---- boot ------------------------------------------------------------------

// Which build is this? Shown in the machine list so a stale phone install is
// obvious at a glance (the service worker updates on the second launch).
{
  const el = document.getElementById("build");
  if (el) el.textContent = "herdgate " + BUILD;
}

// QR pairing round: a scan opens the app with #pair=<code> — prefill the one-line
// approval input so the owner only has to press Approve.
{
  const m = /#pair=([A-Za-z0-9]{4,64})/.exec(location.hash ?? "");
  if (m) {
    const input = $("addmachine-code");
    if (input) input.value = m[1];
  }
}

// Deep link #room=<id>: a notification tap opens the app straight into that room.
// The saved pairing is enough to enter; an unknown room falls back to the list.
function roomFromHash() {
  const m = /^#room=([A-Za-z0-9_-]{1,64})$/.exec(location.hash ?? "");
  if (!m) return null;
  const id = m[1];
  const pair = roomPairs().get(id);
  if (pair && state.token) selectRoom(id, pair, true);
  return id;
}

// Files deep-link #f=<path>[:line[-end]] — a receipt or diff link can land straight
// in the viewer at the exact line (the filev open_target shape). At boot the socket
// may not be open yet; the link waits for the first live view (askView path).
function filesFromHash() {
  const m = /^#f=([^&\s]{1,512})$/.exec(location.hash ?? "");
  if (!m) return null;
  const goto = parseLineSuffix(m[1]) ?? { path: m[1], line: 1, end: 1 };
  if (!state.token || !goto.path) return null;
  const target = goto.line >= 1 ? goto : null;
  if (state.ws?.readyState === WebSocket.OPEN && state.roomId) {
    openFileAt(goto.path, target);
  } else {
    state.pendingFileLink = { path: goto.path, goto: target };
  }
  return goto.path;
}
if (typeof addEventListener === "function") addEventListener("hashchange", () => { roomFromHash(); filesFromHash(); });

// A notification tap on an OPEN window arrives as { t: "nav", room } from the SW —
// navigate in place, no reload (pairing and drafts survive).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const d = event.data;
    if (d?.t === "nav" && typeof d.room === "string" && state.token) {
      const pair = roomPairs().get(d.room);
      if (pair) selectRoom(d.room, pair, true);
    }
  });
}

// ---- self-update --------------------------------------------------------------
// The gate stamps its build id on /healthz (x-hg-build). When the serving gate is
// NEWER than the bundle this page booted from, reload — but only after two agreeing
// polls (hysteresis: an atomic dist swap must not half-trigger), at most once per
// build id (sessionStorage guard against a reload loop), and never while the user
// is typing (an input holding text holds the reload; the banner shows instead).
{
  const SEEN_KEY = "hg:build-seen";
  let pendingBuild = null;
  let banner = null;
  const reloadedKey = (id) => `hg:auto-reloaded:${id}`;
  const holdActive = () => {
    const el = document.activeElement;
    return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value !== "";
  };
  const showBanner = (on) => {
    let node = document.getElementById("upd");
    if (!node && on) {
      node = document.createElement("div");
      node.id = "upd";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Bản mới — chạm để cập nhật";
      btn.addEventListener("click", () => {
        localStorage.setItem(SEEN_KEY, pendingBuild ?? "");
        location.reload();
      });
      node.append(btn);
      document.body.append(node);
    }
    banner = node;
    if (node) node.hidden = !on;
  };
  const act = (id) => {
    let already = false;
    try { already = sessionStorage.getItem(reloadedKey(id)) !== null; } catch { already = false; }
    if (already || holdActive()) return showBanner(true);
    try { sessionStorage.setItem(reloadedKey(id), "1"); } catch { /* storage off — reload anyway */ }
    localStorage.setItem(SEEN_KEY, id);
    location.reload();
  };
  const checkBuild = async () => {
    try {
      const res = await fetch("/healthz", { cache: "no-store" });
      const id = res.headers.get("x-hg-build");
      if (!id) return;
      let seen = null;
      try { seen = localStorage.getItem(SEEN_KEY); } catch { seen = null; }
      if (!seen) { localStorage.setItem(SEEN_KEY, id); return; } // first boot on this device
      if (id === seen) { pendingBuild = null; showBanner(false); return; }
      if (id === pendingBuild) { act(id); return; } // second agreeing sighting
      pendingBuild = id; // first sighting — wait one more poll
    } catch {
      /* offline: try again on the next tick */
    }
  };
  if (typeof addEventListener === "function") {
    addEventListener("load", () => {
      void checkBuild();
      if (typeof setInterval === "function") setInterval(checkBuild, 5 * 60_000);
    });
  }
}

render();
roomFromHash();
filesFromHash();
if (state.token) {
  connect();
  void subscribePush(); // upgrade an existing subscription (keys, VAPID rotation check)
}

// A phone that wakes up should not show a dead screen.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    if (state.roomId) askView();
  } else {
    state.retry = 0;
    connect();
  }
});

// Installable shell (offline start). Registered late so it never delays first paint.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* an app without offline start is still an app */
    });
  });
}

// ---- node:test seam ----------------------------------------------------------
// The PWA suite runs this file in a bare VM and anchors these helpers through
// `globalThis.__herdgateWebTest`. The browser never defines the anchor, so this
// block is inert in production.
{
  const anchor = globalThis.__herdgateWebTest;
  if (anchor) {
    Object.assign(anchor, {
      parseLineSuffix,
      newGeneration,
      generationCurrent,
      diffGotoIndexes,
      fetchInfo: () => ({
        gen: fetches.gen,
        inflight: [...fetches.inflight.values()].map((e) => ({ key: e.key, gen: e.gen, fresh: e.fresh })),
      }),
      fetchDrive: (op, replyOp, payload, opts) => {
        const sent = [];
        state.roomId ??= "pwa3-room";
        state.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
        return { sent, promise: opFetch(op, replyOp, payload, opts) };
      },
      fetchReply: (payload) => routeFencedReply(payload),
      online: () => {
        state.roomId ??= "pwa3-room";
        state.ws = { readyState: 1, send() {} };
      },
      offline: () => { state.ws = null; },
      chatFetch: (fresh) => fetchChatUsage(fresh),
      chatSnap: () => ({
        usage: state.worker.usage ?? null,
        chatError: state.worker.chatError ?? null,
        filter: state.chat.filter ?? null,
      }),
      enrichSnap: () => {
        const e = state.worker.enrich;
        return e ? { id: e.id, loading: e.loading, error: e.error ?? null, result: e.result ?? null } : null;
      },
      enrichToggle: (id) => toggleReceiptEnrich(id),
      enrichRows: (result) => JSON.parse(JSON.stringify(enrichRows(result))),
      contextPctOf: (tokens, max) => contextPctOf(tokens, max),
      parseUnifiedDiff, reviewSnap: () => JSON.parse(JSON.stringify(state.worker.review)),
      reviewComment: (path, line, text) => setReviewComment(path, line, text),
      reviewSend: () => {
        const sent = [];
        state.roomId ??= "pwa3-room";
        state.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
        sendReviewComments();
        return sent;
      },
      apply: (payload) => applyPayload(payload),
      probe: {
        detail: (id) => receiptDetailNode(id),
        thread: (job) => chatThread(job),
        subagent: (name, extra = {}) => subagentCard({
          principal: `spawn:${name}`, requests: 1, replied: 1, failed: 0,
          tokens: 4321, costUsd: 0.01, lastTs: Date.now() - 60_000, ...extra,
        }, true),
        linked: (text) => {
          const el = document.createElement("div");
          appendLinkedText(el, text);
          return el;
        },
      },
    });
  }
}
