import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deathFrame, paneForSession, parentOf, readAllSpawns, scanSpawnDeaths, wakeFrame, wakeParentOnSettle, watchSpawnDeaths, writeFileVerified } from '../plugin/server/pi-wake.mjs';
import { readSpawns } from '../experiments/pi-spawn/registry.mjs';
import { scopeFor, watchReceipts } from '../plugin/server/pi-receipts.mjs';

const execFile = promisify(execFileCb);

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'hg-wake-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const WORKER_JOB = '33333333-3333-4333-8333-333333333333';
const entry = (over: Record<string, unknown> = {}) => ({
  v: 1, id: CHILD, status: 'replied', sessionId: CHILD, ts: 1_797_000_000_000, ...over,
});

function spawnFixture() {
  const base = root();
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl'), [
    JSON.stringify({ id: CHILD, sessionId: CHILD, parentSessionId: PARENT, name: 'title', paneId: 'w8:pP', ts: 1 }),
    JSON.stringify({ id: WORKER_JOB, sessionId: WORKER_JOB, parentSessionId: 'pi-worker', name: 'job-1', self: true, ts: 2 }),
  ].join('\n') + '\n');
  return base;
}

test('registry scan resolves the controller edge over self declarations', () => {
  const base = spawnFixture();
  const spawns = readAllSpawns(base);
  assert.equal(spawns.length, 2);
  assert.equal(parentOf(spawns, CHILD)?.parentSessionId, PARENT);
  assert.equal(parentOf(spawns, WORKER_JOB)?.parentSessionId, 'pi-worker');
  assert.equal(parentOf(spawns, '44444444-4444-4444-8444-444444444444'), null);
  assert.deepEqual(readAllSpawns(join(base, 'missing')), []);
});

test('paneForSession matches the pane whose agent_session file ends with the id', () => {
  const panes = [
    { pane_id: 'w9:p0', agent_session: { value: `/x/2026-a_${PARENT}.jsonl` } },
    { pane_id: 'w9:p1', agent_session: { value: `/x/2026-b_${CHILD}.jsonl` } },
    { pane_id: 'w9:p2' },
  ];
  assert.equal(paneForSession(panes, PARENT), 'w9:p0');
  assert.equal(paneForSession(panes, CHILD), 'w9:p1');
  assert.equal(paneForSession(panes, '55555555-5555-4555-8555-555555555555'), null);
  assert.equal(paneForSession(null, PARENT), null);
});

test('wakeFrame is one terse line with the essentials, never the reply text', () => {
  const spawn = { sessionId: CHILD, parentSessionId: PARENT, name: 'cmdjob' };
  const frame = wakeFrame(entry({ title: 'chạy  echo ok  cho worker', usage: { totalTokens: 12, costUsd: 0.001 } }), spawn);
  assert.ok(frame.startsWith('[herdgate-wake child=cmdjob '));
  assert.ok(frame.includes(`id=${CHILD}`));
  assert.ok(frame.includes('status=replied'));
  assert.ok(frame.includes('title="chạy echo ok cho worker"'));
  assert.ok(frame.includes('tokens=12'));
  // the self-describing directive keeps wake handling durable across compaction
  assert.ok(frame.includes('LÀM TRỌN TRONG TURN NÀY'));
  assert.ok(!frame.includes('\n'));
  assert.ok(wakeFrame(entry({ status: 'failed', reason: 'job_timeout' }), spawn).includes('reason=job_timeout'));
  const long = wakeFrame(entry({ title: 'x'.repeat(500) }), spawn);
  assert.ok(long.length <= 481);
  assert.ok(long.includes('không chỉ ack'));
});

test('wakeParentOnSettle prompts the parent pane and survives every failure', () => {
  const base = spawnFixture();
  const calls: { args: string[]; error?: Error }[] = [];
  const panes = [
    { pane_id: 'w9:p0', agent_session: { value: `/x/2026-a_${PARENT}.jsonl` } },
    { pane_id: 'w9:p1', agent_session: { value: `/x/2026-b_${CHILD}.jsonl` } },
    { pane_id: 'w9:p2' },
  ];
  const logs: string[] = [];
  const wake = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => {
      const last = calls[calls.length - 1];
      if (last?.error) throw last.error;
      calls.push({ args });
      return {};
    },
    listPanes: () => panes,
    log: (m: string) => logs.push(m),
  });
  wake(entry());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['pane', 'run', 'w9:p0']);
  assert.match(calls[0].args[3], /^\[herdgate-wake child=title /);

  // a blocked parent (herdr rejects) logs and drops — never throws
  calls.push({ args: [], error: new Error('agent_blocked') });
  wake(entry());
  assert.match(logs.at(-1)!, /wake failed: agent_blocked/);

  // parent pane closed: logged, skipped
  panes.length = 0;
  wake(entry());
  assert.match(logs.at(-1)!, /pane gone/);

  // worker self-parents resolve to no live pane (session 'pi-worker') — no crash
  panes.push({ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } });
  wake(entry({ id: WORKER_JOB, sessionId: WORKER_JOB }));
  assert.match(logs.at(-1)!, /pane gone — child job-1/);

  // receipts that are not spawned children wake nobody
  const before = calls.filter(c => !c.error).length;
  wake(entry({ id: '66666666-6666-4666-8666-666666666666', sessionId: '77777777-7777-4777-8777-777777777777' }));
  assert.equal(calls.filter(c => !c.error).length, before);
});

test('delivery waits for the parent to go idle — never forks the session tree', async () => {
  const base = spawnFixture();
  const delivered: string[][] = [];
  const logs: string[] = [];
  const states = ['working', 'working', 'blocked', 'idle'];
  let probes = 0;
  const panes = [{ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } }];
  const wake = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { delivered.push(args); return {}; },
    listPanes: () => panes,
    agentState: () => states[Math.min(probes++, states.length - 1)],
    log: (m: string) => logs.push(m),
    retryDelayMs: () => new Promise(r => setTimeout(r, 5)),
    maxWaitMs: 10_000,
  });
  wake(entry());
  await new Promise(r => setTimeout(r, 60));
  assert.equal(delivered.length, 1, 'delivered exactly once, after idle');
  assert.equal(probes, 4, 'probed until the parent was idle');
  assert.match(logs.at(-1)!, /waited \d+s/);

  // a parent that never goes idle: the wake is dropped, never injected mid-turn
  delivered.length = 0;
  probes = 0;
  const stuck = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { delivered.push(args); return {}; },
    listPanes: () => panes,
    agentState: () => 'working',
    log: (m: string) => logs.push(m),
    retryDelayMs: () => new Promise(r => setTimeout(r, 5)),
    maxWaitMs: 30,
  });
  stuck(entry());
  await new Promise(r => setTimeout(r, 80));
  assert.equal(delivered.length, 0, 'never injected into a busy parent');
  assert.match(logs.at(-1)!, /stayed working/);
});

test('the recorded parent pane wins over a same-session ghost', () => {
  const base = root();
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  const REAL = 'w9:p9';
  const GHOST = 'w9:p1';
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl'),
    JSON.stringify({ id: CHILD, sessionId: CHILD, parentSessionId: PARENT, name: 'real', paneId: 'w9:px', parentPaneId: REAL, ts: 1 }) + '\n');
  // Two panes bound to the SAME session file — the ghost sorts first.
  const panes = [
    { pane_id: GHOST, agent_session: { value: `/x/g_${PARENT}.jsonl` } },
    { pane_id: REAL, agent_session: { value: `/x/r_${PARENT}.jsonl` } },
  ];
  const calls: string[][] = [];
  const wake = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { calls.push(args); return {}; },
    listPanes: () => panes,
    log: () => {},
  });
  wake(entry());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], REAL, 'the recorded pane wins, not the first session match');

  // recorded pane gone (parent moved/closed): fall back to session lookup — the
  // ghost would get it, so this is last-resort only and logged loudly
  panes.splice(1, 1);
  calls.length = 0;
  const logs: string[] = [];
  const wake2 = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { calls.push(args); return {}; },
    listPanes: () => panes,
    log: (m: string) => logs.push(m),
  });
  wake2(entry());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], GHOST, 'legacy fallback still reaches some pane bound to the session');
});

test('idle is not enough: the revision must hold steady across the settle delay', async () => {
  const base = spawnFixture();
  const delivered: string[][] = [];
  const logs: string[] = [];
  const panes = [{ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } }];
  // The wfork1 race, replayed: herdr flips 'idle' BEFORE the turn's final
  // message lands — the revision keeps moving under an idle-looking status.
  let revision = 681;
  const bump = () => { revision += 1; };
  let round = 0;
  const wake = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { delivered.push(args); return {}; },
    listPanes: () => panes,
    agentProbe: () => {
      round += 1;
      // round 1: idle but the turn is still closing (bumped during the settle delay)
      if (round === 1) { setTimeout(bump, 5); return { status: 'idle', revision }; }
      return { status: 'idle', revision };
    },
    log: (m: string) => logs.push(m),
    retryDelayMs: () => new Promise(r => setTimeout(r, 5)),
    settleDelayMs: () => new Promise(r => setTimeout(r, 10)),
    maxWaitMs: 5_000,
  });
  wake(entry());
  await new Promise(r => setTimeout(r, 120));
  assert.equal(delivered.length, 1, 'delivered once the revision held steady');
  assert.ok(round >= 3, `re-probed through the race (rounds: ${round})`);
  assert.match(logs.at(-1)!, /quiet parent/);
});

// ── observe/wake fixes (live incident 21/11) + death wake (herdr-pings lesson) ──

const KID = '44444444-4444-4444-8444-444444444444';
const KID2 = '55555555-5555-4555-8555-555555555555';

/** A minimal fake Pi runtime driving the REAL observer (experiments/pi-receipt),
 *  the same harness shape as test/pi-receipt.test.ts — receipts land in `base`,
 *  so watchReceipts + wakeParentOnSettle see exactly what production sees. */
async function piWorker(options: { base: string; sessionId: string }) {
  const cwd = join(options.base, 'work');
  mkdirSync(cwd, { recursive: true });
  const commands = new Map<string, Function>();
  const hooks = new Map<string, Function>();
  const prior = process.env.HERDGATE_PI_RECEIPT_DIR;
  process.env.HERDGATE_PI_RECEIPT_DIR = options.base; // captured when the factory runs
  const { default: activate } = await import(new URL('../experiments/pi-receipt/observer.js', import.meta.url).href);
  activate({
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    on: (event: string, handler: Function) => hooks.set(event, handler),
  });
  process.env.HERDGATE_PI_RECEIPT_DIR = prior;
  const entries = new Map<string, { id: string; type: string; parentId: string | null; message?: Record<string, unknown> }>();
  let leaf: string | null = null;
  const notifications: string[] = [];
  const ctx = {
    mode: 'tui',
    cwd,
    ui: { notify: (text: string) => notifications.push(text) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getLeafId: () => leaf,
      getEntry: (id: string) => entries.get(id),
    },
  };
  const emit = (name: string, event: Record<string, unknown> = {}) => hooks.get(name)?.({ type: name, ...event }, ctx);
  const command = async (name: string, args = '') => {
    await commands.get(`herdgate-${name}`)!(args, ctx);
    return JSON.parse(notifications.at(-1)!);
  };
  const append = (type: string, fields: Record<string, unknown> = {}) => {
    const id = String(entries.size + 1);
    entries.set(id, { id, parentId: leaf, type, ...fields });
    leaf = id;
    return id;
  };
  const user = (text: string) => append('message', { message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = () => append('message', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  emit('session_start');
  return {
    command, user, assistant, cwd,
    turn: (messageEntryId: string) => emit('turn_end', { messageEntryId }),
    settle: (aborted = false) => emit('agent_settled', { aborted }),
  };
}

const until = async (ok: () => boolean, what: string, ms = 4_000) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise(r => setTimeout(r, 25));
  }
};

/** Registry + parent-pane fixtures shared by the observe/wake tests. */
function wakeFixture(kid = KID, kid2 = KID2) {
  const base = root();
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  const spawnFile = join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl');
  const line = (id: string, name: string, paneId: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ id, sessionId: id, parentSessionId: PARENT, parentPaneId: 'w9:p0', name, paneId, ts: 1, ...over });
  const panes = [
    { pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } },
    { pane_id: 'w9:pC' },
  ];
  const frames: string[][] = [];
  const wake = wakeParentOnSettle({
    spawnBase: base,
    run: (...args: string[]) => { frames.push(args); return {}; },
    listPanes: () => panes,
    agentProbe: () => ({ status: 'idle', revision: 7 }),
    log: () => {},
    retryDelayMs: () => new Promise(r => setTimeout(r, 2)),
    settleDelayMs: () => new Promise(r => setTimeout(r, 2)),
    maxWaitMs: 5_000,
  });
  return { base, spawnFile, line, panes, frames, wake };
}

test('a settle with no user input does not kill the arm — the marker prompt still wakes', async () => {
  const { base, spawnFile, line, frames, wake } = wakeFixture();
  writeFileSync(spawnFile, line(KID, 'wakekid', 'w9:pC') + '\n');
  const stop = watchReceipts(base, wake, { intervalMs: 60 });
  const w = await piWorker({ base, sessionId: KID });
  const armed = await w.command('arm', `--id ${KID}`);
  assert.equal(armed.status, 'armed');
  // The live 21/11 incident: session-start settle with NOTHING after the
  // baseline used to finalize request_not_observed and kill the arm.
  w.settle();
  assert.equal((await w.command('receipt', KID)).status, 'armed', 'the arm survives a settle with no user input');
  w.user(`${armed.marker}\nviệc một`);
  w.turn(w.assistant());
  w.settle(false);
  assert.equal((await w.command('receipt', KID)).status, 'replied');
  await until(() => frames.length === 1, 'the final settle never woke the parent');
  assert.equal(frames[0][2], 'w9:p0');
  assert.match(frames[0][3], /^\[herdgate-wake child=wakekid /);
  stop();
});

test('re-prompted markers: newest wins per round and both settles wake the parent', async () => {
  const { base, spawnFile, line, frames, wake } = wakeFixture();
  writeFileSync(spawnFile, line(KID, 'wakekid', 'w9:pC') + '\n');
  const stop = watchReceipts(base, wake, { intervalMs: 60 });
  const w = await piWorker({ base, sessionId: KID });
  // Round one carries TWO marker prompts (a re-prompt queued behind the first
  // turn): the newest is the request, the old turn is history — not a foul.
  const armed = await w.command('arm', `--id ${KID}`);
  w.user(`${armed.marker}\njob one`);
  w.turn(w.assistant());
  w.user(`${armed.marker}\njob one RETRY`);
  w.turn(w.assistant());
  w.settle(false);
  assert.equal((await w.command('receipt', KID)).status, 'replied');
  const journal = readFileSync(join(base, scopeFor(w.cwd), 'receipts.jsonl'), 'utf8');
  assert.ok(journal.includes('"title":"job one RETRY"'), 'the newest marker owns the tracked prompt');
  await until(() => frames.length === 1, 'the first settle never woke the parent');
  // Round two: a fresh arm on the same child session settles and wakes again.
  const second = await w.command('arm', `--id ${KID2}`);
  w.user(`${second.marker}\njob two`);
  w.turn(w.assistant());
  w.settle(false);
  assert.equal((await w.command('receipt', KID2)).status, 'replied');
  await until(() => frames.length === 2, 'the second settle never woke the parent');
  assert.deepEqual(frames.map(f => f[2]), ['w9:p0', 'w9:p0']);
  assert.ok(frames[0][3].includes(`id=${KID}`) && frames[1][3].includes(`id=${KID2}`));
  stop();
});

test('unmarked human input after a marked prompt invalidates the arm — no wake', async () => {
  const { base, spawnFile, line, frames, wake } = wakeFixture();
  writeFileSync(spawnFile, line(KID, 'wakekid', 'w9:pC') + '\n');
  const stop = watchReceipts(base, wake, { intervalMs: 60 });
  const w = await piWorker({ base, sessionId: KID });
  const armed = await w.command('arm', `--id ${KID}`);
  w.user(`${armed.marker}\nviệc`);
  w.turn(w.assistant());
  w.user('plain human typing'); // competing input AFTER the marked request
  w.turn(w.assistant());
  w.settle(false);
  const receipt = await w.command('receipt', KID);
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.reason, 'competing_input');
  assert.equal(receipt.requestEntryId, '1', 'the marked request had been adopted before the foul');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(frames.length, 0, 'an invalidated intent is not a final settle — it wakes nobody');
  stop();
});

test('a vanished pane without a final settle wakes the parent once, marked died in the registry', async () => {
  const base = root();
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  const spawnFile = join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl');
  writeFileSync(spawnFile, JSON.stringify({ id: KID, sessionId: KID, parentSessionId: PARENT,
    parentPaneId: 'w9:p0', name: 'wakekid', paneId: 'w9:pC', ts: 1 }) + '\n');
  const frames: string[][] = [];
  const stop = watchSpawnDeaths({
    spawnBase: base,
    run: (...args: string[]) => { frames.push(args); return {}; },
    listPanes: () => [{ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } }], // w9:pC is GONE
    agentProbe: () => ({ status: 'idle', revision: 3 }),
    log: () => {},
    intervalMs: 25,
    retryDelayMs: () => new Promise(r => setTimeout(r, 2)),
    settleDelayMs: () => new Promise(r => setTimeout(r, 2)),
  });
  await until(() => frames.length === 1, 'the death watch never woke the parent');
  assert.equal(frames[0][2], 'w9:p0', 'the DIED banner goes to the recorded parent pane');
  assert.equal(frames[0][3], deathFrame({ name: 'wakekid' }));
  assert.equal(frames[0][3], `🔔 WAKE — agent wakekid DIED: pane biến mất chưa kịp settle — kiểm tra registry, restore nếu cần`);
  const stored = readSpawns(spawnFile).find(s => s.id === KID)!;
  assert.equal(stored.died, true, 'the registry record is marked died');
  assert.ok(Number.isFinite(stored.diedAt));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(frames.length, 1, 'one DIED per child — the sweep never spams');
  stop();
});

test('a parent-closed child and an already-settled child never report DIED', async () => {
  const base = root();
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  const spawnFile = join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl');
  writeFileSync(spawnFile, [
    JSON.stringify({ id: KID, sessionId: KID, parentSessionId: PARENT, parentPaneId: 'w9:p0', name: 'closedkid', paneId: 'w9:pX', closedBy: 'parent', ts: 1 }),
    JSON.stringify({ id: KID2, sessionId: KID2, parentSessionId: PARENT, parentPaneId: 'w9:p0', name: 'donekid', paneId: 'w9:pY', ts: 2 }),
  ].join('\n') + '\n');
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'),
    JSON.stringify({ v: 1, id: KID2, status: 'replied', sessionId: KID2, ts: 3 }) + '\n');
  const frames: string[][] = [];
  const stop = watchSpawnDeaths({
    spawnBase: base,
    run: (...args: string[]) => { frames.push(args); return {}; },
    listPanes: () => [{ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } }], // pX and pY gone
    agentProbe: () => ({ status: 'idle', revision: 3 }),
    log: () => {},
    intervalMs: 20,
  });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(frames.length, 0, 'an intentional close and a settled child are not deaths');
  assert.ok(!readFileSync(spawnFile, 'utf8').includes('"died"'), 'no died marks are invented');
  stop();
  // The scan itself stays silent for herdr being unreachable: no pane list, no verdicts.
  assert.deepEqual(scanSpawnDeaths({ spawnBase: base, listPanes: () => [] }), []);
  assert.deepEqual(scanSpawnDeaths({ spawnBase: base, listPanes: () => { throw new Error('herdr down'); } }), []);
});

test('arm waits for the child ack file — and fails closed without it', async () => {
  const base = root();
  const ctrl = join(base, 'ctrl');
  mkdirSync(ctrl, { recursive: true });
  mkdirSync(join(base, scopeFor(ctrl)), { recursive: true });
  writeFileSync(join(base, scopeFor(ctrl), 'spawns.jsonl'),
    JSON.stringify({ id: KID, sessionId: KID, paneId: 'w9:pC', parentSessionId: PARENT,
      parentPaneId: 'w9:p0', name: 'ackkid', cwd: ctrl, ts: 1 }) + '\n');
  // A fake herdr: pane list / agent get answer JSON; the typed /herdgate-arm
  // (pane run) returns at once — the CHILD's activation ack lands on a timer,
  // so the only thing that can satisfy arm is polling the ack file.
  const fakeHerdr = join(base, 'fake-herdr.mjs');
  writeFileSync(fakeHerdr, `#!/usr/bin/env node
const [cmd, sub] = process.argv.slice(2);
if (cmd === 'pane' && sub === 'list') console.log(JSON.stringify({ result: { panes: [{ pane_id: 'w9:p0' }, { pane_id: 'w9:pC' }] } }));
else if (cmd === 'agent' && sub === 'get') console.log(JSON.stringify({ result: { agent: { agent_status: 'idle' } } }));
`);
  chmodSync(fakeHerdr, 0o755);
  const spawnCli = fileURLToPath(new URL('../experiments/pi-spawn/spawn.mjs', import.meta.url));
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr, HERDGATE_PI_RECEIPT_DIR: base };
  const started = Date.now();
  const armJob = execFile(process.execPath, [spawnCli, 'arm', 'ackkid'], { cwd: ctrl, env });
  setTimeout(() => writeFileSync(join(base, `${KID}.armed.json`), `${JSON.stringify({ id: KID, at: Date.now() })}\n`), 300);
  const out = JSON.parse((await armJob).stdout);
  assert.equal(out.status, 'armed');
  assert.equal(out.id, KID);
  assert.ok(Date.now() - started >= 250, 'arm returned only after the ack file appeared');
  // The stale ack from round one must not fake the next handshake: arm unlinks
  // it, no new ack ever comes, and the short test timeout ends in exit 1.
  const t0 = Date.now();
  await assert.rejects(
    execFile(process.execPath, [spawnCli, 'arm', 'ackkid'], { cwd: ctrl, env: { ...env, HERDGATE_ARM_ACK_TIMEOUT_MS: '300' } }),
    (error: NodeJS.ErrnoException & { stderr?: string }) => error.code === 1 && /no arm ack/i.test(error.stderr ?? ''),
    'a missing ack must fail loudly');
  assert.ok(Date.now() - t0 < 5_000, 'the test timeout flag is honored');
});

test('writeFileVerified lands exact bytes via tmp+rename and leaves no tmp behind', () => {
  const dir = root();
  const file = join(dir, 'nested', 'sidecar.json');
  assert.equal(writeFileVerified(file, '{"a":1}\n'), true, 'a fresh write verifies against the real read-back');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.equal(writeFileVerified(file, '{"a":2}\n'), true, 'the overwrite path re-verifies too');
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n');
  assert.deepEqual(readdirSync(join(dir, 'nested')).filter(n => n.endsWith('.tmp')), [], 'no tmp litter survives the rename');
});
