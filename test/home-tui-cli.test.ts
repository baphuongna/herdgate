import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const entry = join(import.meta.dirname, '..', 'bin', 'herdgate.mjs');
test('home TUI setup installs a durable publisher without changing the pairing or managing an unrelated service', { skip: process.platform !== 'linux' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'hg-home-cli-'));
  const systemBin = join(home, '.local', 'bin');
  const config = join(home, '.config', 'herdr-app', 'herdgate', 'config');
  const unit = join(home, '.config', 'systemd', 'user', 'herdgate-home-tui.service');
  const pi = join(home, 'pi');
  const piSkill = join(pi, 'skills', 'herdgate', 'herdr', 'SKILL.md');
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: pi, HERDGATE_NO_PI_SKILLS: undefined, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), PATH: `${systemBin}:${process.env.PATH}` };
  try {
    mkdirSync(systemBin, { recursive: true });
    mkdirSync(config, { recursive: true });
    const calls = join(home, 'systemctl.log');
    writeFileSync(join(systemBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$*" in *InvocationID*) printf '%s\\n' a0123456789abcdef0123456789abcde;; esac
`, { mode: 0o700 });
    const journal = join(systemBin, 'journalctl');
    const online = '#!/bin/sh\nprintf "herdgate: connected to https://example.invalid (room r_fixture, 1 device(s))\\n"\n';
    writeFileSync(journal, online, { mode: 0o700 });
    writeFileSync(join(systemBin, 'herdr'), '#!/bin/sh\nprintf \'{"running":true,"compatible":true,"version":"0.9.5"}\\n\'\n', { mode: 0o700 });
    const pair = 'HERDGATE_URL=https://example.invalid\nHERDGATE_ROOM_TOKEN=fixture-only\n';
    writeFileSync(join(config, 'herdgate.env'), pair, { mode: 0o600 });
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    const legacy = '[Unit]\nDescription=Herdgate publisher for the home Herdr TUI\n[Service]\nEnvironment=HERDR_PLUGIN_CONFIG_DIR=%h/.config/herdr-app/herdgate/config\nExecStart=%h/.nvm/versions/node/v22.23.1/bin/node %h/source/herdgate/plugin/server/index.mjs serve\n';
    writeFileSync(unit, legacy);
    const refused = spawnSync(process.execPath, [entry, 'setup'], { env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(readFileSync(unit, 'utf8'), legacy);
    writeFileSync(journal, '#!/bin/sh\nprintf "herdgate: disconnected; retrying in 1000ms\\n"\n');
    const offline = spawnSync(process.execPath, [entry, 'migrate'], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(offline.status, 1);
    assert.match(offline.stderr, /did not receive a Gate hello/);
    assert.equal(existsSync(piSkill), false);
    assert.equal(readFileSync(unit, 'utf8'), legacy, 'restores the old service if the new worker never connects');
    assert.equal(readFileSync(join(config, 'herdgate.env'), 'utf8'), pair);
    writeFileSync(journal, online);
    const migrated = execFileSync(process.execPath, [entry, 'migrate'], { env, encoding: 'utf8' });
    assert.match(migrated, /connected to Gate/);
    assert.ok(existsSync(piSkill));
    assert.match(readFileSync(calls, 'utf8'), /show .*InvocationID/);
    assert.ok(existsSync(unit));
    execFileSync(process.execPath, [entry, 'status'], { env });
    const installed = readFileSync(unit, 'utf8');
    assert.match(installed, /Restart=always/);
    assert.match(installed, /herdgate\/home-tui\/releases\//);
    assert.ok(!installed.includes('fixture-only'));
    assert.equal(readFileSync(join(config, 'herdgate.env'), 'utf8'), pair);
    const foreign = '[Service]\nExecStart=/bin/false\n';
    writeFileSync(unit, foreign);
    assert.notEqual(spawnSync(process.execPath, [entry, 'migrate'], { env }).status, 0);
    assert.equal(readFileSync(unit, 'utf8'), foreign);
  } finally { rmSync(home, { recursive: true, force: true }); }
});