import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const { usageRollup } = await import('../plugin/server/pi-usage.mjs');
const cli = new URL('../experiments/pi-receipt/usage.mjs', import.meta.url).pathname;
const roots: string[] = [];
const mkRoot = () => { const r = mkdtempSync(join(tmpdir(), 'hg-pi-usage-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// Receipt ids must satisfy RECEIPT_ID (readJournal validates shape, unlike collectDocs).
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const session = '22222222-2222-4222-8222-222222222222';
// A fixed local calendar anchor: expected dates are derived with the same local
// arithmetic the module uses, so the asserts hold on any runner timezone.
const now = new Date(2026, 5, 15, 23, 30).getTime(); // local 2026-06-15 23:30
const noon = (back: number) => new Date(2026, 5, 15 - back, 12).getTime();
const dkey = (back: number) => {
  const d = new Date(2026, 5, 15 - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const entry = (over: Record<string, unknown> = {}) => ({
  v: 1, id: uid(1), status: 'replied', sessionId: session, ts: noon(0), ...over,
});

function fixture() {
  const root = mkRoot();
  const base = join(root, 'receipts');
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  mkdirSync(join(base, 'bbbbbbbbbbbbbbbb'), { recursive: true });
  mkdirSync(join(base, 'zzzzzzzzzzzzzzzz'), { recursive: true }); // 16 chars but not hex: ignored
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'), [
    JSON.stringify(entry({ id: uid(1), principal: 'device:d_a', usage: { totalTokens: 1000, costUsd: 0.5, durationMs: 1200 } })),
    JSON.stringify(entry({ id: uid(2), status: 'failed', reason: 'pi_error', principal: 'schedule:nightly', ts: noon(1), usage: { totalTokens: 200, costUsd: 0.25, durationMs: 300 } })),
    '{corrupt torn line',                                                    // skipped by readJournal
    JSON.stringify(entry({ id: uid(3), ts: noon(2) })),                      // no usage key → zeros
    JSON.stringify(entry({ id: uid(4), ts: noon(2) + 60000, usage: { totalTokens: 50, costUsd: 0.125 } })),
  ].join('\n') + '\n');
  writeFileSync(join(base, 'bbbbbbbbbbbbbbbb', 'receipts.jsonl'), [
    // outside the 7-day window: totals and byPrincipal, never a day bucket
    JSON.stringify(entry({ id: uid(5), status: 'canceled', principal: 'device:d_a', ts: noon(10), usage: { totalTokens: 10, costUsd: 0.0625 } })),
    // duplicate id, newer ts wins over the scope-A line above
    JSON.stringify(entry({ id: uid(1), status: 'failed', principal: 'device:d_a', ts: noon(0) + 3600000, usage: { totalTokens: 999, costUsd: 0.75 } })),
  ].join('\n') + '\n');
  writeFileSync(join(base, 'zzzzzzzzzzzzzzzz', 'receipts.jsonl'),
    JSON.stringify(entry({ id: uid(6), usage: { totalTokens: 77777, costUsd: 7 } })) + '\n');
  return { root, base };
}

test('usageRollup: totals, day partition, principal merge, newest-wins', () => {
  const { base } = fixture();
  const r = usageRollup({ base, days: 7, now });

  assert.equal(r.generatedAt, now);
  // Hand tally: 5 receipts (dup id(1) collapsed to the newer failed one,
  // corrupt line and non-hex scope skipped): 2 replied, 2 failed, 1 canceled;
  // tokens 999+200+50+10, cost 0.75+0.25+0.125+0.0625.
  assert.deepEqual(r.total, { requests: 5, replied: 2, failed: 2, canceled: 1, unknown: 0, tokens: 1259, costUsd: 1.1875 });

  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days.map(d => d.date), [0, 1, 2, 3, 4, 5, 6].map(dkey)); // newest first, local dates
  assert.deepEqual(r.days[0], { date: dkey(0), requests: 1, replied: 0, failed: 1, tokens: 999, costUsd: 0.75 });
  assert.deepEqual(r.days[1], { date: dkey(1), requests: 1, replied: 0, failed: 1, tokens: 200, costUsd: 0.25 });
  assert.deepEqual(r.days[2], { date: dkey(2), requests: 2, replied: 2, failed: 0, tokens: 50, costUsd: 0.125 });
  for (const empty of r.days.slice(3)) {
    assert.deepEqual(empty, { date: empty.date, requests: 0, replied: 0, failed: 0, tokens: 0, costUsd: 0 });
  }

  assert.deepEqual(r.byPrincipal.map(p => p.principal), ['device:d_a', 'schedule:nightly', '(human)']); // by cost desc
  assert.deepEqual(r.byPrincipal[0], { principal: 'device:d_a', requests: 2, replied: 0, failed: 1, tokens: 1009, costUsd: 0.8125, lastTs: noon(0) + 3600000 });
  assert.deepEqual(r.byPrincipal[1], { principal: 'schedule:nightly', requests: 1, replied: 0, failed: 1, tokens: 200, costUsd: 0.25, lastTs: noon(1) });
  assert.deepEqual(r.byPrincipal[2], { principal: '(human)', requests: 2, replied: 2, failed: 0, tokens: 50, costUsd: 0.125, lastTs: noon(2) + 60000 });
});

test('usageRollup: missing base fails closed with a zeroed, well-shaped result', () => {
  const missing = usageRollup({ base: join(mkRoot(), 'missing'), now });
  assert.deepEqual(missing.total, { requests: 0, replied: 0, failed: 0, canceled: 0, unknown: 0, tokens: 0, costUsd: 0 });
  assert.equal(missing.days.length, 7);
  assert.ok(missing.days.every(d => d.requests === 0 && d.tokens === 0 && d.costUsd === 0));
  assert.deepEqual(missing.byPrincipal, []);

  const defaulted = usageRollup({ base: join(mkRoot(), 'nope'), now }); // days defaults to 7
  assert.equal(defaulted.days.length, 7);
});

test('cli: --json parses with days/byPrincipal; text mode renders the human row', () => {
  const { base } = fixture();
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const j = run(['--base', base, '--days', '7', '--json']);
  assert.equal(j.status, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(typeof parsed.generatedAt, 'number');
  assert.deepEqual(parsed.total, { requests: 5, replied: 2, failed: 2, canceled: 1, unknown: 0, tokens: 1259, costUsd: 1.1875 });
  assert.equal(parsed.days.length, 7);
  assert.equal(parsed.byPrincipal[0].principal, 'device:d_a');
  assert.ok(parsed.byPrincipal.some((p: { principal: string }) => p.principal === '(human)'));

  const t = run(['--base', base, '--days', '3']);
  assert.equal(t.status, 0);
  assert.ok(t.stdout.includes('Days'));
  assert.ok(t.stdout.includes('By principal'));
  assert.ok(t.stdout.includes('(human)'));
  assert.ok(t.stdout.includes('Total'));
  assert.ok(t.stdout.includes(dkey(2)));   // third day row present
  assert.ok(!t.stdout.includes(dkey(3)));  // fourth day row absent with --days 3
});
