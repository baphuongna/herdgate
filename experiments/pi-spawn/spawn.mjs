#!/usr/bin/env node
// Herdgate agent-spawn helper (experiment, NOT shipped). Answers the controller
// needs Herdr/Pi do not cover natively: when a child Pi agent is spawned its
// session identity is decided HERE (one uuid = receipt request id = Pi
// --session-id), the parent↔child link is journaled beside the receipts, and a
// closed pane reopens with one command using the same --session-id flag.
//
//   node experiments/pi-spawn/spawn.mjs spawn <name> [--cwd DIR] [--tab] [--parent-session ID] [-- extra pi args]
//   node experiments/pi-spawn/spawn.mjs self --parent <id> --name <n> [--cwd DIR] [--id UUID]
//   node experiments/pi-spawn/spawn.mjs arm <name-or-id> [--body]   # /herdgate-arm with THE spawn id
//   node experiments/pi-spawn/spawn.mjs list                        # + receipt status per child
//   node experiments/pi-spawn/spawn.mjs restore <name-or-id>
//
// spawn: splits a sibling pane stacked below (full width; side-by-side splits
// wrap JSON notifications mid-token), or --tab gives the child its own tab;
// starts a fresh Pi agent with the pre-assigned session id, verifies the pane
// binding, records { id, sessionId, paneId, parentSessionId, cwd } in spawns.jsonl.
// restore: opens the SAME session (own tab again for --tab children) via
// -- --session-id (idempotent). Tests default to the machine model; pass e.g.
// -- --thinking low for fast turns.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findSpawn, recordSelf, recordSpawn, readSpawns, spawnBase, spawnsFile, updateSpawn } from './registry.mjs';
import { findReceipt } from '../../plugin/server/pi-receipts.mjs';
import { patchSpawn } from '../../plugin/server/pi-wake.mjs';

const herdr = () => process.env.HERDR_BIN_PATH || 'herdr';
const run = (...args) => JSON.parse(execFileSync(herdr(), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const command = process.argv[2];
const arg = process.argv[3];

function myBinding() {
  const panes = run('pane', 'list').result.panes ?? [];
  const mine = process.env.HERDR_ENV === '1' ? panes.find(p => p.pane_id === process.env.HERDR_PANE_ID) : null;
  const file = mine?.agent_session?.value;
  const parentSessionId = file ? (file.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? null) : null;
  return { myPane: mine?.pane_id ?? null, parentSessionId, panes };
}

function bindingOf(panes, paneId) {
  const file = panes.find(p => p.pane_id === paneId)?.agent_session?.value;
  return file ? (file.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? null) : null;
}

const fail = (message) => { console.error(message); process.exit(1); };

if (command === 'spawn') {
  const name = arg;
  if (!name) fail('usage: spawn <name> [--cwd DIR] [--tab] [--parent-session ID] [-- extra pi args]');
  const cwd = flag('cwd', process.cwd());
  const wantTab = process.argv.includes('--tab');
  const extras = (() => { const i = process.argv.indexOf('--'); return i > 0 ? process.argv.slice(i + 1) : []; })();
  const { myPane, parentSessionId } = myBinding();
  const parent = flag('parent-session', parentSessionId);
  const id = randomUUID(); // one id: receipt request == Pi session
  // Stacked split keeps full terminal width (side-by-side wraps notifications mid-JSON).
  // --tab gives the child its own tab instead — zero impact on the caller's layout.
  const pane = wantTab
    ? run('tab', 'create', '--label', `hg-${name}`, '--no-focus', '--cwd', cwd).result.root_pane.pane_id
    : run(...(myPane
      ? ['pane', 'split', '--pane', myPane, '--direction', 'down', '--no-focus', '--cwd', cwd]
      : ['pane', 'split', '--current', '--direction', 'down', '--no-focus', '--cwd', cwd])).result.pane.pane_id;
  try {
    run('agent', 'start', name, '--kind', 'pi', '--pane', pane, '--timeout', '45000',
      '--', '--session-id', id, ...extras);
  } catch (error) {
    fail(`agent start failed: ${String(error.message).slice(0, 300)}`);
  }
  const entry = recordSpawn(spawnBase(), { id, sessionId: id, paneId: pane, name,
    ...(wantTab ? { tab: true } : {}),
    ...(parent ? { parentSessionId: parent, ...(myPane ? { parentPaneId: myPane } : {}) } : {}), cwd, ts: Date.now() });
  console.log(JSON.stringify({ ...entry, parent: parent ?? null,
    bound: bindingOf(run('pane', 'list').result.panes ?? [], pane) === id }));
} else if (command === 'self') {
  // An agent declares its own parent (the pi-durable ownership edge, herdgate-style):
  // worker job sessions and SDK-spawned children register themselves, so the registry
  // covers every live child — not only ones a controller pane-split.
  const parent = flag('parent');
  const name = flag('name');
  if (!parent || !name) fail('usage: self --parent <session-id> --name <name> [--cwd DIR] [--id UUID]');
  const { parentSessionId } = myBinding();
  const id = flag('id') ?? parentSessionId;
  if (!id) fail('could not resolve this pane\'s session id — pass --id <uuid>');
  const entry = recordSelf(spawnBase(), { sessionId: id, parentSessionId: parent, name,
    cwd: flag('cwd', process.cwd()), ts: Date.now() });
  console.log(JSON.stringify({ ...entry, registered: 'self' }));
} else if (command === 'arm') {
  if (!arg) fail('usage: arm <name-or-id> [--body]');
  const entry = findSpawn(spawnBase(), arg);
  if (!entry) fail(`no spawn record for ${arg}`);
  const { panes } = myBinding();
  if (!panes.some(p => p.pane_id === entry.paneId)) fail(`pane ${entry.paneId} is gone — restore first`);
  const wantBody = process.argv.includes('--body');
  const agent = run('agent', 'get', entry.paneId).result.agent;
  if (agent?.agent_status !== 'idle') fail(`agent is ${agent?.agent_status ?? 'unknown'} — arm when idle`);
  // Handshake, not hope: the arm is REAL only when the child's observer writes
  // its ack file — polled here (timeout 15s / 250ms interval) instead of racing
  // pane text, so the marked prompt can never land before the armed baseline
  // exists (the live spawn→arm→prompt race that killed six observers).
  const ackFile = join(spawnBase(), `${entry.id}.armed.json`);
  try { rmSync(ackFile, { force: true }); } catch { /* best effort: a stale ack must not fake this handshake */ }
  execFileSync(herdr(), ['pane', 'run', entry.paneId, `/herdgate-arm --id ${entry.id} --principal spawn:${entry.id}${wantBody ? ' --body' : ''}`], { stdio: 'ignore' });
  const timeoutMs = Number(process.env.HERDGATE_ARM_ACK_TIMEOUT_MS) > 0
    ? Number(process.env.HERDGATE_ARM_ACK_TIMEOUT_MS) : 15_000;
  const deadline = Date.now() + timeoutMs;
  let ack = null;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(ackFile, 'utf8'));
      if (parsed?.id === entry.id) { ack = parsed; break; }
    } catch { /* not acknowledged yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ack) fail(`no arm ack within ${Math.round(timeoutMs / 1000)}s — the child never confirmed activation of ${entry.id}; check its pane before prompting`);
  console.log(JSON.stringify({ id: entry.id, status: 'armed', pane: entry.paneId, ackAt: ack.at,
    marker: `[herdr-request:${entry.id}]`, retainBody: wantBody }));
} else if (command === 'list') {
  const { panes } = myBinding();
  const rows = readSpawns(spawnsFile(spawnBase())).map(e => ({
    name: e.name, id: e.id, pane: e.paneId ?? null, status: e.status,
    live: e.paneId ? (panes.some(p => p.pane_id === e.paneId) ? 'attached' : 'gone') : (e.self ? 'self' : 'gone'),
    receipt: findReceipt(spawnBase(), e.id)?.status ?? 'none',
    parent: (e.parentSessionId ?? '').slice(0, 8) || null, ts: e.ts,
  }));
  console.log(JSON.stringify(rows, null, 2));
} else if (command === 'close') {
  // The parent owns its children's lifecycle: after a settle is handled and no
  // further job is planned, close the child — tabs must not accumulate. The
  // registry record survives (restore reopens the same one-id session), and a
  // working child is refused: its wake has not arrived yet.
  if (!arg) fail('usage: close <name-or-id>');
  const entry = findSpawn(spawnBase(), arg);
  if (!entry) fail(`no spawn record for ${arg}`);
  const { panes } = myBinding();
  const pane = panes.find(p => p.pane_id === entry.paneId);
  if (!pane) {
    console.log(JSON.stringify({ id: entry.id, name: entry.name, closed: null, reason: 'already_gone',
      restore: `node experiments/pi-spawn/spawn.mjs restore ${entry.name}` }));
    process.exit(0);
  }
  const agent = run('agent', 'get', entry.paneId).result.agent;
  if (agent?.agent_status === 'working') fail(`agent is working — wait for its wake, then close`);
  const kind = entry.tab && pane.tab_id ? 'tab' : 'pane';
  const target = kind === 'tab' ? pane.tab_id : entry.paneId;
  // Mark BEFORE the pane closes: an intentional close must never read as a
  // death — the publisher's death watch skips records closedBy their parent.
  const marked = patchSpawn(spawnBase(), entry.id, { closedBy: 'parent', closedAt: Date.now() });
  run(kind === 'tab' ? 'tab' : 'pane', 'close', target);
  console.log(JSON.stringify({ id: entry.id, name: entry.name, closed: target, kind,
    closedBy: marked ? 'parent' : null,
    restore: `node experiments/pi-spawn/spawn.mjs restore ${entry.name}` }));
} else if (command === 'restore') {
  if (!arg) fail('usage: restore <name-or-id>');
  const entry = findSpawn(spawnBase(), arg);
  if (!entry) fail(`no spawn record for ${arg}`);
  const { myPane } = myBinding();
  const dir = entry.cwd ?? process.cwd();
  // A tab-spawned child restores into its own tab again; a split child stacks below.
  // A self-registered child (worker job) has no pane lineage — its own tab avoids
  // borrowing any caller's pane.
  const wantTab = entry.tab || entry.self;
  const pane = wantTab
    ? run('tab', 'create', '--label', `hg-${entry.name}`, '--no-focus', '--cwd', dir).result.root_pane.pane_id
    : run(...(myPane
      ? ['pane', 'split', '--pane', myPane, '--direction', 'down', '--no-focus', '--cwd', dir]
      : ['pane', 'split', '--current', '--direction', 'down', '--no-focus', '--cwd', dir])).result.pane.pane_id;
  // A transcript file path reopens the exact session (worker children live outside
  // Pi's default storage; a bare --session-id would mint an empty look-alike).
  // If a self-registered child's transcript is GONE, refuse: an empty look-alike
  // with the same id is worse than a clear error.
  if (entry.self && entry.sessionFile && !existsSync(entry.sessionFile))
    fail(`transcript ${entry.sessionFile} is gone — cannot restore an SDK child without it`);
  const sessionArgs = entry.sessionFile && existsSync(entry.sessionFile)
    ? ['--session', entry.sessionFile] : ['--session-id', entry.sessionId];
  try {
    run('agent', 'start', entry.name, '--kind', 'pi', '--pane', pane, '--timeout', '45000',
      '--', ...sessionArgs);
  } catch (error) {
    fail(`agent start failed: ${String(error.message).slice(0, 300)}`);
  }
  const updated = updateSpawn(spawnBase(), entry.id, { status: 'restored', paneId: pane, restoredAt: Date.now() });
  console.log(JSON.stringify({ ...updated, bound: bindingOf(run('pane', 'list').result.panes ?? [], pane) === entry.sessionId }));
} else {
  fail('usage: spawn.mjs spawn|list|restore ...');
}
