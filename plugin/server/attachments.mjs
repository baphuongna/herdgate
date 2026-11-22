// Photo/file attachments uploaded from the PWA composer (Wave C3).
//
// The herdcats lesson (docs/research/2026-11-21-marketplace/deep/cats.md,
// resolver.rs / runtime.mjs endpoint hygiene): files arriving from a device
// land ON THE AGENT MACHINE under a private directory the plugin owns —
//   * every directory level is mkdir'd then chmod'd 0700 one by one, and a
//     level that already exists as a symlink is refused ('symlink'),
//   * the client-supplied name is NEVER trusted for the stored filename —
//     names are <uuid>.<ext>, and <ext> comes from sniffing magic bytes,
//     not from the name or the declared mime type,
//   * the file itself is written O_CREAT|O_EXCL mode 0600.
// The reply then carries a path hint so the Pi agent opens the file with its
// own read tool — image bytes never ride the prompt text.
//
// Pure exports, no sockets: the device ops in index.mjs call these.

import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap, device and host agree
export const ATTACHMENTS_DIR = 'attachments';
const MONTH_DIR = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Stored filenames only: <uuid>.<ext> with ext from the magic-byte whitelist. */
const STORED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/;
const DAY_MS = 86400e3;

/** Sniff the image type from magic bytes — the name and mime are never trusted.
 *  PNG \x89PNG\r\n\x1a\n · JPEG \xFF\xD8\xFF · GIF "GIF8" · WEBP "RIFF"…."WEBP". */
export function sniffType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  const has = (offset, hex) => {
    if (bytes.length < offset + hex.length) return false;
    return hex.every((byte, i) => bytes[offset + i] === byte);
  };
  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (has(0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (has(0, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // "GIF8" (GIF87a/GIF89a)
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return 'webp'; // RIFF<u32>WEBP
  return null;
}

/** Create base/attachments/<yyyy-mm> one level at a time. Ancestors above base
 *  are only created when missing (never chmod'd — /tmp and friends are not
 *  ours; on macOS /tmp is even a system symlink). From base down — the
 *  plugin's own territory — every level is mkdir'd (0700) then chmod'd 0700,
 * created or not, and a level that exists as a symlink is refused. Returns
 *  the month directory path. */
function ensureMonthDir(base, now = new Date()) {
  const month = `${now.getUTCFullYear()}-` + String(now.getUTCMonth() + 1).padStart(2, '0');
  const dir = join(base, ATTACHMENTS_DIR, month);
  const abs = resolve(base);
  const segments = abs.split(sep).filter(Boolean);
  const prefix = abs.startsWith(sep) ? sep : '';
  // 1. bring base into existence (each missing ancestor mkdir'd 0700, no chmod)
  let walk = prefix;
  for (const part of segments) {
    walk = walk === prefix ? join(prefix, part) : join(walk, part);
    try { lstatSync(walk); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(walk, { mode: 0o700 });
    chmodSync(walk, 0o700);
  }
  // 2. base/attachments/<month>: 0700 each level, refuse planted symlinks
  let level = abs;
  for (const part of [ATTACHMENTS_DIR, month]) {
    level = join(level, part);
    let st = null;
    try { st = lstatSync(level); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (st) {
      if (st.isSymbolicLink()) throw new Error('symlink'); // planted path — refuse, never write through it
      if (!st.isDirectory()) throw new Error('not_a_directory');
    } else {
      mkdirSync(level, { mode: 0o700 });
    }
    chmodSync(level, 0o700); // every traversed level ends 0700, created or pre-existing
    st = lstatSync(level); // post-create check: what we made must be a real dir
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error('symlink');
  }
  return dir;
}

/**
 * Save one uploaded image: validate, sniff the type, store under
 * base/attachments/<yyyy-mm>/<uuid>.<ext> (O_EXCL|O_CREAT, mode 0600).
 * `name` is client metadata only — it never reaches the stored path.
 * Returns { id, path }. Throws 'bad_bytes' | 'empty' | 'too_large' |
 * 'bad_type' | 'symlink' — callers translate to a clear error op.
 */
export function saveAttachment(base, { name, bytes }) {
  if (!Buffer.isBuffer(bytes)) throw new Error('bad_bytes');
  if (bytes.length === 0) throw new Error('empty');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('too_large');
  const type = sniffType(bytes);
  if (!type) throw new Error('bad_type');
  if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > 255)) {
    throw new Error('bad_name');
  }
  const dir = ensureMonthDir(base);
  const id = randomUUID(); // stored names are uuids — a client name is never trusted
  const path = join(dir, `${id}.${type}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600); // explicit: survive any umask
  return { id, path };
}

/**
 * Metadata for every stored attachment (id, path, size, at) newest first.
 * Never reads file contents; a missing base answers [].
 */
export function listAttachments(base) {
  const out = [];
  const root = join(base, ATTACHMENTS_DIR);
  let months = [];
  try { months = readdirSync(root); }
  catch { return out; }
  for (const month of months.sort()) {
    if (!MONTH_DIR.test(month)) continue;
    let names = [];
    try { names = readdirSync(join(root, month)); }
    catch { continue; }
    for (const name of names) {
      const match = STORED.test(name);
      if (!match) continue;
      const path = join(root, month, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({ id: name.slice(0, 36), path, size: st.size, at: st.mtimeMs });
      } catch { /* vanished mid-list: skip, never throw */ }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * TTL sweep for stored attachments, dry-run by default (the gcJournal
 * philosophy): report what `days` would reclaim, touch nothing unless
 * apply: true. `at` (mtime) is the age clock; unreadable entries land in
 * errors and are never deleted.
 */
export function gcAttachments(base, { days = 14, apply = false, now = Date.now() } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  const span = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 14;
  const cutoff = at - span * DAY_MS;
  const report = { attachments: 0, candidates: [], bytesReclaimable: 0, errors: [], applied: false, deleted: 0, bytesFreed: 0 };
  const keep = [];
  const months = new Set();
  for (const entry of listAttachments(base)) {
    report.attachments++;
    months.add(dirname(entry.path));
    if (entry.at < cutoff) {
      report.candidates.push({ id: entry.id, path: entry.path, bytes: entry.size, at: entry.at });
      report.bytesReclaimable += entry.size;
    } else {
      keep.push(entry.path);
    }
  }
  if (!apply) return report;
  report.applied = true;
  for (const candidate of report.candidates) {
    try {
      rmSync(candidate.path, { force: false });
      report.deleted++;
      report.bytesFreed += candidate.bytes;
    } catch (error) {
      report.errors.push({ path: candidate.path, code: error.code ?? 'unlink_failed' });
    }
  }
  // A month dir left empty by the sweep goes away too (best effort, never recursive).
  for (const dir of months) {
    try { rmSync(dir, { recursive: false }); }
    catch { /* not empty or vanished — fine */ }
  }
  return report;
}
