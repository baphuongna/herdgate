#!/usr/bin/env node
// DAG view for the Herdgate agent-spawn tree (experiment, NOT shipped).
// Prints the parent→child chain from the spawn registry, joined with each
// child's receipt status and a "checked" column — the herdr-dagr question:
// who ran, for how long, and who has verified the result. "checked" (✓) means
// a receipt exists AND no device still holds an unacknowledged watch intent
// for it (the durable watch store at base/watch.json); "○ pending-view" means
// someone is still waiting to be shown the result. Host-local, read-only,
// fail-closed: a missing base renders an empty tree / [].
//
//   node experiments/pi-spawn/dag.mjs [--base DIR] [--json]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { journalBase, readJournal } from '../../plugin/server/pi-receipts.mjs';
import { openWatchStore } from '../../plugin/server/pi-receipt-watch.mjs';
import { readAllSpawns } from '../../plugin/server/pi-wake.mjs';

const SCOPE = /^[0-9a-f]{16}$/;
const TITLE_WIDTH = 40;

/** Newest receipt per child session, across every workspace scope. */
function receiptsBySession(base) {
  const bySession = new Map();
  let scopes = [];
  try { scopes = readdirSync(base).filter(name => SCOPE.test(name)); }
  catch { return bySession; } // base missing: no receipts, fail closed
  for (const scope of scopes) {
    for (const entry of readJournal(join(base, scope, 'receipts.jsonl'))) {
      if (!entry.sessionId) continue;
      const prior = bySession.get(entry.sessionId);
      if (!prior || entry.ts >= prior.ts) bySession.set(entry.sessionId, entry);
    }
  }
  return bySession;
}

/** Request ids some device still waits on (watch store: base/watch.json, not per-scope). */
function pendingIds(base) {
  try { return new Set(openWatchStore(base).pendingAll().map(sub => sub.requestId)); }
  catch { return new Set(); }
}

const oneLine = (text, width) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, width);
const byTs = (a, b) => (a.ts ?? 0) - (b.ts ?? 0);

/** The forest: one node per spawn, children nested under their parent session. */
export function buildTree(base) {
  // One record per id (re-record/restore reuses ids): newest ts wins.
  const byId = new Map();
  for (const spawn of readAllSpawns(base)) {
    const prior = byId.get(spawn.id);
    if (!prior || (spawn.ts ?? 0) >= (prior.ts ?? 0)) byId.set(spawn.id, spawn);
  }
  const records = [...byId.values()];
  const receipts = receiptsBySession(base);
  const pending = pendingIds(base);

  const childrenOf = new Map(); // parentSessionId -> child spawns
  const knownSessions = new Set(records.map(spawn => spawn.sessionId));
  const roots = [];
  for (const spawn of records) {
    if (spawn.parentSessionId && knownSessions.has(spawn.parentSessionId)) {
      const list = childrenOf.get(spawn.parentSessionId) ?? [];
      list.push(spawn);
      childrenOf.set(spawn.parentSessionId, list);
    } else {
      roots.push(spawn); // no parent declared, or the parent is the (unregistered) root controller
    }
  }

  const node = (spawn, seen) => {
    const receipt = receipts.get(spawn.sessionId) ?? null;
    return {
      name: spawn.name,
      id: spawn.id,
      sessionId: spawn.sessionId,
      status: receipt?.status ?? 'no-receipt',
      title: receipt?.title ? oneLine(receipt.title, TITLE_WIDTH) : null,
      principal: receipt?.principal ?? null,
      // checked: true = settled and acked everywhere, false = a device still pending, null = no receipt yet
      checked: receipt ? !pending.has(receipt.id) : null,
      children: seen.has(spawn.sessionId) ? [] // corrupted cycle: cut, never loop
        : (childrenOf.get(spawn.sessionId) ?? []).sort(byTs)
          .map(child => node(child, new Set(seen).add(spawn.sessionId))),
    };
  };
  return roots.sort(byTs).map(spawn => node(spawn, new Set()));
}

function renderText(nodes) {
  const lines = [];
  const walk = (node, depth) => {
    const bits = [`${node.name} [${String(node.id).slice(0, 8)}] ${node.status}`];
    if (node.principal) bits.push(` (${node.principal})`);
    if (node.title) bits.push(` — ${node.title}`);
    if (node.checked === true) bits.push(' ✓');
    else if (node.checked === false) bits.push(' ○ pending-view');
    lines.push(`${'  '.repeat(depth)}${bits.join('')}`);
    node.children.forEach(child => walk(child, depth + 1));
  };
  nodes.forEach(node => walk(node, 0));
  return lines;
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const base = flag('base') ?? journalBase(); // spawns live beside the receipts, same base
try {
  const tree = buildTree(base);
  if (args.includes('--json')) console.log(JSON.stringify(tree, null, 2));
  else {
    const lines = renderText(tree);
    if (lines.length) console.log(lines.join('\n'));
  }
} catch {
  if (args.includes('--json')) console.log('[]'); // unreadable base: fail closed, exit 0
}
