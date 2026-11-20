#!/usr/bin/env node
// Experimental Herdgate Pi worker — step 3 of the Paseo-gap roadmap. NOT SHIPPED.
// Drains the local job queue written by the publisher (HERDGATE_PI_WORKER=1 enables
// worker.submit/worker.status device ops) and runs each request through a real Pi SDK
// session in the given workspace, journaling a receipt exactly like the TUI observer.
// The worker owns admission idempotency, resume and fail-closed restarts; it is not a
// scheduler and never resends. Fixture provider only in this prototype: no network.
//
//   node experiments/pi-worker/worker.mjs --workspace <dir> [--pi <pi-coding-agent pkg>] \
//     [--fixture-dir <dir>] [--check]
//
// Queue:     <HERDGATE_PI_WORKER_DIR | ~/.local/state/herdgate/pi-worker>/jobs.jsonl
// Receipts:  the shared journal (HERDGATE_PI_RECEIPT_DIR | XDG default), per workspace.
// Sessions:  persistent JSONL audit trail under the worker dir (one session per job).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

const workspace = resolve(arg('workspace') ?? '');
const fixtureDir = resolve(arg('fixture-dir') ?? '');
const check = process.argv.includes('--check');
assert.ok(workspace, 'pass --workspace <dir> (the Pi workspace whose receipt scope to use)');
assert.ok(fixtureDir || check, 'pass --fixture-dir <dir> (this prototype runs the synthetic provider only)');

const root = piPackage();
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } =
  await import(join(root, 'dist/index.js'));
const { createAssistantMessageEventStream, InMemoryModelsStore } =
  await import(join(root, '../pi-ai/dist/index.js'));
assert.ok(versionAtLeast(VERSION, MIN_PI_VERSION),
  `Pi ${VERSION} is older than the verified minimum ${MIN_PI_VERSION} — pass a newer package dir`);
if (check) {
  log(`Pi ${VERSION} at ${root}`);
  log(`workspace ${workspace}`);
  process.exit(0);
}

const { journalBase, scopeFor, findReceipt } = await import('../../plugin/server/pi-receipts.mjs');
const { appendReceipt, loadJournal, openScope, writeBody } = await import('../pi-receipt/journal.mjs');
const { appendJob, jobsFile, readJobs, workerBase } = await import('../../plugin/server/pi-worker.mjs');

const base = workerBase();
const file = jobsFile(base);
const receiptsBase = journalBase();
mkdirSync(base, { recursive: true, mode: 0o700 });
mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
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

const events = join(fixtureDir, 'events.jsonl');
const note = record => appendFileSync(events, `${JSON.stringify(record)}\n`);
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

async function makeSession() {
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
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const call = ++calls;
      note({ event: 'call', call, inputHash: createHash('sha256').update(currentPrompt).digest('hex') });
      void (async () => {
        try {
          if (existsSync(join(fixtureDir, 'hold')) && !existsSync(join(fixtureDir, 'release'))) {
            note({ event: 'holding', call });
            const deadline = Date.now() + 120_000;
            while (!existsSync(join(fixtureDir, 'release')) && Date.now() < deadline) await delay(100);
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
  const sessionsDir = join(base, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const sessionManager = SessionManager.create(workspace, sessionsDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace, agentDir, settingsManager, noSkills: true, noContextFiles: true,
    noThemes: true, noPromptTemplates: true, noExtensions: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: workspace, agentDir, settingsManager, modelRuntime,
    model: modelRuntime.getModel('herdgate-worker-fixture', 'fixture'),
    sessionManager, resourceLoader, noTools: 'all',
  });
  return { session, sessionManager };
}

const receiptsFile = openScope(receiptsBase, workspace);
let receipts = loadJournal(receiptsFile).receipts;
function writeReceipt(id, status, sessionId, fields = {}) {
  receipts = appendReceipt(receiptsFile, receipts,
    { v: 1, id, status, sessionId, ts: Date.now(), ...fields });
}

// Resume pass: a job left `running` by a dead worker fails closed. It is never resent;
// if a receipt was journaled before the crash, that verdict stands.
const jobs = readJobs(file);
for (const job of jobs.values()) {
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
  writeReceipt(job.id, 'unknown', job.sessionId || 'pi-worker', { reason: 'worker_restarted' });
  appendJob(file, { ...job, state: 'unknown', reason: 'worker_restarted' });
  log(`job ${job.id} was running when the previous worker died -> unknown/worker_restarted`);
}

// Drain queued jobs in admission order. One job at a time; terminal state mirrors the receipt.
const queued = [...jobs.values()].filter(job => job.state === 'queued').sort((a, b) => a.ts - b.ts);
if (!queued.length) log('no queued jobs');
for (const job of queued) {
  const { session, sessionManager } = await makeSession();
  const sessionId = sessionManager.getSessionId();
  appendJob(file, { ...job, state: 'running', sessionId });
  let verdict = { status: 'failed', reason: 'worker_error' };
  try {
    currentPrompt = job.prompt;
    await session.prompt(job.prompt);
    const branch = sessionManager.getBranch();
    const request = branch.filter(e => e.type === 'message' && e.message.role === 'user').at(-1);
    const response = branch.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1);
    const requestEntryId = request?.id;
    if (!response) verdict = { status: 'unknown', reason: 'no_final_reply' };
    else if (response.message.stopReason === 'error') verdict = { status: 'failed', reason: 'pi_error', responseEntryId: response.id };
    else if (response.message.stopReason === 'length') verdict = { status: 'failed', reason: 'pi_length', responseEntryId: response.id };
    else if (response.message.stopReason !== 'stop'
      || !Array.isArray(response.message.content)
      || !response.message.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
      verdict = { status: 'unknown', reason: 'no_final_reply', responseEntryId: response.id };
    } else verdict = { status: 'replied', responseEntryId: response.id, bodyText: Array.isArray(response.message.content)
      ? response.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '' };
    if (requestEntryId) verdict.requestEntryId = requestEntryId;
  } catch (error) {
    if (error?.name === 'AbortError') verdict = { status: 'canceled', reason: 'aborted' };
    else log(`job ${job.id} prompt threw: ${error?.message ?? error}`);
  } finally {
    session.dispose();
  }
  if (verdict.status === 'replied' && verdict.bodyText && process.env.HERDGATE_PI_RECEIPT_BODY === '1') {
    try { writeBody(receiptsBase, workspace, job.id, verdict.bodyText); } catch (error) { log(`body archive failed: ${error.message}`); }
  }
  writeReceipt(job.id, verdict.status, sessionId,
    { ...('reason' in verdict ? { reason: verdict.reason } : {}),
      ...('requestEntryId' in verdict ? { requestEntryId: verdict.requestEntryId } : {}),
      ...('responseEntryId' in verdict ? { responseEntryId: verdict.responseEntryId } : {}) });
  appendJob(file, { ...job, state: verdict.status, sessionId,
    ...('reason' in verdict ? { reason: verdict.reason } : {}),
    ...('requestEntryId' in verdict ? { requestEntryId: verdict.requestEntryId } : {}),
    ...('responseEntryId' in verdict ? { responseEntryId: verdict.responseEntryId } : {}) });
  log(`job ${job.id} -> ${verdict.status}${verdict.reason ? `/${verdict.reason}` : ''}`);
}

rmSync(pidFile, { force: true });
log(`done (${queued.length} job(s), scope ${scopeFor(workspace)})`);
