#!/usr/bin/env node
// One command for a whole read-only SDD role (critic / reviewer) — AUTO.md v2's
// VỪA gate as a mechanism, not a reminder. The task.mjs lesson applies one
// level up: the gate used to be four manual commands (start with the right
// flags → herdr agent wait → dig the answer out of a session jsonl → close),
// and a controller under time pressure WILL forget one of them (a pane left
// alive, an answer never read, a role never closed). sdd.mjs folds the chain:
//
//   node experiments/pi-spawn/sdd.mjs run <name> <brief.md> [--cwd DIR] [--model M] [--timeout MS]
//
//   lock (one role at a time) → task.mjs start (READ-ONLY forced: --tools read
//   is hardcoded — there is no flag to weaken it) → herdr agent wait (blocking)
//   → settle loop (dogfood bug: `wait --until idle` can return while the agent
//   has not STARTED working yet — the fresh session has no assistant text and
//   close refuses with "working" — so the settle loop waits for text AND a
//   non-working agent) → the LAST assistant text of the session jsonl on
//   stdout → task.mjs close → lock released in `finally` (no process.exit
//   inside the try — the reviewer's lock-leak finding).
//
// Exit codes: 1 lock refused, 2 answer not findable, 3 start failed,
// 4 wait/settle failed, 5 close failed (answer, if any, was printed),
// 64 usage. A fresh session cannot contain a previous turn: the spawn id IS
// the session id (one-id chain), so any assistant text in the file belongs to
// this role.
//
// Caveat: restore/revive does not replay pi extras — a died role is re-RUN,
// never restored; the read-only guarantee holds only for what this file starts.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReceipt } from '../../plugin/server/pi-receipts.mjs';
import { spawnBase } from './registry.mjs';

const taskCli = fileURLToPath(new URL('./task.mjs', import.meta.url));
const herdrBin = () => process.env.HERDR_BIN_PATH || 'herdr';
const intEnv = (name, dflt) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(v) && v >= 0 ? v : dflt; // 0 is a VALUE (single-shot), never fallback fodder
};
const note = (name, message) => console.error(`[sdd ${name}] ${message}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cliError = error => String(error?.stderr || error?.message || error).trim().slice(0, 400);

/** The answer a controller reads: the LAST assistant line that carries any
 *  non-empty text block, those blocks joined by newline (thinking and
 *  toolResult are never the answer). Null when there is none: the controller
 *  must NOT get a half-invented answer. */
export function lastAssistantText(rawLines) {
  for (let i = rawLines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(rawLines[i]); } catch { continue; }
    const message = entry?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const texts = message.content.filter(c => c?.type === 'text' && typeof c.text === 'string' && c.text.trim()).map(c => c.text);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

/** Where the answer lives. Primary source: `herdr agent wait` itself reports
 *  agent_session.value — no globbing against a layout we do not own. Fallback:
 *  newest `*_<id>.jsonl` under sessionsRoot. Null when nowhere. */
export function resolveSessionFile(waitOut, id, sessionsRoot) {
  try {
    const direct = JSON.parse(String(waitOut))?.result?.agent?.agent_session?.value;
    if (typeof direct === 'string' && direct.endsWith('.jsonl')) return direct;
  } catch { /* not JSON — fall through to the glob */ }
  let best = null, bestMs = -Infinity;
  try {
    for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of readdirSync(join(sessionsRoot, dir.name))) {
        if (!name.endsWith(`_${id}.jsonl`)) continue;
        const ms = statSync(join(sessionsRoot, dir.name, name)).mtimeMs;
        if (ms > bestMs) { bestMs = ms; best = join(sessionsRoot, dir.name, name); }
      }
    }
  } catch { /* no root / no matches */ }
  return best;
}

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; } // someone else's live pid
};

/** One role at a time (AUTO.md v2 law) — atomic `wx` so two runs cannot both
 *  pass a read-then-overwrite window. A stale lock (dead pid) is self-healed
 *  exactly once; a live one names its holder. */
export function acquireLock(lockPath, name) {
  const body = JSON.stringify({ pid: process.pid, name, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(lockPath, body, { flag: 'wx' }); return { ok: true }; }
    catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, holder: `unreadable lock: ${String(error?.message ?? error)}` };
      let held = null;
      try { held = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* corrupt */ }
      if (held && pidAlive(Number(held.pid))) return { ok: false, holder: held.name ?? `pid ${held.pid}` };
      try { unlinkSync(lockPath); } catch { /* racing a healing peer — its wx wins */ }
    }
  }
  return { ok: false, holder: 'lock kept changing' };
}

export const releaseLock = lockPath => { try { unlinkSync(lockPath); } catch { /* already gone */ } };

/** Cheap, non-fatal status probe: null when herdr cannot answer. */
function agentStatus(paneId) {
  try {
    const out = JSON.parse(execFileSync(herdrBin(), ['agent', 'get', paneId], { encoding: 'utf8' }));
    return out?.result?.agent?.agent_status ?? null;
  } catch { return null; }
}

/** The settle loop (dogfood bug): `wait` can return before the agent starts
 *  working, so the answer is judged ready only when BOTH hold — the session
 *  file carries an assistant text AND the agent is not working/blocked.
 *  The receipt journal, when present, is an early reassurance, never the
 *  gate. Round 2 taught the other edge: a long-working agent may write a
 *  mid-task text; delivering it would hand the controller a half-answer —
 *  so a budget that ends while the agent is still busy returns
 *  timedOutBusy and the caller fails with the rescue line instead.
 *  budgetMs 0 = one single-shot probe. */
async function waitForAnswer(name, { sessionFile, paneId, base, id, budgetMs }) {
  const readText = () => {
    try { return lastAssistantText(readFileSync(sessionFile, 'utf8').split('\n')); }
    catch { return null; } // not written yet — the loop tries again
  };
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const text = readText();
    const status = agentStatus(paneId);
    // Fail-safe (reviewer r3 F3): a status we could not read is treated as
    // busy — a flaky `agent get` must never green-light a mid-task text.
    const busy = status === null || status === 'working' || status === 'blocked';
    if (Date.now() >= deadline) {
      if (busy) return { text: null, settled: false, timedOutBusy: true };
      return { text, settled: Boolean(findReceipt(base, id)) };
    }
    if (text != null && !busy) {
      return { text, settled: Boolean(findReceipt(base, id)) };
    }
    await sleep(Math.min(1_000, Math.max(100, deadline - Date.now())));
  }
}

async function cmdRun(name, briefFile, opts) {
  const lockPath = join(spawnBase(), 'sdd.lock');
  const lock = acquireLock(lockPath, name);
  if (!lock.ok) {
    note(name, `another SDD role is running (${lock.holder}) — one at a time (AUTO.md v2). Rescue: task.mjs status / close ${lock.holder}`);
    process.exitCode = 1;
    return;
  }
  let brief = '';
  try { brief = readFileSync(briefFile, 'utf8').trim(); }
  catch (error) { releaseLock(lockPath); note(name, `cannot read brief ${briefFile}: ${error.message}`); process.exitCode = 3; return; }
  if (!brief) { releaseLock(lockPath); note(name, 'brief is empty'); process.exitCode = 3; return; }

  let closeWarning = null;
  try {
    note(name, `step 1/4 start (read-only forced)${opts.cwd ? ` cwd=${opts.cwd}` : ''} …`);
    let started;
    try {
      started = JSON.parse(execFileSync(process.execPath, [
        taskCli, 'start', name, briefFile, '--tab', ...(opts.cwd ? ['--cwd', opts.cwd] : []),
        '--', '--model', opts.model, '--thinking', 'max', '--tools', 'read',
      ], { encoding: 'utf8' }));
    } catch (error) {
      note(name, `start failed: ${cliError(error)}`);
      process.exitCode = 3;
      return;
    }
    const { id, paneId } = started;
    note(name, `pane ${paneId} (id ${String(id).slice(0, 8)}) — step 2/4 wait (blocking) …`);
    let waitOut = null;
    try {
      waitOut = execFileSync(herdrBin(), ['agent', 'wait', paneId, '--until', 'idle', '--until', 'done', '--timeout', String(opts.timeoutMs)], { encoding: 'utf8' });
    } catch (error) {
      // No answer to trust after a timeout — still TRY to close (the guard
      // may refuse while the agent works; that is acceptable), then hand the
      // controller the rescue line.
      try { execFileSync(process.execPath, [taskCli, 'close', name], { encoding: 'utf8' }); }
      catch { /* refused or gone — the rescue line below says what to do */ }
      note(name, `wait failed: ${cliError(error)} — rescue: herdr agent wait ${paneId} --until idle --until done --timeout ${opts.timeoutMs}, then read the session jsonl (task.mjs status ${name}), then task.mjs close ${name}`);
      process.exitCode = 4;
      return;
    }
    note(name, 'step 3/4 settle + read the answer …');
    const sessionFile = resolveSessionFile(waitOut, id, opts.sessionsRoot);
    if (!sessionFile) {
      try { execFileSync(process.execPath, [taskCli, 'close', name], { encoding: 'utf8' }); }
      catch { /* best effort */ }
      note(name, `no session jsonl found (wait output carried no agent_session and the sessions root has no *_${id}.jsonl) — manual: task.mjs status ${name}, find the session file under ${opts.sessionsRoot}, read the last assistant text, then task.mjs close ${name}`);
      process.exitCode = 2;
      return;
    }
    const { text, settled, timedOutBusy } = await waitForAnswer(name, { sessionFile, paneId, base: spawnBase(), id, budgetMs: opts.settlePollMs });
    if (timedOutBusy) {
      // A still-working agent may have written a MID-TASK text: delivering it
      // would hand the controller a half-answer. Fail with the rescue line.
      try { execFileSync(process.execPath, [taskCli, 'close', name], { encoding: 'utf8' }); }
      catch { /* refused while working — the rescue line says what to do */ }
      note(name, `agent still busy after ${opts.settlePollMs}ms — NOT delivering a mid-task text. rescue: sdd re-run later, or herdr agent wait ${paneId} --until idle --until done --timeout ${opts.timeoutMs} then read ${sessionFile} then task.mjs close ${name}`);
      process.exitCode = 4;
      return;
    }
    if (!settled) note(name, `no receipt after ${opts.settlePollMs}ms — reading anyway (settle may lag)`);
    const answer = text;
    note(name, 'step 4/4 close …');
    try { execFileSync(process.execPath, [taskCli, 'close', name], { encoding: 'utf8' }); }
    catch (error) { closeWarning = cliError(error); }
    if (answer == null) {
      note(name, 'the session has no assistant text to read — manual: task.mjs status ' + name);
      process.exitCode = 2;
      return;
    }
    console.log(answer);
    if (closeWarning) note(name, `ANSWER DELIVERED but close failed: ${closeWarning} — rescue: task.mjs close ${name}`);
    process.exitCode = closeWarning ? 5 : 0;
  } finally {
    releaseLock(lockPath);
  }
}

const usage = 'usage: sdd.mjs run <name> <brief.md> [--cwd DIR] [--model M] [--timeout MS]\n'
  + 'one read-only SDD role per run, one role at a time (sdd.lock)\n'
  + 'exit codes: 1 lock refused, 2 answer not findable, 3 start failed, 4 wait failed, 5 close failed, 64 usage';

const flag = (argv, name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  if (process.argv[2] === 'run' && process.argv[3] && process.argv[4]) {
    await cmdRun(process.argv[3], process.argv[4], {
      cwd: flag(process.argv, 'cwd'),
      model: flag(process.argv, 'model', 'zai/glm-5.3-flash'),
      timeoutMs: Number.parseInt(flag(process.argv, 'timeout', '600000'), 10) || 600000,
      settlePollMs: intEnv('HERDR_SDD_SETTLE_POLL_MS', 300_000),
      sessionsRoot: process.env.HERDR_SDD_SESSIONS_ROOT || join(homedir(), '.pi', 'agent', 'sessions'),
    });
  } else {
    console.error(usage);
    process.exit(64);
  }
}
