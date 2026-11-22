// file.tree / file.read — the read-only file viewer ops (filev pattern).
// The e2e leg mirrors git-safe's: a real git fixture repo, a stub herdr, a real
// publisher pointed at it through HERDGATE_DIFF_REPO_DIR, device frames in.
// The hostile cases are the point: traversal, absolute paths, untracked files,
// a symlink planted inside that points OUTSIDE the repo, and the size cap.

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const hasGit = await new Promise<boolean>((resolve) => execFile('git', ['--version'], (err) => resolve(!err)));
const run = promisify1(execFile);
function promisify1(fn: typeof execFile) {
  return (cmd: string, args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    fn(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
  });
}

test('file ops e2e: tracked tree, status overlay, hardened reads', { skip: !hasGit && 'git is required' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-filev-'));
  const logs: string[][] = [];
  const children: ChildProcess[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  try {
    // Fixture repo: two commits (one file then modified), an untracked file, a
    // symlink planted INSIDE pointing OUTSIDE (secret.txt at dir level), a big file.
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 'filev@test']);
    await run('git', ['-C', repo, 'config', 'user.name', 'filev']);
    writeFileSync(join(repo, 'hello.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'src', 'app.js'), 'console.log("hi");\n'.repeat(10));
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'first']);
    writeFileSync(join(repo, 'hello.txt'), 'one\ntwo\nthree\n'); // M after commit 1
    writeFileSync(join(repo, 'untracked.txt'), 'never tracked\n');
    writeFileSync(join(dir, 'secret-outside.txt'), 'outside the repo\n');
    symlinkSync(join(dir, 'secret-outside.txt'), join(repo, 'leak.txt'));
    writeFileSync(join(repo, 'big.log'), 'x'.repeat(300 * 1024)); // > 256KiB cap, tracked below
    await run('git', ['-C', repo, 'add', 'big.log']);
    await run('git', ['-C', repo, 'commit', '-qm', 'second']);

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

    const accountToken = 'filev-owner';
    const statePath = join(dir, 'state.json');
    const state = new State([{ id: 'a1', name: 'test', token: accountToken }], statePath);
    const { room, token } = state.addRoom('a1', 'filev-host');
    const { device, secret } = state.addDevice(room, 'filev-device', 'read');
    cloud = await startCloud({ accounts: [{ id: 'a1', name: 'test', token: accountToken }], statePath, log: () => {} });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    const config = join(dir, 'publisher');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    const log: string[] = [];
    logs.push(log);
    const child = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
        HERDGATE_DIFF_REPO_DIR: repo,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => log.push(chunk));
    children.push(child);

    const deadline = performance.now() + 15_000;
    while (!(log.join('').includes('herdgate: connected to') || log.join('').includes('publish'))) {
      if (performance.now() > deadline) throw new Error(`publisher did not connect:\n${log.join('')}`);
      await delay(60);
    }

    const ask = async (payload: Record<string, unknown>, expectOp: string): Promise<Record<string, unknown>> => {
      console.error('ASK', JSON.stringify(payload).slice(0, 80));
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: device.id, deviceSecret: secret });
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

    // tree: tracked only, status overlay, capped=false
    const tree = await ask({ op: 'file.tree' }, 'file.tree.result') as unknown as { op: string; files: { path: string; status: string | null }[]; capped: boolean; total: number };
    assert.equal(tree.op, 'file.tree.result');
    const paths = tree.files.map((f) => f.path);
    assert.ok(paths.includes('hello.txt'));
    assert.ok(paths.includes('src/app.js'));
    assert.ok(paths.includes('big.log'));
    assert.ok(!paths.includes('untracked.txt'), 'untracked files are invisible by design');
    assert.ok(!paths.includes('leak.txt'), 'an untracked symlink never lists');
    assert.equal(tree.files.find((f) => f.path === 'hello.txt')?.status, 'M');
    assert.equal(tree.capped, false);

    // read: the honest file, with line counts
    const read = await ask({ op: 'file.read', path: 'hello.txt' }, 'file.read.result') as unknown as { op: string; text: string; lines: number; truncated: boolean; bytes: number };
    assert.equal(read.op, 'file.read.result');
    assert.equal(read.text, 'one\ntwo\nthree\n');
    assert.equal(read.lines, 4);
    assert.equal(read.truncated, false);
    assert.equal(read.bytes, 14);

    // read: the big file reports the cap honestly
    const big = await ask({ op: 'file.read', path: 'big.log' }, 'file.read.result') as unknown as { truncated: boolean; bytes: number; text: string };
    assert.equal(big.truncated, true);
    assert.equal(big.bytes, 300 * 1024);
    assert.ok(big.text.length <= 128 * 1024, 'the view stays under the diff class cap');
    // The reply's WIRE form must fit the gate's 256KiB frame cap — an oversized
    // frame is closed by maxPayload and kills the publisher's socket.
    assert.ok(JSON.stringify(big).length < 240 * 1024, 'the envelope fits the frame budget');

    // hostile: traversal, absolute, missing, untracked, symlink escape
    const escape = async (path: string, code: string) => {
      const r = await ask({ op: 'file.read', path }, 'file.read.result') as unknown as { op: string; code: string; message: string };
      assert.equal(r.op, 'error', `${path} must be refused, got ${JSON.stringify(r).slice(0, 120)}`);
      assert.equal(r.code, code, `${path} → ${r.message}`);
    };
    await escape('../secret-outside.txt', 'bad-path');
    await escape('src/../../secret-outside.txt', 'bad-path');
    await escape('/etc/passwd', 'bad-path');
    await escape('nope.txt', 'no-file');
    await escape('untracked.txt', 'no-file');
    await escape('leak.txt', 'bad-path'); // symlink inside → outside: caught at realpath
    t.diagnostic('traversal/absolute/untracked/symlink-escape all refused with named codes');
  } finally {
    for (const c of children) c.kill();
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fuzzy: basename-weighted subsequence ranking + smartcase search', async () => {
  await import(pathToFileURL(join(root, 'src/web/fuzzy.js')).href);
  const { matchAndRank, searchLine } = (globalThis as { hgFuzzy: { matchAndRank: (q: string, c: string[]) => number[]; searchLine: (l: string, q: string) => number[][] } }).hgFuzzy;
  const files = ['src/cloud/gateway.ts', 'src/web/app.js', 'test/web.test.ts', 'app.css'];
  // "appj" — the basename of app.js eats the whole query: beats longer paths.
  const ranked = matchAndRank('appj', files);
  assert.equal(files[ranked[0]], 'src/web/app.js');
  // A directory-only query cannot beat a basename hit.
  assert.deepEqual(matchAndRank('', files), []);
  assert.ok(matchAndRank('zzz', files).length === 0);
  // Tight runs beat scattered ones (gw vs gateway scattering).
  const two = ['a/b/xxxx.ts', 'a/gw.ts'];
  assert.equal(two[matchAndRank('gw', two)[0]], 'a/gw.ts');
  // Smartcase: lowercase matches anywhere; uppercase pins case.
  assert.deepEqual(searchLine('const Push = push', 'push'), [[6, 10], [13, 17]]);
  assert.deepEqual(searchLine('const Push = push', 'Push'), [[6, 10]]);
  assert.deepEqual(searchLine('nothing here', 'push'), []);
});
