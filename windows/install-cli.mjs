// Per-user installation. On Windows, directory junctions do not need admin or Developer Mode.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const releasePattern = /^tui-[a-f0-9]{16}$/;
const stat = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const pathKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
const samePath = (a, b) => pathKey(a) === pathKey(b);

function directory(path) {
  mkdirSync(path, { recursive: true });
  if (!lstatSync(path).isDirectory()) throw new Error(`expected a real directory: ${path}`);
}

async function inputs() {
  function files(dir) {
    return readdirSync(join(source, dir), { withFileTypes: true }).flatMap((file) => {
      const name = `${dir}/${file.name}`;
      return file.isDirectory() ? files(name) : file.isFile() ? [name] : [];
    });
  }
  const runtime = ["plugin", "windows"];
  // ZIPs built before the standalone command do not contain these npm assets.
  for (const dir of ["bin", "app-mod", "templates"]) if (stat(join(source, dir))?.isDirectory()) runtime.push(dir);
  const assets = runtime.flatMap(files);
  // The publisher advertises its build via pkgVersion(), which reads the
  // package's own package.json — a staged release must carry it (npm layouts
  // have it; older ZIP bundles may not, hence the guard).
  if (stat(join(source, "package.json"))?.isFile()) assets.push("package.json");
  if (stat(join(source, ".agents", "skills"))?.isDirectory()) {
    const { piSkillFiles } = await import("../bin/pi-skills.mjs");
    assets.push(...piSkillFiles.map(name => `.agents/skills/${name}`));
  }
  return assets.sort();
}

async function installRelease(releases) {
  const files = (await inputs()).map((name) => [name, readFileSync(join(source, name))]);
  const hash = createHash("sha256");
  for (const [name, contents] of files) hash.update(`${name}\0${contents.length}\0`).update(contents);
  const id = `tui-${hash.digest("hex").slice(0, 16)}`;
  const dest = join(releases, id);
  if (stat(dest)) {
    if (!lstatSync(dest).isDirectory() || readFileSync(join(dest, "release.txt"), "utf8").trim() !== id) {
      throw new Error(`invalid existing release: ${dest}`);
    }
    return id;
  }
  const stage = mkdtempSync(join(releases, ".stage-"));
  try {
    for (const [name, data] of files) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), data, { flag: "wx" });
    }
    writeFileSync(join(stage, "release.txt"), `${id}\n`);
    renameSync(stage, dest);
  } finally {
    rmSync(stage, { force: true, recursive: true });
  }
  return id;
}

function selectRelease(root, releases, id, link = "current") {
  if (!releasePattern.test(id)) throw new Error("invalid release ID");
  const dest = join(releases, id);
  if (!stat(dest)?.isDirectory() || readFileSync(join(dest, "release.txt"), "utf8").trim() !== id) {
    throw new Error(`release not installed: ${id}`);
  }
  const current = join(root, link);
  const old = stat(current);
  if (old) {
    if (!old.isSymbolicLink()) throw new Error(`refusing to replace a real file or directory: ${current}`);
    const target = realpathSync(current);
    if (!releasePattern.test(basename(target)) || !samePath(dirname(target), realpathSync(releases))) {
      throw new Error(`refusing to replace a link outside the managed releases: ${current}`);
    }
    if (samePath(target, realpathSync(dest))) return;
  }
  const slot = join(root, `.next-${randomUUID()}`);
  const backup = `${slot}.old`;
  symlinkSync(dest, slot, process.platform === "win32" ? "junction" : "dir");
  try {
    if (old) renameSync(current, backup);
    try { renameSync(slot, current); }
    catch (e) {
      if (old) renameSync(backup, current);
      throw e;
    }
    if (old) unlinkSync(backup);
  } finally {
    if (stat(slot)?.isSymbolicLink()) unlinkSync(slot);
  }
}

function installShim(root, name, target, marker) {
  const bin = join(root, "bin");
  directory(bin);
  const shim = join(bin, name);
  const previous = stat(shim);
  if (previous && (!previous.isFile() || !readFileSync(shim, "utf8").startsWith(marker + "\r\n"))) {
    throw new Error(`refusing to overwrite an unmanaged shim: ${shim}`);
  }
  // Match the Node used for install, not a node.exe from the caller's cwd.
  const node = process.execPath.replaceAll("%", "%%");
  const content = `${marker}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node}" "%~dp0..\\${target}" %*\r\nexit /b %errorlevel%\r\n`;
  // Self-update is running from this batch file; never rewrite an unchanged shim.
  if (previous && readFileSync(shim, "utf8") === content) return;
  const staged = `${shim}.${randomUUID()}`;
  try {
    writeFileSync(staged, content, { flag: "wx" });
    renameSync(staged, shim);
  } finally {
    rmSync(staged, { force: true });
  }
}

function registerUserPath(root) {
  const system = process.env.SystemRoot;
  if (!isAbsolute(system ?? "")) return false;
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference = 'Stop'
$bin = $env:HERDGATE_INSTALL_BIN
if (!$bin -or $bin.Contains(';')) { exit 1 }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $old = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($old -isnot [string]) { exit 1 }
  foreach ($entry in $old.Split(';')) {
    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim([char]34))
    if ($expanded.TrimEnd([char[]]@(92, 47)) -ieq $bin) { exit 0 }
  }
  $new = if ($old -and !$old.EndsWith(';')) { $old + ';' + $bin } else { $old + $bin }
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'ExpandString') {
    if ($bin.Contains('%')) { exit 1 }
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } else {
    [Environment]::SetEnvironmentVariable('Path', $new, [EnvironmentVariableTarget]::User)
  }
} finally { $key.Dispose() }
exit 0`;
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, HERDGATE_INSTALL_BIN: join(root, "bin") }, shell: false, windowsHide: true,
    timeout: 15_000, encoding: "utf8",
  });
  return result.status === 0;
}

try {
  if (process.platform === "win32" && typeof globalThis.WebSocket !== "function") throw new Error("run this installer with Node 22+ with WebSocket enabled");
  const args = process.argv.slice(2);
  const defaultRoot = process.platform === "win32" && process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Herdgate", "cli") : null;
  let root = defaultRoot;
  let use = null;
  let stage = false;
  let command = false;
  let userPath = true;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--stage") { stage = true; continue; }
    if (flag === "--command") { command = true; continue; }
    if (flag === "--no-path") { userPath = false; continue; }
    const value = args.shift();
    if (flag === "--root" && value) root = resolve(value);
    else if (flag === "--use" && value) use = value;
    else throw new Error("usage: node windows/install-cli.mjs [--root <dir>] [--stage | --use <release-id>] [--command [--no-path]]");
  }
  if (!root) throw new Error("this installer defaults to %LOCALAPPDATA% on Windows");
  if ((stage && (use || command)) || (!command && !userPath)) throw new Error("invalid installer option combination");
  directory(root);
  const releases = join(root, "releases");
  directory(releases);
  const lock = join(root, ".installing");
  mkdirSync(lock);
  try {
    const id = use ?? await installRelease(releases);
    if (stage) {
      console.log(id);
    } else if (command) {
      if (!releasePattern.test(id) || !stat(join(releases, id, "bin", "herdgate.mjs"))?.isFile()) {
        throw new Error("the standalone command requires the Herdgate npm package");
      }
      installShim(root, "herdgate.cmd", "command\\bin\\herdgate.mjs", "@rem Herdgate CLI");
      selectRelease(root, releases, id, "command");
      const shim = join(root, "bin", "herdgate.cmd");
      if (userPath && defaultRoot && samePath(root, defaultRoot)) {
        if (registerUserPath(root)) console.log(`Herdgate CLI: ${shim}\nOpen a new terminal for User PATH; in the current shell, use the full path above.`);
        else console.log(`Herdgate CLI: ${shim}\nCould not register User PATH; invoke the shim by full path.`);
      } else console.log(`Herdgate CLI: ${shim}`);
    } else {
      selectRelease(root, releases, id);
      installShim(root, "herdgate-tui.cmd", "current\\windows\\cli.mjs", "@rem Herdgate TUI CLI");
      console.log(`Herdgate TUI CLI: ${id}\nShim: ${join(root, "bin", "herdgate-tui.cmd")}`);
    }
    // Stage/rollback never install skills; sync only after a successful install or CLI refresh.
    if (!stage && (command || !use) && stat(join(source, "bin", "pi-skills.mjs"))?.isFile()) {
      const { trySyncPiSkills } = await import("../bin/pi-skills.mjs");
      trySyncPiSkills();
    }
  } finally {
    rmSync(lock, { force: true, recursive: true });
  }
} catch (e) {
  console.error(`herdgate install: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
