import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repo = join(import.meta.dirname, '..');
test('cloud add stores named origins and cannot retarget the existing pairing', () => {
  const home = mkdtempSync(join(tmpdir(), 'hg-cloud-cli-'));
  const env = { ...process.env, XDG_CONFIG_HOME: home, HERDR_APP_HOME: join(home, 'app') };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, 'bin/herdgate.mjs'), ...args], { env, encoding: 'utf8' });
  const dir = join(env.HERDR_APP_HOME, 'herdgate', 'config');
  const config = join(dir, 'herdgate.env');
  const paired = 'HERDGATE_URL=https://alpha.example\nHERDGATE_ROOM_TOKEN=local-fixture-only\n';
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, paired);
    assert.equal(run('cloud', 'add', 'alpha', 'https://alpha.example/').status, 0);
    assert.equal(run('cloud', 'add', 'beta', 'https://beta.example:8443').status, 0);
    assert.notEqual(run('cloud', 'add', 'alpha', 'https://elsewhere.example').status, 0);
    assert.notEqual(run('cloud', 'add', 'bad', 'https://user:pass@example.invalid').status, 0);
    assert.match(run('cloud', 'list').stdout, /beta\s+https:\/\/beta\.example:8443/);
    const wrong = run('setup', '--cloud', 'beta');
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /already paired/i);
    assert.match(run('pair', '--cloud', 'beta').stderr, /already paired/i);
    assert.match(run('pair', '--cloud', 'alpha').stdout, /already paired/i);
    assert.equal(readFileSync(config, 'utf8'), paired);
    assert.doesNotMatch(run('cloud', 'list').stdout, /local-fixture-only/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('cloud serve requires exactly one owner token source, without logging the token', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDGATE_')));
  const run = (overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(repo, 'bin/herdgate.mjs'), 'cloud', 'serve'], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000,
  });
  const missing = run();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /is required/);
  const conflict = run({ HERDGATE_ACCOUNT_TOKEN: 'fixture-not-for-logs', HERDGATE_ACCOUNT_TOKEN_FILE: 'unused' });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /set only one/);
  assert.doesNotMatch(conflict.stdout + conflict.stderr, /fixture-not-for-logs/);
});

test('standalone tunnel and Mobile publisher fail closed without an explicit cloud', () => {
  const env = { ...process.env, HERDGATE_URL: undefined };
  const tunnel = spawnSync(process.execPath, [join(repo, 'templates/herdgate-via.mjs'), '--probe'], { env, encoding: 'utf8', timeout: 1500 });
  assert.equal(tunnel.status, 2);
  assert.match(tunnel.stderr, /--gate|HERDGATE_URL/);
  const mobile = spawnSync(process.execPath, [join(repo, 'src/host/mobile-tui.ts')], { env, encoding: 'utf8', timeout: 3000 });
  assert.notEqual(mobile.status, 0);
  assert.match(mobile.stderr, /configure HERDGATE_URL/);
});