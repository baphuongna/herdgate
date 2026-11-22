// review.files / review.diff / review.send — the mobile review loop (reviewr
// pattern). The e2e leg runs a real fixture repo through the publisher: three
// scopes (uncommitted / branch / turn — turn anchored by the git-anchors
// journal, receipts carry no hashes), then the act-gated send into the Pi
// worker queue as a <file-comments> block.

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';

const root = new URL('..', import.meta.url).pathname;
const hasGit = await new Promise<boolean>((resolve) => execFile('git', ['--version'], (err) => resolve(!err)));
const run = (cmd: string, args: string[]) => new Promise<{ stdout: string }>((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
});

test('review ops e2e: three scopes, anchors, act-gated send', { skip: !hasGit && 'git is required' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-review-'));
  const children: ChildProcess[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  try {
    // Fixture: main has two commits, then a feature branch adds a third. The
    // uncommitted layer rides on top (two edits + one untracked file).
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    await run('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    await run('git', ['-C', repo, 'config', 'user.email', 'review@test']);
    await run('git', ['-C', repo, 'config', 'user.name', 'review']);
    writeFileSync(join(repo, 'base.txt'), 'a\n');
    writeFileSync(join(repo, 'new.txt'), 'n1\nn2\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'first']);
    writeFileSync(join(repo, 'base.txt'), 'a\nb line\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'second']);
    const headSecond = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await run('git', ['-C', repo, 'checkout', '-qb', 'feature']);
    writeFileSync(join(repo, 'base.txt'), 'a\nb line\nc line\n');
    writeFileSync(join(repo, 'feat.txt'), 'feat\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'third']);
    const headThird = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    // The uncommitted layer.
    writeFileSync(join(repo, 'new.txt'), 'n1\nn2\nn3\n');
    writeFileSync(join(repo, 'base.txt'), 'a\nb line\nc line\ndirty\n');
    writeFileSync(join(repo, 'fresh.txt'), 'never tracked\n');

    const stub = join(dir, 'herdr-stub.sh');
    writeFileSync(stub, [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "pane --help") printf "Usage: herdr pane\\n\\nCommands:\\n  list\\n  focus\\n" ;;',
      '  "tab --help") printf "Usage: herdr tab\\n\\nCommands:\\n  list\\n" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const accountToken = 'review-owner';
    const statePath = join(dir, 'state.json');
    const state = new State([{ id: 'a1', name: 'test', token: accountToken }], statePath);
    const { room, token } = state.addRoom('a1', 'review-host');
    const reader = state.addDevice(room, 'review-reader', 'read');
    const actor = state.addDevice(room, 'review-actor', 'act');
    cloud = await startCloud({ accounts: [{ id: 'a1', name: 'test', token: accountToken }], statePath, log: () => {} });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    const config = join(dir, 'publisher');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    // The anchors journal: seeded exactly as two settles would have left it —
    // boot at "second", settle at "third". `turn` = second..third = commit 3.
    writeFileSync(join(config, 'git-anchors.json'), JSON.stringify({
      v: 1,
      anchors: [
        { head: headSecond, at: 1, reason: 'boot' },
        { head: headThird, at: 2, reason: 'settle' },
      ],
    }, null, 2));
    const workerDir = join(dir, 'worker');
    mkdirSync(workerDir, { recursive: true });

    const log: string[] = [];
    const child = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
        HERDGATE_DIFF_REPO_DIR: repo,
        HERDGATE_PI_WORKER: '1', HERDGATE_PI_WORKER_DIR: workerDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => log.push(chunk));
    children.push(child);

    const deadline = performance.now() + 15_000;
    while (!log.join('').includes('herdgate: connected to')) {
      if (performance.now() > deadline) throw new Error(`publisher did not connect:\n${log.join('')}`);
      await delay(60);
    }

    const ask = async (payload: Record<string, unknown>, expectOp: string, dev = reader): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: dev.device.id, deviceSecret: dev.secret });
        assert.equal(hello.t, 'hello');
        await sock.send({ t: 'frame', payload });
        const until = performance.now() + 10_000;
        for (;;) {
          const frame = await sock.expect('frame');
          const reply = frame.payload as { op?: string } | undefined;
          if (reply?.op === expectOp || reply?.op === 'error') return reply as Record<string, unknown>;
          if (performance.now() > until) throw new Error(`no ${expectOp} (got ${String(reply?.op)})`);
        }
      } finally { sock.close(); }
    };

    // uncommitted: the two dirty files with stats, plus the untracked overlay.
    const unc = await ask({ op: 'review.files', scope: 'uncommitted' }, 'review.files.result') as unknown as
      { op: string; files: { path: string; plus: number | null; minus: number | null; status?: string }[] };
    assert.equal(unc.op, 'review.files.result');
    const uncMap = new Map(unc.files.map((f) => [f.path, f]));
    assert.ok(uncMap.has('base.txt'), 'base.txt is dirty');
    assert.equal(uncMap.get('new.txt')?.plus, 1);
    assert.equal(uncMap.get('new.txt')?.minus, 0);
    assert.equal(uncMap.get('fresh.txt')?.status, '??', 'untracked rides the porcelain overlay');
    assert.equal(uncMap.get('fresh.txt')?.plus, null);
    assert.ok(!uncMap.has('feat.txt'), 'committed work is not in the uncommitted scope');

    // branch: three-dot against main — exactly the feature commit.
    const br = await ask({ op: 'review.files', scope: 'branch' }, 'review.files.result') as unknown as
      { op: string; base: string; files: { path: string }[] };
    assert.equal(br.op, 'review.files.result');
    assert.deepEqual(br.files.map((f) => f.path).sort(), ['base.txt', 'feat.txt']);
    assert.ok(br.base && br.base.length >= 7, 'branch reports its merge base');

    // turn: second..third — the last settled turn, no more, no less.
    const turn = await ask({ op: 'review.files', scope: 'turn' }, 'review.files.result') as unknown as
      { op: string; base: string; files: { path: string }[] };
    assert.equal(turn.op, 'review.files.result');
    assert.deepEqual(turn.files.map((f) => f.path).sort(), ['base.txt', 'feat.txt']);
    assert.equal(turn.base, headSecond, 'the turn base is the previous settle head');

    // one file's patch, with the marker line and a hunk header
    const diff = await ask({ op: 'review.diff', scope: 'turn', path: 'base.txt' }, 'review.diff.result') as unknown as
      { op: string; text: string; truncated: boolean };
    assert.equal(diff.op, 'review.diff.result');
    assert.match(diff.text, /\+c line/);
    assert.match(diff.text, /@@/);
    assert.equal(diff.truncated, false);

    // refused: bad scope, bad path, missing anchors
    const badScope = await ask({ op: 'review.files', scope: 'everything' }, 'review.files.result') as unknown as { op: string; code: string };
    assert.equal(badScope.op, 'error');
    assert.equal(badScope.code, 'bad-scope');
    const badPath = await ask({ op: 'review.diff', scope: 'turn', path: '../outside.txt' }, 'review.diff.result') as unknown as { op: string; code: string };
    assert.equal(badPath.code, 'bad-path');
    writeFileSync(join(config, 'git-anchors.json'), JSON.stringify({ v: 1, anchors: [{ head: headThird, at: 3, reason: 'boot' }] }));
    const noAnchor = await ask({ op: 'review.files', scope: 'turn' }, 'review.files.result') as unknown as { op: string; code: string };
    assert.equal(noAnchor.code, 'no-anchor', 'one anchor is not a turn boundary');
    t.diagnostic('scopes, anchors and hardening verified');

    // send: read devices never ship comments; act devices do, into the queue.
    const denied = await ask({ op: 'review.send', comments: [{ path: 'base.txt', line: 2, text: 'sửa dòng này' }] }, 'review.sent') as unknown as { op: string; code: string };
    assert.equal(denied.code, 'requires-act');
    const malformed = await ask({ op: 'review.send', comments: [{ path: 'base.txt', line: 0, text: 'x' }] }, 'review.sent', actor) as unknown as { op: string; code: string };
    assert.equal(malformed.code, 'bad-comment');
    const empty = await ask({ op: 'review.send', comments: [] }, 'review.sent', actor) as unknown as { op: string; code: string };
    assert.equal(empty.code, 'bad-comments');
    const sent = await ask({ op: 'review.send', comments: [
      { path: 'base.txt', line: 2, text: 'sửa dòng này' },
      { path: 'feat.txt', line: 1, endLine: 3, text: 'thiếu guard' },
    ] }, 'review.sent', actor) as unknown as { op: string; count: number; state: string; id: string };
    assert.equal(sent.op, 'review.sent');
    assert.equal(sent.count, 2);
    assert.equal(sent.state, 'queued');
    const queued = readFileSync(join(workerDir, 'jobs.jsonl'), 'utf8');
    assert.match(queued, /<file-comments>/);
    assert.match(queued, /base\.txt:2 — sửa dòng này/);
    assert.match(queued, /feat\.txt:1-3 — thiếu guard/);
    t.diagnostic('review.send lands in the worker queue as a structured block');
  } finally {
    for (const c of children) c.kill();
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

