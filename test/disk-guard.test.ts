// The dev-loop timer must not spend a cycle on a disk that is nearly full:
// scripts/disk-guard.sh is its systemd ExecCondition (exit 1 = skipped, not failed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const GUARD = join(import.meta.dirname, "..", "scripts", "disk-guard.sh");

const run = (pct: string | undefined, limit?: string) =>
  spawnSync("bash", [GUARD, "/home", ...(limit ? [limit] : [])], {
    encoding: "utf8",
    env: { ...process.env, HG_DISK_PCT_FOR_TEST: pct ?? "" },
  });

test("disk-guard: below the limit lets the cycle run", () => {
  const r = run("89");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /disk-guard: \/home 89% < 90%/);
});

test("disk-guard: at the limit skips (the threshold is inclusive)", () => {
  const r = run("90");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /disk-guard: \/home 90% ≥ 90% — skipping/);
});

test("disk-guard: above the limit skips", () => {
  assert.equal(run("91").status, 1);
  assert.equal(run("100").status, 1);
});

test("disk-guard: the limit is an argument", () => {
  assert.equal(run("50", "50").status, 1);
  assert.equal(run("49", "50").status, 0);
});

test("disk-guard: without the test override it reads df and answers 0 or 1 with a percentage", () => {
  const r = run(undefined);
  assert.ok(r.status === 0 || r.status === 1, r.stderr + r.stdout);
  const text = r.status === 0 ? r.stdout : r.stderr;
  assert.match(text, /disk-guard: \/home \d+% (≥|<) 90%/);
});

test("disk-guard: a garbage limit fails closed (exit 2), never a silent default", () => {
  const r = run("10", "abc");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /limit 'abc' is not a whole number/);
});

test("disk-guard: a usage that cannot be read fails closed (exit 2) instead of running on", () => {
  const r = spawnSync("bash", [GUARD, "/no/such/path-xyz", "90"], {
    encoding: "utf8",
    env: { ...process.env, HG_DISK_PCT_FOR_TEST: "" },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read the usage of \/no\/such\/path-xyz/);
});
