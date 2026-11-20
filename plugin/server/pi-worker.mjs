// Shared format for the experimental Pi worker queue (see experiments/pi-worker).
// The publisher appends jobs when HERDGATE_PI_WORKER=1; the separately started
// experiment worker consumes them and journals receipts via the shared journal.
// This module only owns the on-disk queue format — no network, no Pi SDK here.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PROMPT = 16 * 1024; // admission bound for one prompt
export const MAX_PENDING = 100;      // queued + running jobs admitted at once
export const JOB_STATES = new Set(['queued', 'running', 'replied', 'failed', 'canceled', 'unknown']);
const JOBS = 'jobs.jsonl';

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

export function validJob(job) {
  return validJobShape(job) ? job : null;
}

function validJobShape(job) {
  return Boolean(job && job.v === 1 && JOB_ID.test(job.id ?? '')
    && JOB_STATES.has(job.state)
    && typeof job.prompt === 'string' && job.prompt.length <= MAX_PROMPT
    && typeof job.ts === 'number'
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

/** The public answer for a device: the prompt never leaves the host. */
export function publicJob(job) {
  if (!job) return { state: 'unknown', reason: 'not_admitted' };
  const { v, prompt, ...rest } = job;
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
