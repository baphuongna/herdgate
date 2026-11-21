// Herdgate receipt-stack probe for non-Linux hosts (written for Windows via the
// SSH bridge: base64 the file, WriteAllBytes, `node probe.mjs`). Exercises the
// SHIPPED plugin/server modules against the real NTFS filesystem and prints one
// JSON summary: journalBase, scopeFor convergence (case + separators), journal
// roundtrip, UTF-8 body read (O_NOFOLLOW is a no-op there), watch store
// persistence, and watchReceipts emitting a new settle.
//
//   HERDGATE_PROBE_ROOT=<.../plugin/server> node windows-probe.mjs   # exit 0 = all pass
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.HERDGATE_PROBE_ROOT; // the installed release's plugin/server dir
const results = [];
const check = (name, ok, detail) => results.push({ check: name, ok: !!ok, detail: detail ?? null });

const receipts = await import(pathToFileURL(join(root, 'pi-receipts.mjs')).href);
const watchMod = await import(pathToFileURL(join(root, 'pi-receipt-watch.mjs')).href);

// 1. journalBase default resolution must not throw and lands under the user profile.
try {
  const base = receipts.journalBase({});
  const flat = base.replaceAll('\\', '/');
  const profileOk = process.platform === 'win32' ? /users\//i.test(flat + '/') : /^\/home\//.test(flat);
  check('journalBase', /pi-receipts/i.test(flat) && profileOk, base);
} catch (e) { check('journalBase', false, String(e.message)); }

// 2. scopeFor converges: case variants and forward/back slashes of one dir.
try {
  const dir = mkdtempSync(join(tmpdir(), 'hg-probe-'));
  const real = realpathSync(dir);
  // Case-insensitivity is a Windows property; on Linux only separators must converge.
  const a = process.platform === 'win32' ? receipts.scopeFor(real.toUpperCase()) : receipts.scopeFor(real);
  const b = process.platform === 'win32' ? receipts.scopeFor(real.toLowerCase()) : a;
  const c = receipts.scopeFor(real.replaceAll('\\', '/'));
  check('scopeFor-converges', a === b && b === c && /^[0-9a-f]{16}$/.test(a), `${a} ${b} ${c}`);
  rmSync(dir, { recursive: true, force: true });
} catch (e) { check('scopeFor-converges', false, String(e.message)); }

// 3. Journal roundtrip on NTFS: read a seeded file, findReceipt, publicReceipt strips.
try {
  const dir = mkdtempSync(join(tmpdir(), 'hg-probe-j-'));
  const scope = receipts.scopeFor(dir);
  const scopeDir = join(dir, 'base', scope);
  mkdirSync(scopeDir, { recursive: true });
  const id = '12345678-1234-4abc-8abc-123456789abc';
  writeFileSync(join(scopeDir, 'receipts.jsonl'),
    `${JSON.stringify({ v: 1, id, status: 'replied', ts: 42, sessionId: 's', usage: { totalTokens: 10 } })}\n`, { mode: 0o600 });
  const base = join(dir, 'base');
  const got = receipts.findReceipt(base, id);
  const pub = receipts.publicReceipt(got);
  check('journal-roundtrip', got?.status === 'replied' && got?.usage?.totalTokens === 10
    && !('sessionId' in pub) && !('v' in pub) && !('ts' in pub), JSON.stringify(pub));
  rmSync(dir, { recursive: true, force: true });
} catch (e) { check('journal-roundtrip', false, String(e.message)); }

// 4. Body archive read: write the file the way the observer does, read it back
//    with findBody (O_NOFOLLOW must be a no-op, not a crash, on Windows).
try {
  const dir = mkdtempSync(join(tmpdir(), 'hg-probe-b-'));
  const scope = receipts.scopeFor(dir);
  const responses = join(dir, 'base', scope, 'responses');
  mkdirSync(responses, { recursive: true });
  const id = 'abcdefab-cdef-4abc-8abc-123456789abc';
  writeFileSync(join(responses, `${id}.md`), 'Báo cáo: chữ tiếng Việt, dấu đầy đủ.', { mode: 0o600 });
  const body = receipts.findBody(join(dir, 'base'), id);
  check('body-read-utf8', body?.text === 'Báo cáo: chữ tiếng Việt, dấu đầy đủ.' && body?.bytes > 0 && !body?.truncated,
    JSON.stringify(body));
  rmSync(dir, { recursive: true, force: true });
} catch (e) { check('body-read-utf8', false, String(e.message)); }

// 5. Watch store on NTFS: register/supersede/ack/sweep + persistence across reopen.
try {
  const dir = mkdtempSync(join(tmpdir(), 'hg-probe-w-'));
  const store = watchMod.openWatchStore(dir);
  const dev = 'd_probe0001';
  const rid = 'abcdefab-cdef-4abc-9abc-123456789abc';
  store.register({ device: dev, requestId: rid, wantBody: true, ttlMs: 60_000 });
  const pending1 = store.pendingFor(dev);
  store.register({ device: dev, requestId: rid, wantBody: false, ttlMs: 60_000 }); // supersede
  store.markDelivered(dev, rid);
  const reoffered = store.pendingFor(dev);
  const reopened = watchMod.openWatchStore(dir); // fresh instance, same disk file
  const persisted = reopened.pendingFor(dev);
  reopened.ack(dev, rid);
  const afterAck = reopened.pendingFor(dev);
  store.sweep?.(Date.now() + 61_000);
  check('watch-store', pending1.length === 1 && pending1[0].wantBody === true
    && reoffered.length === 1 && reoffered[0].wantBody === false
    && persisted.length === 1 && afterAck.length === 0,
    JSON.stringify({ pending1, reoffered, persisted, afterAck }));
  rmSync(dir, { recursive: true, force: true });
} catch (e) { check('watch-store', false, String(e.message)); }

// 6. watchReceipts: a NEW settle must reach onEntry on Windows (fs.watch or sweep).
try {
  const dir = mkdtempSync(join(tmpdir(), 'hg-probe-watch-'));
  const base = join(dir, 'base');
  const scopeDir = join(base, receipts.scopeFor(dir));
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, 'receipts.jsonl'), '', { mode: 0o600 }); // baseline sees empty
  const seen = [];
  const stop = receipts.watchReceipts(base, entry => seen.push(entry), { intervalMs: 500 });
  await new Promise(r => setTimeout(r, 1500)); // baseline
  const id = 'abcdefab-cdef-4abc-aabc-123456789abc';
  writeFileSync(join(scopeDir, 'receipts.jsonl'),
    `${JSON.stringify({ v: 1, id, status: 'failed', ts: Date.now(), sessionId: 'probe', reason: 'pi_error' })}\n`, { mode: 0o600 });
  const deadline = Date.now() + 12_000;
  while (!seen.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
  stop();
  check('watch-receipts-emits', seen.length === 1 && seen[0].id === id && seen[0].status === 'failed',
    JSON.stringify(seen));
  rmSync(dir, { recursive: true, force: true });
} catch (e) { check('watch-receipts-emits', false, String(e.message)); }

console.log(JSON.stringify({ platform: process.platform, node: process.version, results }));
process.exit(results.every(r => r.ok) ? 0 : 1);
