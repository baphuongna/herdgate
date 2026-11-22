import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readSpawns } from '../experiments/pi-spawn/registry.mjs';
import { writeFileVerified } from '../plugin/server/pi-wake.mjs';

const execFile = promisify(execFileCb);
const WAKE_EVENT = fileURLToPath(new URL('../plugin/server/wake-event.mjs', import.meta.url));

const PARENT = '11111111-1111-4111-8111-111111111111';
const KID = '44444444-4444-4444-8444-444444444444';
const KID2 = '55555555-5555-4555-8555-555555555555';
const KID3 = '66666666-6666-4666-8666-666666666666';
const DIED_BANNER = '🔔 WAKE — agent evkid DIED: pane biến mất chưa kịp settle — kiểm tra registry, restore nếu cần';

const roots: string[] = [];
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** The stub herdr: every call is logged to HG_STUB_LOG (BEFORE answering, so
 *  the log doubles as a deterministic per-pane call counter); pane list /
 *  agent get answer from HG_STUB_STATE so tests can move revisions between
 *  episodes — and `bumpAfterCall: N` makes a pane answer revision+1 on every
 *  call after its Nth (a parent that turned mid-wait). */
const STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
let prior = [];
try { prior = readFileSync(process.env.HG_STUB_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l).argv); } catch {}
try { appendFileSync(process.env.HG_STUB_LOG, JSON.stringify({ argv }) + '\\n'); } catch {}
let state = {};
try { state = JSON.parse(readFileSync(process.env.HG_STUB_STATE, 'utf8')); } catch {}
if (argv[0] === 'pane' && argv[1] === 'list') {
  console.log(JSON.stringify({ result: { panes: state.panes ?? [] } }));
} else if (argv[0] === 'agent' && argv[1] === 'get') {
  const cfg = (state.agents ?? {})[argv[2]] ?? { agent_status: 'idle', revision: 99 };
  const seen = prior.filter(a => a[0] === 'agent' && a[1] === 'get' && a[2] === argv[2]).length;
  const revision = cfg.bumpAfterCall != null && seen >= cfg.bumpAfterCall ? cfg.revision + 1 : cfg.revision;
  console.log(JSON.stringify({ result: { agent: { agent_status: cfg.agent_status, revision } } }));
} else {
  console.log(JSON.stringify({ result: {} }));
}
`;

type Fx = { base: string; stub: string; state: string; calls: string };
type Pane = Record<string, unknown>;
type StubAgent = { agent_status: string; revision: number; bumpAfterCall?: number };
type StubState = { panes: Pane[]; agents: Record<string, StubAgent> };

const line = (id: string, name: string, paneId: string, over: Record<string, unknown> = {}) =>
  ({ id, sessionId: id, parentSessionId: PARENT, parentPaneId: 'w9:p0', name, paneId, ts: 1, ...over });

const parentPane: Pane = { pane_id: 'w9:p0', agent_session: { value: `/x/a_${PARENT}.jsonl` } };

function defaultState(): StubState {
  return {
    panes: [parentPane, { pane_id: 'w9:pC' }, { pane_id: 'w9:pD' }, { pane_id: 'w9:pX' }],
    agents: {
      'w9:pC': { agent_status: 'idle', revision: 10 },
      'w9:pD': { agent_status: 'idle', revision: 10 },
      'w9:p0': { agent_status: 'idle', revision: 99 },
    },
  };
}

function fixture(spawns: Record<string, unknown>[]): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'hg-wake-event-'));
  roots.push(dir);
  const base = join(dir, 'base');
  const tools = join(dir, 'tools');
  mkdirSync(join(base, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl'), spawns.map(s => JSON.stringify(s)).join('\n') + '\n');
  const stub = join(tools, 'herdr-stub.mjs');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const state = join(tools, 'state.json');
  const calls = join(tools, 'calls.jsonl');
  writeFileSync(state, JSON.stringify(defaultState()));
  return { base, stub, state, calls };
}

const setState = (fx: Fx, state: unknown) => writeFileSync(fx.state, JSON.stringify(state));

async function fire(fx: Fx, event: string, data: Record<string, unknown> | null, rawJson?: string, extraEnv: Record<string, string> = {}) {
  const { stderr } = await execFile(process.execPath, [WAKE_EVENT], {
    env: {
      ...process.env,
      HERDR_PLUGIN_EVENT: event,
      HERDR_PLUGIN_EVENT_JSON: rawJson ?? JSON.stringify({ event, data: data ?? {} }),
      HERDR_BIN_PATH: fx.stub,
      HERDGATE_PI_RECEIPT_DIR: fx.base,
      HG_STUB_LOG: fx.calls,
      HG_STUB_STATE: fx.state,
      HERDGATE_WAKE_SETTLE_MS: '5',
      HERDGATE_WAKE_RETRY_MS: '5',
      HERDGATE_WAKE_MAX_WAIT_MS: '10000',
      ...extraEnv,
    },
  });
  return stderr;
}

function callsOf(fx: Fx): string[][] {
  try {
    return readFileSync(fx.calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).argv as string[]);
  } catch { return []; }
}
const framesOf = (fx: Fx) => callsOf(fx).filter(a => a[0] === 'pane' && a[1] === 'run');

test('agent_status_changed idle wakes once per episode revision, to the recorded parent pane', async () => {
  const fx = fixture([line(KID, 'evkid', 'w9:pC')]);
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle', workspace_id: 'w9' });
  let frames = framesOf(fx);
  assert.equal(frames.length, 1, 'one wake per settle');
  assert.equal(frames[0][2], 'w9:p0', 'the recorded parent pane wins');
  assert.match(frames[0][3], /^🔔 WAKE — agent evkid idle: /);
  assert.match(frames[0][3], new RegExp(`\\[herdgate-wake child=evkid id=${KID} status=idle via=herdr-event ts=`));
  assert.match(frames[0][3], /LÀM TRỌN TRONG TURN NÀY/, 'the handling directive rides in the frame');
  const sidecar = JSON.parse(readFileSync(join(fx.base, `${KID}.wake.json`), 'utf8'));
  assert.equal(sidecar.lastRevision, 10);
  assert.ok(Number.isFinite(sidecar.lastWakeAt));

  // same episode (idle→done flips status, revision holds): deduped
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'done' });
  assert.equal(framesOf(fx).length, 1, 'a repeated episode revision wakes nobody again');

  // a NEW episode: the child's revision moved, the parent wakes again
  const state = defaultState();
  state.agents['w9:pC'] = { agent_status: 'idle', revision: 11 };
  setState(fx, state);
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' });
  frames = framesOf(fx);
  assert.equal(frames.length, 2, 'a new revision is a new episode — wake again');
  assert.equal(JSON.parse(readFileSync(join(fx.base, `${KID}.wake.json`), 'utf8')).lastRevision, 11);
});

test('user panes and non-wake statuses stay silent — no frame, no sidecar, no herdr calls', async () => {
  const fx = fixture([line(KID, 'evkid', 'w9:pC')]);
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pU', agent_status: 'idle' });  // not our child
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'working' }); // mid-turn
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'blocked' });
  assert.equal(framesOf(fx).length, 0);
  assert.deepEqual(callsOf(fx), [], 'not even a pane list — silent before any herdr call');
  assert.deepEqual(readdirSync(fx.base).filter(n => n.endsWith('.wake.json')), []);
});

test('pane.exited without a settle reports DIED exactly once; parent closes and earned closes stay silent', async () => {
  const fx = fixture([
    line(KID, 'evkid', 'w9:pC'),
    line(KID2, 'donekid', 'w9:pD'),
    line(KID3, 'closedkid', 'w9:pX', { closedBy: 'parent', closedAt: 5 }),
  ]);
  writeFileSync(join(fx.base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'),
    JSON.stringify({ v: 1, id: KID2, status: 'replied', sessionId: KID2, ts: 3 }) + '\n');
  setState(fx, { panes: [parentPane], agents: { 'w9:p0': { agent_status: 'idle', revision: 99 } } }); // child panes gone
  await fire(fx, 'pane.exited', { pane_id: 'w9:pC', workspace_id: 'w9' });
  const frames = framesOf(fx);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2], 'w9:p0');
  assert.ok(frames[0][3].startsWith(DIED_BANNER), 'the exact dwake banner opens the frame');
  assert.match(frames[0][3], new RegExp(`\\[herdgate-wake child=evkid id=${KID} status=died via=herdr-event ts=`));
  const stored = readSpawns(join(fx.base, 'aaaaaaaaaaaaaaaa', 'spawns.jsonl')).find(s => s.id === KID)!;
  assert.equal(stored.died, true, 'the registry record is marked died');
  assert.ok(Number.isFinite(stored.diedAt));
  assert.equal(JSON.parse(readFileSync(join(fx.base, `${KID}.wake.json`), 'utf8')).died, true);

  await fire(fx, 'pane.closed', { pane_id: 'w9:pC' });   // exited then closed: one DIED, never two
  await fire(fx, 'pane.exited', { pane_id: 'w9:pD' });   // settled before the pane closed: earned, not death
  await fire(fx, 'pane.closed', { pane_id: 'w9:pX' });   // the parent closed it on purpose
  await fire(fx, 'pane.exited', { pane_id: 'w9:pX' });
  assert.equal(framesOf(fx).length, 1);
});

test('frames enrich with title/tokens when a receipt exists — and still go without one', async () => {
  const fx = fixture([line(KID, 'richkid', 'w9:pC'), line(KID2, 'barekid', 'w9:pD')]);
  writeFileSync(join(fx.base, 'aaaaaaaaaaaaaaaa', 'receipts.jsonl'),
    JSON.stringify({ v: 1, id: KID, status: 'replied', sessionId: KID, ts: 4,
      title: 'chạy  test  wake', usage: { totalTokens: 1234, costUsd: 0.01 } }) + '\n');
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' });
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pD', agent_status: 'done' });
  const frames = framesOf(fx);
  assert.equal(frames.length, 2, 'the frame goes with or without a receipt');
  const rich = frames.find(f => f[3].includes(`id=${KID}`))![3];
  assert.match(rich, /title="chạy test wake"/);
  assert.match(rich, /tokens=1234/);
  assert.match(rich, /via=herdr-event/);
  const bare = frames.find(f => f[3].includes(`id=${KID2}`))![3];
  assert.match(bare, /status=done via=herdr-event/);
  assert.ok(!bare.includes('title='), 'no invented enrichment');
  assert.ok(!bare.includes('tokens='));
});

test('a garbage HERDR_PLUGIN_EVENT_JSON logs to stderr and exits 0 — never throws', async () => {
  const fx = fixture([line(KID, 'evkid', 'w9:pC')]);
  const stderr = await fire(fx, 'pane.agent_status_changed', null, '{"data": broken');
  assert.match(stderr, /unreadable HERDR_PLUGIN_EVENT_JSON/);
  assert.equal(framesOf(fx).length, 0);
  assert.deepEqual(callsOf(fx), []);
});

// ── wake-event hardening (wave A3): burst lock, heartbeat corpse, verified writes, generation drift ──

test('a busy wake lock (burst peer) exits 0 at once — zero deliveries, zero herdr calls', async () => {
  const fx = fixture([line(KID, 'evkid', 'w9:pC')]);
  const lock = join(fx.base, 'wake.lock');
  mkdirSync(lock);                                       // a peer hook holds the lock right now
  const stderr = await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' });
  assert.match(stderr, /wake lock busy/);
  assert.deepEqual(callsOf(fx), [], 'the skipped peer made not one herdr call');
  assert.equal(framesOf(fx).length, 0);
  assert.ok(existsSync(lock), 'a fresh foreign lock is never stolen or removed');
  // once the peer releases, the next event delivers normally — no wedge
  rmSync(lock, { recursive: true, force: true });
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' });
  assert.equal(framesOf(fx).length, 1);
  assert.ok(!existsSync(lock), 'the holder cleans the lock up after itself');
});

test('a settle whose revision never moved on a stale heartbeat is a corpse — frame dropped', async () => {
  const fx = fixture([line(KID, 'evkid', 'w9:pC')]);
  const env = { HERDGATE_WAKE_HEARTBEAT_STALE_MS: '40' };
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' }, undefined, env);
  assert.equal(framesOf(fx).length, 1, 'the first settle wakes normally');
  const sidecar = JSON.parse(readFileSync(join(fx.base, `${KID}.wake.json`), 'utf8'));
  assert.ok(Number.isFinite(sidecar.lastHeartbeatAt), 'delivery stamps the sidecar heartbeat');
  // The herdr-resume replay: the same idle/done arrives again >20s (here
  // >40ms) later with the revision frozen — a corpse settle wakes nobody.
  await new Promise(r => setTimeout(r, 90));
  const stderr = await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'done' }, undefined, env);
  assert.match(stderr, /corpse settle/);
  assert.equal(framesOf(fx).length, 1, 'the corpse frame is dropped');
  // a LIVE episode (revision moved) pierces a stale heartbeat — wake anyway
  const state = defaultState();
  state.agents['w9:pC'] = { agent_status: 'idle', revision: 11 };
  setState(fx, state);
  await new Promise(r => setTimeout(r, 90));
  await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' }, undefined, env);
  assert.equal(framesOf(fx).length, 2, 'a moved revision proves liveness — wake');
});

test('sidecar persistence is stamp+byte-verified: one miss self-heals, a stubborn miss logs and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-wake-verify-'));
  roots.push(dir);
  const file = join(dir, 'sidecar.json');
  const logs: string[] = [];
  const attempts: number[] = [];
  // The untyped .mjs import leaves writeFileVerified implicit-any; pin the
  // host-trait seam shape so the injected readback is properly typed.
  const verifiedWrite = writeFileVerified as (file: string, bytes: string,
    opts?: { log?: (m: string) => void; readback?: (path: string, attempt: number) => Buffer }) => boolean;
  // Read-back #1 lies (a torn read / a rewrite racing the read-back): the
  // writer must notice the byte mismatch, rewrite ONCE, and land exact bytes.
  let ok = verifiedWrite(file, '{"lastRevision":10}\n', {
    log: (m: string) => logs.push(m),
    readback: (p: string, n: number) => { attempts.push(n); return n === 1 ? Buffer.from('{"lastRevision":11}\n') : readFileSync(p); },
  });
  assert.equal(ok, true, 'the single miss recovered on the rewrite');
  assert.deepEqual(attempts, [1, 2], 'exactly one rewrite after the miss');
  assert.equal(readFileSync(file, 'utf8'), '{"lastRevision":10}\n', 'the retry landed the exact bytes');
  assert.deepEqual([...logs], [], 'a recovered write logs nothing');
  // Still lying: two attempts, one log line, no throw — bookkeeping never kills a wake.
  attempts.length = 0;
  ok = verifiedWrite(file, '{"died":true}\n', { log: (m: string) => logs.push(m), readback: (_p: string, n: number) => { attempts.push(n); return Buffer.from('garbage'); } });
  assert.equal(ok, false);
  assert.deepEqual(attempts, [1, 2], 'one retry, then give up');
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /still mismatches.*not fatal/);
});

test('a parent revision drifting while we wait still delivers — logged, generation minted at fire', async () => {
  const fx = fixture([line(KID, 'driftkid', 'w9:pC')]);
  const state = defaultState();
  // The parent turns exactly after the fire-time probe: gen=99 is minted,
  // every later probe answers 100 — stable across the settle delay, so the
  // frame delivers and the drift is only LOGGED (never dropped).
  state.agents['w9:p0'] = { agent_status: 'idle', revision: 99, bumpAfterCall: 1 };
  setState(fx, state);
  const stderr = await fire(fx, 'pane.agent_status_changed', { pane_id: 'w9:pC', agent_status: 'idle' });
  const frames = framesOf(fx);
  assert.equal(frames.length, 1, 'drift never drops a wake');
  assert.match(frames[0][3], /gen=99\]/, 'the frame carries the fire-time generation');
  assert.match(stderr, /drifted 99->100/);
});
