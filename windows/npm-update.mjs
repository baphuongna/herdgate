// Fetch the npm release using npm bundled with the same Node, without running install hooks.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function withLatest(run) {
  const nodeDir = dirname(process.execPath);
  const npm = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.platform === 'win32' ? [] : [join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]),
    ...(nodeDir === '/usr/bin' ? ['/usr/share/nodejs/npm/bin/npm-cli.js'] : []),
  ].find(existsSync);
  if (!npm) throw new Error('npm was not found beside Node; use a Node 22+ distribution with npm');
  const work = mkdtempSync(join(tmpdir(), 'herdgate-update-'));
  try {
    const result = spawnSync(process.execPath, [npm, 'install', '--prefix', work, '--global=false', '--no-save', '--package-lock=false',
      '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', '@bom0792/herdgate@latest'],
    { cwd: work, stdio: 'inherit', shell: false, windowsHide: true, timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('could not download Herdgate from npm; current publisher not changed');
    return run(join(work, 'node_modules', '@bom0792', 'herdgate'));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}
