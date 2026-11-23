// C18 — cycle audit: the loop's guardrails ("no publish/tag", "no version
// bump", "no token in output") become a MECHANISM: after each settled cycle
// the git history of cfg.cwd is compared against the rules, the result lands
// in loop.log, and a violation stops the nudges (auditHold) until the owner
// resumes. Direct auditWindow tests below use a throwaway git repo.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditWindow } from "../plugin/loop/server/audit.mjs";

const ROOT = join(import.meta.dirname, "..");
const INDEX = join(ROOT, "plugin", "loop", "server", "index.mjs");

// ---- temp git repo ---------------------------------------------------------

function git(args, cwd, env = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** A throwaway repo with a clean root commit (package.json v1.0.0). */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(join(dir, "notes.md"), "hello\n");
  git(["init", "-q"], dir);
  git(["add", "."], dir);
  const c = git(["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", "init"], dir);
  assert.equal(c.status, 0, c.stderr);
  return dir;
}

/** Commit AFTER `since` is taken: the window [since, now] must contain it. */
function commitInWindow(dir, files, message, env = {}) {
  const c = git(["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", message], dir, env);
  assert.equal(c.status, 0, c.stderr);
  return git(["rev-parse", "HEAD"], dir).stdout.trim();
}

// ---- harness (same shape as loop-plugin.test.ts) ---------------------------

function stubHerdr(dir, replies) {
  const bin = join(dir, `herdr-stub-${Math.random().toString(36).slice(2)}.mjs`);
  const calls = join(dir, "calls.log");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl === -1) return;
  const req = JSON.parse(buf.slice(0, nl));
  appendFileSync(${JSON.stringify(calls)}, req.method + " " + JSON.stringify(req.params) + "\\n");
  const map = ${JSON.stringify(JSON.stringify(replies))};
  const r = JSON.parse(map)[req.method] ?? { result: {} };
  process.stdout.write(JSON.stringify({ id: req.id, ...r }) + "\\n");
  process.exit(0);
});
`);
  return { bin, calls };
}

function run(dir, argv, { event, config, state, bin } = {}) {
  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (config !== undefined) writeFileSync(join(configDir, "loop.json"), JSON.stringify(config));
  else rmSync(join(configDir, "loop.json"), { force: true });
  if (state !== undefined) writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
  else rmSync(join(stateDir, "state.json"), { force: true });
  const { bin: defaultBin } = stubHerdr(dir, argv.stubReplies ?? {});
  const child = spawnSync(process.execPath, [INDEX, ...argv.cmd], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: bin ?? defaultBin,
      HOME: dir, // cwd-under-home validation sees the sandbox as home
      ...(event ? { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event) } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const callsFile = join(dir, "calls.log");
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean) : [];
  if (existsSync(callsFile)) rmSync(callsFile);
  return { code: child.status, stdout: child.stdout, stderr: child.stderr, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), "hg-audit-"));

// ---- auditWindow: direct ---------------------------------------------------

test("audit: a clean window is ok with no violations", () => {
  const dir = tmp();
  try {
    gitRepo(dir);
    const r = auditWindow({ cwd: dir, since: Date.now() - 60_000, until: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.violations, []);
    assert.ok(r.commits.length >= 1, "the root commit is seen");
    assert.deepEqual(r.tags, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit: a version bump in package.json is a version-bump violation", () => {
  const dir = tmp();
  try {
    gitRepo(dir);
    const since = Date.now() - 1500;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "2.0.0" }, null, 2) + "\n");
    git(["add", "."], dir);
    const sha = commitInWindow(dir, [], "bump: 1.0.0 -> 2.0.0");
    const r = auditWindow({ cwd: dir, since, until: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const bumps = r.violations.filter((v) => v.rule === "version-bump");
    assert.equal(bumps.length, 1, JSON.stringify(r.violations));
    assert.equal(bumps[0].sha, sha);
    assert.equal(bumps[0].subject, "bump: 1.0.0 -> 2.0.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit: a tag created inside the window is a tag violation", () => {
  const dir = tmp();
  try {
    gitRepo(dir);
    const since = Date.now() - 1500;
    const tagDate = `@${Math.floor(Date.now() / 1000)} +0000`; // creatordate lands in the window
    const t = git(["tag", "-a", "v9.9.9-probe", "-m", "probe tag"], dir, { GIT_COMMITTER_DATE: tagDate });
    assert.equal(t.status, 0, t.stderr);
    const r = auditWindow({ cwd: dir, since, until: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const tags = r.violations.filter((v) => v.rule === "tag");
    assert.equal(tags.length, 1, JSON.stringify(r.violations));
    assert.equal(tags[0].name, "v9.9.9-probe");
    assert.ok(r.tags.some((x) => x.name === "v9.9.9-probe"), "the in-window tag is listed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit: a committed token is a token violation and the secret never leaks", () => {
  const dir = tmp();
  try {
    gitRepo(dir);
    const since = Date.now() - 1500;
    const secret = "HERDGATE_ACCOUNT_TOKEN=abcdefgh12345";
    writeFileSync(join(dir, "notes.md"), `hello\n${secret}\n`);
    git(["add", "."], dir);
    const sha = commitInWindow(dir, [], "add token line");
    const r = auditWindow({ cwd: dir, since, until: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const leaks = r.violations.filter((v) => v.rule === "token");
    assert.equal(leaks.length, 1, JSON.stringify(r.violations));
    assert.equal(leaks[0].sha, sha);
    assert.equal(typeof leaks[0].line, "number", "violation carries the line number, not the value");
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes("abcdefgh12345"), "the token value must never appear in audit output");
    assert.ok(!dump.includes("HERDGATE_ACCOUNT_TOKEN"), "the raw matched line must never appear either");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit: token-shaped lines in tests/fixtures/docs are fixtures, not leaks — counted and skipped, code is still caught", () => {
  // Caught live before the first real audit run: C18's own test fixture
  // (`HERDGATE_ACCOUNT_TOKEN=abcdefgh12345` in test/) and its spec example
  // would have held the dev-loop on its very first cycle. Fake secrets are the
  // nature of tests and prose; the rule guards code and config.
  const dir = tmp();
  try {
    gitRepo(dir);
    const since = Date.now() - 1500;
    const secret = "HERDGATE_ROOM_TOKEN=fixture-token-1234";
    for (const f of ["test/fixtures/sample.env", "docs/runbook.md", "experiments/probe.mjs", "scripts/deploy.sh"]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), `${secret}\n`);
    }
    git(["add", "."], dir);
    commitInWindow(dir, [], "token lines in four kinds of files");
    const r = auditWindow({ cwd: dir, since, until: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const leaks = r.violations.filter((v) => v.rule === "token");
    assert.equal(leaks.length, 1, `only scripts/deploy.sh is a violation: ${JSON.stringify(r.violations)}`);
    assert.equal(leaks[0].file, "scripts/deploy.sh");
    assert.equal(r.skipped, 3, "the three fixture/prose lines are counted, not silently dropped");
    assert.ok(!JSON.stringify(r).includes("fixture-token-1234"), "the value never appears in audit output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit: a cwd that is not a git repo fails honestly, error <= 120 chars", () => {
  const dir = tmp();
  try {
    const r = auditWindow({ cwd: dir, since: Date.now() - 60_000, until: Date.now() });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0 && r.error.length <= 120, JSON.stringify(r));
    assert.match(r.error, /git|repositor/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- cmdEvent integration --------------------------------------------------

test("loop event: a violation holds the loop — no nudge, auditHold set, AUDIT VIOLATION logged", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const repo = gitRepo(join(dir, "repo"));
    const since = Date.now() - 1500;
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "probe", version: "9.9.9" }, null, 2) + "\n");
    git(["add", "."], repo);
    commitInWindow(repo, [], "bump: 1.0.0 -> 9.9.9");

    const r = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, {
      config: { v: 1, label: "probe", promptFile: join(dir, "prompt.md"), cwd: repo, cooldownMs: 10_000, maxCycles: 0 },
      state: { paneId: "wA:p1", status: "running", armed: true, cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "idle" } },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls, [], "a held loop must not touch the bridge — no pane.send_text");
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.ok(Array.isArray(st.auditHold?.rules) && st.auditHold.rules.includes("version-bump"), JSON.stringify(st));
    assert.ok(typeof st.auditHold.at === "number");
    assert.equal(st.cycles, 0, "the hold is not a cycle");
    assert.ok(typeof st.lastAuditAt === "number", "the audited window is recorded");
    assert.match(readFileSync(join(dir, "state", "loop.log"), "utf8"), /AUDIT VIOLATION version-bump/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop resume clears auditHold; status exposes lastAuditAt + auditHold", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const held = { paneId: "wA:p1", workspaceId: "w7", status: "running", paused: true, cycles: 1, lastAuditAt: 1234, auditHold: { rules: ["tag", "token"], at: 5678 } };

    const res = run(dir, { cmd: ["resume"] }, { state: held });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /"paused":false/);
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal("auditHold" in st, false, "resume means the owner reviewed it — hold gone");
    assert.equal(st.paused, false);
    assert.equal(st.lastAuditAt, 1234, "resume must not unsee the audited window");

    const s = run(dir, { cmd: ["status"], stubReplies: { "pane.list": { result: { panes: [] } } } }, { state: st });
    const j = JSON.parse(s.stdout);
    assert.equal(j.state.lastAuditAt, 1234);
    assert.equal(j.state.auditHold, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
