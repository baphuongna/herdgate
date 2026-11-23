/**
 * PWA v2 — the host ops behind the Timeline/Diff surfaces, plus the web-asset
 * contract (glyphs, ops, #pair= prefill).
 *
 * The device-channel shape is the pi-receipt-gate one, minus Herdr/Pi/tmux: a
 * local cloud, the real publisher child, a receipts journal fixture, a `git init`
 * fixture for diff.get, and a stub herdr that only answers --help probes.
 *
 *   node --test test/web-pwa2.test.ts
 */

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const hasGit = await run('git', ['--version']).then(() => true, () => false);

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (performance.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(50);
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  try { await exited; } finally { clearTimeout(timer); }
}

// Journal fixture ids must satisfy RECEIPT_ID (readJournal validates the shape).
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

type UsageReply = { op: string; generatedAt: number; total: { requests: number; tokens: number }; days: unknown[]; byPrincipal: unknown[] };
type DiffReply = { op: string; ref: string; text: string; bytes: number; truncated: boolean };

test('pwa2 ops: usage.rollup, diff.get, pane.focus over the device channel', { skip: !hasGit && 'git is required for the diff fixture' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pwa2-'));
  const log: string[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let publisher: ChildProcess | undefined;
  try {
    // --- receipts journal fixture: one replied, one failed, both valid entries
    const receipts = join(dir, 'receipts');
    mkdirSync(join(receipts, 'aaaaaaaaaaaaaaaa'), { recursive: true });
    const now = Date.now();
    writeFileSync(join(receipts, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'), [
      JSON.stringify({ v: 1, id: uid(1), status: 'replied', sessionId: '22222222-2222-4222-8222-222222222222', ts: now - 1000, principal: 'device:d_a', usage: { totalTokens: 1000, costUsd: 0.5 } }),
      JSON.stringify({ v: 1, id: uid(2), status: 'failed', reason: 'pi_error', sessionId: '22222222-2222-4222-8222-222222222222', ts: now - 2000, principal: 'schedule:nightly', usage: { totalTokens: 200, costUsd: 0.25 } }),
    ].join('\n') + '\n');

    // --- git fixture: a repo whose HEAD patch contains a known line
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 'pwa2@test']);
    await run('git', ['-C', repo, 'config', 'user.name', 'pwa2']);
    writeFileSync(join(repo, 'hello.txt'), 'one\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'first']);
    writeFileSync(join(repo, 'hello.txt'), 'one\ntwo\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'second']);
    const head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

    // --- stub herdr: answers the --help probes, logs every argv it was given
    const callsFile = join(dir, 'herdr-calls.log');
    const stub = join(dir, 'herdr-stub.sh');
    writeFileSync(stub, [
      '#!/bin/sh',
      'echo "$@" >> "$HERDR_STUB_CALLS"',
      'case "$1 $2" in',
      '  "pane --help") printf "Usage: herdr pane\\n\\nCommands:\\n  list\\n  focus\\n" ;;',
      '  "tab --help") printf "Usage: herdr tab\\n\\nCommands:\\n  list\\n" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    // --- local cloud with one room and one read-scoped device
    const accounts = [{ id: 'a1', name: 'test', token: 'pwa2-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'pwa2-host');
    const { device, secret } = state.addDevice(room, 'pwa2-device', 'read');
    cloud = await startCloud({ accounts, statePath, log: entry => log.push(entry) });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    // --- the real publisher child, pointed at the fixtures
    const config = join(dir, 'publisher');
    mkdirSync(config);
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    publisher = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
        HERDGATE_PI_RECEIPTS: '1', HERDGATE_PI_RECEIPT_DIR: receipts,
        HERDGATE_DIFF_REPO_DIR: repo, HERDR_STUB_CALLS: callsFile,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    publisher.stderr!.setEncoding('utf8').on('data', chunk => log.push(chunk));
    await waitFor('publisher connected', () => log.some(entry => entry.includes('herdgate: connected to')));

    // One device socket per question; skip unsolicited frames until the answer.
    const ask = async (payload: Record<string, unknown>, expectOp: string): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: device.id, deviceSecret: secret });
        assert.equal(hello.t, 'hello', JSON.stringify(hello));
        await sock.send({ t: 'frame', payload });
        const deadline = performance.now() + 10_000;
        for (;;) {
          const frame = await sock.expect('frame');
          const reply = frame.payload as { op?: string } | undefined;
          if (reply?.op === expectOp || reply?.op === 'error') return reply as Record<string, unknown>;
          if (performance.now() > deadline) throw new Error(`no ${expectOp} frame in time (got ${String(reply?.op)})`);
        }
      } finally { sock.close(); }
    };

    t.diagnostic('usage.rollup: the journal rolled into the raw usageRollup shape');
    const usage = await ask({ op: 'usage.rollup', days: 7 }, 'usage.rollup.result') as unknown as UsageReply;
    assert.equal(usage.op, 'usage.rollup.result');
    assert.equal(typeof usage.generatedAt, 'number');
    assert.equal(usage.total.requests, 2);
    assert.equal(usage.total.tokens, 1200);
    assert.equal(usage.days.length, 7, 'seven daily buckets, newest first');
    assert.equal(usage.byPrincipal.length, 2);
    assert.deepEqual(usage.byPrincipal.map(p => (p as { principal: string }).principal), ['device:d_a', 'schedule:nightly']);

    t.diagnostic('diff.get: a real ref ships stat + patch; injections never reach git');
    const diff = await ask({ op: 'diff.get', ref: head }, 'diff.result') as unknown as DiffReply;
    assert.equal(diff.op, 'diff.result');
    assert.equal(diff.ref, head);
    assert.match(diff.text, /diff --git a\/hello\.txt b\/hello\.txt/);
    assert.match(diff.text, /^\+two$/m);
    assert.match(diff.text, /hello\.txt \|/);
    assert.equal(diff.truncated, false);
    assert.ok(diff.bytes > 0);

    for (const bad of ['main; rm -rf /', 'HEAD$(id -u)', 'a b c', 'x&y', '']) {
      const refused = await ask({ op: 'diff.get', ref: bad }, 'diff.result');
      assert.equal(refused.op, 'error', `${JSON.stringify(bad)} must be refused`);
      assert.equal(refused.code, 'bad-ref');
    }
    const missing = await ask({ op: 'diff.get', ref: 'deadbeefdeadbeef' }, 'diff.result');
    assert.equal(missing.op, 'error');
    assert.equal(missing.code, 'diff.ref', 'a syntactically legal but unknown ref is a git-level refusal');

    t.diagnostic('a refused op never takes the host down');
    const after = await ask({ op: 'usage.rollup', days: 1 }, 'usage.rollup.result') as unknown as UsageReply;
    assert.equal(after.op, 'usage.rollup.result');
    assert.equal(after.total.requests, 2);

    t.diagnostic('pane.focus: format-gated, fire-and-forget spawn through herdr');
    const badPane = await ask({ op: 'pane.focus', paneId: 'nope; rm -rf /' }, 'pane.focused');
    assert.equal(badPane.op, 'error');
    assert.equal(badPane.code, 'bad-pane');
    const focused = await ask({ op: 'pane.focus', paneId: 'w1:p2' }, 'pane.focused');
    assert.equal(focused.op, 'pane.focused');
    assert.equal(focused.paneId, 'w1:p2');
    assert.equal(focused.via, 'pane focus');
    await waitFor('the stub herdr received pane focus w1:p2',
      () => readFileSync(callsFile, 'utf8').split('\n').includes('pane focus w1:p2'));
    t.diagnostic('pane.focus: herdr pane ids are not all digits (wG:p1) — the charset matches the term ops');
    const lettered = await ask({ op: 'pane.focus', paneId: 'wG:p1' }, 'pane.focused');
    assert.equal(lettered.op, 'pane.focused');
    assert.equal(lettered.paneId, 'wG:p1');
  } catch (err) {
    t.diagnostic(log.join('\n').slice(-4000));
    throw err;
  } finally {
    await stop(publisher);
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web assets: pwa2 markers in app.js', () => {
  const src = readFileSync(join(root, 'src/web/app.js'), 'utf8');
  for (const marker of ['◉', '◐', '●', '✓', 'usage.rollup', 'diff.get', '#pair=']) {
    assert.ok(src.includes(marker), `app.js must contain ${marker}`);
  }
});
