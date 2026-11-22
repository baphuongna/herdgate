// Mirror ops — the fleet sidebar and the typing lane. The e2e leg runs a real
// publisher with a stub herdr that answers snapshots and send-text; the unit
// legs exercise the predictive echo (the predict.rs constants) and the pure
// panel renderer shipped inside the mirror plugin.

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';
import { PredEcho, CONFIRM_THRESHOLD, ECHO_TIMEOUT_MS, MAX_PENDING, looksFullScreen } from '../plugin/mirror/server/predict.mjs';
import { drawFleet, sanitizeFleet } from '../plugin/mirror/server/panel.mjs';

const root = new URL('..', import.meta.url).pathname;
const hasGit = await new Promise<boolean>((resolve) => execFile('git', ['--version'], (err) => resolve(!err)));
const run = (cmd: string, args: string[]) => new Promise<{ stdout: string }>((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
});

test('fleet + typing e2e: fleet.detail shape, act gate on term.send', { skip: !hasGit && 'git is required' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-mirror-'));
  const children: ChildProcess[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  try {
    // A git repo so the publisher's boot anchor path is happy.
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 'm@test']);
    await run('git', ['-C', repo, 'config', 'user.name', 'm']);
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'one']);

    // Stub herdr: snapshot with one agent, pane list with two panes, and a
    // send-text that records what a device typed.
    const stub = join(dir, 'herdr-stub.sh');
    writeFileSync(stub, [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "pane --help") printf "Usage: herdr pane\\n\\nCommands:\\n  list\\n  focus\\n" ;;',
      '  "tab --help") printf "Usage: herdr tab\\n\\nCommands:\\n  list\\n" ;;',
      '  "pane send-text") printf \'pane send-text %s [%s]\\n\' "$3" "$4" >> "' + join(dir, 'sent.log') + '" ;;',
      '  "pane send-keys") printf \'pane send-keys %s %s\\n\' "$3" "$4" >> "' + join(dir, 'sent.log') + '" ;;',
      'esac',
      'case "$1 $2 $3" in',
      '  "api snapshot ") printf \'{"result":{"snapshot":{"version":"9.9.9","protocol":22,"agents":[{"agent":"pi","agent_status":"working","pane_id":"w1:p1","terminal_title_stripped":"pi - work","cwd":"/w"}],"workspaces":[]}}}\' ;;',
      '  "pane list ") printf \'{"result":{"panes":[{"pane_id":"w1:p1","workspace_id":"w1","agent":"pi","agent_status":"working","cwd":"/w","terminal_title_stripped":"pi - work"},{"pane_id":"w2:p2","workspace_id":"w2","cwd":"/x","terminal_title_stripped":"bom@host: ~/x"}]}}\' ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const accountToken = 'mirror-owner';
    const statePath = join(dir, 'state.json');
    const state = new State([{ id: 'a1', name: 'test', token: accountToken }], statePath);
    const { room, token } = state.addRoom('a1', 'mirror-host');
    const reader = state.addDevice(room, 'mirror-reader', 'read');
    const actor = state.addDevice(room, 'mirror-actor', 'act');
    cloud = await startCloud({ accounts: [{ id: 'a1', name: 'test', token: accountToken }], statePath, log: () => {} });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    const config = join(dir, 'publisher');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    const log: string[] = [];
    const child = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
        HERDGATE_DIFF_REPO_DIR: repo,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => log.push(chunk));
    children.push(child);

    const deadline = performance.now() + 15_000;
    while (!log.join('').includes('herdgate: connected to')) {
      if (performance.now() > deadline) throw new Error(`publisher did not connect:\n${log.join('')}`);
      await delay(60);
    }

    const ask = async (payload: Record<string, unknown>, expectOp: string, dev = reader): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: dev.device.id, deviceSecret: dev.secret });
        assert.equal(hello.t, 'hello');
        await sock.send({ t: 'frame', payload });
        const until = performance.now() + 10_000;
        for (;;) {
          const frame = await sock.expect('frame');
          const reply = frame.payload as { op?: string } | undefined;
          if (reply?.op === expectOp || reply?.op === 'error') return reply as Record<string, unknown>;
          if (performance.now() > until) throw new Error(`no ${expectOp} (got ${String(reply?.op)})`);
        }
      } finally { sock.close(); }
    };

    // fleet.detail: agents from the snapshot, panes from pane list, no secrets.
    const fleet = await ask({ op: 'fleet.detail' }, 'fleet.detail.result') as unknown as
      { op: string; herdr: string; agents: { agent: string; status: string; pane: string; title: string }[]; panes: { id: string; agent: string | null; title: string }[] };
    assert.equal(fleet.op, 'fleet.detail.result');
    assert.match(fleet.herdr, /9\.9\.9/);
    assert.equal(fleet.agents.length, 1);
    assert.equal(fleet.agents[0].agent, 'pi');
    assert.equal(fleet.agents[0].status, 'working');
    assert.equal(fleet.agents[0].pane, 'w1:p1');
    assert.equal(fleet.panes.length, 2);
    assert.equal(fleet.panes[1].agent, null);

    // typing: read devices are refused; act devices reach the stub.
    const denied = await ask({ op: 'term.send', target: 'w1:p1', text: 'ls\n' }, 'term.sent') as unknown as { op: string; code: string };
    assert.equal(denied.code, 'requires-act');
    const badTarget = await ask({ op: 'term.send', target: 'w1; rm -rf', text: 'x' }, 'term.sent', actor) as unknown as { code: string };
    assert.equal(badTarget.code, 'bad-target');
    const badKeys = await ask({ op: 'term.keys', target: 'w1:p1', keys: ['Enter', 'x;reboot'] }, 'term.keyed', actor) as unknown as { code: string };
    assert.equal(badKeys.code, 'bad-keys');
    const sent = await ask({ op: 'term.send', target: 'w1:p1', text: 'echo hi' }, 'term.sent', actor) as unknown as { op: string; target: string };
    assert.equal(sent.op, 'term.sent');
    const keyed = await ask({ op: 'term.keys', target: 'w1:p1', keys: ['Enter'] }, 'term.keyed', actor) as unknown as { op: string };
    assert.equal(keyed.op, 'term.keyed');
    const sentLog = readFileSync(join(dir, 'sent.log'), 'utf8');
    assert.ok(sentLog.includes('pane send-text w1:p1'), `stub saw the send: ${JSON.stringify(sentLog).slice(0, 160)}`);
    t.diagnostic('fleet.detail + act-gated typing lane verified');
  } finally {
    for (const c of children) c.kill();
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});



test('predictive echo: trust needs two confirms, one contradiction drops it', () => {
  let t = 1_000;
  const p = new PredEcho({ now: () => t });
  assert.equal(CONFIRM_THRESHOLD, 2);
  assert.equal(ECHO_TIMEOUT_MS, 1200);
  assert.equal(MAX_PENDING, 32);
  // Silent while unproven — predictions queue anyway.
  assert.equal(p.key('a').echo, false);
  assert.equal(p.key('b').echo, false);
  // A frame that predates 'b' (inside the RTT grace) must not punish.
  t = 1_060;
  const stale = p.confirm('shell$ a');
  assert.equal(stale.mismatch, false);
  assert.equal(stale.enabled, false);
  // The next frame carries both — second consecutive confirm enables echo.
  t = 1_120;
  const second = p.confirm('shell$ ab');
  assert.equal(second.mismatch, false);
  assert.equal(second.enabled, true, 'two consecutive confirmed predictions enable echo');
  assert.equal(p.key('c').echo, true);
  assert.equal(p.pendingView(), 'c');
  // A fresh-but-late prediction the screen contradicts: echo off at once.
  p.key('x');
  t = 1_400;
  const clash = p.confirm('shell$ abcZ');
  assert.equal(clash.mismatch, true);
  assert.equal(clash.enabled, false);
  assert.equal(p.key('d').echo, false);
});

test('predictive echo: ghosts expire, the pending ring is capped, full-screen stops echo', () => {
  let t = 5_000;
  const p = new PredEcho({ now: () => t });
  p.key('p');
  p.key('q');
  t = 5_000 + ECHO_TIMEOUT_MS + 10;
  const ghost = p.confirm('một màn hình khác hẳn');
  assert.deepEqual(ghost.ghosts, ['p', 'q'], 'expired predictions return as ghosts to erase');
  assert.equal(ghost.mismatch, false);
  for (let i = 0; i < MAX_PENDING + 5; i++) p.key('k');
  assert.ok(p.pending.length <= MAX_PENDING, 'the pending ring drops the oldest guess');
  // Full-screen heuristics: alt-screen sequences and the usual suspects.
  assert.equal(looksFullScreen('\u001b[?1049h'), true);
  assert.equal(looksFullScreen('plain text', 'htop'), true);
  assert.equal(looksFullScreen('plain text', 'bash'), false);
});

test('fleet panel: pure renderer, wire shapes sanitized', () => {
  const fleet = sanitizeFleet({
    herdr: '9.9.9 (protocol 22)',
    takenAt: 'now',
    agents: [{ agent: 'pi', status: 'working', pane: 'w1:p1', title: 'π - source', cwd: '/s' }],
    panes: [{ id: 'w1:p1', agent: 'pi', status: 'working', title: 'π', cwd: '/s' }, { id: 'w2:p2', title: 'bom@h: ~', cwd: '/x' }, 'rubbish'],
  });
  assert.equal(fleet.agents.length, 1);
  assert.equal(fleet.panes.length, 2);
  assert.equal(fleet.panes[1].agent, null);
  const lines = drawFleet(fleet, { room: 'r_8bf9e457', ageMs: 4_000 });
  assert.match(lines[0], /r_8bf9e457/);
  assert.match(lines[1], /4s trước/);
  assert.match(lines[2], /working 1 · blocked 0/);
  assert.match(lines.join("\n"), /w1:p1/);
  const errLines = drawFleet(null, { room: 'r', error: 'gate mất kết nối' });
  assert.match(errLines[1], /gate mất kết nối/);
  assert.match(errLines[2], /q đóng/);
});
