#!/usr/bin/env node
// Subset of the Core API for TUI panes. Input requires explicit local opt-in.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { openTerminal, validDimension } from "./mobile-tui-stream.mjs";

const invoke = promisify(execFile);
const herdr = process.env.HERDR_BIN_PATH || join(homedir(), ".local/bin/herdr");
const name = process.env.HERDGATE_HOST_NAME || "home-tui-mobile";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const core = { id: digest(`herdgate-tui:${hostname()}:${name}`).slice(0, 32), name };
const version = "0.1.21"; // Core wire compatibility target, not a running Core binary.
const methods = ["hello", "server.status", "terminal.list", "terminal.get", "terminal.read", "events.subscribe", "templates.list", "machine.list", "doc.get"];
const inputMethods = ["terminal.send", "terminal.keys", "terminal.interrupt", "terminal.run", "terminal.kill", "terminal.label", "terminal.keep", "doc.set"];

// Labels the app sets on panes outlive the adapter in a sidecar; seating labels stay ours.
const labelsFile = join(homedir(), ".config", "herdgate", "tui-labels.json");
let appLabels = null;
function appLabelsFor(paneId) {
  if (appLabels === null) {
    try {
      const stored = JSON.parse(readFileSync(labelsFile, "utf8"));
      appLabels = new Map(Object.entries(stored).filter(([id, l]) => typeof id === "string" && l && typeof l === "object" && !Array.isArray(l)).slice(0, 500));
    } catch { appLabels = new Map(); }
  }
  return appLabels.get(paneId) || {};
}
function saveAppLabels() {
  try {
    mkdirSync(dirname(labelsFile), { recursive: true });
    const tmp = labelsFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries([...appLabels].slice(-500))));
    renameSync(tmp, labelsFile);
  } catch { /* labels are best-effort */ }
}
const args = process.argv.slice(2);
const interactive = args[0] === "--interactive";
if (interactive) args.shift();
const mode = interactive ? "interactive" : "read-only";
const inputText = (text) => typeof text === "string" && text.length > 0 && !text.includes("\0") && Buffer.byteLength(text) <= 8192;
const frameKind = { data: 0, credit: 1, close: 2, resize: 3 };
const cap = 128 * 1024;
const windowBytes = 64 * 1024;
const maxStreams = 16; // A desktop space shows several panes at once; the phone showed one or two.
const pollMs = Math.max(250, Number.parseInt(process.env.HERDGATE_TUI_POLL_MS ?? "1250", 10) || 1250);
const startedAt = Date.now();
let cache;
let cacheUntil = 0;
const run = async (args) => (await invoke(herdr, args, { timeout: 4_000, maxBuffer: 512 * 1024, windowsHide: true, shell: false })).stdout;

async function panes() {
  if (cache && Date.now() < cacheUntil) return cache;
  const parsed = JSON.parse(await run(["pane", "list"]));
  if (!Array.isArray(parsed?.result?.panes)) throw new Error("Herdr pane list unavailable");
  cache = parsed.result.panes.filter((p) => typeof p?.pane_id === "string" && /^[a-zA-Z0-9_:.-]{1,128}$/.test(p.pane_id) && !p.pane_id.startsWith("-"))
    .slice(0, 180).map((p) => {
      let title = clip(p.terminal_title_stripped || p.terminal_title || p.pane_id, 120);
      // Herdr's per-pane agent state feeds the core's own status word (a 7501 record
      // shape: an object with a state, never a bare string).
      const status = p.agent_status === "working" ? { state: "working" } : null;
      const ws = typeof p.workspace_id === "string" && /^[a-zA-Z0-9_:.-]{1,128}$/.test(p.workspace_id) ? p.workspace_id : null;
      const tab = typeof p.tab_id === "string" && /^[a-zA-Z0-9_:.-]{1,128}$/.test(p.tab_id) ? p.tab_id : null;
      // The desktop app seats terminals by these labels; ids stay stable per workspace/tab.
      const labels = { ...appLabelsFor(p.pane_id), ...(ws && tab ? { "herdr.space": "sp" + digest("space:" + ws).slice(0, 30), "herdr.tab": "tb" + digest("tab:" + tab).slice(0, 30) } : {}), where: clip(p.workspace_id, 128) };
      return { id: p.pane_id, workspace: ws, tab, target: typeof p.terminal_id === "string" && /^term_[a-zA-Z0-9]{1,96}$/.test(p.terminal_id) ? p.terminal_id : null, terminal: {
        address: "t" + digest(p.pane_id).slice(0, 12), title, name: null, argv: [], cwd: clip(p.cwd, 512),
        state: "live", created_ms: 0, screen: "inexact", cols: 80, rows: 24,
        labels, turn: 0, status,
      } };
    });
  cacheUntil = Date.now() + 1_000;
  return cache;
}

let rectCache = new Map(); // pane_id → { x, y, width, height }
let rectCacheAt = 0;
/** pane_id → rect from `pane layout` (one call per tab); empty when the TUI lacks it. */
async function paneRects() {
  const live = await panes();
  if (live.every((p) => rectCache.has(p.id))) return rectCache; // same panes → same rects
  if (Date.now() < rectCacheAt) return rectCache; // a pane mid-create: keep the last snapshot a moment
  const tabs = [...new Set(live.map((p) => p.tab).filter(Boolean))].slice(0, 40);
  const next = new Map();
  for (const tab of tabs) {
    const probe = live.find((p) => p.tab === tab)?.id;
    if (!probe) continue;
    try {
      const parsed = JSON.parse(await run(["pane", "layout", "--pane", probe]));
      for (const pane of parsed?.result?.layout?.panes ?? []) {
        if (typeof pane?.pane_id === "string" && pane?.rect && ["x", "y", "width", "height"].every((k) => Number.isFinite(pane.rect[k]))) {
          next.set(pane.pane_id, { x: pane.rect.x, y: pane.rect.y, width: pane.rect.width, height: pane.rect.height });
        }
      }
    } catch { /* an older TUI: fall back to a flat row */ }
  }
  rectCache = next;
  rectCacheAt = Date.now() + 1_000;
  return rectCache;
}

/** Split `items` by a clean cut on one axis; the most balanced cut wins. */
function bisect(items, axis, span) {
  const edges = new Set();
  for (const it of items) { edges.add(it.rect[axis]); edges.add(it.rect[axis] + it.rect[span]); }
  let best = null;
  for (const cut of edges) {
    const left = items.filter((it) => it.rect[axis] + it.rect[span] <= cut);
    const right = items.filter((it) => it.rect[axis] >= cut);
    if (!left.length || !right.length || left.length + right.length !== items.length) continue;
    const lo = Math.min(...items.map((it) => it.rect[axis]));
    const hi = Math.max(...items.map((it) => it.rect[axis] + it.rect[span]));
    const score = Math.abs((cut - lo) - (hi - cut));
    if (!best || score < best.score) best = { cut, left, right, score, lo, hi };
  }
  return best;
}

/** The doc's layout tree for one tab's panes, from their on-screen rectangles. */
function layoutTree(items, nodeId) {
  if (items.length <= 1) return { id: nodeId, type: "row", children: items.map(blockOf) };
  const x = bisect(items, "x", "width"); // a vertical cut → children side by side
  const y = bisect(items, "y", "height"); // a horizontal cut → children stacked
  const pick = (c) => (c ? c.score / Math.max(1, c.hi - c.lo) : Infinity);
  let cut, axis, span, type;
  if (x && pick(x) <= pick(y)) { cut = x; axis = "x"; span = "width"; type = "row"; }
  else if (y) { cut = y; axis = "y"; span = "height"; type = "column"; }
  else return { id: nodeId, type: "row", children: items.map(blockOf) }; // no clean cut: flat
  const total = cut.hi - cut.lo || 1;
  const extent = (list) => Math.max(...list.map((it) => it.rect[axis] + it.rect[span])) - Math.min(...list.map((it) => it.rect[axis]));
  const share = (list) => ({ weight: Math.max(0.01, Math.round((extent(list) / total) * 1000) / 1000) });
  const child = (list, suffix) => list.length === 1 ? { ...blockOf(list[0]), size: share(list) } : { ...layoutTree(list, nodeId + suffix), size: share(list) };
  return { id: nodeId, type, children: [child(cut.left, "l"), child(cut.right, "r")] };
}

const blockOf = (it) => ({ id: "p" + digest("pane:" + it.pane.id).slice(0, 30), type: "block", content: { terminal: it.pane.terminal.address } });

/** Terminal records as the viewers list them: panes with their on-screen geometry.
 *  Agent panes also carry their program (π) in name/argv — the app's programs table
 *  matches argv, so its agents mod and icons light up for them. */
async function terminalRecords() {
  const rects = await paneRects();
  const out = [];
  for (const { id, terminal } of await panes()) {
    const rect = rects.get(id);
    let record = rect ? { ...terminal, cols: Math.max(2, Math.min(1000, rect.width)), rows: Math.max(2, Math.min(1000, rect.height)) } : { ...terminal };
    const info = await agentInfo(id);
    if (info.agent) record = { ...record, name: info.agent, argv: [info.agent] };
    out.push(record);
  }
  return out;
}

/** Seating changes (workspace/tab/pane set) are what change the layout doc. */
function docFingerprint(records) {
  return JSON.stringify(records.map((t) => [t.address, t.labels["herdr.space"] ?? null, t.labels["herdr.tab"] ?? null]));
}

/** What a viewer must hear about between polls: titles, folders, seating, life. */
function seenFingerprint(records) {
  return new Map(records.map((t) => [t.address, [t.title, t.cwd, t.labels["herdr.space"] ?? null, t.labels["herdr.tab"] ?? null, t.status?.state ?? null]]));
}

function clip(x, n) { return typeof x === "string" ? x.slice(0, n) : ""; }

let wsLabels = new Map();
let wsLabelsUntil = 0;
/** workspace_id → label; empty when the TUI lacks `workspace list` (spaces then go unnamed). */
async function workspaceLabels() {
  if (Date.now() < wsLabelsUntil) return wsLabels;
  try {
    const parsed = JSON.parse(await run(["workspace", "list"]));
    wsLabels = new Map((Array.isArray(parsed?.result?.workspaces) ? parsed.result.workspaces : [])
      .filter((w) => typeof w?.workspace_id === "string" && typeof w?.label === "string")
      .map((w) => [w.workspace_id, clip(w.label, 120)]));
  } catch { wsLabels = new Map(); }
  wsLabelsUntil = Date.now() + 5_000;
  return wsLabels;
}

/**
 * The `herdr-app` layout document the desktop app renders: each TUI workspace becomes a
 * space (named by its label, placed by its first pane's cwd), each tab a tab, each pane a
 * terminal block. Read-only: structural edits stay in the TUI (doc.set is not offered).
 */
// Seating maps for doc writes: the doc's digest ids back to Herdr's own ids.
const seatWorkspace = new Map(); // spaceId → workspace_id
const seatTab = new Map(); // tabId → { ws, tab }
const seatPane = new Map(); // terminal address → pane_id

let tabLabels = new Map();
let tabLabelsUntil = 0;
/** tab_id → label; empty when the TUI lacks `tab list`. */
async function tabLabelMap() {
  if (Date.now() < tabLabelsUntil) return tabLabels;
  try {
    const parsed = JSON.parse(await run(["tab", "list"]));
    tabLabels = new Map((Array.isArray(parsed?.result?.tabs) ? parsed.result.tabs : [])
      .filter((t) => typeof t?.tab_id === "string" && typeof t?.label === "string")
      .map((t) => [t.tab_id, clip(t.label, 120)]));
  } catch { tabLabels = new Map(); }
  tabLabelsUntil = Date.now() + 5_000;
  return tabLabels;
}

async function layoutDoc() {
  const labels = await workspaceLabels();
  const tabNames = await tabLabelMap();
  const rects = await paneRects();
  const byTab = new Map();
  for (const p of await panes()) {
    if (!p.workspace || !p.tab) continue; // a pane outside every workspace stays off the app's screens
    if (!byTab.has(p.tab)) byTab.set(p.tab, { workspace: p.workspace, panes: [] });
    byTab.get(p.tab).panes.push(p);
  }
  const spaces = new Map();
  for (const [tab, { workspace, panes: tabPanes }] of byTab) {
    const spaceId = "sp" + digest("space:" + workspace).slice(0, 30);
    if (!spaces.has(workspace)) spaces.set(workspace, { id: spaceId, name: labels.get(workspace) || "", folder: tabPanes[0]?.terminal.cwd || "", tabs: new Map() });
    const space = spaces.get(workspace);
    seatWorkspace.set(spaceId, workspace);
    if (!space.folder && tabPanes[0]?.terminal.cwd) space.folder = tabPanes[0].terminal.cwd;
    const tabId = "tb" + digest("tab:" + tab).slice(0, 30);
    seatTab.set(tabId, { ws: workspace, tab });
    let root;
    if (tabPanes.every((p) => rects.has(p.id))) {
      // The TUI's real split structure, rebuilt from the panes' on-screen rectangles.
      const items = tabPanes.map((p) => ({ pane: p, rect: rects.get(p.id) })).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      root = layoutTree(items, tabId);
    } else {
      root = { id: tabId, type: "row", children: tabPanes.map((p) => blockOf({ pane: p })) };
    }
    for (const p of tabPanes) seatPane.set(p.terminal.address, p.id);
    space.tabs.set(tab, { id: tabId, name: tabNames.get(tab) || "", root });
  }
  return { spaces: [...spaces.values()].map((s) => ({ id: s.id, name: s.name, folder: s.folder, tabs: [...s.tabs.values()] })) };
}

const versionOf = (value) => Number.parseInt(digest(JSON.stringify(value)).slice(0, 12), 16);

/** Wrap text to a viewer's width, breaking long tokens — a transcript that reads like the pane. */
function wrapFor(width, text) {
  const cols = Math.max(20, Math.min(200, width - 2));
  const out = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > cols) { // paths and URLs: split rather than overflow
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, cols));
        word = word.slice(cols);
      }
      if (!word) continue;
      if (line && line.length + 1 + word.length > cols) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
  }
  return out.join("\r\n");
}

const sessionCache = new Map(); // pane_id → { session, agent, until } — pane get is a per-read cost otherwise
async function agentInfo(paneId) {
  const cached = sessionCache.get(paneId);
  if (cached && Date.now() < cached.until) return cached;
  let session = null;
  let agent = null;
  try {
    const parsed = JSON.parse(await run(["pane", "get", paneId]));
    const pane = parsed?.result?.pane;
    const value = pane?.agent_session?.value;
    if (typeof value === "string" && value.endsWith(".jsonl") && value.startsWith(homedir() + "/")) session = value;
    if (typeof pane?.agent === "string" && pane.agent) agent = clip(pane.agent, 32);
  } catch { /* a pane without an agent session simply has no transcript */ }
  const info = { session, agent, until: Date.now() + 30_000 };
  sessionCache.set(paneId, info);
  return info;
}

async function agentSession(hit) {
  return (await agentInfo(hit.id)).session;
}

/** The pane's recent chat as structured blocks — the history that lives inside the agent
 *  (π) and never was in the terminal stream. */
async function transcriptBlocks(hit) {
  const session = await agentSession(hit);
  if (!session) return null;
  try {
    const fh = await openFile(session, "r");
    let chunk;
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 256 * 1024);
      chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, size - len);
    } finally {
      await fh.close();
    }
    const lines = chunk.toString("utf8").split("\n").slice(1); // the head line is usually cut mid-record
    const blocks = [];
    for (const raw of lines.slice(-300)) {
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (entry?.type !== "message") continue;
      const message = entry.message ?? {};
      const role = message.role;
      if (role !== "user" && role !== "assistant") continue; // tool chatter stays out of the transcript
      const content = message.content;
      const text = (typeof content === "string" ? content : Array.isArray(content) ? content.filter((x) => x?.type === "text").map((x) => x?.text ?? "").join(" ") : "").trim();
      if (!text) continue;
      blocks.push({ role, text: text.slice(0, 4000) });
    }
    // Newest whole messages first; the oldest drops off whole, never cut mid-thought.
    const kept = blocks.slice(-40);
    let size = kept.reduce((n, b) => n + b.text.length, 0);
    while (kept.length > 1 && size > 40_000) size -= kept.shift().text.length;
    return kept.length ? kept : null;
  } catch {
    return null; // best-effort
  }
}

/** Transcript blocks as the plain lines a text reader (the phone's history view) shows.
 *  With `joinScreen`, the current screen follows: the in-flight turn is not in the
 *  session file yet (π writes it when the turn ends), so the visible screen is the
 *  only bridge — history then flows straight into what the viewer renders below. */
async function transcriptText(hit, { joinScreen = false } = {}) {
  const blocks = await transcriptBlocks(hit);
  const parts = [];
  if (blocks) parts.push(blocks.map((b) => (b.role === "user" ? "❯ " : "● ") + b.text).join("\n"));
  if (joinScreen) {
    try {
      // A text view wants words, not terminal paint: drop OSC replies and every CSI
      // (colors included) — the seed path keeps its paint, this one reads clean.
      const screen = (await run(["pane", "read", hit.id, "--source", "visible", "--format", "text", "--raw"]))
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+$/, "");
      if (screen) {
        if (parts.length) parts.push("──── trở lại hiện tại ────");
        parts.push(screen);
      }
    } catch { /* best-effort seam */ }
  }
  return parts.length ? parts.join("\n") : null;
}

/** The terminal addresses a doc tree shows. */
function collectTerminals(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "block" && node.content?.terminal) out.push(node.content.terminal);
  for (const child of Array.isArray(node.children) ? node.children : []) collectTerminals(child, out);
  return out;
}

const firstLeaf = (node) => {
  let cur = node;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.type === "block") return cur.content?.terminal ?? null;
    cur = Array.isArray(cur.children) && cur.children.length ? cur.children[0] : null;
  }
  return null;
};

/** Divider drags: weight changes between siblings become pane resize steps. */
function treeDiffResize(cur, nxt, ops) {
  if (!cur || !nxt || cur.type !== nxt.type) return;
  if ((cur.type !== "row" && cur.type !== "column") || !Array.isArray(cur.children) || cur.children.length !== nxt.children?.length) return;
  const axis = cur.type === "row" ? ["right", "left"] : ["down", "up"];
  for (let i = 0; i < cur.children.length; i++) {
    const c = cur.children[i], x = nxt.children[i];
    const cw = c?.size?.weight, xw = x?.size?.weight;
    if (Number.isFinite(cw) && Number.isFinite(xw) && Math.abs(xw - cw) > 0.01 && xw > cw) {
      // This child grows; the sibling it takes from says which edge moves.
      const j = nxt.children.findIndex((s, k) => k !== i && Number.isFinite(cur.children[k]?.size?.weight) && (s?.size?.weight ?? 1) < (cur.children[k]?.size?.weight ?? 1));
      const leaf = firstLeaf(c) ?? firstLeaf(cur.children[i]);
      if (j >= 0 && leaf && seatPane.has(leaf)) ops.push(["pane", "resize", "--pane", seatPane.get(leaf), "--direction", axis[j > i ? 0 : 1], "--amount", String(Math.min(0.5, Math.round((xw - cw) * 1000) / 1000))]);
    }
    treeDiffResize(c, x, ops);
  }
}

const labelArg = (name) => typeof name === "string" && name.trim() && !name.trim().startsWith("-") ? name.trim().slice(0, 120) : null;
const renameArg = (name) => typeof name === "string" && !name.trim().startsWith("-") ? name.trim().slice(0, 120) : null; // a rename may clear the label

/** A doc.set is a diff against the live layout: adds, removals, renames and divider drags. */
async function applyDocEdit(cur, nxt) {
  if (!nxt || !Array.isArray(nxt.spaces)) throw invalid();
  const ops = [];
  const nextSpaceIds = new Set();
  for (const space of nxt.spaces.slice(0, 40)) {
    if (!space || typeof space.id !== "string" || !Array.isArray(space.tabs)) continue;
    nextSpaceIds.add(space.id);
    const before = cur.spaces.find((s) => s.id === space.id);
    const name = labelArg(space.name);
    if (!before) {
      if (name) ops.push(["workspace", "create", "--label", name]);
      continue; // its tabs arrive with the panes Herdr seats there
    }
    const wsId = seatWorkspace.get(space.id);
    const newName = renameArg(space.name);
    if (newName !== null && newName !== before.name && wsId) ops.push(["workspace", "rename", wsId, newName]);
    const nextTabIds = new Set();
    for (const tab of space.tabs.slice(0, 40)) {
      if (!tab || typeof tab.id !== "string" || !tab.root) continue;
      nextTabIds.add(tab.id);
      const seat = seatTab.get(tab.id);
      const tabName = renameArg(tab.name);
      const curTab = before.tabs.find((t) => t.id === tab.id);
      if (!curTab && seat) ops.push(["tab", "create", "--workspace", seat.ws, ...(labelArg(tab.name) ? ["--label", labelArg(tab.name)] : [])]);
      else if (curTab && tabName !== null && tabName !== curTab.name && seat) ops.push(["tab", "rename", seat.tab, tabName]);
      if (curTab) {
        const keep = new Set(collectTerminals(tab.root));
        for (const addr of collectTerminals(curTab.root)) if (!keep.has(addr) && seatPane.has(addr)) ops.push(["pane", "close", seatPane.get(addr)]);
      }
    }
    for (const tabId of before.tabs.map((t) => t.id)) {
      const seat = seatTab.get(tabId);
      if (!nextTabIds.has(tabId) && seat) ops.push(["tab", "close", seat.tab]);
    }
  }
  for (const space of cur.spaces) {
    const wsId = seatWorkspace.get(space.id);
    if (!nextSpaceIds.has(space.id) && wsId) ops.push(["workspace", "close", wsId]);
  }
  for (const space of nxt.spaces) {
    const before = cur.spaces.find((s) => s.id === space.id);
    if (!before) continue;
    for (const tab of space.tabs ?? []) {
      const curTab = before.tabs.find((t) => t.id === tab.id);
      if (curTab?.root && tab.root) treeDiffResize(curTab.root, tab.root, ops);
    }
  }
  for (const op of ops.slice(0, 40)) {
    try { await run(op); } catch { /* a step that races the TUI must not block the rest */ }
  }
}

const status = async () => ({ core, version, pid: process.pid, uptime_ms: Date.now() - startedAt, holders: [], live: (await panes()).length, finished: 0, keeps_running_after_logout: true });
class RpcError extends Error {
  constructor(code, message, kind) { super(message); this.code = code; this.kind = kind; }
}
const invalid = () => new RpcError(-32602, "Invalid params", "usage");

async function findPane(terminal) {
  if (typeof terminal !== "string") throw invalid();
  const hit = (await panes()).find((x) => x.terminal.address === terminal);
  if (!hit) throw new RpcError(-32000, "No such terminal", "not_found");
  return hit;
}

async function call(method, p, framed, attach, startEvents) {
  switch (method) {
    case "hello":
      return { core, version, generation: 1, framed, features: framed ? ["framed", "attach", "status", ...(interactive ? ["resize_notifications"] : [])] : ["status"], methods: [...methods, ...(framed ? ["terminal.attach"] : []), ...(interactive ? inputMethods : [])], keeps_running_after_logout: true };
    case "server.status": return status();
    case "terminal.list": {
      const filters = p.labels ?? {};
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw invalid();
      const terminals = (await terminalRecords()).filter((t) =>
        Object.entries(filters).every(([k, v]) => Object.hasOwn(t.labels, k) && t.labels[k] === v));
      return { terminals, hidden_finished: 0, machines: [] };
    }
    case "events.subscribe": {
      // A real event stream: the app re-reads the layout doc and terminal list from these,
      // without them it never notices a pane opened or closed on the TUI.
      if (!framed) throw new RpcError(-32000, "Framed connection required", "needs_framed");
      const records = await terminalRecords();
      const channel = startEvents(records);
      return { terminals: records, seq: 0, channel };
    }
    case "terminal.send":
    case "terminal.keys":
    case "terminal.interrupt": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      const { id, terminal } = await findPane(p.terminal);
      const { turn } = terminal;
      if (method === "terminal.send") {
        if (!inputText(p.text) || p.wait === true || p.if != null) throw invalid();
        // Herdr's pane run takes positional text and submits it with Enter in one API request.
        await run(["pane", "run", id, p.text]);
        return { turn, status: null, started: null, wait: null };
      }
      const keys = method === "terminal.interrupt" ? ["ctrl+c"] : p.keys;
      if (!Array.isArray(keys) || !keys.length || keys.length > 32 || keys.some((key) => typeof key !== "string" || !/^(?:(?:ctrl|alt|shift|super)\+)*[a-z0-9][a-z0-9_-]{0,15}$/i.test(key) || key.length > 32)) throw invalid();
      await run(["pane", "send-keys", id, ...keys]);
      return method === "terminal.interrupt" ? { key: keys[0], outcome: "unknown" } : { turn, status: null };
    }
    case "terminal.run": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      if (!Array.isArray(p.argv) || !p.argv.length || p.argv.length > 16 || p.argv.some((a) => typeof a !== "string" || !a || a.length > 256 || a.includes("\0") || a.startsWith("-"))) throw invalid();
      // The TUI owns placement: the new pane splits the seat the request labels (or the first pane), in the asked direction.
      const before = await panes();
      const space = p.labels && typeof p.labels["herdr.space"] === "string" ? p.labels["herdr.space"] : null;
      const target = before.find((x) => x.terminal.labels["herdr.space"] === space && space) ?? before[0];
      if (!target) throw new RpcError(-32000, "No pane to split", "unavailable");
      const cwd = typeof p.cwd === "string" && p.cwd && !p.cwd.includes("\0") && p.cwd.length <= 512 && !p.cwd.startsWith("-") ? ["--cwd", p.cwd] : [];
      await run(["pane", "split", "--pane", target.id, "--direction", p.place === "down" ? "down" : "right", ...cwd]);
      // Wait briefly for the new pane to appear beside the one we split, then report it seated.
      let record;
      for (let i = 0; i < 10 && !record; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        cacheUntil = 0; // the pane list is cached a second; force a fresh look
        const fresh = await panes();
        const created = fresh.find((x) => x.tab === target.tab && !before.some((o) => o.id === x.id));
        if (created) {
          record = (await terminalRecords()).find((t) => t.address === created.terminal.address) ?? null;
          try { await run(["pane", "run", created.id, p.argv.join(" ")]); } catch { /* the pane stands; the command is best-effort */ }
        }
      }
      if (!record) throw new RpcError(-32000, "The new pane did not appear", "unavailable");
      return { terminal: record, started: null, wait: null };
    }
    case "terminal.kill": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      const hit = await findPane(p.terminal);
      await run(["pane", "close", hit.id]);
      return {};
    }
    case "terminal.get":
    case "terminal.attach":
    case "terminal.read": {
      const hit = await findPane(p.terminal);
      const rect = (await paneRects()).get(hit.id);
      const dims = { cols: Math.max(2, Math.min(1000, rect?.width ?? 80)), rows: Math.max(2, Math.min(1000, rect?.height ?? 24)) };
      if (method === "terminal.get") return { ...hit.terminal, ...dims };
      if (method === "terminal.attach") {
        if (!framed) throw new RpcError(-32000, "Framed connection required", "needs_framed");
        if ([p.cols, p.rows].some((n) => n !== undefined && n !== 0 && !validDimension(n))) throw invalid();
        return attach(hit, p, rect);
      }
      const lines = p.lines ?? 0;
      if (!Number.isSafeInteger(lines) || lines < 0) throw invalid();
      // An agent pane keeps its chat inside itself: serve the transcript as "stitched"
      // history (the core's term for a full-screen app read by scrolling it), joined to
      // the live screen so the seam never shows a gap mid-turn.
      const transcript = await transcriptText(hit, { joinScreen: true });
      if (transcript) {
        const all = transcript.split("\n");
        const take = lines > 0 ? all.slice(-Math.min(2000, lines)) : all.slice(-24);
        const text = take.join("\n");
        return { text: text.slice(0, 60 * 1024), complete: transcript.length <= 60 * 1024, how: "stitched", why: null };
      }
      // A shell pane: `recent` carries the history viewers scroll (the phone reads it);
      // a pane with none — fresh — falls back to the on-screen text so it is not blank.
      let text = await run(["pane", "read", hit.id, "--source", "recent", "--lines", String(Math.max(24, Math.min(120, lines + 24))), "--format", "text", "--raw"]);
      let how = "history";
      if (!text.trim()) {
        text = await run(["pane", "read", hit.id, "--source", "visible", "--lines", String(dims.rows), "--format", "text", "--raw"]);
        how = "screen";
      }
      return { text: text.slice(0, 32 * 1024), complete: text.length <= 32 * 1024, how };
    }
    case "templates.list": return { templates: [] };
    case "machine.list": return { machines: [] };
    case "terminal.label": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      const hit = await findPane(p.terminal);
      const labels = p.labels ?? {};
      if (!labels || typeof labels !== "object" || Array.isArray(labels)) throw invalid();
      const clean = {};
      for (const [k, v] of Object.entries(labels).slice(0, 16)) {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k) || typeof v !== "string" || v.length > 200) throw invalid();
        // Seating labels are the adapter's; everything else is the app's to keep.
        if (k !== "herdr.space" && k !== "herdr.tab" && k !== "where") clean[k] = v;
      }
      if (Object.keys(clean).length) appLabels.set(hit.id, clean); else appLabels.delete(hit.id);
      saveAppLabels();
      cacheUntil = 0; // the next listing shows the new labels
      return {};
    }
    case "terminal.keep": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      await findPane(p.terminal); // Herdr panes already outlive any one viewer
      return {};
    }
    case "doc.set": {
      // Layout edits arrive as a whole document; the TUI applies the difference.
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      if (typeof p.name !== "string" || p.name !== "herdr-app" || p.on) throw invalid();
      if (!p.value || typeof p.value !== "object" || !Array.isArray(p.value.spaces)) throw invalid();
      if (!Number.isSafeInteger(p.version) || p.version < 0) throw invalid();
      const current = await layoutDoc();
      if (p.version !== versionOf(current)) throw new RpcError(-32000, "The TUI layout moved on; read it again", "conflict");
      await applyDocEdit(current, p.value);
      // The edits land on the TUI asynchronously; wait briefly until the doc reflects them.
      const before = versionOf(current);
      let next = current;
      for (let tries = 0; tries < 6; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        cacheUntil = 0;
        rectCacheAt = 0;
        wsLabelsUntil = 0;
        tabLabelsUntil = 0;
        rectCache = new Map();
        next = await layoutDoc();
        if (versionOf(next) !== before) break;
      }
      return { version: versionOf(next) };
    }
    case "doc.get": {
      if (typeof p.name !== "string" || !p.name || p.name.length > 128) throw invalid();
      if (p.name !== "herdr-app") return { value: null, version: 0 };
      const value = await layoutDoc();
      // Content-derived, so the version is stable while the layout is unchanged.
      return { value, version: versionOf(value) };
    }
    default: throw new RpcError(-32601, "Method not available on this TUI adapter", "forbidden");
  }
}

async function paint(paneId, rows) {
  const raw = await run(["pane", "read", paneId, "--source", "visible", "--lines", String(rows), "--format", "text", "--raw"]);
  // Do not replay host terminal escapes (clipboard, title, device queries, etc.).
  const text = stripVTControlCharacters(raw.slice(0, 16_000))
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\n/g, "\r\n");
  return Buffer.from("\x1b[2J\x1b[H" + text);
}

async function serve() {
  let framed = false;
  let buffer = Buffer.alloc(0);
  const streams = new Map();
  let nextChannel = 1;
  let timer;
  let polling = false;
  let closed = false;

  function output(bytes) {
    return new Promise((resolve, reject) => process.stdout.write(bytes, (err) => err ? reject(err) : resolve()));
  }
  function frame(channel, kind, body = Buffer.alloc(0)) {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(channel, 0);
    header[4] = kind;
    header.writeUInt32LE(body.length, 5);
    return output(Buffer.concat([header, body]));
  }
  function write(reply) {
    const body = Buffer.from(JSON.stringify(reply));
    return framed ? frame(0, frameKind.data, body) : output(Buffer.concat([body, Buffer.from("\n")]));
  }
  async function attach(hit, p, rect) {
    if (streams.size >= maxStreams || nextChannel > 0xffff_ffff) throw new RpcError(-32000, "Too many open terminal views", "unavailable");
    const writable = interactive && p.observe !== true;
    if (writable && !hit.target) throw new RpcError(-32000, "This pane has no native terminal stream", "unavailable");
    // The viewer owns the size (herdr-core): attach at what it asked to render at, so the
    // first frame is already its size and no repaint stacks an old screen into its scrollback.
    const real = { cols: Math.min(500, Math.max(2, p.cols ?? rect?.width ?? hit.terminal.cols)), rows: Math.min(300, Math.max(2, p.rows ?? rect?.height ?? hit.terminal.rows)) };
    let native = writable ? await openTerminal(herdr, hit.target, real.cols, real.rows) : null;
    if (native) {
      // History above the live screen: the agent's own transcript (every viewer), and the
      // terminal scrollback when the viewer asked for it (the desktop app does; the phone
      // does not, and its mirror stays as it was). Herdr streams only the live screen.
      const parts = [];
      const blocks = await transcriptBlocks(hit);
      if (blocks) {
        // Theme-neutral styling: bold/dim attributes only, no palette — π's own `system`
        // theme takes colors from the terminal at runtime, and so does this seed.
        const dim = "\x1b[2m", bold = "\x1b[1m", reset = "\x1b[0m";
        const out = [dim + "──── lịch sử chat (mới nhất ở dưới) ────" + reset];
        for (const b of blocks) {
          const mark = b.role === "user" ? bold + "❯ " + reset : "● ";
          const wrapped = wrapFor(real.cols, b.text).split("\r\n");
          out.push(wrapped[0] ? mark + wrapped[0] : mark);
          for (const line of wrapped.slice(1)) out.push("  " + line);
          out.push("");
        }
        out.push(dim + "──── trở lại hiện tại ────" + reset);
        // The seam: the in-flight turn lives only on the screen, so end the seed with
        // the screen itself — the viewer's first paint then continues it, not jumps.
        try {
          const screen = (await run(["pane", "read", hit.id, "--source", "visible", "--format", "text", "--raw"])).replace(/\s+$/, "");
          if (screen) out.push(screen);
        } catch { /* best-effort seam */ }
        parts.push(Buffer.from(out.join("\r\n") + "\r\n"));
      }
      if (!blocks && Number.isSafeInteger(p.history) && p.history > 0) {
        try {
          const back = await run(["pane", "read", hit.id, "--source", "recent", "--lines", String(Math.min(2000, p.history)), "--format", "ansi", "--raw"]);
          const lines = back.split(/\r?\n/);
          const history = lines.slice(0, Math.max(0, lines.length - real.rows)).join("\r\n")
            // Colors stay; terminal replies, links and other noise would only confuse mirrors.
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, (m) => (m.endsWith("m") ? m : ""));
          if (history.trim()) parts.push(Buffer.from(history + "\r\n"));
        } catch { /* seeding is best-effort */ }
      }
      if (parts.length) native = { ...native, first: { ...native.first, bytes: Buffer.concat([...parts, native.first.bytes]) } };
    }
    const channel = nextChannel++;
    const resize = Boolean(native && p.resize_notifications === true);
    const terminal = native ? { ...hit.terminal, cols: native.first.cols, rows: native.first.rows } : hit.terminal;
    streams.set(channel, { id: hit.id, rows: Math.min(120, real.rows), realCols: real.cols, realRows: real.rows, credit: windowBytes, last: null, ready: false, native, resize });
    return { channel, terminal, resize_notifications: resize, automatic_input: false };
  }
  function release(channel) {
    const stream = streams.get(channel);
    if (!stream) return false;
    streams.delete(channel);
    stream.native?.close();
    stream.wake?.();
    return true;
  }
  async function closeStream(channel) {
    if (release(channel)) await frame(channel, frameKind.close);
  }
  async function pumpNative(channel, stream) {
    async function sendPaint(paint) {
      if (streams.get(channel) !== stream) return false;
      if (stream.resize && (paint.cols !== stream.cols || paint.rows !== stream.nativeRows)) {
        stream.cols = paint.cols;
        stream.nativeRows = paint.rows;
        const size = Buffer.alloc(4);
        size.writeUInt16LE(paint.cols, 0);
        size.writeUInt16LE(paint.rows, 2);
        await frame(channel, frameKind.resize, size);
      }
      for (let offset = 0; offset < paint.bytes.length;) {
        while (streams.get(channel) === stream && stream.credit === 0) await new Promise((resolve) => { stream.wake = resolve; });
        if (streams.get(channel) !== stream) return false;
        const end = Math.min(offset + stream.credit, offset + 32 * 1024, paint.bytes.length);
        stream.credit -= end - offset;
        await frame(channel, frameKind.data, paint.bytes.subarray(offset, end));
        offset = end;
      }
      return true;
    }
    try {
      if (await sendPaint(stream.native.first)) {
        for await (const paint of stream.native.frames) if (!(await sendPaint(paint))) break;
      }
    } catch { /* Unexpected native close is signalled on this stream. */ }
    finally { await closeStream(channel); }
  }
  function schedule(delay) {
    if (closed || polling || timer || ![...streams.values()].some((s) => !s.native && !s.events)) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll().catch(() => process.stdin.destroy());
    }, delay);
    timer.unref();
  }
  async function poll() {
    polling = true;
    try {
      for (const [channel, stream] of [...streams]) {
        // Bound subprocesses and stop reading while a client is not draining this view.
        if (closed || streams.get(channel) !== stream || stream.native || stream.events || !stream.ready || stream.credit < windowBytes / 2) continue;
        let snapshot;
        try { snapshot = await paint(stream.id, stream.rows); }
        catch {
          if (!closed) await closeStream(channel);
          continue;
        }
        if (closed || streams.get(channel) !== stream || snapshot.length > stream.credit || stream.last?.equals(snapshot)) continue;
        stream.credit -= snapshot.length;
        stream.last = snapshot;
        await frame(channel, frameKind.data, snapshot);
      }
    } finally {
      polling = false;
      schedule(pollMs);
    }
  }

  const startEvents = (records) => {
    const channel = nextChannel++;
    streams.set(channel, { events: true, seq: 0, credit: windowBytes, docFp: docFingerprint(records), seen: seenFingerprint(records), ready: true });
    scheduleEvents(0);
    return channel;
  };
  const eventMs = Math.max(250, Number.parseInt(process.env.HERDGATE_TUI_EVENT_MS ?? "1500", 10) || 1500);
  let eventTimer;
  let eventing = false;
  function scheduleEvents(delay) {
    if (closed || eventTimer || ![...streams.values()].some((s) => s.events)) return;
    eventTimer = setTimeout(() => {
      eventTimer = undefined;
      void pumpEvents().catch(() => process.stdin.destroy());
    }, delay);
    eventTimer.unref();
  }
  /** The layout doc and terminal records change on the TUI; retell the subscribers. */
  async function pumpEvents() {
    if (eventing) return;
    eventing = true;
    try {
      const watchers = [...streams].filter(([, s]) => s.events);
      if (!watchers.length) return;
      let records;
      try { records = await terminalRecords(); } catch { return; }
      const docFp = docFingerprint(records);
      const now = seenFingerprint(records);
      for (const [channel, s] of watchers) {
        if (closed || streams.get(channel) !== s) continue;
        const out = [];
        if (s.docFp !== docFp) out.push({ method: "event", params: { seq: ++s.seq, type: "doc" } });
        for (const addr of s.seen.keys()) if (!now.has(addr)) out.push({ method: "event", params: { seq: ++s.seq, type: "removed", terminal: addr, data: {} } });
        for (const t of records) {
          const prev = s.seen.get(t.address);
          if (prev === undefined) out.push({ method: "event", params: { seq: ++s.seq, type: "created", terminal: t.address, data: t } });
          else if (prev.join("\0") !== now.get(t.address).join("\0")) {
            const [title0, cwd0, space0, tabb0, status0] = prev;
            const [title1, cwd1, space1, tabb1, status1] = now.get(t.address);
            if (status0 !== status1) out.push({ method: "event", params: { seq: ++s.seq, type: "status", terminal: t.address, data: { status: t.status, records: {}, reported: t.status !== null } } });
            out.push({ method: "event", params: { seq: ++s.seq, type: "labels", terminal: t.address, data: { record: t } } });
          }
        }
        s.docFp = docFp;
        s.seen = now;
        if (out.length && s.credit > 4096) {
          const body = Buffer.from(out.map((e) => JSON.stringify(e)).join("\n") + "\n");
          s.credit -= body.length;
          await frame(channel, frameKind.data, body);
        }
      }
    } finally {
      eventing = false;
      scheduleEvents(eventMs);
    }
  }

  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let body;
        if (framed) {
          if (buffer.length < 9) break;
          const size = buffer.readUInt32LE(5);
          if (size > cap) throw new Error("Core frame too large");
          if (buffer.length < 9 + size) break;
          const channel = buffer.readUInt32LE(0);
          const kind = buffer[4];
          body = buffer.subarray(9, 9 + size);
          buffer = buffer.subarray(9 + size);
          if (channel !== 0) {
            const stream = streams.get(channel);
            if (stream && kind === frameKind.credit && size === 4) {
              stream.credit = Math.min(windowBytes, stream.credit + body.readUInt32LE());
              stream.wake?.();
              stream.wake = null;
            }
            if (stream && kind === frameKind.close && size === 0) await closeStream(channel);
            if (stream?.native) {
              try {
                if (kind === frameKind.data || kind === 6 /* automatic input: program replies, e.g. cell-size reports */) {
                  if (kind === frameKind.data && size > 32 * 1024) throw invalid();
                  await stream.native.send({ type: "terminal.input", bytes: body.toString("base64") });
                }
                // The viewer owns the size (herdr-core semantics): forwarded, and Herdr
                // restores the pane's own size when this stream closes.
                if (kind === frameKind.resize && size === 4) {
                  const cols = body.readUInt16LE(0), rows = body.readUInt16LE(2);
                  if (cols > 0 && rows > 0) await stream.native.send({ type: "terminal.resize", cols: Math.min(500, cols), rows: Math.min(300, rows) });
                }
              } catch { await closeStream(channel); }
            }
            continue;
          }
          if (kind !== frameKind.data) continue;
        } else {
          const end = buffer.indexOf(10);
          if (end > cap || (end < 0 && buffer.length > cap)) throw new Error("Core line too large");
          if (end < 0) break;
          body = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          if (!body.length) continue;
        }
        let msg;
        try { msg = JSON.parse(body.toString("utf8")); }
        catch { await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !Object.hasOwn(msg, "id")) continue;
        if (msg.id !== null && typeof msg.id !== "number" && typeof msg.id !== "string") continue;
        const reply = { jsonrpc: "2.0", id: msg.id };
        const nextFramed = framed || (msg.method === "hello" && msg.params?.framed === true);
        let result;
        try {
          if (msg.params != null && (typeof msg.params !== "object" || Array.isArray(msg.params))) throw invalid();
          result = await call(msg.method, msg.params ?? {}, nextFramed, attach, startEvents);
        } catch (err) {
          const error = err instanceof RpcError ? { code: err.code, message: err.message, data: { kind: err.kind } } : { code: -32000, message: "Herdr TUI unavailable", data: { kind: "unavailable" } };
          await write({ ...reply, error });
          continue;
        }
        await write({ ...reply, result });
        framed = nextFramed;
        if (msg.method === "terminal.attach") {
          const stream = streams.get(result.channel);
          stream.ready = true;
          if (stream.native) void pumpNative(result.channel, stream).catch(() => process.stdin.destroy());
          else schedule(0);
        }
      }
    }
  } finally {
    closed = true;
    clearTimeout(timer);
    clearTimeout(eventTimer);
    for (const channel of streams.keys()) release(channel);
  }
}

const command = args.join(" ");
try {
  if (command === "--version" || command === "-V") console.log(`hc ${version} (Herdgate ${mode} TUI adapter)`);
  else if (command === "server status" || command === "server status --json") console.log(JSON.stringify(await status()));
  else if (command === "connect" || command === "connect --json") {
    await serve();
  } else {
    console.error("herdgate: TUI adapter supports only connect, --version, and server status");
    process.exitCode = 111;
  }
} catch (e) {
  console.error(`herdgate: could not query the local Herdr TUI: ${e?.message ?? e}`);
  process.exitCode = 111;
}
