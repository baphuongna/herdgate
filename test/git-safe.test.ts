/**
 * Hardened git reads (wave A1) — plugin/server/git-safe.mjs.
 *
 * Every git call the plugin makes on behalf of a device payload must be
 * harmless and fail-closed. The fixture is deliberately hostile: a textconv
 * diff driver (the one external-diff family that fires even inside `git show`),
 * a diff.external driver, core.hooksPath pointing at a dir of failing hooks,
 * core.fsmonitor=true, a lying pager. gitRead must still read the true content,
 * GIT_DIR/GIT_WORK_TREE from the publisher's env must never reach the child,
 * args outside the whitelist and cwds outside {plugin dir, HERDGATE_DIFF_REPO_DIR}
 * must be refused — and the diff.get device-frame op keeps its exact old shape.
 *
 *   node --test test/git-safe.test.ts
 */

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { diffRepoDir, gitRead, PLUGIN_DIR, scrubEnv } from '../plugin/server/git-safe.mjs';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const hasGit = await run('git', ['--version']).then(() => true, () => false);

type Hostile = {
  repo: string;
  head: string;
  prev: string;
  textconvRan: string;
  extdiffRan: string;
  hookRan: string;
};

/** A repo whose config tries to execute through every read: textconv driver
 *  (fires inside `git show` too), diff.external (fires inside `git diff`), a
 *  hooks dir full of failing hooks via core.hooksPath, fsmonitor "on". */
async function hostileRepo(dir: string): Promise<Hostile> {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  await run('git', ['-C', repo, 'init', '-q']);
  await run('git', ['-C', repo, 'config', 'user.email', 'gitsafe@test']);
  await run('git', ['-C', repo, 'config', 'user.name', 'gitsafe']);
  writeFileSync(join(repo, 'hello.txt'), 'one\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-qm', 'first']);
  writeFileSync(join(repo, 'hello.txt'), 'one\ntwo\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-qm', 'second']);
  const head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const prev = (await run('git', ['-C', repo, 'rev-parse', 'HEAD~1'])).stdout.trim();

  const marker = (name: string) => join(dir, name);
  const sh = (path: string, body: string) => {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  const conv = join(dir, 'evil-conv.sh');
  sh(conv, `#!/bin/sh\ntouch ${JSON.stringify(marker('TEXTCONV-RAN'))}\necho PWNED-BY-TEXTCONV\n`);
  const ext = join(dir, 'evil-ext.sh');
  sh(ext, `#!/bin/sh\ntouch ${JSON.stringify(marker('EXTDIFF-RAN'))}\nexit 1\n`);
  writeFileSync(join(repo, '.gitattributes'), '*.txt diff=evil\n');
  const hooksDir = join(dir, 'evil-hooks');
  mkdirSync(hooksDir);
  for (const hook of ['fsmonitor', 'post-checkout', 'pre-auto-gc']) {
    sh(join(hooksDir, hook), `#!/bin/sh\ntouch ${JSON.stringify(marker('HOOK-RAN'))}\nexit 1\n`);
  }
  await run('git', ['-C', repo, 'config', 'diff.evil.textconv', conv]);
  await run('git', ['-C', repo, 'config', 'diff.external', ext]);
  await run('git', ['-C', repo, 'config', 'core.hooksPath', hooksDir]);
  await run('git', ['-C', repo, 'config', 'core.fsmonitor', 'true']);
  await run('git', ['-C', repo, 'config', 'core.pager', 'echo PWNED']);
  return { repo, head, prev, textconvRan: marker('TEXTCONV-RAN'), extdiffRan: marker('EXTDIFF-RAN'), hookRan: marker('HOOK-RAN') };
}

/** The control that keeps the hardened assertions honest: without gitRead's
 *  flags, this exact fixture really does execute the drivers. */
test('control: the hostile fixture fires on unhardened git', { skip: !hasGit && 'git is required' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-gitsafe-ctl-'));
  try {
    const h = await hostileRepo(dir);
    await run('git', ['-C', h.repo, 'show', '--no-color', '--stat', '--patch', 'HEAD']);
    assert.ok(existsSync(h.textconvRan), 'the textconv driver ran inside an unhardened git show');
    // The external driver exit(1)s and git dies with it — that IS the attack:
    // the unhardened read is broken by hostile config. Only the marker matters.
    await run('git', ['-C', h.repo, 'diff', h.prev]).catch(() => {});
    assert.ok(existsSync(h.extdiffRan), 'diff.external ran on an unhardened git diff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitRead: hostile hooks/config neutralized, GIT_* scrubbed, bad args/cwds refused', { skip: !hasGit && 'git is required' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-gitsafe-'));
  const saved = {
    diffRepo: process.env.HERDGATE_DIFF_REPO_DIR,
    gitDir: process.env.GIT_DIR,
    workTree: process.env.GIT_WORK_TREE,
  };
  try {
    const h = await hostileRepo(dir);
    // A decoy repository: if GIT_DIR from the environment ever reached the
    // child, git would read THIS one instead of the fixture.
    const decoy = join(dir, 'decoy');
    mkdirSync(decoy, { recursive: true });
    await run('git', ['-C', decoy, 'init', '-q']);
    await run('git', ['-C', decoy, 'config', 'user.email', 'decoy@test']);
    await run('git', ['-C', decoy, 'config', 'user.name', 'decoy']);
    writeFileSync(join(decoy, 'decoy.txt'), 'wrong repo\n');
    await run('git', ['-C', decoy, 'add', '.']);
    await run('git', ['-C', decoy, 'commit', '-qm', 'decoy']);

    process.env.HERDGATE_DIFF_REPO_DIR = h.repo;
    assert.equal(diffRepoDir(), h.repo, 'diffRepoDir follows the test override');

    // 1 — the hostile repo still reads, and nothing hostile executed.
    const show = await gitRead(['show', '--no-color', '--stat', '--patch', 'HEAD']);
    assert.match(show.stdout, /diff --git a\/hello\.txt b\/hello\.txt/);
    assert.match(show.stdout, /^\+two$/m);
    assert.match(show.stdout, /hello\.txt \|/);
    assert.doesNotMatch(show.stdout, /PWNED/);
    assert.ok(!existsSync(h.textconvRan), 'the textconv driver never ran');
    assert.ok(!existsSync(h.extdiffRan), 'diff.external never ran');
    assert.ok(!existsSync(h.hookRan), 'no hook from the hostile hooksPath ran');

    // 2 — the diff-family read (the pipeline's reviewer stat path) is equally hardened.
    const diff = await gitRead(['diff', h.prev]);
    assert.match(diff.stdout, /^\+two$/m);
    assert.ok(!existsSync(h.extdiffRan));
    assert.ok(!existsSync(h.textconvRan));

    // 3 — the -c overrides demonstrably reach git, beating the hostile config.
    assert.equal((await gitRead(['config', 'core.hooksPath'])).stdout.trim(), '', 'core.hooksPath is overridden to empty');
    assert.equal((await gitRead(['config', 'core.fsmonitor'])).stdout.trim(), 'false', 'core.fsmonitor is overridden to false');

    // 4 — GIT_DIR/GIT_WORK_TREE from this process never reach the child.
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    const pinned = await gitRead(['show', '--no-color', 'HEAD']);
    assert.match(pinned.stdout, /hello\.txt/);
    assert.doesNotMatch(pinned.stdout, /decoy\.txt/, 'GIT_DIR did not redirect the read');
    assert.ok(!existsSync(h.textconvRan));
    // control: the very same environment DOES redirect an unhardened git call.
    const followed = await run('git', ['-C', h.repo, 'show', '--no-color', 'HEAD']);
    assert.match(followed.stdout, /decoy\.txt/, 'control — without the scrub, GIT_DIR wins');
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;

    // 5 — the scrubbed env is exactly PATH/HOME/LANG + GIT_OPTIONAL_LOCKS=0.
    const env = scrubEnv();
    assert.ok(
      Object.keys(env).every(k => ['PATH', 'HOME', 'LANG', 'GIT_OPTIONAL_LOCKS'].includes(k)),
      `scrubEnv carries only the allowed keys, got ${JSON.stringify(Object.keys(env))}`,
    );
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0', 'a read never takes the index lock');
    assert.ok(!('GIT_DIR' in env) && !('GIT_WORK_TREE' in env) && !('GIT_CONFIG_COUNT' in env));

    // 6 — args outside the whitelist are refused before git is ever spawned.
    const badArgs = ['main; rm -rf /', 'HEAD$(id -u)', 'a b c', 'x&y', '', '--upload-pack=/bin/evil', '-Oevil', 'x\ny', '`id`'];
    for (const bad of badArgs) {
      await assert.rejects(
        gitRead(['show', bad]),
        err => {
          assert.equal((err as NodeJS.ErrnoException).code, 'GIT_SAFE_ARG');
          return true;
        },
        `${JSON.stringify(bad)} must be refused`,
      );
    }
    await assert.rejects(gitRead([]), /non-empty array/);
    await assert.rejects(gitRead(['show', 42 as unknown as string], h.repo), /GIT_SAFE_ARG|refuses arg/);
    // and no marker appeared while all those refusals happened
    assert.ok(!existsSync(h.textconvRan) && !existsSync(h.extdiffRan) && !existsSync(h.hookRan));

    // 7 — a cwd outside {plugin dir, HERDGATE_DIFF_REPO_DIR} is refused: the
    //     payload can never choose where git runs.
    await assert.rejects(gitRead(['show', 'HEAD'], dir), err => (err as NodeJS.ErrnoException).code === 'GIT_SAFE_CWD');
    await assert.rejects(gitRead(['show', 'HEAD'], decoy), err => (err as NodeJS.ErrnoException).code === 'GIT_SAFE_CWD');
    delete process.env.HERDGATE_DIFF_REPO_DIR;
    assert.equal(diffRepoDir(), PLUGIN_DIR, 'without the override, reads stay pinned to the plugin dir');
  } finally {
    if (saved.diffRepo === undefined) delete process.env.HERDGATE_DIFF_REPO_DIR;
    else process.env.HERDGATE_DIFF_REPO_DIR = saved.diffRepo;
    if (saved.gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.gitDir;
    if (saved.workTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.workTree;
    rmSync(dir, { recursive: true, force: true });
  }
});

type DiffReply = { op: string; ref: string; text: string; bytes: number; truncated: boolean };

test('diff.get e2e over the device frame: same old shape, hardened underneath', { skip: !hasGit && 'git is required' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-gitsafe-e2e-'));
  const logs: string[][] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  const children: ChildProcess[] = [];
  try {
    const h = await hostileRepo(dir);
    const notARepo = join(dir, 'not-a-repo');
    mkdirSync(notARepo);

    // stub herdr: answers only the --help probes; snapshots fail gracefully.
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

    const accounts = [{ id: 'a1', name: 'test', token: 'gitsafe-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    // Rooms/devices must exist in statePath BEFORE the cloud constructs its own
    // State (the web-pwa2 order) — a room minted afterwards is unknown to it.
    const prep = (name: string) => {
      const { room, token } = state.addRoom('a1', `${name}-host`);
      const { device, secret } = state.addDevice(room, `${name}-device`, 'read');
      return { token, device: device.id, secret };
    };
    const hostileCred = prep('hostile');
    const bareCred = prep('norepo');
    cloud = await startCloud({ accounts, statePath, log: () => {} });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    const startPublisher = (name: string, diffRepo: string, cred: { token: string; device: string; secret: string }) => {
      const config = join(dir, name);
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud!.port}\nHERDGATE_ROOM_TOKEN=${cred.token}\n`, { mode: 0o600 });
      const log: string[] = [];
      logs.push(log);
      const child = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH, HOME: dir,
          HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
          HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
          HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
          HERDGATE_DIFF_REPO_DIR: diffRepo,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr!.setEncoding('utf8').on('data', chunk => log.push(chunk));
      children.push(child);
      return { device: cred.device, secret: cred.secret };
    };

    const waitFor = async (label: string, check: () => boolean | Promise<boolean>) => {
      const deadline = performance.now() + 10_000;
      for (;;) {
        if (await check()) return;
        if (performance.now() > deadline) throw new Error(`timed out: ${label}\n${logs.flat().join('').slice(-2000)}`);
        await delay(50);
      }
    };

    const hostile = startPublisher('hostile', h.repo, hostileCred);
    const bare = startPublisher('norepo', notARepo, bareCred);
    await waitFor('publishers connected', async () =>
      logs.length === 2 && logs.every(l => l.join('').includes('herdgate: connected to')));

    const ask = async (device: string, secret: string, payload: Record<string, unknown>, expectOp: string): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device, deviceSecret: secret });
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

    t.diagnostic('diff.get on the hostile repo: old shape, true content, nothing executed');
    const diff = await ask(hostile.device, hostile.secret, { op: 'diff.get', ref: h.head }, 'diff.result') as unknown as DiffReply;
    assert.equal(diff.op, 'diff.result');
    assert.equal(diff.ref, h.head);
    assert.match(diff.text, /diff --git a\/hello\.txt b\/hello\.txt/);
    assert.match(diff.text, /^\+two$/m);
    assert.match(diff.text, /hello\.txt \|/);
    assert.equal(diff.truncated, false);
    assert.ok(diff.bytes > 0);
    assert.ok(!existsSync(h.textconvRan) && !existsSync(h.extdiffRan) && !existsSync(h.hookRan),
      'no hostile driver or hook executed behind the device frame');

    t.diagnostic('refusing junk refs with the same old error codes');
    for (const bad of ['main; rm -rf /', 'HEAD$(id -u)', 'a b c', 'x&y', '']) {
      const refused = await ask(hostile.device, hostile.secret, { op: 'diff.get', ref: bad }, 'diff.result');
      assert.equal(refused.op, 'error', `${JSON.stringify(bad)} must be refused`);
      assert.equal(refused.code, 'bad-ref');
    }
    const missing = await ask(hostile.device, hostile.secret, { op: 'diff.get', ref: 'deadbeefdeadbeef' }, 'diff.result');
    assert.equal(missing.op, 'error');
    assert.equal(missing.code, 'diff.ref', 'a syntactically legal but unknown ref is a git-level refusal');

    t.diagnostic('a non-repo diff dir keeps the diff.repo error code');
    const norepo = await ask(bare.device, bare.secret, { op: 'diff.get', ref: 'HEAD' }, 'diff.result');
    assert.equal(norepo.op, 'error');
    assert.equal(norepo.code, 'diff.repo');

    t.diagnostic('the publisher survives every refusal');
    const after = await ask(hostile.device, hostile.secret, { op: 'diff.get', ref: h.prev }, 'diff.result') as unknown as DiffReply;
    assert.equal(after.op, 'diff.result');
    assert.match(after.text, /diff --git a\/hello\.txt b\/hello\.txt/);
    assert.match(after.text, /^\+one$/m, 'the first commit still reads after all the refusals');
  } catch (err) {
    t.diagnostic(logs.flat().join('\n').slice(-4000));
    throw err;
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: pipeline and publisher go through the hardened reader', async () => {
  for (const file of ['plugin/server/git-safe.mjs', 'plugin/server/index.mjs', 'experiments/pi-spawn/pipeline.mjs']) {
    await run(process.execPath, ['--check', join(root, file)]);
  }
  const pipeline = readFileSync(join(root, 'experiments/pi-spawn/pipeline.mjs'), 'utf8');
  assert.ok(pipeline.includes("gitRead(['-C', worktree, 'diff', '--stat'])"), 'the reviewer diff read goes through gitRead');
  assert.ok(pipeline.includes('env: scrubEnv()'), 'git writes run with the scrubbed env');
  const index = readFileSync(join(root, 'plugin/server/index.mjs'), 'utf8');
  assert.ok(index.includes('gitRead(["show", "--no-color", "--stat", "--patch", ref]'), 'diff.get reads through gitRead');
  assert.ok(!index.includes('execFile("git"'), 'no raw git execFile call remains in the publisher');
});
