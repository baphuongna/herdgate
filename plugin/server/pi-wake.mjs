// Wake-on-settle: when a spawned child's receipt settles, the publisher injects a
// one-line wake frame into the PARENT agent's pane — the controller never polls,
// never holds a watch process; the alert arrives as its next input (the same
// pattern as scheduler wake frames). Spawn registry supplies the parent edge;
// herdr's agent prompt delivers. Failures (blocked parent, gone pane, herdr down)
// log and drop — a missed wake is recoverable from the journal, a crash is not.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSpawns } from '../../experiments/pi-spawn/registry.mjs';

const SCOPE = /^[0-9a-f]{16}$/;

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

/** One terse line: enough for the parent to act, never the reply text.
 *  The directive rides IN the frame on purpose: the handling protocol must
 *  survive context compaction in the parent — a bare status line gets a bare
 *  ack (observed live); the instruction makes every wake self-describing. */
export function wakeFrame(entry, spawn) {
  const bits = [`[herdgate-wake child=${spawn.name ?? 'child'}`, `id=${entry.id}`, `status=${entry.status}`];
  if (entry.reason) bits.push(`reason=${entry.reason}`);
  if (entry.title) bits.push(`title="${String(entry.title).replace(/\s+/g, ' ').slice(0, 60)}"`);
  if (entry.usage && Number.isFinite(entry.usage.totalTokens)) bits.push(`tokens=${entry.usage.totalTokens}`);
  bits.push(`ts=${new Date(entry.ts).toISOString()}]`);
  const directive = ' → việc con đã settle. LÀM TRỌN TRONG TURN NÀY: chạy test mục tiêu, review diff, commit nếu đạt, rồi báo user ngắn gọn — không chỉ ack.';
  const line = bits.join(' ') + directive;
  return line.length <= 480 ? line : `${bits.join(' ').slice(0, 300)}…]${directive}`;
}

/** Build the onSettle callback for watchReceipts.
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
export function wakeParentOnSettle({ spawnBase, run, listPanes, agentState, agentProbe, log = () => {}, retryDelayMs = () => new Promise(r => setTimeout(r, 3000)), settleDelayMs = () => new Promise(r => setTimeout(r, 2000)), maxWaitMs = 15 * 60 * 1000 }) {
  return (entry) => {
    try {
      if (!entry?.sessionId || !entry?.id) return;
      const spawn = parentOf(readAllSpawns(spawnBase), entry.sessionId);
      if (!spawn) return;                       // not a spawned child: nothing to wake
      const deliver = (pane, waited) => {
        try {
          // pane run TYPES into the parent's terminal — the same live-branch path
          // as /herdgate-arm markers. herdr agent prompt submits through the
          // agent/RPC handle whose leaf pointer stagnates after one fork: every
          // wake then extends an orphan branch no one ever sees (three live
          // incidents, each parented to the previous orphan's leaf).
          run('pane', 'run', pane, wakeFrame(entry, spawn));
          log(`wake: child ${spawn.name} ${entry.status} -> parent pane ${pane}${waited ? ` (waited ${(waited / 1000) | 0}s for a quiet parent)` : ''}`);
        } catch (error) {
          log(`wake failed: ${error instanceof Error ? error.message : String(error)}`); // agent_blocked etc: never fatal
        }
      };
      const pane = paneForSession(listPanes(), spawn.parentSessionId);
      if (!pane) {
        log(`wake: parent ${String(spawn.parentSessionId).slice(0, 8)} pane gone — child ${spawn.name} ${entry.status}`);
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
            return deliver(pane, Date.now() - started);
          }
          if (Date.now() - started >= maxWaitMs) {
            return log(`wake: parent pane ${pane} never quieted (${state}→${again?.status ?? '?'}, rev ${probe.revision}→${again?.revision ?? '?'}) — dropped wake for ${spawn.name}`);
          }
          void retryDelayMs().then(attempt);
        });
      };
      attempt();
    } catch (error) {
      log(`wake failed: ${error instanceof Error ? error.message : String(error)}`); // agent_blocked etc: never fatal
    }
  };
}

/** Default herdr runner for the publisher process. */
export function herdrRunner() {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
  return (...args) => JSON.parse(execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
