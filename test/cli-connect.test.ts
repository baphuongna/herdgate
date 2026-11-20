/**
 * `herdgate connect` — this machine as a controller of machines already in the
 * herd, in one command: device pair (read or act), one SSH key per cloud, a
 * managed ~/.ssh/config Host block per room, key registered at the gate. The
 * owner token arrives on stdin (hidden prompt on a terminal) and is never
 * stored, and neither is any device secret.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startCloud } from '../src/cloud/gateway.ts';
import { DeviceSock } from './util2.ts';

const repo = join(import.meta.dirname, '..');
const token = 'connect-test-owner';

const run = (env: NodeJS.ProcessEnv, input: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(repo, 'bin/herdgate.mjs'), ...args], { env, input, encoding: 'utf8', timeout: 40_000 });

const runAsync = (env: NodeJS.ProcessEnv, input: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, [join(repo, 'bin/herdgate.mjs'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += String(c); });
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.stdin.end(input);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

const mintRoom = async (base: string, name: string): Promise<{ roomId: string; roomToken: string }> => {
  const minted = await (await fetch(`${base}/v1/agent/code`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name }),
  })).json() as { code: string };
  const approve = await (await fetch(`${base}/v1/agent/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ code: minted.code }),
  })).json() as { roomId: string };
  const status = await (await fetch(`${base}/v1/agent/code/${minted.code}/status`)).json() as { roomToken: string };
  return { roomId: approve.roomId, roomToken: status.roomToken };
};

test('connect: pairs, keys, config blocks — idempotent, no secrets stored, act waits for the host', { timeout: 120_000 }, async () => {
  const cloud = await startCloud({ accounts: [{ id: 'a', name: 'owner', token }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const home = mkdtempSync(join(tmpdir(), 'hg-connect-'));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), HERDR_APP_HOME: join(home, 'app'),
  };
  try {
    const homeRoom = (await mintRoom(base, 'home')).roomId;

    // A host agent that approves act pairing (event loop stays live for runAsync).
    const laptop = await mintRoom(base, 'laptop');
    const agent = new DeviceSock(base.replace('http:', 'ws:') + '/v1/agent/ws');
    await agent.hello({ roomToken: laptop.roomToken });

    assert.equal(run(env, '', 'cloud', 'add', 'local', base).status, 0, 'loopback http accepted for local development');
    assert.notEqual(run(env, '', 'cloud', 'add', 'bad', 'http://10.0.0.9:8787').status, 0, 'non-loopback http refused');

    // A wrong owner token fails before anything is written to disk.
    // (spawn, not spawnSync: the gate lives in THIS process and must keep serving the child.)
    const bad = await runAsync(env, 'wrong-token\n', 'connect', '--cloud', 'local', '--room', 'home');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /closed the connection|refused/);
    assert.equal(existsSync(join(home, '.ssh')), false, 'nothing written on auth failure');

    // Read pairing in one shot.
    const r = await runAsync(env, `${token}\n`, 'connect', '--cloud', 'local', '--room', 'home');
    assert.equal(r.status, 0, r.stderr);
    const sshDir = join(home, '.ssh');
    assert.ok(existsSync(join(sshDir, 'herdgate_local')), 'the per-cloud key exists');
    assert.ok(existsSync(join(sshDir, 'herdgate-via-local.mjs')), 'the via transport is installed beside it');
    const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
    assert.match(cfg, /# herdgate connect:begin local/);
    assert.match(cfg, new RegExp(`ProxyCommand node .+herdgate-via-local\\.mjs --tunnel --gate ${base.replace(/\//g, '\\/')}`));
    const deviceId = /User (d_[A-Za-z0-9]+)/.exec(cfg)![1];

    const roster = async (room: string): Promise<{ id: string; name: string; scope: string; keys: number }[]> =>
      ((await (await fetch(`${base}/v1/devices?room=${room}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { devices: { id: string; name: string; scope: string; keys: number }[] }).devices;
    const homeDevices = await roster(homeRoom);
    const dev = homeDevices.find((d) => d.id === deviceId);
    assert.ok(dev, 'the paired device is in the roster');
    assert.equal(dev.scope, 'read');
    assert.equal(dev.keys, 1, 'its ssh key is registered at the gate');

    // Idempotent rerun: same alias, one block, no config drift.
    const again = await runAsync(env, `${token}\n`, 'connect', '--cloud', 'local', '--room', 'home');
    assert.equal(again.status, 0, again.stderr);
    const cfg2 = readFileSync(join(sshDir, 'config'), 'utf8');
    assert.equal((cfg2.match(/# herdgate connect:begin local/g) ?? []).length, 1, 'exactly one managed block');
    assert.equal((cfg2.match(/^Host /gm) ?? []).length, 1, 'the alias is reused, not duplicated');
    assert.match(again.stdout, /revoke its previous device/i);

    // act pairing waits for the host's approval (agent answers while the CLI runs).
    const act = runAsync(env, `${token}\n`, 'connect', '--cloud', 'local', '--room', 'laptop', '--scope', 'act');
    const ask = await agent.expect('pair.request', 10_000);
    assert.equal(ask.scope, 'act');
    await agent.send({ t: 'pair.response', requestId: ask.requestId, ok: true });
    const actResult = await act;
    assert.equal(actResult.status, 0, actResult.stderr);
    const cfg3 = readFileSync(join(sshDir, 'config'), 'utf8');
    assert.match(cfg3, /# herdgate connect:begin local/);
    assert.equal((cfg3.match(/^Host /gm) ?? []).length, 2, 'one Host per managed machine');
    const laptopId = /User (d_[A-Za-z0-9]+)/.exec(cfg3.split('# herdgate connect:begin local')[2])![1];
    const laptopDevices = await roster(laptop.roomId);
    assert.equal(laptopDevices.find((d) => d.id === laptopId)?.scope, 'act');
    assert.match(actResult.stdout, /herdr machine add laptop/);

    // Unknown room names fail honestly with the available machines listed.
    const miss = await runAsync(env, `${token}\n`, 'connect', '--cloud', 'local', '--room', 'nope');
    assert.notEqual(miss.status, 0);
    assert.match(miss.stderr, /no machine matches --room 'nope'/);

    agent.close();
  } finally {
    await cloud.close();
    rmSync(home, { recursive: true, force: true });
  }
});
