// Parent→child spawn registry for Herdgate-controlled Pi agents (experiment).
// One id serves the whole chain: receipt request id == Pi --session-id, so a
// controller knows the child's session identity the moment it spawns and can
// reopen it later with the same flag. Stores only ids/panes/status — no briefs.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { journalBase, scopeFor } from '../../plugin/server/pi-receipts.mjs';

export const MAX_SPAWNS = 200;
export const COMPACT_AT = 300;
export const SPAWN_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PANE = /^[\w:.-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function spawnsFile(base) {
  return join(base, scopeFor(process.cwd()), 'spawns.jsonl');
}

function valid(entry) {
  return Boolean(entry && UUID.test(entry.id ?? '') && typeof entry.sessionId === 'string' && entry.sessionId
    && PANE.test(entry.paneId ?? '') && SPAWN_NAME.test(entry.name ?? '')
    && (entry.parentSessionId === undefined || typeof entry.parentSessionId === 'string')
    && (entry.cwd === undefined || typeof entry.cwd === 'string')
    && Number.isFinite(entry.ts));
}

export function readSpawns(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch { return []; }
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(valid);
}

function write(file, entries) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  rmSync(file, { force: true });
  renameSync(tmp, file);
}

/** Record (or supersede) one spawn. The same id updates in place. */
export function recordSpawn(base, spawn) {
  if (!valid(spawn)) throw new Error('invalid_spawn');
  const file = spawnsFile(base);
  let entries = readSpawns(file).filter(entry => entry.id !== spawn.id);
  entries.push({ status: 'running', ...spawn });
  if (entries.length > COMPACT_AT) entries = entries.slice(-MAX_SPAWNS);
  write(file, entries);
  return { status: 'running', ...spawn };
}

/** Patch one record by id (restore/retire); returns the updated record or null. */
export function updateSpawn(base, id, patch) {
  const file = spawnsFile(base);
  const entries = readSpawns(file);
  let updated = null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id !== id) continue;
    entries[i] = { ...entries[i], ...patch };
    updated = entries[i];
  }
  if (!updated) return null;
  write(file, entries);
  return updated;
}

export function findSpawn(base, ref) {
  const entries = readSpawns(spawnsFile(base));
  return entries.find(e => e.id === ref || e.name === ref) ?? null;
}

export function spawnBase() {
  return journalBase(); // same override + scope rules as the receipt journal
}
