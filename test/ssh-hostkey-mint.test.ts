/**
 * A host key that does not parse must never be used — and never written to disk.
 *
 * ssh2 1.17.0's `utils.generateKeyPairSync("ed25519")` returns a malformed key about
 * 0.3% of the time: `lib/keygen.js` strips every leading 0x00 of the key as if it were
 * BIT STRING padding, and an ed25519 key may legitimately start with 0x00 (measured
 * 2026-11-24: 18 malformed in 3000 mints; the public key's length field reads 31).
 * `new Server({ hostKeys })` then throws, the SSH leg comes up null — and the bad key
 * has ALREADY been persisted, so every restart repeats it while the HTTP side still
 * answers 200. This was the "publickey auth … ECONNREFUSED 127.0.0.1:22" flake, roughly
 * one full suite in three.
 *
 * The rule lives where the key is born: validate with the same parser the server runs,
 * retry a malformed mint, refuse loudly when nothing valid comes, and on load refuse
 * with the restore message instead of a parser stack from inside ssh2.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ssh2Pkg from "ssh2";
import { startSshd, type SshConfig } from "../src/cloud/sshd.ts";
import { State } from "../src/cloud/stores.ts";

type Pair = { private: string; public: string };
const utils = (ssh2Pkg as unknown as { utils: { parseKey(key: string): unknown; generateKeyPairSync(type: string): Pair } }).utils;

/** The defect's exact shape: a real ed25519 public key with its first 0x00 byte gone (length 31). */
const BAD: Pair = {
  private: "not an openssh key",
  public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAH3LdUfgc3XfgWnJ00D9iArJYx3EMjNQgKjexn5exP1c=",
};
const realMint = () => utils.generateKeyPairSync("ed25519");
const parses = (k: string) => !(utils.parseKey(k) instanceof Error);

function deps(config: SshConfig, log: (line: string) => void = () => {}) {
  return { config, state: new State([{ id: "a1", name: "owner", token: "mint-account" }]), log, sendAsDevice: () => false, deviceOnline: () => false };
}

test("host key: a malformed mint is retried; only a key that parses reaches the disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-mint-"));
  const keyPath = join(dir, "hostkey.json");
  try {
    let calls = 0;
    const lines: string[] = [];
    const h = await startSshd(deps({ port: 0, keyPath, mintKey: () => (++calls === 1 ? BAD : realMint()) }, (l) => lines.push(l)));
    assert.ok(h, "the sshd came up after retrying the malformed mint");
    try {
      // The stand-in behind the mock is ssh2's real keygen, which carries the ~0.3% defect itself
      // (seen live once in a full suite): a second or third malformed mint is legitimate, the loop's
      // job is to keep going until a key parses — and never write one that does not.
      assert.ok(calls >= 2 && calls <= 8, `the malformed mint was thrown away and another taken (${calls} mints)`);
      assert.ok(lines.some((l) => /malformed/.test(l)), `the retry is on the record: ${JSON.stringify(lines)}`);
      const saved = JSON.parse(readFileSync(keyPath, "utf8")) as Pair;
      assert.ok(parses(saved.private), "the persisted private key parses with ssh2's own parser");
      assert.ok(parses(saved.public), "the persisted public key parses with ssh2's own parser");
      assert.match(h.hostKeyFingerprint ?? "", /^SHA256:/);
    } finally {
      await h.close();
    }

    // An existing, valid key is loaded — never re-minted.
    let mints = 0;
    const again = await startSshd(deps({ port: 0, keyPath, mintKey: () => (mints++, realMint()) }));
    assert.ok(again, "the sshd came up from the stored key");
    try {
      assert.equal(mints, 0, "loaded from disk, not re-minted");
      assert.equal(again.hostKeyFingerprint, h.hostKeyFingerprint, "same identity after restart");
    } finally {
      await again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host key: nothing valid after the retries ⇒ refuses loudly and persists nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-mint-"));
  const keyPath = join(dir, "hostkey.json");
  try {
    let calls = 0;
    await assert.rejects(
      startSshd(deps({ port: 0, keyPath, mintKey: () => (calls++, BAD) })),
      /cannot mint a valid ed25519 host key/,
      "the failure names what happened",
    );
    assert.ok(calls >= 2, `it retried before giving up (${calls} mints)`);
    assert.ok(!existsSync(keyPath), "a key that does not parse is never written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host key: a stored key that no longer parses ⇒ the restore message, file untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-mint-"));
  const keyPath = join(dir, "hostkey.json");
  try {
    writeFileSync(keyPath, JSON.stringify({ ...BAD, fingerprint: "SHA256:stale" }));
    await assert.rejects(
      startSshd(deps({ port: 0, keyPath, mintKey: () => assert.fail("must not mint over an existing key") })),
      /cannot load existing SSH host key.*restore it from backup/,
      "the operator is told what to do, not handed ssh2's parser stack",
    );
    assert.equal(JSON.parse(readFileSync(keyPath, "utf8")).fingerprint, "SHA256:stale", "the broken file is left for forensics");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
