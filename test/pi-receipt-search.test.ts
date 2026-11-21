import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const mod = await import('../plugin/server/pi-receipt-search.mjs');
const { tokenize, buildIndex, searchIndex, snippet, collectDocs, searchReceipts } = mod;
const cli = new URL('../experiments/pi-receipt/search.mjs', import.meta.url).pathname;
const roots: string[] = [];
const mkRoot = () => { const r = mkdtempSync(join(tmpdir(), 'hg-pi-search-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const entry = (over: Record<string, unknown> = {}) => ({
  v: 1, id: '11111111-1111-4111-8111-111111111111', status: 'replied',
  sessionId: '22222222-2222-4222-8222-222222222222', ts: 1795000000000, ...over,
});
const sessionLine = (role: string, text: string) =>
  JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });

function fixture() {
  const root = mkRoot();
  const base = join(root, 'receipts');
  const sessions = join(root, 'sessions');
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  mkdirSync(join(sessions, 'slug-one'), { recursive: true });
  return { root, base, sessions };
}

test('tokenize keeps vietnamese words, paths and case-folds', () => {
  assert.deepEqual(tokenize('Noise Rekey — xoay khóa 2^24 lần!'), ['noise', 'rekey', 'xoay', 'khóa', '2', '24', 'lần']);
  assert.deepEqual(tokenize('khóa'.normalize('NFD')), ['khóa']); // NFD input folds to the same token
  assert.deepEqual(tokenize('src/cloud/gateway.ts v0.9.37'), ['src/cloud/gateway.ts', 'v0.9.37']);
  assert.deepEqual(tokenize(null), []);
});

test('bm25 ranks the matching document above the noise', () => {
  const docs = [
    { id: 'a', text: 'deployment rollback playbook for the staging cluster', meta: { ts: 1 } },
    { id: 'b', text: 'deployment rollback ' + 'lorem ipsum '.repeat(200), meta: { ts: 2 } },
    { id: 'c', text: 'unrelated notes about cooking dinner tonight', meta: { ts: 3 } },
  ];
  const hits = searchIndex(buildIndex(docs), 'deployment rollback', 10);
  assert.ok(hits.length === 2);
  assert.equal(hits[0].doc.id, 'a');            // short focused doc beats the padded one
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(searchIndex(buildIndex(docs), 'zzz-none', 10), []);
});

test('snippet centers on the first query hit and tolerates no-match', () => {
  const text = 'start '.repeat(60) + 'REKEY the noise channel here ' + 'end '.repeat(60);
  const s = snippet(text, 'noise rekey', 60);
  assert.ok(s.includes('REKEY') || s.toLowerCase().includes('noise'));
  assert.ok(s.startsWith('…'));
  assert.equal(snippet('short text', 'absent', 40), 'short text');
});

test('collectDocs merges journal, body archive and transcript by sessionId', () => {
  const { root, base, sessions } = fixture();
  const sA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'), [
    JSON.stringify(entry({ id: 'r1', sessionId: sA, paneId: 'w8:p1' })),
    '{corrupt torn line',                                                    // tolerated
    JSON.stringify(entry({ id: 'r2', sessionId: sA, status: 'failed', reason: 'pi_error' })),
    JSON.stringify({ v: 1, id: 'no-session', status: 'replied' }),           // skipped: no sessionId
    JSON.stringify(entry({ id: 'r3', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })),
  ].join('\n') + '\n');
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa', 'responses'), { recursive: true });
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'responses', 'r1.md'), 'FINAL ANSWER: the gate rotated its keys');
  writeFileSync(join(sessions, 'slug-one', `2026-11-20T10-00-00-000Z_${sA}.jsonl`), [
    sessionLine('user', 'hãy xoay khoá noise sau 2^24 tin'),
    sessionLine('assistant', 'đã xoay xong, handshake mới lập'),
  ].join('\n') + '\n');

  const docs = collectDocs({ base, sessionsRoot: sessions });
  assert.equal(docs.length, 3);                                  // r1 r2 r3; corrupt + no-session skipped
  const r1 = docs.find(d => d.id === 'r1')!;
  assert.ok(r1.text.includes('FINAL ANSWER: the gate rotated')); // body archive searched
  assert.ok(r1.text.includes('xoay khoá noise'));                // transcript prompt searched
  assert.ok(r1.text.includes('đã xoay xong'));                   // transcript reply searched
  assert.equal(r1.sessionFile, join(sessions, 'slug-one', `2026-11-20T10-00-00-000Z_${sA}.jsonl`));
  assert.ok(docs.find(d => d.id === 'r2')!.text.includes('pi_error'));  // metadata tokens
  const bare = collectDocs({ base, sessionsRoot: join(root, 'missing') });
  assert.equal(bare.length, 3);                                  // missing sessions dir is not fatal
  rmSync(root, { recursive: true, force: true });
});

test('cli: json shape, id mode, no-match exit, and session dedupe', () => {
  const { base, sessions } = fixture();
  const sA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'), [
    JSON.stringify(entry({ id: 'job-1', sessionId: sA, ts: 1795000001000 })),
    JSON.stringify(entry({ id: 'job-2', sessionId: sA, ts: 1795000002000 })),
    JSON.stringify(entry({ id: 'job-3', sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ts: 1795000003000 })),
  ].join('\n') + '\n');
  mkdirSync(join(sessions, 'slug-two'), { recursive: true });
  writeFileSync(join(sessions, 'slug-two', `2026-11-20T11-00-00-000Z_${sA}.jsonl`),
    sessionLine('user', 'wake frame scheduler bucket fired') + '\n');
  writeFileSync(join(sessions, 'slug-two', `2026-11-20T12-00-00-000Z_dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl`),
    sessionLine('user', 'wake frame scheduler second prompt other') + '\n');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const json = JSON.parse(run(['scheduler wake', '--base', base, '--sessions', sessions, '--json', '--limit', '5']).stdout);
  assert.ok(json.length >= 2 && json.length <= 3);
  assert.ok(json[0].score > 0 && json[0].id && json[0].sessionId && typeof json[0].snippet === 'string');
  const sessionsSeen = json.map((h: any) => h.sessionId);
  assert.equal(new Set(sessionsSeen).size, sessionsSeen.length);          // deduped per session

  const all = JSON.parse(run(['scheduler wake', '--base', base, '--sessions', sessions, '--json', '--all']).stdout);
  assert.ok(all.length > json.length);                                    // --all restores the flood

  const ids = run(['scheduler wake', '--base', base, '--sessions', sessions, '--id']).stdout.trim().split('\n');
  assert.deepEqual(ids, json.map((h: any) => h.id));

  const none = run(['zzz-no-such-term', '--base', base, '--sessions', sessions]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no receipts match/);
});

test('searchReceipts hands a device only publicReceipt-shaped hits', () => {
  const { base, sessions } = fixture();
  const sA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'), [
    JSON.stringify(entry({ id: 'hit-1', sessionId: sA, ts: 1, paneId: 'w8:pZ', usage: { totalTokens: 10, costUsd: 0.01 } })),
    JSON.stringify(entry({ id: 'hit-2', sessionId: sA, ts: 2 })),
    JSON.stringify(entry({ id: 'other', sessionId: sB, ts: 3 })),
  ].join('\n') + '\n');
  mkdirSync(join(sessions, 'slug-a'), { recursive: true });
  writeFileSync(join(sessions, 'slug-a', `2026-11-20T13-00-00-000Z_${sA}.jsonl`),
    sessionLine('user', 'wake frame scheduler bucket fired') + '\n');
  mkdirSync(join(sessions, 'slug-b'), { recursive: true });
  writeFileSync(join(sessions, 'slug-b', `2026-11-20T14-00-00-000Z_${sB}.jsonl`),
    sessionLine('user', 'nothing relevant here') + '\n');

  const hits = searchReceipts({ base, sessionsRoot: sessions, query: 'scheduler wake' });
  assert.equal(hits.length, 1);                       // both sA receipts collapse into one hit
  const hit = hits[0];
  assert.equal(hit.id, 'hit-2');                      // newest receipt of the session wins the tie
  assert.equal(hit.status, 'replied');
  assert.ok(hit.score > 0);
  // publicReceipt discipline: journal internals and text never leave the host.
  for (const key of ['sessionId', 'ts', 'paneId', 'snippet', 'sessionFile', 'text'])
    assert.ok(!(key in hit), `leaked ${key}`);
  // the hit is the session's newest receipt — usage shows only when it has one
  assert.equal(hit.usage, undefined);
  assert.equal(searchReceipts({ base, sessionsRoot: sessions, query: 'zzz-none' }).length, 0);
  assert.deepEqual(searchReceipts({ base: join(base, 'missing'), sessionsRoot: sessions, query: 'wake' }), []); // fail closed
  assert.equal(searchReceipts({ base, sessionsRoot: sessions, query: 'scheduler wake', all: true, limit: 5 }).length, 2);
});
