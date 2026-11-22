/**
 * Hardened read-only git for the plugin — every `git` invocation that answers a
 * device payload funnels through gitRead (the herdr-file-viewer git.rs lesson).
 *
 * Fail-closed by construction:
 *   - argv: each arg must match [A-Za-z0-9._/:-] (no space, `;`, `$()`, newline,
 *     unicode …), and any arg that looks like a flag must be on a tiny read-flag
 *     allowlist — `--upload-pack`-style option injection is refused before git
 *     is ever spawned (execFile never shells out, this is defense in depth).
 *   - cwd: never payload-chosen. Only the plugin dir itself, or the
 *     HERDGATE_DIFF_REPO_DIR test override. Anything else refuses.
 *   - env: scrubbed to PATH/HOME/LANG + GIT_OPTIONAL_LOCKS=0 (the herdr-sidebar
 *     lesson: a read must not take the index lock). GIT_DIR, GIT_WORK_TREE and
 *     every other GIT_* from the publisher's environment never cross the
 *     boundary, so no env can redirect which repository is read.
 *   - hardening flags on every run: `-c core.fsmonitor=false` and
 *     `-c core.hooksPath=` go before the subcommand (real global options), and
 *     `--no-ext-diff --no-textconv` right after a diff-family subcommand — the
 *     only positions git accepts them — so hostile repo config (an evil
 *     textconv/diff.external driver, an fsmonitor daemon, a hooks dir) can never
 *     execute through a read.
 *
 * Reads only: callers that need writes keep their own spawn, but reuse
 * scrubEnv() so the write path is equally deaf to GIT_* injection.
 */

import { execFile as execFileCb } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** The plugin's own directory — one of the two cwds git may ever run in. */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** The only cwd a git read may target: the plugin dir, or the test override. */
export function diffRepoDir() {
  const override = process.env.HERDGATE_DIFF_REPO_DIR;
  return override ? resolve(override) : PLUGIN_DIR;
}

/**
 * Child env for every git run. PATH/HOME/LANG survive (git needs them to be
 * findable and to read ~/.gitconfig); GIT_OPTIONAL_LOCKS=0 is added so a read
 * never touches index.lock. Everything else — GIT_DIR, GIT_WORK_TREE,
 * GIT_CONFIG_COUNT, GIT_* of any kind — is dropped.
 */
export function scrubEnv() {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
  return env;
}

/** Args must be short printable words: refs, hashes, paths, allowed flags. */
const ARG_RE = /^[A-Za-z0-9._/:-]{1,128}$/;
/** Flags a read may carry. Anything else option-looking is refused. */
const ALLOWED_FLAGS = new Set(["-C", "--no-color", "--stat", "--patch", "--no-ext-diff", "--no-textconv"]);
/** Subcommands that produce diffs — the only ones that take --no-ext-diff/--no-textconv. */
const DIFF_COMMANDS = new Set(["diff", "show", "log", "whatchanged", "format-patch", "range-diff"]);

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw refuse("GIT_SAFE_ARG", "gitRead refuses: args must be a non-empty array");
  }
  for (const arg of args) {
    if (typeof arg !== "string" || !ARG_RE.test(arg)) {
      throw refuse("GIT_SAFE_ARG", `gitRead refuses arg ${JSON.stringify(arg)}: only [A-Za-z0-9._/:-], 1..128 chars`);
    }
    if (arg.startsWith("-") && !ALLOWED_FLAGS.has(arg)) {
      throw refuse("GIT_SAFE_ARG", `gitRead refuses flag ${arg}: not on the read allowlist`);
    }
  }
}

/** The full argv handed to git: config overrides first (they are global), the
 *  diff hardening flags immediately after the diff subcommand (git rejects them
 *  in any other position). */
function buildArgv(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" ? 2 : 1;
  const argv = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath="];
  if (DIFF_COMMANDS.has(args[i])) {
    argv.push(...args.slice(0, i + 1), "--no-ext-diff", "--no-textconv", ...args.slice(i + 1));
  } else {
    argv.push(...args);
  }
  return argv;
}

/**
 * Run one hardened read-only git command.
 *
 * @param {string[]} args git argv tail, e.g. ["show", "--no-color", "--stat", "--patch", ref]
 *   or ["-C", worktree, "diff", "--stat"] (git is pinned to a safe start cwd and
 *   re-pointed with -C — the filev pattern: git除外 vì dùng -C).
 * @param {string} [cwd] where git starts; must be the plugin dir or the
 *   HERDGATE_DIFF_REPO_DIR override, otherwise the call refuses.
 * @param {number} [timeoutMs] kill git after this long (default 10s).
 * @param {number} [maxBuffer] output cap (default 8 MiB).
 * @returns {Promise<{stdout: string, stderr: string}>} execFile's result, so
 *   callers keep their existing error mapping (e.stderr, exit codes).
 */
export async function gitRead(args, cwd = diffRepoDir(), timeoutMs = 10_000, maxBuffer = 8 * 1024 * 1024) {
  validateArgs(args);
  const allowed = new Set([PLUGIN_DIR]);
  if (process.env.HERDGATE_DIFF_REPO_DIR) allowed.add(resolve(process.env.HERDGATE_DIFF_REPO_DIR));
  const startDir = resolve(cwd);
  if (!allowed.has(startDir)) {
    throw refuse(
      "GIT_SAFE_CWD",
      `gitRead refuses cwd ${cwd}: git reads run only in the plugin dir or HERDGATE_DIFF_REPO_DIR`,
    );
  }
  return execFile("git", buildArgv(args), { cwd: startDir, timeout: timeoutMs, maxBuffer, env: scrubEnv() });
}
