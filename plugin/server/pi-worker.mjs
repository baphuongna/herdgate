// Shared format for the experimental Pi worker queue (see experiments/pi-worker).
// The publisher appends jobs when HERDGATE_PI_WORKER=1; the separately started
// experiment worker consumes them and journals receipts via the shared journal.
// This module only owns the on-disk queue format — no network, no Pi SDK here.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
// Same contract as receipts: the actor that caused this job (schedule:<id>,
// device:<id>…) rides along to the journal when the worker settles it.
import { PRINCIPAL } from './pi-receipts.mjs';

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PROMPT = 16 * 1024; // admission bound for one prompt
export const MAX_RUN = 2048;         // admission bound for one shell command (run jobs)
export const MAX_PENDING = 100;      // queued + running jobs admitted at once
export const JOB_STATES = new Set(['queued', 'running', 'replied', 'failed', 'canceled', 'unknown']);
/** Routing key a device may reference — resolved against the host's allowlist. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOBS = 'jobs.jsonl';
const WORKSPACES = 'workspaces.json';

/** Oldest Pi release the experiments are verified against. Newer Pi releases run
 *  without code changes; only a Pi older than this is refused. */
export const MIN_PI_VERSION = '1.5.2';

/** Loose semver floor: numeric triple comparison, 'v' prefix and pre-release
 *  suffixes ignored — except a pre-release of the exact min triple does not pass. */
export function versionAtLeast(version, min = MIN_PI_VERSION) {
  const parse = value => String(value ?? '').trim().replace(/^v/, '').split('-')[0].split('.').map(Number);
  const actual = parse(version);
  const floor = parse(min);
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? 0;
    const b = floor[i] ?? 0;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a !== b) return a > b;
  }
  if (String(version).includes('-') && !String(min).includes('-')) return false; // 1.5.2-rc1 is not >= 1.5.2
  return true;
}

/** Directory holding jobs.jsonl and worker state. One worker per host (prototype). */
export function workerBase(env = process.env) {
  if (env.HERDGATE_PI_WORKER_DIR) return env.HERDGATE_PI_WORKER_DIR;
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'herdgate', 'pi-worker');
}

export function jobsFile(base) {
  return join(base, JOBS);
}

export function workspacesFile(base) {
  return join(base, WORKSPACES);
}

/** Owner-curated routing table: name -> absolute workspace path, 0600, optional.
 *  A device references a name; the worker resolves it here. No raw paths cross
 *  the wire, and a name missing from this file fails closed (never runs). */
export function readWorkspaces(base) {
  let raw;
  try { raw = readFileSync(workspacesFile(base), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return new Map(); } // corrupt allowlist routes nothing new
  const table = parsed?.v === 1 && parsed.workspaces && typeof parsed.workspaces === 'object'
    ? parsed.workspaces : null;
  if (!table) return new Map();
  const out = new Map();
  for (const [name, path] of Object.entries(table)) {
    if (WORKSPACE_NAME.test(name) && typeof path === 'string' && isAbsolute(path)) out.set(name, path);
  }
  return out;
}

export function validJob(job) {
  return validJobShape(job) ? job : null;
}

const validPrompt = value => typeof value === 'string' && value.length <= MAX_PROMPT;
const validRun = value => typeof value === 'string' && value.length >= 1
  && value.length <= MAX_RUN && !value.includes('\0');

function validJobShape(job) {
  return Boolean(job && job.v === 1 && JOB_ID.test(job.id ?? '')
    && JOB_STATES.has(job.state)
    // Payload: a model prompt, a shell command (run job), or both (the worker
    // takes run). Whichever fields are present must each be well-formed.
    && (validPrompt(job.prompt) || validRun(job.run))
    && (job.prompt === undefined || validPrompt(job.prompt))
    && (job.run === undefined || validRun(job.run))
    && typeof job.ts === 'number'
    && (job.workspace === undefined || WORKSPACE_NAME.test(job.workspace))
    && (job.principal === undefined || PRINCIPAL.test(job.principal))
    && ['sessionId', 'reason', 'requestEntryId', 'responseEntryId'].every(key =>
      job[key] === undefined || typeof job[key] === 'string'));
}

/** Newest record per job id; corrupt lines and a torn tail are skipped. */
export function readJobs(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const lines = raw.split('\n');
  lines.pop();
  const jobs = new Map();
  for (const line of lines) {
    try {
      const job = JSON.parse(line);
      if (validJob(job)) jobs.set(job.id, job);
    } catch { /* skip */ }
  }
  return jobs;
}

export function appendJob(file, job) {
  if (!validJob(job)) throw new Error('invalid job record');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(job)}\n`, { mode: 0o600 });
}

/** The public answer for a device: neither the prompt nor the command leaves the host. */
export function publicJob(job) {
  if (!job) return { state: 'unknown', reason: 'not_admitted' };
  const { v, prompt, run, ...rest } = job;
  return rest;
}

export function queueDepth(jobs) {
  let queued = 0;
  let running = 0;
  for (const job of jobs.values()) {
    if (job.state === 'queued') queued += 1;
    else if (job.state === 'running') running += 1;
  }
  return { queued, running };
}

/** Deterministic UUID for one scheduled run: same (schedule, bucket) -> same id, so a
 *  restarted scheduler re-admits the same job instead of duplicating the run. */
export function scheduledRunId(scheduleId, bucket) {
  const digest = createHash('sha256').update(`${scheduleId}|${bucket}`).digest('hex');
  const variant = (parseInt(digest[16], 16) & 0x3) | 0x8;
  return [digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`,
    `${variant.toString(16)}${digest.slice(17, 20)}`, digest.slice(20, 32)].join('-');
}

export function heartbeatPath(base) {
  return join(base, 'heartbeat.json');
}

/** One heartbeat record per tick; the publisher serves it via worker.health. */
export function writeHeartbeat(base, entry) {
  if (!entry || entry.v !== 1 || typeof entry.ts !== 'number' || typeof entry.source !== 'string') {
    throw new Error('invalid heartbeat');
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  writeFileSync(heartbeatPath(base), JSON.stringify(entry), { mode: 0o600 });
}

export function readHeartbeat(base) {
  try {
    const entry = JSON.parse(readFileSync(heartbeatPath(base), 'utf8'));
    if (entry && entry.v === 1 && typeof entry.ts === 'number' && typeof entry.source === 'string') return entry;
  } catch { /* missing or corrupt -> no heartbeat */ }
  return null;
}
