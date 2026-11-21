import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { appendJob, heartbeatPath, jobsFile, publicJob, queueDepth, readHeartbeat, readJobs, readWorkspaces, scheduledRunId, validJob, versionAtLeast, workspacesFile, writeHeartbeat, workerBase, JOB_ID, MIN_PI_VERSION } from '../plugin/server/pi-worker.mjs';
import { findReceipt, journalBase, scopeFor } from '../plugin/server/pi-receipts.mjs';

const root = join(import.meta.dirname, '..');
const piBin = process.env.TEST_PI_BIN;

/** Resolve the installed Pi coding-agent package from the pi binary path. */
function piPackage(): string | undefined {
  if (!piBin) return undefined;
  let dir = dirname(realpathSync(piBin));
  for (let up = 0; up < 6; up++) {
    const releases = join(dir, 'install', 'releases');
    if (existsSync(releases)) {
      const versions = readdirSync(releases).filter(v => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const pkg = versions.length ? join(releases, versions[versions.length - 1], 'node_modules', '@earendil-works', 'pi-coding-agent') : '';
      return pkg && existsSync(pkg) ? pkg : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
}

type FixtureEvent = { event: string; call?: number; inputHash?: string };
const events = (dir: string): FixtureEvent[] => {
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  return lines.map(line => JSON.parse(line) as FixtureEvent);
};

test('the worker queue format is bounded, newest-wins and never leaks prompts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-jobs-'));
  const file = jobsFile(dir);
  const id = '00000000-0000-4000-8000-00000000000a';
  assert.equal(workerBase({ HERDGATE_PI_WORKER_DIR: '/x' }), '/x');
  assert.match(workerBase({}), /herdgate.*pi-worker$/);
  assert.equal(validJob({ v: 1, id: 'nope', prompt: 'x', ts: 1, state: 'queued' }), null);
  assert.equal(validJob({ v: 1, id, prompt: 'x', ts: 1, state: 'sideways' }), null);
  appendJob(file, { v: 1, id, prompt: 'first', ts: 1, state: 'queued' });
  appendJob(file, { v: 1, id, prompt: 'first', ts: 1, state: 'running', sessionId: 's1' });
  writeFileSync(file, '{corrupt\n' + readFileSync(file, 'utf8'), { mode: 0o600 });
  const jobs = readJobs(file);
  assert.equal(jobs.size, 1);
  assert.equal(jobs.get(id)?.state, 'running');
  assert.deepEqual(publicJob(jobs.get(id) ?? null), { id, ts: 1, state: 'running', sessionId: 's1' });
  assert.deepEqual(publicJob(null), { state: 'unknown', reason: 'not_admitted' });
  assert.throws(() => appendJob(file, { v: 1, id: '00000000-0000-4000-8000-00000000000b', prompt: 'x'.repeat(16 * 1024 + 1), ts: 1, state: 'queued' }));
  rmSync(dir, { recursive: true, force: true });
});

test('the Pi version gate is a floor, not a pin', () => {
  assert.equal(MIN_PI_VERSION, '1.5.2');
  assert.ok(versionAtLeast('1.5.2'));
  assert.ok(versionAtLeast('1.5.3'));
  assert.ok(versionAtLeast('1.6.0'));
  assert.ok(versionAtLeast('2.0.0'));
  assert.ok(versionAtLeast('v1.5.2'));
  assert.ok(versionAtLeast('1.5.3-beta.1'));
  assert.ok(versionAtLeast('1.5.2', '1.5.2'));
  assert.equal(versionAtLeast('1.5.1'), false);
  assert.equal(versionAtLeast('1.4.9'), false);
  assert.equal(versionAtLeast('1.5.2-rc1'), false, 'a pre-release of the floor does not pass');
  assert.equal(versionAtLeast('garbage'), false);
  assert.equal(versionAtLeast('1.x.0'), false);
});

test('heartbeat, queue depth and deterministic run ids round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-beat-'));
  assert.equal(readHeartbeat(dir), null, 'no heartbeat yet');
  writeHeartbeat(dir, { v: 1, ts: 123, source: 'test', note: 'x' });
  assert.deepEqual(readHeartbeat(dir), { v: 1, ts: 123, source: 'test', note: 'x' });
  writeFileSync(heartbeatPath(dir), '{corrupt', { mode: 0o600 });
  assert.equal(readHeartbeat(dir), null, 'corrupt heartbeat fails closed');
  assert.throws(() => writeHeartbeat(dir, JSON.parse('{\"v\":1,\"ts\":\"x\",\"source\":\"test\"}')));
  const jobs = new Map();
  jobs.set('a', { v: 1, id: 'a', prompt: 'p', ts: 1, state: 'queued' });
  jobs.set('b', { v: 1, id: 'b', prompt: 'p', ts: 2, state: 'running' });
  jobs.set('c', { v: 1, id: 'c', prompt: 'p', ts: 3, state: 'replied' });
  assert.deepEqual(queueDepth(jobs), { queued: 1, running: 1 });
  const run = scheduledRunId('morning-summary', 42);
  assert.match(run, JOB_ID);
  assert.equal(run, scheduledRunId('morning-summary', 42));
  assert.notEqual(run, scheduledRunId('morning-summary', 43));
  assert.notEqual(run, scheduledRunId('evening-summary', 42));
  rmSync(dir, { recursive: true, force: true });
});

test('the scheduler admits one deterministic run per bucket and heartbeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-sched-'));
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const config = join(dir, 'schedule.json');
  writeFileSync(config, JSON.stringify({ schedules: [
    { id: 'synthetic-hourly', everySeconds: 3600, prompt: 'Scheduled synthetic request' },
    { id: 'broken', everySeconds: 0, prompt: 'never admitted' },
    { id: 'too-long', everySeconds: 60, prompt: 'x'.repeat(16 * 1024 + 1) },
  ] }), { mode: 0o600 });
  const file = jobsFile(workerDir);
  const runScheduler = async (now: number) => {
    const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/scheduler.mjs'),
      '--config', config, '--once', '--now', String(now)],
      { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir }, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(code, 0, err.join(''));
    return err.join('');
  };
  const t0 = 1_700_000_000_000;
  const bucket0 = Math.floor(t0 / 3_600_000);
  const expected = scheduledRunId('synthetic-hourly', bucket0);
  await runScheduler(t0);
  let jobs = readJobs(file);
  assert.deepEqual([...jobs.keys()], [expected], 'only the valid schedule is admitted');
  assert.equal(jobs.get(expected)?.prompt, 'Scheduled synthetic request');
  await runScheduler(t0 + 60_000); // same bucket -> idempotent
  assert.equal(readJobs(file).size, 1, 'a restarted tick in the same bucket must not duplicate');
  await runScheduler(t0 + 3_600_000); // next bucket -> new deterministic id
  jobs = readJobs(file);
  assert.deepEqual([...jobs.keys()], [expected, scheduledRunId('synthetic-hourly', bucket0 + 1)]);
  const beat = readHeartbeat(workerDir);
  assert.ok(beat && beat.source === 'herdgate-scheduler' && typeof beat.ts === 'number');
  rmSync(dir, { recursive: true, force: true });
});

test('a second worker refuses to start while a live pid owns the queue', { skip: !piBin && 'requires TEST_PI_BIN' }, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-worker-'));
  const workerDir = join(dir, 'worker');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(join(workerDir), { recursive: true });
  writeFileSync(join(workerDir, 'worker.pid'), `${process.pid}\n`, { mode: 0o600 }); // this test process is alive
  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', dir, '--pi', pkg, '--fixture-dir', fixtureDir],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: join(dir, 'receipts') }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const [code] = await Promise.all([new Promise<number | null>(resolve => child.once('exit', resolve)), new Promise(r => child.stderr!.once('end', r))]);
  assert.equal(code, 1);
  assert.match(err.join(''), /another worker is running/);
  rmSync(dir, { recursive: true, force: true });
});

test('real-provider mode is flag-guarded: mutually exclusive with the fixture and fails closed without auth', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 60_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-real-'));
  const run = (args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'), '--pi', pkg, ...args],
      { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
    return Promise.all([new Promise<number | null>(resolve => child.once('exit', resolve)),
      new Promise(r => child.stderr!.once('end', r))]).then(([code]) => ({ code, err: err.join('') }));
  };
  const baseEnv = { PATH: process.env.PATH, HERDGATE_PI_WORKER_DIR: join(dir, 'worker'),
    HERDGATE_PI_RECEIPT_DIR: join(dir, 'receipts') };
  const both = await run(['--workspace', dir, '--fixture-dir', join(dir, 'fx'), '--real'], baseEnv);
  assert.equal(both.code, 1);
  assert.match(both.err, /mutually exclusive/);
  // No credentials in scope: a queued job settles failed/pi_no_auth instead of hanging.
  const emptyAgent = join(dir, 'pi-empty');
  mkdirSync(baseEnv.HERDGATE_PI_WORKER_DIR as string, { recursive: true });
  const id = randomUUID();
  appendJob(jobsFile(baseEnv.HERDGATE_PI_WORKER_DIR as string), { v: 1, id, prompt: 'hello', ts: Date.now(), state: 'queued' });
  const noAuth = await run(['--workspace', dir, '--real', '--mode', 'once'], { ...baseEnv, PI_CODING_AGENT_DIR: emptyAgent });
  assert.equal(noAuth.code, 0); // the worker itself survives; the job is the thing that failed
  assert.match(noAuth.err, /failed\/pi_no_auth/);
  const receipt = findReceipt(join(dir, 'receipts'), id);
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.reason, 'pi_no_auth');
  assert.equal(readJobs(jobsFile(baseEnv.HERDGATE_PI_WORKER_DIR as string)).get(id)?.state, 'failed');
  rmSync(dir, { recursive: true, force: true });
});

test('the worker drains a seeded queue once and journals metadata-only receipts', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 60_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-worker-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  const file = jobsFile(workerDir);
  const one = '00000000-0000-4000-8000-000000000011';
  const two = '00000000-0000-4000-8000-000000000012';
  appendJob(file, { v: 1, id: one, prompt: 'Synthetic worker request: tiếng Việt', ts: 1, state: 'queued' });
  appendJob(file, { v: 1, id: two, prompt: 'Second synthetic request', ts: 2, state: 'queued' });

  const run = () => {
    const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
      '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir],
      { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
    const done = new Promise<{ code: number | null; err: string }>(resolve =>
      child.once('exit', code => resolve({ code, err: err.join('') })));
    return { child, done };
  };

  const first = await run().done;
  assert.equal(first.code, 0, first.err);
  assert.equal((first.err.match(/job [0-9a-f-]+ -> replied/g) ?? []).length, 2);
  const jobs = readJobs(file);
  assert.deepEqual([...jobs.values()].map(j => j.state), ['replied', 'replied']);
  const oneHash = jobs.get(one)!;
  const twoHash = jobs.get(two)!;
  assert.ok(oneHash.requestEntryId && oneHash.responseEntryId);
  assert.ok(twoHash.requestEntryId && twoHash.responseEntryId);
  assert.ok(oneHash.sessionId && twoHash.sessionId && oneHash.sessionId !== twoHash.sessionId);
  const journal = join(receiptsDir, scopeFor(workspace), 'receipts.jsonl');
  const raw = readFileSync(journal, 'utf8');
  assert.ok(!raw.includes('tiếng Việt') && !raw.includes('synthetic'), 'receipts must not contain prompt text');
  assert.equal(findReceipt(receiptsDir, one)?.status, 'replied');
  assert.equal(findReceipt(receiptsDir, one)?.responseEntryId, oneHash.responseEntryId);
  const calls = () => events(fixtureDir).filter(e => e.event === 'call').length;
  assert.equal(calls(), 2);
  assert.equal(events(fixtureDir).find(e => e.event === 'call')?.inputHash,
    createHash('sha256').update('Synthetic worker request: tiếng Việt').digest('hex'));

  const second = await run().done; // nothing queued: idempotent no-op
  assert.equal(second.code, 0, second.err);
  assert.equal(calls(), 2, 'a drained queue must not resend');
  rmSync(dir, { recursive: true, force: true });
});

test('a worker killed mid-run fails closed on restart and resumes the next job', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 90_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-worker-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  const file = jobsFile(workerDir);
  const held = '00000000-0000-4000-8000-000000000021';
  const next = '00000000-0000-4000-8000-000000000022';
  appendJob(file, { v: 1, id: held, prompt: 'Synthetic held request', ts: 1, state: 'queued' });
  appendJob(file, { v: 1, id: next, prompt: 'Synthetic next request', ts: 2, state: 'queued' });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'hold'), '', { mode: 0o600 });

  const spawnWorker = () => spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });

  const stuck = spawnWorker();
  await waitFor('fixture holds the first call', () => events(fixtureDir).some(e => e.event === 'holding' && e.call === 1));
  stuck.kill('SIGKILL');
  await new Promise(resolve => stuck.once('exit', resolve));
  assert.equal(readJobs(file).get(held)?.state, 'running');

  rmSync(join(fixtureDir, 'hold')); // the restart must not resend the held request anyway
  const rerun = spawnWorker();
  const err: string[] = [];
  rerun.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const code = await new Promise<number | null>(resolve => rerun.once('exit', resolve));
  assert.equal(code, 0, err.join(''));

  const jobs = readJobs(file);
  assert.equal(jobs.get(held)?.state, 'unknown');
  assert.equal(jobs.get(held)?.reason, 'worker_restarted');
  assert.equal(jobs.get(next)?.state, 'replied');
  const receipt = findReceipt(receiptsDir, held);
  assert.equal(receipt?.status, 'unknown');
  assert.equal(receipt?.reason, 'worker_restarted');
  assert.equal(findReceipt(receiptsDir, next)?.status, 'replied');
  const hashOf = (prompt: string) => createHash('sha256').update(prompt).digest('hex');
  const callCount = (prompt: string) => events(fixtureDir).filter(e => e.event === 'call' && e.inputHash === hashOf(prompt)).length;
  assert.equal(callCount('Synthetic held request'), 1, 'the held request ran exactly once');
  assert.equal(callCount('Synthetic next request'), 1, 'only the next job ran after the restart');
  assert.ok(!readFileSync(join(receiptsDir, scopeFor(workspace), 'receipts.jsonl'), 'utf8').includes('Synthetic'));
  rmSync(dir, { recursive: true, force: true });
});

test('rpc mode: ping/stats/drain over JSONL, junk tolerated, oversize frame kills, EOF exits cleanly', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 90_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-rpc-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  const file = jobsFile(workerDir);
  const one = '00000000-0000-4000-8000-000000000031';
  appendJob(file, { v: 1, id: one, prompt: 'Rpc synthetic request', ts: 1, state: 'queued' });

  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir, '--mode', 'rpc'],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const frames: Record<string, any>[] = [];
  child.stdout!.setEncoding('utf8');
  let stdoutBuffer = '';
  child.stdout!.on('data', chunk => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const frame = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      try { frames.push(JSON.parse(frame)); } catch { /* torn */ }
    }
  });
  const send = (payload: unknown) => child.stdin!.write(`${JSON.stringify(payload)}\n`);
  const reply = async (id: string, op: string, extra?: Record<string, unknown>) => {
    const before = frames.length;
    send({ id, op, ...extra });
    return waitFor(`reply to ${op}`, () => frames.slice(before).find(f => f.id === id));
  };

  const pong = await reply('p1', 'ping');
  assert.equal(pong.ok, true);
  assert.equal(pong.result.pong, true);
  assert.equal(pong.result.pid, child.pid);

  // The seeded job drains at startup; stats must reflect exactly one replied verdict.
  await waitFor('job settled', () => findReceipt(receiptsDir, one)?.status === 'replied');
  const stats = await reply('s1', 'stats');
  assert.equal(stats.result.started, 1);
  assert.equal(stats.result.verdicts.replied, 1);
  assert.equal(stats.result.queued, 0);
  assert.equal(stats.result.running, null);
  assert.equal(stats.result.busy, false);

  // steer without a running job is an explicit error, not a queue write.
  const steer = await reply('st1', 'steer', { text: 'nope' });
  assert.equal(steer.ok, false);
  assert.match(steer.error, /not_running/);

  // Junk frames answer with an error and never kill the loop.
  child.stdin!.write('this is not json\n');
  const after = await reply('p2', 'ping');
  assert.equal(after.ok, true);
  assert.equal(frames.filter(f => f.ok === false && f.error === 'bad_json').length, 1);

  // drain while idle is a no-op that reports zero runs.
  const drain = await reply('d1', 'drain', { wait: true });
  assert.deepEqual(drain.result, { started: true, ran: 0 });

  // stdin EOF shuts down gracefully with exit 0 (pid lock released).
  child.stdin!.end();
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 0, err.join(''));
  assert.equal(existsSync(join(workerDir, 'worker.pid')), false, 'pid lock released on exit');
  rmSync(dir, { recursive: true, force: true });
});

test('rpc mode: abort cancels a held run into a receipt; an oversize frame exits fail-closed', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 90_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-rpc2-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'hold'), '', { mode: 0o600 });
  const file = jobsFile(workerDir);
  const held = '00000000-0000-4000-8000-000000000041';
  appendJob(file, { v: 1, id: held, prompt: 'Held synthetic request', ts: 1, state: 'queued' });

  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir, '--mode', 'rpc'],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const frames: Record<string, any>[] = [];
  child.stdout!.setEncoding('utf8');
  let stdoutBuffer = '';
  child.stdout!.on('data', chunk => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const frame = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      try { frames.push(JSON.parse(frame)); } catch { /* torn */ }
    }
  });
  const send = (payload: unknown) => child.stdin!.write(`${JSON.stringify(payload)}\n`);
  const reply = async (id: string, op: string, extra?: Record<string, unknown>) => {
    const before = frames.length;
    send({ id, op, ...extra });
    return waitFor(`reply to ${op}`, () => frames.slice(before).find(f => f.id === id));
  };

  await waitFor('fixture holds the call', () => events(fixtureDir).some(e => e.event === 'holding'));
  const busy = await reply('s0', 'stats');
  assert.equal(busy.result.running, held);

  const aborted = await reply('a1', 'abort');
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.result.aborted, true);
  assert.equal(aborted.result.job.id, held);
  assert.equal(aborted.result.job.status, 'canceled');
  assert.equal(aborted.result.job.reason, 'aborted');
  const receipt = findReceipt(receiptsDir, held);
  assert.equal(receipt?.status, 'canceled');
  assert.equal(receipt?.reason, 'aborted');
  assert.equal(readJobs(file).get(held)?.state, 'canceled');
  const settled = events(fixtureDir).find(e => e.event === 'settled' && e.call === 1);
  assert.ok(!settled, 'the held call never settled — the abort cut it');

  // A frame over the cap kills the worker instead of desyncing the protocol.
  child.stdin!.write(`{"id":"big","op":"ping","pad":"${'x'.repeat(70 * 1024)}"}\n`);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 3, `oversize frame must exit 3 (stderr: ${err.join('')})`);
  rmSync(dir, { recursive: true, force: true });
});

test('rpc mode: steer injects input into the held turn and the receipt still settles', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 90_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-rpc3-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'hold'), '', { mode: 0o600 });
  const file = jobsFile(workerDir);
  const held = '00000000-0000-4000-8000-000000000051';
  appendJob(file, { v: 1, id: held, prompt: 'Steered synthetic request', ts: 1, state: 'queued' });

  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir, '--mode', 'rpc'],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames: Record<string, any>[] = [];
  child.stdout!.setEncoding('utf8');
  let stdoutBuffer = '';
  child.stdout!.on('data', chunk => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const frame = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      try { frames.push(JSON.parse(frame)); } catch { /* torn */ }
    }
  });
  const send = (payload: unknown) => child.stdin!.write(`${JSON.stringify(payload)}\n`);
  const reply = async (id: string, op: string, extra?: Record<string, unknown>) => {
    const before = frames.length;
    send({ id, op, ...extra });
    return waitFor(`reply to ${op}`, () => frames.slice(before).find(f => f.id === id));
  };

  await waitFor('fixture holds the call', () => events(fixtureDir).some(e => e.event === 'holding'));
  const steered = await reply('st1', 'steer', { text: 'nghĩ ngắn hơn' });
  assert.equal(steered.ok, true, JSON.stringify(steered));
  assert.equal(steered.result.job, held);
  // The steer message queues into the live session; once the held turn settles it is
  // delivered and the fixture is called a second time within the same job.
  writeFileSync(join(fixtureDir, 'release'), '', { mode: 0o600 });
  await waitFor('steer re-prompted the fixture', () => events(fixtureDir).filter(e => e.event === 'call').length >= 2);
  await waitFor('job settled after steer', () => findReceipt(receiptsDir, held)?.status === 'replied');
  const stats = await reply('s1', 'stats');
  assert.equal(stats.result.verdicts.replied, 1);
  send({ id: 'x1', op: 'shutdown' });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('workspace routing: allowlist names route jobs per-scope, unknown names fail closed', {
  skip: (!piBin || process.platform !== 'linux') && 'requires TEST_PI_BIN on Linux',
  timeout: 90_000,
}, async () => {
  const pkg = piPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-ws-'));
  const defaultWs = join(dir, 'ws-default');
  const otherWs = join(dir, 'ws-other');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(defaultWs, { recursive: true });
  mkdirSync(otherWs, { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  // Owner-curated allowlist: a name a device may reference -> absolute path.
  writeFileSync(join(workerDir, 'workspaces.json'), JSON.stringify({ v: 1, workspaces: {
    other: otherWs, 'not-a-name!': '/ignored', dup: '/relative/path' } }), { mode: 0o600 });
  const file = jobsFile(workerDir);
  const plain = '00000000-0000-4000-8000-000000000071';
  const routed = '00000000-0000-4000-8000-000000000072';
  const stranger = '00000000-0000-4000-8000-000000000073';
  appendJob(file, { v: 1, id: plain, prompt: 'Default scope request', ts: 1, state: 'queued' });
  appendJob(file, { v: 1, id: routed, prompt: 'Routed scope request', ts: 2, state: 'queued', workspace: 'other' });
  appendJob(file, { v: 1, id: stranger, prompt: 'Unroutable request', ts: 3, state: 'queued', workspace: 'nope' });

  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', defaultWs, '--pi', pkg, '--fixture-dir', fixtureDir],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 0, err.join(''));

  // Each routable job settles in ITS workspace scope; the stranger fails closed
  // in the default scope without ever reaching the fixture.
  assert.equal(findReceipt(receiptsDir, plain)?.status, 'replied');
  assert.equal(findReceipt(receiptsDir, routed)?.status, 'replied');
  assert.equal(findReceipt(receiptsDir, stranger)?.status, 'failed');
  assert.equal(findReceipt(receiptsDir, stranger)?.reason, 'unknown_workspace');
  assert.ok(existsSync(join(receiptsDir, scopeFor(defaultWs), 'receipts.jsonl')));
  assert.ok(existsSync(join(receiptsDir, scopeFor(otherWs), 'receipts.jsonl')));
  const raw = readFileSync(join(receiptsDir, scopeFor(otherWs), 'receipts.jsonl'), 'utf8');
  assert.ok(raw.includes(routed) && !raw.includes(plain), 'the routed scope holds only its own job');
  const jobs = readJobs(file);
  assert.equal(jobs.get(plain)?.state, 'replied');
  assert.equal(jobs.get(routed)?.state, 'replied');
  assert.equal(jobs.get(stranger)?.state, 'failed');
  assert.equal(jobs.get(stranger)?.reason, 'unknown_workspace');
  assert.equal(events(fixtureDir).filter(e => e.event === 'call').length, 2, 'the unroutable job never ran');
  assert.ok(!raw.includes('Routed scope request') && !raw.includes('Unroutable'), 'receipts stay prompt-free');

  // Shape rules: only allowlisted-style names pass validJob; the reader skips junk rows.
  assert.equal(validJob({ v: 1, id: plain, prompt: 'x', ts: 1, state: 'queued', workspace: 'Other' }), null);
  assert.equal(validJob({ v: 1, id: plain, prompt: 'x', ts: 1, state: 'queued', workspace: 'a'.repeat(65) }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('readWorkspaces: corrupt or missing allowlist files route nothing new', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-wsfmt-'));
  assert.equal(readWorkspaces(dir).size, 0, 'no file -> empty map');
  writeFileSync(workspacesFile(dir), '{corrupt', { mode: 0o600 });
  assert.equal(readWorkspaces(dir).size, 0, 'corrupt -> empty map');
  writeFileSync(workspacesFile(dir), JSON.stringify({ v: 1, workspaces: { good: '/abs', 'bad name': '/abs', rel: 'nope' } }), { mode: 0o600 });
  const table = readWorkspaces(dir);
  assert.equal(table.size, 1);
  assert.equal(table.get('good'), '/abs');
  rmSync(dir, { recursive: true, force: true });
});

assert.ok(journalBase({}) || homedir()); // keep the receipts import honest
