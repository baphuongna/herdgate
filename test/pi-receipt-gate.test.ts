import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';
import type { RawData } from 'ws';
import { MIN_PI_VERSION, scheduledRunId, versionAtLeast } from '../plugin/server/pi-worker.mjs';

const exec = promisify(execFile);
const herdr = process.env.TEST_HERDR_BIN;
const pi = process.env.TEST_PI_BIN;
const root = join(import.meta.dirname, '..');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

type Receipt = { id: string; status: string; marker?: string; reason?: string; requestEntryId?: string; responseEntryId?: string };
type FixtureEvent = { event: string; call?: number; aborted?: boolean; reason?: string; inputHash?: string };

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  try { await exited; } finally { clearTimeout(timer); }
}

// Linux integration only. Uses no real Pi models, Herdr profiles, Gate, or SSH key.
// TEST_HERDR_BIN=$(command -v herdr) TEST_PI_BIN=$(command -v pi) node --test test/pi-receipt-gate.test.ts
test('Pi receipt from an existing Herdr pane survives a Gate client reconnect without resubmission', {
  skip: (process.platform !== 'linux' || !herdr || !pi) && 'requires TEST_HERDR_BIN and TEST_PI_BIN on Linux',
  timeout: 120_000,
}, async t => {
  assert.ok(herdr && pi);
  const dir = mkdtempSync(join(tmpdir(), 'hg-pi-gate-'));
  const home = (name: string): NodeJS.ProcessEnv => {
    const path = join(dir, name);
    const config = join(path, 'config', 'herdr');
    mkdirSync(config, { recursive: true });
    const configFile = join(config, 'config.toml');
    writeFileSync(configFile, 'onboarding = false\n[remote]\nmanage_ssh_config = false\n');
    return { PATH: process.env.PATH, HOME: path, USERPROFILE: path, LANG: 'C.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/sh',
      HERDR_CONFIG_PATH: configFile, XDG_CONFIG_HOME: join(path, 'config'), XDG_STATE_HOME: join(path, 'state'),
      XDG_DATA_HOME: join(path, 'data'), PI_CODING_AGENT_DIR: join(path, 'pi-agent'), PI_TELEMETRY: '0' };
  };
  const hostEnv = home('host');
  const controllerEnv = home('controller');
  const fixtureDir = join(dir, 'fixture');
  const run = (env: NodeJS.ProcessEnv, bin: string, ...args: string[]) => exec(bin, args, { cwd: dir, env, timeout: 10_000 });
  const host = (...args: string[]) => run(hostEnv, herdr, ...args);
  const client = (...args: string[]) => run(controllerEnv, herdr, ...args);
  const tmux = (...args: string[]) => run(controllerEnv, 'tmux', '-f', '/dev/null', '-S', join(dir, 'tmux.sock'), ...args);
  const capture = async () => (await tmux('capture-pane', '-J', '-p', '-S', '-100')).stdout;
  const events = (): FixtureEvent[] => {
    const path = join(fixtureDir, 'events.jsonl');
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.pop(); // Ignore a partial append, should a read coincide with the fixture writer.
    return lines.map(line => JSON.parse(line));
  };
  const calls = () => events().filter(e => e.event === 'call').map(e => e.call);
  const send = async (text: string) => {
    const paste = join(dir, 'paste');
    writeFileSync(paste, text, { mode: 0o600 });
    await tmux('load-buffer', '-b', 'receipt-input', paste);
    await tmux('paste-buffer', '-d', '-p', '-r', '-b', 'receipt-input');
    await tmux('send-keys', 'Enter');
  };
  const receipts = async () => [...(await capture()).matchAll(/\{"id":"[0-9a-f-]+","status":"[^"\n]+"[^}\n]*\}/g)]
    .map(match => JSON.parse(match[0]) as Receipt);
  const arm = async () => {
    const prior = new Set((await receipts()).filter(r => r.status === 'armed').map(r => r.id));
    await send('/herdgate-arm');
    const result = await waitFor('new remote armed receipt', async () => (await receipts()).findLast(r =>
      r.status === 'armed' && r.marker && !prior.has(r.id)));
    assert.equal(result.marker, `[herdr-request:${result.id}]`);
    return result as Receipt & { marker: string };
  };
  const query = async (id: string, expected: string) => {
    assert.equal((await receipts()).some(r => r.id === id && r.status === expected), false, 'the expected status must be new');
    await send(`/herdgate-receipt ${id}`);
    return waitFor(`remote receipt ${expected}`, async () => (await receipts()).findLast(r => r.id === id && r.status === expected));
  };
  const log: string[] = [];
  let server: ChildProcess | undefined;
  let publisher: ChildProcess | undefined;
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let stage = 'start';
  let serverStatus: unknown;
  try {
    mkdirSync(fixtureDir);
    assert.equal((await host('--version')).stdout.trim(), 'herdr 0.9.5');
    assert.ok(versionAtLeast((await run(hostEnv, pi, '--version')).stdout.trim(), MIN_PI_VERSION),
      `Pi binary must be at least ${MIN_PI_VERSION}`);
    stage = 'start isolated Herdr and Pi';
    server = spawn(herdr, ['server'], { cwd: dir, env: hostEnv, stdio: 'ignore', detached: true });
    serverStatus = await waitFor('host Herdr', async () => {
      const status = JSON.parse((await host('status', 'server', '--json')).stdout);
      return status.running === true ? status : null;
    });
    await host('workspace', 'create', '--cwd', dir, '--label', 'pi-receipt-test', '--focus');
    const panes = JSON.parse((await host('pane', 'list')).stdout).result.panes as { pane_id: string; focused: boolean }[];
    const pane = panes.find(p => p.focused)?.pane_id;
    assert.ok(pane);
    const command = [pi, '--offline', '--no-approve', '--no-session', '--no-tools', '--no-skills', '--no-context-files',
      '--no-extensions', '-e', join(root, 'experiments/pi-receipt/observer.js'), '-e', join(root, 'test/fixtures/pi-receipt-provider.mjs'),
      '--model', 'hg-receipt-fixture/test'];
    const launchPi = () => host('pane', 'run', pane, `HG_RECEIPT_FIXTURE_DIR=${quote(fixtureDir)} HERDGATE_PI_RECEIPT_DIR=${quote(join(dir, 'receipts'))} HERDGATE_PI_RECEIPT_BODY=1 ${command.map(quote).join(' ')}`);
    await launchPi();
    await waitFor('Pi fixture in isolated host pane', async () => (await host('pane', 'read', pane, '--raw')).stdout.includes('HG_RECEIPT_FIXTURE_READY'));

    stage = 'start isolated Gate and SSH/WS publisher';
    const accounts = [{ id: 'a1', name: 'test', token: 'receipt-test-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'receipt-test-host');
    const { device, secret: actSecret } = state.addDevice(room, 'receipt-controller', 'act');
    const { device: probe, secret: probeSecret } = state.addDevice(room, 'receipt-probe', 'read');
    const key = join(dir, 'key');
    await run(controllerEnv, 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key);
    const [algo, pub] = readFileSync(key + '.pub', 'utf8').split(' ');
    state.addDeviceSshKey(device.id, algo, pub);
    cloud = await startCloud({ accounts, statePath, log: entry => log.push(entry), ssh: { port: 0, keyPath: join(dir, 'host-key.json') } });
    assert.ok(cloud.ssh);
    const config = join(dir, 'publisher');
    mkdirSync(config);
    const base = `http://127.0.0.1:${cloud.port}`;
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=${base}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    publisher = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir, env: { ...hostEnv, HERDR_BIN_PATH: herdr, HERDR_PLUGIN_ID: 'dev.herdgate.host', HERDGATE_TUI_ONLY: '1',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config, HERDGATE_PUBLISHER_CHILD: '1',
        HERDGATE_PI_RECEIPTS: '1', HERDGATE_PI_RECEIPT_DIR: join(dir, 'receipts'),
        HERDGATE_PI_WORKER: '1', HERDGATE_PI_WORKER_DIR: join(dir, 'worker') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    publisher.stderr?.setEncoding('utf8').on('data', entry => log.push(entry));
    await waitFor('publisher connected', () => log.some(entry => entry.includes('herdgate: connected to')));

    const ssh = join(dir, 'ssh_config');
    writeFileSync(ssh, `Host herdgate-test\n  HostName herdgate-test\n  User ${device.id}\n  IdentityFile "${key}"\n  UserKnownHostsFile "${join(dir, 'known_hosts')}"\n  GlobalKnownHostsFile /dev/null\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  ProxyCommand "${process.execPath}" "${join(root, 'templates/herdgate-via.mjs')}" --tunnel --gate ${base}\n`);
    await run(controllerEnv, '/usr/bin/ssh', '-F', ssh, '-o', 'StrictHostKeyChecking=accept-new', 'herdgate-test', 'exit');
    const wrapper = join(dir, 'ssh-bin');
    mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(ssh)} "$@"\n`, { mode: 0o700 });
    controllerEnv.PATH = `${wrapper}:${controllerEnv.PATH}`;
    await client('machine', 'add', 'herdgate-test', '--label', 'home', '--remote-session', 'default');
    await tmux('new-session', '-d', '-x', '200', '-y', '42', 'sleep', '75');
    await tmux('set-option', 'remain-on-exit', 'on');
    const attach = () => tmux('respawn-pane', '-k', herdr, '--remote', 'herdgate-test');
    await attach();
    await waitFor('existing Pi pane via remote TUI', async () => (await capture()).includes('HG_RECEIPT_FIXTURE_READY'));

    stage = 'exact request observed before settle';
    const first = await arm();
    const brief = `${first.marker}\nSynthetic request through the bridge: tiếng Việt`;
    await send(brief);
    await waitFor('settle barrier', () => events().some(e => e.event === 'holding_first_settle'));
    assert.equal(events().find(e => e.event === 'call')?.inputHash, createHash('sha256').update(brief).digest('hex'));
    const received = await query(first.id, 'received');
    assert.ok(received.requestEntryId);
    assert.deepEqual(calls(), [1], 'slash commands are not model inputs');
    assert.equal(events().some(e => e.event === 'settled'), false);
    assert.equal((await receipts()).some(r => r.id === first.id && r.status === 'replied'), false);
    t.diagnostic('remote: armed and received for the same request while Pi was still settling');

    stage = 'disconnect before settle and reconnect without sending again';
    const disconnects = () => log.filter(entry => entry.includes(`ssh: device ${device.id} disconnected`)).length;
    const before = disconnects();
    await tmux('respawn-pane', '-k', 'sleep', '60');
    await waitFor('Gate observed SSH disconnect', () => disconnects() > before);
    writeFileSync(join(fixtureDir, 'release'), '');
    await waitFor('Pi settles while the controller is disconnected', () => events().some(e => e.event === 'settled' && e.call === 1 && e.aborted === false));

    stage = 'structured device query with no TUI attached';
    const gatePort = cloud.port;
    // The Gate may push unsolicited frames (e.g. view updates) to a device socket;
    // wait for the reply that matches the op we asked for.
    const recvOp = async (sock: DeviceSock, op: string): Promise<Record<string, unknown>> => {
      const deadline = performance.now() + 10_000;
      for (;;) {
        const frame = await sock.expect('frame');
        const payload = frame.payload as { op?: string } | undefined;
        if (payload?.op === op || payload?.op === 'error') return payload as Record<string, unknown>;
        if (performance.now() > deadline) throw new Error(`no ${op} frame in time (got ${String(payload?.op)})`);
      }
    };
    const ask = async (id: string) => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: probe.id, deviceSecret: probeSecret });
        assert.equal(hello.t, 'hello', JSON.stringify(hello));
        await sock.send({ t: 'frame', payload: { op: 'receipt.get', id } });
        return await recvOp(sock, 'receipt.result');
      } finally { sock.close(); }
    };
    const askBody = async (id: string) => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        await sock.hello({ device: probe.id, deviceSecret: probeSecret });
        await sock.send({ t: 'frame', payload: { op: 'receipt.body', id } });
        return await recvOp(sock, 'receipt.body.result');
      } finally { sock.close(); }
    };
    const offline = await ask(first.id);
    assert.equal(offline.op, 'receipt.result');
    assert.equal(offline.id, first.id);
    assert.equal(offline.status, 'replied');
    const missing = await ask(randomUUID());
    assert.deepEqual(missing, { op: 'receipt.result', id: missing.id, status: 'unknown', reason: 'not_retained_in_runtime' });
    assert.deepEqual(calls(), [1], 'a structured query is not a model input');
    t.diagnostic('device frame query answered replied while no TUI client was attached');

    await attach();
    await waitFor('same Pi pane after reconnect', async () => (await capture()).includes('SYNTHETIC_REPLY_1'));
    const replied = await query(first.id, 'replied');
    assert.equal(replied.requestEntryId, received.requestEntryId);
    assert.ok(replied.responseEntryId);
    assert.deepEqual(calls(), [1], 'reattach and query must not send a second model input');
    t.diagnostic('Gate confirmed disconnect; Pi settled while offline; reconnect returned the same receipt with one provider call');
    const firstBody = await askBody(first.id);
    assert.equal(firstBody.op, 'receipt.body.result');
    assert.match(String(firstBody.text), /SYNTHETIC_REPLY_1/);
    assert.equal(firstBody.truncated, false);
    const noBody = await askBody(randomUUID());
    assert.equal(noBody.reason, 'body_not_retained');
    t.diagnostic('receipt.body served the archived reply; unknown ids fail closed');

    stage = 'wrong marker cannot get a reply receipt';
    const wrong = await arm();
    await send(`[herdr-request:${randomUUID()}]\nSynthetic request with the wrong marker`);
    await waitFor('wrong-marker run settled', () => events().some(e => e.event === 'settled' && e.call === 2));
    assert.deepEqual(await query(wrong.id, 'unknown'), { id: wrong.id, status: 'unknown', reason: 'request_not_observed' });
    t.diagnostic('wrong marker: Pi answered the input but did not attribute the reply to the armed ID');

    stage = 'abort a matched request through remote TUI';
    const canceled = await arm();
    await send(`${canceled.marker}\nSynthetic request to cancel`);
    await waitFor('fixture model streaming', () => events().some(e => e.event === 'waiting_for_escape'));
    await tmux('send-keys', 'Escape');
    await waitFor('aborted settle', () => events().some(e => e.event === 'settled' && e.call === 3 && e.aborted === true));
    const canceledReceipt = await query(canceled.id, 'canceled');
    assert.ok(canceledReceipt.requestEntryId);
    assert.equal(canceledReceipt.reason, 'pi_aborted');
    assert.equal(canceledReceipt.responseEntryId, undefined);
    assert.deepEqual(calls(), [1, 2, 3]);
    t.diagnostic('remote Escape: Pi aborted the matched request and did not issue a reply receipt');

    stage = 'reload and a new Pi process keep the journal without resubmission';
    await send('/reload');
    await waitFor('Pi reload completes', () => events().some(e => e.event === 'session_start' && e.reason === 'reload'));
    const kept = await query(first.id, 'replied');
    assert.equal(kept.requestEntryId, received.requestEntryId);
    assert.equal(kept.responseEntryId, replied.responseEntryId);
    await send('/quit');
    await waitFor('Pi exits back to the pane shell', async () => (await capture()).includes('$'));
    await launchPi(); // a fresh Pi process opens the same workspace and journal
    await waitFor('a new Pi process is ready', () => events().filter(e => e.event === 'session_start').length >= 3);
    await waitFor('the new Pi TUI accepts input', async () => /\/128k \(auto\)/.test(await capture()));
    await delay(400);
    const restarted = await query(first.id, 'replied');
    assert.equal(restarted.requestEntryId, received.requestEntryId);
    assert.equal(restarted.responseEntryId, replied.responseEntryId);
    const remoteAfterRestart = await ask(first.id);
    assert.deepEqual(remoteAfterRestart, { op: 'receipt.result', id: first.id, status: 'replied',
      requestEntryId: received.requestEntryId, responseEntryId: replied.responseEntryId });
    assert.deepEqual(calls(), [1, 2, 3]);
    t.diagnostic('remote reload and Pi restart: the journaled receipt survived with no extra provider call');

    stage = 'owned worker drains device-submitted jobs with no TUI';
    const piPackage = (() => {
      let at = dirname(realpathSync(pi));
      for (let up = 0; up < 6; up++) {
        const releases = join(at, 'install', 'releases');
        if (existsSync(releases)) {
          const versions = readdirSync(releases).filter(v => /^\d+\.\d+\.\d+$/.test(v))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          return join(releases, versions[versions.length - 1], 'node_modules', '@earendil-works', 'pi-coding-agent');
        }
        at = dirname(at);
      }
      throw new Error('cannot resolve the Pi package from TEST_PI_BIN');
    })();
    const act = async (payload: Record<string, unknown>) => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: device.id, deviceSecret: actSecret });
        assert.equal(hello.t, 'hello', JSON.stringify(hello));
        await sock.send({ t: 'frame', payload });
        return await recvOp(sock, 'worker.submitted');
      } finally { sock.close(); }
    };
    const workerFixture = join(dir, 'worker-fixture');
    mkdirSync(workerFixture);
    const workerEvents = (): { event: string; call?: number; inputHash?: string }[] => {
      const path = join(workerFixture, 'events.jsonl');
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; call?: number }) : [];
    };
    const runWorker = async () => {
      const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/worker.mjs'),
        '--workspace', dir, '--pi', piPackage, '--fixture-dir', workerFixture],
        { cwd: dir, env: { ...hostEnv, HERDGATE_PI_RECEIPT_DIR: join(dir, 'receipts'), HERDGATE_PI_WORKER_DIR: join(dir, 'worker'), HERDGATE_PI_RECEIPT_BODY: '1', PI_TELEMETRY: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
      const err: string[] = [];
      child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
      const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
      assert.equal(code, 0, err.join(''));
      return err.join('');
    };
    const submit = async (id: string, prompt: string) => {
      const reply = await act({ op: 'worker.submit', id, prompt });
      assert.equal(reply.op, 'worker.submitted');
      return reply;
    };
    const status = async (id: string) => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        await sock.hello({ device: probe.id, deviceSecret: probeSecret });
        await sock.send({ t: 'frame', payload: { op: 'worker.status', id } });
        return await recvOp(sock, 'worker.status.result');
      } finally { sock.close(); }
    };

    const denied = await (async () => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        await sock.hello({ device: probe.id, deviceSecret: probeSecret });
        await sock.send({ t: 'frame', payload: { op: 'worker.submit', prompt: 'read scope cannot enqueue' } });
        return await recvOp(sock, 'worker.submitted');
      } finally { sock.close(); }
    })();
    assert.equal(denied.op, 'error');
    assert.equal(denied.code, 'requires-act');

    const workerId = randomUUID();
    const workerBrief = 'Synthetic worker request: tiếng Việt';
    const submitted = await submit(workerId, workerBrief);
    assert.deepEqual(submitted, { op: 'worker.submitted', id: workerId, state: 'queued', duplicate: false });
    assert.equal((await status(workerId)).state, 'queued');
    assert.ok(!(await status(workerId)).prompt, 'status must not echo the prompt');
    await runWorker();
    const workerReceipt = await ask(workerId);
    assert.equal(workerReceipt.op, 'receipt.result');
    assert.equal(workerReceipt.id, workerId);
    assert.equal(workerReceipt.status, 'replied');
    assert.ok(workerReceipt.requestEntryId && workerReceipt.responseEntryId);
    assert.equal((await status(workerId)).state, 'replied');
    assert.deepEqual(workerEvents().filter(e => e.event === 'call').map(e => e.call), [1]);
    assert.equal(workerEvents().find(e => e.event === 'call')?.inputHash,
      createHash('sha256').update(workerBrief).digest('hex'));
    assert.deepEqual(calls(), [1, 2, 3], 'the worker must not touch the TUI Pi session');

    const resubmitted = await submit(workerId, workerBrief);
    assert.equal(resubmitted.duplicate, true);
    assert.equal(resubmitted.state, 'replied');
    await runWorker();
    assert.deepEqual(workerEvents().filter(e => e.event === 'call').map(e => e.call), [1], 'a duplicate id must not re-run');

    const queuedWhileDown = randomUUID();
    assert.deepEqual(await submit(queuedWhileDown, 'Second synthetic worker request'),
      { op: 'worker.submitted', id: queuedWhileDown, state: 'queued', duplicate: false });
    await runWorker();
    assert.equal((await status(queuedWhileDown)).state, 'replied');
    assert.equal((await ask(queuedWhileDown)).status, 'replied');
    assert.deepEqual(workerEvents().filter(e => e.event === 'call').map(e => e.call), [1, 2]);
    assert.deepEqual(calls(), [1, 2, 3]);
    t.diagnostic('owned worker: act-scoped admission, duplicate ids idempotent, receipts answered with no TUI attached');

    stage = 'scheduler heartbeat and health over the device channel';
    const health = async (): Promise<Record<string, unknown> & { queued?: number; heartbeat?: { source: string } | null }> => {
      const sock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
      try {
        await sock.hello({ device: probe.id, deviceSecret: probeSecret });
        await sock.send({ t: 'frame', payload: { op: 'worker.health' } });
        return await recvOp(sock, 'worker.health.result');
      } finally { sock.close(); }
    };
    const healthBefore = await health();
    assert.deepEqual(healthBefore, { op: 'worker.health.result', enabled: true, queued: 0, running: 0, heartbeat: null });
    const schedConfig = join(dir, 'schedule.json');
    writeFileSync(schedConfig, JSON.stringify({ schedules: [
      { id: 'synthetic-hourly', everySeconds: 3600, prompt: 'Scheduled synthetic request' },
    ] }), { mode: 0o600 });
    const runScheduler = async (now: number) => {
      const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/scheduler.mjs'),
        '--config', schedConfig, '--once', '--now', String(now)],
        { cwd: dir, env: { ...hostEnv, HERDGATE_PI_WORKER_DIR: join(dir, 'worker'), HERDGATE_PI_RECEIPT_DIR: join(dir, 'receipts') }, stdio: ['ignore', 'ignore', 'pipe'] });
      const err: string[] = [];
      child.stderr?.setEncoding('utf8').on('data', chunk => err.push(chunk));
      const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
      assert.equal(code, 0, err.join(''));
    };
    const now = Date.now();
    const bucket = Math.floor(now / 3_600_000);
    const scheduledId = scheduledRunId('synthetic-hourly', bucket);
    await runScheduler(now);
    let h = await health();
    assert.equal(h.queued, 1);
    assert.ok(h.heartbeat && h.heartbeat.source === 'herdgate-scheduler');
    await runScheduler(now); // same bucket: the restart must re-admit, not duplicate
    assert.equal((await health()).queued, 1, 'same bucket must not duplicate a run');
    await runWorker();
    h = await health();
    assert.equal(h.queued, 0);
    const scheduled = await ask(scheduledId);
    assert.equal(scheduled.op, 'receipt.result');
    assert.equal(scheduled.status, 'replied');
    assert.ok(scheduled.requestEntryId && scheduled.responseEntryId);
    await runScheduler(now + 3_600_000); // next bucket -> next deterministic run
    assert.equal((await health()).queued, 1, 'the next bucket enqueues the next run');
    t.diagnostic('scheduler: deterministic buckets idempotent, drained by the worker, heartbeat served via worker.health');

    stage = 'MCP server drives submit, status and receipts over the device channel';
    type Rpc = { id?: number; result?: { content?: { text?: string }[]; isError?: boolean; serverInfo?: { name: string }; tools?: { name: string }[]; protocolVersion?: string } };
    const mcpClient = (creds: { device: string; secret: string }) => {
      const child = spawn(process.execPath, [join(root, 'experiments/pi-worker/mcp.mjs'),
        '--gate', base, '--device', creds.device, '--secret', creds.secret], { stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map<number, (value: Rpc) => void>();
      child.stdout!.setEncoding('utf8').on('data', chunk => {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Rpc;
          if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
        }
      });
      const err: string[] = [];
      child.stderr!.setEncoding('utf8').on('data', chunk => err.push(chunk));
      let nextId = 0;
      return {
        stderr: () => err.join(''),
        request: (method: string, params?: unknown) => new Promise<Rpc>(resolve => {
          const id = ++nextId;
          pending.set(id, resolve);
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
        }),
        stop: async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } },
      };
    };
    const toolText = (reply: Rpc) => JSON.parse(reply.result!.content![0]!.text!) as Record<string, unknown>;
    const mcp = mcpClient({ device: device.id, secret: actSecret });
    try {
      const init = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate-test', version: '0' } });
      assert.equal(init.result!.serverInfo!.name, 'herdgate-worker');
      assert.equal(init.result!.protocolVersion, '2024-11-05');
      const list = await mcp.request('tools/list');
      assert.deepEqual(list.result!.tools!.map(tool => tool.name).sort(),
        ['herdgate_receipt', 'herdgate_receipt_body', 'herdgate_receipt_wait', 'herdgate_worker_health', 'herdgate_worker_status', 'herdgate_worker_submit']);
      const receiptReply = toolText(await mcp.request('tools/call', { name: 'herdgate_receipt', arguments: { id: first.id } }));
      assert.equal(receiptReply.op, 'receipt.result');
      assert.equal(receiptReply.status, 'replied');
      const admission = toolText(await mcp.request('tools/call', { name: 'herdgate_worker_submit', arguments: { prompt: 'MCP synthetic request: tiếng Việt' } }));
      assert.equal(admission.op, 'worker.submitted');
      assert.equal(admission.state, 'queued');
      const viaHealth = toolText(await mcp.request('tools/call', { name: 'herdgate_worker_health', arguments: {} }));
      assert.equal(viaHealth.enabled, true);
      assert.equal(viaHealth.queued, 2, 'the scheduled next-bucket run plus the MCP submission');
      await runWorker();
      const status = toolText(await mcp.request('tools/call', { name: 'herdgate_worker_status', arguments: { id: admission.id } }));
      assert.equal(status.op, 'worker.status.result');
      assert.equal(status.state, 'replied');
      assert.ok(!('prompt' in status));
      assert.equal(toolText(await mcp.request('tools/call', { name: 'herdgate_receipt', arguments: { id: admission.id } })).status, 'replied');
      const viaBody = toolText(await mcp.request('tools/call', { name: 'herdgate_receipt_body', arguments: { id: first.id } }));
      assert.match(String(viaBody.text), /SYNTHETIC_REPLY_1/);
    } finally { await mcp.stop(); }
    const readMcp = mcpClient({ device: probe.id, secret: probeSecret });
    try {
      const denied = await readMcp.request('tools/call', { name: 'herdgate_worker_submit', arguments: { prompt: 'read scope cannot enqueue' } });
      assert.equal(denied.result!.isError, true);
      assert.equal(toolText(denied).code, 'requires-act');
      const alive = toolText(await readMcp.request('tools/call', { name: 'herdgate_worker_health', arguments: {} }));
      assert.equal(alive.enabled, true);
    } finally { await readMcp.stop(); }
    t.diagnostic('MCP: act submit plus read-only tools over the same authenticated device channel');

    stage = 'receipt push reaches a subscribed device when the worker settles';
    const pushSock = new DeviceSock(`ws://127.0.0.1:${gatePort}/v1/device/ws`);
    try {
      await pushSock.hello({ device: probe.id, deviceSecret: probeSecret });
      const pushes: Record<string, unknown>[] = [];
      const onPush = (data: RawData): void => {
        const m = JSON.parse(String(data)) as { t?: string; payload?: { op?: string; id?: string } };
        if (m.t === 'frame' && m.payload?.op === 'receipt.push') pushes.push(m.payload as Record<string, unknown>);
      };
      pushSock.ws.on('message', onPush);
      const pushId = randomUUID();
      await act({ op: 'worker.submit', id: pushId, prompt: 'Push synthetic request' });
      await runWorker();
      const pushed = await waitFor('receipt.push for the submitted job',
        () => pushes.find(p => p.id === pushId) ?? null);
      assert.equal(pushed.status, 'replied');
      assert.ok(pushed.requestEntryId && pushed.responseEntryId);
      assert.equal(pushed.hasBody, true, 'the push advertises the archived body');
      const pushedBody = await askBody(pushId);
      assert.match(String(pushedBody.text), /SYNTHETIC_WORKER_REPLY_/);
      assert.equal((await ask(pushId)).status, 'replied', 'the pushed receipt is also queryable');
      pushSock.ws.off('message', onPush);
    } finally { pushSock.close(); }
    t.diagnostic('receipt.push arrived without polling while no TUI client was attached');
  } catch (err) {
    t.diagnostic(`failed at ${stage}`);
    t.diagnostic(JSON.stringify({ events: events(), serverStatus }));
    t.diagnostic(log.join('\n').slice(-4000));
    t.diagnostic((await capture().catch(() => '')).trim().slice(-2500));
    throw err;
  } finally {
    await tmux('kill-server').catch(() => {});
    await stop(publisher);
    await cloud?.close();
    if (server) await host('server', 'stop').catch(() => {});
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
