import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { appendJob, heartbeatPath, jobsFile, MAX_RUN, publicJob, queueDepth, readHeartbeat, readJobs, readWorkspaces, scheduledRunId, validJob, versionAtLeast, workspacesFile, writeHeartbeat, workerBase, JOB_ID, MIN_PI_VERSION } from '../plugin/server/pi-worker.mjs';
import { findReceipt, journalBase, scopeFor } from '../plugin/server/pi-receipts.mjs';
import { readSpawns } from '../experiments/pi-spawn/registry.mjs';

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

/** The worker boots the Pi SDK even for run jobs (no session is created, but the
 *  import happens at startup), so tests resolve a package from TEST_PI_BIN when
 *  set — otherwise from the host's own install tree, no TEST_PI_BIN needed. */
function hostPiPackage(): string | undefined {
  if (piBin) return piPackage();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const releases = join(agentDir, 'install', 'releases');
  if (!existsSync(releases)) return undefined;
  const versions = readdirSync(releases).filter(v => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions.length ? versions[versions.length - 1] : '';
  const pkg = latest ? join(releases, latest, 'node_modules', '@earendil-works', 'pi-coding-agent') : '';
  return pkg && existsSync(pkg) ? pkg : undefined;
}

const runJobsSkip = (process.platform !== 'linux' || !hostPiPackage()) && 'requires a local Pi install on Linux';

type EnqueuedRun = { id: string; run: string; prompt?: string; principal?: string };

/** Seed a fresh queue of run jobs, drain it once, and hand back every path the
 *  assertions need. The fixture dir proves no model session was ever created. */
async function drainCommandQueue(opts: {
  jobs: EnqueuedRun[];
  commands?: boolean;
  body?: boolean;
  args?: string[];
}): Promise<{ dir: string; workspace: string; file: string; receiptsDir: string; fixtureDir: string; code: number | null; err: string }> {
  const pkg = hostPiPackage();
  assert.ok(pkg, 'resolvable Pi package');
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-run-'));
  const workspace = join(dir, 'ws');
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(workspace, { recursive: true });
  const file = jobsFile(workerDir);
  let ts = 0;
  for (const job of opts.jobs) {
    appendJob(file, { v: 1, id: job.id, ts: ++ts, state: 'queued', run: job.run,
      ...(job.prompt !== undefined ? { prompt: job.prompt } : {}),
      ...(job.principal ? { principal: job.principal } : {}) });
  }
  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir, ...(opts.args ?? [])],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir,
      PI_TELEMETRY: '0', ...(opts.commands ? { HERDGATE_PI_WORKER_COMMANDS: '1' } : {}),
      ...(opts.body ? { HERDGATE_PI_RECEIPT_BODY: '1' } : {}) }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  return { dir, workspace, file, receiptsDir, fixtureDir, code, err: err.join('') };
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
  // Principal contract (herdr-sched §3.1): the actor rides the job to its receipt.
  assert.equal(validJob({ v: 1, id, prompt: 'x', ts: 1, state: 'queued', principal: 'schedule:nightly-build' })?.principal, 'schedule:nightly-build');
  assert.equal(validJob({ v: 1, id, prompt: 'x', ts: 1, state: 'queued', principal: 'bogus' }), null);
  assert.equal(validJob({ v: 1, id, prompt: 'x', ts: 1, state: 'queued', principal: 'device:d_12345678' })?.principal, 'device:d_12345678');
  appendJob(file, { v: 1, id, prompt: 'first', ts: 1, state: 'queued', principal: 'device:d_12345678' });
  appendJob(file, { v: 1, id, prompt: 'first', ts: 1, state: 'running', sessionId: 's1', principal: 'device:d_12345678' });
  writeFileSync(file, '{corrupt\n' + readFileSync(file, 'utf8'), { mode: 0o600 });
  const jobs = readJobs(file);
  assert.equal(jobs.size, 1);
  assert.equal(jobs.get(id)?.state, 'running');
  assert.deepEqual(publicJob(jobs.get(id) ?? null), { id, ts: 1, state: 'running', sessionId: 's1', principal: 'device:d_12345678' });
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
  const framed = jobs.get(expected)?.prompt ?? '';
  assert.equal(jobs.get(expected)?.principal, 'schedule:synthetic-hourly', 'the job carries its schedule as principal');
  assert.ok(framed.startsWith(`[herdgate-schedule id="synthetic-hourly" run="${expected}" bucket=${bucket0} fired=`),
    'the wake frame names the schedule and run before the prompt');
  assert.ok(framed.endsWith('\n\nScheduled synthetic request'), 'the original prompt follows the frame');
  await runScheduler(t0 + 60_000); // same bucket -> idempotent
  assert.equal(readJobs(file).size, 1, 'a restarted tick in the same bucket must not duplicate');
  await runScheduler(t0 + 3_600_000); // next bucket -> new deterministic id
  jobs = readJobs(file);
  assert.deepEqual([...jobs.keys()], [expected, scheduledRunId('synthetic-hourly', bucket0 + 1)]);
  const beat = readHeartbeat(workerDir);
  assert.ok(beat && beat.source === 'herdgate-scheduler' && typeof beat.ts === 'number');
  rmSync(dir, { recursive: true, force: true });
});

test('a schedule routed to a missing workspace is gone for good; a raw prompt skips the frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-sched-'));
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const config = join(dir, 'schedule.json');
  writeFileSync(config, JSON.stringify({ schedules: [
    { id: 'routed', everySeconds: 3600, prompt: 'Routed synthetic request', workspace: 'nope' },
    { id: 'plain', everySeconds: 3600, prompt: 'Raw synthetic request' },
  ] }), { mode: 0o600 });
  const file = jobsFile(workerDir);
  const runScheduler = async (args: string[]) => {
    const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/scheduler.mjs'),
      '--config', config, '--once', ...args],
      { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir }, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(code, 0, err.join(''));
    return err.join('');
  };
  const t0 = 1_700_000_000_000;
  let out = await runScheduler(['--now', String(t0)]);
  assert.match(out, /target workspace "nope" is not allowlisted/);
  let jobs = readJobs(file);
  assert.deepEqual([...jobs.keys()], [scheduledRunId('plain', Math.floor(t0 / 3_600_000))],
    'the gone schedule enqueues nothing');
  // Still gone one bucket later — no failed job spam, no retroactive catch-up.
  out = await runScheduler(['--now', String(t0 + 3_600_000)]);
  assert.match(out, /target workspace "nope" is not allowlisted/);
  assert.equal(readJobs(file).size, 2, 'only the plain schedule advanced');
  assert.equal(readHeartbeat(workerDir)?.gone, 1, 'the heartbeat counts the gone target');
  // Allow the name: the routed schedule fires for the CURRENT bucket only.
  const workspaces = join(workerDir, 'workspaces.json');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(workspaces, JSON.stringify({ v: 1, workspaces: { nope: join(dir, 'ws') } }), { mode: 0o600 });
  const t2 = t0 + 7_200_000;
  out = await runScheduler(['--now', String(t2)]);
  jobs = readJobs(file);
  const routed = jobs.get(scheduledRunId('routed', Math.floor(t2 / 3_600_000)));
  assert.ok(routed?.workspace === 'nope', 'the job carries the routing key');
  assert.ok(routed.prompt.includes('[herdgate-schedule id="routed"'), 'the wake frame rides the routed job');
  assert.ok(!jobs.has(scheduledRunId('routed', Math.floor(t0 / 3_600_000))),
    'buckets missed while gone never fire retroactively');
  // Raw prompts skip the frame entirely.
  await runScheduler(['--now', String(t0 + 10_800_000), '--raw-prompts']);
  const raw = readJobs(file).get(scheduledRunId('plain', Math.floor((t0 + 10_800_000) / 3_600_000)));
  assert.equal(raw?.prompt, 'Raw synthetic request', 'raw prompts are passed through verbatim');
  rmSync(dir, { recursive: true, force: true });
});

/** Same deterministic recap id the scheduler derives: sha256('recap:'+session) forced to v4 shape. */
function recapIdOf(sessionId: string): string {
  const digest = createHash('sha256').update(`recap:${sessionId}`).digest('hex');
  const variant = (parseInt(digest[16], 16) & 0x3) | 0x8;
  return [digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`,
    `${variant.toString(16)}${digest.slice(17, 20)}`, digest.slice(20, 32)].join('-');
}

test('the recap pass summarizes cold replied sessions once, gated, capped and transcript-backed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-recap-'));
  const workerDir = join(dir, 'worker');
  const receiptsDir = join(dir, 'receipts');
  const piHome = join(dir, 'pihome');
  const piSessions = join(piHome, 'agent', 'sessions');
  const config = join(dir, 'schedule.json');
  writeFileSync(config, JSON.stringify({ schedules: [] }), { mode: 0o600 });
  const file = jobsFile(workerDir);
  const runScheduler = async (now: number, extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/scheduler.mjs'),
      '--config', config, '--once', '--now', String(now)],
      { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir,
        HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_HOME: piHome, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(code, 0, err.join(''));
    return err.join('');
  };
  const scope = join(receiptsDir, '0123456789abcdef');
  const addReceipt = (n: number, entry: Record<string, unknown>) => {
    mkdirSync(scope, { recursive: true });
    appendFileSync(join(scope, 'receipts.jsonl'), `${JSON.stringify({ v: 1, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ...entry })}\n`, { mode: 0o600 });
  };
  const addTranscript = (sessionId: string) => {
    const slug = join(piSessions, 'proj-slug'); // Pi storage slug layout: <root>/<slug>/<ts>_<id>.jsonl
    mkdirSync(slug, { recursive: true });
    const path = join(slug, `1700000000000_${sessionId}.jsonl`);
    writeFileSync(path, '', { mode: 0o600 });
    return path;
  };
  const sessionOf = (n: number) => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;
  const t0 = 1_700_000_000_000;
  const cold = t0 - 20 * 60_000; // older than the 10-minute recap horizon
  const sessionA = sessionOf(1);
  const transcriptA = addTranscript(sessionA);
  addReceipt(1, { status: 'replied', sessionId: sessionA, ts: cold });
  const sessionHot = sessionOf(2); // replied but still warm -> ignored
  addTranscript(sessionHot);
  addReceipt(2, { status: 'replied', sessionId: sessionHot, ts: t0 - 60_000 });
  const sessionFailed = sessionOf(3); // settled badly -> no recap
  addTranscript(sessionFailed);
  addReceipt(3, { status: 'failed', sessionId: sessionFailed, ts: cold });
  const sessionNoFile = sessionOf(4); // cold but the transcript is gone -> nothing to read
  addReceipt(4, { status: 'replied', sessionId: sessionNoFile, ts: cold });

  // Gate off: an old replied session enqueues nothing, quietly.
  const gateOff = await runScheduler(t0);
  assert.equal(readJobs(file).size, 0, 'gate off: no recap job is enqueued');
  assert.ok(!gateOff.includes('recap:'), 'gate off: no recap noise in the log');

  // Gate on: exactly one deterministic recap job for the one eligible session.
  const gateOn = await runScheduler(t0, { HERDGATE_PI_RECAP: '1' });
  const expected = recapIdOf(sessionA);
  assert.match(expected, JOB_ID, 'the derived recap id is a valid job id');
  const jobs = readJobs(file);
  assert.deepEqual([...jobs.keys()], [expected], 'only the cold replied session with a transcript is recap’d');
  const recap = jobs.get(expected);
  assert.equal(recap?.principal, `recap:${sessionA}`, 'the recap carries its session as principal');
  assert.equal(recap?.state, 'queued');
  assert.equal(recap?.ts, t0);
  assert.equal(recap?.workspace, undefined, 'recaps run in the default workspace');
  assert.ok(recap?.prompt.startsWith(`[herdgate-recap session=${sessionA} file=${transcriptA}]\n\n`),
    'the recap frame names the session and transcript file');
  assert.ok(recap.prompt.includes(`không sửa): ${transcriptA}.`), 'the prompt points at the transcript path');
  assert.match(gateOn, /recap: enqueued 1 \(1 considered\)/);

  // Idempotent: a second tick adds nothing — one recap per session, ever.
  await runScheduler(t0 + 60_000, { HERDGATE_PI_RECAP: '1' });
  assert.equal(readJobs(file).size, 1, 'a second tick must not duplicate the recap');

  // Cap: five more eligible sessions, RECAP_MAX defaults to 3 per tick.
  const t1 = t0 + 30_000; // the hot session is still inside the horizon
  for (let n = 5; n <= 9; n++) {
    addTranscript(sessionOf(n));
    addReceipt(n, { status: 'replied', sessionId: sessionOf(n), ts: cold });
  }
  const capped = await runScheduler(t1, { HERDGATE_PI_RECAP: '1' });
  const after = readJobs(file);
  assert.equal([...after.values()].filter(job => job.principal?.startsWith('recap:')).length, 4,
    'the first recap plus the three the cap allows');
  assert.match(capped, /recap: enqueued 3 \(5 considered\)/);
  assert.ok(after.has(recapIdOf(sessionOf(5))) && after.has(recapIdOf(sessionOf(6))) && after.has(recapIdOf(sessionOf(7))),
    'the first three eligible sessions in scan order are the ones recap’d');
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
  // Receipts carry a bounded title (the first prompt line, cut to 96) and nothing
  // more of the prompt or the reply — metadata-only, as before titles existed.
  assert.equal(findReceipt(receiptsDir, one)?.title, 'Synthetic worker request: tiếng Việt');
  assert.equal(findReceipt(receiptsDir, two)?.title, 'Second synthetic request');
  assert.ok(!raw.includes('SYNTHETIC_WORKER_REPLY'), 'the model reply never enters the receipt');
  assert.equal(findReceipt(receiptsDir, one)?.status, 'replied');
  assert.equal(findReceipt(receiptsDir, one)?.responseEntryId, oneHash.responseEntryId);
  // Each job session self-registers its parent in the spawn registry (same workspace scope).
  const spawns = readSpawns(join(receiptsDir, scopeFor(workspace), 'spawns.jsonl'));
  const selfEntry = spawns.find(s => s.sessionId === oneHash.sessionId);
  assert.equal(selfEntry?.parentSessionId, 'pi-worker', 'a worker job declares its own parent');
  assert.equal(selfEntry?.id, selfEntry?.sessionId, 'one-id chain: the self entry is its own receipt id');
  assert.equal(selfEntry?.paneId, undefined, 'no pane — restore attaches one later');
  assert.ok(selfEntry?.sessionFile && existsSync(selfEntry.sessionFile), 'the transcript path is recorded for exact restore');
  assert.equal(selfEntry?.status, 'replied', 'the entry settles with the verdict, not the spawn-time status');
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
  const rawJournal = readFileSync(join(receiptsDir, scopeFor(workspace), 'receipts.jsonl'), 'utf8');
  assert.ok(!rawJournal.includes('SYNTHETIC_WORKER_REPLY'), 'no reply text enters receipts; titles stay bounded');
  for (const settled of [findReceipt(receiptsDir, held), findReceipt(receiptsDir, next)]) {
    assert.ok(!settled?.title || settled.title.length <= 96, 'a title is at most the first line, cut to 96');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a hung job is bounded by --job-timeout: failed/job_timeout, queue moves on, user abort stays canceled', {
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
  mkdirSync(fixtureDir, { recursive: true });
  const file = jobsFile(workerDir);
  const held = '00000000-0000-4000-8000-000000000031';
  const next = '00000000-0000-4000-8000-000000000032';
  appendJob(file, { v: 1, id: held, prompt: 'Synthetic hung request', ts: 1, state: 'queued' });
  appendJob(file, { v: 1, id: next, prompt: 'Synthetic after-hang request', ts: 2, state: 'queued' });
  writeFileSync(join(fixtureDir, 'hold'), '', { mode: 0o600 }); // the first stream never ends on its own

  const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
    '--workspace', workspace, '--pi', pkg, '--fixture-dir', fixtureDir, '--job-timeout', '2'],
    { env: { PATH: process.env.PATH, HOME: dir, HERDGATE_PI_WORKER_DIR: workerDir, HERDGATE_PI_RECEIPT_DIR: receiptsDir, PI_TELEMETRY: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
  // The first stream parks in the hold loop (released only by abort); drop the hold
  // file before the second job starts so it streams normally.
  await waitFor('fixture holds the first call', () => events(fixtureDir).some(e => e.event === 'holding' && e.call === 1));
  rmSync(join(fixtureDir, 'hold'));
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 0, err.join(''));
  assert.match(err.join(''), /exceeded 2s — aborting/, 'the timeout fired and said so');

  const jobs = readJobs(file);
  assert.equal(jobs.get(held)?.state, 'failed');
  assert.equal(jobs.get(held)?.reason, 'job_timeout');
  assert.equal(jobs.get(next)?.state, 'replied', 'the queue moved on to the next job');
  const receipt = findReceipt(receiptsDir, held);
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.reason, 'job_timeout');
  assert.equal(findReceipt(receiptsDir, next)?.status, 'replied');
  // The hung prompt ran exactly once: the timeout aborts, it never retries or resends.
  const hashOf = (prompt: string) => createHash('sha256').update(prompt).digest('hex');
  assert.equal(events(fixtureDir).filter(e => e.event === 'call' && e.inputHash === hashOf('Synthetic hung request')).length, 1);
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
  assert.equal(findReceipt(receiptsDir, routed)?.title, 'Routed scope request', 'titles are the bounded first line only');
  assert.ok(!raw.includes('SYNTHETIC_WORKER_REPLY'), 'the reply body never enters the journal');

  // Shape rules: only allowlisted-style names pass validJob; the reader skips junk rows.
  assert.equal(validJob({ v: 1, id: plain, prompt: 'x', ts: 1, state: 'queued', workspace: 'Other' }), null);
  assert.equal(validJob({ v: 1, id: plain, prompt: 'x', ts: 1, state: 'queued', workspace: 'a'.repeat(65) }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('run jobs fail closed when HERDGATE_PI_WORKER_COMMANDS is off: the command never executes', {
  skip: runJobsSkip,
  timeout: 60_000,
}, async () => {
  const markerDir = mkdtempSync(join(tmpdir(), 'hg-pi-sentinel-'));
  const sentinel = join(markerDir, 'ran');
  const id = '00000000-0000-4000-8000-000000000081';
  const out = await drainCommandQueue({ jobs: [{ id, run: `touch "${sentinel}"` }] }); // gate off: no HERDGATE_PI_WORKER_COMMANDS
  assert.equal(out.code, 0, out.err); // the worker survives; the job is what failed
  const jobs = readJobs(out.file);
  assert.equal(jobs.get(id)?.state, 'failed');
  assert.equal(jobs.get(id)?.reason, 'command_jobs_disabled');
  const receipt = findReceipt(out.receiptsDir, id);
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.reason, 'command_jobs_disabled');
  assert.equal(receipt?.sessionId, id, 'one-id chain: the job id stands in for the session');
  assert.equal(receipt?.title, `touch "${sentinel}"`.slice(0, 96));
  assert.ok(!existsSync(sentinel), 'the command must not run with the gate closed');
  assert.equal(events(out.fixtureDir).filter(e => e.event === 'call').length, 0, 'no model session either');
  rmSync(markerDir, { recursive: true, force: true });
  rmSync(out.dir, { recursive: true, force: true });
});

test('gated run jobs execute in the workspace: exit 0 replies with output, exit!=0 fails, run wins over prompt', {
  skip: runJobsSkip,
  timeout: 90_000,
}, async () => {
  const echo = '00000000-0000-4000-8000-000000000082';
  const fails = '00000000-0000-4000-8000-000000000083';
  const dual = '00000000-0000-4000-8000-000000000084';
  const pwd = '00000000-0000-4000-8000-000000000085';
  const out = await drainCommandQueue({
    commands: true,
    body: true,
    jobs: [
      { id: echo, run: 'echo ok', principal: 'schedule:nightly-build' },
      { id: fails, run: 'echo boom >&2; exit 3' },
      { id: dual, run: 'echo dual-mode', prompt: 'must not reach the model' },
      { id: pwd, run: 'printf %s "$PWD"' },
    ],
  });
  assert.equal(out.code, 0, out.err);
  const jobs = readJobs(out.file);
  assert.equal(jobs.get(echo)?.state, 'replied');
  assert.equal(jobs.get(fails)?.state, 'failed');
  assert.equal(jobs.get(fails)?.reason, 'exit:3');
  assert.equal(jobs.get(dual)?.state, 'replied', 'a job with both fields runs the command');
  const echoReceipt = findReceipt(out.receiptsDir, echo);
  assert.equal(echoReceipt?.status, 'replied');
  assert.equal(echoReceipt?.sessionId, echo);
  assert.equal(echoReceipt?.title, 'echo ok');
  assert.equal(echoReceipt?.principal, 'schedule:nightly-build', 'the principal rides run-job receipts too');
  assert.ok(echoReceipt?.usage && Number.isFinite(echoReceipt.usage.durationMs) && echoReceipt.usage.durationMs > 0,
    'usage carries the measured durationMs');
  const failReceipt = findReceipt(out.receiptsDir, fails);
  assert.equal(failReceipt?.status, 'failed');
  assert.equal(failReceipt?.reason, 'exit:3');
  assert.equal(findReceipt(out.receiptsDir, dual)?.title, 'echo dual-mode', 'run supplies the title when both fields exist');
  const body = (id: string) => readFileSync(join(out.receiptsDir, scopeFor(out.workspace), 'responses', `${id}.md`), 'utf8');
  assert.ok(body(echo).includes('ok'), 'exit 0 archives the output as the reply body');
  assert.ok(body(fails).includes('boom'), 'stderr is captured with stdout');
  assert.equal(body(pwd).trim(), realpathSync(out.workspace), 'the command runs with the workspace as cwd');
  assert.equal(events(out.fixtureDir).filter(e => e.event === 'call').length, 0, 'run jobs never prompt a model');
  rmSync(out.dir, { recursive: true, force: true });
});

test('a hung run job is bounded by --job-timeout: killed, failed/job_timeout, never canceled', {
  skip: runJobsSkip,
  timeout: 60_000,
}, async () => {
  const id = '00000000-0000-4000-8000-000000000086';
  const t0 = Date.now();
  const out = await drainCommandQueue({
    commands: true,
    args: ['--job-timeout', '1'],
    jobs: [{ id, run: 'sleep 5' }],
  });
  assert.equal(out.code, 0, out.err);
  assert.ok(Date.now() - t0 < 4_500, 'the timeout must not wait out the full sleep');
  const jobs = readJobs(out.file);
  assert.equal(jobs.get(id)?.state, 'failed');
  assert.equal(jobs.get(id)?.reason, 'job_timeout');
  const receipt = findReceipt(out.receiptsDir, id);
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.reason, 'job_timeout');
  assert.equal(receipt?.sessionId, id);
  rmSync(out.dir, { recursive: true, force: true });
});

test('validJob admits bounded run jobs without a prompt and never leaks the command', () => {
  const id = '00000000-0000-4000-8000-000000000090';
  const base = { v: 1, id, ts: 1, state: 'queued' };
  assert.equal(validJob({ ...base, run: 'echo hi' })?.run, 'echo hi', 'a prompt-less run job is admitted');
  assert.equal(validJob({ ...base, run: 'x'.repeat(MAX_RUN) })?.run?.length, MAX_RUN, 'the bound itself passes');
  assert.equal(validJob({ ...base, run: 'x'.repeat(MAX_RUN + 1) }), null);
  assert.equal(validJob({ ...base, run: '' }), null);
  assert.equal(validJob({ ...base, run: 'echo \0nope' }), null, 'NUL never crosses admission');
  assert.equal(validJob({ ...base, run: 42 }), null);
  assert.equal(validJob({ ...base, prompt: 'x', run: 'x'.repeat(MAX_RUN + 1) }), null, 'a malformed run fails the whole job');
  assert.equal(validJob({ ...base, prompt: 'x'.repeat(16 * 1024 + 1), run: 'echo hi' }), null, 'the prompt bound still applies when present');
  const dual = validJob({ ...base, prompt: 'also present', run: 'echo hi' });
  assert.ok(dual, 'both fields may ride one job; the worker takes run');
  const pub = publicJob(dual!);
  assert.equal('run' in pub, false, 'publicJob must not leak the command');
  assert.equal('prompt' in pub, false);
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-runq-'));
  appendJob(jobsFile(dir), { ...base, run: 'echo hi' });
  assert.equal(readJobs(jobsFile(dir)).get(id)?.run, 'echo hi', 'run-only jobs round-trip the queue');
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
