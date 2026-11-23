/**
 * The herdgate Herdr plugin: manifest validity and the real commands, driven the way
 * Herdr drives them (env vars from docs/plugins.mdx, HERDR_BIN_PATH as the API).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const PLUGIN = new URL("../plugin/", import.meta.url).pathname;
const MANIFEST = readFileSync(join(PLUGIN, "herdr-plugin.toml"), "utf8");
const INDEX = join(PLUGIN, "server/index.mjs");
import { WebSocketServer } from "ws";

/** A fake `herdr` binary: stdout of `api snapshot` is the given JSON. */
function fakeHerdr(dir: string, snapshot: unknown): string {
  const p = join(dir, "herdr");
  const body = `#!/bin/sh\n[ "$1" = "api" ] && [ "$2" = "snapshot" ] && cat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`;
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const snapshot = {
  id: "cli:api:snapshot",
  result: {
    snapshot: {
      version: "0.9.5",
      protocol: 22,
      focused_workspace_id: "w1",
      workspaces: [{ workspace_id: "w1", label: "project", number: 1, tab_count: 1, pane_count: 1, agent_status: "working" }],
      agents: [{ agent: "pi", agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }],
    },
  },
};

function envFor(dir: string, bin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HERDR_ENV: "1",
    HERDR_PLUGIN_ID: "dev.herdgate.host",
    HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
    HERDR_BIN_PATH: bin,
  };
}

test("manifest: declares what Herdr needs, and only read-only surfaces", () => {
  assert.match(MANIFEST, /^id = "dev\.herdgate\.host"$/m);
  assert.match(MANIFEST, /^name = /m);
  assert.match(MANIFEST, /^version = /m);
  assert.match(MANIFEST, /^min_herdr_version = /m, "required by Herdr");
  assert.match(MANIFEST, /platforms = \[/);
  assert.match(MANIFEST, /\[\[startup\]\]/);
  assert.match(MANIFEST, /\[\[actions\]\]/);
  assert.match(MANIFEST, /\[\[panes\]\]/);
  // Action/pane ids may not contain dots (Herdr's rule).
  for (const id of [...MANIFEST.matchAll(/^(?:id|placement) = "([^"]+)"$/gm)].map((m) => m[1])) {
    if (id === "split" || id === "overlay" || id === "popup" || id === "tab" || id === "zoomed") continue;
    if (id.startsWith("dev.")) continue; // the plugin id itself
    assert.ok(!id.includes("."), `local id "${id}" must not contain a dot`);
  }
});

test("plugin: the hello advertises the real package version, not a stale literal", async () => {
  const { pkgVersion } = (await import(new URL("../plugin/server/common.mjs", import.meta.url).href)) as { pkgVersion: () => string };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8")) as { version: string };
  assert.equal(pkgVersion(), pkg.version, "pkgVersion reads the shipped package.json (repo and npm layouts agree)");
  assert.match(pkgVersion(), /^\d+\.\d+\.\d+$/, "a semver-ish string, not a name or a hash");
  assert.ok(!readFileSync(INDEX, "utf8").includes('version: "0.9.38"'), "no hard-coded version in the publisher hello");
});

test('attachment caps: the list reply is capped, newest first', async () => {
  const { listAttachments } = await import(new URL('../plugin/server/attachments.mjs', import.meta.url).href) as { listAttachments: (base: string) => unknown[] };
  const dir = mkdtempSync(join(tmpdir(), 'hg-att-cap-'));
  try {
    const month = join(dir, 'attachments', '2026-11');
    mkdirSync(month, { recursive: true });
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(month, `${crypto.randomUUID()}.png`), Buffer.from([0x89, 0x50]));
    }
    const all = listAttachments(dir);
    assert.equal(all.length, 250, 'the raw helper still lists everything (host-side tools)');
    // The op layer caps at 200 newest — assert the cap constant exists and the slicing marker is wired.
    const src = readFileSync(new URL('../plugin/server/index.mjs', import.meta.url), 'utf8');
    assert.match(src, /MAX_ATTACHMENTS\b/, 'the cap constant exists');
    assert.match(src, /all\.slice\(0, MAX_ATTACHMENTS\)/, 'attachment.list slices when over the cap');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cadence: nextPublishDelay bursts when busy or changed, relaxes when quiet', async () => {
  const { nextPublishDelay } = (await import(new URL('../plugin/server/common.mjs', import.meta.url).href)) as { nextPublishDelay: (o: Record<string, unknown>) => number };
  // Busy agents or a changed snapshot: the fast lane (5s floor, never below 2s).
  assert.equal(nextPublishDelay({ baseMs: 30_000, busy: true }), 5_000);
  assert.equal(nextPublishDelay({ baseMs: 5_000, changed: true }), 5_000);
  assert.equal(nextPublishDelay({ baseMs: 5_000, busy: true }), 5_000);
  // Quiet: grows ×1.5 per streak from the base, clamped at 60s.
  assert.equal(nextPublishDelay({ baseMs: 5_000, quietStreak: 1 }), 7_500);
  assert.equal(nextPublishDelay({ baseMs: 5_000, quietStreak: 2 }), 11_250);
  assert.equal(nextPublishDelay({ baseMs: 5_000, quietStreak: 40 }), 60_000, 'clamped at max');
  // A large base stays itself while quiet — never faster than configured.
  assert.equal(nextPublishDelay({ baseMs: 30_000, quietStreak: 0 }), 30_000);
  assert.equal(nextPublishDelay({ baseMs: 1_000 }), 2_000, 'never below the 2s floor');
  // Env-shaped max override is honored.
  assert.equal(nextPublishDelay({ baseMs: 5_000, quietStreak: 40, maxMs: 20_000 }), 20_000);
});

test('invariant: every bulk op reply carries a cap (source tripwire)', () => {
  const src = readFileSync(INDEX, 'utf8');
  const markers: [string, RegExp, string][] = [
    ['term.list + fleet.detail panes', /MAX_PANES/g, 'both pane-carrying ops cap'],
    ['file.tree entries', /MAX_FILE_ENTRIES/, 'the file index caps'],
    ['file.read bytes', /MAX_FILE_BYTES/, 'file bytes cap'],
    ['file.read wire-budget shrink', /240 \* 1024/, 'the envelope shrink loop lives'],
    ['review.files entries', /MAX_REVIEW_FILES/, 'review list caps'],
    ['diff/review.diff bytes', /MAX_DIFF_BYTES/g, 'patch bytes cap'],
  ];
  for (const [name, re, why] of markers) {
    const hits = re.global ? [...src.matchAll(re)].length : re.test(src) ? 1 : 0;
    assert.ok(hits >= (re.global ? 2 : 1), `${name}: ${why} (found ${hits})`);
  }
});

test("plugin: --help works, and status reports honest, real values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-plugin-"));
  try {
    const bin = fakeHerdr(dir, snapshot);
    const env = envFor(dir, bin);

    const help = await run(process.execPath, [INDEX, "--help"], { env });
    assert.match(help.stdout, /dev\.herdgate\.host/);
    assert.match(help.stdout, /pair/);
    assert.match(help.stdout, /serve/);

    const st = await run(process.execPath, [INDEX, "status"], { env });
    const out = JSON.parse(st.stdout);
    assert.equal(out.plugin, "dev.herdgate.host");
    assert.equal(out.config.paired, false);
    assert.equal(out.publisher.running, false);
    assert.equal(out.herdr.herdr, "0.9.5 (protocol 22)");
    assert.equal(out.herdr.workspaces, 1);
    assert.equal(out.herdr.agents, 1);
    assert.equal(out.herdr.working, 1);
    assert.equal(out.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin: status fails honestly when Herdr cannot be read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-plugin-"));
  try {
    const env = envFor(dir, join(dir, "no-such-herdr"));
    const failed: { stdout: string; code?: number } = await run(process.execPath, [INDEX, "status"], { env }).catch(
      (e: { stdout: string; code: number }) => e,
    );
    const out = JSON.parse(failed.stdout);
    assert.equal(out.herdr, null);
    assert.match(out.error, /herdr/);
    assert.notEqual(failed.code, 0, "an unreadable Herdr is a failing exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin: serve is a no-op until paired, and never fails the Herdr server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-plugin-"));
  try {
    const env = envFor(dir, fakeHerdr(dir, snapshot));
    const r = await run(process.execPath, [INDEX, "serve"], { env }); // rejects on non-zero exit
    assert.equal(typeof r.stdout, "string");
    assert.match(r.stderr, /not paired/);
    assert.equal(existsSync(join(dir, "state", "publisher.pid")), false, "no publisher spawned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin: stop with nothing running says so, and clears a stale pid file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-plugin-"));
  try {
    const env = envFor(dir, fakeHerdr(dir, snapshot));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "publisher.pid"), "999999"); // not a live pid
    const r = await run(process.execPath, [INDEX, "stop"], { env });
    assert.match(r.stderr, /not running/);
    assert.equal(existsSync(join(stateDir, "publisher.pid")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wedge guard: a hung attempt is abandoned, the chain keeps ticking (2026-11-23 laptop wedge)", async () => {
  const { withTimeout } = (await import(new URL("../plugin/server/common.mjs", import.meta.url).href)) as { withTimeout: <T>(p: Promise<T>, ms: number, label?: string) => Promise<T> };
  await assert.rejects(withTimeout(new Promise(() => {}), 40, "wedged"), (e: Error & { kind?: string }) => e.kind === "timeout_guard" && /timed out/.test(e.message));
  assert.equal(await withTimeout(Promise.resolve(7), 100, "fast"), 7, "a healthy attempt passes through untouched");
  // Source tripwire: the tick and the single-flight snapshot must both be guarded —
  // one bare `await publish()` is exactly how 85 minutes of silence happened.
  const src = readFileSync(INDEX, "utf8");
  assert.match(src, /withTimeout\(publish\(wsRef\)/, "the tick's publish is guarded");
  assert.match(src, /withTimeout\(snapshotPayload\(\)/, "the shared snapshot is guarded");
});
