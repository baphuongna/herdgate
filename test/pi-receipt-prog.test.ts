// Progressive receipt self-reporting: turns + lastActivityAt are MEASURED from
// the session transcript at settle time (never estimated), stored as optional
// journal fields, exposed through publicReceipt, and judged by isStale.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// URL-based dynamic imports keep this test decoupled from type declarations.
const receiptsModule = new URL('../plugin/server/pi-receipts.mjs', import.meta.url);
const observerModule = new URL('../experiments/pi-receipt/observer.js', import.meta.url);
const receipts: any = await import(receiptsModule.href);
const observer: any = await import(observerModule.href);
const countTurnsFromSession: (filePath: string) => { turns: number; lastActivityAt: number | null } | null
  = observer.countTurnsFromSession;

type Entry = { id: string; type: string; parentId: string | null; message?: Record<string, unknown> };
const roots: string[] = [];
const fresh = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('countTurnsFromSession counts assistant messages, skips corrupt lines, and survives empty transcripts', () => {
  const root = fresh('hg-pi-turns-');
  const ms = (n: number) => 1_700_000_000_000 + n * 1000;
  const message = (role: string, n: number) => JSON.stringify({
    type: 'message', id: `e${n}`, parentId: null, timestamp: new Date(ms(n)).toISOString(),
    message: { role, content: [{ type: 'text', text: `private ${role} text` }], timestamp: ms(n) },
  });
  const session = join(root, 'session.jsonl');
  writeFileSync(session, [
    JSON.stringify({ type: 'session', version: 3, id: 'fixture', timestamp: new Date(ms(0)).toISOString(), cwd: root }),
    message('user', 1),
    message('assistant', 2),
    '{corrupt torn line',
    message('assistant', 3),
    message('user', 4),
    message('assistant', 5), // no trailing newline: the tail flush must absorb it
  ].join('\n'), { mode: 0o600 });
  assert.deepEqual(countTurnsFromSession(session), { turns: 3, lastActivityAt: ms(5) },
    '3 assistant + 2 user + 1 corrupt line -> 3 turns; the last message owns lastActivityAt');
  const empty = join(root, 'empty.jsonl');
  writeFileSync(empty, '', { mode: 0o600 });
  assert.deepEqual(countTurnsFromSession(empty), { turns: 0, lastActivityAt: null }, 'an empty transcript measures zero');
  assert.equal(countTurnsFromSession(join(root, 'missing.jsonl')), null,
    'an unreadable transcript is unknown, not zero — never a guess');
});

test('publicReceipt exposes measured activity counters and omits absent ones entirely', () => {
  const base = { v: 1, id: '00000000-0000-4000-8000-00000000000f', status: 'replied', sessionId: 's', ts: 1 };
  const shown = receipts.publicReceipt({ ...base, turns: 3, lastActivityAt: 1_700_000_012_345 });
  assert.equal(shown.turns, 3);
  assert.equal(shown.lastActivityAt, 1_700_000_012_345);
  const bare = receipts.publicReceipt(base);
  assert.ok(!('turns' in bare), 'absent means absent, not null');
  assert.ok(!('lastActivityAt' in bare), 'absent means absent, not null');
  const none = receipts.publicReceipt(null);
  assert.ok(!('turns' in none) && !('lastActivityAt' in none));
});

test('isStale trips just past the window and never guesses a missing timestamp', () => {
  const minute = 60e3;
  const entry = { v: 1, id: '00000000-0000-4000-8000-00000000000e', status: 'replied', sessionId: 's', ts: 1, lastActivityAt: 1_000_000 };
  assert.equal(receipts.isStale(entry, 1_000_000 + 29 * minute + 59e3, 30 * minute), false, "29'59\" is not stale yet");
  assert.equal(receipts.isStale(entry, 1_000_000 + 30 * minute + 1e3, 30 * minute), true, "30'01\" is stale");
  assert.equal(receipts.isStale({ v: 1, id: '00000000-0000-4000-8000-00000000000d', status: 'replied', sessionId: 's', ts: 1 }, 9_999_999_999_999), false,
    'no lastActivityAt means UNKNOWN, not stale — fail closed');
  const now = 1_800_000_000_000;
  assert.equal(receipts.isStale({ lastActivityAt: now - 30 * minute - 1 }, now), true, 'the default window is 30 minutes');
  assert.equal(receipts.isStale({ lastActivityAt: now - 29 * minute }, now), false);
});

test('validEntry accepts the optional counters and the journal round-trips them', () => {
  const id = '00000000-0000-4000-8000-000000000010';
  const entry = { v: 1, id, status: 'replied', sessionId: 's', ts: 7, turns: 0, lastActivityAt: 1_700_000_000_000 };
  assert.equal(receipts.validEntry(entry), entry, 'a zero turn count is a measurement, not a missing field');
  const root = fresh('hg-pi-roundtrip-');
  const scope = join(root, 'a'.repeat(16));
  mkdirSync(scope, { recursive: true });
  const journal = join(scope, 'receipts.jsonl');
  writeFileSync(journal, `${JSON.stringify(entry)}\n{corrupt\n`, { mode: 0o600 });
  const loaded = receipts.readJournal(journal);
  assert.equal(loaded.length, 1, 'the corrupt line is skipped');
  assert.equal(loaded[0].turns, 0);
  assert.equal(loaded[0].lastActivityAt, 1_700_000_000_000);
  // Malformed counters never enter the journal — measured numbers only.
  for (const bad of [{ turns: -1 }, { turns: 1.5 }, { turns: '3' }, { lastActivityAt: 'soon' }, { lastActivityAt: Number.NaN }]) {
    assert.equal(receipts.validEntry({ ...entry, ...bad }), null, JSON.stringify(bad));
  }
});

// A minimal Pi harness whose session JSONL is a real file the observer can read.
async function transcriptWorker() {
  const root = fresh('hg-pi-observe-');
  const cwd = join(root, 'work');
  mkdirSync(cwd, { recursive: true });
  const sessionFile = join(root, 'session.jsonl');
  const commands = new Map<string, Function>();
  const hooks = new Map<string, Function>();
  const prior = process.env.HERDGATE_PI_RECEIPT_DIR;
  process.env.HERDGATE_PI_RECEIPT_DIR = root; // captured when the factory runs
  const { default: activate } = await import(observerModule.href);
  activate({
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    on: (event: string, handler: Function) => hooks.set(event, handler),
  });
  process.env.HERDGATE_PI_RECEIPT_DIR = prior;
  const entries = new Map<string, Entry>();
  const transcript: string[] = [
    JSON.stringify({ type: 'session', version: 3, id: 'fixture', timestamp: new Date(0).toISOString(), cwd }),
  ];
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
      getSessionFile: () => sessionFile,
      getLeafId: () => leaf,
      getEntry: (id: string) => entries.get(id),
    },
  };
  const ms = (n: number) => 1_700_000_000_000 + n * 1000;
  function append(type: string, fields: Record<string, unknown> = {}) {
    const id = String(entries.size + 1);
    const record = { type, id, parentId: leaf, timestamp: new Date(ms(entries.size)).toISOString(), ...fields };
    entries.set(id, record);
    leaf = id;
    if (type === 'message') transcript.push(JSON.stringify(record));
    writeFileSync(sessionFile, transcript.join('\n') + '\n', { mode: 0o600 });
    return id;
  }
  const user = (text: string) => append('message', { message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms(entries.size) } });
  const assistant = () => append('message', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'private reply' }], timestamp: ms(entries.size) } });
  const emit = (name: string, event: Record<string, unknown> = {}) => hooks.get(name)?.({ type: name, ...event }, ctx);
  emit('session_start');
  return {
    root, cwd,
    command: async (name: string, args = '') => {
      await commands.get(`herdgate-${name}`)!(args, ctx);
      return JSON.parse(notifications.at(-1)!);
    },
    user, assistant,
    turn: (messageEntryId: string) => emit('turn_end', { messageEntryId }),
    settle: (aborted = false) => emit('agent_settled', { aborted }),
  };
}

test('the observer measures turns and lastActivityAt from the observed transcript at settle', async () => {
  const w = await transcriptWorker();
  w.user('unrelated history'); // transcript history counts too: it is the same session
  w.assistant();
  const armed = await w.command('arm');
  w.user(`${armed.marker}\nprivate brief`);
  const response = w.assistant();
  w.turn(response);
  w.settle();
  const shown = await w.command('receipt', armed.id);
  assert.equal(shown.status, 'replied');
  assert.ok(!('turns' in shown) && !('lastActivityAt' in shown), 'notifications keep the metadata-only shape');
  const journal = receipts.readJournal(join(w.root, receipts.scopeFor(w.cwd), 'receipts.jsonl'));
  const entry = journal.find((e: { id: string }) => e.id === armed.id);
  assert.equal(entry.turns, 2, 'history + reply assistant messages — counted, not estimated');
  assert.equal(entry.lastActivityAt, 1_700_000_003_000, 'the last transcript message owns the timestamp');
  assert.equal(receipts.publicReceipt(entry).turns, 2);
  assert.equal(receipts.publicReceipt(entry).lastActivityAt, 1_700_000_003_000);
  assert.equal(receipts.isStale(entry, 1_700_000_003_000 + 30 * 60e3 + 1), true);
  assert.equal(receipts.isStale(entry, 1_700_000_003_000 + 29 * 60e3), false);
});
