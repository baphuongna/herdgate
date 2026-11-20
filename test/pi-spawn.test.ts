import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COMPACT_AT, MAX_SPAWNS, readSpawns, recordSpawn, spawnsFile, updateSpawn } from '../experiments/pi-spawn/registry.mjs';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';

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

test('temporary spawn registries are cleaned up', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
