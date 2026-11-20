// Shared reader for the experimental Pi receipt journal (see experiments/pi-receipt).
// The observer writes; the publisher may answer receipt.get frames from paired
// devices when HERDGATE_PI_RECEIPTS=1. Read-only, bounded, no network access here.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

export const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPTS = 'receipts.jsonl';

/** Base directory holding one hashed sub-directory per Pi workspace. */
export function journalBase(env = process.env) {
  const override = env.HERDGATE_PI_RECEIPT_DIR;
  if (override) return override;
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'herdgate', 'pi-receipts');
}

export function scopeFor(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export function validEntry(entry) {
  return validEntryShape(entry) ? entry : null;
}

function validEntryShape(entry) {
  return Boolean(entry && entry.v === 1 && RECEIPT_ID.test(entry.id ?? '')
    && ['replied', 'failed', 'canceled', 'unknown'].includes(entry.status)
    && typeof entry.sessionId === 'string' && typeof entry.ts === 'number'
    && ['reason', 'requestEntryId', 'responseEntryId', 'paneId'].every(key => entry[key] === undefined || typeof entry[key] === 'string'));
}

/** Parse a journal file; tolerate a torn tail and skip corrupt lines. */
export function readJournal(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = raw.split('\n');
  lines.pop(); // the empty tail; a torn final line without \n drops with it
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (validEntry(entry)) entries.push(entry);
    } catch { /* skip */ }
  }
  return entries;
}

/**
 * Find the newest receipt for a request ID across workspace journals.
 * Lookup by exact UUID only — there is no enumeration. Returns null when the
 * journals are unreadable or the ID is unknown; callers fail closed.
 */
export function findReceipt(base, id) {
  if (!RECEIPT_ID.test(id ?? '')) return null;
  try {
    let found = null;
    for (const name of readdirSync(base)) {
      if (!/^[0-9a-f]{16}$/.test(name)) continue;
      for (const entry of readJournal(join(base, name, RECEIPTS))) {
        if (entry.id === id && (!found || entry.ts >= found.ts)) found = entry;
      }
    }
    return found;
  } catch {
    return null;
  }
}

/** The public answer for a device: journal internals stay on the host. */
export function publicReceipt(entry) {
  if (!entry) return { status: 'unknown', reason: 'not_retained_in_runtime' };
  const { v, ts, sessionId, paneId, ...rest } = entry;
  return rest;
}
