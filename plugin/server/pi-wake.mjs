// Wake-on-settle: when a spawned child's receipt settles, wake the PARENT
// agent's pane with a one-line frame — the controller never polls, never holds
// a watch process; the alert arrives as its next input (the same pattern as
// scheduler wake frames). Spawn registry supplies the parent edge; herdr pane
// run delivers. The live path is the herdr [[events]] hook (server/wake-event.mjs):
// herdr observes the child, so wake survives a child that never arms or dies
// with its pane. Failures (blocked parent, gone pane, herdr down) log and drop
// — a missed wake is recoverable from the journal, a crash is not.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSpawns } from '../../experiments/pi-spawn/registry.mjs';
import { findReceipt } from './pi-receipts.mjs';

const note = (line) => console.error(`herdgate pi-wake: ${line}`);

const SCOPE = /^[0-9a-f]{16}$/;
/** A receipt that proves the child finished speaking — anything else is silence.
 *  Final settles (replied/failed/canceled) wake a parent; invalidated/expired
 *  intents (unknown) carry no result to act on, and a vanished child belongs
 *  to the death watch below. */
export const SETTLED = new Set(['replied', 'failed', 'canceled']);

/** The handling directive that rides IN every settle frame, on purpose: the
 *  protocol must survive context compaction in the parent — a bare status line
 *  gets a bare ack (observed live); the instruction makes every wake
 *  self-describing. Shared by the journal-watch frame and the herdr-event
 *  frame (server/wake-event.mjs) so the wording never forks. */
export const SETTLE_DIRECTIVE = ' → việc con đã settle. LÀM TRỌN TRONG TURN NÀY: chạy test mục tiêu, review diff, commit nếu đạt, rồi báo user ngắn gọn — không chỉ ack.';

/** Every spawn record across workspace scopes (spawn + self declarations). */
export function readAllSpawns(base) {
  const out = [];
  let scopes = [];
  try { scopes = readdirSync(base).filter(n => SCOPE.test(n)); }
  catch { return out; }
  for (const scope of scopes) {
    for (const entry of readSpawns(join(base, scope, 'spawns.jsonl'))) out.push(entry);
  }
  return out;
}

/** The spawn edge for a child session: controller records win over self-declared. */
export function parentOf(spawns, childSessionId) {
  return spawns.find(s => s.sessionId === childSessionId && s.parentSessionId && !s.self)
    ?? spawns.find(s => s.sessionId === childSessionId && s.parentSessionId)
    ?? null;
}

/** The pane currently showing a session (its agent_session file ends _<id>.jsonl). */
export function paneForSession(panes, sessionId) {
  const suffix = `_${sessionId}.jsonl`;
  const pane = (panes ?? []).find(p => typeof p?.agent_session?.value === 'string'
    && p.agent_session.value.endsWith(suffix));
  return pane?.pane_id ?? null;
}

/** One terse line: enough for the parent to act, never the reply text. */
export function wakeFrame(entry, spawn) {
  const bits = [`[herdgate-wake child=${spawn.name ?? 'child'}`, `id=${entry.id}`, `status=${entry.status}`];
  if (entry.reason) bits.push(`reason=${entry.reason}`);
  if (entry.title) bits.push(`title="${String(entry.title).replace(/\s+/g, ' ').slice(0, 60)}"`);
  if (entry.usage && Number.isFinite(entry.usage.totalTokens)) bits.push(`tokens=${entry.usage.totalTokens}`);
  bits.push(`ts=${new Date(entry.ts).toISOString()}]`);
  const line = bits.join(' ') + SETTLE_DIRECTIVE;
  return line.length <= 480 ? line : `${bits.join(' ').slice(0, 300)}…]${SETTLE_DIRECTIVE}`;
}

/** Resolve the parent's pane and deliver one frame once the parent is quietly
 *  between turns. Shared by settle wakes, death wakes AND the herdr event hook
 *  (server/wake-event.mjs) — the quiet-wait protocol below is the load-bearing
 *  part and must never fork the tree.
 *
 *  Delivery waits for the parent to be BETWEEN TURNS, stably. Two live
 *  incidents (wtest2, wfork1) showed why "idle" alone is not enough: herdr
 *  flips the agent idle milliseconds BEFORE the turn's final message lands, so
 *  a wake injected at that instant becomes a PENDING message, and Pi's pending
 *  queue then forks the session tree from a stale leaf — the handling turn runs
 *  in full on an orphan branch that neither the human's view nor the parent's
 *  context ever adopts, and everyone swears nothing arrived. Waiting for the
 *  agent revision to hold steady across two probes proves the turn truly
 *  closed; the injected text then submits against the live leaf. */
export function deliverToParent({ spawn, line, label, run, listPanes, agentState, agentProbe, onDelivered, generation,
    log = () => {}, retryDelayMs = () => new Promise(r => setTimeout(r, 3000)), settleDelayMs = () => new Promise(r => setTimeout(r, 2000)), maxWaitMs = 15 * 60 * 1000 }) {
  const deliver = (pane, waited, seenRevision) => {
    // Generation drift (herdr-sesh requestID, adapted): the caller captured the
    // parent's revision at fire time; if the parent turned while we waited for
    // a quiet moment the token no longer matches — but a wake is NOT a UI
    // refresh, dropping it is unrecoverable, so the frame still goes and the
    // drift is logged for the trail.
    if (generation != null && seenRevision != null && seenRevision !== generation) {
      log(`wake: parent pane ${pane} revision drifted ${generation}->${seenRevision} while waiting — delivering anyway (child ${spawn.name} ${label})`);
    }
    try {
      // pane run TYPES into the parent's terminal — the same live-branch path
      // as /herdgate-arm markers. herdr agent prompt submits through the
      // agent/RPC handle whose leaf pointer stagnates after one fork: every
      // wake then extends an orphan branch no one ever sees (three live
      // incidents, each parented to the previous orphan's leaf).
      run('pane', 'run', pane, line);
      log(`wake: child ${spawn.name} ${label} -> parent pane ${pane}${waited ? ` (waited ${(waited / 1000) | 0}s for a quiet parent)` : ''}`);
      // Bookkeeping AFTER the frame landed (episode dedupe sidecars etc.) — a
      // failure here must never undo or retry a delivered wake.
      try { onDelivered?.(); } catch { /* never fatal */ }
    } catch (error) {
      log(`wake failed: ${error instanceof Error ? error.message : String(error)}`); // agent_blocked etc: never fatal
    }
  };
  const panes = listPanes();
  // The parent's REAL pane, recorded at spawn time. Session-file lookup alone
  // is ambiguous: a second pi bound to the same session (a restore leftover)
  // makes every wake land in the ghost — observed live, four times.
  let pane = spawn.parentPaneId && panes.some(p => p?.pane_id === spawn.parentPaneId)
    ? spawn.parentPaneId
    : paneForSession(panes, spawn.parentSessionId);
  if (!pane) {
    log(`wake: parent ${String(spawn.parentSessionId).slice(0, 8)} pane gone — child ${spawn.name} ${label}`);
    return;
  }
  if (!agentProbe) {
    // Legacy single-state probe: idle means deliver (kept for callers
    // without a revision; the rich probe above is the safe path).
    if (!agentState) return deliver(pane, 0);
    const started = Date.now();
    const attemptState = () => {
      let state = 'unknown';
      try { state = agentState(pane) ?? 'unknown'; }
      catch { state = 'unknown'; }
      if (state === 'idle') return deliver(pane, Date.now() - started);
      if (Date.now() - started >= maxWaitMs) {
        return log(`wake: parent pane ${pane} stayed ${state} for ${(maxWaitMs / 60000) | 0}min — dropped wake for ${spawn.name} (journal keeps the settle)`);
      }
      void retryDelayMs().then(attemptState);
    };
    return attemptState();
  }
  const started = Date.now();
  const attempt = () => {
    let probe = null;
    try { probe = agentProbe(pane); } catch { probe = null; }
    const state = probe?.status ?? 'unknown';
    if (state === 'working' || state === 'blocked' || !probe) {
      if (Date.now() - started >= maxWaitMs) {
        return log(`wake: parent pane ${pane} stayed ${state} for ${(maxWaitMs / 60000) | 0}min — dropped wake for ${spawn.name} (journal keeps the settle)`);
      }
      return void retryDelayMs().then(attempt);
    }
    // Idle-ish: prove the turn CLOSED — the revision must hold across a settle delay.
    void settleDelayMs().then(() => {
      let again = null;
      try { again = agentProbe(pane); } catch { again = null; }
      if (again && again.status !== 'working' && again.status !== 'blocked' && again.revision === probe.revision) {
        return deliver(pane, Date.now() - started, again.revision);
      }
      if (Date.now() - started >= maxWaitMs) {
        return log(`wake: parent pane ${pane} never quieted (${state}→${again?.status ?? '?'}, rev ${probe.revision}→${again?.revision ?? '?'}) — dropped wake for ${spawn.name}`);
      }
      void retryDelayMs().then(attempt);
    });
  };
  attempt();
}

/** Build the onSettle callback for watchReceipts. */
export function wakeParentOnSettle({ spawnBase, run, listPanes, agentState, agentProbe, log = () => {}, retryDelayMs, settleDelayMs, maxWaitMs }) {
  return (entry) => {
    try {
      if (!entry?.sessionId || !entry?.id) return;
      if (!SETTLED.has(entry.status)) {
        return log(`wake: ${entry.id} settled ${entry.status} — not a final settle, no parent wake`);
      }
      const spawn = parentOf(readAllSpawns(spawnBase), entry.sessionId);
      if (!spawn) return;                       // not a spawned child: nothing to wake
      deliverToParent({ spawn, line: wakeFrame(entry, spawn), label: entry.status,
        run, listPanes, agentState, agentProbe, log, retryDelayMs, settleDelayMs, maxWaitMs });
    } catch (error) {
      log(`wake failed: ${error instanceof Error ? error.message : String(error)}`); // agent_blocked etc: never fatal
    }
  };
}

/** The herdr-pings lesson: a child that dies with its pane (bridge crash) never
 *  settles, so no journal event can ever fire a wake — the silence IS the
 *  failure. The banner follows the wake-skill format so the parent's handling
 *  protocol recognizes the frame and acts inside its turn. */
export function deathFrame(spawn) {
  return `🔔 WAKE — agent ${spawn?.name ?? 'child'} DIED: pane biến mất chưa kịp settle — kiểm tra registry, restore nếu cần`;
}

/** Wake a parent about a lost child (pane vanished before any final settle). */
export function wakeParentOnDeath({ run, listPanes, agentState, agentProbe, log = () => {}, retryDelayMs, settleDelayMs, maxWaitMs }) {
  return (spawn) => {
    try {
      if (!spawn?.parentSessionId) return;
      deliverToParent({ spawn, line: deathFrame(spawn), label: 'DIED',
        run, listPanes, agentState, agentProbe, log, retryDelayMs, settleDelayMs, maxWaitMs });
    } catch (error) {
      log(`wake failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Stamp+byte-verified persistence — herdcats follower.rs:483-488 applied to
 *  writes instead of tailing: tmp+rename, then read the file BACK and compare
 *  every byte, taking a stat stamp before AND after the read so a read racing
 *  another rewrite is detected rather than trusted (mtime/size alone lie — a
 *  same-length rewrite is invisible to them). A miss rewrites exactly ONCE;
 *  a second miss logs and gives up — never throws: bookkeeping must not kill
 *  a wake. `readback` is the host-trait seam (herdr-sidebar FakeRefresh
 *  style): tests inject lying reads to prove the retry; production always
 *  reads the real file. */
export function writeFileVerified(file, bytes, { log = note, readback = null } = {}) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const stampOf = (st) => (st ? `${st.dev ?? 0}:${st.ino ?? 0}:${st.size}:${st.mtimeMs}` : null);
  const realReadback = (path) => {
    try {
      const before = stampOf(statSync(path));
      const back = readFileSync(path);
      const after = stampOf(statSync(path));
      return before && after && before === after ? back : null; // moved under us: not trustworthy
    } catch { return null; }
  };
  const verify = (path, attempt) => (readback ? readback(path, attempt) : realReadback(path));
  const attempt = (n) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, data, { mode: 0o600 });
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch (error) {
      log(`verified write #${n} failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const back = verify(file, n);
    return back !== null && back.length === data.length && back.equals(data);
  };
  if (attempt(1)) return true;
  if (attempt(2)) return true; // hụt → ghi lại đúng một lần, rồi đọc lại lần nữa
  log(`verified write still mismatches for ${file} after one retry — giving up (not fatal)`);
  return false;
}

/** Patch one spawn record inside the scope file that actually holds it. The
 *  registry's own updateSpawn patches only the caller's cwd scope — the
 *  publisher daemon sits elsewhere, so deaths are marked wherever the record
 *  lives. Returns the updated record, or null when no scope holds the id. */
export function patchSpawn(base, id, patch) {
  let scopes = [];
  try { scopes = readdirSync(base).filter(name => SCOPE.test(name)); }
  catch { return null; }
  for (const scope of scopes) {
    const file = join(base, scope, 'spawns.jsonl');
    const entries = readSpawns(file);
    if (!entries.some(entry => entry.id === id)) continue;
    let updated = null;
    const next = entries.map(entry => entry.id === id ? (updated = { ...entry, ...patch }) : entry);
    // Stamp+byte-verified: the mark (died/closedBy) is what keeps ONE frame per
    // child — a write that silently misses would re-fire wakes forever.
    if (!writeFileVerified(file, `${next.map(entry => JSON.stringify(entry)).join('\n')}\n`)) return null;
    return updated;
  }
  return null;
}

/** Children whose pane vanished before any final settle — the death-watch
 *  candidates. ONLY records with a parent-pane edge qualify: human panes and
 *  self-declared worker sessions are never watched. An empty pane list means
 *  herdr itself is unreachable/restarting — that is not six deaths, it is zero
 *  answers; fail silent instead of spamming DIED frames. */
export function scanSpawnDeaths({ spawnBase, listPanes }) {
  let panes = [];
  try { panes = listPanes() ?? []; }
  catch { return []; }
  if (!panes.length) return [];
  const alive = new Set(panes.map(p => p?.pane_id).filter(Boolean));
  const dead = [];
  for (const spawn of readAllSpawns(spawnBase)) {
    if (!spawn.parentPaneId || !spawn.paneId) continue;               // no parent edge: not ours to watch
    if (spawn.died === true || spawn.closedBy === 'parent') continue; // already reported / closed on purpose
    if (alive.has(spawn.paneId)) continue;                            // pane still there
    const receipt = findReceipt(spawnBase, spawn.id);
    if (receipt && SETTLED.has(receipt.status)) continue;             // settled in time; the close was earned
    dead.push(spawn);
  }
  return dead;
}

/** The publisher's 30s death watch (a script poll, never the journal watcher):
 *  scan → mark died:true in the registry FIRST (one DIED per child, never a
 *  spam loop) → wake the parent through the same quiet-delivery path. */
export function watchSpawnDeaths({ spawnBase, run, listPanes, agentState, agentProbe, log = () => {}, intervalMs = 30_000, retryDelayMs, settleDelayMs, maxWatchMs }) {
  const wakeOne = wakeParentOnDeath({ run, listPanes, agentState, agentProbe, log, retryDelayMs, settleDelayMs, maxWaitMs: maxWatchMs });
  const tick = () => {
    let dead = [];
    try { dead = scanSpawnDeaths({ spawnBase, listPanes }); }
    catch (error) {
      return log(`death scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const spawn of dead) {
      const marked = patchSpawn(spawnBase, spawn.id, { died: true, diedAt: Date.now() });
      if (!marked) continue; // record vanished mid-scan: nothing to wake about
      log(`death: child ${spawn.name} pane ${spawn.paneId} vanished before settling — waking the parent`);
      wakeOne(marked);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Default herdr runner for the publisher process (tolerates plain-text output). */
export function herdrRunner() {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
  return (...args) => {
    const out = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    try { return JSON.parse(out); } catch { return { raw: out }; }
  };
}
