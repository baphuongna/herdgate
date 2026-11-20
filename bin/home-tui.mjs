// Linux user service, with a durable release outside npm's cache.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../plugin/server/common.mjs';
import { trySyncPiSkills } from './pi-skills.mjs';

const unit = 'herdgate-home-tui.service';
const marker = '# Managed by Herdgate CLI\n';
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const appHome = process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');
const root = join(dataHome, 'herdgate', 'home-tui');
const unitFile = join(configHome, 'systemd', 'user', unit);
const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit', timeout: 25_000 });
function capture(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
const invocation = () => capture('systemctl', ['--user', 'show', '--property=InvocationID', '--value', unit]);
async function waitForGate(origin, previous) {
  const deadline = Date.now() + 8_000;
  do {
    const id = invocation();
    if (/^[a-f0-9]{32}$/.test(id) && id !== '0'.repeat(32) && id !== previous) {
      const events = capture('journalctl', ['--user', '--unit', unit, '--no-pager', '--output=cat',
        '--grep=^herdgate: (connected to |(disconnected|ws error);)', '-n', '1', `_SYSTEMD_INVOCATION_ID=${id}`]);
      const endpoint = events.match(/^herdgate: connected to (\S+) /)?.[1];
      if (endpoint) {
        try { if (new URL(endpoint).origin === origin && invocation() === id) return; }
        catch { /* wait for a valid hello */ }
      }
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('the new publisher did not receive a Gate hello; check its systemd journal');
}
function replace(path, value) {
  const tmp = `${path}.${randomUUID()}`;
  try {
    writeFileSync(tmp, value, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
function installedUnit() {
  if (!existsSync(unitFile)) return null;
  if (!lstatSync(unitFile).isFile()) throw new Error(`refusing to use a non-regular unit: ${unitFile}`);
  return readFileSync(unitFile, 'utf8');
}
function legacyUnit(text) {
  return text.startsWith('[Unit]\nDescription=Herdgate publisher for the home Herdr TUI\n') &&
    text.includes('Environment=HERDR_PLUGIN_CONFIG_DIR=%h/.config/herdr-app/herdgate/config\n') &&
    /^ExecStart=%h\/\.nvm\/versions\/node\/v\d+\.\d+\.\d+\/bin\/node %h\/source\/herdgate\/plugin\/server\/index\.mjs serve$/m.test(text);
}
const sysPath = (value) => {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('systemd paths must be absolute and on one line');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
};
function release() {
  const server = fileURLToPath(new URL('../plugin/server/', import.meta.url));
  const require = createRequire(import.meta.url);
  const wsManifest = require.resolve('ws/package.json');
  const runtime = readdirSync(server).filter(n => n.endsWith('.mjs')).sort();
  const hash = createHash('sha256').update(readFileSync(wsManifest));
  for (const name of runtime) hash.update(name + '\0').update(readFileSync(join(server, name)));
  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const dest = join(releases, hash.digest('hex').slice(0, 24));
  if (!existsSync(dest)) {
    const stage = mkdtempSync(join(releases, '.stage-'));
    try {
      const plugin = join(stage, 'plugin', 'server');
      mkdirSync(plugin, { recursive: true });
      for (const name of runtime) cpSync(join(server, name), join(plugin, name));
      mkdirSync(join(stage, 'node_modules'));
      cpSync(dirname(wsManifest), join(stage, 'node_modules', 'ws'), { recursive: true });
      renameSync(stage, dest);
    } finally { rmSync(stage, { force: true, recursive: true }); }
  }
  if (!lstatSync(dest).isDirectory()) throw new Error('invalid installed TUI release');
  return dest;
}
async function setup(args) {
  const adopt = args.includes('--adopt');
  if (args.some(a => a !== '--adopt')) throw new Error('usage: herdgate home-tui setup [--adopt]');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, '.installing');
  mkdirSync(lock);
  try {
    const old = installedUnit();
    if (old && !old.startsWith(marker) && !(adopt && legacyUnit(old))) {
      throw new Error('existing service is not CLI-managed; only the previous Herdgate home service can be migrated with --adopt');
    }
    const herdr = process.env.HERDR_BIN_PATH || join(homedir(), '.local', 'bin', 'herdr');
    const socket = process.env.HERDR_SOCKET_PATH || join(configHome, 'herdr', 'herdr.sock');
    const config = join(appHome, 'herdgate', 'config');
    const state = join(appHome, 'herdgate', 'state');
    const cfg = readConfig(join(config, 'herdgate.env'));
    if (!cfg.HERDGATE_ROOM_TOKEN || !cfg.HERDGATE_URL) throw new Error('pair the home room first; herdgate.env is missing or incomplete');
    const gate = new URL(cfg.HERDGATE_URL);
    if (gate.protocol !== 'https:' || gate.username || gate.password || gate.pathname !== '/' || gate.search || gate.hash) {
      throw new Error('a credential-free HTTPS Gate origin is required');
    }
    for (const path of [herdr, socket, config, state, root]) sysPath(path);
    const status = JSON.parse(execFileSync(herdr, ['status', 'server', '--json'], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, HERDR_SOCKET_PATH: socket, HERDR_SESSION: 'default' } }));
    if (!status.running || status.compatible !== true) throw new Error('start a compatible Herdr TUI server before running setup');
    const runtime = release();
    const env = { HERDGATE_PUBLISHER_CHILD:'1', HERDR_PLUGIN_ID:'dev.herdgate.host', HERDR_PLUGIN_CONFIG_DIR:config, HERDR_PLUGIN_STATE_DIR:state, HERDR_BIN_PATH:herdr, HERDR_SOCKET_PATH:socket, HERDGATE_HERDR_SESSION:'default' };
    const lines = Object.entries(env).map(([k, v]) => `Environment=${isAbsolute(v) ? sysPath(`${v}`).replace(/^"/, `"${k}=`) : `${k}=${v}`}`).join('\n');
    const next = `${marker}[Unit]\nDescription=Herdgate publisher for the home Herdr TUI\nAfter=network.target herdgate.service\n\n[Service]\nType=simple\n${lines}\nExecStart=:${sysPath(process.execPath)} ${sysPath(join(runtime,'plugin/server/index.mjs'))} serve\nRestart=always\nRestartSec=2\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
    mkdirSync(dirname(unitFile), { recursive: true });
    const wasActive = capture('systemctl', ['--user', 'is-active', unit]) === 'active';
    const changed = old !== next;
    const previous = changed && wasActive ? invocation() : '';
    if (changed) replace(unitFile, next);
    try {
      if (changed) systemctl('daemon-reload');
      systemctl(changed && wasActive ? 'restart' : 'start', unit);
      await waitForGate(gate.origin, previous);
      systemctl('enable', unit);
    } catch (error) {
      if (changed) {
        try {
          systemctl('stop', unit);
          if (!old) systemctl('disable', unit);
          if (old) replace(unitFile, old); else rmSync(unitFile, { force: true });
          systemctl('daemon-reload');
          if (old && wasActive) systemctl('start', unit);
        } catch (rollback) {
          throw new Error(`${error.message}; rollback could not finish: ${rollback.message}`);
        }
      }
      throw error;
    }
    trySyncPiSkills();
    console.log('Herdgate publisher connected to Gate; no Herdr process was restarted.');
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
try {
  const [action, ...args] = process.argv.slice(2);
  if (process.platform !== 'linux') throw new Error('home-tui requires Linux with a systemd user manager');
  if (action === 'setup') await setup(args);
  else if (!args.length && ['start', 'status', 'restart', 'stop'].includes(action)) {
    const existing = installedUnit();
    if (!existing || !(existing.startsWith(marker) || legacyUnit(existing))) throw new Error('run herdgate home-tui setup first');
    systemctl(action, ...(action === 'status' ? ['--no-pager'] : []), unit);
  } else throw new Error('usage: herdgate home-tui setup [--adopt] | start | status | restart | stop');
} catch (error) {
  console.error('herdgate home-tui: ' + error.message);
  process.exitCode = 1;
}
