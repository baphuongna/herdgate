import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repo = join(import.meta.dirname, '..');
const sourceSkills = join('.agents', 'skills');

test('Herdgate installs and refreshes its Pi skills without npm cache, settings edits, or overwriting a local change', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hg pi install '));
  const src = join(scratch, 'npm-extract');
  const settingsDir = join(scratch, 'Pi profile');
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: settingsDir, HERDGATE_NO_PI_SKILLS: undefined };
  const installed = join(settingsDir, 'skills', 'herdgate');
  const invoke = (command: string[], extraEnv = {}) => {
    const result = spawnSync(process.execPath, [join(src, 'bin', 'herdgate.mjs'), ...command], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 8000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  try {
    for (const dir of ['bin', 'plugin', 'windows', sourceSkills]) cpSync(join(repo, dir), join(src, dir), { recursive: true });
    mkdirSync(settingsDir);
    const settings = join(settingsDir, 'settings.json');
    writeFileSync(settings, '{"quietStartup":true}\n');
    mkdirSync(join(settingsDir, 'skills', 'custom'), { recursive: true });
    writeFileSync(join(settingsDir, 'skills', 'custom', 'SKILL.md'), 'unrelated user skill\n');
    const root = join(scratch, 'herdgate-cli');
    invoke(['install', '--root', root], { HERDGATE_NO_PI_SKILLS: '1' });
    assert.equal(existsSync(installed), false);
    invoke(['install', '--root', root]);
    for (const skill of ['herdr', 'herdr-advisor', 'herdr-committee', 'herdr-handoff', 'herdr-help', 'herdr-plugin']) {
      assert.deepEqual(readFileSync(join(installed, skill, 'SKILL.md')), readFileSync(join(src, sourceSkills, skill, 'SKILL.md')));
    }
    assert.ok(existsSync(join(installed, 'herdr', 'herdr_pi.py')));
    assert.ok(existsSync(join(installed, 'herdr', 'profiles.example.toml')));
    const next = join(src, sourceSkills, 'herdr', 'SKILL.md');
    const change = readFileSync(next, 'utf8') + '\nFixture update.\n';
    writeFileSync(next, change);
    invoke(['pi-skills']);
    const dest = join(installed, 'herdr', 'SKILL.md');
    assert.equal(readFileSync(dest, 'utf8'), change);
    writeFileSync(dest, 'user edited this skill');
    assert.match(invoke(['pi-skills']).stderr, /locally modified/);
    assert.equal(readFileSync(dest, 'utf8'), 'user edited this skill');
    assert.equal(readFileSync(settings, 'utf8'), '{"quietStartup":true}\n');
    assert.equal(readFileSync(join(settingsDir, 'skills', 'custom', 'SKILL.md'), 'utf8'), 'unrelated user skill\n');
    rmSync(src, { recursive: true, force: true });
    rmSync(installed, { recursive: true });
    const persistent = spawnSync(process.execPath, [join(root, 'command', 'bin', 'herdgate.mjs'), 'pi-skills'], { env, encoding: 'utf8', timeout: 8000 });
    assert.equal(persistent.status, 0, persistent.stderr);
    assert.ok(existsSync(dest), 'standalone CLI still contains the bundled skills');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
