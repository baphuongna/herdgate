import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { paneForSession, parentOf, readAllSpawns, wakeFrame, wakeParentOnSettle } from '../plugin/server/pi-wake.mjs';

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
  const panes = [{ pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } }];
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
  assert.deepEqual(calls[0].args.slice(0, 3), ['agent', 'prompt', 'w9:p0']);
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
