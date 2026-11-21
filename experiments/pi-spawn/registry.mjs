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
// Pi session ids are v7 (SDK-generated); receipt request ids are v4. Both are one-id
// chain material, so the registry accepts either shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function spawnsFileFor(base, cwd) {
  return join(base, scopeFor(cwd), 'spawns.jsonl');
}

export function spawnsFile(base) {
  return spawnsFileFor(base, process.cwd());
}

function valid(entry) {
  // Controller entries carry the pane they run in; self-registered ones (an agent
  // declaring its own parent, e.g. a worker job session) have no pane until restored.
  const paneOk = entry?.self === true
    ? (entry.paneId === undefined || PANE.test(entry.paneId))
    : PANE.test(entry?.paneId ?? '');
  return Boolean(entry && UUID.test(entry.id ?? '') && typeof entry.sessionId === 'string' && entry.sessionId
    && paneOk && SPAWN_NAME.test(entry.name ?? '')
    && (entry.parentSessionId === undefined || typeof entry.parentSessionId === 'string')
    && (entry.cwd === undefined || typeof entry.cwd === 'string')
    && (entry.sessionFile === undefined || typeof entry.sessionFile === 'string')
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

/** Record an agent declaring its OWN parent (no controller pane involved). */
export function recordSelf(base, self) {
  if (!self?.sessionId || !UUID.test(self.sessionId) || typeof self.parentSessionId !== 'string'
    || !self.parentSessionId || !SPAWN_NAME.test(self.name ?? '')) throw new Error('invalid_self');
  // One-id chain: a self-registered child serves as its own receipt request id.
  // Scoped to the workspace the child runs in, so a controller sitting there sees it.
  const spawn = { status: 'self', ...self, id: self.id ?? self.sessionId, self: true };
  if (!valid(spawn)) throw new Error('invalid_self');
  const file = spawnsFileFor(base, self.cwd ?? process.cwd());
  let entries = readSpawns(file).filter(entry => entry.id !== spawn.id);
  entries.push(spawn);
  if (entries.length > COMPACT_AT) entries = entries.slice(-MAX_SPAWNS);
  write(file, entries);
  return spawn;
}

export function spawnBase() {
  return journalBase(); // same override + scope rules as the receipt journal
}
