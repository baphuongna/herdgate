import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readSpawns, spawnsFileFor } from '../experiments/pi-spawn/registry.mjs';

const run = promisify(execFile);
const herdr = process.env.TEST_HERDR_BIN;
const pi = process.env.TEST_PI_BIN;
const root = join(import.meta.dirname, '..');
const pipeline = join(root, 'experiments/pi-spawn/pipeline.mjs');
// Fails while pipe-answer.mjs is missing/wrong (1 + 1), passes once it exports 4.
const TEST_CMD = 'node -e "import(process.cwd() + \'/pipe-answer.mjs\').then(m => process.exit(m.default === 4 ? 0 : 1)).catch(() => process.exit(1))"';

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}

type StateStep = { step: string; phase?: string; role?: string; label?: string; exit?: number; note?: string; reason?: string };
type PipeReport = {
  v: number; id: string; repo: string; branch: string; worktree: string;
  agents: { worker: { id: string; name: string; pane: string; bound: boolean }; reviewer: { id: string; name: string; pane: string; bound: boolean } };
  attempts: number; retries: number; testCmd: string; testExit: number;
  review: { verdict: string; reason: string | null }; fixtureDir: string | null; nextAction: string;
};

// Linux integration only, hermetically isolated through HERDR_SOCKET_PATH: the
// user's running Herdr server is never touched, and no real model is called.
// TEST_HERDR_BIN=$(command -v herdr) TEST_PI_BIN=$(command -v pi) node --test test/pi-pipeline.test.ts
test('pipeline e2e: worktree+bootstrap → agent → test fails → same-agent retry → reviewer PASS → report → guarded clean', {
  skip: (process.platform !== 'linux' || !herdr || !pi) && 'requires TEST_HERDR_BIN and TEST_PI_BIN on Linux',
  timeout: 120_000,
}, async t => {
  assert.ok(herdr && pi);
  const dir = mkdtempSync(join(tmpdir(), 'hg-pipe-e2e-'));
  const home = join(dir, 'home');
  const config = join(home, 'config', 'herdr');
  mkdirSync(config, { recursive: true });
  const configFile = join(config, 'config.toml');
  writeFileSync(configFile, 'onboarding = false\n[remote]\nmanage_ssh_config = false\n');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/sh',
    HERDR_CONFIG_PATH: configFile, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'), HERDR_SOCKET_PATH: join(dir, 'herdr.sock'), PI_TELEMETRY: '0',
  };
  const repo = join(dir, 'repo');
  const receipts = join(dir, 'receipts');
  let server: ChildProcess | undefined;
  let workspaceId: string | undefined;
  const cli = (...args: string[]) => run(herdr, args, { env });
  try {
    // Fixture repo: git init + 1 file + one initial commit (`git worktree add` needs a
    // HEAD). The pipeline itself and the test never commit anything else — the
    // reviewer is hired precisely to read the uncommitted diff.
    mkdirSync(repo, { recursive: true });
    await run('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, 'README.md'), 'pipeline fixture repo\n');
    await run('git', ['-C', repo, 'add', '-A']);
    await run('git', ['-C', repo, '-c', 'user.name=pipe', '-c', 'user.email=pipe@test', 'commit', '-qm', 'init']);
    const taskFile = join(dir, 'task.md');
    writeFileSync(taskFile, 'Create pipe-answer.mjs exporting 4.\n');

    server = spawn(herdr, ['server'], { cwd: dir, env, stdio: 'ignore', detached: true });
    const status = await waitFor('isolated herdr server', async () => {
      try {
        const out = await cli('status', 'server', '--json');
        const parsed = JSON.parse(out.stdout) as { running?: boolean; socket?: string };
        return parsed.running === true && parsed.socket === env.HERDR_SOCKET_PATH ? parsed : null;
      } catch { return null; }
    });
    t.diagnostic(`herdr server isolated on ${status.socket}`);
    const made = await cli('workspace', 'create', '--cwd', dir, '--label', 'pipe-e2e', '--focus');
    workspaceId = JSON.parse(made.stdout).result.workspace.workspace_id;

    const pipeEnv = { ...env, HERDR_BIN_PATH: herdr, TEST_PI_BIN: pi, HERDGATE_PI_RECEIPT_DIR: receipts };
    const out = await run(process.execPath, [pipeline, 'run', taskFile, '--cwd', repo, '--fake', '--max-retry', '2',
      '--test-cmd', TEST_CMD, '--timeout-ms', '45000'],
      { env: pipeEnv, timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.match(out.stdout, /human-approval/, 'the summary stops at human approval');

    const reports = readdirSync(repo).filter(name => /^pipe-[0-9a-f]+\.report\.json$/.test(name));
    assert.equal(reports.length, 1, 'exactly one pipeline report beside the repo');
    const id = reports[0].match(/^pipe-([0-9a-f]+)\.report\.json$/)![1];
    const report: PipeReport = JSON.parse(readFileSync(join(repo, reports[0]), 'utf8'));
    assert.equal(report.id, id);
    assert.equal(report.retries, 1, 'the buggy first attempt drove exactly one retry');
    assert.equal(report.attempts, 2);
    assert.equal(report.testExit, 0, 'the retry landed the fix and the test passed');
    assert.equal(report.review.verdict, 'PASS');
    assert.equal(report.nextAction, 'human-approval');
    assert.equal(report.branch, `pipe/${id}`);
    assert.match(report.agents.worker.id, /^[0-9a-f-]{36}$/);
    assert.match(report.agents.reviewer.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(report.agents.worker.id, report.agents.reviewer.id, 'worker and reviewer are distinct one-id spawns');
    assert.ok(existsSync(report.worktree), 'the worktree survives the run — no auto-clean before approval');
    assert.match(readFileSync(join(report.worktree, 'pipe-answer.mjs'), 'utf8'), /2 \+ 2/, 'the fixed answer is in the worktree');

    const state = JSON.parse(readFileSync(join(repo, `pipe-${id}.state.json`), 'utf8')) as { steps: StateStep[] };
    const boot = state.steps.filter(step => step.step === 'bootstrap');
    assert.ok(boot.some(step => step.phase === 'worktree_added'), 'bootstrap logged the worktree step');
    assert.ok(boot.some(step => step.phase === 'npm_install_skipped'), 'no package.json -> npm install skipped, no network');

    // The scripted provider's actual script: buggy, then fix, then the reviewer.
    const events = readFileSync(join(report.fixtureDir!, 'events.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { event: string; reviewer?: boolean; fixed?: boolean });
    const calls = events.filter(entry => entry.event === 'call');
    assert.deepEqual(calls.map(entry => [entry.reviewer, entry.fixed]), [[false, false], [false, true], [true, false]]);

    // B2's registry contract: both children live in spawns.jsonl under the worktree scope, one id each.
    const spawns = readSpawns(spawnsFileFor(receipts, realpathSync(report.worktree)));
    assert.equal(spawns.filter(entry => entry.id === report.agents.worker.id || entry.id === report.agents.reviewer.id).length, 2);
    assert.ok(spawns.every(entry => entry.id === entry.sessionId), 'one-id chain: registry id == Pi session id');

    // Clean is the guarded teardown hook: it refuses without approval.
    const refuse = await run(process.execPath, [pipeline, 'clean', id, '--cwd', repo], { env: pipeEnv }).catch(error => error);
    assert.notEqual(refuse.code, 0, 'clean without --approved must fail');
    assert.match(String(refuse.stderr), /--approved/);
    assert.ok(existsSync(report.worktree), 'a refused clean leaves the worktree untouched');

    await run(process.execPath, [pipeline, 'clean', id, '--cwd', repo, '--approved'], { env: pipeEnv });
    assert.equal(existsSync(report.worktree), false, 'approved clean removed the worktree');
    assert.equal((await run('git', ['-C', repo, 'branch', '--list', `pipe/${id}`])).stdout.trim(), '', 'approved clean deleted the branch');
    assert.ok(existsSync(join(repo, reports[0])), 'the report itself stays as the audit trail');
    t.diagnostic(`pipeline ${id}: retries=1 testExit=0 review=PASS, cleaned after approval`);
  } finally {
    if (workspaceId) await cli('workspace', 'close', workspaceId).catch(() => {});
    await cli('server', 'stop').catch(() => {});
    if (server && server.exitCode === null) {
      server.kill();
      const timer = setTimeout(() => server!.kill('SIGKILL'), 1500).unref();
      await new Promise(resolve => server!.once('exit', resolve));
      clearTimeout(timer);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
