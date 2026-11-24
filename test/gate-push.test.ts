// G4 — gate-push: the nightly backup archive leaves the machine only as
// AES-256-GCM ciphertext ("HGP1" blob); the VPS is a courier, never a reader.
// A push counts only when the remote sha256 matches. These tests cover the
// crypto, the _latest pointer semantics of gate-backup.mjs, the exact ssh argv
// the transport builds, prune math, and the restore drill (decrypt → tar →
// byte-identical state). `auto` must be a no-op exit 0 until the owner writes
// the opt-in config — the nightly timer must stay green without a VPS.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  setRunnerForTests, loadKey, encryptBlob, decryptBlob,
  remoteName, pruneKeep, latestBackup, pushLatest, decryptArchive,
} from "../scripts/gate-push.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "gate-push.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "hg-gpush-"));
const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, env });
const mode = (p) => statSync(p).mode & 0o777;

function fakeBackup(root, name = "gate-2026-11-24T04-30-00-000Z") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, rooms: [{ id: "r_x" }] }));
  writeFileSync(join(dir, "ssh_host_ed25519.json"), JSON.stringify({ priv: "MATERIAL" }));
  chmodSync(join(dir, "ssh_host_ed25519.json"), 0o600);
  return dir;
}

test("gate-push: AEAD roundtrip, tamper and truncation are fatal", () => {
  const key = randomBytes(32);
  const plain = Buffer.from("state material \x00\xff repeated".repeat(100));
  const blob = encryptBlob(key, plain);
  assert.ok(blob.subarray(0, 4).equals(Buffer.from("HGP1")));
  assert.deepEqual(decryptBlob(key, blob), plain);
  const flipped = Buffer.from(blob); flipped[flipped.length - 1] ^= 1;
  assert.throws(() => decryptBlob(key, flipped), /auth|tag|decrypt/i);
  assert.throws(() => decryptBlob(key, blob.subarray(0, 20)), /magic or size/, "too short to even hold IV+tag");
  assert.throws(() => decryptBlob(key, Buffer.concat([Buffer.from("NOPE"), blob.subarray(4)])), /magic or size/);
});

test("gate-push: key file is created 0600 once, base64 form accepted", () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, "backup.key");
    const k1 = loadKey(keyFile);
    assert.equal(k1.length, 32);
    assert.equal(mode(keyFile), 0o600, "key must not be group/world readable");
    assert.deepEqual(loadKey(keyFile), k1, "stable across loads");
    const b64 = join(dir, "b64.key");
    writeFileSync(b64, k1.toString("base64"));
    assert.deepEqual(loadKey(b64), k1, "base64-encoded 32B key accepted");
    const bad = join(dir, "bad.key");
    writeFileSync(bad, "too-short");
    assert.throws(() => loadKey(bad), /32 bytes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-push: remoteName and prune math", () => {
  assert.equal(remoteName("/x/backups/gate-2026-11-24T04-30-00-000Z"), "gate-2026-11-24T04-30-00-000Z.tar.gz.enc");
  assert.throws(() => remoteName("/x/backups/whatever"), /not recognized/);
  const names = Array.from({ length: 16 }, (_, i) => `gate-2026-11-${String(10 + i).padStart(2, "0")}T00-00-00-000Z.tar.gz.enc`);
  assert.deepEqual(pruneKeep([...names, "state.json", "readme"], 14), names.slice(0, 2), "only the oldest .enc files, ignore junk");
  assert.deepEqual(pruneKeep(names, 99), []);
});

test("gate-push: _latest is a text pointer (gate-backup semantics), falls back to newest scan", () => {
  const root = tmp();
  try {
    fakeBackup(root, "gate-2026-11-22T00-00-00-000Z");
    fakeBackup(root, "gate-2026-11-23T00-00-00-000Z");
    fakeBackup(root, "gate-2026-11-24T00-00-00-000Z");
    writeFileSync(join(root, "_latest"), "gate-2026-11-22T00-00-00-000Z\n");
    assert.equal(latestBackup(root), join(root, "gate-2026-11-22T00-00-00-000Z"), "pointer wins over newer dirs");
    rmSync(join(root, "_latest"));
    assert.equal(latestBackup(root), join(root, "gate-2026-11-24T00-00-00-000Z"), "newest scan");
    const empty = join(root, "empty"); mkdirSync(empty);
    assert.equal(latestBackup(empty), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gate-push: pushLatest happy path — BatchMode ssh, ciphertext on the wire, checksum verified, restore drill", () => {
  const dir = tmp();
  try {
    const backupDir = fakeBackup(dir);
    const keyFile = join(dir, "k.key"); const key = loadKey(keyFile);
    const calls = []; let stored = null;
    setRunnerForTests(({ cmd, args, opts }) => {
      calls.push({ cmd, args, opts });
      if (cmd === "tar") return spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, ...opts });
      if (cmd === "ssh") {
        const remote = args.filter((a) => !a.startsWith("-")).join(" ");
        if (remote.includes("cat >")) { stored = Buffer.from(opts.input); return { status: 0, stdout: Buffer.alloc(0) }; }
        if (remote.includes("sha256sum")) return { status: 0, stdout: Buffer.from(`${createHash("sha256").update(stored).digest("hex")}  ${remote.split(" ").pop()}\n`) };
        if (remote.includes("ls -1")) return { status: 0, stdout: Buffer.from("gate-2026-11-24T04-30-00-000Z.tar.gz.enc\n") };
        if (remote.includes("rm -f")) return { status: 0, stdout: Buffer.alloc(0) };
      }
      return { status: 0, stdout: Buffer.alloc(0) };
    });
    try {
      const r = pushLatest({ host: "b@vps", port: 2222, path: "/srv/hb", key: keyFile, backup: backupDir });
      assert.equal(r.code, 0, r.message);
      assert.match(r.message, /gate-2026-11-24T04-30-00-000Z\.tar\.gz\.enc \d+B sha256=[0-9a-f]{12}… → b@vps:\/srv\/hb/);
      const put = calls.find((c) => c.cmd === "ssh" && c.args.join(" ").includes("cat >"));
      assert.ok(put, "must ssh-put the blob");
      assert.deepEqual(put.args.slice(0, 2), ["-o", "BatchMode=yes"], "unattended: never prompt");
      assert.ok(put.args.includes("2222"), "custom port passed");
      assert.ok(stored.subarray(0, 4).equals(Buffer.from("HGP1")), "wire carries ciphertext, never plaintext");
      assert.ok(!stored.includes(Buffer.from("MATERIAL")), "host-key material must not appear in the blob");
      // restore drill: the stored blob decrypts back to a byte-identical tree
      const enc = join(dir, "b.enc"); writeFileSync(enc, stored);
      const out = join(dir, "restored");
      const d = decryptArchive({ inFile: enc, outDir: out, key: keyFile });
      assert.equal(d.code, 0, d.message);
      assert.equal(readFileSync(join(out, "state.json"), "utf8"), readFileSync(join(backupDir, "state.json"), "utf8"));
      assert.equal(readFileSync(join(out, "ssh_host_ed25519.json"), "utf8"), readFileSync(join(backupDir, "ssh_host_ed25519.json"), "utf8"));
    } finally { setRunnerForTests(null); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-push: pushLatest failure classes — nothing to push, ssh down, checksum mismatch, prune failure", () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, "k.key"); loadKey(keyFile);
    assert.equal(pushLatest({ host: "b@vps", path: "/srv/hb", key: keyFile, backup: join(dir, "nope") }).code, 2);
    const backupDir = fakeBackup(dir, "gate-2026-11-25T00-00-00-000Z");
    setRunnerForTests(({ cmd, args, opts }) => {
      if (cmd === "tar") return spawnSync(cmd, args, { encoding: "buffer", ...opts });
      const remote = args.filter((a) => !a.startsWith("-")).join(" ");
      if (remote.includes("cat >")) return { status: 255, stderr: Buffer.from("connection refused") };
      return { status: 0, stdout: Buffer.alloc(0) };
    });
    try {
      assert.equal(pushLatest({ host: "b@vps", path: "/srv/hb", key: keyFile, backup: backupDir }).code, 4);
      setRunnerForTests(({ cmd, args, opts }) => {
        if (cmd === "tar") return spawnSync(cmd, args, { encoding: "buffer", ...opts });
        const remote = args.filter((a) => !a.startsWith("-")).join(" ");
        if (remote.includes("cat >")) return { status: 0, stdout: Buffer.alloc(0) };
        if (remote.includes("sha256sum")) return { status: 0, stdout: Buffer.from("deadbeef  x\n") }; // wrong hash
        return { status: 0, stdout: Buffer.alloc(0) };
      });
      assert.equal(pushLatest({ host: "b@vps", path: "/srv/hb", key: keyFile, backup: backupDir }).code, 5, "unverified push must not count");
      // prune: 16 on remote, keep 14 → rm the 2 oldest; rm failing is code 6 (push did land)
      let blob = null;
      setRunnerForTests(({ cmd, args, opts }) => {
        if (cmd === "tar") return spawnSync(cmd, args, { encoding: "buffer", ...opts });
        const remote = args.filter((a) => !a.startsWith("-")).join(" ");
        if (remote.includes("cat >")) { blob = Buffer.from(opts.input); return { status: 0, stdout: Buffer.alloc(0) }; }
        if (remote.includes("sha256sum")) return { status: 0, stdout: Buffer.from(`${createHash("sha256").update(blob).digest("hex")}  x\n`) };
        if (remote.includes("ls -1")) return {
          status: 0,
          stdout: Buffer.from(Array.from({ length: 15 }, (_, i) => `gate-2026-11-${String(1 + i).padStart(2, "0")}T00-00-00-000Z.tar.gz.enc`).join("\n") + "\ngate-2026-11-25T00-00-00-000Z.tar.gz.enc\n"),
        };
        if (remote.includes("rm -f")) return { status: 0, stdout: Buffer.alloc(0) };
        return { status: 0, stdout: Buffer.alloc(0) };
      });
      const ok = pushLatest({ host: "b@vps", path: "/srv/hb", key: keyFile, backup: backupDir });
      assert.equal(ok.code, 0, ok.message);
      assert.match(ok.message, /pruned 2/);
      setRunnerForTests(({ cmd, args, opts }) => {
        if (cmd === "tar") return spawnSync(cmd, args, { encoding: "buffer", ...opts });
        const remote = args.filter((a) => !a.startsWith("-")).join(" ");
        if (remote.includes("cat >")) { blob = Buffer.from(opts.input); return { status: 0, stdout: Buffer.alloc(0) }; }
        if (remote.includes("sha256sum")) return { status: 0, stdout: Buffer.from(`${createHash("sha256").update(blob).digest("hex")}  x\n`) };
        if (remote.includes("ls -1")) return { status: 0, stdout: Buffer.from("gate-2026-11-01T00-00-00-000Z.tar.gz.enc\ngate-2026-11-25T00-00-00-000Z.tar.gz.enc\n") };
        if (remote.includes("rm -f")) return { status: 1, stderr: Buffer.from("rm failed") };
        return { status: 0, stdout: Buffer.alloc(0) };
      });
      const prunedFail = pushLatest({ host: "b@vps", path: "/srv/hb", key: keyFile, backup: backupDir, keep: 1 });
      assert.equal(prunedFail.code, 6, "push landed + verified; only the prune failed — say so, do not report plain success");
      assert.match(prunedFail.message, /pushed\+verified/);
    } finally { setRunnerForTests(null); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-push: auto is a silent no-op exit 0 until the owner opts in (timer stays green without a VPS)", () => {
  const home = tmp();
  try {
    const r = cli(["auto"], { ...process.env, HERDGATE_PUSH_CONFIG: join(home, "backup-remote.json") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no remote configured/);
    assert.ok(!existsSync(join(home, "backup-remote.json")), "auto never writes the opt-in config itself");
    // with a config but an unreachable host the failure is loud (exit 4), never a silent green
    writeFileSync(join(home, "backup-remote.json"), JSON.stringify({ host: "nobody@127.0.0.1", port: 1, path: "/srv/x" }));
    fakeBackup(home);
    const bad = cli(["auto"], { ...process.env, HERDGATE_PUSH_CONFIG: join(home, "backup-remote.json"), HERDGATE_PUSH_KEY: join(home, "k.key"), HERDGATE_PUSH_BACKUPS: home });
    assert.equal(bad.status, 4, bad.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("gate-push: the CLI entry guard is alive — a bare invocation must speak, never exit 0 silently", () => {
  // Regression for the bug this file shipped with: a missing import made the
  // isMain guard throw, the catch turned it into `false`, and every CLI call
  // exited 0 without doing anything (the timer would have stayed green forever).
  const r = cli([]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /usage: gate-push\.mjs push\|auto\|check\|decrypt\|export-key/);
  const bogus = cli(["nope"]);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /usage:/);
});

test("gate-push: export-key prints base64 of the key file, nothing else", () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, "k.key");
    const key = loadKey(keyFile);
    const r = cli(["export-key", "--key", keyFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(Buffer.from(r.stdout.trim(), "base64").toString("hex"), key.toString("hex"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
