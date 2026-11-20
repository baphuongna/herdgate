// Shared writer for the experimental Pi receipt journal (see experiments/pi-receipt).
// Extracted from the observer so the pi-worker experiment (experiments/pi-worker)
// can append the exact same per-workspace format. No network access here.
import { appendFileSync, mkdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal, scopeFor } from '../../plugin/server/pi-receipts.mjs';

export const MAX_JOURNAL = 200;   // receipts kept per workspace
export const COMPACT_AT = 300;    // rewrite the journal once past this size

/** Create (0700) the workspace scope directory and return its journal path. */
export function openScope(base, cwd) {
  const dir = join(base, scopeFor(cwd));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'receipts.jsonl');
}

export function loadJournal(file) {
  const entries = readJournal(file);
  return { entries, receipts: new Map(entries.map(entry => [entry.id, entry])) };
}

/**
 * Append one receipt. Returns the map to keep — it may be a compacted copy once
 * the in-memory map passes COMPACT_AT. Throws on I/O failure; callers fail closed.
 */
export function appendReceipt(file, receipts, entry) {
  receipts.set(entry.id, entry);
  if (receipts.size <= COMPACT_AT) {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return receipts;
  }
  const keep = [...receipts.entries()].slice(-MAX_JOURNAL);
  compact(file, keep.map(([, kept]) => kept));
  return new Map(keep);
}

export function compact(file, entries) {
  const lock = `${file}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs < 120_000) return; // another runtime is compacting
      rmSync(lock, { recursive: true, force: true });            // stale lock
      mkdirSync(lock, { mode: 0o700 });
    } catch { return; }
  }
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    rmSync(file, { force: true });
    renameSync(tmp, file);
  } finally {
    try { rmdirSync(lock); } catch { /* already gone */ }
  }
}
