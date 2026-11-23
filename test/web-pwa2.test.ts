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

    // --- local cloud with one room: a read device and an act device
    const accounts = [{ id: 'a1', name: 'test', token: 'pwa2-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'pwa2-host');
    const { device, secret } = state.addDevice(room, 'pwa2-device', 'read');
    const actPair = state.addDevice(room, 'pwa2-act', 'act');
    const act = { device: actPair.device.id, secret: actPair.secret };
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
    const ask = async (payload: Record<string, unknown>, expectOp: string, as: { device: string; secret: string } = { device: device.id, secret }): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: as.device, deviceSecret: as.secret });
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

    t.diagnostic('pane.focus: act-gated, format-gated, fire-and-forget spawn through herdr');
    const readTry = await ask({ op: 'pane.focus', paneId: 'w1:p2' }, 'pane.focused');
    assert.equal(readTry.op, 'error', 'a read device must not steer the user\u2019s screen');
    assert.equal(readTry.code, 'requires-act');
    const badPane = await ask({ op: 'pane.focus', paneId: 'nope; rm -rf /' }, 'pane.focused', act);
    assert.equal(badPane.op, 'error');
    assert.equal(badPane.code, 'bad-pane');
    const focused = await ask({ op: 'pane.focus', paneId: 'w1:p2' }, 'pane.focused', act);
    assert.equal(focused.op, 'pane.focused');
    assert.equal(focused.paneId, 'w1:p2');
    assert.equal(focused.via, 'pane focus');
    await waitFor('the stub herdr received pane focus w1:p2',
      () => readFileSync(callsFile, 'utf8').split('\n').includes('pane focus w1:p2'));
    t.diagnostic('pane.focus: herdr pane ids are not all digits (wG:p1) — the charset matches the term ops');
    const lettered = await ask({ op: 'pane.focus', paneId: 'wG:p1' }, 'pane.focused', act);
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

test('pwa2 act ops: tab.create/tab.close — a phone owns only the tabs it made', { skip: !hasGit && 'git is required' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pwa2-tabs-'));
  const log: string[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let publisher: ChildProcess | undefined;
  const stop = async (p?: ChildProcess) => { if (p) { p.kill('SIGKILL'); await new Promise(r => setTimeout(r, 200)); } };
  try {
    const callsFile = join(dir, 'herdr-calls.log');
    const stub = join(dir, 'herdr-stub.sh');
    writeFileSync(stub, [
      '#!/bin/sh',
      'echo "$@" >> "$HERDR_STUB_CALLS"',
      'case "$1" in',
      '  tab)',
      '    case "$2" in',
      '      create) printf \'{"id":"cli:tab:create","result":{"tab":{"tab_id":"w8:tP1"},"root_pane":{"pane_id":"w8:pP1"},"type":"tab_created"}}\\n\' ;;',
      '      close) printf \'{"id":"cli:tab:close","result":{"type":"ok"}}\\n\' ;;',
      '    esac ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const accounts = [{ id: 'a1', name: 'test', token: 'pwa2-tabs-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'tabs-host');
    const read = state.addDevice(room, 'reader', 'read');
    const asRead = { device: read.device.id, secret: read.secret };
    const act1 = state.addDevice(room, 'act-one', 'act');
    const asAct1 = { device: act1.device.id, secret: act1.secret };
    const act2 = state.addDevice(room, 'act-two', 'act');
    const asAct2 = { device: act2.device.id, secret: act2.secret };
    cloud = await startCloud({ accounts, statePath, log: () => {} });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    const config = join(dir, 'publisher');
    mkdirSync(config);
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    const spawnPub = () => {
      const p = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH, HOME: dir,
          HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
          HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
          HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1', HERDR_STUB_CALLS: callsFile,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      p.stderr!.setEncoding('utf8').on('data', chunk => log.push(chunk));
      return p;
    };
    publisher = spawnPub();
    await waitFor('publisher connected', () => log.some(entry => entry.includes('herdgate: connected to')));

    const ask = async (payload: Record<string, unknown>, expectOp: string, as: { device: string; secret: string }): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: as.device, deviceSecret: as.secret });
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

    // Read devices cannot open tabs.
    const readTry = await ask({ op: 'tab.create', label: 'nope' }, 'tab.created', asRead);
    assert.equal(readTry.op, 'error');
    assert.equal(readTry.code, 'requires-act');

    // A junk label is refused before any herdr call.
    const junk = await ask({ op: 'tab.create', label: 'bad\u0007label' }, 'tab.created', asAct1);
    assert.equal(junk.code, 'bad-label');

    // act1 creates a tab: the stub herdr receives tab create --label, the reply
    // carries the ids, and the ownership map remembers whose tab it is.
    const made = await ask({ op: 'tab.create', label: 'phone-notes' }, 'tab.created', asAct1);
    assert.equal(made.op, 'tab.created');
    assert.equal(made.tabId, 'w8:tP1');
    assert.equal(made.paneId, 'w8:pP1');
    await waitFor('the stub herdr received tab create --label phone-notes',
      () => readFileSync(callsFile, 'utf8').split('\n').some(l => l.includes('tab create --label phone-notes')));

    // Nobody else may close it — not another act device.
    const stranger = await ask({ op: 'tab.close', tabId: 'w8:tP1' }, 'tab.closed', asAct2);
    assert.equal(stranger.op, 'error');
    assert.equal(stranger.code, 'not-yours', 'another act device does not own the tab');
    // Nor an unknown tab id.
    const alien = await ask({ op: 'tab.close', tabId: 'w8:tZZZ' }, 'tab.closed', asAct1);
    assert.equal(alien.code, 'not-yours');

    // The owner closes it: herdr tab close runs, the map entry is retired.
    const closed = await ask({ op: 'tab.close', tabId: 'w8:tP1' }, 'tab.closed', asAct1);
    assert.equal(closed.op, 'tab.closed');
    await waitFor('the stub herdr received tab close w8:tP1',
      () => readFileSync(callsFile, 'utf8').split('\n').some(l => l.includes('tab close w8:tP1')));
    const again = await ask({ op: 'tab.close', tabId: 'w8:tP1' }, 'tab.closed', asAct1);
    assert.equal(again.code, 'not-yours', 'a closed tab is no longer owned by anyone');

    // Ownership survives a publisher restart: create, restart, close.
    const kept = await ask({ op: 'tab.create', label: 'keepme' }, 'tab.created', asAct1);
    assert.equal(kept.op, 'tab.created');
    await stop(publisher);
    publisher = spawnPub();
    await waitFor('publisher reconnected', () => log.filter(e => e.includes('herdgate: connected to')).length >= 2);
    const afterRestart = await ask({ op: 'tab.close', tabId: 'w8:tP1' }, 'tab.closed', asAct1);
    assert.equal(afterRestart.op, 'tab.closed', 'the map lives in the state file, not in memory');
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
