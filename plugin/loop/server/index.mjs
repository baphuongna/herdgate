#!/usr/bin/env node
// dev.herdgate.loop — generic agent-loop pane, event-chained.
//
// Lifecycle: `start` reads loop.json (CONFIG_DIR), creates the workspace
// "⚙ <label>" if missing, opens a tab, and types the boot command into the
// pane. From then on the `event` hook is the whole engine: when OUR pane
// settles (idle|done), it types the next-cycle prompt into the same pane.
// `pause` mutes nudges, `stop` closes the workspace we created, `status`
// reports honestly. No daemon: every entry is a short-lived process.
//
// Rules inherited from the herdgate dev-loop (paid for in production):
// - one JSON-RPC request per herdr process (api-bridge constraint)
// - only the pane in our registry is ever touched; foreign panes exit 0
// - the event hook must never crash or hang Herdr: every path is bounded
// - state survives restarts (state.json), so a crashed plugin loses nothing
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bootText, buildBoot, validateBootCommand } from "./boot.mjs";
import { auditWindow } from "./audit.mjs";

const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), ".config", "herdgate-loop");
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || join(homedir(), ".local", "state", "herdgate-loop");
const CONFIG = join(CONFIG_DIR, "loop.json");
const STATE = join(STATE_DIR, "state.json");
const LOG = join(STATE_DIR, "loop.log");
const LOG_CAP = 512 * 1024;
const MIN_COOLDOWN_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 20_000;
// C23 — the deferred nudge: one short-lived detached process (R6), spawned
// only when a new schedule id is minted (F1); re-scheduled at most 3 times
// after bridge failures (F5). This file, resolvable as a plain path —
// fileURLToPath, never a raw file-URL .pathname (F7, Windows).
const SELF = fileURLToPath(import.meta.url);
const DEFER_WINDOW_MS = 250; // same-window settles reuse one schedule (F1)
const DEFER_RETRY_MS = 5_000; // bridge failure: retry after 5s (F5)
const DEFER_RETRY_MAX = 3; // ...at most three times, then dropped
const DEFAULT_NUDGE =
  "\n\nLoop — vòng kế: đọc lại prompt file và chạy đúng MỘT vòng nữa rồi dừng. Không hỏi lại.\r";

const die = (code, msg) => { console.error(msg); process.exit(code); };
const out = (obj) => { console.log(JSON.stringify(obj)); };

function log(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOG, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
    if (readFileSync(LOG, "utf8").length > LOG_CAP) {
      const tail = readFileSync(LOG, "utf8").slice(-Math.floor(LOG_CAP / 2));
      writeFileSync(LOG, tail.slice(tail.indexOf("\n") + 1));
    }
  } catch { /* best effort */ }
}

function readJson(file, fallback) {
  try {
    // Strip a UTF-8 BOM: Windows PowerShell 5.1 `-Encoding utf8` and legacy
    // Notepad prepend one, and JSON.parse chokes on it — the plugin used to
    // report a misleading "not found" for a file the owner had just written
    // (caught live on the owner's laptop during the C12 probe).
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch { return fallback; }
}
const saveState = (s) => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); };
const loadState = () => readJson(STATE, {});
const loadConfig = () => readJson(CONFIG, null);

// loop.json is owner-controlled input: validate strictly, fail closed.
function validateConfig(c) {
  if (!c || c.v !== 1) return "loop.json: missing or unsupported `v` (expected 1)";
  if (typeof c.label !== "string" || !/^[A-Za-z0-9 _-]{1,24}$/.test(c.label)) return "loop.json: `label` must be 1-24 chars of [A-Za-z0-9 _-]";
  if (typeof c.promptFile !== "string" || !isAbsolute(c.promptFile)) return "loop.json: `promptFile` must be an absolute path";
  if (!existsSync(c.promptFile)) return `loop.json: promptFile not found: ${c.promptFile}`;
  if (typeof c.cwd !== "string" || !isAbsolute(c.cwd)) return "loop.json: `cwd` must be an absolute path";
  if (!existsSync(c.cwd)) return `loop.json: cwd not found: ${c.cwd}`;
  const home = homedir();
  // Either separator after home: Windows paths use "\" (homedir() is
  // drive-lettered there), POSIX uses "/" — node accepts both shapes on
  // Windows, so a hardcoded "/" rejected every real cwd like
  // C:\Users\x\proj (only cwd === home slipped through).
  const underHome = c.cwd === home || c.cwd.startsWith(home + "/") || c.cwd.startsWith(home + "\\");
  if (!underHome) return "loop.json: `cwd` must live under the owner's home";
  const cooldown = c.cooldownMs ?? MIN_COOLDOWN_MS;
  if (!Number.isInteger(cooldown) || cooldown < MIN_COOLDOWN_MS) return `loop.json: \`cooldownMs\` must be an integer >= ${MIN_COOLDOWN_MS}`;
  const maxCycles = c.maxCycles ?? 0;
  if (!Number.isInteger(maxCycles) || maxCycles < 0) return "loop.json: `maxCycles` must be an integer >= 0";
  if (c.nudgeText !== undefined && (typeof c.nudgeText !== "string" || c.nudgeText.length > 2000)) return "loop.json: `nudgeText` must be a string <= 2000 chars";
  // C20 watchFiles: the files the loop watches to auto-resume a self-paused
  // loop. Owner input, so fail closed like everything else: absolute paths,
  // 1-8 of them, each must exist and be a file (a directory can carry an
  // mtime but means the owner pointed at the wrong thing).
  if (c.watchFiles !== undefined) {
    if (!Array.isArray(c.watchFiles) || c.watchFiles.length < 1 || c.watchFiles.length > 8) return "loop.json: `watchFiles` must be an array of 1-8 absolute file paths";
    for (const f of c.watchFiles) {
      if (typeof f !== "string" || !isAbsolute(f)) return `loop.json: watchFiles entries must be absolute paths: ${f}`;
      if (!existsSync(f)) return `loop.json: watchFiles entry not found: ${f}`;
      if (!statSync(f).isFile()) return `loop.json: watchFiles entry is not a file: ${f}`;
    }
  }
  const bootErr = validateBootCommand(c.bootCommand);
  if (bootErr) return bootErr;
  // C17: auto-pause tuning. Defaults live here (not at the read sites) so
  // status, the event engine and validation agree on one number/pattern.
  const noopPauseAfter = c.noopPauseAfter ?? 2;
  if (!Number.isInteger(noopPauseAfter) || noopPauseAfter < 0) return "loop.json: `noopPauseAfter` must be an integer >= 0 (0 disables auto-pause)";
  if (c.noopPattern !== undefined) {
    if (typeof c.noopPattern !== "string" || c.noopPattern.length < 1 || c.noopPattern.length > 120) return "loop.json: `noopPattern` must be a string of 1-120 chars";
    try { new RegExp(c.noopPattern); } catch { return "loop.json: `noopPattern` is not a valid JS regex"; }
  }
  return null;
}

// One JSON-RPC request per process — the api-bridge contract.
// The real bridge (herdr 0.9.5, seen live on Windows) replies on its own
// schedule and does NOT exit on stdin EOF: it treats EOF as "disconnect
// now" and drops a pending reply, while the server has already executed
// the request. A one-shot `spawnSync` write-then-close races EOF against
// the reply and loses — the start action died "no-reply" on a real laptop
// while the server created the workspace anyway. So: write the request,
// HOLD stdin open, take the first reply line, then kill the child.
function herdr(method, params) {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  const argv = ["--session", process.env.HERDR_SESSION ?? "default", "remote-api-bridge"];
  const cmd = bin.endsWith(".mjs") ? [process.execPath, bin, ...argv] : [bin, ...argv];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: { code: "no-reply", message: `herdr ${method}: no reply within ${BRIDGE_TIMEOUT_MS}ms` } }),
      BRIDGE_TIMEOUT_MS,
    );
    child.stdout.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl === -1) return;
      const line = out.slice(0, nl).trim();
      if (!line) { out = out.slice(nl + 1); return; }
      try {
        const reply = JSON.parse(line);
        finish(reply.error ? { ok: false, error: reply.error } : { ok: true, result: reply.result });
      } catch { finish({ ok: false, error: { code: "bad-reply", message: line.slice(0, 120) } }); }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ ok: false, error: { code: "spawn", message: `herdr ${method}: ${String(e.message).slice(0, 120)}` } }));
    child.on("exit", (code) => { if (!settled) finish({ ok: false, error: { code: "no-reply", message: `herdr ${method}: rc=${code} ${err.slice(0, 120)}` } }); });
    child.stdin.on("error", () => {}); // EPIPE: the bridge exited before us
    child.stdin.write(JSON.stringify({ id: "r1", method, params }) + "\n"); // no .end(): stdin stays open until the reply lands
  });
}

const wsLabel = (label) => `⚙ ${label}`;

// C17: was the finished cycle work or a no-op? The honest witness is git —
// the dev-loop protocol has every cycle leave a commit, and a no-op cycle
// leaves a `no-op …` subject by convention. Read-only (`git log`), bounded
// (10s timeout), and agnostic to what the agent claims about itself.
// "unknown" (no repo, git failure, empty window) never moves the streak:
// without evidence the old nudge behavior stands — no punishment by guesswork.
function classifyCycle(cfg, sinceMs, now) {
  const r = spawnSync("git", ["-C", cfg.cwd, "log", `--since=${new Date(sinceMs).toISOString()}`, `--until=${new Date(now).toISOString()}`, "--format=%s"], { timeout: 10_000, encoding: "utf8" });
  if (r.error || r.status !== 0) return "unknown";
  const subjects = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (subjects.length === 0) return "unknown";
  let pattern;
  try { pattern = new RegExp(cfg?.noopPattern ?? "no-op"); } catch { return "unknown"; }
  return subjects.every((s) => pattern.test(s)) ? "no-op" : "work";
}

// One pane.list answers both "alive?" and (for kick) "busy?" — the pane
// object carries agent_status in the real bridge shape.
// C23: listPanes() keeps the outcomes apart (F5) — an infra failure
// (no-reply / spawn / bad JSON) is NOT "pane gone"; only getPane()'s callers
// still collapse everything to null.
async function listPanes() {
  const r = await herdr("pane.list", {});
  return r.ok && Array.isArray(r.result?.panes)
    ? { ok: true, panes: r.result.panes }
    : { ok: false, error: r.error?.code ?? "bad-reply" };
}

async function getPane(paneId) {
  const l = await listPanes();
  return l.ok ? l.panes.find((p) => p?.pane_id === paneId) ?? null : null;
}

async function paneAlive(paneId) {
  return (await getPane(paneId)) !== null;
}

// ---- actions -------------------------------------------------------------

async function cmdStatus() {
  const cfg = loadConfig();
  const cfgErr = cfg ? validateConfig(cfg) : "loop.json not found (CONFIG_DIR)";
  const s = loadState();
  const alive = s.paneId ? await paneAlive(s.paneId) : false;
  out({
    config: cfgErr ? { ok: false, error: cfgErr, path: CONFIG } : { ok: true, label: cfg.label, promptFile: cfg.promptFile, cwd: cfg.cwd, boot: buildBoot(cfg), cooldownMs: cfg.cooldownMs ?? MIN_COOLDOWN_MS, maxCycles: cfg.maxCycles ?? 0, noopPauseAfter: cfg.noopPauseAfter ?? 2, watchFiles: Array.isArray(cfg.watchFiles) ? cfg.watchFiles : [] },
    state: { paneId: s.paneId ?? null, workspaceId: s.workspaceId ?? null, status: s.status ?? "idle", paused: s.paused === true, pausedBy: s.pausedBy ?? null, pausedAt: s.pausedAt ?? 0, armed: s.armed === undefined ? true : s.armed === true, cycles: s.cycles ?? 0, noopStreak: Number(s.noopStreak) || 0, lastNudgeAt: s.lastNudgeAt ?? 0, lastAuditAt: s.lastAuditAt ?? null, auditHold: s.auditHold ?? null, paneAlive: alive },
    log: LOG,
  });
}

async function cmdStart() {
  const cfg = loadConfig();
  const cfgErr = cfg ? validateConfig(cfg) : "loop.json not found — write it in the plugin CONFIG_DIR first";
  if (cfgErr || !cfg) return die(2, cfgErr);
  const s = loadState();
  // A live pane we still own blocks a new run — whatever the status. "done"
  // leaves the final answer on screen for the owner to read; restarting on
  // top of it used to orphan that pane (its tab stayed open forever, events
  // swallowed by the foreign check). Refuse and name the way out: stop first.
  if (s.paneId && (await paneAlive(s.paneId))) {
    return die(1, `pane ${s.paneId} still open (status: ${s.status ?? "?"}${s.cycles ? `, ${s.cycles} cycles` : ""}) — stop it first`);
  }

  // Reuse our workspace by label; create it only if missing.
  const label = wsLabel(cfg.label);
  let wsId = null;
  const list = await herdr("workspace.list", {});
  const found = list.ok && Array.isArray(list.result?.workspaces) && list.result.workspaces.find((w) => w?.label === label);
  if (found) wsId = found.workspace_id;
  else {
    const created = await herdr("workspace.create", {});
    if (!created.ok) return die(3, `workspace.create failed: ${created.error?.message}`);
    wsId = created.result?.workspace?.workspace_id;
    if (!wsId) return die(3, "workspace.create returned no workspace_id");
    const renamed = await herdr("workspace.rename", { workspace_id: wsId, label });
    if (!renamed.ok) log(`warn: workspace.rename failed: ${renamed.error?.message}`);
  }
  const tab = await herdr("tab.create", { workspace_id: wsId, label: cfg.label, cwd: cfg.cwd });
  if (!tab.ok) return die(3, `tab.create failed: ${tab.error?.message}`);
  const paneId = tab.result?.root_pane?.pane_id;
  if (!paneId) return die(3, "tab.create returned no root_pane.pane_id");

  // Boot the agent. The line is shell-free by construction (boot.mjs):
  // pi reads the prompt through its @file argument — a quoted path every
  // shell (sh, PowerShell, cmd.exe) passes verbatim — and the pane is born
  // in cfg.cwd via tab.create, so there is no `cd` to spell per platform.
  // Owners with a different shell/agent override via loop.json bootCommand.
  const sent = await herdr("pane.send_text", { pane_id: paneId, text: bootText(cfg) });
  if (!sent.ok) return die(3, `pane.send_text failed: ${sent.error?.message}`);

  // C23: a fresh run object also drops any stale deferred schedule (F8).
  saveState({ paneId, workspaceId: wsId, status: "running", paused: false, armed: false, cycles: 0, noopStreak: 0, lastNudgeAt: 0, startedAt: Date.now() });
  log(`start: pane ${paneId} in ${label} (workspace ${wsId})`);
  out({ ok: true, paneId, workspaceId: wsId });
}

// C20 — kick: resume and nudge NOW, without the stop+start round-trip that
// throws away the pane (and its final answer). A busy agent is left alone
// (typing over a running turn would inject mid-thought); a dead pane sends
// the owner to `start`.
async function cmdKick() {
  const s = loadState();
  if (!s.paneId) return die(1, "no loop to kick (no state)");
  const pane = await getPane(s.paneId);
  if (!pane) return die(1, `pane ${s.paneId} is gone — start a new loop`);
  if (pane.agent_status === "working" || pane.agent_status === "blocked") {
    // C23/F9: even this early-exit — which never wrote state before — must
    // clear a pending deferred nudge: an owner kick supersedes it.
    if (s.deferredUntil !== undefined || s.deferredId !== undefined) {
      saveState({ ...s, deferredUntil: undefined, deferredId: undefined });
    }
    out({ ok: true, nudged: false, reason: "working" });
    return;
  }
  const cfg = loadConfig(); // deliberately not validated: a nudge is owner-initiated
  const text = cfg?.nudgeText ?? DEFAULT_NUDGE;
  const r = await herdr("pane.send_text", { pane_id: s.paneId, text });
  if (!r.ok) return die(3, `pane.send_text failed: ${r.error?.message}`);
  // C23: a real nudge clears any pending deferred nudge in the same write (R5/F14).
  saveState({ ...s, paused: false, pausedBy: undefined, noopStreak: 0, cycles: (Number(s.cycles) || 0) + 1, lastNudgeAt: Date.now(), deferredUntil: undefined, deferredId: undefined });
  log(`kick: nudged pane ${s.paneId}`);
  out({ ok: true, nudged: true, paneId: s.paneId });
}

async function cmdStop() {
  const s = loadState();
  if (!s.workspaceId) return die(1, "nothing to stop (no state)");
  const r = await herdr("workspace.close", { workspace_id: s.workspaceId });
  // A workspace that is already gone is a successful stop, not an error.
  const gone = r.ok || r.error?.code === "workspace_not_found" || /not found/i.test(r.error?.message ?? "");
  // C23: stopping the loop also cancels a pending deferred nudge (F8).
  saveState({ ...s, status: gone ? "stopped" : "stop-failed", paneId: gone ? null : s.paneId, deferredUntil: undefined, deferredId: undefined });
  log(`stop: workspace.close ${gone ? "ok" : `failed: ${r.error?.message}`}`);
  if (!gone) return die(3, `workspace.close failed: ${r.error?.message}`);
  out({ ok: true, status: "stopped" });
}

function cmdPause(resume) {
  const s = loadState();
  if (!s.paneId && !s.workspaceId) return die(1, "no loop to pause/resume");
  // WHOSE pause is it, and what does resume forgive? `owner` is a human
  // decision the engine never overrides; C17's self-pause stamps `auto` and
  // may be lifted when a watched file changes. resume = the owner decided:
  // the no-op streak is forgiven (stale no-ops would re-pause on the next
  // quiet cycle) and the audit hold is cleared for good (undefined keys
  // vanish from the JSON; the audited window stays recorded).
  const next = { ...s, paused: !resume };
  if (resume) {
    next.noopStreak = 0;
    delete next.pausedBy;
    delete next.pausedAt;
    next.auditHold = undefined;
  } else {
    next.pausedBy = "owner";
    next.pausedAt = Date.now();
  }
  saveState(next);
  log(resume ? `resume: nudges re-enabled (noop streak reset${s.auditHold ? ", audit hold cleared" : ""})` : "pause: nudges muted (pausedBy owner)");
  out({ ok: true, paused: !resume });
}

// C20 — auto-resume: a loop the LOOP itself paused (pausedBy "auto") may
// come back on its own when a watched file changes (mtime newer than the
// pause stamp) — the owner editing the backlog is the only signal needed.
// An owner pause is a human decision and is never overridden. Kept as two
// standalone functions so parallel work on the same fields (C17) merges
// cleanly: callers ask `shouldAutoResume(state, cfg)`; the file path is
// available for honest logs via `latestWatchedChange`.
function latestWatchedChange(state, cfg) {
  if (state.pausedBy !== "auto") return null;
  const files = Array.isArray(cfg?.watchFiles) ? cfg.watchFiles : [];
  if (files.length === 0) return null;
  let newest = null, newestMs = -Infinity;
  for (const f of files) {
    let ms;
    try { ms = statSync(f).mtimeMs; } catch { continue; } // vanished since validation: not a change
    if (ms > newestMs) { newestMs = ms; newest = f; }
  }
  return newestMs > (Number(state.pausedAt) || 0) ? newest : null;
}
const shouldAutoResume = (state, cfg) => latestWatchedChange(state, cfg) !== null;

// ---- the engine: event hook ----------------------------------------------

// C23 — settle bookkeeping, split from the nudge (F2/F12): everything a
// settle must decide EXACTLY ONCE runs here, in the old order — config,
// armed, status, paused/C20 auto-resume, auditHold, audit (C18),
// classify/auto-pause (C17), maxCycles, and finally the cooldown verdict.
// No process.exit inside: the verdict is returned and the caller acts on it.
// The returned `state` carries every bookkeeping update (audit mark, streak,
// auto-resume clears) and is persisted by whoever acts — the nudge write or
// the deferred schedule, never both. `reason` is the stop kind; cmdEvent
// turns it into the exact log line the old inline code produced. paneId is
// part of the fixed interface (the armed stop line quotes it) — the settle
// itself never touches the pane, only nudgeNow does.
function settleBookkeeping({ state: s0, cfg, paneId }) {
  let s = s0;
  if (cfg && validateConfig(cfg)) return { state: s, action: "stop", reason: "config invalid" };
  // A settle only counts once the pane has done work in this run. Herdr
  // also reports idle around pane birth (before any turn); the pre-arming
  // build nudged on it — observed live: nudge #1 fired 1.77s after start,
  // injecting the nudge text into a newborn task. States written before
  // `armed` existed (undefined) stay armed: a loop upgraded in place must
  // not stall mid-chain.
  const armed = s.armed === undefined ? true : s.armed === true;
  if (!armed) return { state: s, action: "stop", reason: "armed" };
  if (s.status !== "running") return { state: s, action: "stop", reason: "status" };
  if (s.paused === true) {
    const changed = latestWatchedChange(s, cfg);
    if (!changed) {
      // "owner" (or a pause without authorship, from older states) is never
      // lifted by the machine — one honest line per settle.
      return { state: s, action: "stop", reason: s.pausedBy === "auto" ? "paused-auto" : "paused-owner" };
    }
    s = { ...s, paused: false, pausedBy: undefined, pausedAt: undefined, noopStreak: 0 };
    saveState(s);
    log(`auto-resume: watched file changed — ${basename(changed)}`);
    // falls through: the resumed loop obeys the normal nudge rules below
    // (maxCycles, cooldown) exactly like an un-paused settle would.
  }
  if (s.auditHold) return { state: s, action: "stop", reason: "audit hold" };

  // Cycle audit (C18): the guardrails as a mechanism, not a promise. The
  // window is the work since the previous audit (or since this run started)
  // — placed before the maxCycles/cooldown branches so the LAST settle (the
  // one that flips the loop done) is audited too, and always before a nudge.
  // Fail-open is for INFRASTRUCTURE failures only: a git error is not
  // evidence of a violation, so the chain keeps feeding — and the window is
  // NOT marked audited (lastAuditAt keeps its value) so the next settle
  // re-audits it whole. A real violation holds the chain until resume.
  const since = Number(s.lastAuditAt) || Number(s.startedAt) || 0;
  const until = Date.now();
  const audit = auditWindow({ cwd: cfg.cwd, since, until });
  const auditMark = audit.ok ? { lastAuditAt: until } : {};
  if (audit.ok && audit.violations.length > 0) {
    const rules = [...new Set(audit.violations.map((v) => v.rule))];
    const next = { ...s, lastAuditAt: until, auditHold: { rules, at: until } };
    saveState(next);
    log(`AUDIT VIOLATION ${rules.join(",")} — nudges held until resume`);
    return { state: next, action: "stop", reason: "audit violation" };
  }
  if (audit.ok) log(`AUDIT ok commits=${audit.commits.length} tags=${audit.tags.length}${audit.skipped ? ` (${audit.skipped} token-shaped fixture/prose lines skipped)` : ""}`);
  else log(`AUDIT error ${audit.error} — fail-open: infra failure is not evidence of a violation; window re-audited next settle`);

  // C17: the settle is a valid finished cycle — classify it by the commits
  // it produced, BEFORE the nudge decision. "unknown" leaves the streak
  // (and the pause verdict) untouched; only a counted no-op can pause.
  const verdict = classifyCycle(cfg, Number(s.lastNudgeAt) || Number(s.startedAt) || 0, Date.now());
  if (verdict === "no-op") {
    s.noopStreak = (Number(s.noopStreak) || 0) + 1;
    const noopPauseAfter = cfg?.noopPauseAfter ?? 2;
    if (noopPauseAfter > 0 && s.noopStreak >= noopPauseAfter) {
      const next = { ...s, paused: true, pausedBy: "auto", pausedAt: Date.now(), status: "running", ...auditMark };
      saveState(next);
      return { state: next, action: "stop", reason: "auto-pause" };
    }
  } else if (verdict === "work") {
    s.noopStreak = 0;
  }
  const maxCycles = cfg?.maxCycles ?? 0;
  const cycles = Number(s.cycles) || 0;
  if (maxCycles > 0 && cycles >= maxCycles) {
    if (s.status !== "done") {
      const next = { ...s, ...auditMark, status: "done" };
      saveState(next);
      return { state: next, action: "stop", reason: "max-cycles" };
    }
    return { state: s, action: "stop", reason: "max-cycles-done" }; // already reported done — the old build stayed silent
  }
  const cooldown = cfg?.cooldownMs ?? MIN_COOLDOWN_MS;
  const last = Number(s.lastNudgeAt) || 0;
  if (until - last < cooldown) return { state: { ...s, ...auditMark }, action: "defer", reason: "cooldown" };
  return { state: { ...s, ...auditMark }, action: "nudge-now" };
}

// C23 — the nudge itself, shared by the settle path and the deferred wake
// (F12): cooldown check, one pane.send_text, then ONE state write that bumps
// lastNudgeAt/cycles/armed AND clears any deferred schedule (R5/F14 — a real
// nudge supersedes it in the same write, never a second one). `agentStatus`
// is the freshest observed pane status; a busy agent is never typed over.
async function nudgeNow({ state: s, cfg, paneId, agentStatus }) {
  const cooldown = cfg?.cooldownMs ?? MIN_COOLDOWN_MS;
  const last = Number(s.lastNudgeAt) || 0;
  if (Date.now() - last < cooldown) return { state: s, verdict: { nudged: false, reason: "cooldown" } };
  if (agentStatus === "working" || agentStatus === "blocked") return { state: s, verdict: { nudged: false, reason: "pane working" } };
  const cycles = Number(s.cycles) || 0;
  const text = cfg?.nudgeText ?? DEFAULT_NUDGE;
  const r = await herdr("pane.send_text", { pane_id: paneId, text });
  const next = { ...s, armed: true, cycles: cycles + 1, lastNudgeAt: Date.now(), deferredUntil: undefined, deferredId: undefined };
  saveState(next);
  log(`nudge #${cycles + 1} rc=${r.ok ? "ok" : `FAIL ${r.error?.code}`} (pane ${paneId})`);
  return { state: next, verdict: { nudged: r.ok, ...(r.ok ? {} : { reason: r.error?.code }) } };
}

// C23 — schedule exactly one deferred nudge at `atMs` (R1/R4). File-first
// like every state field; the runner is one short-lived detached node
// process, never a daemon (R6), spawned with the inherited env so it finds
// the same state/config dirs (R7). A settle landing inside ±250ms of an
// existing schedule keeps it and spawns nothing (F1) — but still persists
// this settle's bookkeeping updates, exactly like the old cooldown write.
function scheduleDeferred(state, atMs) {
  const existing = Number(state.deferredUntil) || 0;
  if (existing && Math.abs(existing - atMs) <= DEFER_WINDOW_MS) {
    saveState(state);
    return { kept: true, id: state.deferredId ?? "", atMs: existing };
  }
  const id = randomUUID();
  saveState({ ...state, deferredUntil: atMs, deferredId: id });
  spawn(process.execPath, [SELF, "deferred-nudge", "--id", id], { detached: true, stdio: "ignore" }).unref();
  return { kept: false, id, atMs };
}

// The stop verdicts map back to the exact lines the old inline code logged;
// null = the bookkeeping already logged (or must stay silent) — never log twice.
function settleStopLine(reason, s, cfg, paneId) {
  switch (reason) {
    case "armed": return `settle ignored — pane ${paneId} has done no work yet (birth idle is not a cycle)`;
    case "config invalid": return "config became invalid — nudges muted until fixed";
    case "status": return `status=${s.status} — no nudge`;
    case "paused-owner": return "paused by owner — no auto-resume";
    case "paused-auto": return "paused (auto) — no watched file changed since the pause — no nudge";
    case "audit hold": return `audit hold ${s.auditHold?.rules?.join(",")} — no nudge until the owner resumes`;
    case "auto-pause": return `auto-pause: ${s.noopStreak} no-op cycles in a row — resume with the resume action`;
    case "max-cycles": return `maxCycles ${cfg?.maxCycles ?? 0} reached — loop done`;
    default: return null; // audit violation (already logged), max-cycles-done (silent)
  }
}

async function cmdEvent() {
  let payload;
  try { payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}"); } catch { process.exit(0); }
  const event = typeof payload?.event === "string" ? payload.event : "";
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  let s = loadState(); // reassigned on auto-resume: later saves must not resurrect `paused`
  if (!s.paneId || paneId !== s.paneId) process.exit(0); // not our pane — silent, always

  if (event === "pane.exited") {
    saveState({ ...s, status: "chain-broke" });
    log(`pane ${paneId} exited — chain broke; restart with the start action`);
    process.exit(0);
  }
  const status = typeof data.agent_status === "string" ? data.agent_status : "";
  if (status !== "idle" && status !== "done") {
    // working/blocked: hands off — but the FIRST work this run arms the loop:
    // only after work does a settle mean "finished a turn" instead of
    // "herdr reporting the pane's birth idle".
    if ((status === "working" || status === "blocked") && s.armed !== true && s.status === "running") {
      saveState({ ...s, armed: true });
      log(`armed: pane ${paneId} seen ${status} — settles count from now on`);
    }
    process.exit(0);
  }
  const cfg = loadConfig();
  const v = settleBookkeeping({ state: s, cfg, paneId });
  s = v.state;
  if (v.action === "stop") {
    const line = settleStopLine(v.reason, s, cfg, paneId);
    if (line) log(line);
    process.exit(0);
  }
  if (v.action === "defer") {
    // C23 — the fix: a settle caught by the cooldown used to be CONSUMED with
    // nothing scheduled (live stall 16:25Z: suppressed, then silence forever,
    // because no further event ever arrives on an idle agent). Now the settle
    // schedules exactly one deferred nudge at lastNudgeAt + cooldownMs (R1).
    const cooldown = cfg?.cooldownMs ?? MIN_COOLDOWN_MS;
    log(`nudge suppressed (cooldown ${cooldown}ms)`);
    const d = scheduleDeferred(s, (Number(s.lastNudgeAt) || 0) + cooldown);
    if (!d.kept) log(`deferred nudge scheduled in ${Math.max(0, Math.round((d.atMs - Date.now()) / 1000))}s (id ${d.id.slice(0, 8)})`);
    process.exit(0);
  }
  await nudgeNow({ state: s, cfg, paneId, agentStatus: status });
  process.exit(0);
}

// C23 — the deferred runner: one short-lived process spawned by
// scheduleDeferred (R6). It NEVER reads the event env — paneId comes from
// state; the --id is the whole handshake. Bookkeeping (audit, classify,
// maxCycles) already ran exactly once when the settle scheduled this (F3):
// the runner only re-checks the fences, then nudges.
async function cmdDeferredNudge(id) {
  if (!id) die(2, "usage: index.mjs deferred-nudge --id <uuid>");
  const shortId = id.slice(0, 8);
  // Before sleeping: absolute silence (F4) — no log, no mkdir. A missing
  // state or a foreign id means the schedule is gone; the process just quits.
  const raw = readJson(STATE, null);
  if (!raw || raw.deferredId !== id || !Number(raw.deferredUntil)) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(raw.deferredUntil) - Date.now())));
  // Woken: from here on, every exit is logged honestly (R8).
  const dropDeferred = (s, reason) => {
    saveState({ ...s, deferredUntil: undefined, deferredId: undefined });
    log(`deferred nudge dropped: ${reason} (id ${shortId})`);
    process.exit(0);
  };
  let s = loadState();
  if (s.deferredId !== id) { log(`deferred nudge dropped: superseded (id ${shortId})`); process.exit(0); }
  const cfg = loadConfig();
  const cfgErr = cfg ? validateConfig(cfg) : "loop.json not found (CONFIG_DIR)";
  const armed = s.armed === undefined ? true : s.armed === true;
  // Fences (F6), newest reality wins. maxCycles/cooldown are deliberately NOT
  // here (F10/F11): they belong to the bookkeeping that already ran.
  const fence =
    cfgErr ? "config invalid"
    : !armed ? "not armed"
    : s.status !== "running" ? `status=${s.status}`
    : s.paused === true ? (s.pausedBy === "auto" ? "paused by auto" : "paused by owner")
    : s.auditHold ? `audit hold ${s.auditHold.rules?.join(",")}`
    : null;
  if (fence) return dropDeferred(s, fence);
  // One pane.list, three distinct outcomes (F5): an infra failure keeps the
  // schedule and retries after 5s, at most DEFER_RETRY_MAX times.
  const fire = async (n) => {
    const l = await listPanes();
    if (!l.ok) {
      if (n > DEFER_RETRY_MAX) return dropDeferred(s, `bridge ${l.error}`);
      log(`deferred nudge retry: bridge ${l.error} (n=${n}, 5s)`);
      await new Promise((resolve) => setTimeout(resolve, DEFER_RETRY_MS));
      return fire(n + 1);
    }
    const pane = l.panes.find((p) => p?.pane_id === s.paneId) ?? null;
    if (!pane) return dropDeferred(s, "pane gone"); // herdr's pane.exited owns the lifecycle — never a self-invented chain-broke
    const observed = typeof pane.agent_status === "string" ? pane.agent_status : "";
    if (observed === "working" || observed === "blocked") return dropDeferred(s, "pane working"); // a real settle will arrive
    log(`deferred nudge: firing (id ${shortId})`);
    const v = await nudgeNow({ state: s, cfg, paneId: s.paneId, agentStatus: observed });
    if (v.verdict.nudged) process.exit(0);
    if (v.verdict.reason === "cooldown") {
      // A kick/nudge slipped in while we slept: the schedule is stale — clear
      // it silently; cooldown is never a `dropped` reason (F11).
      saveState({ ...s, deferredUntil: undefined, deferredId: undefined });
      process.exit(0);
    }
    // A refused send is exactly the stall C23 exists to prevent: clearing the
    // schedule here would consume the settle with nothing (review round 2).
    // Keep the schedule and retry like any bridge failure (F5): 5s apart, at
    // most DEFER_RETRY_MAX times, then an honest `dropped: bridge <code>`.
    const code = v.verdict.reason ?? "send-failed";
    if (n > DEFER_RETRY_MAX) return dropDeferred(s, `bridge ${code}`);
    log(`deferred nudge retry: bridge ${code} (n=${n}, 5s)`);
    await new Promise((resolve) => setTimeout(resolve, DEFER_RETRY_MS));
    return fire(n + 1);
  };
  await fire(1);
}

// ---- dispatch ------------------------------------------------------------

const cmd = process.argv[2] ?? "";
const commands = {
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  pause: () => cmdPause(false),
  resume: () => cmdPause(true),
  kick: cmdKick,
  event: cmdEvent,
  // C23 — internal runner for the deferred schedule; spawned by
  // scheduleDeferred with --id and never registered as a plugin action.
  "deferred-nudge": () => cmdDeferredNudge(process.argv[3] === "--id" ? process.argv[4] : undefined),
};
if (!commands[cmd]) die(2, `usage: index.mjs <${Object.keys(commands).join("|")}>`);
await commands[cmd]();
