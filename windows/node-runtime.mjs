// An npm-launched CLI can be running under a different Node from npm itself.
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const major = (version) => Number(/^v?(\d+)\./.exec(version)?.[1] || 0);
const working = (version, webSocket) => major(version) >= 22 && webSocket;

/** Return an absolute alternate runtime, or null when the current runtime is usable. */
export function windowsNode({ version = process.version, webSocket = typeof globalThis.WebSocket === 'function', env = process.env } = {}) {
  if (working(version, webSocket)) return null;
  // Do not work around flags disabling WebSocket on an already compatible Node installation.
  if (major(version) >= 22) throw new Error(`WebSocket is disabled or unavailable in Node ${version}; check NODE_OPTIONS and the Node installation`);
  for (const base of new Set([env.ProgramW6432, env.ProgramFiles])) {
    if (!base || !isAbsolute(base)) continue;
    const candidate = join(base, 'nodejs', 'node.exe');
    const result = spawnSync(candidate, ['-p', 'JSON.stringify([process.version,typeof(WebSocket)])'], {
      cwd: join(base, 'nodejs'), env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 3000,
    });
    if (result.status !== 0) continue;
    try {
      const [found, ws] = JSON.parse(result.stdout);
      if (working(found, ws === 'function')) return candidate;
    } catch { /* not a usable Node runtime */ }
  }
  throw new Error(`Herdgate was launched with Node ${String(version).replace(/^v/, '')}; install Node 22+ with WebSocket enabled or run the CLI directly with that Node`);
}
