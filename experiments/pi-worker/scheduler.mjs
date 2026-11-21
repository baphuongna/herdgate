#!/usr/bin/env node
// Experimental Herdgate scheduler — step 4 slice. NOT SHIPPED.
// Enqueues deterministic scheduled prompts into the Pi worker queue and writes the
// heartbeat the publisher serves over worker.health. Idempotent by construction:
// one job per (schedule id, time bucket); the run id is derived from the bucket, so
// a restarted --once (cron/systemd timer) re-admits the same id instead of running
// twice. It never resends a failed/unknown run and is not an orchestrator.
// Paseo scheduler lessons applied: prompts wake the agent inside a frame naming the
// schedule and run (trace id), and a schedule routed to a workspace that is no longer
// allowlisted is gone for good — it is skipped, not retried every bucket; buckets
// missed while gone are never fired retroactively.
//
//   node experiments/pi-worker/scheduler.mjs --config <schedule.json> [--once | --loop <s>] [--now <epoch-ms>] [--raw-prompts]
//
// Schedule file (local, 0600 recommended — it holds prompts):
//   { "schedules": [ { "id": "morning-summary", "everySeconds": 3600, "prompt": "...",
//                      "workspace": "optional-allowlist-name" } ] }
// Schedule ids must be unique in one queue; ids collide only if duplicated here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendJob, jobsFile, readJobs, readWorkspaces, scheduledRunId, writeHeartbeat, workerBase, MAX_PROMPT, WORKSPACE_NAME } from '../../plugin/server/pi-worker.mjs';
import { findReceipt, journalBase } from '../../plugin/server/pi-receipts.mjs';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};
const log = line => console.error(`pi-scheduler: ${line}`);
const configPath = arg('config');
assert.ok(configPath, 'pass --config <schedule.json>');
const now0 = Number(arg('now')) || Date.now();
const looping = process.argv.includes('--loop');
const rawPrompts = process.argv.includes('--raw-prompts');
const loopSeconds = Math.max(1, Number(arg('loop')) || 60);
const base = workerBase();
const file = jobsFile(base);
const receiptsBase = journalBase();
const SCHEDULE_ID = /^[A-Za-z0-9_:.-]{1,64}$/;

function schedules() {
  const raw = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
  assert.ok(raw && Array.isArray(raw.schedules), 'config needs a schedules array');
  return raw.schedules;
}

function tick(now) {
  let enqueued = 0;
  let admitted = 0;
  let invalid = 0;
  let gone = 0;
  const jobs = readJobs(file);
  const allowlist = readWorkspaces(base);
  for (const schedule of schedules()) {
    const idOk = SCHEDULE_ID.test(schedule?.id ?? '');
    const everyOk = Number.isInteger(schedule?.everySeconds) && schedule.everySeconds >= 1 && schedule.everySeconds <= 2_147_483_647;
    const promptOk = typeof schedule?.prompt === 'string' && schedule.prompt.trim().length > 0 && schedule.prompt.length <= MAX_PROMPT;
    const wsOk = schedule?.workspace === undefined || WORKSPACE_NAME.test(schedule.workspace);
    if (!idOk || !everyOk || !promptOk || !wsOk) { invalid += 1; log(`skipped invalid schedule ${String(schedule?.id)}`); continue; }
    // Target gone is permanent for as long as the name is missing: skip, don't spam
    // failed jobs every bucket. Buckets missed while gone never fire retroactively.
    if (schedule.workspace && !allowlist.has(schedule.workspace)) {
      gone += 1;
      log(`schedule ${schedule.id} target workspace "${schedule.workspace}" is not allowlisted — skipping (gone)`);
      continue;
    }
    const bucket = Math.floor(now / (schedule.everySeconds * 1000));
    const id = scheduledRunId(schedule.id, bucket);
    if (jobs.get(id) || findReceipt(receiptsBase, id)) { admitted += 1; continue; }
    // The wake frame tells the agent WHICH schedule fired and the run to trace —
    // a scheduled agent should never wonder why it woke up.
    const framed = rawPrompts ? schedule.prompt
      : `[herdgate-schedule id="${schedule.id}" run="${id}" bucket=${bucket} fired=${new Date(now).toISOString()}]\n\n${schedule.prompt}`;
    if (framed.length > MAX_PROMPT) { invalid += 1; log(`skipped ${schedule.id}: framed prompt exceeds ${MAX_PROMPT}`); continue; }
    appendJob(file, { v: 1, id, prompt: framed, ts: now, state: 'queued', principal: `schedule:${schedule.id}`,
      ...(schedule.workspace ? { workspace: schedule.workspace } : {}) });
    jobs.set(id, { v: 1, id, prompt: framed, ts: now, state: 'queued', principal: `schedule:${schedule.id}` });
    enqueued += 1;
    log(`schedule ${schedule.id} bucket ${bucket} -> job ${id}`);
  }
  writeHeartbeat(base, { v: 1, ts: Date.now(), source: 'herdgate-scheduler', enqueued, admitted, invalid, gone });
  log(`tick: ${enqueued} enqueued, ${admitted} already admitted, ${invalid} invalid, ${gone} target gone`);
}

tick(now0);
if (looping) {
  const timer = setInterval(() => tick(Date.now()), loopSeconds * 1000);
  timer.unref?.();
} else {
  process.exit(0);
}
