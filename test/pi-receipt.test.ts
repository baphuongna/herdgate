import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const extension = new URL('../experiments/pi-receipt/observer.js', import.meta.url);
const receipts = await import('../plugin/server/pi-receipts.mjs');
const MAX_JOURNAL = 200;   // mirrors the observer's per-workspace bound
const COMPACT_AT = 300;     // the journal is rewritten once it grows past this
type Entry = { id: string; type: string; parentId: string | null; message?: Record<string, unknown> };
const roots: string[] = [];

async function worker(options: { persistRoot?: string; cwd?: string } = {}) {
  const root = options.persistRoot ?? mkdtempSync(join(tmpdir(), 'hg-pi-receipt-'));
  if (!roots.includes(root)) roots.push(root);
  mkdirSync(root, { recursive: true });
  const cwd = options.cwd ?? join(root, 'work');
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
  let sessionId = 'local-fixture';
  let idle = true;
  let queued = false;
  const notifications: string[] = [];
  const ctx = {
    mode: 'tui',
    cwd,
    ui: { notify: (text: string) => notifications.push(text) },
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leaf,
      getEntry: (id: string) => entries.get(id),
    },
  };
  function emit(name: string, event: Record<string, unknown> = {}) {
    hooks.get(name)?.({ type: name, ...event }, ctx);
  }
  async function command(name: string, args = '') {
    await commands.get(`herdgate-${name}`)!(args, ctx);
    return JSON.parse(notifications.at(-1)!);
  }
  function append(type: string, fields = {}) {
    const id = String(entries.size + 1);
    entries.set(id, { id, parentId: leaf, type, ...fields });
    leaf = id;
    return id;
  }
  function user(text: string) {
    return append('message', { message: { role: 'user', content: [{ type: 'text', text }] } });
  }
  function assistant(stopReason = 'stop', content: Array<Record<string, unknown>> = [{ type: 'text', text: 'private reply' }]) {
    return append('message', { message: { role: 'assistant', stopReason, content, errorMessage: 'private error' } });
  }
  emit('session_start');
  return {
    command, append, user, assistant, emit, root, cwd,
    turn: (messageEntryId: string) => emit('turn_end', { messageEntryId }),
    settle: (aborted = false) => emit('agent_settled', { aborted }),
    setIdle: (value: boolean) => { idle = value; },
    setQueued: (value: boolean) => { queued = value; },
    setSession: (value: string) => { sessionId = value; },
    setLeaf: (value: string | null) => { leaf = value; },
    rendered: () => notifications.join('\n'),
  };
}

test('a marked round trip reports received after append and replied only after settle', async () => {
  const w = await worker();
  w.user('unrelated history');
  const { id, status, marker } = await w.command('arm');
  assert.equal(status, 'armed');
  assert.equal(marker, `[herdr-request:${id}]`);
  w.emit('message_end', { message: { role: 'user', content: marker } });
  assert.equal((await w.command('receipt', id)).status, 'armed');
  const requestEntryId = w.user(`${marker}\r\nprivate brief`);
  const responseEntryId = w.assistant();
  w.turn(responseEntryId);
  w.emit('agent_end');
  assert.deepEqual(await w.command('receipt', id), { id, status: 'received', requestEntryId });
  w.settle();
  assert.deepEqual(await w.command('receipt', id), { id, status: 'replied', requestEntryId, responseEntryId });
  assert.doesNotMatch(w.rendered(), /private (brief|reply|error)/);
});

test('a new turn without a finalized entry cannot settle using a previous reply', async () => {
  const w = await worker();
  const { id, marker } = await w.command('arm');
  const requestEntryId = w.user(marker);
  w.turn(w.assistant());
  w.emit('turn_start');
  w.settle();
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'no_final_turn', requestEntryId });
});

test('a marker entering as follow-up to an untracked assistant turn is not a receipt', async () => {
  const w = await worker();
  const { id, marker } = await w.command('arm');
  w.turn(w.assistant());
  w.user(marker);
  w.turn(w.assistant());
  w.settle();
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'request_not_observed' });
});

test('arm refuses queued input, a busy agent and an existing intent', async () => {
  const w = await worker();
  w.setIdle(false);
  assert.equal((await w.command('arm')).reason, 'busy');
  w.setIdle(true);
  w.setQueued(true);
  assert.equal((await w.command('arm')).reason, 'busy');
  w.setQueued(false);
  const { id } = await w.command('arm');
  assert.deepEqual(await w.command('arm'), { id, status: 'not_armed', reason: 'already_armed' });
});

test('unmarked, inexact and duplicate marked user entries cannot produce a reply', async () => {
  for (const kind of ['unmarked', 'inexact', 'duplicate']) {
    const w = await worker();
    const { id, marker } = await w.command('arm');
    w.user(kind === 'inexact' ? `${marker} trailing text` : kind === 'duplicate' ? marker : 'unmarked');
    if (kind === 'duplicate') w.user(marker);
    w.turn(w.assistant());
    w.settle();
    assert.deepEqual(await w.command('receipt', id), {
      id, status: 'unknown', reason: kind === 'duplicate' ? 'competing_input' : 'request_not_observed',
    });
  }
});

test('one worker settling cannot complete another worker’s intent', async () => {
  const a = await worker();
  const b = await worker();
  const first = await a.command('arm');
  const second = await b.command('arm');
  b.user(second.marker);
  b.turn(b.assistant());
  b.settle();
  assert.equal((await b.command('receipt', second.id)).status, 'replied');
  assert.equal((await a.command('receipt', first.id)).status, 'armed');
  assert.equal((await b.command('receipt', first.id)).status, 'unknown');
});

test('a branch round-trip and a different session invalidate instead of reusing entry IDs', async () => {
  for (const reason of ['branch_changed', 'runtime_changed']) {
    const w = await worker();
    const baseline = w.user('historic message');
    const { id, marker } = await w.command('arm');
    const requestEntryId = w.user(marker);
    const reply = w.assistant();
    w.turn(reply);
    if (reason === 'branch_changed') {
      w.setLeaf(baseline);
      w.emit('session_tree');
      w.setLeaf(reply);
      w.emit('session_tree');
    } else {
      w.setSession('other-session');
    }
    w.settle();
    assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason, requestEntryId });
  }
});

test('a response hidden by context edits is not promoted to replied', async () => {
  const w = await worker();
  const { id, marker } = await w.command('arm');
  const requestEntryId = w.user(marker);
  const reply = w.assistant();
  w.turn(reply);
  w.append('context_edit', { targetId: reply, replacement: null });
  w.settle();
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'unsupported_context', requestEntryId });
});

test('tool output alone is not a response, but tools can precede a final reply', async () => {
  for (const caseName of ['tool-only', 'missing-result', 'final-reply']) {
    const w = await worker();
    const { id, marker } = await w.command('arm');
    w.user(marker);
    const call = { type: 'toolCall', id: 'call-1' };
    const intermediate = w.assistant('toolUse', [call]);
    if (caseName !== 'missing-result') {
      w.append('message', { message: { role: 'toolResult', toolCallId: call.id, content: [{ type: 'text', text: 'private tool output' }] } });
    }
    w.turn(intermediate);
    if (caseName !== 'tool-only') w.turn(w.assistant());
    w.settle();
    assert.equal((await w.command('receipt', id)).status, caseName === 'final-reply' ? 'replied' : 'unknown');
    assert.doesNotMatch(w.rendered(), /private tool output/);
  }
});

test('an expired intent is unknown, not failed', async t => {
  const w = await worker();
  let now = 1;
  t.mock.method(performance, 'now', () => now);
  const { id, expiresInSeconds } = await w.command('arm');
  now += expiresInSeconds * 1000;
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'expired' });
});

test('receipts persist across runtimes in a bounded private per-workspace journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hg-pi-journal-'));
  roots.push(root);
  const cwd = join(root, 'work');
  const first = await worker({ persistRoot: root, cwd });
  const { id, marker } = await first.command('arm');
  const requestEntryId = first.user(marker);
  const responseEntryId = first.assistant();
  first.turn(responseEntryId);
  first.settle();
  assert.equal((await first.command('receipt', id)).status, 'replied');

  // A fresh runtime for the same workspace loads the journal; another workspace cannot.
  const second = await worker({ persistRoot: root, cwd });
  assert.deepEqual(await second.command('receipt', id), { id, status: 'replied', requestEntryId, responseEntryId });
  const elsewhere = await worker({ persistRoot: root, cwd: join(root, 'elsewhere') });
  assert.deepEqual(await elsewhere.command('receipt', id), { id, status: 'unknown', reason: 'not_retained_in_runtime' });

  // The journal keeps only the newest receipts and stays private metadata.
  let latest = '';
  for (let index = 0; index <= COMPACT_AT; index++) {
    const armed = await second.command('arm');
    second.user(armed.marker);
    second.turn(second.assistant());
    second.settle();
    latest = armed.id;
  }
  assert.deepEqual(await second.command('receipt', id), { id, status: 'unknown', reason: 'not_retained_in_runtime' });
  assert.equal((await second.command('receipt', latest)).status, 'replied');
  // Hysteresis: the map and file may hold up to COMPACT_AT entries; crossing that
  // boundary rewrites the journal down to the newest MAX_JOURNAL receipts.
  const scope = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  assert.ok(readdirSync(root).includes(scope), 'the journal is scoped per working directory');
  const journal = join(root, scope, 'receipts.jsonl');
  const stored = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(stored.length >= MAX_JOURNAL && stored.length <= COMPACT_AT, `journal size ${stored.length}`);
  assert.ok(stored.every(entry => entry.id !== id), 'the oldest receipt was evicted');
  assert.ok(stored.some(entry => entry.id === latest), 'the newest receipt was retained');
  assert.ok(statSync(journal).mode.toString(8).endsWith('600'));
  for (const entry of stored) {
    assert.ok(entry.v === 1 && entry.id && entry.sessionId && typeof entry.ts === 'number');
    assert.equal(JSON.stringify(entry).match(/private|brief|reply|error/g), null, 'no prompt or answer text is stored');
  }
});

test('the shared journal reader finds newest receipts by exact UUID without enumeration', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hg-pi-reader-'));
  roots.push(base);
  const line = (entry: object) => `${JSON.stringify(entry)}\n`;
  const scopeA = join(base, 'a'.repeat(16));
  const scopeB = join(base, 'b'.repeat(16));
  mkdirSync(scopeA, { recursive: true });
  mkdirSync(scopeB, { recursive: true });
  const id = '00000000-0000-4000-8000-00000000000f';
  writeFileSync(join(scopeA, 'receipts.jsonl'),
    line({ v: 1, id, status: 'replied', sessionId: 's1', ts: 1 }) + '{corrupt\n', { mode: 0o600 });
  writeFileSync(join(scopeB, 'receipts.jsonl'),
    line({ v: 1, id, status: 'failed', reason: 'pi_error', sessionId: 's2', ts: 9, paneId: 'p1' }));
  const newest = receipts.findReceipt(base, id);
  assert.equal(newest?.status, 'failed');
  assert.deepEqual(receipts.publicReceipt(newest), { id, status: 'failed', reason: 'pi_error' });
  assert.deepEqual(receipts.publicReceipt(null), { status: 'unknown', reason: 'not_retained_in_runtime' });
  assert.equal(receipts.findReceipt(base, 'not-a-uuid'), null);
  assert.equal(receipts.findReceipt(base, '00000000-0000-4000-8000-0000000000ff'), null);
  assert.equal(receipts.findReceipt(join(base, 'missing'), id), null);
  assert.equal(receipts.journalBase({ HERDGATE_PI_RECEIPT_DIR: '/x' }), '/x');
  assert.ok(receipts.journalBase({}).includes(join('herdgate', 'pi-receipts')));
  assert.equal(receipts.scopeFor('/a').length, 16);
});

test('walking the session suffix fails closed at its bound', async () => {
  const w = await worker();
  const { id, marker } = await w.command('arm');
  w.user(marker);
  for (let i = 0; i < 256; i++) w.append('label');
  w.turn(w.assistant());
  w.settle();
  assert.deepEqual(await w.command('receipt', id), { id, status: 'unknown', reason: 'branch_limit' });
});

test('temporary journal workspaces are cleaned up', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
