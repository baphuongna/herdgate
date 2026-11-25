import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { startFixtureRuntime } from "./fixtures/local-web-console-runtime/runtime.mjs";

const repo = join(import.meta.dirname, "..");
const assets = join(repo, "test/fixtures/local-web-console-runtime/console/dist");
const fixtureSnapshot = {
  version: "0.9.5", protocol: 22, workspaces: [{ workspace_id: "w1", label: "fixture" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true }],
  layouts: [], agents: [],
};

test("console CLI start/status/login/open/stop drives an isolated HTTP + RPC fixture", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hg-console-cli-"));
  const state = join(root, "state");
  const runtimeSocket = join(root, "runtime.sock");
  const openBin = join(root, "bin");
  const openLog = join(root, "opened-url");
  const runtime = await startFixtureRuntime(runtimeSocket, { snapshot: fixtureSnapshot });
  const env = {
    ...process.env,
    HERDGATE_CONSOLE_STATE_DIR: state,
    HERDGATE_CONSOLE_ASSET_DIR: assets,
    HERDGATE_CONSOLE_RPC_SOCKET: runtimeSocket,
    PATH: `${openBin}:${process.env.PATH ?? ""}`,
    HG_OPEN_LOG: openLog,
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "bin/herdgate.mjs"), "console", ...args], { env, encoding: "utf8", timeout: 10_000 });
  const runAsync = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, "bin/herdgate.mjs"), "console", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
  t.after(async () => {
    if (existsSync(join(state, "instance.json"))) run("stop");
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  const before = run("status", "--json");
  assert.equal(before.status, 0);
  assert.deepEqual(JSON.parse(before.stdout), { status: "stopped" });
  const [start, startAgain] = await Promise.all([runAsync("start"), runAsync("start")]);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(startAgain.status, 0, startAgain.stderr);
  const status = await runAsync("status", "--json");
  assert.equal(status.status, 0);
  const statusObject = JSON.parse(status.stdout);
  assert.equal(statusObject.status, "ready", "start probes the configured runtime before reporting status");
  assert.equal(statusObject.transport, "rpc");
  assert.match(statusObject.address, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(status.stdout, new RegExp(runtimeSocket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const loginResult = run("login");
  assert.equal(loginResult.status, 0, loginResult.stderr);
  const code = /expires in 120s\): ([0-9a-f]{64})/.exec(loginResult.stdout)?.[1];
  assert.ok(code);
  assert.doesNotMatch(loginResult.stderr, new RegExp(code));
  const instance = JSON.parse(readFileSync(join(state, "instance.json"), "utf8"));
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, "instance.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(instance), new RegExp(code));

  const origin = statusObject.address;
  const redemption = await fetch(`${origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
  assert.equal(redemption.status, 200);
  const { token } = await redemption.json() as { token: string };
  assert.doesNotMatch(readFileSync(join(state, "instance.json"), "utf8"), new RegExp(token));
  assert.equal(new URL(redemption.url).search, "");
  const auth = { authorization: `Bearer ${token}` };
  const sessionResponse = await fetch(`${origin}/api/console/v1/session`, { headers: auth });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { runtimeGeneration: string };
  const onlineStatus = await runAsync("status", "--json");
  assert.equal(onlineStatus.status, 0);
  assert.equal(JSON.parse(onlineStatus.stdout).status, "ready");
  const screen = await fetch(`${origin}/api/console/v1/pane/w1%3Ap1/screen`, { headers: { ...auth, "x-herdgate-runtime-generation": session.runtimeGeneration } });
  assert.equal(screen.status, 200);
  assert.match((await screen.json()).ansi, /fixture screen/);

  mkdirSync(openBin, { recursive: true });
  writeFileSync(join(openBin, "xdg-open"), "#!/bin/sh\nprintf '%s' \"$1\" > \"$HG_OPEN_LOG\"\n", { mode: 0o700 });
  chmodSync(join(openBin, "xdg-open"), 0o700);
  const opened = run("open");
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(readFileSync(openLog, "utf8"), `${origin}/`);
  assert.doesNotMatch(readFileSync(openLog, "utf8"), new RegExp(token));

  const stop = run("stop");
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(run("stop").status, 0, "stop is idempotent");
  assert.deepEqual(JSON.parse(run("status", "--json").stdout), { status: "stopped" });
  assert.equal(existsSync(join(state, "instance.json")), false);
});

test("start and status probe the configured RPC fixture as it goes up and down", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows Console lifecycle remains intentionally blocked pending live verification");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hg-console-runtime-status-"));
  const state = join(root, "state");
  const runtimeSocket = join(root, "runtime.sock");
  const env = { ...process.env, HERDGATE_CONSOLE_STATE_DIR: state, HERDGATE_CONSOLE_ASSET_DIR: assets, HERDGATE_CONSOLE_RPC_SOCKET: runtimeSocket };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "bin/herdgate.mjs"), "console", ...args], { env, encoding: "utf8", timeout: 10_000 });
  const runAsync = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, "bin/herdgate.mjs"), "console", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
  let runtime: Awaited<ReturnType<typeof startFixtureRuntime>> | undefined;
  t.after(async () => {
    if (existsSync(join(state, "instance.json"))) run("stop");
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const started = run("start");
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /runtime-unavailable/);
  assert.equal(JSON.parse(run("status", "--json").stdout).status, "runtime-unavailable");

  runtime = await startFixtureRuntime(runtimeSocket, { snapshot: fixtureSnapshot });
  const up = await runAsync("status", "--json");
  assert.equal(up.status, 0, up.stderr);
  assert.equal(JSON.parse(up.stdout).status, "ready");
  await runtime.close();
  runtime = undefined;
  const down = await runAsync("status", "--json");
  assert.equal(down.status, 0, down.stderr);
  assert.equal(JSON.parse(down.stdout).status, "runtime-unavailable");
  assert.equal(run("stop").status, 0);
});

test("default assets come from app-root console/dist; explicit asset override remains supported", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hg-console-default-assets-"));
  const bin = join(root, "bin");
  const dist = join(root, "console", "dist");
  const state = join(root, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dist, { recursive: true });
  for (const file of ["console.mjs", "console-server.mjs", "console-service.mjs", "console-rpc.mjs"]) {
    copyFileSync(join(repo, "bin", file), join(bin, file));
  }
  writeFileSync(join(dist, "manifest.json"), JSON.stringify({ version: 1, index: "index.html", files: { "index.html": { path: "index.html", type: "text/html; charset=utf-8" } } }));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>default asset fixture</title>");
  const env = { ...process.env, HERDGATE_CONSOLE_STATE_DIR: state };
  delete env.HERDGATE_CONSOLE_ASSET_DIR;
  delete env.HERDGATE_CONSOLE_RPC_SOCKET;
  const run = (...args: string[]) => spawnSync(process.execPath, [join(bin, "console.mjs"), ...args], { env, encoding: "utf8", timeout: 10_000 });
  t.after(() => { if (existsSync(join(state, "instance.json"))) run("stop"); rmSync(root, { recursive: true, force: true }); });
  const started = run("start");
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /runtime-unavailable/);
  const status = run("status", "--json");
  assert.equal(JSON.parse(status.stdout).status, "runtime-unavailable");
  assert.equal(run("stop").status, 0);
});

test("open never starts a stopped Console and start fails clearly without an asset manifest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hg-console-cli-negative-"));
  const env = { ...process.env, HERDGATE_CONSOLE_STATE_DIR: join(root, "state"), HERDGATE_CONSOLE_ASSET_DIR: join(root, "missing-assets") };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "bin/herdgate.mjs"), "console", ...args], { env, encoding: "utf8", timeout: 5_000 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opened = run("open");
  assert.notEqual(opened.status, 0);
  assert.match(opened.stderr, /run herdgate console start/);
  assert.equal(existsSync(env.HERDGATE_CONSOLE_STATE_DIR), false, "open does not implicitly start or create state");
  const start = run("start");
  assert.notEqual(start.status, 0);
  assert.match(start.stderr, /console_assets_missing/);
});
