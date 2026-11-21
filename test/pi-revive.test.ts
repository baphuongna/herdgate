// `spawn.mjs revive` — bulk resurrection after a reboot/machine restart (the
// herdr-revive lesson: bring back WHAT WAS RUNNING, on its EXACT conversation,
// never the latest one). Candidates are crash-lost children only (no closedBy,
// no died, pane gone, transcript still on disk); each one reopens through the
// very same restore path, -- --session <the exact file>. Everything runs against
// a stateful herdr stub via HERDR_BIN_PATH: no real herdr, no real model.

import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readSpawns, spawnsFileFor } from '../experiments/pi-spawn/registry.mjs';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';

const execFile = promisify(execFileCb);

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'hg-revive-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const spawnCli = fileURLToPath(new URL('../experiments/pi-spawn/spawn.mjs', import.meta.url));
const PARENT = '99999999-9999-4999-8999-999999999999';
const GONE = 'aaaaaaaa-0000-4000-8000-00000000000a'; // (a) crash-lost, transcript on disk → revived
const CLOSED = 'bbbbbbbb-0000-4000-8000-00000000000b'; // (b) closedBy=parent → skipped
const DIED = 'cccccccc-0000-4000-8000-00000000000c'; // (c) died:true → skipped

/** A stateful herdr stub: tab create / pane split mint panes into a panes.json
 *  the next `pane list` serves back (so a revived child reads as alive), and
 *  every MUTATING call is appended to the log. Read-only `pane list` is exempt
 *  from the log — revive's scan needs liveness; the invariant under test is
 *  that a dry-run changes NOTHING. */
function stubHerdr(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'herdr.mjs');
  const log = join(dir, 'herdr-calls.log');
  const state = join(dir, 'herdr-state');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const panesFile = join(state, 'panes.json');
const read = () => { try { return JSON.parse(readFileSync(panesFile, 'utf8')); } catch { return { next: 1, panes: [] }; } };
const write = (s) => writeFileSync(panesFile, JSON.stringify(s));
const [cmd, sub] = process.argv.slice(2);
mkdirSync(state, { recursive: true });
if (cmd === 'pane' && sub === 'list') {
  console.log(JSON.stringify({ result: { panes: read().panes } }));
} else if (cmd === 'tab' && sub === 'create') {
  const s = read(); const id = 'wS:t' + s.next; write({ next: s.next + 1, panes: [...s.panes, { pane_id: id }] });
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  console.log(JSON.stringify({ result: { root_pane: { pane_id: id } } }));
} else if (cmd === 'pane' && sub === 'split') {
  const s = read(); const id = 'wS:p' + s.next; write({ next: s.next + 1, panes: [...s.panes, { pane_id: id }] });
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  console.log(JSON.stringify({ result: { pane: { pane_id: id } } }));
} else if (cmd === 'agent' && sub === 'start') {
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  console.log(JSON.stringify({ result: {} }));
} else {
  console.log(JSON.stringify({ result: {} }));
}
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

interface LogCall { argv: string[] }
const readLog = (log: string): LogCall[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as LogCall) : [];

interface Fixture { base: string; ws: string; sessionFile: string; env: NodeJS.ProcessEnv; log: string; registry: string }

function fixture(): Fixture {
  const base = root();
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });
  const { bin, log } = stubHerdr(base);
  // A real transcript file on disk: the exact conversation revive must reopen.
  const sessionFile = join(base, 'sessions', `${GONE}.jsonl`);
  mkdirSync(join(base, 'sessions'), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ v: 1, type: 'user', ts: 1 }) + '\n');
  const registry = join(base, scopeFor(ws), 'spawns.jsonl');
  mkdirSync(join(base, scopeFor(ws)), { recursive: true });
  writeFileSync(registry, [
    { id: GONE, sessionId: GONE, paneId: 'w1:pGone', name: 'gonekid', parentSessionId: PARENT,
      cwd: ws, sessionFile, tab: true, ts: 1 },
    { id: CLOSED, sessionId: CLOSED, paneId: 'w1:pClosed', name: 'closedkid', parentSessionId: PARENT,
      cwd: ws, sessionFile, closedBy: 'parent', closedAt: 2, ts: 2 },
    { id: DIED, sessionId: DIED, paneId: 'w1:pDied', name: 'diedkid', parentSessionId: PARENT,
      cwd: ws, sessionFile, died: true, diedAt: 3, ts: 3 },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  return { base, ws, sessionFile, log, registry, env: { ...process.env, HERDR_BIN_PATH: bin, HERDGATE_PI_RECEIPT_DIR: base } };
}

interface ReviveResult { revived?: { name: string; paneId: string }[]; skipped?: { name: string; reason: string }[]; dryRun?: boolean }

test('revive reopens only crash-lost children, each on its exact transcript', async () => {
  const f = fixture();
  const t0 = Date.now();
  const out = JSON.parse((await execFile(process.execPath, [spawnCli, 'revive'], { cwd: f.ws, env: f.env })).stdout) as ReviveResult;
  // (a) revived — into its own tab again (it was a --tab child); (b) and (c) skipped for the right reasons.
  assert.deepEqual(out.revived?.map(r => r.name), ['gonekid']);
  assert.match(out.revived![0].paneId, /^wS:t\d+$/, 'a tab child revives into a fresh tab pane');
  const reasons = Object.fromEntries((out.skipped ?? []).map(s => [s.name, s.reason]));
  assert.match(reasons['closedkid'], /closedBy=parent/, 'an intentional close is never a revive candidate');
  assert.equal(reasons['diedkid'], 'died');
  assert.equal(reasons['gonekid'], undefined, 'the crash-lost child is not also skipped');
  // The one herdr agent start carries -- --session <the exact transcript file>.
  const calls = readLog(f.log);
  const starts = calls.filter(c => c.argv[0] === 'agent' && c.argv[1] === 'start');
  assert.equal(starts.length, 1);
  assert.ok(starts[0].argv.includes('--session'), `session flag present: ${starts[0].argv.join(' ')}`);
  assert.equal(starts[0].argv[starts[0].argv.indexOf('--session') + 1], f.sessionFile, 'the EXACT conversation file, never the latest session');
  // The registry records the revive: restored pane + append-style revivedAt history.
  const stored = readSpawns(f.registry);
  const kid = stored.find(e => e.id === GONE)!;
  assert.equal(kid.status, 'restored');
  assert.equal(kid.paneId, out.revived![0].paneId);
  assert.ok(Array.isArray(kid.revivedAt) && kid.revivedAt.length === 1 && (kid.revivedAt[0] as number) >= t0,
    'revivedAt is journaled append-style');
  // Idempotent: the second pass sees the child alive in the stub's pane list and opens nothing.
  const again = JSON.parse((await execFile(process.execPath, [spawnCli, 'revive'], { cwd: f.ws, env: f.env })).stdout) as ReviveResult;
  assert.deepEqual(again.revived, [], 'a living child is never reopened');
  assert.equal(again.skipped?.find(s => s.name === 'gonekid')?.reason, 'pane-alive');
  assert.equal(readLog(f.log).filter(c => c.argv[1] === 'start').length, 1, 'still exactly one agent start');
  // --name scopes the scan: targeting the closed child revives nothing.
  const named = JSON.parse((await execFile(process.execPath, [spawnCli, 'revive', '--name', 'closedkid'], { cwd: f.ws, env: f.env })).stdout) as ReviveResult;
  assert.deepEqual(named.revived, []);
  assert.match(named.skipped![0].reason, /closedBy=parent/);
  assert.equal(readLog(f.log).filter(c => c.argv[1] === 'start').length, 1);
  await assert.rejects(
    execFile(process.execPath, [spawnCli, 'revive', '--name', 'nope'], { cwd: f.ws, env: f.env }),
    (error: NodeJS.ErrnoException & { stderr?: string }) => error.code === 1 && /no spawn record for nope/.test(error.stderr ?? ''),
    'an unknown name fails loudly instead of reviving silently nothing');
});

test('revive --dry-run lists the plan and touches nothing', async () => {
  const f = fixture();
  const dry = await execFile(process.execPath, [spawnCli, 'revive', '--dry-run'], { cwd: f.ws, env: f.env });
  // The plan names the candidate with its identity — and only the candidate.
  const planLines = dry.stdout.split('\n').filter(l => l.startsWith('would revive '));
  assert.equal(planLines.length, 1);
  assert.match(planLines[0], /^would revive gonekid /);
  assert.ok(planLines[0].includes(f.sessionFile), 'the plan shows which exact transcript would reopen');
  assert.ok(!planLines.some(l => l.includes('closedkid') || l.includes('diedkid')), 'non-candidates are never in the plan');
  const parsed = JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{'))) as Required<ReviveResult>;
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.skipped.map(s => s.name).sort(), ['closedkid', 'diedkid']);
  // Zero herdr actions: the stub log (mutating calls) is empty, the registry untouched.
  assert.deepEqual(readLog(f.log), [], 'a dry-run performs no herdr action at all');
  const stored = readSpawns(f.registry);
  assert.ok(!stored.some(e => e.status === 'restored' || e.revivedAt), 'nothing was actually revived');
});

test('revive skips a gone child whose transcript is gone — no empty look-alikes', async () => {
  const f = fixture();
  rmSync(f.sessionFile, { force: true }); // the reboot ate the transcript too
  const out = JSON.parse((await execFile(process.execPath, [spawnCli, 'revive'], { cwd: f.ws, env: f.env })).stdout) as ReviveResult;
  assert.deepEqual(out.revived, []);
  assert.equal(out.skipped?.find(s => s.name === 'gonekid')?.reason, 'sessionFile-missing');
  assert.deepEqual(readLog(f.log), [], 'no pane is ever opened for a child without its transcript');
});

test('revive reads the registry across workspace scopes', async () => {
  // The controller may sit in a different workspace than the lost child: revive
  // scans every scope under the journal base, not just the caller's cwd.
  const f = fixture();
  const elsewhere = join(f.base, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  const out = JSON.parse((await execFile(process.execPath, [spawnCli, 'revive'], { cwd: elsewhere, env: f.env })).stdout) as ReviveResult;
  assert.deepEqual(out.revived?.map(r => r.name), ['gonekid']);
  const kid = readSpawns(spawnsFileFor(f.base, f.ws)).find(e => e.id === GONE)!;
  assert.equal(kid.paneId, out.revived![0].paneId, 'the record is patched in the scope that holds it');
});
