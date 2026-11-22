import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Wave-B observers: pure /proc sampler, Pi transcript parser, port attribution.
// Fixtures inject procDir so nothing here depends on the machine that runs it.
const { sysSnapshot } = await import('../plugin/server/sysmon.mjs');
const { parsePiTranscript } = await import('../plugin/server/pi-transcript.mjs');
const { attributePorts } = await import('../plugin/server/port-attr.mjs');

const roots: string[] = [];
const mkRoot = (tag: string) => { const r = mkdtempSync(join(tmpdir(), `hg-sysmon-${tag}-`)); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// ---- /proc fixture builders -------------------------------------------------

// Fields after the comm parenthesis mirror /proc/<pid>/stat: rest[11..14] are
// utime/stime/cutime/cstime (stat fields 14..17).
const statLine = (pid: number, o: Record<string, number | string> = {}) => {
  const { ppid = 1, utime = 0, stime = 0, cutime = 0, cstime = 0, comm = 'proc' } = o as any;
  // rest[11]=utime rest[12]=stime rest[13]=cutime rest[14]=cstime (stat fields 14..17):
  // eleven tokens after the comm — state, ppid, pgrp, session, tty, tpgid,
  // flags, minflt, cminflt, majflt, cmajflt — come before utime.
  return `${pid} (${comm}) S ${ppid} 0 0 0 -1 0 0 0 0 0 ${utime} ${stime} ${cutime} ${cstime} 0 0 1 0 0 0 0 0\n`;
};
const statmLine = (residentPages: number) => `100 ${residentPages} 20 5 0 10 0\n`;

function writeProc(dir: string, pid: number, opts: Record<string, number | string> & { resident?: number } = {}) {
  const { resident = 0, ...stat } = opts;
  mkdirSync(join(dir, String(pid)), { recursive: true });
  writeFileSync(join(dir, String(pid), 'stat'), statLine(pid, stat));
  writeFileSync(join(dir, String(pid), 'statm'), statmLine(resident));
}
const removeProc = (dir: string, pid: number) => rmSync(join(dir, String(pid)), { recursive: true, force: true });

const near = (actual: number, expected: number, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} ≈ ${expected}`);

// ---- sysmon: per-tree CPU share and RAM -------------------------------------

test('sysmon attributes a two-tier, three-process tree with exact jiffies delta', () => {
  const dir = mkRoot('tree');
  writeProc(dir, 1, { ppid: 0, comm: 'init' });
  writeProc(dir, 100, { ppid: 1, utime: 10, stime: 10, resident: 10, comm: 'shell' });
  writeProc(dir, 101, { ppid: 100, utime: 30, resident: 20, comm: 'node' });
  writeProc(dir, 102, { ppid: 100, utime: 100, stime: 50, resident: 30, comm: 'cargo' });

  let now = 5_000;
  const clock = () => now;
  const opts = { clkTck: 100, nproc: 4, clock };
  const first = sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);
  assert.equal(first.length, 1);
  assert.equal(first[0].key, 'a');
  assert.equal(first[0].cpuPct, 0); // first call is the baseline, no delta yet
  assert.equal(first[0].ramBytes, 60 * 4096);
  assert.equal(first[0].procs, 3);

  now += 2_000; // a 2s cadence tick, controlled by the injected clock
  writeProc(dir, 100, { ppid: 1, utime: 35, stime: 10, resident: 10, comm: 'shell' });
  writeProc(dir, 101, { ppid: 100, utime: 130, resident: 20, comm: 'node' });
  writeProc(dir, 102, { ppid: 100, utime: 200, stime: 150, resident: 30, comm: 'cargo' });
  const second = sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);
  // Δjiffies = 25 + 100 + 200 = 325 → 3.25 CPU-s / 2s / 4 cores × 100 = 40.625%.
  near(second[0].cpuPct, 40.625);
  assert.equal(second[0].ramBytes, 60 * 4096);
  assert.equal(second[0].procs, 3);
});

test('sysmon counts an exited child through the parent cutime fold (3-case delta)', () => {
  const dir = mkRoot('cutime');
  writeProc(dir, 1, { ppid: 0, comm: 'init' });
  writeProc(dir, 100, { ppid: 1, utime: 10, stime: 10, resident: 10, comm: 'shell' });
  writeProc(dir, 101, { ppid: 100, utime: 30, resident: 20, comm: 'node' });
  writeProc(dir, 102, { ppid: 100, utime: 40, stime: 10, comm: 'short-test' });

  let now = 10_000;
  const opts = { clkTck: 100, nproc: 4, clock: () => now };
  sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);

  // Inside the window: shell +10, child 101 +50, child 102 works +20 more
  // (lifetime 70) and exits — the kernel folds 102's whole lifetime into
  // shell 100's cutime. Its before-jiffies (50) must be subtracted so only
  // the window's work (10 + 50 + 20 = 80) is attributed.
  now += 2_000;
  writeProc(dir, 100, { ppid: 1, utime: 20, stime: 10, cutime: 70, resident: 10, comm: 'shell' });
  writeProc(dir, 101, { ppid: 100, utime: 80, resident: 20, comm: 'node' });
  removeProc(dir, 102);
  const rows = sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);
  near(rows[0].cpuPct, 80 / 100 / 2 / 4 * 100); // exactly the window's 80 jiffies
  assert.equal(rows[0].procs, 2); // the dead child is gone from the live count
  assert.equal(rows[0].ramBytes, 30 * 4096);
});

test('sysmon counts a child born inside the window in full', () => {
  const dir = mkRoot('born');
  writeProc(dir, 1, { ppid: 0, comm: 'init' });
  writeProc(dir, 100, { ppid: 1, utime: 10, stime: 10, comm: 'shell' });
  let now = 20_000;
  const opts = { clkTck: 100, nproc: 4, clock: () => now };
  sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);
  now += 2_000;
  writeProc(dir, 100, { ppid: 1, utime: 10, stime: 10, comm: 'shell' });
  writeProc(dir, 103, { ppid: 100, utime: 25, comm: 'spawned' });
  const rows = sysSnapshot([{ pid: 100, key: 'a' }], dir, opts);
  near(rows[0].cpuPct, 25 / 100 / 2 / 4 * 100);
  assert.equal(rows[0].procs, 2);
});

test('sysmon drops vanished pids and garbage stats without failing the batch', () => {
  const dir = mkRoot('torn');
  writeProc(dir, 300, { ppid: 1, utime: 5, comm: 'shell' });
  writeProc(dir, 301, { ppid: 300, utime: 5, comm: 'child' });
  let now = 30_000;
  const opts = { clkTck: 100, nproc: 4, clock: () => now };
  sysSnapshot([{ pid: 300, key: 'gone' }], dir, opts);

  // The whole tree disappears between samples, and a fresh pid holds garbage.
  now += 1_000;
  removeProc(dir, 300);
  removeProc(dir, 301);
  mkdirSync(join(dir, '302'), { recursive: true });
  writeFileSync(join(dir, '302', 'stat'), 'not a stat line at all\n');
  const rows = sysSnapshot([{ pid: 300, key: 'gone' }], dir, opts);
  assert.deepEqual(rows, [{ key: 'gone', cpuPct: 0, ramBytes: 0, procs: 0 }]);

  assert.deepEqual(sysSnapshot([{ pid: 1, key: 'x' }], join(mkRoot('no-proc'), 'missing')), []);
});

// ---- port attribution --------------------------------------------------------

const tcpRow = (sl: number, portHex: string, inode: number) =>
  ` ${sl}: 00000000000000000000000000000000:${portHex} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

function writeSocket(dir: string, pid: number, fd: string, inode: number) {
  mkdirSync(join(dir, String(pid), 'fd'), { recursive: true });
  symlinkSync(`socket:[${inode}]`, join(dir, String(pid), 'fd', fd));
}

test('port-attr attributes one listener to its shell tree and leaves the foreign one out', () => {
  const dir = mkRoot('ports');
  writeProc(dir, 1, { ppid: 0, comm: 'init' });
  writeProc(dir, 300, { ppid: 1, comm: 'bash' }); // session shell
  writeProc(dir, 301, { ppid: 300, comm: 'node' }); // dev server in the tree
  writeProc(dir, 400, { ppid: 1, comm: 'unrelated' }); // foreign listener
  mkdirSync(join(dir, 'net'), { recursive: true });
  writeFileSync(join(dir, 'net', 'tcp'), `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${tcpRow(0, '1F90', 9001)}`); // 0x1F90 = 8080
  writeFileSync(join(dir, 'net', 'tcp6'), `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${tcpRow(1, '1538', 9002)}`); // 0x1538 = 5432
  writeFileSync(join(dir, '301', 'cmdline'), 'node\0server.js\0');
  writeSocket(dir, 301, '3', 9001);
  writeSocket(dir, 400, '4', 9002);

  const { attributed, unattributed } = attributePorts([{ pid: 300, key: 'sh' }], dir);
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0].port, 8080);
  assert.equal(attributed[0].proto, 'tcp');
  assert.equal(attributed[0].pid, 301);
  assert.equal(attributed[0].cmd, 'node server.js');
  assert.equal(attributed[0].ownerKey, 'sh');
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].port, 5432);
  assert.equal(unattributed[0].proto, 'tcp6');
  assert.equal(unattributed[0].pid, 400); // pid known, owner honestly not invented

  // No shells named → every listener is unattributed, none gains an owner.
  const none = attributePorts([300], dir); // 300 itself is not a shell holder here
  assert.equal(none.attributed.length, 1); // socket holder 301 descends from 300 → attributed
  const empty = attributePorts([], dir);
  assert.equal(empty.attributed.length, 0);
  assert.equal(empty.unattributed.length, 2);

  assert.deepEqual(attributePorts([{ pid: 300, key: 'sh' }], join(dir, 'nope')), { attributed: [], unattributed: [] });
});

test('port-attr survives a ppid cycle and still answers for the other listeners', () => {
  const dir = mkRoot('cycle');
  writeProc(dir, 1, { ppid: 0, comm: 'init' });
  writeProc(dir, 500, { ppid: 501, comm: 'loopy-a' });
  writeProc(dir, 501, { ppid: 500, comm: 'loopy-b' }); // 500 ⇄ 501: neither is a shell
  mkdirSync(join(dir, 'net'), { recursive: true });
  writeFileSync(join(dir, 'net', 'tcp'), `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${tcpRow(0, '2328', 9003)}`); // 0x2328 = 9000
  writeSocket(dir, 500, '5', 9003);
  const { attributed, unattributed } = attributePorts([{ pid: 999, key: 'sh' }], dir);
  assert.equal(attributed.length, 0); // the walk must terminate, not hang
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].port, 9000);
  assert.equal(unattributed[0].pid, 500);
});

// ---- Pi transcript parser ----------------------------------------------------

const SID = '019f7d31-6b39-7dfc-b4e6-5cb8bde9c800';
const usage = (tokens: number, cost: number, extra: Record<string, number> = {}) =>
  ({ input: tokens - 300, output: 100, cacheRead: 200, cacheWrite: 0, totalTokens: tokens, ...extra, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: cost } });

function transcriptFixture() {
  const lines = [
    { type: 'session', version: 3, id: SID, timestamp: '2026-07-20T01:00:00.000Z', cwd: '/tmp' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-07-20T01:00:01.000Z', provider: 'zai', modelId: 'glm-4.6' },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-07-20T01:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1_000 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-20T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }], api: 'openai-completions', provider: 'zai', model: 'glm-4.6', timestamp: 2_000, usage: usage(1_300, 0.003) } },
    { type: 'model_change', id: 'm2', parentId: 'a1', timestamp: '2026-07-20T01:00:04.000Z', provider: 'anthropic', modelId: 'claude-opus-4' },
    { type: 'message', id: 'u2', parentId: 'm2', timestamp: '2026-07-20T01:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }], timestamp: 3_000 } },
    { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-20T01:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }], provider: 'anthropic', model: 'claude-opus-4', timestamp: 4_000, usage: usage(560, 0.005) } },
    // Compaction summarizes the tail; its own summarization call carries usage.
    { type: 'compaction', id: 'c1', parentId: 'a2', timestamp: '2026-07-20T01:00:07.000Z', summary: 'summarized', firstKeptEntryId: 'u2', tokensBefore: 40_000, usage: usage(330, 0.001) },
    { type: 'message', id: 'u3', parentId: 'c1', timestamp: '2026-07-20T01:00:08.000Z', message: { role: 'user', content: [{ type: 'text', text: 'after compact' }], timestamp: 5_000 } },
    { type: 'message', id: 'a3', parentId: 'u3', timestamp: '2026-07-20T01:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'fresh context' }], provider: 'anthropic', model: 'claude-opus-4', timestamp: 6_000, usage: usage(890, 0.004, { contextTokens: 950 }) } },
  ];
  return { lines, text: lines.map(l => JSON.stringify(l) + '\n').join('') };
}

test('pi-transcript parses model after the last model_change, context after compaction, and usage totals', () => {
  const dir = mkRoot('transcript');
  const file = join(dir, `2026-07-20T01-00-00-000Z_${SID}.jsonl`);
  writeFileSync(file, transcriptFixture().text);

  const parsed = parsePiTranscript(file);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.sessionId, SID);
  assert.equal(parsed.model, 'claude-opus-4'); // the LAST model_change on the branch
  assert.equal(parsed.modelProvider, 'anthropic');
  assert.equal(parsed.contextTokens, 950); // newest assistant usage after c1
  assert.equal(parsed.usageTotal.totalTokens, 1_300 + 560 + 330 + 890);
  near(parsed.usageTotal.costUsd, 0.013);
  assert.equal(parsed.turns, 3);
  assert.equal(parsed.lastTs, 6_000);
  assert.equal(parsed.usageCoversSession, true);
});

test('pi-transcript tail window drops the cut line and reports a lower-bound total', () => {
  const dir = mkRoot('windowed');
  const file = join(dir, `${SID}.jsonl`);
  const { lines, text } = transcriptFixture();
  writeFileSync(file, text);

  // Open the window a few bytes INSIDE the a1 line: a1 is dropped (cut, not
  // parsed) while everything from m2 on stays; the branch walk accepts that
  // a1 lives before the window.
  const a1Text = JSON.stringify(lines[3]) + '\n';
  const cutAt = Buffer.byteLength(text.slice(0, text.indexOf(a1Text))) + 3;
  const maxBytes = Buffer.byteLength(text) - cutAt;
  assert.ok(maxBytes > 0 && maxBytes < Buffer.byteLength(text));

  const parsed = parsePiTranscript(file, maxBytes);
  assert.equal(parsed.sessionId, SID); // header window still reaches the session line
  assert.equal(parsed.model, 'claude-opus-4');
  assert.equal(parsed.contextTokens, 950);
  assert.equal(parsed.turns, 2); // a2 + a3 — a1 fell out of the window
  assert.equal(parsed.usageTotal.totalTokens, 560 + 330 + 890);
  near(parsed.usageTotal.costUsd, 0.010);
  assert.equal(parsed.usageCoversSession, false); // windowed sum ≠ session total
});

test('pi-transcript falls back to the assistant model and counter sums', () => {
  const dir = mkRoot('fallback');
  const file = join(dir, `2026-07-20T02-00-00-000Z_${SID}.jsonl`);
  writeFileSync(file, [
    { type: 'session', version: 3, id: SID, timestamp: '2026-07-20T02:00:00.000Z', cwd: '/tmp' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-20T02:00:01.000Z', message: { role: 'user', content: 'hi', timestamp: 100 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-20T02:00:02.000Z', message: { role: 'assistant', content: [], provider: 'zai', model: 'glm-4.6', timestamp: 200, usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 5, cost: { total: 0.002 } } } },
    '', // trailing newline artifacts and blank lines are skipped
  ].map(l => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join(''));

  const parsed = parsePiTranscript(file);
  assert.equal(parsed.model, 'glm-4.6'); // no model_change → newest assistant message
  assert.equal(parsed.modelProvider, 'zai');
  assert.equal(parsed.contextTokens, 130); // no contextTokens/totalTokens → Σ of 4 counters
  assert.equal(parsed.usageTotal.totalTokens, 130);
  near(parsed.usageTotal.costUsd, 0.002);
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.lastTs, 200);
});

test('pi-transcript returns unreadable for broken, mismatched or absent transcripts', () => {
  const dir = mkRoot('unreadable');
  const good = transcriptFixture();
  const named = join(dir, `2026-07-20T03-00-00-000Z_${SID}.jsonl`);
  writeFileSync(named, good.text);

  const missing = parsePiTranscript(join(dir, 'nope.jsonl'));
  assert.deepEqual(missing, { error: 'unreadable', file: join(dir, 'nope.jsonl') });

  const badVersion = join(dir, `v2_${SID}.jsonl`);
  writeFileSync(badVersion, good.text.replace('"version":3', '"version":2'));
  assert.equal(parsePiTranscript(badVersion).error, 'unreadable');

  // Same bytes under a filename that does not carry the session id.
  const renamed = join(dir, '2026-07-20T03-00-00-000Z_deadbeef-0000-4000-8000-000000000000.jsonl');
  writeFileSync(renamed, good.text);
  assert.equal(parsePiTranscript(renamed).error, 'unreadable');

  const empty = join(dir, `${SID}.jsonl`);
  writeFileSync(empty, ''); // nothing written yet — not a guessable session
  assert.equal(parsePiTranscript(empty).error, 'unreadable');
});
