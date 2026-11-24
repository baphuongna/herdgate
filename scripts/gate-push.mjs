#!/usr/bin/env node
// gate-push — ship the gate's nightly backup off-site, encrypted.
//
// The backup dir (state.json + the SSH host key + vapid.json) is secret: the
// VPS is only a courier and must never hold plaintext (same trust rule as the
// cutover plan: the VPS sees ciphertext only). Format: gzip'd tar -> AES-256-GCM
// ("HGP1" | 12-byte IV | ciphertext | 16-byte tag) with a 32-byte key file that
// lives ONLY on this machine (0600, auto-created). Losing both the machine and
// the key loses the backup: run `export-key` once and keep it in a password
// manager. The remote needs nothing but ssh + POSIX sh (mkdir/cat/sha256sum/
// ls/rm); rsync is not assumed. A push only counts when the remote sha256
// matches the local one.
//
// usage:
//   gate-push.mjs push  --to <user@host> [--port N] --path <remote-dir> [--keep 14]
//                       [--key <file>] [--backup <dir>]      (default: newest gate-* backup)
//   gate-push.mjs auto                                      (config-driven; no config = exit 0)
//   gate-push.mjs check --to <user@host> [--port N] --path <remote-dir>
//   gate-push.mjs export-key [--key <file>]                 (prints base64; the owner runs this)
//   gate-push.mjs decrypt --in <file.enc> --out <dir> [--key <file>]
//
// config (opt-in, read by `auto`): ~/.config/herdgate/backup-remote.json
//   { "host": "user@vps", "port": 22, "path": "/srv/herdgate-backup", "keep": 14 }
// exit codes: 0 ok · 1 usage · 2 nothing to push / bad config · 3 key/crypto
//             4 transport · 5 verify mismatch · 6 prune failed
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("HGP1", "ascii");
// Test seam for paths (same spirit as HERDR_SDD_SESSIONS_ROOT in experiments/pi-spawn/sdd.mjs):
// the real timers never set these; tests point HOME-anchored paths at a tmp dir.
const CONFIG_PATH = process.env.HERDGATE_PUSH_CONFIG ?? join(homedir(), ".config", "herdgate", "backup-remote.json");
const DEFAULT_KEY = process.env.HERDGATE_PUSH_KEY ?? join(homedir(), ".config", "herdgate", "backup.key");
const BACKUPS_ROOT = process.env.HERDGATE_PUSH_BACKUPS ?? join(homedir(), ".local", "state", "herdgate", "backups");
const die = (code, msg) => { console.error(`gate-push: ${msg}`); process.exit(code); };
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};

// --- test seam (same pattern as setHerdrRunnerForTests in experiments/pi-spawn/task.mjs)
let runnerForTests = null;
export function setRunnerForTests(fn) { runnerForTests = fn; }
function run(cmd, args, opts = {}) {
  if (runnerForTests) return runnerForTests({ cmd, args, opts });
  return spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, ...opts });
}

// --- crypto -------------------------------------------------------------
export function loadKey(keyFile) {
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true });
    const bytes = randomBytes(32);
    writeFileSync(keyFile, bytes, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    console.error(`gate-push: created NEW key ${keyFile} — run export-key and keep a copy in a password manager; without it off-site backups are unreadable.`);
    return bytes;
  }
  const raw = readFileSync(keyFile);
  const bytes = raw.length === 32 ? raw : Buffer.from(raw.toString("utf8").trim(), "base64");
  if (bytes.length !== 32) throw new Error(`key ${keyFile} must be 32 bytes (or base64 of 32 bytes)`);
  return bytes;
}
export function encryptBlob(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([MAGIC, iv, c.update(plain), c.final(), c.getAuthTag()]);
}
export function decryptBlob(key, blob) {
  if (blob.length < 4 + 12 + 16 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("not a gate-push blob (bad magic or size)");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(16, blob.length - 16)), d.final()]);
}

// --- naming / pruning ----------------------------------------------------
export function remoteName(backupDir) {
  const base = String(backupDir).replace(/\/+$/, "").split("/").pop();
  if (!/^gate-\d{4}-\d{2}-\d{2}T/.test(base)) throw new Error(`backup dir name not recognized: ${base}`);
  return `${base}.tar.gz.enc`;
}
export function pruneKeep(names, keep) {
  const enc = names.filter((n) => /^gate-\d{4}-\d{2}-\d{2}T.*\.tar\.gz\.enc$/.test(n)).sort();
  return enc.slice(0, Math.max(0, enc.length - keep));
}
export function latestBackup(root = BACKUPS_ROOT) {
  try {
    const pointer = join(root, "_latest");
    if (existsSync(pointer)) {
      // gate-backup.mjs writes _latest as a text pointer (the archive dir name)
      const named = readFileSync(pointer, "utf8").trim();
      if (/^gate-\d{4}-\d{2}-\d{2}T/.test(named) && statSync(join(root, named)).isDirectory()) return join(root, named);
    }
  } catch { /* fall through */ }
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => /^gate-\d{4}-\d{2}-\d{2}T/.test(d)).sort();
  return dirs.length ? join(root, dirs[dirs.length - 1]) : null;
}

// --- transport (plain POSIX on the far side) -----------------------------
const sshArgs = (host, port, remoteCmd) =>
  ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...(port ? ["-p", String(port)] : []), host, remoteCmd];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Push one backup dir. Returns { code, message }; code 0 only when the
 *  remote checksum matched (prune failures still report code 6). */
export function pushLatest({ host, port, path, keep = 14, key: keyFile = DEFAULT_KEY, backup: backupDir, root }) {
  const dir = backupDir ?? latestBackup(root);
  if (!dir || !existsSync(dir)) return { code: 2, message: `no backup dir to push (${dir ?? "none found"})` };
  if (!statSync(dir).isDirectory()) return { code: 2, message: `not a directory: ${dir}` };
  const name = remoteName(dir);
  let key;
  try { key = loadKey(keyFile); } catch (e) { return { code: 3, message: e.message }; }
  const tarred = run("tar", ["czf", "-", "-C", dirname(dir), dir.split("/").pop()]);
  const plain = Buffer.from(tarred.stdout ?? "");
  if (tarred.status !== 0 || !plain.length) return { code: 4, message: `tar failed: ${String(tarred.stderr || "")}`.slice(0, 200) };
  const blob = encryptBlob(key, plain);
  const put = run("ssh", sshArgs(host, port, `mkdir -p '${path}' && cat > '${path}/${name}'`), { input: blob });
  if (put.status !== 0) return { code: 4, message: `ssh put failed: ${String(put.stderr || "")}`.slice(0, 200) };
  const sum = run("ssh", sshArgs(host, port, `sha256sum '${path}/${name}'`));
  const remote = String(sum.stdout ?? "").split(" ")[0];
  const local = sha256(blob);
  if (sum.status !== 0 || remote !== local) return { code: 5, message: `verify mismatch (local ${local.slice(0, 12)}…, remote ${String(remote).slice(0, 12)}…)` };
  let pruned = [];
  const list = run("ssh", sshArgs(host, port, `ls -1 '${path}'`));
  if (list.status === 0) {
    pruned = pruneKeep(String(list.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean), keep);
    if (pruned.length) {
      const rm = run("ssh", sshArgs(host, port, `rm -f ${pruned.map((v) => `'${path}/${v}'`).join(" ")}`));
      if (rm.status !== 0) return { code: 6, message: `pushed+verified, but prune failed: ${pruned.join(", ")}` };
    }
  }
  return { code: 0, message: `${name} ${blob.length}B sha256=${local.slice(0, 12)}… → ${host}:${path}${pruned.length ? ` (pruned ${pruned.length})` : ""}` };
}

/** Decrypt an archive back into a dir (the restore drill). */
export function decryptArchive({ inFile, outDir, key: keyFile = DEFAULT_KEY }) {
  mkdirSync(outDir, { recursive: true });
  const key = loadKey(keyFile);
  const tmp = mkdtempSync(join(tmpdir(), "gate-push-"));
  try {
    writeFileSync(join(tmp, "b.tgz"), decryptBlob(key, readFileSync(inFile)));
    const x = run("tar", ["xzf", join(tmp, "b.tgz"), "-C", outDir, "--strip-components=1"]);
    if (x.status !== 0) return { code: 4, message: `tar extract failed: ${String(x.stderr || "")}`.slice(0, 200) };
    return { code: 0, message: `decrypted ${inFile} → ${outDir}` };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// --- CLI ------------------------------------------------------------------
function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "export-key") {
      console.log(loadKey(arg("key") ?? DEFAULT_KEY).toString("base64"));
      return;
    }
    if (cmd === "decrypt") {
      const inFile = arg("in"), outDir = arg("out");
      if (!inFile || !outDir) return die(1, "decrypt needs --in <file.enc> --out <dir>");
      const r = decryptArchive({ inFile, outDir, key: arg("key") ?? DEFAULT_KEY });
      if (r.code !== 0) die(r.code, r.message);
      console.log(`gate-push: ${r.message}`);
      return;
    }
    if (cmd === "push" || cmd === "auto" || cmd === "check") {
      let cfg = { host: arg("to"), port: arg("port") ? Number(arg("port")) : 22, path: arg("path"), keep: arg("keep") ? Number(arg("keep")) : 14 };
      if (cmd === "auto") {
        if (!existsSync(CONFIG_PATH)) { console.error(`gate-push: no remote configured (skip). To enable: write ${CONFIG_PATH}`); return; }
        try { cfg = { port: 22, keep: 14, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; }
        catch (e) { return die(2, `bad config ${CONFIG_PATH}: ${e.message}`); }
      }
      if (!cfg.host || !cfg.path) return die(1, "need --to <user@host> and --path <remote-dir>");
      if (cmd === "check") {
        const list = run("ssh", sshArgs(cfg.host, cfg.port, `ls -1 '${cfg.path}'`));
        if (list.status !== 0) return die(4, "cannot list remote path");
        const names = String(list.stdout ?? "").split("\n").filter((n) => n.trim().endsWith(".enc")).map((s) => s.trim()).sort();
        if (!names.length) return die(2, "no encrypted backups on remote yet");
        console.log(names.join("\n"));
        return;
      }
      const r = pushLatest({ ...cfg, backup: arg("backup") });
      if (r.code !== 0) die(r.code, r.message);
      console.log(`gate-push: ${r.message}`);
      return;
    }
    die(1, "usage: gate-push.mjs push|auto|check|decrypt|export-key (see file header)");
  } catch (e) { die(3, e.message); }
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main();
