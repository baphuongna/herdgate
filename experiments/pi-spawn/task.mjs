#!/usr/bin/env node
// One command for the whole subagent lifecycle (experiment, NOT shipped).
// The herdr-link lesson: driving one child used to be four separate tool calls
// (spawn.mjs spawn → spawn.mjs arm → herdr agent prompt, then close/status
// later), each with its own marker discipline — and controllers kept forgetting
// one of them (marker glued onto the prompt, a prompt landing before the arm
// ack, a working child closed), which cost three live bugs. task.mjs folds the
// chain into ONE command so the ordering and the marker format cannot be
// forgotten:
//
//   node experiments/pi-spawn/task.mjs start <name> <taskfile> [--cwd DIR] [--tab] [--body] [-- extra pi args]
//   node experiments/pi-spawn/task.mjs continue <name> <taskfile-or-text>   # re-prompt a LIVE child
//   node experiments/pi-spawn/task.mjs status [name]                        # per child, recent-first
//   node experiments/pi-spawn/task.mjs list                                 # one line per child
//   node experiments/pi-spawn/task.mjs close <name>
//
// start = spawn → arm (the handshake ack spawn.mjs already polls) → prompt
// whose FIRST LINE is the marker alone — the boundary hasMarker demands.
//
// Reuse policy: registry/receipt readers are imported directly (they are
// libraries). spawn.mjs's flow is IIFE-style top-level code with NO exports —
// importing it would RUN its CLI — so its subcommands are invoked through
// execFileSync on the CLI itself: the least invasive reuse, zero duplication
// of its guards (idle check, ack poll, working-agent close refusal).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findSpawn, spawnBase } from './registry.mjs';
import { findReceipt } from '../../plugin/server/pi-receipts.mjs';
import { readAllSpawns } from '../../plugin/server/pi-wake.mjs';

const spawnCli = fileURLToPath(new URL('./spawn.mjs', import.meta.url));
const herdr = () => process.env.HERDR_BIN_PATH || 'herdr';

/** @internal Test seam (the herdr-link setHerdrRunnerForTests lesson, link.md
 *  §1): swap the herdr CLI runner for one that records argv. Tests assert the
 *  exact argv sequence through the REAL module — no module mocking. Passing
 *  anything but a function restores the production execFileSync runner. */
const defaultHerdrRunner = (file, args) => ({
  stdout: execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
});
let herdrRunner = defaultHerdrRunner;
export function setHerdrRunnerForTests(runner) {
  herdrRunner = typeof runner === 'function' ? runner : defaultHerdrRunner;
}

const run = (...args) => JSON.parse(herdrRunner(herdr(), args).stdout);
const runSafe = (...args) => {
  try { return { ok: true, out: run(...args) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 300) }; }
};
const nodeCli = (file, args) => execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
// execFileSync errors bury the child's own words (spawn.mjs fail() prints to
// stderr); surface those instead of a bare "Command failed".
const cliError = error => String(error?.stderr || error?.message || error).trim().slice(0, 500);
const fail = message => { console.error(message); process.exit(1); };

/** The discipline every marked prompt shares: keep working (tool calls each
 *  reply) until done, then answer with one SUMMARY line. */
export const TASK_INSTRUCTION = 'Mỗi reply phải kèm tool call đến khi xong; xong in 1 dòng SUMMARY.';

/** The prompt the observer can attribute: the marker ALONE on line 1, the body
 *  from line 2. hasMarker accepts a single space after the marker too, but the
 *  canonical boundary is the newline — this builder makes the bug that burned a
 *  six-agent wave (marker glued straight onto the task text) unrepresentable. */
export function buildTaskPrompt(marker, body) {
  return `${marker}\n${body}`;
}

/** herdr-link/1-style inbound wrapper (link.md mechanism §15): a CONTINUE
 *  prompt is self-describing — line 1 the marker (as always), then the body,
 *  and as the LAST line a JSON envelope naming where the answer goes, so the
 *  child needs no side-channel docs to route its SUMMARY. replyTo reuses the
 *  one-id chain (`spawn:<id>` — the principal form the receipt journal
 *  already speaks). start does NOT wrap: its first prompt already carries
 *  TASK_INSTRUCTION and the marker; the envelope is a continue-only addition. */
export const ENVELOPE_HINT = 'Dòng cuối là envelope định tuyến: khi xong, gửi SUMMARY về replyTo (qua via), không cần hỏi lại.';

export function buildInboundWrapper(marker, spawnId, body) {
  return `${buildTaskPrompt(marker, taskBody(body))}\n${ENVELOPE_HINT}\n${JSON.stringify({ replyTo: `spawn:${spawnId}`, via: 'herdgate-task' })}`;
}

const markerOf = entry => `[herdr-request:${entry.id}]`;
const taskBody = text => `${TASK_INSTRUCTION}\n\n${text}`;

/** A failed chain is REPORTED, never left half-done and silent: which step
 *  died, which state the child is in, and the exact next command to run. */
function abort(name, steps, where, entry) {
  for (const key of Object.keys(steps)) if (steps[key] === 'pending') steps[key] = 'skipped (nothing sent)';
  console.error(`[task ${name}] ABORTED at step "${where}" — per-step status:`);
  for (const [key, value] of Object.entries(steps)) console.error(`  ${key.padEnd(6)} ${value}`);
  const next = where === 'spawn'
    ? 'nothing was created; fix the spawn error above and re-run start'
    : where === 'arm'
      ? `child is spawned+recorded${entry ? ` (id ${entry.id})` : ''} but NOT armed and NOT prompted; check its pane, then: node experiments/pi-spawn/spawn.mjs arm ${name} && node experiments/pi-spawn/task.mjs continue ${name} <taskfile> — or task.mjs close ${name}`
      : `child is spawned+armed but the prompt failed; re-send with: node experiments/pi-spawn/task.mjs continue ${name} <taskfile>`;
  console.error(`  next: ${next}`);
  process.exit(1);
}

function cmdStart(name, taskfile) {
  if (!name || !taskfile) fail('usage: task.mjs start <name> <taskfile> [--cwd DIR] [--tab] [--body] [-- extra pi args]');
  const cwd = flag('cwd');
  const wantTab = process.argv.includes('--tab');
  const wantBody = process.argv.includes('--body');
  const extras = (() => { const i = process.argv.indexOf('--'); return i > 0 ? process.argv.slice(i + 1) : []; })();
  let body = '';
  try { body = readFileSync(taskfile, 'utf8').trim(); }
  catch (error) { fail(`cannot read taskfile ${taskfile}: ${error.message}`); }
  if (!body) fail(`taskfile ${taskfile} is empty`);
  const note = message => console.error(`[task ${name}] ${message}`);
  const steps = { spawn: 'pending', arm: 'pending', prompt: 'pending' };
  let entry = null;
  try {
    note(`step 1/3 spawn${wantTab ? ' (own tab)' : ''}${cwd ? ` cwd=${cwd}` : ''} …`);
    entry = JSON.parse(nodeCli(spawnCli,
      ['spawn', name, ...(cwd ? ['--cwd', cwd] : []), ...(wantTab ? ['--tab'] : []), ...(extras.length ? ['--', ...extras] : [])]));
    steps.spawn = `ok (pane ${entry.paneId}, id ${entry.id})`;
  } catch (error) {
    steps.spawn = `FAILED: ${cliError(error)}`;
    return abort(name, steps, 'spawn');
  }
  let arm = null;
  try {
    note('step 2/3 arm (polling the child ack) …');
    arm = JSON.parse(nodeCli(spawnCli, ['arm', name, ...(wantBody ? ['--body'] : [])]));
    steps.arm = `ok (ack at ${arm.ackAt})`;
  } catch (error) {
    steps.arm = `FAILED: ${cliError(error)}`;
    return abort(name, steps, 'arm', entry);
  }
  try {
    note('step 3/3 prompt (marker alone on line 1) …');
    run('agent', 'prompt', entry.paneId, buildTaskPrompt(arm.marker, taskBody(body)));
    steps.prompt = 'ok';
  } catch (error) {
    steps.prompt = `FAILED: ${cliError(error)}`;
    return abort(name, steps, 'prompt', entry);
  }
  console.log(JSON.stringify({ id: entry.id, name: entry.name, paneId: entry.paneId, armed: true, prompted: true }));
}

/** @internal Exported for the argv-recording test seam — the CLI dispatch
 *  below calls this same function. */
export function cmdContinue(name, taskfileOrText) {
  if (!name || !taskfileOrText) fail('usage: task.mjs continue <name> <taskfile-or-text>');
  const entry = findSpawn(spawnBase(), name);
  if (!entry) fail(`no spawn record for ${name}`);
  // A path that exists is read as a file; anything else IS the task text.
  let text = taskfileOrText;
  if (existsSync(taskfileOrText)) {
    try { text = readFileSync(taskfileOrText, 'utf8').trim(); }
    catch (error) { fail(`cannot read ${taskfileOrText}: ${error.message}`); }
  }
  if (!text.trim()) fail('empty task text');
  const list = runSafe('pane', 'list');
  const panes = list.ok ? (list.out?.result?.panes ?? []) : [];
  if (!panes.some(pane => pane.pane_id === entry.paneId))
    fail(`pane ${entry.paneId} is gone — restore first: node experiments/pi-spawn/spawn.mjs restore ${entry.name}`);
  // The competing_input lesson: a marker stacked on a busy agent (or any
  // unmarked input after it) kills the whole arm intent — refuse to be it.
  const agent = runSafe('agent', 'get', entry.paneId);
  const status = agent.ok ? (agent.out?.result?.agent?.agent_status ?? 'unknown') : 'unknown';
  if (status === 'working' || status === 'blocked')
    fail(`agent is ${status} — a second marker now would die as competing_input; wait for its settle/wake, then continue`);
  try {
    // Self-describing wrapper: marker on line 1, envelope on the last line.
    run('agent', 'prompt', entry.paneId, buildInboundWrapper(markerOf(entry), entry.id, text));
  } catch (error) {
    fail(`prompt failed: ${cliError(error)}`);
  }
  console.log(JSON.stringify({ id: entry.id, name: entry.name, paneId: entry.paneId, prompted: true, marker: markerOf(entry) }));
}

/** One row per spawn record (newest ts per id), joined with live pane state,
 *  agent status and the newest receipt; sorted recent-first (sesh rule). */
function collectRows(ref) {
  const base = spawnBase();
  const byId = new Map();
  for (const record of readAllSpawns(base)) {
    const prior = byId.get(record.id);
    if (!prior || (record.ts ?? 0) >= (prior.ts ?? 0)) byId.set(record.id, record);
  }
  let records = [...byId.values()];
  if (ref) {
    records = records.filter(record => record.name === ref || record.id === ref);
    if (!records.length) fail(`no spawn record for ${ref}`);
  }
  const list = runSafe('pane', 'list');
  const panes = list.ok ? (list.out?.result?.panes ?? []) : [];
  const rows = records.map(record => {
    const pane = record.paneId ? panes.find(p => p.pane_id === record.paneId) : undefined;
    let agent_status = null;
    if (pane) {
      const agent = runSafe('agent', 'get', record.paneId);
      agent_status = agent.ok ? (agent.out?.result?.agent?.agent_status ?? 'unknown') : null;
    }
    const receipt = findReceipt(base, record.id);
    return {
      name: record.name,
      id: record.id.slice(0, 8),
      pane: record.paneId ?? null,
      live: Boolean(pane),
      agent_status,
      receipt: receipt
        ? { status: receipt.status, turns: receipt.turns ?? null, lastActivityAt: receipt.lastActivityAt ?? null }
        : null,
      died: Boolean(record.died),
      closedBy: record.closedBy ?? null,
      lastActivityAt: receipt?.lastActivityAt ?? record.ts ?? 0,
    };
  });
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return rows;
}

function cmdStatus(ref) {
  console.log(JSON.stringify(collectRows(ref), null, 2));
}

function cmdList() {
  for (const row of collectRows()) {
    const bits = [row.name, `<${row.id}>`, `pane=${row.pane ?? '-'}`, row.live ? 'live' : 'gone'];
    if (row.agent_status) bits.push(`agent=${row.agent_status}`);
    bits.push(row.receipt
      ? `receipt=${row.receipt.status}${row.receipt.turns != null ? ` turns=${row.receipt.turns}` : ''}`
      : 'no-receipt');
    if (row.closedBy) bits.push(`closedBy=${row.closedBy}`);
    if (row.died) bits.push('died');
    console.log(bits.join(' '));
  }
}

function cmdClose(name) {
  if (!name) fail('usage: task.mjs close <name>');
  // Delegated, not duplicated: spawn.mjs close owns the working-agent refusal,
  // the closedBy-before-close marker and tab/pane teardown — same guards, one
  // implementation. Pure pass-through, exit code included.
  const result = spawnSync(process.execPath, [spawnCli, 'close', name], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const flag = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const usage = 'usage: task.mjs start <name> <taskfile> [--cwd DIR] [--tab] [--body] [-- extra pi args]\n'
  + '       task.mjs continue <name> <taskfile-or-text>\n'
  + '       task.mjs status [name]\n'
  + '       task.mjs list\n'
  + '       task.mjs close <name>';

// CLI only when run as a script — importing task.mjs (tests) must not dispatch.
const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const command = process.argv[2];
  if (command === 'start') cmdStart(process.argv[3], process.argv[4]);
  else if (command === 'continue') cmdContinue(process.argv[3], process.argv[4]);
  else if (command === 'status') cmdStatus(process.argv[3]);
  else if (command === 'list') cmdList();
  else if (command === 'close') cmdClose(process.argv[3]);
  else fail(usage);
}
