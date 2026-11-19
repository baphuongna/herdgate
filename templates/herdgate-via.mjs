#!/usr/bin/env node
/**
 * herdgate-via — the `--via` transport for `hc machine add` when the gate's SSH
 * leg is not TCP-reachable from this machine (IPv4-only network vs an AAAA-only
 * host, locked-down proxy, etc).
 *
 * It wraps the system `ssh` and gives it a ProxyCommand that pipes the raw SSH
 * stream through a WebSocket to the gate (`/v1/ssh/ws`, port 443 — the same
 * road the web app already uses). Every check stays in the gate's sshd: device
 * auth, the read-only allowlist, brute-force strikes. This file carries no
 * secrets and needs no admin rights.
 *
 * Modes:
 *   (default)  herdgate-via --gate URL --user d_xxx [--key PATH] "remote line…"
 *              → spawns ssh over the tunnel; used as herdr's `--via` command
 *              (herdr appends the remote line as the last argument).
 *   --tunnel   herdgate-via --tunnel --gate URL
 *              → stdin/stdout ↔ the WebSocket (a ProxyCommand body itself).
 *   --probe    herdgate-via --probe --gate URL
 *              → opens the tunnel and prints the first SSH banner bytes (a
 *                one-shot connectivity check).
 *
 * Zero dependencies; Node ≥ 22 (global WebSocket). Standalone: ships alone.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const GATE = (flag("--gate") ?? process.env.HERDGATE_URL ?? "https://gate.phuongnb.io.vn").replace(/\/$/, "");
const wsUrl = GATE.replace(/^http/, "ws") + "/v1/ssh/ws";
const MODE = argv.includes("--tunnel") ? "tunnel" : argv.includes("--probe") ? "probe" : "via";

const die = (msg) => {
  console.error(`herdgate-via: ${msg}`);
  process.exit(2);
};

const toBuf = (data) => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), "utf8");
};

/** stdin/stdout ↔ the gate's SSH-over-WebSocket leg. */
function tunnel() {
  let ws;
  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer"; // undici hands binary frames as Blob otherwise — SSH bytes would garble
  } catch (e) {
    die(`cannot build ${wsUrl}: ${e?.message ?? e}`);
  }
  const pump = () => process.stdin.on("data", (d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d);
  });
  ws.onopen = () => pump();
  ws.onmessage = (ev) => process.stdout.write(toBuf(ev.data));
  ws.onclose = () => process.exit(0);
  ws.onerror = () => {
    // Undici quirk: a failure while CONNECTING never fires `close` — ssh would
    // sit on a dead pipe forever. Exit on our own; if close does follow, it is a no-op.
    console.error(`herdgate-via: tunnel to ${wsUrl} failed`);
    process.exit(2);
  };
  process.stdin.on("end", () => {
    // Half-close: tell the sshd we are done writing; it closes the rest.
    try { ws.close(1000); } catch { process.exit(0); }
  });
  process.stdin.on("error", () => { /* ssh went away; onclose ends us */ });
}

if (MODE === "tunnel") tunnel();
else if (MODE === "probe") {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const t = setTimeout(() => die(`no SSH banner from ${GATE} in 8s — is the gate up?`), 8_000);
  ws.onmessage = (ev) => {
    clearTimeout(t);
    const s = toBuf(ev.data).toString("latin1");
    console.log(s.startsWith("SSH-") ? `ok: ${GATE} speaks ${s.slice(0, s.indexOf("\n") >= 0 ? s.indexOf("\n") : s.length).trim()}` : `connected, but first bytes are not an SSH banner: ${JSON.stringify(s.slice(0, 32))}`);
    try { ws.close(1000); } catch { /* fine */ }
    setTimeout(() => process.exit(0), 250);
  };
  ws.onerror = () => { clearTimeout(t); die(`cannot reach ${wsUrl}`); };
  ws.onclose = () => { /* covered by the timeout */ };
} else {
  // ---- via: wrap system ssh around the tunnel -------------------------------
  const line = argv[argv.length - 1];
  const user = flag("--user");
  if (!user || !line || line.startsWith("--")) {
    die("usage: herdgate-via --gate URL --user d_xxx [--key PATH] \"remote line\" (herdr passes the line)");
  }
  const keyArg = flag("--key") ?? [join(homedir(), ".ssh", "herdgate"), join(homedir(), ".ssh", "id_ed25519")]
    .find((p) => existsSync(p)) ?? null;
  const self = fileURLToPath(import.meta.url);
  const known = flag("--known-hosts");
  // OpenSSH runs ProxyCommand as a command line: keep it free of quotes and
  // shell metacharacters (paths without spaces, no redirections).
  const proxy = `node ${self} --tunnel --gate ${GATE}`;
  const args = [
    "-o", `ProxyCommand=${proxy}`,
    "-o", "StrictHostKeyChecking=accept-new", // first connect learns the host key, later ones pin it
    ...(known ? ["-o", `UserKnownHostsFile=${known}`] : []),
    "-o", "IdentitiesOnly=yes",
    ...(keyArg ? ["-o", `IdentityFile=${keyArg}`] : []),
    "-o", "BatchMode=yes", // the app's world: no prompts, ever
    "-o", "ServerAliveInterval=15",
    "-o", "ConnectTimeout=15",
    "-p", "22",
    `${user}@herdgate`,
    "--",
    line,
  ];
  // Windows has OpenSSH's ssh.exe on PATH next to node; Unix just `ssh`.
  const sshBin = process.platform === "win32" ? "ssh" : "ssh";
  const check = spawnSync(sshBin, ["-V"], { stdio: "ignore", shell: process.platform === "win32" });
  if (check.error) die(`system ssh not found — OpenSSH client must be on PATH (${check.error.message})`);
  const p = spawn(sshBin, args, { stdio: "inherit" });
  p.on("error", (e) => die(`cannot start ssh: ${e.message}`));
  p.on("exit", (c) => process.exit(c ?? 0));
  process.on("SIGINT", () => p.kill("SIGINT"));
  process.on("SIGTERM", () => p.kill("SIGTERM"));
}

export {};
