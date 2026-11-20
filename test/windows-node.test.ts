import assert from 'node:assert/strict';
import { linkSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runtime = new URL('../windows/node-runtime.mjs', import.meta.url);
test('a Windows npm launcher using Node 20 can use the standard installed Node 22 instead of PATH', async () => {
  const { windowsNode } = await import(runtime.href);
  const folder = mkdtempSync(join(tmpdir(), 'hg Program Files '));
  try {
    const dir = join(folder, 'nodejs');
    const pinned = join(dir, 'node.exe');
    mkdirSync(dir);
    try { linkSync(process.execPath, pinned); } catch { cpSync(process.execPath, pinned); }
    const env = { ...process.env, ProgramW6432: folder, ProgramFiles: folder, PATH: '' };
    assert.equal(windowsNode({ version: 'v20.20.2', webSocket: false, env }), pinned);
    assert.equal(windowsNode({ version: 'v22.14.0', webSocket: true, env }), null);
    assert.throws(() => windowsNode({ version: 'v22.14.0', webSocket: false, env }), /WebSocket is disabled or unavailable/);
    assert.throws(() => windowsNode({ version: 'v20.20.2', webSocket: false, env: { PATH: '' } }), /Node 20.20.2/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
