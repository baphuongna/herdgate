// State hardening for the pi-spawn registry + the 3-layer retire for close.
// Mechanisms under test, straight from the deep reports (no reinvention):
//  - deep/portfwd.md §1 (state.rs:613-650): spawnBase refuses a dir another
//    uid owns or group/others can write into, naming the dir;
//  - §2 (state.rs:700-718): atomic writes via O_EXCL temp with an unguessable
//    name + rename (a planted symlink must not be written through);
//  - §3 (state.rs:471): byte-stable output — same records, any order → same
//    bytes; damaged file → error naming the FILE, never a silent empty read;
//  - r-entwurf.md §4 + deep/entwurf.md: retire is 3 explicit layers — the
//    operator names the target, preflight refuses busy children by name, and a
//    leaf generation check (record sessionId vs the session herdr reports on
//    that pane) refuses a REUSED pane in ONE attempt without closing anything.
// Everything runs against a stateful herdr stub via HERDR_BIN_PATH: no real
// herdr, no real model.

import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  findSpawn, readSpawns, readSpawnsTolerant, recordSpawn, spawnBase, spawnsFileFor,
} from '../experiments/pi-spawn/registry.mjs';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';

const execFile = promisify(execFileCb);

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'hg-hard-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const spawnCli = fileURLToPath(new URL('../experiments/pi-spawn/spawn.mjs', import.meta.url));

// ── damaged file: refuse loudly with the file named, warn-and-continue ──

test('a damaged spawns file refuses with its name — never a silent empty read', () => {
  const base = root();
  const file = spawnsFileFor(base, process.cwd());
  mkdirSync(join(base, scopeFor(process.cwd())), { recursive: true });
  writeFileSync(file, [
    JSON.stringify({ id: uuid(1), sessionId: uuid(1), paneId: 'w1:p1', name: 'okchild', ts: 1 }),
    '{this line is not json',
    JSON.stringify({ id: 'garbage', sessionId: '', paneId: 'x', name: 'bad-name!', ts: 'nope' }),
  ].join('\n') + '\n');
  // The reader throws and the error NAMES the file (portfwd StateError::Damaged).
  assert.throws(() => readSpawns(file), (error: Error) => error.message.includes(file),
    'the error names the damaged file');
  // The warn-and-continue read reports the damage AND returns the valid line.
  const warned: string[] = [];
  const partial = readSpawnsTolerant(file, m => warned.push(m));
  assert.deepEqual(partial.map(e => e.id), [uuid(1)]);
  assert.equal(warned.length, 1);
  assert.ok(warned[0].includes(file), 'the warning names the file too');
  // A writer survives the same damage: the valid record survives the rewrite.
  recordSpawn(base, { id: uuid(2), sessionId: uuid(2), paneId: 'w1:p2', name: 'fresh', ts: 2 });
  assert.deepEqual(readSpawns(file).map(e => e.id).sort(), [uuid(1), uuid(2)],
    'after the rewrite only the valid records remain');
});

// ── spawnBase: refuse a dir group/other can write into, naming it ──

test('spawnBase refuses other-writable dirs by name, auto-tightens its own group-writable one', () => {
  const base = root();
  const prev = process.env.HERDGATE_PI_RECEIPT_DIR;
  try {
    for (const mode of [0o002, 0o077]) { // other-writable (with or without group)
      chmodSync(base, mode);
      process.env.HERDGATE_PI_RECEIPT_DIR = base;
      assert.throws(() => spawnBase(), (error: Error) => error.message.includes(base),
        `mode ${mode.toString(8)} must be refused with the dir named`);
    }
    // state.rs:655: group-writable on OUR OWN dir is tightened in place, not refused.
    chmodSync(base, 0o775);
    process.env.HERDGATE_PI_RECEIPT_DIR = base;
    assert.equal(spawnBase(), base, 'a dir we own gets the group write bit tightened away');
    assert.equal(statSync(base).mode & 0o777 & ~0o700, 0o055,
      'the tightened dir is no longer group-writable');
    chmodSync(base, 0o700);
    assert.equal(spawnBase(), base, 'a private dir owned by us passes');
  } finally {
    chmodSync(base, 0o700); // restore traversal for the cleanup
    if (prev === undefined) delete process.env.HERDGATE_PI_RECEIPT_DIR;
    else process.env.HERDGATE_PI_RECEIPT_DIR = prev;
  }
});

// ── byte-stable writes ──

test('registry writes are byte-stable: same records in any order → identical bytes', () => {
  const a = root();
  const b = root();
  const mk = (i: number, ts: number) =>
    ({ id: uuid(i), sessionId: uuid(i), paneId: `w1:p${i}`, name: `c${i}`, ts });
  recordSpawn(a, mk(1, 10)); recordSpawn(a, mk(2, 5)); recordSpawn(a, mk(3, 7));
  recordSpawn(b, mk(3, 7)); recordSpawn(b, mk(1, 10)); recordSpawn(b, mk(2, 5));
  const bytesA = readFileSync(spawnsFileFor(a, process.cwd()), 'utf8');
  const bytesB = readFileSync(spawnsFileFor(b, process.cwd()), 'utf8');
  assert.equal(bytesA, bytesB, 'the file is byte-stable across processes/insertion orders');
  assert.deepEqual(bytesA.trimEnd().split('\n').map(l => JSON.parse(l).id), [uuid(2), uuid(3), uuid(1)],
    'sorted by the stable key (ts, id) — newest last, diffable by a human');
});

// ── findSpawn: duplicate names prefer the LIVE record (shadow-by-orphan fix) ──

test('findSpawn resolves duplicate names to the live record, then the newest ts', () => {
  const base = root();
  const live = recordSpawn(base, { id: uuid(1), sessionId: uuid(1), paneId: 'w1:pLive', name: 'dup', ts: 1 });
  const orphan = recordSpawn(base, { id: uuid(2), sessionId: uuid(2), paneId: 'w1:pDead', name: 'dup', ts: 9 });
  assert.equal(findSpawn(base, 'dup', ['w1:pLive']).id, live.id,
    'a live pane beats a newer orphan — the 22/11 shadow-by-orphan bug');
  assert.equal(findSpawn(base, 'dup').id, orphan.id,
    'with no liveness info the newest ts wins');
  assert.equal(findSpawn(base, live.id, []).id, live.id,
    'an exact id is unique and never tie-broken');
  assert.equal(findSpawn(base, 'nope'), null);
});

// ── close: the 3-layer retire, against a stateful herdr stub ──

/** Stateful herdr stub: `pane list` serves the panes with their agent_session
 *  binding, `agent get` answers with the same session plus a chosen status,
 *  and every get/close lands in the log — so a refusal can PROVE it closed
 *  nothing and queried exactly once. */
function stubHerdr(dir: string, panes: { pane_id: string; session?: string; tab_id?: string }[], status: string):
  { bin: string; log: string } {
  const bin = join(dir, 'herdr.mjs');
  const log = join(dir, 'herdr-calls.log');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const panes = ${JSON.stringify(panes)};
const [group, sub] = args;
const target = args[2];
const pane = panes.find(p => p.pane_id === target);
const sessionFile = pane?.session ? '/sessions/session_' + pane.session + '.jsonl' : null;
if (group === 'pane' && sub === 'list') {
  console.log(JSON.stringify({ result: { panes: panes.map(p => ({
    pane_id: p.pane_id, tab_id: p.tab_id,
    ...(p.session ? { agent_session: { value: '/sessions/session_' + p.session + '.jsonl' } } : {}),
  })) } }));
} else if (group === 'agent' && sub === 'get') {
  appendFileSync(log, JSON.stringify({ argv: args }) + '\\n');
  console.log(JSON.stringify({ result: { agent: {
    agent_status: ${JSON.stringify(status)},
    ...(sessionFile ? { agent_session: { value: sessionFile } } : {}),
  } } }));
} else if (sub === 'close') {
  appendFileSync(log, JSON.stringify({ argv: args }) + '\\n');
  console.log(JSON.stringify({ result: { ok: true } }));
} else {
  console.log(JSON.stringify({ result: {} }));
}
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

interface LogCall { argv: string[] }
const readLog = (log: string): LogCall[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LogCall) : [];

interface CloseFixture { base: string; ws: string; env: NodeJS.ProcessEnv; log: string; registry: string }

/** One child 'hardkid' recorded with recordSession, running on a pane the stub
 *  binds to paneSession (≠ recordSession simulates a REUSED pane). */
function closeFixture(recordSession: string, pane: { pane_id: string; session?: string; tab_id?: string }, status = 'idle'): CloseFixture {
  const base = root();
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const { bin, log } = stubHerdr(base, [pane], status);
  const registry = join(base, scopeFor(ws), 'spawns.jsonl');
  mkdirSync(join(base, scopeFor(ws)), { recursive: true });
  writeFileSync(registry, JSON.stringify({ id: recordSession, sessionId: recordSession, paneId: pane.pane_id,
    name: 'hardkid', parentSessionId: uuid(9), cwd: ws, ts: 1 }) + '\n');
  return { base, ws, env: { ...process.env, HERDR_BIN_PATH: bin, HERDGATE_PI_RECEIPT_DIR: base }, log, registry };
}

interface CloseOut { id: string; name: string; closed: string | null; kind: string; closedBy: string | null; generation?: string }
type ExecErr = NodeJS.ErrnoException & { stderr?: string };

test('close refuses a reused pane on generation mismatch — one attempt, nothing closed', async () => {
  const S1 = uuid(41);
  const f = closeFixture(S1, { pane_id: 'w1:pX', session: uuid(42) }); // pane now runs ANOTHER session
  await assert.rejects(
    execFile(process.execPath, [spawnCli, 'close', 'hardkid'], { cwd: f.ws, env: f.env }),
    (error: ExecErr) => error.code === 1 && /generation mismatch/.test(error.stderr ?? ''),
    'the refusal names the mismatch instead of closing a stranger');
  const calls = readLog(f.log);
  assert.equal(calls.filter(c => c.argv[1] === 'get').length, 1,
    'exactly one generation probe — a mismatched pane is never re-queried into an excuse to close');
  assert.ok(!calls.some(c => c.argv[1] === 'close'), 'no pane/tab close happened');
  assert.equal(readSpawns(f.registry)[0].closedBy, undefined, 'an unverified close is never marked closedBy');
});

test('close preflight refuses a working child by name — the pane stays open', async () => {
  const S = uuid(43);
  const f = closeFixture(S, { pane_id: 'w1:pW', session: S }, 'working');
  await assert.rejects(
    execFile(process.execPath, [spawnCli, 'close', 'hardkid'], { cwd: f.ws, env: f.env }),
    (error: ExecErr) => error.code === 1 && /agent is working/.test(error.stderr ?? ''),
    'layer (b): a busy child is refused while its wake has not arrived');
  assert.ok(!readLog(f.log).some(c => c.argv[1] === 'close'), 'no pane/tab close happened');
  assert.equal(readSpawns(f.registry)[0].closedBy, undefined);
});

test('a verified close marks closedBy WITH the generation it checked', async () => {
  const S = uuid(44);
  const f = closeFixture(S, { pane_id: 'w1:pO', tab_id: 'w1:t9', session: S });
  const out = JSON.parse((await execFile(process.execPath, [spawnCli, 'close', 'hardkid'],
    { cwd: f.ws, env: f.env })).stdout) as CloseOut;
  assert.equal(out.closed, 'w1:pO');
  assert.equal(out.closedBy, 'parent');
  assert.equal(out.generation, S, 'the receipt proves which session the close was verified against');
  const stored = readSpawns(f.registry)[0];
  assert.equal(stored.closedBy, 'parent');
  assert.equal(stored.closedGeneration, S, 'the marker outlives the pane with its evidence');
  assert.ok(readLog(f.log).some(c => c.argv[1] === 'close' && c.argv[2] === 'w1:pO'));
});
