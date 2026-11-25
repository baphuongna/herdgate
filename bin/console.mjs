#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConsoleAssets } from "./console-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "bin", "console-server.mjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stateDirectory(env = process.env) {
  if (env.HERDGATE_CONSOLE_STATE_DIR) return resolve(env.HERDGATE_CONSOLE_STATE_DIR);
  if (process.platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("console_windows_launcher_blocked");
    return join(env.LOCALAPPDATA, "Herdgate", "console");
  }
  return resolve(join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdgate", "console"));
}
function assetsDirectory(env = process.env) {
  return resolve(env.HERDGATE_CONSOLE_ASSET_DIR || join(ROOT, "plugin", "server", "console", "dist"));
}
function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
  const info = statSync(path);
  if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error("console_state_permissions_invalid");
}
function readInstance(directory) {
  const file = join(directory, "instance.json");
  if (!existsSync(file)) return null;
  try {
    const fileStat = lstatSync(file);
    const dirStat = statSync(directory);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || (process.platform !== "win32" && (fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o077) !== 0 || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077) !== 0))) throw new Error("bad private state");
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state?.version !== 1 || !UUID.test(state.instanceId) || !Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535 || state.host !== "127.0.0.1" || state.controlPath !== join(directory, "control.sock") || state.origin !== `http://127.0.0.1:${state.port}` || !Number.isSafeInteger(state.pid)) throw new Error("bad instance identity");
    return state;
  } catch { throw new Error("console_state_invalid; refusing to adopt or stop an unverified instance"); }
}
async function health(state) {
  try {
    const response = await fetch(`${state.origin}/_console/health`, { headers: { host: `127.0.0.1:${state.port}` }, signal: AbortSignal.timeout(700) , redirect: "manual" });
    if (response.status !== 200) return null;
    const body = await response.json();
    if (body?.status !== "ready" || body.instanceId !== state.instanceId || !["online", "unavailable"].includes(body.runtime) || !["rpc", "unavailable"].includes(body.transport)) return null;
    return body;
  } catch { return null; }
}
async function statusInfo(directory = stateDirectory()) {
  let state;
  try { state = readInstance(directory); } catch { return { status: "error" }; }
  if (!state) {
    if (existsSync(join(directory, "control.sock"))) return { status: "error" };
    if (existsSync(join(directory, ".start.lock"))) {
      try { return Date.now() - statSync(join(directory, ".start.lock")).mtimeMs < 10_000 ? { status: "starting" } : { status: "error" }; }
      catch { return { status: "error" }; }
    }
    return { status: "stopped" };
  }
  const body = await health(state);
  if (!body) return { status: "error" };
  return { status: body.runtime === "online" ? "ready" : "runtime-unavailable", address: state.origin, transport: body.transport };
}
function outputStatus(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (value.status === "stopped") process.stdout.write("Console: stopped\n");
  else if (value.status === "error") process.stdout.write("Console: error (instance is not responding)\n");
  else process.stdout.write(`Console: ${value.status} at ${value.address} (${value.transport})\n`);
}
async function control(state, command) {
  try {
    const socketStat = lstatSync(state.controlPath);
    if (!socketStat.isSocket() || (process.platform !== "win32" && (socketStat.uid !== process.getuid?.() || (socketStat.mode & 0o077) !== 0))) throw new Error("console_control_unverified");
  } catch { throw new Error("console_control_unverified"); }
  return new Promise((resolveReply, rejectReply) => {
    const socket = net.createConnection(state.controlPath);
    let data = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("console_control_timeout")), 1_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectReply(error); else resolveReply(value);
    };
    socket.once("error", () => finish(new Error("console_control_unavailable")));
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.byteLength > 4096) return finish(new Error("console_control_invalid_reply"));
      const nl = data.indexOf(0x0a);
      if (nl < 0) return;
      try {
        const value = JSON.parse(data.subarray(0, nl).toString("utf8"));
        if (!value?.ok) return finish(new Error(value?.code || "console_control_denied"));
        finish(null, value);
      } catch { finish(new Error("console_control_invalid_reply")); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ instanceId: state.instanceId, command })}\n`));
  });
}
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function start() {
  if (process.platform === "win32") throw new Error("console_windows_launcher_blocked; Windows lifecycle is not live-verified");
  const directory = stateDirectory();
  ensurePrivateDir(directory);
  const existing = readInstance(directory);
  if (existing) {
    const current = await health(existing);
    if (current) {
      outputStatus({ status: current.runtime === "online" ? "ready" : "runtime-unavailable", address: existing.origin, transport: current.transport }, false);
      return;
    }
    throw new Error("console_instance_unverified; refusing to kill or adopt stale state");
  }
  if (existsSync(join(directory, "control.sock"))) throw new Error("console_instance_unverified; stale private control socket exists");
  const assets = assetsDirectory();
  validateConsoleAssets(assets);
  let lock;
  try { lock = join(directory, ".start.lock"); mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw new Error("console_state_permissions_invalid");
    lock = join(directory, ".start.lock");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && existsSync(lock)) {
      const concurrent = readInstance(directory);
      if (concurrent) {
        const current = await health(concurrent);
        if (current) {
          outputStatus({ status: current.runtime === "online" ? "ready" : "runtime-unavailable", address: concurrent.origin, transport: current.transport }, false);
          return;
        }
        throw new Error("console_instance_unverified; refusing to kill or adopt stale state");
      }
      await delay(40);
    }
    if (!existsSync(lock)) return start();
    throw new Error("console_start_in_progress; retry after status check");
  }
  try {
    const instanceId = randomUUID();
    const running = readInstance(directory);
    if (running) {
      const current = await health(running);
      if (current) {
        outputStatus({ status: current.runtime === "online" ? "ready" : "runtime-unavailable", address: running.origin, transport: current.transport }, false);
        return;
      }
      throw new Error("console_instance_unverified; refusing to kill or adopt stale state");
    }
    if (existsSync(join(directory, "control.sock"))) throw new Error("console_instance_unverified; stale private control socket exists");
    const childEnv = {};
    for (const key of ["PATH", "HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"]) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    if (process.env.HERDGATE_CONSOLE_RPC_SOCKET) childEnv.HERDGATE_CONSOLE_RPC_SOCKET = process.env.HERDGATE_CONSOLE_RPC_SOCKET;
    const child = spawn(process.execPath, [SERVER, "--state-dir", directory, "--assets-dir", assets, "--instance-id", instanceId], {
      detached: true, stdio: "ignore", shell: false, windowsHide: true, env: childEnv,
    });
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.unref();
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error("console_start_failed; check local service state");
      const state = readInstance(directory);
      if (state?.instanceId === instanceId) {
        const current = await health(state);
        if (current) {
          outputStatus({ status: current.runtime === "online" ? "ready" : "runtime-unavailable", address: state.origin, transport: current.transport }, false);
          return;
        }
      }
      await delay(40);
    }
    throw new Error("console_start_timeout; no verified loopback health response");
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
async function stop() {
  const directory = stateDirectory();
  const state = readInstance(directory);
  if (!state) {
    if (existsSync(join(directory, "control.sock")) || existsSync(join(directory, ".start.lock"))) throw new Error("console_instance_unverified; stale startup state remains");
    process.stdout.write("Console: stopped\n");
    return;
  }
  await control(state, "stop");
  const end = Date.now() + 10_000;
  while (Date.now() < end && existsSync(join(directory, "instance.json"))) await delay(25);
  if (existsSync(join(directory, "instance.json"))) throw new Error("console_stop_unverified; instance state remains");
  process.stdout.write("Console: stopped\n");
}
async function login() {
  const directory = stateDirectory();
  const state = readInstance(directory);
  if (!state || !(await health(state))) throw new Error("Console is stopped; run herdgate console start first");
  const result = await control(state, "issue-login");
  if (typeof result.code !== "string" || !/^[0-9a-f]{64}$/.test(result.code)) throw new Error("console_login_failed");
  process.stdout.write(`Local login code (one use, expires in 120s): ${result.code}\n`);
}
function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") { command = "rundll32.exe"; args = ["url.dll,FileProtocolHandler", url]; }
  else if (process.platform === "darwin") { command = "open"; args = [url]; }
  else { command = "xdg-open"; args = [url]; }
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "ignore", shell: false, windowsHide: true, timeout: 5_000 });
  if (result.error || result.status !== 0) throw new Error("could not open the Console URL with the system browser");
}
async function open() {
  const state = readInstance(stateDirectory());
  if (!state || !(await health(state))) throw new Error("Console is stopped; run herdgate console start first");
  process.stdout.write(`Opening ${state.origin}/\nIf prompted, get a local code with: herdgate console login\n`);
  openBrowser(`${state.origin}/`);
}

const [verb, ...rest] = process.argv.slice(2);
try {
  if (verb === "start" && rest.length === 0) await start();
  else if (verb === "status" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) outputStatus(await statusInfo(), rest[0] === "--json");
  else if (verb === "stop" && rest.length === 0) await stop();
  else if (verb === "login" && rest.length === 0) await login();
  else if (verb === "open" && rest.length === 0) await open();
  else throw new Error("usage: herdgate console start|status [--json]|open|login|stop");
} catch (error) {
  process.stderr.write(`herdgate console: ${error instanceof Error ? error.message : "operation failed"}\n`);
  process.exitCode = 1;
}
