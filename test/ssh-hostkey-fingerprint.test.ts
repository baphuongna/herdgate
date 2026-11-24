/**
 * The host key fingerprint the sshd reports must be the one OpenSSH prints.
 *
 * `fingerprintOf` was written for PEM ("-----BEGIN PUBLIC KEY-----" / base64 lines / footer):
 * strip the first and last line, join, hash. The key ssh2 mints is an authorized_keys line
 * instead — `ssh-ed25519 <base64>` — where nothing gets stripped, so the algorithm name was
 * glued onto the base64 before hashing. Caught 2026-11-24 on the production key: the gate's
 * file said SHA256:ER5U4j…, `ssh-keygen -lf` said SHA256:OCMQlB…. Nothing downstream compared
 * the two (the PWA does not show it), so it never bit — but a wrong security value on the
 * record is a bug even when nobody is looking.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import ssh2Pkg from "ssh2";
import { startSshd } from "../src/cloud/sshd.ts";
import { State } from "../src/cloud/stores.ts";

type Pair = { private: string; public: string };
const generate = (ssh2Pkg as unknown as { utils: { generateKeyPairSync(type: string): Pair } }).utils.generateKeyPairSync;

/** SHA256 of the SSH public blob — the definition behind `ssh-keygen -lf`'s second column. */
const openSshFingerprint = (publicLine: string): string =>
  "SHA256:" + createHash("sha256").update(Buffer.from(publicLine.trim().split(/\s+/)[1], "base64")).digest("base64").replace(/=+$/, "");

test("host key fingerprint: what ssh-keygen -lf prints, not a hash of the algorithm name", async () => {
  const pair = generate("ed25519");
  assert.match(pair.public, /^ssh-ed25519 [A-Za-z0-9+/=]+$/, "ssh2 mints an authorized_keys line");
  const h = await startSshd({
    config: { port: 0, mintKey: () => pair },
    state: new State([{ id: "a1", name: "owner", token: "fp-account" }]),
    log: () => {},
    sendAsDevice: () => false,
    deviceOnline: () => false,
  });
  try {
    assert.ok(h, "the sshd came up");
    assert.equal(h.hostKeyFingerprint, openSshFingerprint(pair.public), "same value as the SHA256 of the public blob");
  } finally {
    await h?.close();
  }

  // Cross-check with the tool operators actually use, when it is on this machine.
  const dir = mkdtempSync(join(tmpdir(), "herdgate-fp-"));
  try {
    writeFileSync(join(dir, "k.pub"), pair.public);
    const lf = spawnSync("ssh-keygen", ["-lf", join(dir, "k.pub")], { encoding: "utf8" });
    if (lf.status === 0) {
      const reported = lf.stdout.trim().split(/\s+/)[1];
      assert.equal(h?.hostKeyFingerprint, reported, "byte-for-byte what ssh-keygen prints");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
