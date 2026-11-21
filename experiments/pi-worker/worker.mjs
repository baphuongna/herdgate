#!/usr/bin/env node
// Experimental Herdgate Pi worker — step 3 of the Paseo-gap roadmap. NOT SHIPPED.
// Drains the local job queue written by the publisher (HERDGATE_PI_WORKER=1 enables
// worker.submit/worker.status device ops) and runs each request through a real Pi SDK
// session in the given workspace, journaling a receipt exactly like the TUI observer.
// The worker owns admission idempotency, resume and fail-closed restarts; it is not a
// scheduler and never resends. Providers: --fixture-dir runs the synthetic
// no-network provider (tests); --real runs the host Pi's own configured models
// (auth.json + models.json + settings default model of the user running it).
//
//   node experiments/pi-worker/worker.mjs --workspace <dir> [--pi <pi-coding-agent pkg>] \
//     [--fixture-dir <dir> | --real] [--tools] [--thinking <level>] [--job-timeout <seconds>] \
//     [--check] [--mode once|rpc] [--idle-exit <seconds>]
//
// once (default): drain what is queued, then exit 0 — the original one-shot binary.
// rpc: stay resident and speak one JSON request/response pair per line on stdio
//      (Paseo jsonl-rpc lessons: a frame over 64 KiB kills the process instead of
//      being skipped — losing state beats desync; stdin EOF and SIGTERM/SIGINT shut
//      down gracefully, aborting the running job into a canceled receipt; junk lines
//      get an error response and never kill the loop). Ops: ping, stats, drain,
//      steer, abort, shutdown. Queue growth auto-triggers a drain pass when idle.
// Sessions are created and disposed per job, so idle cleanup here means the daemon
// itself: --idle-exit <seconds> exits through the same graceful path.
//
// Queue:     <HERDGATE_PI_WORKER_DIR | ~/.local/state/herdgate/pi-worker>/jobs.jsonl
// Receipts:  the shared journal (HERDGATE_PI_RECEIPT_DIR | XDG default), per workspace.
// Sessions:  persistent JSONL audit trail under the worker dir (one session per job).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { MIN_PI_VERSION, versionAtLeast } from '../../plugin/server/pi-worker.mjs';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};
const log = line => console.error(`pi-worker: ${line}`);
const delay = ms => new Promise(done => setTimeout(done, ms));

function piPackage() {
  const explicit = arg('pi') || process.env.HERDGATE_PI_ROOT;
  if (explicit) return resolve(explicit);
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const releases = join(agentDir, 'install', 'releases');
  const versions = existsSync(releases)
    ? readdirSync(releases).filter(name => /^\d+\.\d+\.\d+$/.test(name))
    : [];
  assert.ok(versions.length, `no Pi releases under ${releases} — pass --pi <pi-coding-agent package dir>`);
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return join(releases, versions.at(-1), 'node_modules', '@earendil-works', 'pi-coding-agent');
}

const workspace = arg('workspace') ? resolve(arg('workspace')) : '';
const fixtureDir = arg('fixture-dir') ? resolve(arg('fixture-dir')) : '';
const real = process.argv.includes('--real');
const toolsOn = process.argv.includes('--tools');
const thinking = arg('thinking');
const jobTimeoutSeconds = Number(arg('job-timeout') ?? 0);
const check = process.argv.includes('--check');
const mode = arg('mode') ?? 'once';
const idleExitSeconds = Number(arg('idle-exit') ?? 0);
assert.ok(['once', 'rpc'].includes(mode), 'pass --mode once|rpc');
assert.ok(Number.isFinite(idleExitSeconds) && idleExitSeconds >= 0, '--idle-exit expects seconds');
assert.ok(Number.isFinite(jobTimeoutSeconds) && jobTimeoutSeconds >= 0, '--job-timeout expects seconds (0 = off)');
assert.ok(!fixtureDir || !real, '--fixture-dir and --real are mutually exclusive');
if (thinking) assert.ok(['low', 'medium', 'high'].includes(thinking), '--thinking expects low|medium|high');
assert.ok(workspace || check, 'pass --workspace <dir> (the Pi workspace whose receipt scope to use)');
assert.ok(fixtureDir || check || real, 'pass --fixture-dir <dir> (synthetic tests) or --real (host-configured models)');

const root = piPackage();
// undici 8.12 (bundled with Pi 1.5.x) touches zlib.createZstdDecompress at load
// time; node < 22.15 lacks it and boot crashes. Shim it inside THIS process only:
// no installed file changes, zstd responses fail loudly if ever requested.
if (typeof zlib.createZstdDecompress !== 'function') {
  zlib.createZstdDecompress = () => { throw new Error('zstd unsupported on this node build'); };
  log(`note: shimmed zlib.createZstdDecompress (node ${process.versions.node} < 22.15) for undici boot`);
}
// Absolute Windows paths are not import specifiers — go through file:// URLs.
const fromRoot = rel => pathToFileURL(join(root, rel)).href;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } =
  await import(fromRoot('dist/index.js'));
const { createAssistantMessageEventStream, InMemoryModelsStore } =
  await import(fromRoot('../pi-ai/dist/index.js'));
assert.ok(versionAtLeast(VERSION, MIN_PI_VERSION),
  `Pi ${VERSION} is older than the verified minimum ${MIN_PI_VERSION} — pass a newer package dir`);
if (check) {
  log(`Pi ${VERSION} at ${root}`);
  log(`workspace ${workspace}`);
  process.exit(0);
}

const { journalBase, scopeFor, findReceipt } = await import('../../plugin/server/pi-receipts.mjs');
const { appendReceipt, loadJournal, openScope, writeBody } = await import('../pi-receipt/journal.mjs');
const { appendJob, jobsFile, readJobs, readWorkspaces, workerBase } = await import('../../plugin/server/pi-worker.mjs');
const { recordSelf } = await import('../pi-spawn/registry.mjs');

const base = workerBase();
const file = jobsFile(base);
const receiptsBase = journalBase();
mkdirSync(base, { recursive: true, mode: 0o700 });
if (fixtureDir) mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
const agentDir = join(base, 'agent');
mkdirSync(agentDir, { recursive: true, mode: 0o700 });

// One worker at a time: a live pid owns the queue; a dead pid's file is overwritten.
const pidFile = join(base, 'worker.pid');
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); assert.fail(`another worker is running (pid ${pid})`); }
    catch (error) { assert.ok(error.code === 'ESRCH', String(error.message)); }
  }
}
writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

const events = fixtureDir ? join(fixtureDir, 'events.jsonl') : '';
const note = fixtureDir ? record => appendFileSync(events, `${JSON.stringify(record)}\n`) : () => {};
let currentPrompt = '';
// Keep call numbers monotonic across worker restarts: seed from the events file.
let calls = 0;
try {
  for (const line of readFileSync(events, 'utf8').split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record?.event === 'call' && Number.isInteger(record.call)) calls = Math.max(calls, record.call);
    } catch { /* torn tail */ }
  }
} catch { /* no events yet */ }

function message(model, text) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api,
    provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: zero }, stopReason: 'stop', timestamp: Date.now(),
  };
}

async function makeSession(wsPath, jobId) {
  const sessionsDir = join(base, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  // One-id chain: the SDK accepts a chosen session id, so a job's Pi session IS its
  // receipt request id — the same invariant the TUI spawn flow enforces with
  // `pi --session-id`.
  const sessionManager = SessionManager.create(wsPath, sessionsDir, jobId ? { id: jobId } : {});
  if (real) {
    // Real provider: the host Pi's own credentials, models.json and settings default
    // model. The manager is read-only here (no setters are called), so worker jobs
    // never write user settings; sessions stay isolated under the worker base.
    const realAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    const settingsManager = SettingsManager.create(process.cwd(), realAgentDir);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(realAgentDir, 'auth.json'), modelsPath: join(realAgentDir, 'models.json'),
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: wsPath, agentDir: realAgentDir, settingsManager, noSkills: true, noContextFiles: true,
      noThemes: true, noPromptTemplates: true, noExtensions: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: wsPath, agentDir: realAgentDir, settingsManager, modelRuntime,
      sessionManager, resourceLoader,
      ...(thinking ? { thinkingLevel: thinking } : {}),
      // Tools stay off unless the owner opts in — same trust as the paired-device
      // SSH bridge, but explicit.
      ...(toolsOn ? {} : { noTools: 'all' }),
    });
    assert.ok(session.model, 'no configured model — log in with pi on this host first');
    return { session, sessionManager };
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: false });
  settingsManager.setEnableInstallTelemetry(false);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null, modelsStore: new InMemoryModelsStore(), authPath: join(agentDir, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerProvider('herdgate-worker-fixture', {
    baseUrl: 'https://no-network.invalid', apiKey: 'fake', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const call = ++calls;
      note({ event: 'call', call, inputHash: createHash('sha256').update(currentPrompt).digest('hex') });
      void (async () => {
        try {
          if (existsSync(join(fixtureDir, 'hold')) && !existsSync(join(fixtureDir, 'release'))) {
            note({ event: 'holding', call });
            const deadline = Date.now() + 120_000;
            while (!existsSync(join(fixtureDir, 'release')) && !options?.signal?.aborted && Date.now() < deadline) await delay(100);
          }
          if (options?.signal?.aborted) {
            // Real providers surface an aborted stopReason; the fixture must too,
            // or session.abort() waits forever for a stream that never ends.
            const cut = message(model, '');
            cut.stopReason = 'aborted';
            note({ event: 'aborted', call });
            stream.push({ type: 'done', reason: 'aborted', message: cut });
            stream.end(cut);
            return;
          }
          const output = message(model, `SYNTHETIC_WORKER_REPLY_${call}`);
          note({ event: 'settled', call, aborted: false });
          stream.push({ type: 'done', reason: 'stop', message: output });
          stream.end(output);
        } catch (error) {
          note({ event: 'fixture_error', call, error: String(error?.message ?? error) });
          stream.end();
        }
      })();
      return stream;
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: wsPath, agentDir, settingsManager, noSkills: true, noContextFiles: true,
    noThemes: true, noPromptTemplates: true, noExtensions: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: wsPath, agentDir, settingsManager, modelRuntime,
    model: modelRuntime.getModel('herdgate-worker-fixture', 'fixture'),
    sessionManager, resourceLoader, noTools: 'all',
  });
  return { session, sessionManager };
}

// Receipt journals are per-workspace scopes; the default workspace is where jobs
// without a routing key (and unknown-workspace failures) are journaled.
const journals = new Map();
function journalFor(wsPath) {
  let entry = journals.get(wsPath);
  if (!entry) {
    const file = openScope(receiptsBase, wsPath);
    entry = { file, receipts: loadJournal(file).receipts };
    journals.set(wsPath, entry);
  }
  return entry;
}
function writeReceipt(wsPath, id, status, sessionId, fields = {}) {
  const entry = journalFor(wsPath);
  entry.receipts = appendReceipt(entry.file, entry.receipts,
    { v: 1, id, status, sessionId, ts: Date.now(), ...fields });
}

/** Resolve a job's routing key: a name from the host allowlist, else the default.
 *  A name that is not allowlisted fails closed — the job never runs. */
function resolveWorkspace(job, allowlist) {
  if (job.workspace === undefined) return { path: workspace };
  const path = allowlist.get(job.workspace);
  return path ? { path } : { error: 'unknown_workspace', name: job.workspace };
}

// Resume pass: a job left `running` by a dead worker fails closed. It is never resent;
// if a receipt was journaled before the crash, that verdict stands.
const initialJobs = readJobs(file);
const initialAllowlist = readWorkspaces(base);
for (const job of initialJobs.values()) {
  if (job.state !== 'running') continue;
  const settled = findReceipt(receiptsBase, job.id);
  if (settled) {
    appendJob(file, { ...job, state: settled.status,
      ...(settled.reason ? { reason: settled.reason } : {}),
      ...(settled.requestEntryId ? { requestEntryId: settled.requestEntryId } : {}),
      ...(settled.responseEntryId ? { responseEntryId: settled.responseEntryId } : {}) });
    log(`job ${job.id} resumed from journal: ${settled.status}`);
    continue;
  }
  const route = resolveWorkspace(job, initialAllowlist);
  writeReceipt(route.path, job.id, 'unknown', job.sessionId || 'pi-worker', { reason: 'worker_restarted', ...(job.principal ? { principal: job.principal } : {}) });
  appendJob(file, { ...job, state: 'unknown', reason: 'worker_restarted' });
  log(`job ${job.id} was running when the previous worker died -> unknown/worker_restarted`);
}

// Live run state, shared with the RPC ops (steer/abort reach the running session).
let running = null; // { job, session, done: Promise<verdict> } while a job executes
let passActive = false;
let shuttingDown = false; // set by the rpc shutdown paths; stops new jobs mid-pass
const counters = { started: 0, verdicts: { replied: 0, unknown: 0, failed: 0, canceled: 0 } };
const startedAt = Date.now();

async function runJob(job, allowlist) {
  const route = resolveWorkspace(job, allowlist);
  if (route.error) {
    // Unknown routing key: fail closed in the default scope. Never run, never resend.
    const verdict = { status: 'failed', reason: route.error };
    writeReceipt(workspace, job.id, verdict.status, 'pi-worker', { reason: verdict.reason, ...(job.principal ? { principal: job.principal } : {}) });
    appendJob(file, { ...job, state: verdict.status, reason: verdict.reason });
    counters.verdicts.failed = (counters.verdicts.failed ?? 0) + 1;
    log(`job ${job.id} -> failed/${route.error} (workspace "${route.name}" not allowlisted)`);
    return verdict;
  }
  const wsPath = route.path;
  const { session, sessionManager } = await makeSession(wsPath, job.id);
  const sessionId = sessionManager.getSessionId();
  appendJob(file, { ...job, state: 'running', sessionId });
  // The job session declares its own parent (ownership edge, pi-durable style), so
  // the spawn registry covers SDK children too — restore reopens this exact session
  // (by transcript file path: worker sessions live outside Pi's default storage,
  // where a bare --session-id would silently mint an empty look-alike).
  const selfRegister = status => {
    try {
      return recordSelf(receiptsBase, { sessionId, parentSessionId: 'pi-worker',
        id: job.id, name: `job-${job.id.slice(0, 8)}`, cwd: wsPath,
        sessionFile: sessionManager.getSessionFile(), ts: Date.now(), ...status });
    } catch (error) { log(`self-register failed: ${error.message}`); return null; }
  };
  selfRegister();
  let verdict = { status: 'failed', reason: 'worker_error' };
  const done = (async () => {
    try {
      currentPrompt = job.prompt;
      await session.prompt(job.prompt);
      // Steered input queues in the interactive message queue; a bare headless
      // prompt() does not consume it, so deliver queued messages as follow-up
      // turns inside the same job (the receipt reflects the final turn).
      const queuedIn = session.clearQueue();
      for (const text of [...queuedIn.steering, ...queuedIn.followUp]) {
        await session.sendUserMessage(text);
      }
      const branch = sessionManager.getBranch();
      const request = branch.filter(e => e.type === 'message' && e.message.role === 'user').at(-1);
      const response = branch.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1);
      const requestEntryId = request?.id;
      if (!response) verdict = { status: 'unknown', reason: 'no_final_reply' };
      else if (response.message.stopReason === 'error') verdict = { status: 'failed', reason: 'pi_error', responseEntryId: response.id };
      else if (response.message.stopReason === 'length') verdict = { status: 'failed', reason: 'pi_length', responseEntryId: response.id };
      else if (response.message.stopReason === 'aborted') verdict = { status: 'canceled', reason: 'aborted', responseEntryId: response.id };
      else if (response.message.stopReason !== 'stop'
        || !Array.isArray(response.message.content)
        || !response.message.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
        verdict = { status: 'unknown', reason: 'no_final_reply', responseEntryId: response.id };
      } else verdict = { status: 'replied', responseEntryId: response.id, bodyText: Array.isArray(response.message.content)
        ? response.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '' };
      const usage = verdict.status === 'replied' && response.message.usage && typeof response.message.usage === 'object'
        && (Number.isFinite(response.message.usage.totalTokens) || Number.isFinite(response.message.usage.cost?.total))
        ? { ...(Number.isFinite(response.message.usage.totalTokens) ? { totalTokens: response.message.usage.totalTokens } : {}),
            ...(Number.isFinite(response.message.usage.cost?.total) ? { costUsd: response.message.usage.cost.total } : {}) }
        : undefined;
      if (usage) verdict.usage = usage;
      if (requestEntryId) verdict.requestEntryId = requestEntryId;
    } catch (error) {
      if (error?.name === 'AbortError') verdict = { status: 'canceled', reason: 'aborted' };
      else if (/no api key/i.test(String(error?.message))) verdict = { status: 'failed', reason: 'pi_no_auth' };
      else log(`job ${job.id} prompt threw: ${error?.message ?? error}`);
    }
    return verdict;
  })();
  running = { job, session, done };
  counters.started += 1;
  // A hung stream would stall the whole queue forever; the wall clock bounds one
  // job (pi-durable's retry-limit analog: pathological requests end, they never loop).
  // Timed-out aborts settle failed/job_timeout — distinct from a user abort's canceled.
  let timedOut = false;
  const timer = jobTimeoutSeconds > 0 ? setTimeout(() => {
    timedOut = true;
    log(`job ${job.id} exceeded ${jobTimeoutSeconds}s — aborting`);
    session.abort().catch(() => {});
  }, jobTimeoutSeconds * 1000) : null;
  try {
    await done;
    if (timedOut && verdict.status === 'canceled') {
      verdict = { status: 'failed', reason: 'job_timeout',
        ...('responseEntryId' in verdict ? { responseEntryId: verdict.responseEntryId } : {}) };
    }
  } finally {
    if (timer) clearTimeout(timer);
    session.dispose();
    running = null;
  }
  if (verdict.status === 'replied' && verdict.bodyText && process.env.HERDGATE_PI_RECEIPT_BODY === '1') {
    try { writeBody(receiptsBase, wsPath, job.id, verdict.bodyText); } catch (error) { log(`body archive failed: ${error.message}`); }
  }
  writeReceipt(wsPath, job.id, verdict.status, sessionId,
    { ...('reason' in verdict ? { reason: verdict.reason } : {}),
      ...('requestEntryId' in verdict ? { requestEntryId: verdict.requestEntryId } : {}),
      ...('responseEntryId' in verdict ? { responseEntryId: verdict.responseEntryId } : {}),
      ...('usage' in verdict ? { usage: verdict.usage } : {}),
      // The actor that caused this job stays on its receipt (herdr-sched §3.1):
      // schedule:<id> for scheduler-fired runs, device:<id> for remote submits.
      ...(job.principal ? { principal: job.principal } : {}) });
  appendJob(file, { ...job, state: verdict.status, sessionId,
    ...('reason' in verdict ? { reason: verdict.reason } : {}),
    ...('requestEntryId' in verdict ? { requestEntryId: verdict.requestEntryId } : {}),
    ...('responseEntryId' in verdict ? { responseEntryId: verdict.responseEntryId } : {}) });
  counters.verdicts[verdict.status] = (counters.verdicts[verdict.status] ?? 0) + 1;
  selfRegister({ status: verdict.status }); // supersede in place: list reflects the settle
  log(`job ${job.id} -> ${verdict.status}${verdict.reason ? `/${verdict.reason}` : ''}`);
  return verdict;
}

/** One admission-order pass over the queue; one job at a time. Returns jobs started. */
async function drainPass() {
  passActive = true;
  let ran = 0;
  try {
    const jobs = readJobs(file);
    const allowlist = readWorkspaces(base); // fresh each pass: owner edits route live
    const queued = [...jobs.values()].filter(job => job.state === 'queued').sort((a, b) => a.ts - b.ts);
    for (const job of queued) {
      if (shuttingDown) break; // a shutdown mid-pass must not start the next job
      await runJob(job, allowlist); ran += 1;
    }
  } finally {
    passActive = false;
  }
  return ran;
}

if (mode === 'once') {
  const ran = await drainPass();
  rmSync(pidFile, { force: true });
  log(`done (${ran} job(s), scope ${scopeFor(workspace)})`);
  process.exit(0);
}

// --- rpc mode: one JSON frame per line in, one response per frame out (stdout). ---
const MAX_FRAME = 64 * 1024;
const RPC_VERSION = 'pi-worker-rpc-1';
let idleTimer = null;

const respond = (id, ok, payload) => {
  process.stdout.write(`${JSON.stringify({ type: 'response', id: id ?? null, ok, ...(ok ? { result: payload } : { error: String(payload) }) })}\n`);
};
const touchIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  if (idleExitSeconds > 0) idleTimer = setTimeout(() => void shutdown(`idle_exit after ${idleExitSeconds}s`), idleExitSeconds * 1000);
  if (idleTimer) idleTimer.unref();
};

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  try { unwatchFile(file); } catch { /* not watching */ }
  log(`shutting down (${reason})`);
  if (running) {
    try { await running.session.abort(); await running.done; }
    catch (error) { log(`shutdown abort failed: ${error?.message ?? error}`); }
  }
  rmSync(pidFile, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('sigterm'));
process.on('SIGINT', () => void shutdown('sigint'));

let passPromise = null;
const startPass = () => {
  if (passActive || passPromise || shuttingDown) return passPromise;
  passPromise = drainPass().finally(() => { passPromise = null; touchIdleTimer(); });
  return passPromise;
};

const ops = {
  async ping() {
    return { pong: true, pid: process.pid, rpc: RPC_VERSION, pi: VERSION, mode: 'rpc',
      uptimeMs: Date.now() - startedAt, shuttingDown };
  },
  async stats() {
    const jobs = readJobs(file);
    let queued = 0;
    for (const job of jobs.values()) if (job.state === 'queued') queued += 1;
    return { pid: process.pid, uptimeMs: Date.now() - startedAt, queued,
      running: running?.job.id ?? null, runningSinceMs: running ? Date.now() - startedAt : null,
      busy: passActive, started: counters.started, verdicts: { ...counters.verdicts },
      scope: scopeFor(workspace), workspaces: readWorkspaces(base).size, rpc: RPC_VERSION,
      jobTimeoutSeconds };
  },
  async drain({ wait } = {}) {
    if (passActive || passPromise) return { started: false, busy: true, current: running?.job.id ?? null };
    const pass = startPass();
    if (!wait) return { started: true };
    const ran = await pass;
    return { started: true, ran };
  },
  async steer({ text } = {}) {
    if (!running) throw new Error('not_running');
    if (typeof text !== 'string' || !text.trim() || text.length > 16 * 1024) throw new Error('bad_text');
    await running.session.sendUserMessage(text, { deliverAs: 'steer' });
    return { ok: true, job: running.job.id };
  },
  async abort() {
    if (!running) throw new Error('not_running');
    const job = running.job;
    const done = running.done;
    await running.session.abort();
    const verdict = await done;
    return { aborted: true, job: { id: job.id, status: verdict.status, ...('reason' in verdict ? { reason: verdict.reason } : {}) } };
  },
  async shutdown() {
    setImmediate(() => void shutdown('rpc'));
    return { ok: true };
  },
};

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  let newline;
  while ((newline = stdinBuffer.indexOf('\n')) >= 0) {
    const frame = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (frame.length > MAX_FRAME) {
      log(`frame of ${frame.length} bytes over ${MAX_FRAME} — exiting instead of desyncing`);
      process.exit(3);
    }
    handleFrame(frame);
  }
  if (stdinBuffer.length > MAX_FRAME) {
    log(`frame over ${MAX_FRAME} bytes (unterminated) — exiting instead of desyncing`);
    process.exit(3);
  }
});
process.stdin.on('end', () => void shutdown('stdin_closed'));
process.stdin.resume();

function handleFrame(frame) {
  touchIdleTimer();
  if (shuttingDown) { respond(null, false, 'shutting_down'); return; }
  let request = null;
  try { request = JSON.parse(frame); } catch { respond(null, false, 'bad_json'); return; }
  const { id, op } = request ?? {};
  const handler = ops[op];
  if (!handler || typeof op !== 'string') { respond(id ?? null, false, `unknown_op:${String(op)}`); return; }
  void handler(request).then(
    result => respond(id ?? null, true, result),
    error => respond(id ?? null, false, error?.message ?? String(error)));
}

// Queue growth starts a pass when idle; tests and owners can also call drain directly.
watchFile(file, { interval: 400 }, () => { if (!passActive && !passPromise && !shuttingDown) startPass(); });
touchIdleTimer();

// Drain anything already queued (same startup behavior as one-shot mode).
startPass();
log(`rpc ready (pid ${process.pid}, Pi ${VERSION}, scope ${scopeFor(workspace)}${idleExitSeconds ? `, idle-exit ${idleExitSeconds}s` : ''})`);
