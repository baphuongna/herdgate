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
// Recap pass (herdr-recap lesson: write the recap while the cache is warm): with
// HERDGATE_PI_RECAP=1 every tick also looks for sessions whose reply settled and
// nobody came back for — replied, older than the horizon, transcript still on
// disk — and enqueues ONE bounded, deterministic recap job per session.
//
//   node experiments/pi-worker/scheduler.mjs --config <schedule.json> [--once | --loop <s>] [--now <epoch-ms>] [--raw-prompts]
//
// Schedule file (local, 0600 recommended — it holds prompts):
//   { "schedules": [ { "id": "morning-summary", "everySeconds": 3600, "prompt": "...",
//                      "workspace": "optional-allowlist-name" } ] }
// Schedule ids must be unique in one queue; ids collide only if duplicated here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJob, jobsFile, readJobs, readWorkspaces, scheduledRunId, writeHeartbeat, workerBase, MAX_PROMPT, WORKSPACE_NAME } from '../../plugin/server/pi-worker.mjs';
import { findReceipt, journalBase, readJournal } from '../../plugin/server/pi-receipts.mjs';
import { findSessionFile, sessionRoots } from '../../plugin/server/pi-receipt-search.mjs';

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

const RECAP_AFTER_MS_DEFAULT = 10 * 60_000; // a reply newer than this is still "being watched"
const RECAP_MAX_DEFAULT = 3;
const RECAP_SESSION = /^[A-Za-z0-9._-]{1,64}$/; // must ride the recap:<sessionId> principal
const SCOPE_DIR = /^[0-9a-f]{16}$/;

/** Deterministic recap id per session (same digest-to-v4 trick as scheduledRunId,
 *  different domain so the two never collide): one recap per session, ever — a
 *  restarted scheduler re-admits the same id instead of summarizing twice. */
function recapRunId(sessionId) {
  const digest = createHash('sha256').update(`recap:${sessionId}`).digest('hex');
  const variant = (parseInt(digest[16], 16) & 0x3) | 0x8;
  return [digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`,
    `${variant.toString(16)}${digest.slice(17, 20)}`, digest.slice(20, 32)].join('-');
}

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
  recapTick(now);
}

/** Summarize replied sessions nobody came back for. Runs after the regular
 *  schedules, gated by HERDGATE_PI_RECAP=1 (re-read every tick), bounded by
 *  RECAP_MAX per tick, once per session by construction. Never throws into the
 *  tick loop — a recap problem must not take the schedules down with it. */
function recapTick(now) {
  if (process.env.HERDGATE_PI_RECAP !== '1') return; // off: skip entirely, no noise
  const afterOverride = Number(process.env.HERDGATE_PI_RECAP_AFTER_MS);
  const maxOverride = Number(process.env.HERDGATE_PI_RECAP_MAX);
  const waitMs = Number.isFinite(afterOverride) && afterOverride > 0 ? afterOverride : RECAP_AFTER_MS_DEFAULT;
  const cap = Number.isInteger(maxOverride) && maxOverride > 0 ? maxOverride : RECAP_MAX_DEFAULT;
  try {
    const jobs = readJobs(file);
    // Newest entry per receipt id across every workspace scope — the merged map
    // IS the findReceipt answer for existence checks, without re-scanning per id.
    const latest = new Map();
    let scopes = [];
    try { scopes = readdirSync(receiptsBase).filter(name => SCOPE_DIR.test(name)); }
    catch { return; } // no journal base yet: nothing to recap
    for (const scope of scopes) {
      for (const entry of readJournal(join(receiptsBase, scope, 'receipts.jsonl'))) {
        const prior = latest.get(entry.id);
        if (!prior || entry.ts >= prior.ts) latest.set(entry.id, entry);
      }
    }
    const roots = sessionRoots();
    const seen = new Set(); // session ids already considered this tick
    let considered = 0;
    let enqueued = 0;
    for (const entry of latest.values()) {
      if (entry.status !== 'replied') continue; // only conversations that settled well
      if (typeof entry.principal === 'string' && entry.principal.startsWith('recap:')) continue; // never recap the recapper
      if (entry.ts > now - waitMs) continue; // still warm — the human may come back
      const { sessionId } = entry;
      if (!RECAP_SESSION.test(sessionId) || seen.has(sessionId)) continue; // many receipts may share one session
      seen.add(sessionId);
      const id = recapRunId(sessionId);
      if (jobs.get(id) || latest.has(id)) continue; // recap already admitted or already ran
      const transcript = findSessionFile(roots, sessionId);
      if (!transcript) continue; // cache cold: nothing to read
      considered += 1;
      if (enqueued >= cap) continue;
      const prompt = `[herdgate-recap session=${sessionId} file=${transcript}]

`
        + `Đọc transcript Pi ở đường dẫn sau (read-only, không sửa): ${transcript}. `
        + `Tóm tắt đúng 3 dòng: (1) nhiệm vụ là gì (2) kết quả/chân trời cuối cùng (3) việc còn bỏ dở nếu có. Không làm gì khác.`;
      appendJob(file, { v: 1, id, prompt, ts: now, state: 'queued', principal: `recap:${sessionId}` });
      jobs.set(id, { v: 1, id, prompt, ts: now, state: 'queued', principal: `recap:${sessionId}` });
      enqueued += 1;
      log(`recap: session ${sessionId} -> job ${id}`);
    }
    if (enqueued > 0) log(`recap: enqueued ${enqueued} (${considered} considered)`);
  } catch (error) {
    log(`recap pass skipped: ${error.message}`);
  }
}

tick(now0);
if (looping) {
  const timer = setInterval(() => tick(Date.now()), loopSeconds * 1000);
  timer.unref?.();
} else {
  process.exit(0);
}
