// dev.herdgate.loop — cycle audit: the loop's guardrails ("no publish/tag",
// "no version bump", "no token in output") compared against the git history
// of cfg.cwd after each settled cycle.
//
// Read-only by construction: only `log`, `for-each-ref` and `diff-tree` are
// ever spawned (no hooks can fire — read-only ops; GIT_OPTIONAL_LOCKS=0 so
// the index is never locked), the env is scrubbed git-safe style (no GIT_*
// injection, GIT_CONFIG_NOSYSTEM=1) and the total budget is 30s with 10s
// per command. Every failure is `{ ok:false, error }` with the error trimmed
// to 120 chars; a git failure is NOT evidence of a violation, so callers may
// fail-open on it.
//
// Token violations carry ONLY the commit sha and the new-file line number —
// the matched line (the secret) is never echoed anywhere. Raw git stdout is
// parsed and discarded; auditWindow returns structured violations only.
//
// Self-contained: imports only node:* (no CLI — index.mjs drives it).
import { spawnSync } from "node:child_process";

const PER_COMMAND_TIMEOUT_MS = 10_000;
const TOTAL_BUDGET_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ERROR = 120;

// Files a version bump is forbidden in (loop rule 2b: no per-cycle bumps).
const VERSION_FILES = [
  "package.json",
  "plugin/herdr-plugin.toml",
  "plugin/mirror/herdr-plugin.toml",
  "plugin/loop/herdr-plugin.toml",
];
const VERSION_JSON_RE = /^[-+]\s*"version"\s*:/;
const VERSION_TOML_RE = /^[-+]version\s*=/;
// Secrets that must never be committed. Matched on ADDED lines only.
const TOKEN_RE = /HERDGATE_(ACCOUNT|ROOM|BRIDGE)_TOKEN\s*=\s*\S{8,}/;
const DEVICE_SECRET_RE = /"deviceSecret"\s*:\s*"[^"]{8,}"/;
// `@@ -a,b +c,d @@` — c is where the new file continues.
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const SHA_LINE_RE = /^[0-9a-f]{40}$/;

const shortErr = (m) => String(m).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);

// Child env for every git run — the git-safe scrub plus the system-config
// ban. PATH/HOME survive (git must be findable); every other GIT_* variable
// of the caller's environment never crosses the boundary.
function gitEnv() {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
  return env;
}

// epoch-ms → git's unambiguous UTC date form (ISO 8601 shapes also parse, but
// this one has no punctuation git's approxidate could trip on).
function gitDate(t) {
  const n = Number(t);
  const d = new Date(Number.isFinite(n) ? n : 0);
  const pad = (x, w = 2) => String(x).padStart(w, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** One read-only git command, bounded by the remaining audit budget. */
function gitRun(args, cwd, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, error: "audit budget exhausted (30s)" };
  let r;
  try {
    r = spawnSync("git", ["-C", cwd, ...args], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: Math.min(PER_COMMAND_TIMEOUT_MS, left),
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: shortErr(e?.message ?? "git spawn failed") };
  }
  if (r.error) return { ok: false, error: shortErr(r.error.message) };
  if (r.status !== 0) return { ok: false, error: shortErr((r.stderr || `git exited ${r.status}`).trim()) };
  return { ok: true, stdout: r.stdout ?? "" };
}

/**
 * Audit the git window [since, until] of `cwd` against the loop guardrails.
 * @returns {{ok:true, commits:{sha,subject}[], tags:{name,at}[], violations:object[]}
 *          | {ok:false, error:string}}
 */
export function auditWindow({ cwd, since, until }) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { ok: false, error: "auditWindow: cwd must be a non-empty path" };
  }
  const sinceArg = `--since=${gitDate(since)}`;
  const untilArg = `--until=${gitDate(until)}`;
  const sinceMs = Number(since) || 0;
  const violations = [];

  // The commits of the window: sha<NUL>subject per line.
  const log = gitRun(["log", sinceArg, untilArg, "--format=%H%x00%s"], cwd, deadline);
  if (!log.ok) return { ok: false, error: log.error };
  const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("\0");
    return { sha: l.slice(0, i), subject: l.slice(i + 1) };
  });

  // Tags whose creation lands in the window (creatordate is unix seconds).
  const refs = gitRun(["for-each-ref", "--format=%(refname:short)%00%(creatordate:unix)", "refs/tags"], cwd, deadline);
  if (!refs.ok) return { ok: false, error: refs.error };
  const tags = [];
  for (const line of refs.stdout.split("\n").filter(Boolean)) {
    const i = line.indexOf("\0");
    const name = line.slice(0, i);
    const ts = Number(line.slice(i + 1)); // NaN/"" sorts itself out below
    if (Number.isFinite(ts) && ts > 0 && ts * 1000 >= sinceMs) {
      tags.push({ name, at: ts * 1000 });
      violations.push({ rule: "tag", name });
    }
  }

  // Rule version-bump: one diff per commit, pinned to the bumpable files.
  for (const c of commits) {
    const d = gitRun(["diff-tree", "-p", c.sha, "--", ...VERSION_FILES], cwd, deadline);
    if (!d.ok) return { ok: false, error: d.error };
    const bumped = d.stdout.split("\n").some((l) => VERSION_JSON_RE.test(l) || VERSION_TOML_RE.test(l));
    if (bumped) violations.push({ rule: "version-bump", sha: c.sha, subject: c.subject });
  }

  // Rule token: added patch lines only (`+` but not `+++`), numbered in the
  // NEW file via hunk headers. The matched line is never kept or echoed —
  // only sha + line number.
  const patch = gitRun(["log", "-p", "--format=%H", sinceArg, untilArg], cwd, deadline);
  if (!patch.ok) return { ok: false, error: patch.error };
  let sha = null;
  let newLine = 0;
  for (const line of patch.stdout.split("\n")) {
    if (SHA_LINE_RE.test(line)) { sha = line; newLine = 0; continue; }
    const hunk = HUNK_RE.exec(line);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      if (TOKEN_RE.test(line) || DEVICE_SECRET_RE.test(line)) {
        violations.push({ rule: "token", sha, line: newLine });
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++; // context line — the new file advanced
    }
  }

  return { ok: true, commits, tags, violations };
}
