import assert from 'node:assert/strict';
import { linkSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runtime = new URL('../windows/node-runtime.mjs', import.meta.url);
const setupTui = new URL('../windows/setup-tui.mjs', import.meta.url);

test('setup-tui: an orphaned .setup lock is reclaimed, a fresh one is respected', async () => {
  const { acquireSetupLock } = await import(setupTui.href);
  const dir = mkdtempSync(join(tmpdir(), 'hg-setup-lock-'));
  try {
    const lock = join(dir, '.setup');
    // Fresh root: the lock is acquired and released cleanly.
    const release = acquireSetupLock(dir);
    assert.ok(existsSync(lock), 'the lock directory exists while held');
    release();
    assert.ok(!existsSync(lock), 'the lock is gone after release');
    // A stale orphan (a killed run from minutes ago) is reclaimed, not fatal.
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const release2 = acquireSetupLock(dir);
    assert.ok(existsSync(lock), 'the stale lock was re-acquired');
    release2();
    assert.ok(!existsSync(lock));
    // A fresh foreign lock means another setup may be running: refuse, explain.
    mkdirSync(lock);
    assert.throws(() => acquireSetupLock(dir), /another herdgate setup|EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
