// Receipts evidence v2 (wave A4) — send-path delivery (delivered|stalled|
// unverified, chat.md useDelivery.ts transport-vs-app flag), failure phase
// taxonomy (dispatch|settled|failed_before_dispatch, mobrel coordinator.go:884
// + socket_api.go:157 dispatch boundary), and the mailbox newer-of-two watcher
// (usage.md refresh.rs:326-344 provider_snapshot_for_display).
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const receipts = await import('../plugin/server/pi-receipts.mjs');
const extension = new URL('../experiments/pi-receipt/observer.js', import.meta.url);
const roots: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// Entry schema: back-compat, new optional fields, strict enums.
// ---------------------------------------------------------------------------

const base = { v: 1, id: '00000000-0000-4000-8000-00000000000f', status: 'replied', sessionId: 's', ts: 1 } as Record<string, unknown>;

test('legacy entries without the v2 fields stay valid and map delivery from responseEntryId', () => {
  const legacy = { ...base };
  assert.equal(receipts.validEntry(legacy), legacy, 'a pre-v2 journal line passes unchanged');
  // A legacy replied receipt carries its own delivery proof: the response entry.
  const shown = receipts.publicReceipt({ ...base, requestEntryId: 'r1', responseEntryId: 'a1' });
  assert.equal(shown.delivery, 'delivered');
  assert.ok(!('phase' in shown), 'phase is never guessed for legacy lines');
  // A legacy failure without a response says nothing about delivery — absent, not wrong.
  const failed = receipts.publicReceipt({ ...base, id: '00000000-0000-4000-8000-00000000000e', status: 'failed', reason: 'pi_error', responseEntryId: undefined });
  assert.ok(!('delivery' in failed) && !('phase' in failed));
});

test('validEntry accepts the v2 enums and rejects wrong values and unbounded errors', () => {
  for (const delivery of ['delivered', 'stalled', 'unverified']) {
    assert.ok(receipts.validEntry({ ...base, delivery }), `delivery ${delivery} is in the enum`);
  }
  for (const phase of ['dispatch', 'settled', 'failed_before_dispatch']) {
    assert.ok(receipts.validEntry({ ...base, phase }), `phase ${phase} is in the enum`);
  }
  assert.ok(receipts.validEntry({ ...base, delivery: 'stalled', phase: 'dispatch', error: { code: 'pi_error' } }));
  assert.ok(receipts.validEntry({ ...base, error: { code: 'job_timeout', args: { ttlSeconds: 3600, retry: false } } }), 'bounded args ride along');
  // Wrong enum values fail closed — the journal reader would skip such a line.
  for (const bad of [
    { delivery: 'maybe' }, { delivery: 'DELIVERED' }, { delivery: 1 },
    { phase: 'dispatching' }, { phase: 'failed' }, { phase: null },
  ]) {
    assert.equal(receipts.validEntry({ ...base, ...bad }), null, JSON.stringify(bad));
  }
  // error is a bounded machine-readable shape (mobrel protocol.go:324), or absent.
  for (const bad of [
    'pi_error', 7, null, {}, { code: 'PI_ERROR' }, { code: 'not a code' }, { code: '' }, { code: 'x'.repeat(65) },
    { code: 'pi_error', args: [1, 2] }, { code: 'pi_error', args: 'no' },
    { code: 'pi_error', junk: 1 }, { code: 'pi_error', args: { x: 'y'.repeat(257) } },
    { code: 'pi_error', args: { big: 2n ** 64n } },
    { code: 'ok', args: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])) },
  ]) {
    assert.equal(receipts.validEntry({ ...base, error: bad }), null, `error ${JSON.stringify(String(bad))} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// The observer writes delivery/phase/error on every settle.
// ---------------------------------------------------------------------------

type Entry = { id: string; type: string; parentId: string | null; message?: Record<string, unknown> };

async function worker() {
  const root = fresh('hg-pi-receipt2-');
  const cwd = join(root, 'work');
  mkdirSync(cwd, { recursive: true });
  const commands = new Map<string, Function>();
  const hooks = new Map<string, Function>();
  const prior = process.env.HERDGATE_PI_RECEIPT_DIR;
  process.env.HERDGATE_PI_RECEIPT_DIR = root; // captured when the factory runs
  const { default: activate } = await import(extension.href);
  activate({
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    on: (event: string, handler: Function) => hooks.set(event, handler),
  });
  process.env.HERDGATE_PI_RECEIPT_DIR = prior;
  const entries = new Map<string, Entry>();
  let leaf: string | null = null;
  const notifications: string[] = [];
  const ctx = {
    mode: 'tui',
    cwd,
    ui: { notify: (text: string) => notifications.push(text) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => 'local-fixture',
      getLeafId: () => leaf,
      getEntry: (id: string) => entries.get(id),
    },
  };
  const emit = (name: string, event: Record<string, unknown> = {}) => hooks.get(name)?.({ type: name, ...event }, ctx);
  function append(type: string, fields: Record<string, unknown> = {}) {
    const id = String(entries.size + 1);
    entries.set(id, { id, parentId: leaf, type, ...fields } as Entry);
    leaf = id;
    return id;
  }
  const user = (text: string) => append('message', { message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = (stopReason = 'stop') => append('message', { message: { role: 'assistant', stopReason, content: [{ type: 'text', text: 'private reply' }] } });
  emit('session_start');
  return {
    root, cwd,
    command: async (name: string, args = '') => {
      await commands.get(`herdgate-${name}`)!(args, ctx);
      return JSON.parse(notifications.at(-1)!) as Record<string, unknown>;
    },
    user, assistant,
    turn: (messageEntryId: string) => emit('turn_end', { messageEntryId }),
    settle: (aborted = false) => emit('agent_settled', { aborted }),
    journal: () => receipts.readJournal(join(root, receipts.scopeFor(cwd), 'receipts.jsonl')),
  };
}

test('an expiry before the request reached the provider is failed_before_dispatch', async t => {
  const w = await worker();
  let now = 1;
  t.mock.method(performance, 'now', () => now);
  const { id, expiresInSeconds } = await w.command('arm');
  now += expiresInSeconds * 1000; // the TTL runs out with no marker prompt ever appended
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'expired' });
  const entry = w.journal().find((e: { id: string }) => e.id === id)!;
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.delivery, 'unverified', 'nothing acknowledged the prompt');
  assert.equal(entry.phase, 'failed_before_dispatch', 'the fail predates dispatch — retry-safe knowledge');
  assert.deepEqual(entry.error, { code: 'job_timeout' }, 'the arm TTL maps to a machine-readable timeout');
});

test('an expiry after dispatch keeps the outcome open as phase dispatch', async t => {
  const w = await worker();
  let now = 1;
  t.mock.method(performance, 'now', () => now);
  const { id, marker, expiresInSeconds } = await w.command('arm');
  w.user(marker); // the marked prompt is appended
  w.turn(w.assistant()); // a turn observes it: dispatch is now a recorded fact
  now += expiresInSeconds * 1000;
  await w.command('receipt', id); // any entry point runs the expiry check
  const entry = w.journal().find((e: { id: string }) => e.id === id)!;
  assert.equal(entry.delivery, 'delivered', 'the session entry is the host acknowledgement');
  assert.equal(entry.phase, 'dispatch', 'dispatched, outcome unknown — never failed_before_dispatch');
  assert.deepEqual(entry.error, { code: 'job_timeout' });
});

test('a provider failure settles with a machine-readable error; replied and canceled settle clean', async () => {
  const w = await worker();
  const failed = await w.command('arm');
  w.user(failed.marker as string);
  w.turn(w.assistant('error'));
  w.settle();
  const failedEntry = w.journal().find((e: { id: string }) => e.id === failed.id)!;
  assert.equal(failedEntry.status, 'failed');
  assert.equal(failedEntry.delivery, 'delivered');
  assert.equal(failedEntry.phase, 'settled', 'the provider answered — a definite outcome');
  assert.deepEqual(failedEntry.error, { code: 'pi_error' }, 'stopReason error maps to a machine-readable code');

  const replied = await w.command('arm');
  w.user(replied.marker as string);
  const responseEntryId = w.assistant();
  w.turn(responseEntryId);
  w.settle();
  const repliedEntry = w.journal().find((e: { id: string }) => e.id === replied.id)!;
  assert.equal(repliedEntry.delivery, 'delivered');
  assert.equal(repliedEntry.phase, 'settled');
  assert.ok(!('error' in repliedEntry), 'a clean reply carries no error');

  const canceled = await w.command('arm');
  w.user(canceled.marker as string);
  w.turn(w.assistant());
  w.settle(true);
  const canceledEntry = w.journal().find((e: { id: string }) => e.id === canceled.id)!;
  assert.equal(canceledEntry.status, 'canceled');
  assert.equal(canceledEntry.phase, 'settled');
  assert.ok(!('error' in canceledEntry), 'a user abort is not a provider error');

  // An unknown outcome with no mappable reason keeps lifecycle strings only.
  const sidelined = await w.command('arm');
  w.user(`${sidelined.marker}\nbrief`);
  w.user('competing unmarked input');
  w.turn(w.assistant());
  w.settle();
  const sidelinedEntry = w.journal().find((e: { id: string }) => e.id === sidelined.id)!;
  assert.equal(sidelinedEntry.status, 'unknown');
  assert.ok(!('error' in sidelinedEntry), 'no machine-readable code, no error field');
});

test('publicReceipt exposes delivery and phase but never the error payload', async () => {
  const w = await worker();
  const armed = await w.command('arm');
  w.user(armed.marker as string);
  w.turn(w.assistant('error'));
  w.settle();
  const entry = w.journal().find((e: { id: string }) => e.id === armed.id)!;
  const shown = receipts.publicReceipt(entry) as Record<string, unknown>;
  assert.equal(shown.delivery, 'delivered');
  assert.equal(shown.phase, 'settled');
  assert.ok(!('error' in shown), 'host-side diagnostics stay on the host');
  assert.equal(shown.reason, 'pi_error');
  // The slash-command notification keeps the old metadata-only shape.
  const notice = await w.command('receipt', armed.id);
  assert.ok(!('delivery' in notice) && !('phase' in notice) && !('error' in notice));
  assert.deepEqual(notice, { id: armed.id, status: 'failed', reason: 'pi_error', requestEntryId: entry.requestEntryId });
  // A reloaded runtime serves the same stripped shape from the v2 journal.
  assert.ok(!('error' in receipts.publicReceipt(w.journal()[0]!)));
});

// ---------------------------------------------------------------------------
// watchReceipts: mailbox newer-of-two — one sweep, one emit per id.
// ---------------------------------------------------------------------------

test('two copies of one id in a single sweep collapse to the newest, emitted once', async () => {
  const dir = fresh('hg-pi-watch2-');
  const baseDir = join(dir, 'base');
  const scope = join(baseDir, 'a'.repeat(16));
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  const file = join(scope, 'receipts.jsonl');
  const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
  const id = '00000000-0000-4000-8000-000000000021';
  const copy = (ts: number, status = 'replied') => ({ v: 1, id, status, sessionId: 's', ts });
  const other = '00000000-0000-4000-8000-000000000022';
  writeFileSync(file, line({ v: 1, id: other, status: 'replied', sessionId: 's', ts: 1 }), { mode: 0o600 }); // baseline
  const seen: { id: string; ts: number; status: string }[] = [];
  const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
  const stop = receipts.watchReceipts(baseDir, (e: { id: string; ts: number; status: string }) => seen.push({ id: e.id, ts: e.ts, status: e.status }), { intervalMs: 150 });
  await delay(350);
  assert.equal(seen.length, 0, 'the baseline must not replay');
  // One mailbox write lands two copies of the same id (an event writer and a
  // poll writer racing): the sweep must emit only the newer one, exactly once.
  appendFileSync(file, line(copy(5)) + line(copy(9, 'failed')));
  const first = async () => { while (seen.length < 1) await delay(50); };
  await Promise.race([first(), delay(5000).then(() => { throw new Error('watcher did not fire'); })]);
  assert.deepEqual(seen[0], { id, ts: 9, status: 'failed' }, 'the newest copy wins');
  await delay(650); // several more sweeps re-read both copies
  assert.equal(seen.filter(e => e.id === id).length, 1, 'the older copy never emits, in this sweep or any later one');
  // A genuinely newer copy across sweeps still emits (newer ts for a known id)…
  appendFileSync(file, line(copy(12)));
  const second = async () => { while (seen.length < 2) await delay(50); };
  await Promise.race([second(), delay(5000).then(() => { throw new Error('the newer copy must re-emit'); })]);
  assert.equal(seen[1]!.ts, 12);
  // …but a duplicate at the same ts is not news.
  appendFileSync(file, line(copy(12, 'canceled')));
  await delay(500);
  assert.equal(seen.length, 2, 'same-ts duplicate copies stay silent');
  stop();
  await delay(300);
  appendFileSync(file, line(copy(20)));
  await delay(400);
  assert.equal(seen.length, 2, 'a stopped watcher stays silent');
});

test('temporary v2 workspaces are cleaned up', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
