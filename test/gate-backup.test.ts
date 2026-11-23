// C11d — gate-backup: the fleet's single point of failure is the gate state
// on the home machine (docs/plans/vps-cutover.md). A backup that cannot be
// verified is garbage, so every archive carries a sha256 manifest and the
// script can re-verify it byte for byte. Sensitive modes (the SSH host key)
// must survive the copy — restoring a world-readable host key trades one
// failure for another.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "gate-backup.mjs");

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, ...opts });

function synthGate(dir, { withOptional = true } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, rooms: [{ id: "r_test" }] }));
  writeFileSync(join(dir, "ssh_host_ed25519.json"), JSON.stringify({ priv: "MATERIAL" }));
  chmodSync(join(dir, "ssh_host_ed25519.json"), 0o600);
  if (withOptional) {
    writeFileSync(join(dir, "vapid.json"), JSON.stringify({ k: "v" }));
    mkdirSync(join(dir, "attachments"));
    writeFileSync(join(dir, "attachments", "a.bin"), "att");
    mkdirSync(join(dir, "pi-receipts"));
    writeFileSync(join(dir, "pi-receipts", "r.jsonl"), "rec");
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "t.json"), "{}");
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "hg-gbackup-"));
const mode = (p) => statSync(p).mode & 0o777;

test("gate-backup: full archive with manifest, sensitive mode preserved", () => {
  const dir = tmp();
  try {
    const state = join(dir, "gate", "state.json");
    synthGate(join(dir, "gate"));
    const out = join(dir, "backups");
    const r = run(["--state", state, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const archives = readFileSync(join(out, "_latest"), "utf8").trim(); // pointer for humans/scripts
    const arc = join(out, archives);
    assert.ok(existsSync(join(arc, "state.json")));
    assert.ok(existsSync(join(arc, "ssh_host_ed25519.json")));
    assert.ok(existsSync(join(arc, "vapid.json")));
    assert.ok(existsSync(join(arc, "attachments", "a.bin")));
    assert.ok(existsSync(join(arc, "pi-receipts", "r.jsonl")));
    assert.ok(existsSync(join(arc, "tasks", "t.json")));
    // The host key is private material — the copy must not relax its mode.
    assert.equal(mode(join(arc, "ssh_host_ed25519.json")), 0o600, "host key copy stays 0600");
    const manifest = JSON.parse(readFileSync(join(arc, "manifest.json"), "utf8"));
    for (const name of ["state.json", "ssh_host_ed25519.json", "vapid.json", "attachments", "pi-receipts", "tasks"]) {
      assert.ok(manifest.entries[name]?.present === true, `manifest lists ${name}`);
      assert.match(manifest.entries[name].sha256, /^[0-9a-f]{64}$/);
    }
    // The manifest describes the ARCHIVED copy (what a restore would use),
    // not the live source — pinned after a real race: pi-receipts kept
    // changing under a source-side digest while the gate was serving.
    const archivedState = readFileSync(join(arc, "state.json"));
    assert.equal(manifest.entries["state.json"].sha256, createHash("sha256").update(archivedState).digest("hex"),
      "manifest sha256 is the digest of the archived bytes");
    // And the archive verifies clean right after being written.
    assert.equal(run(["--verify", arc]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-backup: retention keeps the newest N, prunes the oldest", () => {
  const dir = tmp();
  try {
    const gate = join(dir, "gate");
    synthGate(gate);
    const out = join(dir, "backups");
    for (let i = 0; i < 3; i++) {
      assert.equal(run(["--state", join(gate, "state.json"), "--out", out, "--keep", "2"]).status, 0, `backup ${i}`);
    }
    const kept = readdirSync(out).filter((n) => n.startsWith("gate-"));
    assert.equal(kept.length, 2, "--keep 2 keeps exactly two archives");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-backup: verify catches a single flipped byte", () => {
  const dir = tmp();
  try {
    const gate = join(dir, "gate");
    synthGate(gate);
    const out = join(dir, "backups");
    assert.equal(run(["--state", join(gate, "state.json"), "--out", out]).status, 0);
    const arc = join(out, readFileSync(join(out, "_latest"), "utf8").trim());
    writeFileSync(join(arc, "state.json"), JSON.stringify({ v: 1, rooms: [{ id: "tampered" }] }));
    const bad = run(["--verify", arc]);
    assert.equal(bad.status, 1, "a tampered archive must fail verification");
    assert.match(bad.stdout + bad.stderr, /state\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate-backup: optional artifacts absent is fine, missing state.json is not", () => {
  const dir = tmp();
  try {
    const gate = join(dir, "gate");
    synthGate(gate, { withOptional: false });
    const out = join(dir, "backups");
    const r = run(["--state", join(gate, "state.json"), "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const arc = join(out, readFileSync(join(out, "_latest"), "utf8").trim());
    const manifest = JSON.parse(readFileSync(join(arc, "manifest.json"), "utf8"));
    assert.equal(manifest.entries["vapid.json"].present, false, "absence is recorded, not faked");
    assert.ok(!existsSync(join(arc, "vapid.json")));

    const noState = run(["--state", join(dir, "nowhere", "state.json"), "--out", out]);
    assert.equal(noState.status, 2, "no state.json is a usage error, not an empty backup");
    assert.match(noState.stderr, /state\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
