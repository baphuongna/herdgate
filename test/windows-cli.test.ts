import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = join(import.meta.dirname, "..");

test("per-user CLI keeps immutable releases, switches the junction and preserves pairing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "herdgate cli "));
  const source = join(tmp, "bundle");
  const base = join(tmp, "Herdgate", "cli");
  const appHome = join(tmp, "app");
  const env = { ...process.env, HERDR_APP_HOME: appHome, LOCALAPPDATA: tmp };
  const entry = join(source, "bin", "herdgate.mjs");
  const npmCli = (...args: string[]) => execFileSync(process.execPath, [entry, ...args], { env, encoding: "utf8" });
  const invoke = () => npmCli("install-tui", "--root", base);
  const cli = (...args: string[]) => npmCli("tui", ...args);
  try {
    cpSync(join(repo, "bin"), join(source, "bin"), { recursive: true });
    cpSync(join(repo, "plugin"), join(source, "plugin"), { recursive: true });
    cpSync(join(repo, "windows"), join(source, "windows"), { recursive: true });
    const pairing = join(appHome, "herdgate", "config", "herdgate.env");
    mkdirSync(join(appHome, "herdgate", "config"), { recursive: true });
    writeFileSync(pairing, "test pairing unchanged\n");
    invoke();
    const first = cli("version").trim();
    assert.match(first, /^tui-[a-f0-9]{16}$/);
    assert.equal(realpathSync(join(base, "current")), realpathSync(join(base, "releases", first)));
    assert.ok(lstatSync(join(base, "current")).isSymbolicLink());
    assert.match(readFileSync(join(base, "bin", "herdgate-tui.cmd"), "utf8"), /current\\windows\\cli\.mjs/);
    assert.equal(JSON.parse(cli("status")).state, "stopped");
    if (process.platform === "win32") {
      const result = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "herdgate-tui.cmd", "version"], {
        cwd: join(base, "bin"), encoding: "utf8", env,
      });
      assert.equal(result.trim(), first);
    }
    invoke();
    assert.equal(cli("version").trim(), first);
    const old = join(source, "plugin", "server", "publish-tui.mjs");
    writeFileSync(old, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    invoke();
    const second = cli("version").trim();
    assert.notEqual(first, second);
    assert.ok(existsSync(join(base, "releases", first)));
    assert.match(cli("versions"), new RegExp(second + " \\(current\\)"));
    const herdr = join(tmp, "A Space", "herdr.exe");
    const hc = join(tmp, "A Space", "herdr-core.exe");
    assert.deepEqual(JSON.parse(cli("start", herdr, "--hc", hc)), ["start", herdr, "--hc", hc]);
    assert.deepEqual(JSON.parse(cli("start", herdr, "--mobile-tui", "d_phone")), ["start", herdr, "--mobile-tui", "d_phone"]);
    assert.deepEqual(JSON.parse(cli("start", herdr, "--mobile-tui-act", "d_phone_act")), ["start", herdr, "--mobile-tui-act", "d_phone_act"]);
    assert.ok(existsSync(join(base, "releases", second, "plugin", "server", "mobile-tui-core.mjs")));
    cli("use", first);
    assert.equal(cli("version").trim(), first);
    assert.equal(readFileSync(pairing, "utf8"), "test pairing unchanged\n");
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});

test("the npm installer leaves a standalone herdgate command after its source is removed, without selecting a publisher", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hg npm cache "));
  const source = join(tmp, "npm-extract");
  const base = join(tmp, "user", "Herdgate", "cli");
  const env = { ...process.env, LOCALAPPDATA: join(tmp, "not-the-install-root"), XDG_CONFIG_HOME: join(tmp, "config") };
  try {
    for (const dir of ["bin", "plugin", "windows", "templates", "app-mod"]) {
      cpSync(join(repo, dir), join(source, dir), { recursive: true });
    }
    const cli = (...args: string[]) => execFileSync(process.execPath, [join(source, "bin", "herdgate.mjs"), ...args], { env, encoding: "utf8" });
    const old = 'tui-0000000000000000';
    mkdirSync(join(base, 'releases', old), { recursive: true });
    writeFileSync(join(base, 'releases', old, 'release.txt'), `${old}\n`);
    cli('install-tui', '--root', base, '--use', old);
    cli('install', '--root', base);
    rmSync(source, { recursive: true, force: true });
    assert.equal(realpathSync(join(base, 'current')), realpathSync(join(base, 'releases', old)), 'installing the command does not change the publisher');
    const script = readFileSync(join(base, 'bin', 'herdgate.cmd'), 'utf8');
    assert.match(script, /command\\bin\\herdgate\.mjs/);
    assert.ok(script.includes(process.execPath.replaceAll('%', '%%')));
    const call = (...args: string[]) => process.platform === 'win32'
      ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'herdgate.cmd', ...args], { cwd: join(base, 'bin'), env, encoding: 'utf8' })
      : execFileSync(process.execPath, [join(base, 'command', 'bin', 'herdgate.mjs'), ...args], { env, encoding: 'utf8' });
    call('cloud', 'add', 'home', 'https://gate.example.org');
    assert.match(call('cloud', 'list'), /home\s+https:\/\/gate\.example\.org/);
    assert.match(call('--help'), /herdgate start \| stop \| status \| update/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the installed update command uses npm beside its pinned Node and dispatches the downloaded CLI", () => {
  const tmp = mkdtempSync(join(tmpdir(), "herdgate self-update "));
  const base = join(tmp, "Herdgate", "cli");
  const runtime = join(tmp, "pinned runtime");
  const node = join(runtime, process.platform === "win32" ? "node.exe" : "node");
  const npm = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
  const env = { ...process.env, LOCALAPPDATA: tmp, HERDGATE_NO_PI_SKILLS: '1' };
  try {
    mkdirSync(join(runtime, "node_modules", "npm", "bin"), { recursive: true });
    try { linkSync(process.execPath, node); } catch { cpSync(process.execPath, node); }
    execFileSync(node, [join(repo, "bin", "herdgate.mjs"), "install-tui", "--root", base], { env });
    const cli = join(base, "current", "windows", "cli.mjs");
    const run = () => spawnSync(node, [cli, "update"], { cwd: base, env, encoding: "utf8" });
    const unconfigured = run();
    assert.notEqual(unconfigured.status, 0);
    assert.match(unconfigured.stderr, /tui setup/);
    writeFileSync(join(base, "publisher-profile.json"), '{"args":[]}\n');
    writeFileSync(npm, `
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv.includes('@bom0792/herdgate@latest') || !process.argv.includes('--ignore-scripts')) process.exit(7);
const dest = process.argv[process.argv.indexOf('--prefix') + 1];
if (dest === process.env.LOCALAPPDATA) process.exit(8);
const bin = path.join(dest, 'node_modules', '@bom0792', 'herdgate', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'herdgate.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
`);
    const updated = run();
    assert.equal(updated.status, 0, updated.stderr);
    assert.deepEqual(JSON.parse(updated.stdout.trim()), ["tui", "update"]);
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});

test("the staged release carries package.json so the publisher can advertise its real version", () => {
  const tmp = mkdtempSync(join(tmpdir(), "herdgate stage "));
  const source = join(tmp, "bundle");
  try {
    for (const dir of ["plugin", "windows"]) cpSync(join(repo, dir), join(source, dir), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@bom0792/herdgate", version: "9.9.9-fixture" }) + "\n");
    const out = execFileSync(process.execPath, [join(source, "windows", "install-cli.mjs"), "--root", join(tmp, "Herdgate", "cli"), "--stage"], { env: { ...process.env, LOCALAPPDATA: tmp }, encoding: "utf8" }).trim();
    assert.match(out, /^tui-[a-f0-9]{16}$/);
    const staged = JSON.parse(readFileSync(join(tmp, "Herdgate", "cli", "releases", out, "package.json"), "utf8")) as { version: string };
    assert.equal(staged.version, "9.9.9-fixture");
    // And the shipped helper reads it from inside the staged release.
    const v = execFileSync(process.execPath, ["-e", "import('./plugin/server/common.mjs').then((c) => console.log(c.pkgVersion()))"], { cwd: join(tmp, "Herdgate", "cli", "releases", out), encoding: "utf8" }).trim();
    assert.equal(v, "9.9.9-fixture", "pkgVersion resolves ../../package.json inside a staged release");
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});

test("npm CLI stages, updates and rolls back the publisher while retaining the explicit Mobile mode", () => {
  const tmp = mkdtempSync(join(tmpdir(), "herdgate setup "));
  const source = join(tmp, "bundle");
  const entry = join(source, "bin", "herdgate.mjs");
  const log = join(tmp, "calls.jsonl");
  const state = join(tmp, "running");
  const pi = join(tmp, "pi");
  const piSkill = join(pi, "skills", "herdgate", "herdr", "SKILL.md");
  const env = { ...process.env, LOCALAPPDATA: tmp, PI_CODING_AGENT_DIR: pi, HERDGATE_NO_PI_SKILLS: undefined, HERDR_APP_HOME: join(tmp, "app"), TEST_TUI_LOG: log, TEST_TUI_STATE: state };
  const cli = (...args: string[]) => execFileSync(process.execPath, [entry, "tui", ...args], { env, encoding: "utf8" });
  const pair = join(env.HERDR_APP_HOME, "herdgate", "config", "herdgate.env");
  const worker = join(source, "plugin", "server", "publish-tui.mjs");
  const putWorker = (tag: string, failure = "") => writeFileSync(worker, `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [cmd,...args]=process.argv.slice(2), tag=${JSON.stringify(tag)};
const {TEST_TUI_LOG:log,TEST_TUI_STATE:file}=process.env;
appendFileSync(log,JSON.stringify([tag,cmd,...args])+'\\n');
if(cmd===${JSON.stringify(failure)}) { console.error('fixture '+cmd+' failed'); process.exit(1); }
if(cmd==='check') process.exit(0);
if(cmd==='start') writeFileSync(file,tag);
if(cmd==='stop') rmSync(file,{force:true});
console.log(JSON.stringify({state:existsSync(file)?'connected':'stopped'}));
`);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const bad = (...args: string[]) => spawnSync(process.execPath, [entry, "tui", ...args], { env, encoding: "utf8" });
  try {
    for (const dir of ["bin", "plugin", "windows", join(".agents", "skills")]) cpSync(join(repo, dir), join(source, dir), { recursive: true });
    mkdirSync(join(env.HERDR_APP_HOME, "herdgate", "config"), { recursive: true });
    writeFileSync(pair, "pair stays unchanged\n");
    const herdr = join(tmp, "A Space", "herdr.exe");
    const flags = [herdr, "--mobile-tui-act", "d_phone"];
    putWorker("old");
    execFileSync(process.execPath, [entry, "install-tui", "--root", join(tmp, "Herdgate", "cli")], { env });
    cli("start", ...flags); // legacy start does not save the explicit mode
    const before = cli("version").trim();
    const runningBefore = calls().filter(c => c[1] === "stop").length;
    assert.match(bad("migrate").stderr, /did not save its mode/);
    assert.equal(cli("version").trim(), before);
    assert.equal(calls().filter(c => c[1] === "stop").length, runningBefore);
    assert.match(cli("migrate", "--no-path", ...flags), /connected/);
    assert.ok(existsSync(join(tmp, 'Herdgate', 'cli', 'bin', 'herdgate.cmd')));
    const beforeSkillUpdate = readFileSync(piSkill, 'utf8');
    const nextSkill = join(source, '.agents', 'skills', 'herdr', 'SKILL.md');
    writeFileSync(nextSkill, beforeSkillUpdate + '\nUpdated fixture skill.\n');
    assert.ok(calls().some(c => JSON.stringify(c) === JSON.stringify(["old", "start", ...flags])));
    assert.equal(readFileSync(state, "utf8"), "old");
    const old = cli("version").trim();
    putWorker("bad-check", "check");
    assert.notEqual(bad("update").status, 0);
    assert.equal(cli("version").trim(), old);
    assert.equal(readFileSync(state, "utf8"), "old");
    assert.equal(readFileSync(piSkill, 'utf8'), beforeSkillUpdate);
    putWorker("new");
    assert.match(cli("update"), /connected/);
    const current = cli("version").trim();
    assert.notEqual(current, old);
    assert.equal(readFileSync(piSkill, 'utf8'), readFileSync(nextSkill, 'utf8'));
    assert.ok(calls().some(c => JSON.stringify(c) === JSON.stringify(["new", "start", ...flags])));
    assert.equal(readFileSync(state, "utf8"), "new");
    const count = calls().filter(c => c[1] === "start").length;
    cli("update");
    assert.equal(calls().filter(c => c[1] === "start").length, count, "no restart for the same healthy release");
    putWorker("bad-start", "start");
    const command = realpathSync(join(tmp, 'Herdgate', 'cli', 'command'));
    assert.match(bad("update").stderr, /restored/i);
    assert.equal(realpathSync(join(tmp, 'Herdgate', 'cli', 'command')), command);
    assert.equal(cli("version").trim(), current);
    assert.equal(readFileSync(state, "utf8"), "new");
    assert.equal(readFileSync(pair, "utf8"), "pair stays unchanged\n");
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});
