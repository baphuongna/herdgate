// Journal GC for the experimental Pi receipt journal (see experiments/pi-receipt).
// "The Luggage" school of retention: eat everything past its days, keep what
// might still matter. Fail-closed like every other journal reader — an entry
// whose status is 'unknown' is evidence not yet understood, so it is ALWAYS
// kept; a scope that cannot be read is reported, never thrown; a watch store
// that cannot be parsed is never rewritten. Dry-run by default: nothing is
// written unless apply: true, and even then every rewrite is tmp+rename.

import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_ID, readJournal } from './pi-receipts.mjs';
import { watchFile } from './pi-receipt-watch.mjs';

const SCOPE = /^[0-9a-f]{16}$/; // one hashed dir per Pi workspace
const RECEIPTS = 'receipts.jsonl';
const DAY_MS = 86400e3;
const DEVICE = /^[\w.-]{1,64}$/; // same shape the watch store validates

/**
 * The durable watch intents at base/watch.json are the only "cursors" over the
 * journals (requestId -> receipt id). Missing file: no references. Unreadable
 * or corrupt file: no references AND never rewritten (fail-closed — apply must
 * not destroy intents it could not read).
 */
function loadCursors(base) {
  const file = watchFile(base);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    return { subs: [], file, writable: false, broken: error.code !== 'ENOENT' };
  }
  const list = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  const subs = list.filter(s => DEVICE.test(s?.device ?? '') && RECEIPT_ID.test(s?.requestId ?? '')
    && typeof s.wantBody === 'boolean' && Number.isFinite(s.createdAt) && Number.isFinite(s.expiresAt));
  return { subs, file, writable: true };
}

/** Same atomic-private pattern as the journal writer (experiments/pi-receipt/journal.mjs). */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  rmSync(file, { force: true });
  renameSync(tmp, file);
}

/**
 * Sweep every workspace scope under base and collect receipts older than
 * `days` for deletion — except:
 *  - status 'unknown' (fail-closed: unclear evidence is always kept), and
 *  - receipts still referenced by a watch intent (a device may still be
 *    waiting to be shown the result).
 * Body archives (responses/<id>.md) of deleted receipts join the candidates;
 * their bytes fold into the receipt's candidate bytes. Watch intents pointing
 * at ids no journal holds anymore are orphan cursors, reported always and
 * removed only on apply. Never throws; unreadable scopes land in report.errors.
 *
 * apply=false returns { scopes, candidates, orphanCursors, bytesReclaimable,
 * keptUnknown, errors } and touches nothing. apply=true additionally rewrites
 * each affected journal without the deleted entries (tmp+rename), removes the
 * archived bodies, retires orphan cursors, and adds { applied, deleted,
 * bytesFreed } to the report.
 */
export function gcJournal({ base, days = 90, now = Date.now(), apply = false } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  const span = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 90;
  const cutoff = at - span * DAY_MS;

  const report = {
    scopes: 0,          // scope dirs successfully read
    candidates: [],     // {id, scope, ts, status, bytes} — bytes = journal line + body archive
    orphanCursors: [],  // {device, requestId}
    bytesReclaimable: 0,
    keptUnknown: 0,     // old entries kept because their status is unknown
    errors: [],         // {scope, code}
  };

  let names = [];
  try { names = readdirSync(base).filter(name => SCOPE.test(name)).sort(); }
  catch (error) {
    report.errors.push({ scope: null, code: error.code ?? 'unreadable_base' });
    return report; // nothing can be read, nothing will be written
  }

  const byScope = new Map(); // scope -> entries (validated by readJournal)
  for (const name of names) {
    try {
      byScope.set(name, readJournal(join(base, name, RECEIPTS)));
      report.scopes += 1;
    } catch (error) {
      report.errors.push({ scope: name, code: error.code ?? 'unreadable_scope' });
    }
  }

  const cursors = loadCursors(base);
  if (cursors.broken) report.errors.push({ scope: 'watch', code: 'unreadable_watch' });
  const referenced = new Set(cursors.subs.map(sub => sub.requestId));

  const allIds = new Set(); // every receipt id any journal holds (post-scan)
  for (const entries of byScope.values()) for (const entry of entries) allIds.add(entry.id);

  // Pass 1 — pick deletion candidates per entry, keeping the fail-closed set.
  const keptIds = new Set();            // ids that must survive somewhere
  const delByScope = new Map();         // scope -> Set<id to drop>
  const lineBytes = new Map();          // "scope\0id" -> journal-line bytes
  for (const [scope, entries] of byScope) {
    for (const entry of entries) {
      const old = entry.ts < cutoff;
      if (old && entry.status === 'unknown') {
        report.keptUnknown += 1;
        keptIds.add(entry.id);
        continue;
      }
      if (old && !referenced.has(entry.id)) {
        const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1; // line + \n
        report.candidates.push({ id: entry.id, scope, ts: entry.ts, status: entry.status, bytes });
        lineBytes.set(`${scope}\0${entry.id}`, bytes);
        const ids = delByScope.get(scope) ?? new Set();
        ids.add(entry.id);
        delByScope.set(scope, ids);
      } else {
        keptIds.add(entry.id); // fresh, or still referenced by a watch intent
      }
    }
  }

  // Pass 2 — archived bodies of deleted receipts (the writer files them in the
  // same scope). A body stays when any surviving receipt elsewhere owns the id.
  const bodyFiles = []; // {id, scope, path, size}
  for (const candidate of report.candidates) {
    if (keptIds.has(candidate.id)) continue;
    const path = join(base, candidate.scope, 'responses', `${candidate.id}.md`);
    try {
      const size = statSync(path).size;
      candidate.bytes += size;
      bodyFiles.push({ id: candidate.id, scope: candidate.scope, path, size });
    } catch { /* no retained body: fine */ }
  }

  report.orphanCursors = cursors.subs
    .filter(sub => !allIds.has(sub.requestId))
    .map(sub => ({ device: sub.device, requestId: sub.requestId }))
    .sort((a, b) => `${a.device}${a.requestId}`.localeCompare(`${b.device}${b.requestId}`));

  report.bytesReclaimable = report.candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (!apply) return report;

  // apply — every write tmp+rename, every failure reported, never thrown.
  let applied = true;
  let deleted = 0;
  let bytesFreed = 0;
  for (const [scope, ids] of delByScope) {
    try {
      const kept = byScope.get(scope).filter(entry => !ids.has(entry.id));
      atomicWrite(join(base, scope, RECEIPTS), kept.map(entry => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''));
      deleted += ids.size;
      for (const id of ids) bytesFreed += lineBytes.get(`${scope}\0${id}`) ?? 0;
    } catch (error) {
      applied = false;
      report.errors.push({ scope, code: error.code ?? 'rewrite_failed' });
    }
  }
  for (const body of bodyFiles) {
    try {
      rmSync(body.path, { force: true });
      bytesFreed += body.size;
    } catch (error) {
      applied = false;
      report.errors.push({ scope: body.scope, code: error.code ?? 'body_delete_failed' });
    }
  }
  if (report.orphanCursors.length && cursors.writable) {
    try {
      const keep = cursors.subs.filter(sub => allIds.has(sub.requestId));
      atomicWrite(cursors.file, JSON.stringify({ v: 1, subscriptions: keep }) + '\n');
    } catch (error) {
      applied = false;
      report.errors.push({ scope: 'watch', code: error.code ?? 'watch_rewrite_failed' });
    }
  }

  return { ...report, applied, deleted, bytesFreed };
}
