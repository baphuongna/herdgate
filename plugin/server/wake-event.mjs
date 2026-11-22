#!/usr/bin/env node
// Wake-by-herdr-event: the [[events]] hooks in herdr-plugin.toml run this file
// once per event — a short-lived process, never a daemon. Herdr is the observer
// now: pane.agent_status_changed says the child's turn closed (idle|done),
// pane.exited/pane.closed say the pane is gone. Wake no longer depends on the
// child cooperating (arm + marker + journal watcher — three live bugs made it
// silently miss); the spawn registry supplies the parent edge, delivery reuses
// pi-wake's quiet-wait protocol, and a per-child sidecar dedupes episodes by
// the child's agent revision. Any failure logs to stderr and exits 0 — an
// event hook must never raise a noisy toast, and a user pane is never touched.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findReceipt, journalBase } from './pi-receipts.mjs';
import { SETTLED, SETTLE_DIRECTIVE, deathFrame, deliverToParent, herdrRunner, paneForSession, patchSpawn, readAllSpawns, writeFileVerified } from './pi-wake.mjs';

const HOOKED = new Set(['pane.agent_status_changed', 'pane.exited', 'pane.closed']);
/** herdr-pings semantics: 'done' = settled-UNSEEN, not process exit — both
 *  idle and done mean "the child finished its turn"; working/blocked wake no
 *  one, and the `agent` label (process alive) is irrelevant to a settle. */
const WAKE_STATUSES = new Set(['idle', 'done']);
const log = (line) => console.error(`herdgate wake-event: ${line}`);

const delayMs = (env, name, fallback) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** HERDR_PLUGIN_EVENT_JSON carries {event, data}; tolerate a bare data object. */
function eventData(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

const sidecarPath = (base, id) => join(base, `${id}.wake.json`);

function readSidecar(base, id) {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(base, id), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** tmp+rename + stamp+byte-verify (pi-wake.writeFileVerified): a crash
 *  mid-write leaves the OLD sidecar (or none) — never a half file — and a
 *  write that lies about landing is caught and retried once. Updates happen
 *  only AFTER a frame actually landed, so a crash before delivery never
 *  suppresses the next wake either. */
function writeSidecar(base, id, value) {
  writeFileVerified(sidecarPath(base, id), `${JSON.stringify(value)}\n`, { log });
}

/** flock-style try-lock for event bursts — herdr-sidebar LaunchLock
 *  (ensure.rs acquire(false)): one settle fans out to status+exit+closed
 *  hooks at once, and herdr runs them concurrently with no sequence number,
 *  so without serialization two peers can both read "no sidecar yet" and
 *  double-deliver. try semantics (the sidebar's focus-mode): busy -> exit 0
 *  at once, a peer is already handling this child. Node has no flock(2), so
 *  the lock is the report's sanctioned atomic mkdir — same acquire-or-skip;
 *  a crashed holder self-heals via the staleness steal (age > stale window). */
const wakeLockPath = (base) => join(base, 'wake.lock');

function acquireWakeLock(base, env) {
  const file = wakeLockPath(base);
  const staleMs = delayMs(env, 'HERDGATE_WAKE_LOCK_STALE_MS', 60_000);
  const tryLock = () => {
    try { mkdirSync(file, { mode: 0o700 }); return true; }
    catch { return false; }
  };
  if (tryLock()) return true;
  try {
    if (Date.now() - statSync(file).mtimeMs > staleMs) { // crashed holder: steal once
      rmSync(file, { recursive: true, force: true });
      return tryLock();
    }
  } catch { /* a peer raced the steal: treat as busy */ }
  return false;
}

const releaseWakeLock = (base) => rmSync(wakeLockPath(base), { recursive: true, force: true });

/** Drop sidecars whose child left the registry (compacted away after 200
 *  spawns) — runs only on our own children's events, never throws. */
function sweepSidecars(base, liveIds) {
  try {
    for (const name of readdirSync(base)) {
      if (!name.endsWith('.wake.json')) continue;
      const id = name.slice(0, -'.wake.json'.length);
      if (!liveIds.has(id)) unlinkSync(join(base, name));
    }
  } catch { /* nothing to sweep */ }
}

/** The event-driven settle frame: the wake-skill banner line, then the
 *  self-describing tag line (directive rides IN the frame — it must survive
 *  the parent's context compaction). Receipt enrichment (title/tokens) is
 *  best effort: with no receipt the frame still goes — exactly the strength
 *  of the event architecture over arm/marker cooperation. */
export function eventWakeFrame({ spawn, agentStatus, receipt, generation, at = Date.now() }) {
  const name = spawn?.name ?? 'child';
  const bits = [`[herdgate-wake child=${name}`, `id=${spawn?.id ?? '?'}`, `status=${agentStatus}`];
  if (receipt?.reason) bits.push(`reason=${receipt.reason}`);
  if (receipt?.title) bits.push(`title="${String(receipt.title).replace(/\s+/g, ' ').slice(0, 60)}"`);
  if (receipt?.usage && Number.isFinite(receipt.usage.totalTokens)) bits.push(`tokens=${receipt.usage.totalTokens}`);
  bits.push('via=herdr-event', `ts=${new Date(at).toISOString()}`);
  // Generation token (herdr-sesh requestID): the parent's revision at fire
  // time rides IN the frame, so a frame landing after the parent turned is
  // self-describing about when it was minted.
  if (Number.isFinite(generation)) bits.push(`gen=${generation}]`);
  else bits.push(']');
  const line = `${bits.join(' ')}${SETTLE_DIRECTIVE}`;
  const body = line.length <= 480 ? line : `${bits.join(' ').slice(0, 300)}…]${SETTLE_DIRECTIVE}`;
  const headline = receipt?.title ? String(receipt.title).replace(/\s+/g, ' ').slice(0, 60) : 'việc con đã settle — herdr báo';
  return `🔔 WAKE — agent ${name} ${agentStatus}: ${headline}\n${body}`;
}

/** DIED: the exact dwake banner (the parent's handling protocol recognizes the
 *  format) plus the via=herdr-event tag line. */
export function eventDeathFrame(spawn, at = Date.now()) {
  const name = spawn?.name ?? 'child';
  return `${deathFrame(spawn)}\n[herdgate-wake child=${name} id=${spawn?.id ?? '?'} status=died via=herdr-event ts=${new Date(at).toISOString()}]`;
}

/** idle/done: the child's turn closed. Dedupe per episode via the child's own
 *  agent revision (herdr agent get), then deliver through the parent's
 *  quiet-wait and record the episode only AFTER the frame landed. A revision
 *  probe that fails wakes anyway unless the heartbeat says corpse (fail
 *  open — a duplicate is recoverable, a missed wake is not). */
function onStatusChanged(env, { data, paneId, spawn, base, run, listPanes, agentProbe }) {
  const status = data?.agent_status;
  if (!WAKE_STATUSES.has(status)) return;                    // working/blocked transitions wake nobody
  const panes = listPanes();
  if (!panes.some(p => p?.pane_id === paneId)) {
    return log(`child ${spawn.name} pane ${paneId} is gone — the exit event owns the wake`);
  }
  let revision = null;
  try { revision = run('agent', 'get', paneId)?.result?.agent?.revision ?? null; } catch { revision = null; }
  const sidecar = readSidecar(base, spawn.id);
  // Heartbeat liveness (herdr-sidebar ipc.rs: HEARTBEAT_STALE_SECS = 20 —
  // "a corpse keeps both label and token", and a herdr resume replays
  // idle/done for panes whose TUI died long ago). The sidecar stamps
  // lastHeartbeatAt on every delivered frame; a settle whose revision never
  // moved (or cannot be probed) backed by a heartbeat staler than 20s is a
  // corpse settle — drop the fake frame, log it, wake nobody.
  const heartbeatStaleMs = delayMs(env, 'HERDGATE_WAKE_HEARTBEAT_STALE_MS', 20_000);
  const lastHeartbeatAt = typeof sidecar.lastHeartbeatAt === 'number' ? sidecar.lastHeartbeatAt : null;
  const now = Date.now();
  const revisionHeld = revision !== null && sidecar.lastRevision === revision;
  if ((revisionHeld || revision === null) && lastHeartbeatAt !== null && now - lastHeartbeatAt > heartbeatStaleMs) {
    return log(`child ${spawn.name} ${status} but revision ${revision ?? '?'} never moved and the heartbeat is ${((now - lastHeartbeatAt) / 1000) | 0}s stale — corpse settle, frame dropped`);
  }
  if (revision !== null && sidecar.lastRevision === revision) {
    return log(`child ${spawn.name} episode rev ${revision} already woke the parent — deduped`);
  }
  // One-id chain: the receipt request id IS the spawn id; the sessionId
  // fallback only covers odd record shapes. Enrichment may still come back
  // null (no arm, journal elsewhere) — the frame goes regardless.
  const receipt = findReceipt(base, spawn.id) ?? findReceipt(base, spawn.sessionId);
  // Generation token (herdr-sesh requestID): capture the PARENT's revision at
  // fire time and mint it into the frame. If the parent turns while we wait
  // for a quiet moment, delivery proceeds anyway — the drift is logged by
  // deliverToParent, never used to drop a wake.
  const parentPane = spawn.parentPaneId && panes.some(p => p?.pane_id === spawn.parentPaneId)
    ? spawn.parentPaneId
    : paneForSession(panes, spawn.parentSessionId);
  let generation = null;
  if (parentPane) {
    try { generation = run('agent', 'get', parentPane)?.result?.agent?.revision ?? null; } catch { generation = null; }
  }
  log(`child ${spawn.name} ${status} (rev ${revision ?? '?'}) — waking the parent`);
  deliverToParent({
    spawn, line: eventWakeFrame({ spawn, agentStatus: status, receipt, generation }), label: `settled ${status}`,
    run, listPanes, agentProbe, log, generation,
    retryDelayMs: () => new Promise(r => setTimeout(r, delayMs(env, 'HERDGATE_WAKE_RETRY_MS', 3000))),
    settleDelayMs: () => new Promise(r => setTimeout(r, delayMs(env, 'HERDGATE_WAKE_SETTLE_MS', 2000))),
    maxWaitMs: delayMs(env, 'HERDGATE_WAKE_MAX_WAIT_MS', 15 * 60 * 1000),
    onDelivered: () => writeSidecar(base, spawn.id, { ...sidecar, lastRevision: revision, lastWakeAt: Date.now(), lastHeartbeatAt: Date.now() }),
  });
}

/** pane.exited/pane.closed: the pane is gone. One DIED per child — a parent's
 *  intentional close or a settle that landed in time is not a death. The
 *  registry is marked BEFORE waking, exactly like the old death watch. */
function onPaneGone(env, { spawn, base, run, listPanes, agentProbe }) {
  if (spawn.died === true) return;                    // already reported once
  if (spawn.closedBy === 'parent') return;            // closed on purpose
  if (!spawn.parentPaneId) return;                    // no parent-pane edge: not ours to report
  const receipt = findReceipt(base, spawn.id);
  if (receipt && SETTLED.has(receipt.status)) {
    return log(`child ${spawn.name} settled ${receipt.status} before the pane closed — not a death`);
  }
  const marked = patchSpawn(base, spawn.id, { died: true, diedAt: Date.now() });
  if (!marked) return;                                // record vanished mid-flight: nothing to wake about
  const sidecar = readSidecar(base, spawn.id);
  writeSidecar(base, spawn.id, { ...sidecar, died: true, diedAt: Date.now() });
  log(`child ${marked.name} pane ${marked.paneId} vanished before settling — waking the parent`);
  deliverToParent({
    spawn: marked, line: eventDeathFrame(marked), label: 'DIED',
    run, listPanes, agentProbe, log,
    retryDelayMs: () => new Promise(r => setTimeout(r, delayMs(env, 'HERDGATE_WAKE_RETRY_MS', 3000))),
    settleDelayMs: () => new Promise(r => setTimeout(r, delayMs(env, 'HERDGATE_WAKE_SETTLE_MS', 2000))),
    maxWaitMs: delayMs(env, 'HERDGATE_WAKE_MAX_WAIT_MS', 15 * 60 * 1000),
    // A delivered DIED frame is a heartbeat too: it proves the pipeline is
    // live, so later corpse verdicts for this child measure from here.
    onDelivered: () => writeSidecar(base, spawn.id, { ...readSidecar(base, spawn.id), lastHeartbeatAt: Date.now() }),
  });
}

/** Handle one herdr plugin event. Splits cleanly: not our event or not our
 *  pane → silent exit before a single herdr call; ours → dedupe/deliver. */
export function runWakeEvent(env = process.env) {
  const eventName = env.HERDR_PLUGIN_EVENT ?? '';
  if (!HOOKED.has(eventName)) return;
  let payload = null;
  try { payload = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON || '{}'); }
  catch (error) {
    return log(`unreadable HERDR_PLUGIN_EVENT_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = eventData(payload);
  const paneId = typeof data?.pane_id === 'string' ? data.pane_id.trim() : '';
  if (!paneId) return log(`${eventName} carries no pane_id — nothing to do`);
  const base = journalBase(env);
  const run = herdrRunner();
  const listPanes = () => { try { return run('pane', 'list')?.result?.panes ?? []; } catch { return []; } };
  const agentProbe = (pane) => {
    const agent = run('agent', 'get', pane)?.result?.agent;
    return { status: agent?.agent_status, revision: agent?.revision ?? null };
  };
  const spawns = readAllSpawns(base);
  const spawn = spawns.find(s => s.paneId === paneId);
  if (!spawn) return;                                 // a user pane: silently never touched
  // Burst guard BEFORE a single herdr call: a busy lock means a peer hook is
  // already deciding for this child — exit 0 and let it finish.
  if (!acquireWakeLock(base, env)) {
    return log(`wake lock busy — a burst-peer hook is already handling child ${spawn.name}, exiting`);
  }
  try {
    sweepSidecars(base, new Set(spawns.map(s => s.id)));
    if (eventName === 'pane.agent_status_changed') return onStatusChanged(env, { data, paneId, spawn, base, run, listPanes, agentProbe });
    return onPaneGone(env, { spawn, base, run, listPanes, agentProbe });
  } finally {
    releaseWakeLock(base);                             // async delivery continues lock-free (single-flight per process)
  }
}

/** CLI entry — never throws: an event hook failing loudly would spam toasts. */
export function main() {
  try {
    runWakeEvent(process.env);
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
