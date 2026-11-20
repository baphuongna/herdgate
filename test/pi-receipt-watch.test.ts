import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_SUBS_PER_DEVICE, WATCH_TTL_MS, openWatchStore, watchFile } from '../plugin/server/pi-receipt-watch.mjs';

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-watch-'));
  roots.push(dir);
  return dir;
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('register keeps the newest intent per request, bounded per device, private on disk', () => {
  const base = root();
  mkdirSync(base, { recursive: true });
  const store = openWatchStore(base);
  const first = store.register({ device: 'd_a', requestId: uuid(1), wantBody: true });
  assert.equal(first.wantBody, true);
  // Re-registering the same (device, request) supersedes instead of duplicating.
  const replaced = store.register({ device: 'd_a', requestId: uuid(1) });
  assert.equal(replaced.wantBody, false);
  assert.equal(store.pendingFor('d_a').length, 1);
  // Other devices track their own requests; the per-device bound drops the oldest.
  for (let i = 2; i < MAX_SUBS_PER_DEVICE + 4; i++) store.register({ device: 'd_a', requestId: uuid(i) });
  assert.equal(store.pendingFor('d_a').length, MAX_SUBS_PER_DEVICE);
  const survivor = store.register({ device: 'd_b', requestId: uuid(99) });
  assert.equal(store.pendingFor('d_b').length, 1);
  const raw = JSON.parse(readFileSync(watchFile(base), 'utf8'));
  assert.equal(raw.v, 1);
  assert.equal(raw.subscriptions.length, MAX_SUBS_PER_DEVICE + 1);
  for (const entry of raw.subscriptions) assert.ok(typeof entry.device === 'string' && /^[0-9a-f-]{36}$/.test(entry.requestId));
  // A new process reopens the same durable intents.
  assert.deepEqual(openWatchStore(base).pendingFor('d_b').map(s => s.requestId), [survivor.requestId]);
});

test('acknowledgment retires an intent; expiry sweeps it without an ack', () => {
  const base = root();
  const store = openWatchStore(base);
  store.register({ device: 'd_a', requestId: uuid(3) });
  store.markDelivered('d_a', uuid(3));
  assert.equal(store.pendingFor('d_a').length, 1, 'delivery is not acknowledgment');
  assert.equal(store.ack('d_b', uuid(3)), false, 'another device cannot retire it');
  assert.equal(store.ack('d_a', uuid(3)), true);
  assert.deepEqual(store.pendingFor('d_a'), []);
  // Expired intents disappear on sweep; fresh ones survive.
  const fresh = store.register({ device: 'd_a', requestId: uuid(4) });
  store.register({ device: 'd_a', requestId: uuid(5), ttlMs: 1 });
  store.sweep(fresh.createdAt + 2);
  assert.deepEqual(store.pendingFor('d_a').map(s => s.requestId), [fresh.requestId]);
  assert.ok(fresh.expiresAt - fresh.createdAt === WATCH_TTL_MS, 'default ttl mirrors the arm window');
  // Invalid input fails closed instead of poisoning the store.
  assert.throws(() => store.register({ device: 'd_a', requestId: 'not-a-uuid' }));
  assert.throws(() => store.register({ device: '', requestId: uuid(6) }));
  assert.throws(() => store.register({ device: 'd_a', requestId: uuid(6), ttlMs: 0 }));
});

test('replay candidates are unacknowledged intents for one device', () => {
  const base = root();
  const store = openWatchStore(base);
  store.register({ device: 'd_a', requestId: uuid(7) });
  store.register({ device: 'd_a', requestId: uuid(8) });
  store.register({ device: 'd_a', requestId: uuid(9) });
  store.register({ device: 'd_b', requestId: uuid(10) });
  store.markDelivered('d_a', uuid(8));
  store.ack('d_a', uuid(9));
  const replay = store.pendingFor('d_a').map(s => s.requestId);
  assert.deepEqual(replay.sort(), [uuid(7), uuid(8)].sort(), 'a device that reconnects is re-offered what it has not acknowledged');
  rmSync(base, { recursive: true, force: true });
});

test('temporary watch stores are cleaned up', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
