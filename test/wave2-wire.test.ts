/**
 * Wave 2 wiring — the observer modules behind real device ops (sysmon.mjs,
 * port-attr.mjs, pi-transcript.mjs through index.mjs) plus the pi-spawn
 * continue envelope (herdr-link/1 inbound wrapper) and the
 * setHerdrRunnerForTests argv-recording seam.
 *
 * Device-channel shape is the web-pwa2 one: a local cloud, the real publisher
 * child, a receipts/spawns fixture, a stub herdr whose pane list exposes (or
 * hides) a pid column on demand. The seam part imports the REAL task.mjs and
 * swaps only the herdr runner — no module mocking.
 *
 *   node --test test/wave2-wire.test.ts
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';
import { scopeFor } from '../plugin/server/pi-receipts.mjs';

const root = join(import.meta.dirname, '..');

// task.mjs has no .d.mts (constraint: only task.mjs may change), so the helper
// loads through a non-literal specifier — type-checked as a cast, like pi-task.
const taskUrl = new URL('../experiments/pi-spawn/task.mjs', import.meta.url);
const task = await import(taskUrl.href) as {
  setHerdrRunnerForTests: (runner?: (file: string, args: string[]) => { stdout: string }) => void;
  cmdContinue: (name: string, taskfileOrText: string) => void;
  buildInboundWrapper: (marker: string, spawnId: string, body: string) => string;
  ENVELOPE_HINT: string;
};

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (performance.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(50);
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  try { await exited; } finally { clearTimeout(timer); }
}

// Journal fixture ids must satisfy RECEIPT_ID / JOB_ID.
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const SID_A = '77777777-7777-4777-8777-777777777777'; // enriched via the spawn record's sessionFile
const SID_B = '88888888-8888-4888-8888-888888888888'; // enriched via the PI_HOME session-root fallback
const SID_C = '99999999-9999-4999-8999-999999999999'; // no transcript anywhere → clear error op

/** A minimal Pi v3 session transcript for one session id (the schema
 *  pi-transcript.mjs parses: session header + one user/assistant turn). */
const LAST_ISO = '2026-11-24T10:00:02.000Z';
const LAST_TS = Date.parse(LAST_ISO); // the newest message timestamp, ms
function transcript(sessionId: string, assistantModel: string, tokens: number) {
  return [
    JSON.stringify({ type: 'session', id: sessionId, version: 3, timestamp: '2026-11-24T10:00:00.000Z' }),
    JSON.stringify({ id: 'e1', parentId: null, type: 'message', timestamp: '2026-11-24T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ id: 'e2', parentId: 'e1', type: 'message', timestamp: LAST_ISO,
      message: { role: 'assistant', model: assistantModel, provider: 'test', timestamp: LAST_TS, content: [],
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: tokens, contextTokens: tokens, cost: { total: 0.01 } } } }),
  ].join('\n') + '\n';
}

// A stub herdr that answers `pane list` — with a pid column, unless the
// W2_NOPID marker file exists (the "herdr exposes no pid field" case). Every
// argv lands in W2_CALLS as one JSON line.
const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.W2_CALLS, JSON.stringify(args) + '\\n');
const out = obj => console.log(JSON.stringify(obj));
if (args[0] === 'pane' && args[1] === 'list') {
  const pid = existsSync(process.env.W2_NOPID) ? null : Number(readFileSync(process.env.W2_PIDFILE, 'utf8').trim());
  out({ result: { panes: [{ pane_id: 'w0:p1', agent_status: 'idle', ...(pid ? { pid } : {}) }] } });
} else {
  out({ result: {} });
}
`;

type AgentsReply = { op: string; at: string; agents: { key: string; cpuPct: number; ramBytes: number; procs: number }[]; note?: string };
type PortsRow = { port: number; proto: string; pid?: number; cmd?: string; ownerKey?: string };
type PortsReply = { op: string; attributed: PortsRow[]; unattributed: PortsRow[]; note?: string };
type EnrichReply = { op: string; id: string; sessionId?: string; model?: string | null; contextTokens?: number | null;
  turns?: number; usageTotal?: { totalTokens: number; costUsd: number }; lastTs?: number | null;
  reason?: string; code?: string; message?: string };

test('wave2 ops: sysmon.snapshot, ports.list, receipt.enrich over the device channel', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-wave2-'));
  const log: string[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let publisher: ChildProcess | undefined;
  try {
    // --- receipts journal + spawn registry fixture, in ONE base dir.
    // The publisher runs with cwd = dir, so its scope is scopeFor(dir).
    const receipts = join(dir, 'receipts');
    const scope = scopeFor(dir);
    mkdirSync(join(receipts, scope), { recursive: true });
    const now = Date.now();
    writeFileSync(join(receipts, scope, 'receipts.jsonl'), [
      JSON.stringify({ v: 1, id: uid(1), status: 'replied', sessionId: SID_A, ts: now - 1000, principal: 'device:d_a' }),
      JSON.stringify({ v: 1, id: uid(2), status: 'replied', sessionId: SID_B, ts: now - 2000, principal: 'device:d_a' }),
      JSON.stringify({ v: 1, id: uid(3), status: 'replied', sessionId: SID_C, ts: now - 3000, principal: 'device:d_a' }),
    ].join('\n') + '\n');
    // Transcript A sits wherever the spawn record says (sessionFile); B hides in
    // PI_HOME's session roots (the fallback); C has nothing anywhere.
    const sessions = join(dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const transcriptA = join(sessions, `1700000000000_${SID_A}.jsonl`);
    writeFileSync(transcriptA, transcript(SID_A, 'qwen-test', 165));
    const piHome = join(dir, 'pi-home');
    mkdirSync(join(piHome, 'agent', 'sessions', 'slug'), { recursive: true });
    writeFileSync(join(piHome, 'agent', 'sessions', 'slug', `1700000000001_${SID_B}.jsonl`), transcript(SID_B, 'fallback-test', 200));
    // One live spawn child on pane w0:p1; only record A carries a sessionFile.
    writeFileSync(join(receipts, scope, 'spawns.jsonl'), [
      JSON.stringify({ id: uid(1), sessionId: SID_A, paneId: 'w0:p1', name: 'w2child', cwd: dir, ts: now, sessionFile: transcriptA }),
      JSON.stringify({ id: uid(2), sessionId: SID_B, paneId: 'w0:p9', name: 'gone-child', cwd: dir, ts: now - 5000 }),
    ].join('\n') + '\n');

    // --- stub herdr: pane list with/without a pid column, argv logged
    const callsFile = join(dir, 'herdr-calls.log');
    const pidFile = join(dir, 'shell.pid');
    const noPidMarker = join(dir, 'panes-nopid');
    writeFileSync(pidFile, `${process.pid}\n`); // the cloud listens inside THIS process → attribution is provable
    const stub = join(dir, 'herdr-stub.mjs');
    writeFileSync(stub, STUB_SOURCE);
    chmodSync(stub, 0o755);

    // --- local cloud with one room and one read-scoped device
    const accounts = [{ id: 'a1', name: 'test', token: 'wave2-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'wave2-host');
    const { device, secret } = state.addDevice(room, 'wave2-device', 'read');
    cloud = await startCloud({ accounts, statePath, log: entry => log.push(entry) });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    // --- the real publisher child, pointed at the fixtures
    const config = join(dir, 'publisher');
    mkdirSync(config);
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    publisher = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
        HERDGATE_PI_RECEIPTS: '1', HERDGATE_PI_RECEIPT_DIR: receipts,
        PI_HOME: piHome,
        W2_CALLS: callsFile, W2_PIDFILE: pidFile, W2_NOPID: noPidMarker,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    publisher.stderr!.setEncoding('utf8').on('data', chunk => log.push(chunk));
    await waitFor('publisher connected', () => log.some(entry => entry.includes('herdgate: connected to')));

    const ask = async (payload: Record<string, unknown>, expectOp: string): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: device.id, deviceSecret: secret });
        assert.equal(hello.t, 'hello', JSON.stringify(hello));
        await sock.send({ t: 'frame', payload });
        const deadline = performance.now() + 10_000;
        for (;;) {
          const frame = await sock.expect('frame');
          const reply = frame.payload as { op?: string } | undefined;
          if (reply?.op === expectOp || reply?.op === 'error') return reply as Record<string, unknown>;
          if (performance.now() > deadline) throw new Error(`no ${expectOp} frame in time (got ${String(reply?.op)})`);
        }
      } finally { sock.close(); }
    };

    t.diagnostic('sysmon.snapshot: one row per live spawn child, module shape, fail-closed');
    const snap = await ask({ op: 'sysmon.snapshot' }, 'sysmon.snapshot.result') as unknown as AgentsReply;
    assert.equal(snap.op, 'sysmon.snapshot.result');
    assert.ok(!Number.isNaN(Date.parse(snap.at)), 'at is an ISO timestamp');
    assert.ok(!('note' in snap), 'pid column present → no note');
    if (process.platform === 'linux') { // /proc exists → the module really sampled
      assert.equal(snap.agents.length, 1, 'one live child (w0:p1); the gone pane w0:p9 is not live');
      const row = snap.agents[0];
      assert.equal(row.key, 'w2child');
      assert.ok(row.cpuPct >= 0 && row.cpuPct <= 100, 'cpuPct is a share of the machine, clamped');
      assert.ok(row.ramBytes >= 0 && row.procs >= 1, 'ramBytes/procs are real /proc numbers');
    } else {
      assert.deepEqual(snap.agents, [], 'no /proc → fail closed to []');
    }
    assert.ok(readFileSync(callsFile, 'utf8').split('\n').includes(JSON.stringify(['pane', 'list'])),
      'roots came from the live pane list, not a guess');

    t.diagnostic('sysmon.snapshot without a pid column: roots empty + note, never a guess');
    writeFileSync(noPidMarker, '');
    await delay(1_100); // the op is subprocess-backed → 1/s throttle per device
    const blind = await ask({ op: 'sysmon.snapshot' }, 'sysmon.snapshot.result') as unknown as AgentsReply;
    assert.equal(blind.op, 'sysmon.snapshot.result');
    assert.deepEqual(blind.agents, [], 'registry stores no pids — nothing can be sampled');
    assert.match(blind.note!, /no pid field/);

    t.diagnostic('ports.list: the cloud port attributes to the live child; hidden pid → unattributed + note');
    rmSync(noPidMarker);
    await delay(1_100);
    const ports = await ask({ op: 'ports.list' }, 'ports.list.result') as unknown as PortsReply;
    assert.equal(ports.op, 'ports.list.result');
    assert.ok(!('note' in ports), 'pid column present → no note');
    assert.ok(Array.isArray(ports.attributed) && Array.isArray(ports.unattributed));
    if (process.platform === 'linux') { // the gateway socket is owned by THIS process → provably attributed
      const mine = ports.attributed.find(row => row.port === cloud.port && row.proto === 'tcp');
      assert.ok(mine, `cloud port ${cloud.port} must be attributed to the live child`);
      assert.equal(mine.ownerKey, 'w2child', 'owner is the spawn child the shell pid descends from');
      assert.equal(typeof mine.pid, 'number');
      assert.equal(typeof mine.cmd, 'string');
      for (const row of ports.unattributed) assert.ok(row.port > 0 && (row.proto === 'tcp' || row.proto === 'tcp6'));
    }
    writeFileSync(noPidMarker, '');
    await delay(1_100);
    const blindPorts = await ask({ op: 'ports.list' }, 'ports.list.result') as unknown as PortsReply;
    assert.deepEqual(blindPorts.attributed, [], 'no shell pids → an owner is never invented');
    assert.match(blindPorts.note!, /no pid field/);
    if (process.platform === 'linux') {
      assert.ok(blindPorts.unattributed.some(row => row.port === cloud.port),
        'the cloud listener stays observable, just unattributed');
    }
    rmSync(noPidMarker);

    t.diagnostic('receipt.enrich: spawn-record sessionFile, PI_HOME fallback, and a clear error when absent');
    const a = await ask({ op: 'receipt.enrich', id: uid(1) }, 'receipt.enrich.result') as unknown as EnrichReply;
    assert.equal(a.op, 'receipt.enrich.result');
    assert.equal(a.id, uid(1));
    assert.equal(a.sessionId, SID_A);
    assert.equal(a.model, 'qwen-test');
    assert.equal(a.contextTokens, 165);
    assert.equal(a.turns, 1);
    assert.deepEqual(a.usageTotal, { totalTokens: 165, costUsd: 0.01 });
    assert.equal(a.lastTs, LAST_TS);

    const b = await ask({ op: 'receipt.enrich', id: uid(2) }, 'receipt.enrich.result') as unknown as EnrichReply;
    assert.equal(b.op, 'receipt.enrich.result');
    assert.equal(b.sessionId, SID_B);
    assert.equal(b.model, 'fallback-test');
    assert.equal(b.turns, 1, 'no sessionFile on the record → Pi session roots answered');

    const c = await ask({ op: 'receipt.enrich', id: uid(3) }, 'receipt.enrich.result') as unknown as EnrichReply;
    assert.equal(c.op, 'error', 'a missing transcript is a clear error op, never a throw');
    assert.equal(c.code, 'receipt.enrich');
    assert.match(c.message!, /no readable transcript/);

    const ghost = await ask({ op: 'receipt.enrich', id: 'not-a-uuid' }, 'receipt.enrich.result') as unknown as EnrichReply;
    assert.equal(ghost.op, 'error');
    assert.equal(ghost.code, 'receipt.enrich');

    t.diagnostic('a refused op never took the host down');
    const after = await ask({ op: 'receipt.enrich', id: uid(1) }, 'receipt.enrich.result') as unknown as EnrichReply;
    assert.equal(after.op, 'receipt.enrich.result');
    assert.equal(after.model, 'qwen-test');
  } catch (err) {
    t.diagnostic(log.join('\n').slice(-4000));
    throw err;
  } finally {
    await stop(publisher);
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── E1: the continue envelope (herdr-link/1-style inbound wrapper) ──

test('buildInboundWrapper: marker on line 1, envelope JSON as the LAST line, parseable back', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const marker = `[herdr-request:${id}]`;
  const body = 'Tiếp tục: viết test cho fix.';
  const prompt = task.buildInboundWrapper(marker, id, body);
  const lines = prompt.split('\n');
  assert.equal(lines[0], marker, 'line 1 is the marker EXACTLY (the hasMarker boundary)');
  assert.ok(prompt.includes(body), 'the task body rides along');
  assert.equal(lines.at(-2), task.ENVELOPE_HINT, 'one short routing instruction before the envelope');
  const envelope = JSON.parse(lines.at(-1)!) as { replyTo: string; via: string };
  assert.deepEqual(envelope, { replyTo: `spawn:${id}`, via: 'herdgate-task' },
    'the last line parses back into the herdr-link/1-style envelope');
  assert.equal(JSON.stringify(JSON.parse(lines.at(-1)!)), lines.at(-1), 'the envelope line is strict JSON');
});

// ── E3: setHerdrRunnerForTests — argv recorded through the REAL module ──

test('setHerdrRunnerForTests: a swapped runner records the exact argv of one continue', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const marker = `[herdr-request:${id}]`;
  const base = mkdtempSync(join(tmpdir(), 'hg-wave2-seam-'));
  // The registry is scoped by the CALLING process cwd — cmdContinue runs here.
  const scope = scopeFor(process.cwd());
  mkdirSync(join(base, scope), { recursive: true });
  writeFileSync(join(base, scope, 'spawns.jsonl'),
    JSON.stringify({ id, sessionId: '33333333-3333-4333-8333-333333333333', paneId: 'w1:p1', name: 'seam-child', cwd: base, ts: Date.now() }) + '\n');

  const calls: { file: string; args: string[] }[] = [];
  const prevOverride = process.env.HERDGATE_PI_RECEIPT_DIR;
  process.env.HERDGATE_PI_RECEIPT_DIR = base;
  try {
    task.setHerdrRunnerForTests((file, args) => {
      calls.push({ file, args: [...args] });
      if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: [{ pane_id: 'w1:p1' }] } }) };
      if (args[0] === 'agent' && args[1] === 'get') return { stdout: JSON.stringify({ result: { agent: { agent_status: 'idle' } } }) };
      return { stdout: JSON.stringify({ result: { ok: true } }) };
    });
    task.cmdContinue('seam-child', 'Tiếp tục: viết test cho fix.');
  } finally {
    task.setHerdrRunnerForTests(undefined); // restore the production runner
    if (prevOverride === undefined) delete process.env.HERDGATE_PI_RECEIPT_DIR;
    else process.env.HERDGATE_PI_RECEIPT_DIR = prevOverride;
    rmSync(base, { recursive: true, force: true });
  }

  assert.deepEqual(calls.map(call => call.args.slice(0, 2)),
    [['pane', 'list'], ['agent', 'get'], ['agent', 'prompt']],
    'the protocol sequence: pane liveness → agent busy-check → prompt, nothing else');
  assert.equal(calls[0].file, process.env.HERDR_BIN_PATH || 'herdr', 'the runner saw the resolved binary');
  const prompt = calls[2].args[3];
  const lines = prompt.split('\n');
  assert.equal(lines[0], marker, 'the prompt still opens with the marker ALONE');
  assert.deepEqual(JSON.parse(lines.at(-1)!), { replyTo: `spawn:${id}`, via: 'herdgate-task' },
    'the recorded prompt carries the parseable envelope as its last line');
});
