// Tests for windows/update-policy.mjs and the safe direct-run flow of
// windows/npm-update.mjs (herdr-updater lessons: never guess versions, never
// downgrade, append-only history, notify by default).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The policy module is plain ESM without sibling type declarations.
declare module "*.mjs";

import { appendHistory, compareVersions, parseVersion, policyFromEnv, relation } from "../windows/update-policy.mjs";

const repo = join(import.meta.dirname, "..");
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

test("parseVersion returns precedence parts or null, never a guess", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("0.10.0"), { major: 0, minor: 10, patch: 0, prerelease: [] });
  assert.deepEqual(parseVersion("0.9.0-rc.1"), { major: 0, minor: 9, patch: 0, prerelease: ["rc", "1"] });
  assert.equal(parseVersion("x.y"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("01.2.3"), null);
  assert.equal(parseVersion("v1.2.3"), null);
});

test("compareVersions: 0.10.0>0.9.0, 0.9.0>0.9.0-rc.1, equality, prerelease order, null on junk", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "numeric fields, not lexical");
  assert.equal(compareVersions("0.9.0", "0.9.0-rc.1"), 1, "a release outranks its prerelease");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1, "more prerelease fields rank higher");
  assert.equal(compareVersions("1.0.0-2", "1.0.0-10"), -1, "numeric prerelease identifiers compare numerically");
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "numeric identifiers sort below alphanumeric");
  assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0, "build metadata never affects precedence");
  assert.equal(compareVersions("x.y", "1.0.0"), null);
  assert.equal(compareVersions("", "1.0.0"), null);
  assert.equal(compareVersions("1.0.0", "x.y"), null);
});

test("relation labels same, behind, ahead and unknown (never 'current')", () => {
  assert.equal(relation("0.9.37", "0.9.37"), "same");
  assert.equal(relation("0.9.37", "0.9.38"), "behind");
  assert.equal(relation("0.9.38", "0.9.37"), "ahead");
  assert.equal(relation("0.9.38", "0.9.38-rc.1"), "ahead", "a release outranks its own prerelease");
  assert.equal(relation("tui-0000000000000000", "0.9.38"), "unknown");
  assert.equal(relation("0.9.37", ""), "unknown");
  assert.equal(relation(null, "0.9.38"), "unknown");
});

test("policyFromEnv fails closed to notify", () => {
  assert.equal(policyFromEnv({}), "notify", "a missing policy means notify");
  assert.equal(policyFromEnv({ HERDGATE_UPDATE_POLICY: "auto" }), "auto");
  assert.equal(policyFromEnv({ HERDGATE_UPDATE_POLICY: "yes" }), "notify", "strange values fail closed");
  assert.equal(policyFromEnv({ HERDGATE_UPDATE_POLICY: "AUTO" }), "notify");
  assert.equal(policyFromEnv({ HERDGATE_UPDATE_POLICY: "" }), "notify");
  assert.equal(policyFromEnv(undefined), "notify");
});

test("appendHistory appends JSONL without ever overwriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "hg update history "));
  try {
    appendHistory(dir, { from: "0.9.37", to: "0.9.38", relation: "behind", action: "checked", at: "2026-01-01T00:00:00.000Z" });
    const firstLine = readFileSync(join(dir, "update-history.jsonl"), "utf8").trim();
    const first = JSON.parse(firstLine);
    assert.equal(first.at, "2026-01-01T00:00:00.000Z");
    assert.equal(first.from, "0.9.37");
    assert.equal(first.to, "0.9.38");
    assert.equal(first.relation, "behind");
    assert.equal(first.action, "checked");
    assert.ok(first.host, "the host is recorded");

    appendHistory(dir, { from: "0.9.38", to: "0.9.39", relation: "behind", action: "updated" });
    const lines = readFileSync(join(dir, "update-history.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "two appends produce two lines");
    assert.equal(lines[0], firstLine, "the first line is untouched");
    const second = JSON.parse(lines[1]);
    assert.equal(second.action, "updated");
    assert.equal(second.from, "0.9.38");
    assert.equal(second.to, "0.9.39");
    assert.ok(second.at, "a timestamp is recorded when none is given");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- end-to-end: the direct-run updater ----

/** A disposable copy of windows/ plus a fake npm on PATH that only logs its invocations. */
function updaterFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "hg safe update "));
  const home = join(tmp, "home");
  cpSync(join(repo, "windows"), join(home, "windows"), { recursive: true });
  const npmBin = join(tmp, "npm-bin");
  mkdirSync(npmBin);
  const log = join(tmp, "npm-calls.log");
  writeFileSync(join(npmBin, "npm"), "#!/bin/sh\n[ -n \"$HG_NPM_LOG\" ] && printf '%s\\n' \"$*\" >> \"$HG_NPM_LOG\"\nexit 0\n");
  chmodSync(join(npmBin, "npm"), 0o755);
  const state = join(tmp, "state");
  const env: Record<string, string | undefined> = { ...process.env } as Record<string, string | undefined>;
  delete env.HERDGATE_UPDATE_POLICY;
  delete env.HERDGATE_UPDATE_CHECKOUT;
  delete env.HERDGATE_UPDATE_INSTALLED;
  delete env.HERDGATE_UPDATE_LATEST;
  delete env.LOCALAPPDATA;
  env.PATH = `${npmBin}:${env.PATH ?? ""}`;
  env.HG_NPM_LOG = log;
  env.HERDGATE_UPDATE_STATE_DIR = state;
  const run = (extra: Record<string, string | undefined>) => {
    const child: Record<string, string | undefined> = { ...env };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete child[key];
      else child[key] = value;
    }
    return spawnSync(process.execPath, [join(home, "windows", "npm-update.mjs")], { env: child as NodeJS.ProcessEnv, encoding: "utf8" });
  };
  const history = () => {
    const file = join(state, "update-history.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, never>)
      : [];
  };
  const npmCalls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { tmp, home, run, history, npmCalls };
}

test("npm updater defaults to notify: report only, no install, one 'checked' history line", () => {
  const f = updaterFixture();
  try {
    const result = f.run({ HERDGATE_UPDATE_INSTALLED: "0.9.37", HERDGATE_UPDATE_LATEST: "0.9.38" });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout ?? "";
    assert.match(out, /installed: 0\.9\.37/);
    assert.match(out, /latest:\s+0\.9\.38/);
    assert.match(out, /relation:\s+behind/);
    assert.match(out, /plan:/);
    assert.deepEqual(f.npmCalls(), [], "notify must not invoke npm at all");
    const history = f.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].action, "checked");
    assert.equal(history[0].relation, "behind");
    assert.equal(history[0].from, "0.9.37");
    assert.equal(history[0].to, "0.9.38");
    assert.ok(history[0].at);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("auto policy installs exactly once when behind and records 'updated'", () => {
  const f = updaterFixture();
  try {
    const result = f.run({ HERDGATE_UPDATE_POLICY: "auto", HERDGATE_UPDATE_INSTALLED: "0.9.37", HERDGATE_UPDATE_LATEST: "0.9.38" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout ?? "", /updated:\s+0\.9\.37 -> 0\.9\.38/);
    const calls = f.npmCalls();
    const installs = calls.filter((call) => call.includes("install"));
    assert.equal(installs.length, 1, "exactly one npm install");
    assert.ok(installs[0].includes("@bom0792/herdgate@latest"));
    assert.ok(installs[0].includes("--ignore-scripts"), "install hooks stay disabled");
    const history = f.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].action, "updated");
    assert.equal(history[0].from, "0.9.37");
    assert.equal(history[0].to, "0.9.38");
    assert.equal(history[0].relation, "behind");
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("auto policy holds ahead versions without calling npm", () => {
  const f = updaterFixture();
  try {
    const result = f.run({ HERDGATE_UPDATE_POLICY: "auto", HERDGATE_UPDATE_INSTALLED: "0.9.40", HERDGATE_UPDATE_LATEST: "0.9.38" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout ?? "", /held — applying would be a downgrade\/no-op/);
    assert.match(result.stdout ?? "", /relation:\s+ahead/);
    assert.deepEqual(f.npmCalls(), [], "a downgrade must never install");
    const history = f.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].action, "held");
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("an unparsable version is an error (exit 1), never 'current', never updated", () => {
  const f = updaterFixture();
  try {
    const result = f.run({ HERDGATE_UPDATE_INSTALLED: "0.9.37", HERDGATE_UPDATE_LATEST: "banana-pie" });
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /cannot compare/);
    assert.match(result.stderr ?? "", /refusing to guess/);
    assert.deepEqual(f.npmCalls(), []);
    assert.deepEqual(f.history(), [], "nothing is recorded when the relation is unknown");
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("git checkout applies only a fast-forward from an upstream that contains HEAD", { skip: !gitAvailable && "git is not available" }, () => {
  const f = updaterFixture();
  const checkout = join(f.tmp, "checkout");
  const gitIn = (args: string[]) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  const commit = (message: string) => {
    writeFileSync(join(checkout, "f.txt"), `${message}\n`);
    assert.equal(gitIn(["add", "-A"]).status, 0);
    assert.equal(gitIn(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]).status, 0);
    return gitIn(["rev-parse", "HEAD"]).stdout.trim();
  };
  const head = () => gitIn(["rev-parse", "HEAD"]).stdout.trim();
  const update = (extra: Record<string, string | undefined>) => f.run({ HERDGATE_UPDATE_CHECKOUT: checkout, ...extra });
  try {
    mkdirSync(checkout, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", checkout]).status, 0);
    assert.equal(gitIn(["symbolic-ref", "HEAD", "refs/heads/main"]).status, 0);
    const shaA = commit("a");

    // No upstream configured yet: linked, held even in auto.
    const linked = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(linked.stdout ?? "", /relation:\s+linked/);
    assert.match(linked.stdout ?? "", /held/);
    assert.equal(head(), shaA);

    // Upstream equals HEAD: same, held as a no-op.
    assert.equal(gitIn(["update-ref", "refs/remotes/origin/main", shaA]).status, 0);
    assert.equal(gitIn(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]).status, 0);
    assert.equal(gitIn(["config", "branch.main.remote", "origin"]).status, 0);
    assert.equal(gitIn(["config", "branch.main.merge", "refs/heads/main"]).status, 0);
    const same = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.match(same.stdout ?? "", /relation:\s+same/);
    assert.match(same.stdout ?? "", /held/);
    assert.equal(head(), shaA);

    // A local commit ahead of upstream: downgrade guard, held.
    const shaB = commit("b");
    const ahead = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.match(ahead.stdout ?? "", /relation:\s+ahead/);
    assert.match(ahead.stdout ?? "", /held — applying would be a downgrade\/no-op/);
    assert.equal(head(), shaB);

    // Build an upstream commit that CONTAINS HEAD (C on top of B), then park HEAD back on B.
    const shaC = commit("c");
    assert.equal(gitIn(["reset", "-q", "--hard", shaB]).status, 0);
    assert.equal(gitIn(["update-ref", "refs/remotes/origin/main", shaC]).status, 0);
    assert.equal(head(), shaB);

    // Default notify: report the fast-forward plan, change nothing, record 'checked'.
    const notify = update({});
    assert.equal(notify.status, 0, notify.stderr);
    assert.match(notify.stdout ?? "", /relation:\s+behind/);
    assert.match(notify.stdout ?? "", /plan:/);
    assert.equal(head(), shaB, "notify must not touch the checkout");
    const checked = f.history().filter((entry) => entry.action === "checked");
    assert.equal(checked.length, 1);
    assert.equal(checked[0].relation, "behind");
    assert.equal(checked[0].from, shaB);
    assert.equal(checked[0].to, shaC);

    // Auto: fast-forward only, recorded as 'updated'.
    const applied = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(head(), shaC, "fast-forwards to the upstream commit");
    assert.match(readFileSync(join(checkout, "f.txt"), "utf8"), /c/);
    const updated = f.history().filter((entry) => entry.action === "updated");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].from, shaB);
    assert.equal(updated[0].to, shaC);

    // Diverged upstream: a sibling commit must not be merged.
    assert.equal(gitIn(["checkout", "-q", "-b", "side", shaB]).status, 0);
    const shaD = commit("d");
    assert.equal(gitIn(["checkout", "-q", "main"]).status, 0);
    assert.equal(gitIn(["update-ref", "refs/remotes/origin/main", shaD]).status, 0);
    const diverged = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.match(diverged.stdout ?? "", /relation:\s+diverged/);
    assert.match(diverged.stdout ?? "", /held/);
    assert.equal(head(), shaC);

    // Detached HEAD: pinned, held.
    assert.equal(gitIn(["checkout", "-q", "--detach", shaB]).status, 0);
    const pinned = update({ HERDGATE_UPDATE_POLICY: "auto" });
    assert.match(pinned.stdout ?? "", /relation:\s+pinned/);
    assert.match(pinned.stdout ?? "", /held/);
    assert.equal(head(), shaB);

    // The git path never shells out to npm.
    assert.deepEqual(f.npmCalls(), []);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});
