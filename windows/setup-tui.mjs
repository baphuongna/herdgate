// npm entry point: stage a release before stopping the existing publisher.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const installer = fileURLToPath(new URL("./install-cli.mjs", import.meta.url));
const releaseId = /^tui-[a-f0-9]{16}$/;
const normalize = (path) => process.platform === "win32" ? path.toLowerCase() : path;
const errorText = (e) => e instanceof Error ? e.message : String(e);
function invoke(file, args) {
  const child = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || `${args[0]} failed (${child.status})`);
  if (child.stderr) process.stderr.write(child.stderr);
  return child.stdout.trim();
}
function storedProfile(path) {
  if (!existsSync(path)) return null;
  const { args } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(args) || args.length > 3 || args.some((v) => typeof v !== "string")) throw new Error("invalid TUI profile; inspect the saved profile before updating");
  return args;
}
function writeProfile(path, args) {
  const tmp = `${path}.${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ args }) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

/** The setup lock: one `.setup` directory per root. A run that was killed
 *  mid-update leaves it orphaned; a retry minutes later must reclaim it
 *  instead of dying on EEXIST. A lock younger than 60s may still belong to a
 *  live run — refuse and say so, never stomp a possible concurrent setup. */
export function acquireSetupLock(root) {
  const lock = join(root, ".setup");
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    let mtimeMs = Date.now();
    try { mtimeMs = statSync(lock).mtimeMs; } catch { /* vanished: mkdir again below */ }
    if (mtimeMs > Date.now() - 60_000) throw new Error(`another herdgate setup appears to be running; if you are sure it is not, remove ${lock}`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock); // losing this race is fatal, which is what we want
  }
  let released = false;
  return () => { if (!released) { released = true; rmSync(lock, { force: true, recursive: true }); } };
}

async function setup() {
  const [cmd, ...options] = process.argv.slice(2);
  const requested = options.filter(flag => flag !== "--no-path");
  const noPath = requested.length !== options.length;
  if (cmd === "update" && options.length) throw new Error("use herdgate setup to change publisher options");
  if (!["setup", "migrate", "update"].includes(cmd)) throw new Error("expected setup, migrate, or update");
  const plain = requested.includes("--plain");
  if (plain && requested.length !== 1) throw new Error("--plain cannot be combined with other publisher options");
  if (!process.env.LOCALAPPDATA) throw new Error("%LOCALAPPDATA% is required for this installer");
  const root = join(process.env.LOCALAPPDATA, "Herdgate", "cli");
  mkdirSync(root, { recursive: true });
  const releaseLock = acquireSetupLock(root);
  try {
    const link = join(root, "current");
    const releases = join(root, "releases");
    const profilePath = join(root, "publisher-profile.json");
    const profile = storedProfile(profilePath);
    if (cmd === "update" && !profile) throw new Error("no saved publisher mode; run herdgate migrate with your current options once");
    // 'setup' without arguments on an already configured machine keeps its mode.
    const args = plain ? [] : requested.length ? requested : profile ?? [];
    let prior;
    if (existsSync(link)) {
      const target = realpathSync(link);
      prior = basename(target);
      if (!releaseId.test(prior) || normalize(dirname(target)) !== normalize(realpathSync(releases))) {
        throw new Error("current does not point to an installed release");
      }
    }
    if (!profile && !requested.length && (prior || cmd === "migrate")) {
      throw new Error("the old publisher did not save its mode; run herdgate migrate --mobile-act <id>, --mobile-read <id>, --hc <path>, or --plain if Mobile was off");
    }
    const install = (...options) => invoke(installer, ["--root", root, ...options]);
    const cli = (id, ...options) => invoke(join(releases, id, "windows", "cli.mjs"), options);
    const status = (id) => JSON.parse(cli(id, "status"));
    const stop = (id) => {
      if (JSON.parse(cli(id, "stop")).state !== "stopped") throw new Error("publisher did not stop; no Herdr processes were signalled");
    };
    const start = async (id, options) => {
      cli(id, "start", ...options);
      const deadline = Date.now() + 10_000;
      let result;
      do {
        result = status(id);
        if (result.state === "connected") return result;
        if (result.state === "stopped" || result.state === "stale") break;
        await delay(300);
      } while (Date.now() < deadline);
      throw new Error(`publisher did not connect (${result.state})${result.log ? `; see ${result.log}` : ""}`);
    };
    const next = install("--stage");
    if (!releaseId.test(next)) throw new Error("installer did not return a release ID");
    cli(next, "check", ...args); // validate executable, pairing and Herdr before disrupting the old worker
    const refreshCommand = () => {
      // Older standalone bundles do not have the top-level npm CLI. Keep their compatibility shim usable.
      if (!existsSync(join(releases, next, "bin", "herdgate.mjs"))) return;
      const first = !existsSync(join(root, "bin", "herdgate.cmd"));
      try {
        const output = install("--command", "--use", next, ...(!first || noPath ? ["--no-path"] : []));
        if (first) console.error(output);
      } catch (error) {
        // Command registration isn't part of the publisher transaction.
        console.error(`herdgate tui: could not install the persistent command: ${errorText(error)}`);
      }
    };
    const oldStatus = status(prior ?? next);
    const running = !["stopped", "stale"].includes(oldStatus.state);
    if (prior === next && profile && JSON.stringify(args) === JSON.stringify(profile) && oldStatus.state === "connected") {
      install("--use", next); // refresh pinned Node shim, no worker restart
      refreshCommand();
      console.log(JSON.stringify({ release: next, ...oldStatus }));
      return;
    }
    if (oldStatus.state !== "stopped") stop(prior ?? next);
    let triedStart = false;
    try {
      install("--use", next);
      triedStart = true;
      const result = await start(next, args);
      writeProfile(profilePath, args);
      refreshCommand();
      console.log(JSON.stringify({ release: next, ...result }));
    } catch (cause) {
      try {
        if (triedStart && status(next).state !== "stopped") stop(next);
        if (prior) {
          install("--use", prior);
          if (running) await start(prior, profile ?? args);
        }
      } catch (recovery) {
        throw new Error(`${errorText(cause)}; could not restore the old publisher: ${errorText(recovery)}`);
      }
      throw new Error(`${errorText(cause)}${prior ? "; previous release restored" : ""}`);
    }
  } finally { releaseLock(); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try { await setup(); }
  catch (e) { console.error(`herdgate tui: ${errorText(e)}`); process.exitCode = 1; }
}
