// npm staging helper + safe self-updater for the Herdgate per-user CLI.
//
// withLatest(run) keeps its original contract for the existing callers
// (windows/cli.mjs "update" and bin/herdgate.mjs "update"): stage the latest
// @bom0792/herdgate release with the npm bundled beside the same Node, without
// running install hooks, and hand the staged package directory to run().
//
// Run directly (node npm-update.mjs) this module is the safe updater, applying
// the lessons from herdr-updater:
//   - before ANY change the installed/latest relation is computed with
//     ./update-policy.mjs; "unknown" (unparsable versions) is an error state
//     that exits 1 — it is never treated as "current" and never updated past;
//   - the default policy is "notify": print installed/latest/relation/plan,
//     run no install and write no file except the append-only history
//     "checked" line;
//   - HERDGATE_UPDATE_POLICY=auto may only apply when the installed version is
//     strictly "behind" (npm source), or when the installed commit is an
//     ancestor of the upstream ref found via git merge-base --is-ancestor (git
//     source); same/ahead/diverged/pinned/linked states are held with a reason;
//   - every real apply appends an "updated" history line (from -> to) and keeps
//     the previous install behaviour (staged npm install with --ignore-scripts,
//     then the staged Windows CLI performs the switch).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendHistory, policyFromEnv, relation } from "./update-policy.mjs";

const PACKAGE = "@bom0792/herdgate";
const here = dirname(fileURLToPath(import.meta.url));

/** npm-cli.js shipped beside the current Node, if any (same candidates as before). */
function bundledNpmCli() {
  const nodeDir = dirname(process.execPath);
  return [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.platform === "win32" ? [] : [join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]),
    ...(nodeDir === "/usr/bin" ? ["/usr/share/nodejs/npm/bin/npm-cli.js"] : []),
  ].find(existsSync) ?? null;
}

// Fetch the npm release using npm bundled with the same Node, without running install hooks.
export function withLatest(run) {
  const npm = bundledNpmCli();
  if (!npm) throw new Error('npm was not found beside Node; use a Node 22+ distribution with npm');
  const work = mkdtempSync(join(tmpdir(), 'herdgate-update-'));
  try {
    const result = spawnSync(process.execPath, [npm, 'install', '--prefix', work, '--global=false', '--no-save', '--package-lock=false',
      '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', '@bom0792/herdgate@latest'],
    { cwd: work, stdio: 'inherit', shell: false, windowsHide: true, timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('could not download Herdgate from npm; current publisher not changed');
    return run(join(work, 'node_modules', '@bom0792', 'herdgate'));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---- safe updater (direct run) ----

/** Run npm, preferring an npm from PATH (where tests stub it); the bundled npm-cli.js is the fallback. */
function npmRun(args, { timeout = 120_000 } = {}) {
  if (process.platform === "win32") {
    const command = ["npm", ...args]
      .map((arg) => (/[ \t"^&|<>()!]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg))
      .join(" ");
    return spawnSync(command, { encoding: "utf8", shell: true, windowsHide: true, timeout });
  }
  const fromPath = spawnSync("npm", args, { encoding: "utf8", shell: false, windowsHide: true, timeout });
  if (!fromPath.error || fromPath.error.code !== "ENOENT") return fromPath;
  const bundled = bundledNpmCli();
  return bundled
    ? spawnSync(process.execPath, [bundled, ...args], { encoding: "utf8", shell: false, windowsHide: true, timeout })
    : fromPath;
}

/** Latest published version, or null when npm cannot answer. */
function npmLatestVersion(pkg) {
  const result = npmRun(["view", pkg, "version"], { timeout: 30_000 });
  if (result.error || result.status !== 0) return null;
  const version = (result.stdout ?? "").trim().split("\n").pop()?.trim();
  return version || null;
}

/** Version of the package this module was shipped in, or null (never guessed). */
function installedPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Stage the latest release exactly like withLatest, but through the resolved npm. */
function stageLatest() {
  const work = mkdtempSync(join(tmpdir(), "herdgate-update-"));
  try {
    const result = npmRun(["install", "--prefix", work, "--global=false", "--no-save", "--package-lock=false",
      "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", `${PACKAGE}@latest`]);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`could not download ${PACKAGE} from npm; nothing was changed`);
    return work;
  } catch (error) {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

// ---- git source ----

function git(checkout, args) {
  return spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
}

function gitText(checkout, args) {
  const result = git(checkout, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Classify a checkout: behind/ahead/same by ancestry, pinned (detached HEAD) or linked (no upstream). */
function gitRelation(checkout) {
  const head = gitText(checkout, ["rev-parse", "HEAD"]);
  if (!head) return { relation: "unknown", head: null, upstream: null, upstreamSha: null };
  const branch = gitText(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = !branch || branch === "HEAD";
  const upstream = detached ? null : gitText(checkout, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstreamSha = upstream ? gitText(checkout, ["rev-parse", upstream]) : null;
  if (!upstream || !upstreamSha) {
    return { relation: detached ? "pinned" : "linked", head, upstream, upstreamSha: null };
  }
  if (head === upstreamSha) return { relation: "same", head, upstream, upstreamSha };
  // Only an installed ref that is an ancestor of upstream may be fast-forwarded.
  if (git(checkout, ["merge-base", "--is-ancestor", head, upstreamSha]).status === 0) {
    return { relation: "behind", head, upstream, upstreamSha };
  }
  if (git(checkout, ["merge-base", "--is-ancestor", upstreamSha, head]).status === 0) {
    return { relation: "ahead", head, upstream, upstreamSha };
  }
  return { relation: "diverged", head, upstream, upstreamSha };
}

/** Nearest enclosing git work tree, or null (an npm-installed package has none). */
function findCheckout(start) {
  for (let dir = resolve(start);;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---- reporting and policies ----

function fail(message) {
  console.error(`herdgate update: ${message}`);
  process.exitCode = 1;
}

/** Append one history line; on failure report and stop (return null). */
function record(stateDir, entry) {
  try {
    return appendHistory(stateDir, entry);
  } catch (error) {
    fail(`could not append the update history: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function updateFromNpm(policy, stateDir, env) {
  const pkg = env.HERDGATE_UPDATE_PACKAGE || PACKAGE;
  const installed = env.HERDGATE_UPDATE_INSTALLED || installedPackageVersion();
  const latest = env.HERDGATE_UPDATE_LATEST || npmLatestVersion(pkg);
  const rel = relation(installed, latest);
  console.log(`source:    npm package ${pkg}`);
  console.log(`policy:    ${policy}`);
  console.log(`installed: ${installed ?? "<unknown>"}`);
  console.log(`latest:    ${latest ?? "<unknown>"}`);
  console.log(`relation:  ${rel}`);
  if (rel === "unknown") {
    return fail(`cannot compare installed "${installed ?? ""}" with latest "${latest ?? ""}": unparsable version — refusing to guess or update`);
  }
  if (policy === "notify") {
    console.log(rel === "behind"
      ? `plan:      stage ${pkg}@${latest} with npm --ignore-scripts and switch the per-user CLI; set HERDGATE_UPDATE_POLICY=auto to apply`
      : `plan:      nothing to apply (relation ${rel})`);
    if (!record(stateDir, { from: installed, to: latest, relation: rel, action: "checked" })) return;
    console.log(`history:   ${join(stateDir, "update-history.jsonl")} (append-only)`);
    return;
  }
  if (rel !== "behind") {
    console.log("held — applying would be a downgrade/no-op");
    record(stateDir, { from: installed, to: latest, relation: rel, action: "held" });
    return;
  }
  let work;
  try {
    work = stageLatest();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    if (!record(stateDir, { from: installed, to: latest, relation: rel, action: "updated" })) return;
    console.log(`updated:   ${installed} -> ${latest}`);
    // Keep the previous apply behaviour: the staged Windows CLI switches the publisher.
    const stagedCli = join(work, "node_modules", "@bom0792", "herdgate", "bin", "herdgate.mjs");
    if (process.platform === "win32" && existsSync(stagedCli)) {
      const switched = spawnSync(process.execPath, [stagedCli, "tui", "update"], { stdio: "inherit", shell: false, windowsHide: true, timeout: 120_000 });
      if (switched.error) throw switched.error;
      if (switched.status) process.exitCode = switched.status;
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function updateFromGit(policy, stateDir, checkout) {
  const rel = gitRelation(checkout);
  console.log(`source:    git checkout ${checkout}`);
  console.log(`policy:    ${policy}`);
  console.log(`installed: ${rel.head ?? "<unknown>"}${rel.head ? " (HEAD)" : ""}`);
  console.log(`upstream:  ${rel.upstream ? `${rel.upstream}${rel.upstreamSha ? ` (${rel.upstreamSha})` : ""}` : "<none>"}`);
  console.log(`relation:  ${rel.relation}`);
  if (rel.relation === "unknown") {
    return fail(`cannot determine the state of the git checkout at ${checkout} — refusing to guess or update`);
  }
  if (policy === "notify") {
    console.log(rel.relation === "behind"
      ? `plan:      fast-forward HEAD to ${rel.upstream} (${rel.upstreamSha}); set HERDGATE_UPDATE_POLICY=auto to apply`
      : `plan:      nothing to apply (relation ${rel.relation})`);
    if (!record(stateDir, { from: rel.head, to: rel.upstreamSha, relation: rel.relation, action: "checked" })) return;
    console.log(`history:   ${join(stateDir, "update-history.jsonl")} (append-only)`);
    return;
  }
  if (rel.relation !== "behind") {
    const reason = rel.relation === "ahead" ? "applying would be a downgrade/no-op"
      : rel.relation === "same" ? "applying would be a no-op"
      : rel.relation === "diverged" ? "the checkout diverged from upstream; only a fast-forward is safe"
      : rel.relation === "pinned" ? "the checkout is pinned to a detached ref"
      : "the branch has no upstream to fast-forward to";
    console.log(`held — ${reason}`);
    record(stateDir, { from: rel.head, to: rel.upstreamSha, relation: rel.relation, action: "held" });
    return;
  }
  const merged = git(checkout, ["merge", "--ff-only", rel.upstreamSha]);
  if (merged.error || merged.status !== 0) {
    return fail(`fast-forwarding to ${rel.upstream} failed; the checkout was not changed${merged.stderr ? `: ${merged.stderr.trim()}` : ""}`);
  }
  const applied = gitText(checkout, ["rev-parse", "HEAD"]) ?? rel.upstreamSha;
  if (!record(stateDir, { from: rel.head, to: applied, relation: "behind", action: "updated" })) return;
  console.log(`updated:   ${rel.head} -> ${applied}`);
}

function main() {
  const env = process.env;
  const policy = policyFromEnv(env);
  const stateDir = env.HERDGATE_UPDATE_STATE_DIR || (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Herdgate", "cli") : null);
  if (!stateDir) {
    return fail("nowhere to record the update history; set HERDGATE_UPDATE_STATE_DIR (or LOCALAPPDATA)");
  }
  const checkout = env.HERDGATE_UPDATE_CHECKOUT || findCheckout(here);
  return checkout ? updateFromGit(policy, stateDir, checkout) : updateFromNpm(policy, stateDir, env);
}

// Only act when executed directly; importing callers keep using withLatest unchanged.
const executedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (executedDirectly) main();
