import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readJournal } from '../plugin/server/pi-receipts.mjs';

const { gcJournal } = await import('../plugin/server/pi-receipt-gc.mjs');
const cli = new URL('../experiments/pi-receipt/gc.mjs', import.meta.url).pathname;

const roots: string[] = [];
const mkRoot = () => { const r = mkdtempSync(join(tmpdir(), 'hg-pi-gc-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// Receipt ids must satisfy RECEIPT_ID (readJournal validates shape).
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const session = '22222222-2222-4222-8222-222222222222';
const DAY = 86400e3;

const entry = (n: number, over: Record<string, unknown> = {}) => ({
  v: 1, id: uid(n), status: 'replied', sessionId: session, ts: 0, ...over,
});

const lineBytes = (e: object) => Buffer.byteLength(JSON.stringify(e), 'utf8') + 1;

/** Snapshot every file under base: path -> {mtimeMs, size, content}. */
function snapshot(base: string) {
  const out = new Map<string, { mtimeMs: number; size: number; content: Buffer }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(p, { mtimeMs: st.mtimeMs, size: st.size, content: readFileSync(p) });
    }
  };
  walk(base);
  return out;
}

/**
 * Two scopes, per spec:
 *  A: old replied (with archived body), old failed, old unknown (KEEP), old
 *     replied referenced by a watch cursor (KEEP), fresh replied.
 *  B: old canceled, fresh failed.
 * watch.json: one intent on A's referenced old receipt, one orphan intent.
 */
function fixture() {
  const root = mkRoot();
  const base = join(root, 'receipts');
  const now = Date.now();      // anchored to the real clock: the CLI has no --now
  const oldTs = now - 100 * DAY; // > 90 days: aged out
  const freshTs = now - DAY;     // yesterday: stays
  const A = join(base, 'aaaaaaaaaaaaaaaa');
  const B = join(base, 'bbbbbbbbbbbbbbbb');
  mkdirSync(join(A, 'responses'), { recursive: true });
  mkdirSync(B, { recursive: true });

  const e1 = entry(1, { ts: oldTs });                         // old replied -> delete (body too)
  const e2 = entry(2, { status: 'failed', reason: 'pi_error', ts: oldTs }); // old failed -> delete
  const e3 = entry(3, { status: 'unknown', reason: 'expired', ts: oldTs }); // old unknown -> KEEP
  const e4 = entry(4, { ts: oldTs });                          // old replied, watched -> KEEP
  const e5 = entry(5, { ts: freshTs });                        // fresh -> KEEP
  const e6 = entry(6, { status: 'canceled', ts: oldTs });      // old canceled (scope B) -> delete
  const e7 = entry(7, { status: 'failed', reason: 'pi_error', ts: freshTs }); // fresh -> KEEP

  writeFileSync(join(A, 'receipts.jsonl'), [e1, e2, e3, e4, e5].map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(B, 'receipts.jsonl'), [e6, e7].map(e => JSON.stringify(e)).join('\n') + '\n');

  const bodyText = `# reply for ${uid(1)}\n` + 'x'.repeat(500);
  writeFileSync(join(A, 'responses', `${uid(1)}.md`), bodyText);

  writeFileSync(join(base, 'watch.json'), JSON.stringify({
    v: 1,
    subscriptions: [
      { device: 'phone-1', requestId: uid(4), wantBody: false, createdAt: oldTs, expiresAt: oldTs + 600000 },
      { device: 'phone-1', requestId: uid(9), wantBody: true, createdAt: oldTs, expiresAt: oldTs + 600000 }, // orphan
    ],
  }) + '\n');

  return {
    base, A, B, bodyText, now,
    del: [e1, e2, e6], keep: [e3, e4, e5, e7],
  };
}

test('dry-run: correct hand tally, touches no file', () => {
  const { base, now, del, keep, bodyText } = fixture();
  const before = snapshot(base);

  const r = gcJournal({ base, days: 90, now });

  assert.equal(r.scopes, 2);
  assert.equal(r.keptUnknown, 1);
  assert.equal(r.errors.length, 0);
  assert.ok(!('applied' in r)); // dry run carries no apply fields

  // Candidates: exactly the three old settled receipts, body bytes folded into e1.
  assert.deepEqual(
    r.candidates.map((c: any) => [c.id, c.scope, c.status]).sort(),
    del.map(e => [e.id, e.id === uid(6) ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa', e.status]).sort(),
  );
  const withBody = r.candidates.find((c: any) => c.id === uid(1));
  assert.equal(withBody.bytes, lineBytes(del[0]) + Buffer.byteLength(bodyText));
  assert.equal(r.bytesReclaimable, r.candidates.reduce((s: number, c: any) => s + c.bytes, 0));

  // The watched old receipt and every other keeper are not candidates.
  for (const e of keep) assert.ok(!r.candidates.some((c: any) => c.id === e.id), e.id);

  // Orphan cursor reported (uid(9) is in no journal); the live one is not.
  assert.deepEqual(r.orphanCursors, [{ device: 'phone-1', requestId: uid(9) }]);

  // Nothing changed: same paths, same mtimes, same bytes, same content.
  const after = snapshot(base);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [p, was] of before) {
    assert.equal(after.get(p)!.mtimeMs, was.mtimeMs, p);
    assert.equal(after.get(p)!.size, was.size, p);
    assert.ok(after.get(p)!.content.equals(was.content), p);
  }
});

test('apply: deletes candidates, keeps the rest, retires orphans; idempotent', () => {
  const { base, now, A, B, keep } = fixture();

  const r = gcJournal({ base, days: 90, now, apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.deleted, 3);
  assert.equal(r.bytesFreed, r.bytesReclaimable);
  assert.equal(r.errors.length, 0);

  // Journals hold exactly the keepers, original order.
  assert.deepEqual(readJournal(join(A, 'receipts.jsonl')).map(e => e.id), [uid(3), uid(4), uid(5)]);
  assert.deepEqual(readJournal(join(B, 'receipts.jsonl')).map(e => e.id), [uid(7)]);
  assert.ok(keep.every(e => readJournal(join(base, e.id === uid(7) ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa', 'receipts.jsonl')).some(x => x.id === e.id)));

  // Body of the deleted receipt is gone; the watched receipt's journal line survives.
  assert.ok(!existsSync(join(A, 'responses', `${uid(1)}.md`)));

  // Watch store: orphan retired, the intent on uid(4) untouched.
  const watch = JSON.parse(readFileSync(join(base, 'watch.json'), 'utf8'));
  assert.deepEqual(watch.subscriptions.map((s: any) => s.requestId), [uid(4)]);

  // Second run: nothing left to do.
  const again = gcJournal({ base, days: 90, now, apply: true });
  assert.equal(again.candidates.length, 0);
  assert.equal(again.orphanCursors.length, 0);
  assert.equal(again.deleted, 0);
  assert.equal(again.bytesFreed, 0);
  assert.equal(again.keptUnknown, 1); // the unknown receipt is still kept
  assert.ok(existsSync(join(base, 'watch.json'))); // no orphan rewrite churn
});

test('unreadable scope: reported in errors, never throws (dry-run and apply)', () => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return; // chmod is advisory for root
  const root = mkRoot();
  const base = join(root, 'receipts');
  const good = join(base, 'aaaaaaaaaaaaaaaa');
  const bad = join(base, 'cccccccccccccccc');
  mkdirSync(good, { recursive: true });
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(good, 'receipts.jsonl'), JSON.stringify(entry(1, { ts: Date.now() - 100 * DAY })) + '\n');
  writeFileSync(join(bad, 'receipts.jsonl'), JSON.stringify(entry(2, { ts: Date.now() - 100 * DAY })) + '\n');
  chmodSync(bad, 0o000);

  try {
    const dry = gcJournal({ base, days: 90, now: Date.now() });
    assert.equal(dry.scopes, 1);
    assert.deepEqual(dry.errors, [{ scope: 'cccccccccccccccc', code: 'EACCES' }]);
    assert.equal(dry.candidates.length, 1); // the readable scope still sweeps
    assert.equal(dry.candidates[0].id, uid(1));

    const run = gcJournal({ base, days: 90, now: Date.now(), apply: true });
    assert.equal(run.applied, true);
    assert.equal(run.deleted, 1);
    assert.equal(run.errors.length, 1);
  } finally {
    chmodSync(bad, 0o755); // let test.after remove the tree
  }
});

test('cli: --json parses; text mode shows the table, keptUnknown and --apply hint', () => {
  const { base, del } = fixture();
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const j = run(['--base', base, '--days', '90', '--json']);
  assert.equal(j.status, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.scopes, 2);
  assert.equal(parsed.candidates.length, 3);
  assert.equal(parsed.keptUnknown, 1);
  assert.equal(parsed.applied, undefined); // --json without --apply stays a dry run
  assert.deepEqual(parsed.orphanCursors.map((c: any) => c.requestId), [uid(9)]);
  assert.deepEqual(parsed.candidates.map((c: any) => c.id).sort(), del.map(e => e.id).sort());

  const t = run(['--base', base]);
  assert.equal(t.status, 0);
  assert.ok(t.stdout.includes('id') && t.stdout.includes('scope') && t.stdout.includes('status') && t.stdout.includes('KB'));
  assert.ok(t.stdout.includes(uid(1).slice(0, 8)));
  assert.ok(t.stdout.includes('Total'));
  assert.ok(t.stdout.includes('keptUnknown'));
  assert.ok(t.stdout.includes('--apply'));

  const a = run(['--base', base, '--apply']);
  assert.equal(a.status, 0);
  assert.ok(a.stdout.includes('Applied'));
  const again = run(['--base', base, '--json']);
  assert.equal(JSON.parse(again.stdout).candidates.length, 0);
});
