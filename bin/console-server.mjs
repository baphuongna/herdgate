#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleRpc, createUnixConnector } from "./console-rpc.mjs";
import { createConsoleService, validateConsoleAssets } from "./console-service.mjs";

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  if (at < 0 || !args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`missing ${name}`);
  return args[at + 1];
}
const stateDir = resolve(option("--state-dir"));
const assetsDir = resolve(option("--assets-dir"));
const instanceId = option("--instance-id");
const statePath = join(stateDir, "instance.json");
const controlPath = join(stateDir, "control.sock");
let service;
let control;
let ownsControl = false;
let stopping = false;
const WATCHDOG_INTERVAL_MS = 2_000;
let watchdog;

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
function writeInstance(state) {
  const temp = join(stateDir, `.instance-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, statePath);
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (watchdog) { clearInterval(watchdog); watchdog = undefined; }
  try { await service?.stop(); } catch { /* shutdown must continue to state cleanup */ }
  if (control?.listening) await new Promise((resolveClose) => control.close(resolveClose));
  try {
    const current = JSON.parse(readFileSync(statePath, "utf8"));
    if (current.instanceId === instanceId) rmSync(statePath, { force: true });
  } catch { /* state already absent or damaged */ }
  if (ownsControl) {
    rmSync(controlPath, { force: true });
    ownsControl = false;
  }
}

// Orphan guard: once the private control state disappears (state dir wiped, control socket
// deleted) no client can ever stop this service again, so it must end itself. Starts only
// after instance state and the control socket exist, so any later absence means lost control.
function startWatchdog() {
  watchdog = setInterval(() => {
    if (stopping) return;
    let owned = false;
    try { owned = JSON.parse(readFileSync(statePath, "utf8"))?.instanceId === instanceId; }
    catch { owned = false; }
    if (!owned || !existsSync(controlPath)) void shutdown().finally(() => process.exit(0));
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();
}

async function main() {
  if (process.platform === "win32") throw Object.assign(new Error("Windows console lifecycle/control ACL is not yet verified"), { code: "console_windows_launcher_blocked" });
  if (Buffer.byteLength(controlPath) > 100) throw Object.assign(new Error("private control socket path exceeds the Unix socket limit"), { code: "console_control_path_too_long" });
  if (existsSync(statePath) || existsSync(controlPath)) throw Object.assign(new Error("another Console instance or stale private state exists"), { code: "console_instance_conflict" });
  privateDir(stateDir);
  validateConsoleAssets(assetsDir);
  // Only a host-selected explicit endpoint is accepted; no socket discovery, CLI fallback or pipe-name guessing.
  const socketPath = process.env.HERDGATE_CONSOLE_RPC_SOCKET;
  const rpc = socketPath ? createConsoleRpc({ connect: createUnixConnector(socketPath) }) : null;
  service = createConsoleService({ rpc, assetsDir, instanceId, log: (line) => process.stderr.write(`${line}\n`) });
  await service.start({ host: "127.0.0.1", port: 0 });

  control = net.createServer((socket) => {
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 4096) { handled = true; socket.end('{"ok":false}\n'); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); } catch { socket.end('{"ok":false}\n'); return; }
      if (!message || message.instanceId !== instanceId) { socket.end('{"ok":false}\n'); return; }
      if (message.command === "issue-login") {
        try { socket.end(JSON.stringify({ ok: true, code: service.issueLoginCode() }) + "\n"); }
        catch (error) { socket.end(JSON.stringify({ ok: false, code: error?.code ?? "login_failed" }) + "\n"); }
      } else if (message.command === "probe-runtime") {
        void service.probeRuntime().then((runtime) => {
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, runtime }) + "\n");
        });
      } else if (message.command === "stop") {
        socket.end('{"ok":true}\n');
        setImmediate(() => void shutdown());
      } else socket.end('{"ok":false}\n');
    });
  });
  control.listen(controlPath);
  await new Promise((resolveListen, rejectListen) => {
    control.once("listening", resolveListen);
    control.once("error", rejectListen);
  });
  ownsControl = true;
  chmodSync(controlPath, 0o600);
  writeInstance({ version: 1, instanceId, pid: process.pid, host: "127.0.0.1", port: Number(new URL(service.origin).port), origin: service.origin, controlPath, startedAt: Date.now() });
  startWatchdog();
  process.stdout.write("ready\n");
}

process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
main().catch((error) => {
  const code = error?.code || "console_start_failed";
  process.stderr.write(`${code}\n`);
  void shutdown().finally(() => process.exit(1));
});
