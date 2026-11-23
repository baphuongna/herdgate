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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
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

async function paneAlive(paneId) {
  const r = await herdr("pane.list", {});
  return r.ok && Array.isArray(r.result?.panes) && r.result.panes.some((p) => p?.pane_id === paneId);
}

// ---- actions -------------------------------------------------------------

async function cmdStatus() {
  const cfg = loadConfig();
  const cfgErr = cfg ? validateConfig(cfg) : "loop.json not found (CONFIG_DIR)";
  const s = loadState();
  const alive = s.paneId ? await paneAlive(s.paneId) : false;
  out({
    config: cfgErr ? { ok: false, error: cfgErr, path: CONFIG } : { ok: true, label: cfg.label, promptFile: cfg.promptFile, cwd: cfg.cwd, boot: buildBoot(cfg), cooldownMs: cfg.cooldownMs ?? MIN_COOLDOWN_MS, maxCycles: cfg.maxCycles ?? 0, noopPauseAfter: cfg.noopPauseAfter ?? 2 },
    state: { paneId: s.paneId ?? null, workspaceId: s.workspaceId ?? null, status: s.status ?? "idle", paused: s.paused === true, pausedBy: s.pausedBy ?? null, armed: s.armed === undefined ? true : s.armed === true, cycles: s.cycles ?? 0, noopStreak: Number(s.noopStreak) || 0, lastNudgeAt: s.lastNudgeAt ?? 0, lastAuditAt: s.lastAuditAt ?? null, auditHold: s.auditHold ?? null, paneAlive: alive },
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

  saveState({ paneId, workspaceId: wsId, status: "running", paused: false, armed: false, cycles: 0, noopStreak: 0, lastNudgeAt: 0, startedAt: Date.now() });
  log(`start: pane ${paneId} in ${label} (workspace ${wsId})`);
  out({ ok: true, paneId, workspaceId: wsId });
}

async function cmdStop() {
  const s = loadState();
  if (!s.workspaceId) return die(1, "nothing to stop (no state)");
  const r = await herdr("workspace.close", { workspace_id: s.workspaceId });
  // A workspace that is already gone is a successful stop, not an error.
  const gone = r.ok || r.error?.code === "workspace_not_found" || /not found/i.test(r.error?.message ?? "");
  saveState({ ...s, status: gone ? "stopped" : "stop-failed", paneId: gone ? null : s.paneId });
  log(`stop: workspace.close ${gone ? "ok" : `failed: ${r.error?.message}`}`);
  if (!gone) return die(3, `workspace.close failed: ${r.error?.message}`);
  out({ ok: true, status: "stopped" });
}

function cmdPause(resume) {
  const s = loadState();
  if (!s.paneId && !s.workspaceId) return die(1, "no loop to pause/resume");
  // resume = the owner decided: the audit hold is cleared for good (undefined
  // keys vanish from the JSON; the audited window stays recorded) and the
  // no-op streak is forgiven — counting stale no-ops against a loop the owner
  // just resumed would re-pause it on the very next quiet cycle.
  const next = { ...s, paused: !resume };
  if (resume) {
    next.noopStreak = 0;
    delete next.pausedBy;
    next.auditHold = undefined;
  } else {
    next.pausedBy = "owner";
  }
  saveState(next);
  log(resume ? `resume: nudges re-enabled (noop streak reset${s.auditHold ? ", audit hold cleared" : ""})` : "pause: nudges muted (pausedBy owner)");
  out({ ok: true, paused: !resume });
}

// ---- the engine: event hook ----------------------------------------------

async function cmdEvent() {
  let payload;
  try { payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}"); } catch { process.exit(0); }
  const event = typeof payload?.event === "string" ? payload.event : "";
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const s = loadState();
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
  // A settle only counts once the pane has done work in this run. Herdr
  // also reports idle around pane birth (before any turn); the pre-arming
  // build nudged on it — observed live: nudge #1 fired 1.77s after start,
  // injecting the nudge text into a newborn task. States written before
  // `armed` existed (undefined) stay armed: a loop upgraded in place must
  // not stall mid-chain.
  const armed = s.armed === undefined ? true : s.armed === true;
  if (!armed) { log(`settle ignored — pane ${paneId} has done no work yet (birth idle is not a cycle)`); process.exit(0); }
  const cfg = loadConfig();
  if (cfg && validateConfig(cfg)) { log("config became invalid — nudges muted until fixed"); process.exit(0); }
  const cooldown = (cfg?.cooldownMs ?? MIN_COOLDOWN_MS);
  const maxCycles = cfg?.maxCycles ?? 0;
  const cycles = Number(s.cycles) || 0;

  if (s.status !== "running") { log(`status=${s.status} — no nudge`); process.exit(0); }
  if (s.paused === true) { log("paused — no nudge"); process.exit(0); }
  if (s.auditHold) { log(`audit hold ${s.auditHold.rules.join(",")} — no nudge until the owner resumes`); process.exit(0); }

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
    saveState({ ...s, lastAuditAt: until, auditHold: { rules, at: until } });
    log(`AUDIT VIOLATION ${rules.join(",")} — nudges held until resume`);
    process.exit(0);
  }
  if (audit.ok) log(`AUDIT ok commits=${audit.commits.length} tags=${audit.tags.length}`);
  else log(`AUDIT error ${audit.error} — fail-open: infra failure is not evidence of a violation; window re-audited next settle`);


  // C17: the settle is a valid finished cycle — classify it by the commits
  // it produced, BEFORE the nudge decision. "unknown" leaves the streak
  // (and the pause verdict) untouched; only a counted no-op can pause.
  const verdict = classifyCycle(cfg, Number(s.lastNudgeAt) || Number(s.startedAt) || 0, Date.now());
  if (verdict === "no-op") {
    s.noopStreak = (Number(s.noopStreak) || 0) + 1;
    const noopPauseAfter = cfg?.noopPauseAfter ?? 2;
    if (noopPauseAfter > 0 && s.noopStreak >= noopPauseAfter) {
      saveState({ ...s, paused: true, pausedBy: "auto", pausedAt: Date.now(), status: "running", ...auditMark });
      log(`auto-pause: ${s.noopStreak} no-op cycles in a row — resume with the resume action`);
      process.exit(0);
    }
  } else if (verdict === "work") {
    s.noopStreak = 0;
  }
  if (maxCycles > 0 && cycles >= maxCycles) {
    if (s.status !== "done") { saveState({ ...s, ...auditMark, status: "done" }); log(`maxCycles ${maxCycles} reached — loop done`); }
    process.exit(0);
  }
  const last = Number(s.lastNudgeAt) || 0;
  if (until - last < cooldown) { saveState({ ...s, ...auditMark }); log(`nudge suppressed (cooldown ${cooldown}ms)`); process.exit(0); }

  const text = cfg?.nudgeText ?? DEFAULT_NUDGE;
  const r = await herdr("pane.send_text", { pane_id: paneId, text });
  saveState({ ...s, armed: true, cycles: cycles + 1, lastNudgeAt: Date.now(), ...auditMark });
  log(`nudge #${cycles + 1} rc=${r.ok ? "ok" : `FAIL ${r.error?.code}`} (pane ${paneId})`);
}

// ---- dispatch ------------------------------------------------------------

const cmd = process.argv[2] ?? "";
const commands = {
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  pause: () => cmdPause(false),
  resume: () => cmdPause(true),
  event: cmdEvent,
};
if (!commands[cmd]) die(2, `usage: index.mjs <${Object.keys(commands).join("|")}>`);
await commands[cmd]();
