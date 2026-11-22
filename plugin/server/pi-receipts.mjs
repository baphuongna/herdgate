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

// Send-path delivery (chat.md useDelivery.ts:120-220 — the transport-vs-app
// flag, seen from the host side): `delivered` = the host acknowledged the
// prompt, `stalled` = the transport reported a stall after the host saw it,
// `unverified` = sent with no acknowledgement. Only the sending transport can
// observe a stall; the journal writer records what IT observed.
export const DELIVERY = new Set(['delivered', 'stalled', 'unverified']);
// Failure phase (mobrel coordinator.go:884 + socket_api.go:157 — "how many
// bytes reached the socket" as the boundary): `failed_before_dispatch` = the
// fail happened before the request reached the provider (retry-safe
// knowledge), `dispatch` = dispatched with the outcome still unknown,
// `settled` = a final outcome (replied, failed, canceled).
export const PHASE = new Set(['dispatch', 'settled', 'failed_before_dispatch']);
// A machine-readable error is bounded like mobrel's ApiError (protocol.go:324):
// code ≤64 chars, ≤8 args, each string ≤256, total JSON ≤1024. Free-text
// diagnostics never qualify — without a mappable code there is no error field.
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_ARGS_MAX = 8;
const ERROR_STRING_MAX = 256;
const ERROR_JSON_MAX = 1024;

export function validError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  if (Object.keys(error).some(key => key !== 'code' && key !== 'args')) return false;
  if (typeof error.code !== 'string' || !ERROR_CODE.test(error.code)) return false;
  if (error.args !== undefined) {
    if (typeof error.args !== 'object' || error.args === null || Array.isArray(error.args)) return false;
    const keys = Object.keys(error.args);
    if (keys.length > ERROR_ARGS_MAX) return false;
    if (!keys.every(key => {
      const value = error.args[key];
      return typeof value === 'string' ? value.length <= ERROR_STRING_MAX
        : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean';
    })) return false;
  }
  return JSON.stringify(error).length <= ERROR_JSON_MAX;
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
    && (entry.delivery === undefined || DELIVERY.has(entry.delivery))
    && (entry.phase === undefined || PHASE.has(entry.phase))
    && (entry.error === undefined || validError(entry.error))
    && (entry.title === undefined || validTitle(entry.title))
    && (entry.turns === undefined || (typeof entry.turns === 'number' && Number.isInteger(entry.turns) && entry.turns >= 0))
    && (entry.lastActivityAt === undefined || (typeof entry.lastActivityAt === 'number' && Number.isFinite(entry.lastActivityAt))));
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
 *  only included when the caller explicitly passes withTitle: true. Measured
 *  activity counters (`turns`, `lastActivityAt`) are a count and a timestamp —
 *  no conversation content — so they pass through whenever the entry has them. */
export function publicReceipt(entry, { withTitle = false } = {}) {
  if (!entry) return { status: 'unknown', reason: 'not_retained_in_runtime' };
  const { v, ts, sessionId, paneId, title, error, ...rest } = entry;
  // `error` is host-side diagnostics and never leaves the host; devices get
  // the delivery/phase metadata instead. Legacy journals predate both fields:
  // a responseEntryId is itself a delivery proof, so it maps to `delivered` —
  // anything else stays absent rather than guessed.
  const shown = withTitle && title !== undefined ? { ...rest, title } : { ...rest };
  if (shown.delivery === undefined && entry.responseEntryId !== undefined) shown.delivery = 'delivered';
  return shown;
}

/** True when the receipt has not seen activity for longer than staleAfterMs.
 *  Only an observed `lastActivityAt` can say so: an entry without the field
 *  predates the counter (or was written without transcript access), and the
 *  difference is UNKNOWN, not stale — no guessing, fail closed to false. */
export function isStale(entry, now = Date.now(), staleAfterMs = 30 * 60e3) {
  if (!entry || typeof entry.lastActivityAt !== 'number' || !Number.isFinite(entry.lastActivityAt)) return false;
  return now - entry.lastActivityAt > staleAfterMs;
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
 * (unseen id, or a newer ts for a known id). Two copies of one id inside a
 * single sweep collapse to its newest copy — one emit, never two. The first
 * scan is a baseline and emits nothing, so a restarting publisher does not
 * replay old receipts.
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
    // Mailbox newer-of-two (usage.md refresh.rs:326-344 provider_snapshot_for_display):
    // one sweep can observe two copies of the same id — an event writer and a
    // poll writer racing on one mailbox. Gather everything from every scope,
    // order by (id, ts), and keep only each id's newest copy, so a single sweep
    // emits an id at most once and always the newest copy, never both.
    const rows = [];
    for (const name of scopes) {
      let entries;
      try { entries = readJournal(join(base, name, RECEIPTS)); } catch { continue; }
      rows.push(...entries);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.ts - b.ts));
    const newest = rows.filter((entry, i) => i + 1 === rows.length || rows[i + 1].id !== entry.id);
    newest.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    for (const entry of newest) {
      const prior = seen.get(entry.id);
      if (prior !== undefined && prior >= entry.ts) continue;
      seen.set(entry.id, entry.ts);
      if (emit) { try { onEntry(entry); } catch { /* listener errors must not kill the sweep */ } }
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
