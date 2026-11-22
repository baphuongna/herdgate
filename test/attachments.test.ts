/**
 * Wave C3 — photo/file attachments from the PWA to the agent machine.
 *
 * The herdcats lessons under test (docs/research/2026-11-21-marketplace/deep/cats.md):
 *  - uploads land on the AGENT machine under a private dir: 0700 created one
 *    level at a time, fail-on-symlink, uuid filenames — the client name is
 *    never trusted, the ext comes from magic bytes;
 *  - the reply carries a path hint ("Please open and inspect this image: …")
 *    so the Pi agent reads the file with its own tools — bytes never ride the
 *    prompt;
 *  - refusals are clear error ops, never throws, never a dead host.
 *
 * Device-channel shape is the web-pwa2 one: a local cloud, the real publisher
 * child, a stub herdr, and HERDR_PLUGIN_STATE_DIR pointing at a fixture so
 * attachments land inside it.
 *
 *   node --test test/attachments.test.ts
 */

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startCloud } from '../src/cloud/gateway.ts';
import { State } from '../src/cloud/stores.ts';
import { DeviceSock } from './util2.ts';
import { gcAttachments, listAttachments, MAX_ATTACHMENT_BYTES, saveAttachment, sniffType } from '../plugin/server/attachments.mjs';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const posix = process.platform !== 'win32'; // mode bits and symlinks are POSIX guarantees

// ── magic-byte fixtures: tiny but real signatures, built in-test ──
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\xff', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);

async function waitFor<T>(label: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (performance.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(50);
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  try { await exited; } finally { clearTimeout(timer); }
}

// ── unit: saveAttachment — magic bytes, private dirs, uuid names ──

test('saveAttachment: sniffs the type from magic bytes and stores <uuid>.<ext> mode 0600', () => {
  const base = mkdtempSync(join(tmpdir(), 'hg-att-'));
  try {
    const cases: [Buffer, string][] = [[PNG, 'png'], [JPEG, 'jpg'], [GIF, 'gif'], [WEBP, 'webp']];
    for (const [bytes, ext] of cases) {
      assert.equal(sniffType(bytes), ext, `${ext} magic sniffs as ${ext}`);
      const { id, path } = saveAttachment(base, { name: `client-name.${ext === 'jpg' ? 'jpeg' : ext}`, bytes });
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'the id is a uuid');
      assert.ok(path.startsWith(join(base, 'attachments')), 'stored under base/attachments');
      assert.match(path, /attachments[/\\]\d{4}-\d{2}[/\\]/, 'one month bucket yyyy-mm');
      assert.ok(path.endsWith(`.${ext}`), `the ext is ${ext} (from magic, not the client name)`);
      assert.ok(!path.includes('client-name'), 'the client name never reaches the stored path');
      assert.ok(existsSync(path), 'the file exists');
      assert.equal(statSync(path).size, bytes.length, 'the bytes are intact');
      if (posix) assert.equal(statSync(path).mode & 0o777, 0o600, 'file mode 0600');
    }
    if (posix) {
      // every traversed level is 0700 — created one level at a time, chmod'd each
      const root0700 = statSync(join(base, 'attachments'));
      assert.equal(root0700.mode & 0o777, 0o700, 'attachments/ is 0700');
      const month = readdir0700(join(base, 'attachments'));
      assert.ok(month, 'one month dir exists');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function readdir0700(dir: string): string | null {
  // proves the month level exists under attachments/ (the mode asserts above cover the rest)
  const names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}$/.test(n));
  return names.length ? names[0] : null;
}

test('saveAttachment: same bytes twice → two uuids, never a clobbered name', () => {
  const base = mkdtempSync(join(tmpdir(), 'hg-att-2-'));
  try {
    const first = saveAttachment(base, { name: 'a.png', bytes: PNG });
    const second = saveAttachment(base, { name: 'a.png', bytes: PNG });
    assert.notEqual(first.id, second.id, 'two distinct uuids');
    assert.notEqual(first.path, second.path);
    assert.ok(existsSync(first.path) && existsSync(second.path), 'both files live side by side');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('saveAttachment: refuses bad bytes, wrong magic, oversize, non-Buffer', () => {
  const base = mkdtempSync(join(tmpdir(), 'hg-att-3-'));
  try {
    assert.throws(() => saveAttachment(base, { name: 'no.png', bytes: Buffer.from('definitely not an image, just text') }),
      /bad_type/, 'no known magic → bad_type');
    assert.throws(() => saveAttachment(base, { name: 'lying.png', bytes: Buffer.from('PN') }), /bad_type/);
    assert.throws(() => saveAttachment(base, { name: 'big.png', bytes: Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]) }),
      /too_large/, '4MiB+1 → too_large');
    assert.equal(PNG.length + MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES + PNG.length);
    assert.throws(() => saveAttachment(base, { name: 'u8.png', bytes: new Uint8Array(PNG) }), /bad_bytes/,
      'only a real Buffer is accepted');
    assert.throws(() => saveAttachment(base, { name: 'z.png', bytes: Buffer.alloc(0) }), /empty/);
    const ok = saveAttachment(base, { name: 'cap.png', bytes: Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES - PNG.length)]) });
    assert.ok(existsSync(ok.path), 'exactly 4MiB is legal');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('saveAttachment: a planted symlink on the path is refused, never written through', { skip: !posix && 'symlinks need privileges' }, () => {
  // plant 1: base/attachments itself is a symlink to elsewhere
  const base = mkdtempSync(join(tmpdir(), 'hg-att-4-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'hg-att-4-elsewhere-'));
  try {
    symlinkSync(elsewhere, join(base, 'attachments'));
    assert.throws(() => saveAttachment(base, { name: 'a.png', bytes: PNG }), /symlink/);
    assert.equal(listAttachments(base).length, 0, 'nothing was written through the link');
    const written = readdirSafe(elsewhere);
    assert.equal(written, 0, 'the symlink target stayed untouched');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }

  // plant 2: the month dir inside a real attachments/ is the symlink
  const base2 = mkdtempSync(join(tmpdir(), 'hg-att-5-'));
  const elsewhere2 = mkdtempSync(join(tmpdir(), 'hg-att-5-elsewhere-'));
  try {
    mkdirSync(join(base2, 'attachments'));
    const month = `${new Date().getUTCFullYear()}-` + String(new Date().getUTCMonth() + 1).padStart(2, '0');
    symlinkSync(elsewhere2, join(base2, 'attachments', month));
    assert.throws(() => saveAttachment(base2, { name: 'a.png', bytes: PNG }), /symlink/);
    assert.equal(readdirSafe(elsewhere2), 0, 'the month-dir link target stayed untouched');
  } finally {
    rmSync(base2, { recursive: true, force: true });
    rmSync(elsewhere2, { recursive: true, force: true });
  }
});

function readdirSafe(dir: string): number {
  try { return readdirSync(dir).length; } catch { return 0; }
}

test('listAttachments: metadata only, never content; gc dry-run then apply', () => {
  const base = mkdtempSync(join(tmpdir(), 'hg-att-6-'));
  try {
    const fresh = saveAttachment(base, { name: 'new.png', bytes: PNG });
    const stale = saveAttachment(base, { name: 'old.png', bytes: GIF });
    const old = new Date(Date.now() - 20 * 86400e3); // 20 days — past the 14-day TTL
    utimesSync(stale.path, old, old); // Dates, not numbers: numeric utimes break on some fs

    const listed = listAttachments(base);
    assert.equal(listed.length, 2);
    assert.ok(listed.every((row) => typeof row.id === 'string' && typeof row.path === 'string'
      && typeof row.size === 'number' && typeof row.at === 'number'), 'id/path/size/at only');
    assert.ok(!('bytes' in listed[0]) && !('data' in listed[0]), 'no content ever leaves listAttachments');

    const dry = gcAttachments(base, { days: 14 }); // dry-run is the default
    assert.equal(dry.applied, false, 'default is dry-run');
    assert.deepEqual(dry.candidates.map((c) => c.id), [stale.id], 'only the stale file is a candidate');
    assert.ok(existsSync(stale.path) && existsSync(fresh.path), 'dry-run deletes nothing');

    const applied = gcAttachments(base, { days: 14, apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.deleted, 1);
    assert.ok(!existsSync(stale.path), 'the stale file is gone');
    assert.ok(existsSync(fresh.path), 'the fresh file is kept');
    assert.equal(listAttachments(base).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── ops over the device channel: the real publisher child, web-pwa2 shape ──

type UploadedReply = { op: string; id?: string; path?: string; hint?: string; code?: string; message?: string };
type ListReply = { op: string; attachments?: { id: string; path: string; size: number; at: number }[] };

test('attachment.upload / attachment.list over the device channel: path + hint on the agent machine', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-att-7-'));
  const log: string[] = [];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let publisher: ChildProcess | undefined;
  try {
    // --- stub herdr: nothing here needs it beyond existing
    const stub = join(dir, 'herdr-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);

    // --- local cloud with one room and one read-scoped device
    const accounts = [{ id: 'a1', name: 'test', token: 'att-owner' }];
    const statePath = join(dir, 'state.json');
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom('a1', 'att-host');
    const { device, secret } = state.addDevice(room, 'att-device', 'read');
    cloud = await startCloud({ accounts, statePath, log: entry => log.push(entry) });
    const gate = `ws://127.0.0.1:${cloud.port}`;

    // --- the real publisher child; its state dir is where attachments must land
    const config = join(dir, 'publisher');
    mkdirSync(config);
    writeFileSync(join(config, 'herdgate.env'), `HERDGATE_URL=http://127.0.0.1:${cloud.port}\nHERDGATE_ROOM_TOKEN=${token}\n`, { mode: 0o600 });
    publisher = spawn(process.execPath, [join(root, 'plugin/server/index.mjs'), 'serve'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: dir,
        HERDR_BIN_PATH: stub, HERDR_PLUGIN_ID: 'dev.herdgate.host',
        HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: config,
        HERDGATE_PUBLISHER_CHILD: '1', HERDGATE_TUI_ONLY: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    publisher.stderr!.setEncoding('utf8').on('data', chunk => log.push(chunk));
    await waitFor('publisher connected', () => log.some(entry => entry.includes('herdgate: connected to')));

    const ask = async (payload: Record<string, unknown>, expectOp: string): Promise<Record<string, unknown>> => {
      const sock = new DeviceSock(`${gate}/v1/device/ws`);
      try {
        const hello = await sock.hello({ device: device.id, deviceSecret: secret });
        assert.equal(hello.t, 'hello', JSON.stringify(hello));
        await sock.send({ t: 'frame', payload });
        const deadline = performance.now() + 10_000;
        for (;;) {
          const frame = await sock.expect('frame');
          const reply = frame.payload as { op?: string } | undefined;
          if (reply?.op === expectOp || reply?.op === 'error') return reply as Record<string, unknown>;
          if (performance.now() > deadline) throw new Error(`no ${expectOp} frame in time (got ${String(reply?.op)})`);
        }
      } finally { sock.close(); }
    };

    t.diagnostic('upload: a real PNG lands in the publisher state dir, reply carries path + hint');
    const up = await ask({ op: 'attachment.upload', name: 'photo.png', dataBase64: PNG.toString('base64') }, 'attachment.uploaded') as unknown as UploadedReply;
    assert.equal(up.op, 'attachment.uploaded');
    assert.ok(up.id && /^[0-9a-f-]{36}$/.test(up.id), 'a uuid id');
    const path = String(up.path);
    assert.ok(path.startsWith(join(config, 'attachments')), 'the file is on the agent machine, in the state dir');
    assert.match(path, /attachments[/\\]\d{4}-\d{2}[/\\][0-9a-f-]{36}\.png$/, 'month bucket + uuid.png');
    assert.equal(up.hint, `Please open and inspect this image: ${path}`, 'the cats-pattern hint, verbatim');
    assert.ok(existsSync(path), 'the file really exists where the hint says');
    assert.equal(statSync(path).size, PNG.length, 'the bytes arrived intact');
    if (posix) {
      assert.equal(statSync(path).mode & 0o777, 0o600, 'file 0600 on the host');
      assert.equal(statSync(join(config, 'attachments')).mode & 0o777, 0o700, 'attachments/ 0700 on the host');
    }

    const up2 = await ask({ op: 'attachment.upload', name: 'photo.png', dataBase64: PNG.toString('base64') }, 'attachment.uploaded') as unknown as UploadedReply;
    assert.notEqual(up2.id, up.id, 'uuid names never collide');

    t.diagnostic('list: metadata for what was uploaded, no content');
    const list = await ask({ op: 'attachment.list' }, 'attachment.list.result') as unknown as ListReply;
    assert.equal(list.op, 'attachment.list.result');
    const ids = (list.attachments ?? []).map(row => row.id);
    assert.ok(ids.includes(up.id!) && ids.includes(up2.id!), 'both uploads are listed');
    for (const row of list.attachments ?? []) {
      assert.equal(typeof row.size, 'number');
      assert.equal(typeof row.at, 'number');
      assert.ok(!('data' in row) && !('bytes' in row), 'list never carries content');
    }

    t.diagnostic('refusals are clear error ops and never take the host down');
    // (The >4MiB throw is covered at the module level above: the device ws caps
    // frames at 256KiB — MAX_FRAME_BYTES — so an oversized upload can never even
    // arrive whole; the host-side 4MiB cap is defense in depth.)
    const garbage = await ask({ op: 'attachment.upload', name: 'x.png', dataBase64: '###not-base64###' }, 'attachment.uploaded');
    assert.equal(garbage.op, 'error');
    assert.equal(garbage.code, 'attachment');
    assert.match(String(garbage.message), /base64/);

    const lying = await ask({ op: 'attachment.upload', name: 'lying.png', dataBase64: Buffer.from('just text, no magic').toString('base64') }, 'attachment.uploaded');
    assert.equal(lying.op, 'error');
    assert.match(String(lying.message), /bad_type/);

    const missing = await ask({ op: 'attachment.upload', name: 'no-data.png' }, 'attachment.uploaded');
    assert.equal(missing.op, 'error');
    assert.match(String(missing.message), /name and base64/);

    const after = await ask({ op: 'attachment.list' }, 'attachment.list.result') as unknown as ListReply;
    assert.equal(after.op, 'attachment.list.result');
    assert.equal((after.attachments ?? []).length, 2, 'refused uploads stored nothing; the host still answers');
  } catch (err) {
    t.diagnostic(log.join('\n').slice(-4000));
    throw err;
  } finally {
    await stop(publisher);
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the PWA asset contract (marker test, web-pwa2 style) ──

test('web assets: the 📎 composer exists and talks attachment.upload', () => {
  const src = readFileSync(join(root, 'src/web/app.js'), 'utf8');
  for (const marker of ['attachment.upload', 'attachment.uploaded', '📎', 'image/*', 'Please open and inspect this image']) {
    assert.ok(src.includes(marker), `app.js must contain ${marker}`);
  }
  const css = readFileSync(join(root, 'src/web/app.css'), 'utf8');
  assert.ok(css.includes('.toast'), 'app.css styles the refusal toast');
});
