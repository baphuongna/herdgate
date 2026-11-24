import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** C27 — sdd.mjs: one command for the whole read-only SDD role lifecycle
 *  (lock → task.mjs start with --tools read → herdr agent wait → read the
 *  last assistant text from the session jsonl → close → release). E2E in a
 *  sandbox: a scripted herdr stub (pattern of pi-task.test.ts) so task.mjs
 *  itself runs for real, plus unit tests for the pure helpers. */

const SDD_CLI = new URL('../experiments/pi-spawn/sdd.mjs', import.meta.url).pathname;
const roots: string[] = [];

// The stub answers everything task.mjs/spawn.mjs/sdd.mjs ask of herdr, logs
// every invocation to STUB_LOG, and — the C27 addition — serves `agent wait`
// with an agent_session pointing at STUB_SESSION_FILE (unset + STUB_NO_SESSION
// simulates a host that cannot tell us the session file).
const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // A settle-signal receipt, exactly where findReceipt reads it (16-hex
  // scope dir + receipts.jsonl, v4 id) — so tests can prove the found path.
  try {
    const dir = join(process.env.HERDGATE_PI_RECEIPT_DIR, id.replace(/-/g, '').slice(0, 16));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'receipts.jsonl'), JSON.stringify({ v: 1, id, sessionId: id, status: 'replied', turns: 1, ts: Date.now(), lastActivityAt: Date.now() }) + '\\n');
  } catch { /* best effort */ }
  save();
  out({ result: { ok: true } });
} else if (group === 'agent' && sub === 'get') {
  const seq = (process.env.STUB_AGENT_SEQ || 'idle').split(',');
  const status = seq[Math.min(state.getSeq ?? 0, seq.length - 1)];
  state.getSeq = (state.getSeq ?? 0) + 1; save();
  out({ result: { agent: { agent_status: status } } });
} else if (group === 'agent' && sub === 'prompt') {
  out({ result: { ok: true } });
} else if (group === 'agent' && sub === 'wait') {
  if (process.env.STUB_WAIT_FAIL) { console.error('wait: simulated timeout'); process.exit(3); }
  const session = process.env.STUB_NO_SESSION ? null
    : { agent_session: { kind: 'path', value: process.env.STUB_SESSION_FILE } };
  out({ id: 'cli:agent:wait', result: { agent: { pane_id: args[2], agent_status: 'done', ...session } } });
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

type Fixture = {
  base: string; work: string; receipts: string; brief: string; sessionFile: string;
  env: NodeJS.ProcessEnv; calls: () => string[][];
};

function fixture(withSession = true): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'hg-sdd-'));
  roots.push(base);
  const work = join(base, 'work');
  const receipts = join(base, 'receipts');
  const sessions = join(base, 'sessions');
  mkdirSync(work, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const stub = join(base, 'herdr-stub.mjs');
  writeFileSync(stub, STUB_SOURCE);
  chmodSync(stub, 0o755);
  const brief = join(base, 'brief.md');
  writeFileSync(brief, 'Phản biện spec X. Kết thúc: C27-ROLE-DONE 0\n');
  const sessionFile = join(sessions, '2026-11-24T02-17-08-416Z_1a043c32-39fc-403f-8cea-25841234e3d3.jsonl');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'file body' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'F1 [NIT] — a/c:1 — cũ — bỏ' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'chốt' }, { type: 'text', text: 'F1 [BLOCK] — spec/x — sai — sửa\n\nC27-ROLE-DONE 1' }] } }),
  ].join('\n') + '\n');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HERDR_BIN_PATH: stub,
    HERDGATE_PI_RECEIPT_DIR: receipts,
    HERDGATE_ARM_ACK_TIMEOUT_MS: '10000',
    STUB_LOG: join(base, 'calls.log'),
    STUB_STATE: join(base, 'state.json'),
    HERDR_SDD_SETTLE_POLL_MS: '0', // tests never wait on the real settle poll
    HERDR_SDD_SESSIONS_ROOT: sessions, // the fallback glob root
    ...(withSession ? { STUB_SESSION_FILE: sessionFile } : { STUB_NO_SESSION: '1' }),
  };
  const calls = () => { try { return readFileSync(join(base, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]); } catch { return []; } };
  return { base, work, receipts, brief, sessionFile, env, calls };
}

/** env with per-test knobs layered on the happy path */
const withEnv = (f: Fixture, over: Record<string, string>) => ({ ...f.env, ...over });

type RunResult = { stdout: string; stderr: string; status: number | null };

function runSdd(args: string[], env: NodeJS.ProcessEnv): RunResult {
  // spawnSync, never execFileSync: the SUCCESS branch must capture stderr
  // too — an empty-string assert is a free pass (reviewer2's F2), and the
  // settle warnings live exactly on that branch.
  const r = spawnSync(process.execPath, [SDD_CLI, ...args], { encoding: 'utf8', env });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

test('c27 T1: run drives the whole chain with read-only forced — start argv carries --tools read, wait carries the until/timeout flags, answer is the last assistant text, close runs, lock released', () => {
  const f = fixture();
  const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], f.env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /F1 \[BLOCK\] — spec\/x — sai — sửa/, 'the LAST assistant text block is the answer');
  assert.match(r.stdout, /C27-ROLE-DONE 1/);
  const calls = f.calls();
  const start = calls.find(c => c[0] === 'agent' && c[1] === 'start');
  assert.ok(start, 'the child pi was started (task.mjs ran for real)');
  assert.ok(start.includes('--tools') && start[start.indexOf('--tools') + 1] === 'read', 'read-only is forced by configuration');
  assert.ok(start.includes('--model') && start[start.indexOf('--model') + 1] === 'zai/glm-5.3-flash', 'default model');
  const wait = calls.find(c => c[0] === 'agent' && c[1] === 'wait');
  assert.ok(wait, 'wait was called');
  assert.ok(wait.includes('--until') && wait.includes('idle') && wait.includes('done'), 'wait blocks until idle+done, no polling');
  assert.ok(wait.includes('--timeout') && wait[wait.indexOf('--timeout') + 1] === '600000', 'default timeout 600s');
  assert.ok(calls.some(c => c[1] === 'close'), 'the pane/tab was closed');
  assert.ok(!exists(join(f.receipts, 'sdd.lock')), 'the lock is released');
  assert.doesNotMatch(r.stderr, /reading anyway|still busy/, 'the settle receipt arrived — no lag warning');
});

test('c27 T2: a live lock refuses (naming the holder) and spawns nothing; a dead lock is self-healed', () => {
  const f = fixture();
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    mkdirSync(f.receipts, { recursive: true });
    writeFileSync(join(f.receipts, 'sdd.lock'), JSON.stringify({ pid: holder.pid, name: 'c26-reviewer', at: Date.now() }));
    const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], f.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /c26-reviewer/);
    assert.deepEqual(f.calls(), [], 'a refused run spawns NOTHING');
    // stale lock: the pid is dead — self-heal and run
    writeFileSync(join(f.receipts, 'sdd.lock'), JSON.stringify({ pid: 99999999, name: 'ghost', at: 1 }));
    const r2 = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], f.env);
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
    assert.match(r2.stdout, /F1 \[BLOCK\]/);
  } finally { holder.kill(); }
});

test('c27 T3: lastAssistantText joins the non-empty text blocks of the last assistant line that has any; thinking/toolResult are skipped; all-empty yields null', async () => {
  const { lastAssistantText } = await import(new URL('../experiments/pi-spawn/sdd.mjs', import.meta.url).pathname) as {
    lastAssistantText: (rawLines: string[]) => string | null;
  };
  const mk = (role: string, content: unknown[]) => JSON.stringify({ type: 'message', message: { role, content } });
  const lines = [
    mk('toolResult', [{ type: 'text', text: 'not an answer' }]),
    mk('assistant', [{ type: 'text', text: 'old answer' }]),
    mk('assistant', [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '' }]),
    mk('assistant', [{ type: 'thinking', thinking: 'y' }, { type: 'text', text: 'final' }, { type: 'text', text: 'part' }]),
  ];
  assert.equal(lastAssistantText(lines), 'final\npart');
  assert.equal(lastAssistantText([mk('assistant', [{ type: 'text', text: '   ' }])]), null, 'whitespace-only blocks are empty');
  assert.equal(lastAssistantText(['not json']), null);
});

test('c27 T4: resolveSessionFile prefers wait\'s agent_session, falls back to the newest *_<id>.jsonl glob, null when nowhere', async () => {
  const { resolveSessionFile } = await import(new URL('../experiments/pi-spawn/sdd.mjs', import.meta.url).pathname) as {
    resolveSessionFile: (waitOut: string | null, id: string, sessionsRoot: string) => string | null;
  };
  const waitOut = JSON.stringify({ result: { agent: { agent_session: { value: '/direct/session.jsonl' } } } });
  assert.equal(resolveSessionFile(waitOut, 'abc', '/nowhere'), '/direct/session.jsonl', 'the direct path wins without touching the disk');
  const dir = mkdtempSync(join(tmpdir(), 'hg-sdd-glob-'));
  roots.push(dir);
  const id = '1a043c32-39fc-403f-8cea-25841234e3d3';
  const oldF = join(dir, 'a', `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const newF = join(dir, 'b', `2026-11-24T00-00-00-000Z_${id}.jsonl`);
  for (const p of [oldF, newF]) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, ''); }
  utimesSync(oldF, new Date(1), new Date(1));
  assert.equal(resolveSessionFile(null, id, dir), newF, 'multiple matches → newest mtime');
  assert.equal(resolveSessionFile(null, id, '/nowhere'), null);
});

test('c27 T5: no session file findable → exit 2 with a manual-reading hint, and the pane is still closed', () => {
  const f = fixture(false); // the wait stub hides agent_session; sessions root is empty
  const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], f.env);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /session jsonl/, 'the message points at the session file problem');
  assert.match(r.stderr, /task\.mjs status/, 'the message names the manual way out');
  assert.ok(f.calls().some(c => c[1] === 'close'), 'cleanup still closes the pane');
});

test('c27 T6: the idle race — wait returns before the agent starts; the settle loop holds until text exists AND the agent is not working', () => {
  const f = fixture();
  // get #1 (arm check) says idle; get #2 — the settle probe — says working
  // (the race window right after wait returns); from #3 on idle again. The
  // session file already holds the text, so only the settle loop can tell
  // ready from not.
  const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], withEnv(f, { STUB_AGENT_SEQ: 'idle,working,idle', HERDR_SDD_SETTLE_POLL_MS: '5000' }));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /F1 \[BLOCK\]/, 'the answer waited for readiness, then delivered');
  const gets = f.calls().filter(c => c[0] === 'agent' && c[1] === 'get');
  assert.ok(gets.length >= 3, `the settle loop probed through the working window (${gets.length} gets)`);
  assert.doesNotMatch(r.stderr, /still busy/, 'once idle, no busy warning');
});

test('c27 T7: wait failing (timeout) → exit 4, close attempted anyway, rescue line on stderr', () => {
  const f = fixture();
  const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], withEnv(f, { STUB_WAIT_FAIL: '1' }));
  assert.equal(r.status, 4, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /rescue: herdr agent wait/, 'the controller gets the exact next command');
  assert.ok(f.calls().some(c => c[1] === 'close'), 'close was ATTEMPTED on the wait-fail path');
  assert.ok(!exists(join(f.receipts, 'sdd.lock')), 'the lock is released even on failure');
});

function exists(p: string) { try { readFileSync(p); return true; } catch { return false; } }

test('c27 T8: budget ends while the agent still works → exit 4 with rescue, close attempted, and NO mid-task text delivered', () => {
  const f = fixture();
  // arm sees idle (get #1); every settle probe (get #2+) says working — a
  // long-running reviewer writing mid-task text. Budget 0 = single-shot.
  const r = runSdd(['run', 'c27x-probe', f.brief, '--cwd', f.work], withEnv(f, { STUB_AGENT_SEQ: 'idle,working', HERDR_SDD_SETTLE_POLL_MS: '0' }));
  assert.equal(r.status, 4, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), '', 'a mid-task text is NOT an answer — nothing on stdout');
  assert.match(r.stderr, /NOT delivering a mid-task text/, 'the contract says why');
  assert.match(r.stderr, /rescue: /, 'the controller gets the rescue line');
  assert.ok(!exists(join(f.receipts, 'sdd.lock')), 'the lock is released');
});
