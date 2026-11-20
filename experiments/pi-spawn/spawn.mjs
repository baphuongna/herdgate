#!/usr/bin/env node
// Herdgate agent-spawn helper (experiment, NOT shipped). Answers the controller
// needs Herdr/Pi do not cover natively: when a child Pi agent is spawned its
// session identity is decided HERE (one uuid = receipt request id = Pi
// --session-id), the parent↔child link is journaled beside the receipts, and a
// closed pane reopens with one command using the same --session-id flag.
//
//   node experiments/pi-spawn/spawn.mjs spawn <name> [--cwd DIR] [--parent-session ID] [-- extra pi args]
//   node experiments/pi-spawn/spawn.mjs list
//   node experiments/pi-spawn/spawn.mjs restore <name-or-id>
//
// spawn: splits a sibling pane (from HERDR_PANE_ID when inside Herdr), starts a
// fresh Pi agent with the pre-assigned session id, verifies the pane binding,
// records { id, sessionId, paneId, parentSessionId, cwd } in spawns.jsonl.
// restore: opens the SAME session in a new pane via -- --session-id (idempotent).
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findSpawn, recordSpawn, readSpawns, spawnBase, spawnsFile, updateSpawn } from './registry.mjs';

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
  if (!name) fail('usage: spawn <name> [--cwd DIR] [--parent-session ID] [-- extra pi args]');
  const cwd = flag('cwd', process.cwd());
  const extras = (() => { const i = process.argv.indexOf('--'); return i > 0 ? process.argv.slice(i + 1) : []; })();
  const { myPane, parentSessionId } = myBinding();
  const parent = flag('parent-session', parentSessionId);
  const id = randomUUID(); // one id: receipt request == Pi session
  const splitArgs = myPane
    ? ['pane', 'split', '--pane', myPane, '--direction', 'right', '--no-focus', '--cwd', cwd]
    : ['pane', 'split', '--current', '--direction', 'right', '--no-focus', '--cwd', cwd];
  const pane = run(...splitArgs).result.pane.pane_id;
  try {
    run('agent', 'start', name, '--kind', 'pi', '--pane', pane, '--timeout', '45000',
      '--', '--session-id', id, ...extras);
  } catch (error) {
    fail(`agent start failed: ${String(error.message).slice(0, 300)}`);
  }
  const entry = recordSpawn(spawnBase(), { id, sessionId: id, paneId: pane, name,
    ...(parent ? { parentSessionId: parent } : {}), cwd, ts: Date.now() });
  console.log(JSON.stringify({ ...entry, parent: parent ?? null,
    bound: bindingOf(run('pane', 'list').result.panes ?? [], pane) === id }));
} else if (command === 'list') {
  const { panes } = myBinding();
  const rows = readSpawns(spawnsFile(spawnBase())).map(e => ({
    name: e.name, id: e.id, pane: e.paneId, status: e.status,
    live: panes.some(p => p.pane_id === e.paneId) ? 'attached' : 'gone',
    parent: (e.parentSessionId ?? '').slice(0, 8) || null, ts: e.ts,
  }));
  console.log(JSON.stringify(rows, null, 2));
} else if (command === 'restore') {
  if (!arg) fail('usage: restore <name-or-id>');
  const entry = findSpawn(spawnBase(), arg);
  if (!entry) fail(`no spawn record for ${arg}`);
  const { myPane } = myBinding();
  const splitArgs = myPane
    ? ['pane', 'split', '--pane', myPane, '--direction', 'right', '--no-focus', '--cwd', entry.cwd ?? process.cwd()]
    : ['pane', 'split', '--current', '--direction', 'right', '--no-focus', '--cwd', entry.cwd ?? process.cwd()];
  const pane = run(...splitArgs).result.pane.pane_id;
  try {
    run('agent', 'start', entry.name, '--kind', 'pi', '--pane', pane, '--timeout', '45000',
      '--', '--session-id', entry.sessionId);
  } catch (error) {
    fail(`agent start failed: ${String(error.message).slice(0, 300)}`);
  }
  const updated = updateSpawn(spawnBase(), entry.id, { status: 'restored', paneId: pane, restoredAt: Date.now() });
  console.log(JSON.stringify({ ...updated, bound: bindingOf(run('pane', 'list').result.panes ?? [], pane) === entry.sessionId }));
} else {
  fail('usage: spawn.mjs spawn|list|restore ...');
}
