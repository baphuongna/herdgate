import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readSpawns, spawnsFileFor, type SpawnRecord } from '../experiments/pi-spawn/registry.mjs';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';

// task.mjs has no .d.mts (constraint: only task.mjs/test/SKILL.md may change), so
// the helper is loaded through a non-literal specifier — type-checked as a cast.
const taskUrl = new URL('../experiments/pi-spawn/task.mjs', import.meta.url);
const { buildTaskPrompt } = await import(taskUrl.href) as { buildTaskPrompt: (marker: string, body: string) => string };

const taskCli = fileURLToPath(new URL('../experiments/pi-spawn/task.mjs', import.meta.url));
const INSTRUCTION = 'Mỗi reply phải kèm tool call đến khi xong; xong in 1 dòng SUMMARY.';

// ── Unit: the marker prompt format (regression for the marker-boundary bug) ──

test('buildTaskPrompt puts the marker ALONE on line 1 — never glued, never marker+space', () => {
  const marker = '[herdr-request:11111111-1111-4111-8111-111111111111]';
  const body = `Nhiệm vụ: sửa bug đăng nhập.\n\nChi tiết trong docs.`;
  const prompt = buildTaskPrompt(marker, body);
  assert.equal(prompt, `${marker}\n${body}`, 'exactly marker + newline + body');
  const lines = prompt.split('\n');
  assert.equal(lines[0], marker, 'line 1 is the marker EXACTLY');
  assert.equal(lines.slice(1).join('\n'), body, 'the body starts on line 2, unmodified');
  assert.ok(prompt.startsWith(`${marker}\n`), 'the boundary is the newline hasMarker expects');
  assert.ok(!prompt.startsWith(`${marker} `), 'never marker + space');
  assert.ok(!prompt.startsWith(marker + body[0]), 'never marker glued onto the task text');
});

// ── e2e: a scripted herdr stub (HERDR_BIN_PATH) + a temp registry ──

// The stub answers the commands spawn.mjs/task.mjs use, logs every invocation
// (one JSON line per call, STUB_LOG), keeps pane state (STUB_STATE), and writes
// the arm ack when /herdgate-arm runs — unless STUB_ARM_FAIL=1 (fail-arm case).
const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
let state = { seq: 2, panes: [{ pane_id: 'w1:p1' }] };
try { state = JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8')); } catch { /* fresh */ }
const save = () => writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
const out = obj => console.log(JSON.stringify(obj));
const [group, sub] = args;
if (group === 'pane' && sub === 'list') {
  out({ result: { panes: state.panes } });
} else if (group === 'pane' && sub === 'split') {
  const pane = { pane_id: 'w1:p' + state.seq++ };
  state.panes.push(pane); save();
  out({ result: { pane } });
} else if (group === 'tab' && sub === 'create') {
  const pane = { pane_id: 'w1:p' + state.seq++, tab_id: 't' + state.seq };
  state.panes.push(pane); save();
  out({ result: { root_pane: { pane_id: pane.pane_id } } });
} else if (group === 'agent' && sub === 'start') {
  const pane = state.panes.find(p => p.pane_id === args[args.indexOf('--pane') + 1]);
  const id = args[args.indexOf('--session-id') + 1];
  if (pane && id) pane.agent_session = { value: '/sessions/session_' + id + '.jsonl' };
  save();
  out({ result: { ok: true } });
} else if (group === 'agent' && sub === 'get') {
  out({ result: { agent: { agent_status: 'idle' } } });
} else if (group === 'agent' && sub === 'prompt') {
  out({ result: { ok: true } });
} else if (group === 'pane' && sub === 'run') {
  const id = (args[3] || '').match(/--id ([0-9a-f-]{36})/);
  if (id && !process.env.STUB_ARM_FAIL) {
    writeFileSync(join(process.env.HERDGATE_PI_RECEIPT_DIR, id[1] + '.armed.json'),
      JSON.stringify({ id: id[1], at: Date.now() }));
  }
  out({ result: { ok: true } });
} else if (sub === 'close') {
  state.panes = state.panes.filter(p => p.pane_id !== args[2] && p.tab_id !== args[2]); save();
  out({ result: { ok: true } });
} else {
  out({ result: {} });
}
`;

const roots: string[] = [];

type Fixture = {
  base: string; work: string; receipts: string; taskfile: string;
  env: NodeJS.ProcessEnv; // happy-path env (arm acks flow)
  failArmEnv: NodeJS.ProcessEnv; // same but the child never acks the arm
  calls: (fail?: boolean) => string[][];
  freshState: () => void;
};

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'hg-task-'));
  roots.push(base);
  const work = join(base, 'work');
  const receipts = join(base, 'receipts');
  mkdirSync(work, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  const stub = join(base, 'herdr-stub.mjs');
  writeFileSync(stub, STUB_SOURCE);
  chmodSync(stub, 0o755);
  const taskfile = join(base, 'task.md');
  writeFileSync(taskfile, 'Nhiệm vụ: sửa bug đăng nhập trong module auth.\n');
  const logOf = (fail?: boolean) => join(base, fail ? 'calls-fail.log' : 'calls.log');
  const stateOf = (fail?: boolean) => join(base, fail ? 'state-fail.json' : 'state.json');
  const makeEnv = (fail?: boolean): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HERDR_BIN_PATH: stub,
    HERDGATE_PI_RECEIPT_DIR: receipts,
    HERDGATE_ARM_ACK_TIMEOUT_MS: fail ? '400' : '10000',
    ...(fail ? { STUB_ARM_FAIL: '1', STUB_LOG: logOf(true), STUB_STATE: stateOf(true) } : { STUB_LOG: logOf(), STUB_STATE: stateOf() }),
  });
  const calls = (fail?: boolean) => readFileSync(logOf(fail), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as string[]);
  const freshState = () => { for (const file of [logOf(), logOf(true), stateOf(), stateOf(true)]) rmSync(file, { force: true }); };
  return { base, work, receipts, taskfile, env: makeEnv(), failArmEnv: makeEnv(true), calls, freshState };
}

type RunResult = { stdout: string; stderr: string; status: number | null };

function runTask(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [taskCli, ...args], { encoding: 'utf8', cwd, env });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

type StartResult = { id: string; name: string; paneId: string; armed: boolean; prompted: boolean };
type StatusRow = {
  name: string; id: string; pane: string | null; live: boolean; agent_status: string | null;
  receipt: { status: string; turns: number | null; lastActivityAt: number | null } | null;
  died: boolean; closedBy: string | null; lastActivityAt: number;
};

let fx: Fixture; // shared by the sequential e2e tests below (declaration order = run order)
let started: StartResult;

test('task.mjs start runs spawn → arm → prompt in order, marker alone on line 1', () => {
  fx = fixture();
  const res = runTask(['start', 'worker', fx.taskfile, '--cwd', fx.work], fx.env, fx.work);
  assert.equal(res.status, 0, `start must succeed (stderr: ${res.stderr})`);
  started = JSON.parse(res.stdout.trim()) as StartResult;
  assert.equal(started.name, 'worker');
  assert.equal(started.armed, true);
  assert.equal(started.prompted, true);
  assert.match(started.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'one-id v4 uuid');
  assert.equal(started.paneId, 'w1:p2', 'the stub-allocated child pane');

  // The spawn record landed in the temp registry (never the real journal).
  const records = readSpawns(spawnsFileFor(fx.receipts, fx.work));
  const mine = records.find(record => record.id === started.id) as SpawnRecord | undefined;
  assert.ok(mine, 'spawn record exists in the temp registry');
  assert.equal(mine.paneId, started.paneId);
  assert.equal(mine.name, 'worker');

  // Exactly the three steps, in order: agent start → /herdgate-arm pane run → agent prompt.
  const calls = fx.calls();
  const startAt = calls.findIndex(call => call[0] === 'agent' && call[1] === 'start');
  const armAt = calls.findIndex(call => call[0] === 'pane' && call[1] === 'run' && call[3]?.includes('/herdgate-arm'));
  const promptAt = calls.findIndex(call => call[0] === 'agent' && call[1] === 'prompt');
  assert.ok(startAt >= 0 && armAt > startAt && promptAt > armAt, 'spawn → arm → prompt, in that order');
  assert.ok(calls[armAt][3].includes(`--id ${started.id}`), 'the arm carries THE spawn id');
  const prompts = calls.filter(call => call[0] === 'agent' && call[1] === 'prompt');
  assert.equal(prompts.length, 1, 'exactly one prompt');
  const text = prompts[0][3];
  assert.equal(text.split('\n')[0], `[herdr-request:${started.id}]`, 'prompt line 1 is the marker EXACTLY');
  assert.ok(text.startsWith(`[herdr-request:${started.id}]\n`), 'newline boundary after the marker');
  assert.ok(text.includes(INSTRUCTION), 'the working-discipline instruction rides along');
  assert.ok(text.includes('module auth'), 'the taskfile body is the prompt body');
});

test('task.mjs start with a missing arm ack aborts loudly: per-step status, no prompt sent', () => {
  const res = runTask(['start', 'stuck', fx.taskfile, '--cwd', fx.work], fx.failArmEnv, fx.work);
  assert.notEqual(res.status, 0, 'arm timeout must fail the whole start');
  assert.match(res.stderr, /ABORTED at step "arm"/);
  assert.match(res.stderr, /spawn\s+ok \(pane/, 'the spawn step is reported as done');
  assert.match(res.stderr, /arm\s+FAILED.*no arm ack/s, 'the arm failure carries the engine error');
  assert.match(res.stderr, /prompt\s+skipped/, 'the un-sent prompt step is explicit, not silent');
  assert.match(res.stderr, /next:/, 'the operator gets the exact next command');
  assert.equal(fx.calls(true).filter(call => call[0] === 'agent' && call[1] === 'prompt').length, 0,
    'no prompt may land on an un-armed child');
  // The child is NOT lost: it was spawned and recorded before the arm failed.
  const stuck = readSpawns(spawnsFileFor(fx.receipts, fx.work)).find(record => record.name === 'stuck');
  assert.ok(stuck, 'the half-started child stays recorded for follow-up (close/re-arm)');
});

test('task.mjs continue re-prompts the live child with the same marker format', () => {
  assert.ok(started);
  const before = fx.calls().filter(call => call[0] === 'agent' && call[1] === 'prompt').length;
  const res = runTask(['continue', 'worker', 'Tiếp tục: viết test cho fix.'], fx.env, fx.work);
  assert.equal(res.status, 0, `continue must succeed (stderr: ${res.stderr})`);
  const out = JSON.parse(res.stdout.trim()) as { id: string; prompted: boolean; marker: string; paneId: string };
  assert.equal(out.id, started.id);
  assert.equal(out.prompted, true);
  assert.equal(out.marker, `[herdr-request:${started.id}]`);
  const prompts = fx.calls().filter(call => call[0] === 'agent' && call[1] === 'prompt');
  assert.equal(prompts.length, before + 1, 'exactly one more prompt');
  const text = prompts.at(-1)![3];
  assert.equal(text.split('\n')[0], `[herdr-request:${started.id}]`, 're-prompt keeps the marker ALONE on line 1');
  assert.ok(text.includes('Tiếp tục: viết test cho fix.'));
  // Unknown child fails closed instead of prompting some random pane.
  const ghost = runTask(['continue', 'ghost', 'hello'], fx.env, fx.work);
  assert.notEqual(ghost.status, 0);
  assert.match(ghost.stderr, /no spawn record for ghost/);
});

test('task.mjs status joins pane/agent/receipt state, sorted recent-first; list is one line per child', () => {
  assert.ok(started);
  // A settled receipt for the live child + an older record whose pane is gone.
  const scope = join(fx.receipts, scopeFor(fx.work));
  const other = '22222222-2222-4222-8222-222222222222';
  writeFileSync(join(scope, 'receipts.jsonl'),
    JSON.stringify({ v: 1, id: started.id, status: 'replied', sessionId: started.id, ts: 5, turns: 3, lastActivityAt: 5000 }) + '\n');
  const registry = spawnsFileFor(fx.receipts, fx.work);
  writeFileSync(registry, `${readFileSync(registry, 'utf8')}${
    JSON.stringify({ id: other, sessionId: other, paneId: 'w1:p9', name: 'older-job', cwd: fx.work, ts: 1000 })}\n`);

  const res = runTask(['status'], fx.env, fx.work);
  assert.equal(res.status, 0);
  const rows = JSON.parse(res.stdout) as StatusRow[];
  assert.equal(rows.length, 3, 'worker + stuck + older-job');
  const worker = rows.find(row => row.name === 'worker')!;
  assert.equal(worker.id, started.id.slice(0, 8), 'short id');
  assert.equal(worker.pane, started.paneId);
  assert.equal(worker.live, true);
  assert.equal(worker.agent_status, 'idle', 'agent_status straight from herdr agent get');
  assert.deepEqual(worker.receipt, { status: 'replied', turns: 3, lastActivityAt: 5000 });
  assert.equal(worker.died, false);
  assert.equal(worker.closedBy, null);
  const older = rows.find(row => row.name === 'older-job')!;
  assert.equal(older.live, false, 'pane not in herdr → gone');
  assert.equal(older.agent_status, null);
  assert.equal(older.receipt, null);
  assert.ok(rows.findIndex(row => row.name === 'worker') < rows.findIndex(row => row.name === 'older-job'),
    'receipt lastActivityAt (5000) sorts before the older ts (1000) — recent first');

  const one = runTask(['status', 'worker'], fx.env, fx.work);
  assert.equal((JSON.parse(one.stdout) as StatusRow[]).length, 1, 'status <name> filters');

  const listed = runTask(['list'], fx.env, fx.work);
  assert.equal(listed.status, 0);
  const lines = listed.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, 'one line per child');
  assert.match(lines.find(line => line.startsWith('worker '))!, /receipt=replied turns=3/);
  assert.match(lines.find(line => line.startsWith('older-job '))!, /gone no-receipt/);
});

test('task.mjs close delegates to spawn.mjs close and the child shows closed afterwards', () => {
  assert.ok(started);
  const res = runTask(['close', 'worker'], fx.env, fx.work);
  assert.equal(res.status, 0, `close must succeed (stderr: ${res.stderr})`);
  const out = JSON.parse(res.stdout.trim()) as { closed: string; kind: string; closedBy: string | null };
  assert.equal(out.closed, started.paneId, 'the pane close went through herdr');
  assert.equal(out.kind, 'pane');
  assert.equal(out.closedBy, 'parent', 'the intentional-close marker survives the delegation');
  assert.ok(fx.calls().some(call => call[0] === 'pane' && call[1] === 'close' && call[2] === started.paneId));
  const rows = JSON.parse(runTask(['status', 'worker'], fx.env, fx.work).stdout) as StatusRow[];
  assert.equal(rows[0].live, false, 'the closed pane is gone from herdr');
  assert.equal(rows[0].closedBy, 'parent');
});

test('usage without a command fails with the subcommand list', () => {
  const res = runTask([], fx.env, fx.work);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /usage: task\.mjs start/);
});

test('temporary task fixtures are cleaned up', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
