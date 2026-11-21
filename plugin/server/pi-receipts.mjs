// Shared reader for the experimental Pi receipt journal (see experiments/pi-receipt).
// The observer writes; the publisher may answer receipt.get frames from paired
// devices when HERDGATE_PI_RECEIPTS=1. Read-only, bounded, no network access here.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const MAX_BODY_BYTES = 64 * 1024; // served size cap for one archived reply

export const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPTS = 'receipts.jsonl';

/** Base directory holding one hashed sub-directory per Pi workspace. */
export function journalBase(env = process.env) {
  const override = env.HERDGATE_PI_RECEIPT_DIR;
  if (override) return override;
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'herdgate', 'pi-receipts');
}

export function scopeFor(cwd) {
  // Resolve symlinks before hashing (Paseo's import-matcher lesson): two panes
  // entering the same workspace through different link paths must share one
  // journal scope. Reads already scan every scope, so this only converges writes.
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* deleted cwd: keep the raw path */ }
  // Windows realpath preserves the caller's letter casing (D:\Bom vs d:\bom are
  // the same dir on NTFS), so converge scopes case-insensitively there — verified
  // live against the installed release on Windows (docs/herdr-skills validation).
  if (process.platform === 'win32') real = real.toLowerCase();
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

// The actor behind a request, on every event trail it touches (herdr-sched §3.1):
// schedule:<id> | job:<id> | device:<id> | human:<free-tag> — absent means a
// human typed it locally in a pane and nothing programmatic claims the request.
export const PRINCIPAL = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9._-]{1,64}$/;

// A receipt may carry an optional one-line title derived from the prompt
// (deriveTitle). It is prompt-derived content, so it lives under the strictest
// leak policy: stored in the host-local journal, never in publicReceipt unless
// the caller explicitly opts in with withTitle.
export const TITLE_MAX = 96;
const TITLE_CTRL = /[\u0000-\u001f\u007f]/; // no control characters (\n, \r, \t included)

function validTitle(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= TITLE_MAX
    && !TITLE_CTRL.test(value);
}

/**
 * First meaningful line of a prompt: drop the first line when it is the request
 * marker (`[herdr-request:…]`) or a scheduler wake frame (`[herdgate-schedule …]`),
 * take the first non-empty line, drop control characters, trim, cap at
 * TITLE_MAX. Returns '' when the prompt says nothing usable — title stays optional.
 */
export function deriveTitle(promptText) {
  const lines = String(promptText ?? '').split(/\r?\n/);
  const start = /^\[(herdr-request|herdgate-schedule)[^\]]*\]$/.test(lines[0].trim()) ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(TITLE_CTRL, ' ').replace(/\s+/g, ' ').trim();
    if (line) return line.slice(0, TITLE_MAX);
  }
  return '';
}

export function validEntry(entry) {
  return validEntryShape(entry) ? entry : null;
}

function validEntryShape(entry) {
  return Boolean(entry && entry.v === 1 && RECEIPT_ID.test(entry.id ?? '')
    && ['replied', 'failed', 'canceled', 'unknown'].includes(entry.status)
    && typeof entry.sessionId === 'string' && typeof entry.ts === 'number'
    && ['reason', 'requestEntryId', 'responseEntryId', 'paneId'].every(key => entry[key] === undefined || typeof entry[key] === 'string')
    && (entry.usage === undefined || (typeof entry.usage === 'object' && entry.usage !== null
      && Object.keys(entry.usage).length > 0
      && Object.keys(entry.usage).every(key => ['totalTokens', 'costUsd', 'durationMs'].includes(key))
      && Object.values(entry.usage).every(value => Number.isFinite(value)))
    && (entry.principal === undefined || PRINCIPAL.test(entry.principal)))
    && (entry.title === undefined || validTitle(entry.title)));
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

/** The public answer for a device: journal internals stay on the host.
 *  Title is prompt-derived text, so it is withheld by default (fail-safe) and
 *  only included when the caller explicitly passes withTitle: true. */
export function publicReceipt(entry, { withTitle = false } = {}) {
  if (!entry) return { status: 'unknown', reason: 'not_retained_in_runtime' };
  const { v, ts, sessionId, paneId, title, ...rest } = entry;
  return withTitle && title !== undefined ? { ...rest, title } : rest;
}

/**
 * Find the archived reply text for a request id across workspace scopes.
 * Writers archive bodies only when configured to retain the reply. The
 * served text is capped (truncated flags the cut). Exact id
 * only, no enumeration; unreadable -> null (fail closed).
 */
export function findBody(base, id) {
  if (!RECEIPT_ID.test(id ?? '')) return null;
  try {
    for (const name of readdirSync(base)) {
      if (!/^[0-9a-f]{16}$/.test(name)) continue;
      let fd;
      try {
        fd = openSync(join(base, name, 'responses', `${id}.md`), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(fd);
        if (!stat.isFile()) continue;
        const buf = Buffer.alloc(Math.min(stat.size, MAX_BODY_BYTES));
        let read = 0;
        while (read < buf.length) {
          const n = readSync(fd, buf, read, buf.length - read, null);
          if (!n) break;
          read += n;
        }
        if (read !== buf.length) continue; // archive changed while reading
        const truncated = stat.size > read;
        const data = buf.subarray(0, read);
        // For a capped reply, omit a final incomplete code point rather than substituting U+FFFD.
        const text = truncated ? new StringDecoder('utf8').write(data) : data.toString('utf8');
        return { text, truncated, bytes: stat.size };
      } catch { continue; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Watch every workspace journal under base and hand each NEW settle to onEntry
 * (unseen id, or a newer ts for a known id). The first scan is a baseline and
 * emits nothing, so a restarting publisher does not replay old receipts.
 * fs.watch (recursive where supported) gives low latency; a slow interval sweep
 * covers missed events and platforms without recursive watch. A missing base
 * directory just means the next sweep retries. Never throws to the caller.
 */
export function watchReceipts(base, onEntry, { intervalMs = 4000 } = {}) {
  let stopped = false;
  const seen = new Map(); // id -> ts
  let watcher = null;
  let timer = null;
  let sweepScheduled = false;
  const sweep = emit => {
    if (stopped) return;
    let scopes = [];
    try { scopes = readdirSync(base).filter(name => /^[0-9a-f]{16}$/.test(name)); }
    catch { /* base not created yet */ }
    for (const name of scopes) {
      let entries;
      try { entries = readJournal(join(base, name, RECEIPTS)); } catch { continue; }
      for (const entry of entries) {
        const prior = seen.get(entry.id);
        if (prior !== undefined && prior >= entry.ts) continue;
        seen.set(entry.id, entry.ts);
        if (emit) { try { onEntry(entry); } catch { /* listener errors must not kill the sweep */ } }
      }
    }
  };
  const ensureWatcher = () => {
    if (watcher || stopped) return;
    try {
      watcher = watch(base, { recursive: true }, () => {
        if (sweepScheduled || stopped) return;
        sweepScheduled = true;
        const late = setTimeout(() => { sweepScheduled = false; sweep(true); }, 250);
        late.unref?.();
      });
      watcher.on('error', () => { try { watcher?.close(); } catch { /* already closed */ } watcher = null; });
    } catch { /* base missing or unsupported here; the interval retries */ }
  };
  sweep(false); // baseline only
  ensureWatcher();
  timer = setInterval(() => {
    if (stopped) return;
    ensureWatcher();
    sweep(true);
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    try { watcher?.close(); } catch { /* already closed */ }
    if (timer) clearInterval(timer);
  };
}
