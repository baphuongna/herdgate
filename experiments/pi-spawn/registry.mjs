// Parent→child spawn registry for Herdgate-controlled Pi agents (experiment).
// One id serves the whole chain: receipt request id == Pi --session-id, so a
// controller knows the child's session identity the moment it spawns and can
// reopen it later with the same flag. Stores only ids/panes/status — no briefs.
//
// State hardening (miko-misa/herdr-portfwd state.rs lessons, deep/portfwd.md):
// - a damaged file never reads as empty: the reader throws with the FILE NAMED
//   (the StateError::Damaged refuse); callers warn and continue on the lines
//   that did parse instead of silently inventing a smaller registry;
// - writes are atomic through an O_EXCL temp with an unguessable name + rename
//   (a symlink planted at a guessable temp path must not be written through);
// - records sort by a stable key before every write, so the same set of records
//   serializes to byte-identical files across processes (diffable by a human);
// - spawnBase() refuses a base dir owned by another uid or writable by
//   group/others, naming the dir: registry records decide which panes get
//   closed, and a dir some other uid can write into is a takeover.
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** A damaged registry file. The message names the file — a corrupt line must
 *  never read as "no children" — and `.entries` carries the lines that DID
 *  parse, so a caller can warn and keep going on the valid portion. */
export class DamagedSpawnsError extends Error {
  constructor(file, bad, entries) {
    super(`spawns file ${file} is damaged: ${bad} unreadable line(s) — refusing to read it as if it were fine`);
    this.name = 'DamagedSpawnsError';
    this.file = file;
    this.bad = bad;
    this.entries = entries;
  }
}

/** Read one registry file. Missing file → [] (a fresh workspace is not damage).
 *  Any line that fails to parse or pass the schema → DamagedSpawnsError naming
 *  the file (the entwurf crash-don't-warn rule for malformed records). */
export function readSpawns(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (valid(parsed)) entries.push(parsed); else bad++;
  }
  if (bad > 0) throw new DamagedSpawnsError(file, bad, entries);
  return entries;
}

/** Warn-and-continue read for callers that must survive a damaged scope: prints
 *  the named error once, returns the valid records. Writers use this so one
 *  corrupt line compacts away on the next rewrite instead of blocking work. */
export function readSpawnsTolerant(file, warn = console.error) {
  try {
    return readSpawns(file);
  } catch (error) {
    if (error instanceof DamagedSpawnsError) {
      warn(`[spawn-registry] ${error.message}; continuing with ${error.entries.length} valid record(s)`);
      return error.entries;
    }
    throw error;
  }
}

// Byte-stable output (state.rs:471): dedupe by id happens at the call sites,
// the write sorts by (ts, id) so the same records always produce the same
// bytes regardless of which process or insertion order produced them.
const byStableKey = (a, b) =>
  a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

let tempSeq = 0;
function write(file, entries) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body = [...entries].sort(byStableKey).map(entry => JSON.stringify(entry)).join('\n') + '\n';
  // O_EXCL ('wx') + an unguessable name: a symlink somebody planted at a
  // guessable temp path cannot be written through (state.rs:700-718). The
  // rename then replaces the registry atomically — no window where it is gone.
  const tmp = `${file}.tmp-${process.pid}-${tempSeq++}-${randomBytes(8).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, body);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  } finally {
    try { closeSync(fd); } catch { /* already closed on the error path */ }
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
}

/** Record (or supersede) one spawn. The same id updates in place. */
export function recordSpawn(base, spawn) {
  if (!valid(spawn)) throw new Error('invalid_spawn');
  const file = spawnsFile(base);
  let entries = readSpawnsTolerant(file).filter(entry => entry.id !== spawn.id);
  entries.push({ status: 'running', ...spawn });
  if (entries.length > COMPACT_AT) entries = entries.slice(-MAX_SPAWNS);
  write(file, entries);
  return { status: 'running', ...spawn };
}

/** Patch one record by id (restore/retire); returns the updated record or null. */
export function updateSpawn(base, id, patch) {
  const file = spawnsFile(base);
  const entries = readSpawnsTolerant(file);
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

/** Find one record by id or name. A name can be shadowed by an orphan record
 *  (the 22/11 bug: a dead pane's newer record hid the live one), so when the
 *  caller passes the pane ids herdr still lists, a LIVE record wins over a
 *  newer orphan; ties and the no-liveness case resolve to the newest ts. An
 *  exact id is unique and never tie-broken. */
export function findSpawn(base, ref, livePaneIds = null) {
  const entries = readSpawnsTolerant(spawnsFile(base));
  const byId = entries.find(entry => entry.id === ref);
  if (byId) return byId;
  const named = entries.filter(entry => entry.name === ref);
  if (!named.length) return null;
  const live = livePaneIds ? new Set(livePaneIds) : null;
  const liveNamed = live ? named.filter(entry => entry.paneId && live.has(entry.paneId)) : [];
  const pool = liveNamed.length ? liveNamed : named;
  return pool.reduce((best, entry) => (best && best.ts >= entry.ts ? best : entry), null);
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
  let entries = readSpawnsTolerant(file).filter(entry => entry.id !== spawn.id);
  entries.push(spawn);
  if (entries.length > COMPACT_AT) entries = entries.slice(-MAX_SPAWNS);
  write(file, entries);
  return spawn;
}

export function spawnBase() {
  const base = journalBase(); // same override + scope rules as the receipt journal
  // state.rs:613-650: refuse a state dir another uid owns or that OTHERS can
  // write into — the dir is NAMED in the error, never hidden behind a generic
  // failure. Group-writable is the lenient direction the original teaches
  // (state.rs:655): a dir we own gets tightened in place; one that cannot be
  // tightened is refused exactly like a foreign dir. Without a POSIX uid/mode
  // model (non-POSIX platforms) there is nothing equivalent to check.
  if (typeof process.geteuid !== 'function') return base;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const meta = statSync(base);
  const me = process.geteuid();
  if (meta.uid !== me)
    throw new Error(`spawn dir ${base} belongs to uid ${meta.uid}, not uid ${me} — refusing to use it`);
  const mode = meta.mode & 0o777;
  if (mode & 0o002)
    throw new Error(`spawn dir ${base} has mode ${mode.toString(8).padStart(4, '0')} — others can write in it; refusing to use it`);
  if (mode & 0o020) {
    chmodSync(base, mode & ~0o020); // auto-tighten our own dir (state.rs:655)
    const after = statSync(base).mode & 0o777;
    if (after & 0o022)
      throw new Error(`spawn dir ${base} has mode ${after.toString(8).padStart(4, '0')} — group/others can write in it and it cannot be tightened; refusing to use it`);
  }
  return base;
}
