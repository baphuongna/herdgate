import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { encode } from '../src/protocol/envelope.ts';

const repo = join(import.meta.dirname, '..');
const token = 'release-test-owner-only';
const host = 'gate.fixture.invalid';
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDGATE_')));

function run(cwd: string, bin: string, ...args: string[]) {
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 25_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('release set contains a clean compiled Cloud that serves the PWA and preserves pairing and pins', {
  skip: process.platform !== 'linux', timeout: 50_000,
}, async () => {
  const stage = mkdtempSync(join(tmpdir(), 'hg cloud release '));
  const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
  const out = join(stage, 'out');
  const cloudName = `herdgate-cloud-${version}`;
  const cloud = join(stage, cloudName);
  const archive = join(out, cloudName + '.tar.gz');
  const npm = `bom0792-herdgate-${version}.tgz`;
  const hostZip = `herdgate-host-${version}.zip`;
  const state = join(stage, 'state');
  const tokenFile = join(stage, 'owner-token');
  const sshKey = join(state, 'ssh_host_ed25519.json');
  const vapid = join(state, 'vapid.json');
  const cloudEnv = {
    ...env, HERDGATE_ACCOUNT_TOKEN_FILE: tokenFile, HERDGATE_STATE: join(state, 'state.json'),
    HERDGATE_PUBLIC_HOST: host, HERDGATE_PUBLIC_URL: `https://${host}`, HERDGATE_PORT: '0',
    HERDGATE_SSH_PORT: '0', HERDGATE_SSH_HOST: 'ssh.fixture.invalid', HERDGATE_SSH_PUBLIC_PORT: '2299',
  };
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 2500).unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
    child = undefined;
  };
  const start = async () => {
    let log = '';
    child = spawn(process.execPath, ['--no-experimental-strip-types', 'runtime/cloud/main.js'], {
      cwd: cloud, env: cloudEnv, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => { log += String(chunk); });
    for (let i = 0; i < 100; i++) {
      const port = log.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) return `http://127.0.0.1:${port}`;
      assert.equal(child.exitCode, null, log);
      await delay(25);
    }
    throw new Error(`Cloud did not start: ${log}`);
  };
  const request = (base: string, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(base + path, {
        method: options.method, signal: AbortSignal.timeout(2000),
        headers: { Host: host, ...options.headers },
      }, async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk as Buffer);
          resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: res.statusCode }));
        } catch (err) { reject(err); }
      });
      req.once('error', reject);
      req.end(options.body);
    });
  const hello = async (base: string) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/device/ws', { headers: { Host: host } });
    try {
      const signal = AbortSignal.timeout(2000);
      ws.once('open', () => ws.send(encode({ t: 'hello', accountToken: token })));
      const [message] = await once(ws, 'message', { signal });
      return JSON.parse(String(message)) as { t: string; agents: { roomId: string }[]; ssh: { host: string; port: number } };
    } finally { ws.terminate(); }
  };
  try {
    run(repo, 'bash', 'scripts/build-release.sh', out);
    assert.equal(run(out, 'sha256sum', '-c', 'SHA256SUMS').split('\n').length, 3);
    const cloudFiles = run(out, 'tar', '-tzf', archive).split('\n');
    const npmFiles = run(out, 'tar', '-tzf', npm).split('\n');
    assert.ok(cloudFiles.includes(`${cloudName}/runtime/cloud/ssh-tcp-edge.js`));
    assert.ok(cloudFiles.includes(`${cloudName}/package-lock.json`));
    assert.ok(npmFiles.includes('package/.agents/skills/herdr/SKILL.md'));
    assert.ok(run(out, 'unzip', '-Z1', hostZip).split('\n').includes('templates/herdgate-via.mjs'));
    for (const file of [...cloudFiles, ...npmFiles]) {
      assert.doesNotMatch(file, /\/(?:\.env|owner-token|state\.json|vapid\.json|ssh_host_ed25519\.json|node_modules|herdgate-win-[^/]+|[^/]+\.tgz)(?:\/|$)/);
    }
    run(stage, 'tar', '-xzf', archive);
    // Unit/e2e suite is offline; the release smoke check installs the locked dependencies separately.
    symlinkSync(realpathSync(join(repo, 'node_modules')), join(cloud, 'node_modules'), 'dir');
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    writeFileSync(vapid, 'existing key fixture must not be read or replaced when push is off', { mode: 0o600 });
    let base = await start();
    assert.equal((await request(base, '/v1/push/key')).status, 404, 'release defaults to push off');
    assert.equal((await request(base, '/healthz', { headers: { Host: 'other.fixture.invalid' } })).status, 421);
    assert.equal(await (await request(base, '/healthz')).text(), 'ok');
    assert.match(await (await request(base, '/')).text(), /id="signin"/);
    // The owner's console ships with the release set and answers under its pretty URL.
    for (const file of ['admin.html', 'admin.js', 'admin.css', 'admin-model.js']) {
      assert.ok(cloudFiles.includes(`${cloudName}/runtime/web/${file}`), `the release set carries ${file}`);
    }
    const admin = await request(base, '/admin');
    assert.equal(admin.status, 200, '/admin is the console');
    assert.match(await admin.text(), /id="signin"/);
    for (const file of ['/admin.js', '/admin-model.js', '/admin.css']) assert.equal((await request(base, file)).status, 200, `${file} is served`);
    assert.equal((await request(base, '/v1/admin/overview')).status, 401, 'the admin API is the owner\'s alone');
    assert.ok(Buffer.from(await (await request(base, '/herdgate-host.zip')).arrayBuffer()).equals(readFileSync(join(out, hostZip))));
    assert.equal((await request(base, '/owner-token')).status, 404);
    assert.deepEqual((await hello(base)).agents, []);
    const minted = await request(base, '/v1/agent/code', { method: 'POST', body: '{"name":"fixture"}' });
    const { code } = await minted.json() as { code: string };
    const approved = await request(base, '/v1/agent/approve', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
    assert.equal(approved.status, 200);
    const { roomId } = await approved.json() as { roomId: string };
    const old = [sshKey, vapid].map(file => readFileSync(file));
    await stop();
    base = await start();
    const owner = await hello(base);
    assert.equal(owner.t, 'hello');
    assert.deepEqual(owner.agents.map(agent => agent.roomId), [roomId]);
    assert.deepEqual(owner.ssh, { host: 'ssh.fixture.invalid', port: 2299 });
    [sshKey, vapid].forEach((file, i) => assert.ok(readFileSync(file).equals(old[i]), 'existing identity is unchanged'));
    await stop();
    writeFileSync(sshKey, 'invalid fixture');
    const corrupt = spawnSync(process.execPath, ['runtime/cloud/main.js'], { cwd: cloud, env: cloudEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /cannot load existing SSH host key/);
    assert.equal(readFileSync(sshKey, 'utf8'), 'invalid fixture');
  } finally {
    await stop();
    rmSync(stage, { recursive: true, force: true });
  }
});
