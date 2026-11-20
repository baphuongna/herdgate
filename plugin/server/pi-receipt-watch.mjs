// Durable receipt-push subscriptions (experimental; see experiments/pi-receipt).
// Lesson taken from Paseo's finish subscriptions: the notification intent is
// owned by the receiver's request id, persists across publisher restarts and
// device reconnects, and only an explicit acknowledgment retires it. Delivered
// but unacknowledged intents are re-offered on reconnect; nothing is resent to
// devices that did not register. Shared reader/writer for the publisher; no
// network access here. Same opt-in gate as receipt.get (HERDGATE_PI_RECEIPTS=1).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RECEIPT_ID } from './pi-receipts.mjs';

/** Matches the observer's arm TTL: a watch outlives the request it tracks. */
export const WATCH_TTL_MS = 10 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SUBS_PER_DEVICE = 16;

/** Where the durable watch intents live, beside the receipt journals. */
export function watchFile(base) {
  return join(base, 'watch.json');
}

function valid(device) {
  return typeof device === 'string' && /^[\w.-]{1,64}$/.test(device);
}

function load(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return []; } // missing or unreadable -> empty, fail closed for replay
  const list = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  return list.filter(entry => valid(entry?.device) && RECEIPT_ID.test(entry?.requestId ?? '')
    && typeof entry.wantBody === 'boolean' && Number.isFinite(entry?.createdAt) && Number.isFinite(entry?.expiresAt));
}

function save(file, subscriptions) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, subscriptions }) + '\n', { mode: 0o600 });
  rmSync(file, { force: true });
  renameSync(tmp, file);
}

/**
 * Sync, atomic, newest-wins store. Registering the same (device, requestId)
 * supersedes the prior intent; ack removes it; sweep drops expired intents.
 * pendingFor() lists what a reconnecting device must be re-offered.
 */
export function openWatchStore(base) {
  const file = watchFile(base);
  const write = (subscriptions) => {
    save(file, subscriptions);
    return subscriptions;
  };
  let subscriptions = load(file);
  return {
    register({ device, requestId, wantBody = false, ttlMs = WATCH_TTL_MS }) {
      if (!valid(device)) throw new Error('invalid_device');
      if (!RECEIPT_ID.test(requestId ?? '')) throw new Error('invalid_request_id');
      if (wantBody !== undefined && typeof wantBody !== 'boolean') throw new Error('invalid_want_body');
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error('invalid_ttl');
      const now = Date.now();
      subscriptions = subscriptions.filter(s => !(s.device === device && s.requestId === requestId));
      subscriptions.push({ device, requestId, wantBody: Boolean(wantBody), createdAt: now, expiresAt: now + ttlMs });
      const mine = subscriptions.filter(s => s.device === device);
      if (mine.length > MAX_SUBS_PER_DEVICE) {
        const drop = new Set(mine.slice(0, mine.length - MAX_SUBS_PER_DEVICE));
        subscriptions = subscriptions.filter(s => !drop.has(s));
      }
      write(subscriptions);
      return { ...subscriptions.find(s => s.device === device && s.requestId === requestId) };
    },
    markDelivered(device, requestId) {
      const sub = subscriptions.find(s => s.device === device && s.requestId === requestId);
      if (sub) { sub.deliveredAt = Date.now(); write(subscriptions); }
      return Boolean(sub);
    },
    ack(device, requestId) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter(s => !(s.device === device && s.requestId === requestId));
      if (subscriptions.length === before) return false;
      write(subscriptions);
      return true;
    },
    pendingFor(device) {
      return subscriptions.filter(s => s.device === device && s.expiresAt > Date.now())
        .map(({ id, ...rest }) => ({ ...rest }));
    },
    pendingAll() {
      return subscriptions.filter(s => s.expiresAt > Date.now())
        .map(({ id, ...rest }) => ({ ...rest }));
    },
    sweep(now = Date.now()) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter(s => s.expiresAt > now);
      if (subscriptions.length !== before) write(subscriptions);
      return before - subscriptions.length;
    },
  };
}
