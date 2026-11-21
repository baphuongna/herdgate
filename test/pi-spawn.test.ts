import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { COMPACT_AT, MAX_SPAWNS, readSpawns, recordSelf, recordSpawn, spawnsFile, spawnsFileFor, updateSpawn } from '../experiments/pi-spawn/registry.mjs';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';
import { openWatchStore } from '../plugin/server/pi-receipt-watch.mjs';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'hg-spawn-')); roots.push(dir); return dir; };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('spawn records link a controller session to a child pane and Pi session id', () => {
  const base = root();
  mkdirSync(base, { recursive: true });
  const entry = recordSpawn(base, { id: uuid(1), sessionId: uuid(1), paneId: 'w8:pC',
    name: 'demo-child', parentSessionId: uuid(9), cwd: '/home/bom/source', ts: 1 });
  assert.equal(entry.status, 'running');
  assert.equal(spawnsFile(base), join(base, scopeFor(process.cwd()), 'spawns.jsonl'));
  const stored = readSpawns(spawnsFile(base));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].parentSessionId, uuid(9), 'the parent link is durable');
  assert.equal(stored[0].prompt, undefined, 'no brief text in the registry');
  // The same request id supersedes its own record instead of duplicating.
  recordSpawn(base, { id: uuid(1), sessionId: uuid(1), paneId: 'w8:pD', name: 'demo-child', ts: 2 });
  assert.equal(readSpawns(spawnsFile(base)).length, 1);
  assert.equal(readSpawns(spawnsFile(base))[0].paneId, 'w8:pD');
  // Restore updates in place and keeps history of the latest pane.
  const restored = updateSpawn(base, uuid(1), { status: 'restored', paneId: 'w8:pE', restoredAt: 3 });
  assert.deepEqual(restored, { ...restored, status: 'restored', paneId: 'w8:pE' });
  assert.equal(readSpawns(spawnsFile(base))[0].restoredAt, 3);
  // Invalid input fails closed and writes nothing.
  assert.throws(() => recordSpawn(base, { id: 'nope', sessionId: 'x', paneId: 'p', name: 'n', ts: 1 }));
  assert.throws(() => recordSpawn(base, { id: uuid(2), sessionId: uuid(2), paneId: 'p', name: 'Bad Name!', ts: 1 }));
  assert.equal(readSpawns(spawnsFile(base)).length, 1);
});

test('the registry stays bounded and survives a fresh process', () => {
  const base = root();
  for (let i = 0; i < COMPACT_AT + 5; i++) {
    recordSpawn(base, { id: uuid(100 + i), sessionId: uuid(100 + i), paneId: `p${i}`, name: 'c', ts: i });
  }
  const stored = readSpawns(spawnsFile(base));
  assert.ok(stored.length > MAX_SPAWNS && stored.length <= COMPACT_AT + 5,
    `bounded between the keep floor and the compact bound (got ${stored.length})`);
  assert.equal(stored.at(-1)?.paneId, `p${COMPACT_AT + 4}`, 'the newest record is never dropped');
  assert.equal(readSpawns(spawnsFile(base)).length, stored.length, 'a new process reads the same registry');
});

test('self-registered children declare their own parent without a pane', () => {
  const base = root();
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  // A worker job session: id defaults to its own session id (one-id chain), no pane yet.
  const self = recordSelf(base, { sessionId: uuid(7), parentSessionId: 'pi-worker',
    name: 'job-abc12345', cwd: ws, ts: 1 });
  assert.equal(self.id, uuid(7), 'a self-registered child is its own receipt id');
  assert.equal(self.status, 'self');
  assert.equal(self.paneId, undefined);
  const stored = readSpawns(spawnsFileFor(base, ws));
  assert.equal(stored.length, 1, 'the record lands in the workspace scope the child runs in');
  assert.equal(stored[0].parentSessionId, 'pi-worker');
  // Restoring later attaches a pane; a re-registration (same id) still supersedes in place.
  const again = recordSelf(base, { sessionId: uuid(7), parentSessionId: 'pi-worker',
    name: 'job-abc12345', cwd: ws, ts: 2, paneId: 'w8:pZ' });
  assert.equal(again.paneId, 'w8:pZ');
  const after = readSpawns(spawnsFileFor(base, ws));
  assert.equal(after.length, 1, 'supersede keeps one record');
  assert.equal(after[0].paneId, 'w8:pZ', 'a self entry with a pane stays valid');
  // Invalid: no parent declared, or a non-uuid session.
  assert.throws(() => recordSelf(base, { sessionId: uuid(8), name: 'orphan', ts: 1 }), /invalid_self/);
  assert.throws(() => recordSelf(base, { sessionId: 'not-a-uuid', parentSessionId: 'pi-worker',
    name: 'job-x', ts: 1 }), /invalid_self/);
});

// ── dag.mjs: the spawn-tree DAG view (registry + receipts + checked column) ──

const CONTROLLER = 'c0c0c0c0-0000-4000-8000-00000000c0c0';
const CHILD1 = 'a1a1a1a1-0000-4000-8000-00000000a1a1';
const CHILD2 = 'b2b2b2b2-0000-4000-8000-00000000b2b2';
const GRAND = 'd3d3d3d3-0000-4000-8000-00000000d3d3';
const ROOT_SESSION = 'e4e4e4e4-0000-4000-8000-00000000e4e4'; // live but unregistered: not drawn

function dagFixture() {
  const base = root();
  const scopeA = join(base, 'aaaaaaaaaaaaaaaa');
  const scopeB = join(base, 'bbbbbbbbbbbbbbbb');
  mkdirSync(scopeA, { recursive: true });
  mkdirSync(scopeB, { recursive: true });
  writeFileSync(join(scopeA, 'spawns.jsonl'), [
    { id: CONTROLLER, sessionId: CONTROLLER, paneId: 'w1:p1', name: 'controller', parentSessionId: ROOT_SESSION, cwd: '/x', ts: 1 },
    { id: CHILD1, sessionId: CHILD1, paneId: 'w1:p2', name: 'child-one', parentSessionId: CONTROLLER, cwd: '/x', ts: 2 },
    { id: GRAND, sessionId: GRAND, paneId: 'w1:p3', name: 'grand-job', parentSessionId: CHILD1, cwd: '/x', ts: 3 },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(scopeB, 'spawns.jsonl'),
    JSON.stringify({ id: CHILD2, sessionId: CHILD2, paneId: 'w1:p4', name: 'child-two', parentSessionId: CONTROLLER, cwd: '/y', ts: 4 }) + '\n');
  const title = 'fix-login-bug '.repeat(4).trim(); // 56 chars -> capped at 40
  writeFileSync(join(scopeA, 'receipts.jsonl'), JSON.stringify({
    v: 1, id: CHILD1, status: 'replied', sessionId: CHILD1, ts: 5, principal: 'spawn:a1a1a1a1', title,
  }) + '\n');
  writeFileSync(join(scopeB, 'receipts.jsonl'), JSON.stringify({
    v: 1, id: CHILD2, status: 'failed', sessionId: CHILD2, ts: 6, reason: 'job_timeout',
  }) + '\n');
  // One device still waits on child-two's result; child-one's watch intent is long gone.
  openWatchStore(base).register({ device: 'phone-1', requestId: CHILD2 });
  return { base, title };
}

const dagCli = fileURLToPath(new URL('../experiments/pi-spawn/dag.mjs', import.meta.url));
const runDag = (args: string[]) => execFileSync(process.execPath, [dagCli, ...args], { encoding: 'utf8' });

test('dag view draws the spawn tree with receipt status and the checked column', () => {
  const { base, title } = dagFixture();
  const text = runDag(['--base', base]);
  assert.deepEqual(text.trimEnd().split('\n'), [
    'controller [c0c0c0c0] no-receipt',
    `  child-one [a1a1a1a1] replied (spawn:a1a1a1a1) — ${title.slice(0, 40)} ✓`,
    '    grand-job [d3d3d3d3] no-receipt',
    '  child-two [b2b2b2b2] failed ○ pending-view',
  ]);
  assert.ok(!text.includes(title), 'titles stay one line, capped at 40 chars');

  const tree = JSON.parse(runDag(['--base', base, '--json']));
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'controller');
  assert.equal(tree[0].checked, null, 'the root spawn has no receipt of its own');
  assert.equal(tree[0].children.length, 2, 'children sort by ts across scopes');
  const [c1, c2] = tree[0].children;
  assert.equal(c1.status, 'replied');
  assert.equal(c1.checked, true, 'settled receipt, no device still watching');
  assert.equal(c1.title, title.slice(0, 40));
  assert.equal(c1.children.length, 1);
  assert.equal(c1.children[0].name, 'grand-job');
  assert.equal(c1.children[0].status, 'no-receipt');
  assert.equal(c1.children[0].checked, null);
  assert.deepEqual(c1.children[0].children, []);
  assert.equal(c2.status, 'failed');
  assert.equal(c2.checked, false, 'a device still holds the pending watch intent');
  assert.deepEqual(c2.children, []);
});

test('dag view fails closed on a missing base', () => {
  const missing = join(root(), 'nope');
  assert.equal(runDag(['--base', missing]), '', 'empty tree, exit 0');
  assert.deepEqual(JSON.parse(runDag(['--base', missing, '--json'])), []);
});

test('temporary spawn registries are cleaned up', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
