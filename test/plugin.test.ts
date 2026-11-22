/**
 * The herdgate Herdr plugin: manifest validity and the real commands, driven the way
 * Herdr drives them (env vars from docs/plugins.mdx, HERDR_BIN_PATH as the API).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const PLUGIN = new URL("../plugin/", import.meta.url).pathname;
const MANIFEST = readFileSync(join(PLUGIN, "herdr-plugin.toml"), "utf8");
const INDEX = join(PLUGIN, "server/index.mjs");

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
