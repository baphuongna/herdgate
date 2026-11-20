// Install only shipped resources into Pi's user skill directory; never edit Pi settings.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const piSkillFiles = [
  ...['herdr', 'herdr-advisor', 'herdr-committee', 'herdr-handoff', 'herdr-help', 'herdr-plugin'].map(name => `${name}/SKILL.md`),
  'herdr/herdr_pi.py', 'herdr/profiles.example.toml',
].sort();
const source = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
const marker = '.herdgate-skills-v1';
const stat = path => {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const packDirs = new Set(piSkillFiles.map(name => name.split('/')[0]));
const packFiles = new Set(piSkillFiles);
function hasExactLayout(root) {
  const dirs = readdirSync(root, { withFileTypes: true });
  if (dirs.length !== packDirs.size + 1) return false;
  let count = 0;
  for (const dir of dirs) {
    if (dir.name === marker && dir.isFile()) continue;
    if (!packDirs.has(dir.name) || !dir.isDirectory()) return false;
    for (const entry of readdirSync(join(root, dir.name), { withFileTypes: true })) {
      if (!entry.isFile() || !packFiles.has(`${dir.name}/${entry.name}`)) return false;
      count++;
    }
  }
  return count === packFiles.size;
}
const digest = files => {
  const hash = createHash('sha256');
  for (const [path, bytes] of files) hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  return hash.digest('hex');
};
const readPack = root => piSkillFiles.map(name => [name, readFileSync(join(root, name))]);

function syncPiSkills() {
  if (process.env.HERDGATE_NO_PI_SKILLS === '1' || !stat(source)) return;
  const home = homedir();
  const override = process.env.PI_CODING_AGENT_DIR;
  const agent = override ? resolve(override === '~' ? home : /^~[\\/]/.test(override) ? join(home, override.slice(2)) : override) : join(home, '.pi', 'agent');
  const skills = join(agent, 'skills');
  const dest = join(skills, 'herdgate');
  const lock = join(skills, '.herdgate-skills.lock');
  const files = readPack(source);
  const next = digest(files);
  mkdirSync(skills, { recursive: true, mode: 0o700 });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('another skill sync is in progress (or left a stale .herdgate-skills.lock)');
  }
  try {
    const existing = stat(dest);
    if (existing) {
      if (!existing.isDirectory() || !stat(join(dest, marker))?.isFile()) {
        throw new Error('the destination is not managed by Herdgate; left untouched');
      }
      const prior = readFileSync(join(dest, marker), 'utf8');
      if (!hasExactLayout(dest) || prior !== `${digest(readPack(dest))}\n`) {
        throw new Error('the installed skill pack is locally modified; left untouched');
      }
      if (prior === `${next}\n`) return;
    }
    // Hidden staging/backup directories are not auto-discovered by Pi.
    const stage = mkdtempSync(join(skills, '.herdgate-stage-'));
    const backup = join(stage, 'previous');
    const pending = join(stage, 'next');
    try {
      for (const [name, bytes] of files) {
        const path = join(pending, name);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(join(pending, marker), `${next}\n`, { flag: 'wx', mode: 0o600 });
      if (existing) renameSync(dest, backup);
      try { renameSync(pending, dest); }
      catch (error) {
        if (existing) renameSync(backup, dest);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } finally {
      // If rollback also failed, preserve the backup rather than deleting the user's old pack.
      if (stat(backup)) console.error(`Herdgate: previous skill pack kept at ${backup}`);
      else rmSync(stage, { recursive: true, force: true });
    }
    console.error(`Herdgate: ${existing ? 'updated' : 'installed'} Pi skills at ${dest} (use /reload in Pi).`);
  } finally { rmdirSync(lock); }
}

export function trySyncPiSkills() {
  try { syncPiSkills(); }
  catch (error) { console.error(`Herdgate: could not sync Pi skills: ${error.message}`); }
}
