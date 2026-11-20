import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdgate');
const path = join(dir, 'clouds.json');
const validName = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function cloudOrigin(raw) {
  if (typeof raw !== 'string' || /[\s?#@]/.test(raw)) throw new Error('cloud must be a credential-free HTTPS origin');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('cloud must be a credential-free HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('cloud must be a credential-free HTTPS origin');
  }
  return url.origin;
}

function load() {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid cloud config');
  return new Map(Object.entries(parsed).map(([name, origin]) => {
    if (!validName.test(name)) throw new Error('invalid name in cloud config');
    return [name, cloudOrigin(origin)];
  }));
}

export function resolveCloud(input) {
  if (validName.test(input)) {
    const origin = load().get(input);
    if (!origin) throw new Error(`cloud '${input}' not found; use herdgate cloud add <name> <url>`);
    return origin;
  }
  return cloudOrigin(input);
}

export function manageCloud([action, name, value, ...rest]) {
  if (action === 'list' && !name) {
    for (const [alias, origin] of load()) console.log(`${alias}\t${origin}`);
    return;
  }
  if (action !== 'add' || !name || !validName.test(name) || !value || rest.length) {
    throw new Error('usage: herdgate cloud add <lowercase-name> <https-url> | herdgate cloud list');
  }
  const origin = cloudOrigin(value);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.clouds-lock');
  mkdirSync(lock);
  const temp = `${path}.${randomUUID()}`;
  try {
    const clouds = load();
    if (clouds.has(name) && clouds.get(name) !== origin) throw new Error('cloud name already points to a different origin; choose another name');
    clouds.set(name, origin);
    writeFileSync(temp, `${JSON.stringify(Object.fromEntries(clouds), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
    rmSync(lock, { force: true, recursive: true });
  }
  console.log(`${name}\t${origin}`);
}
