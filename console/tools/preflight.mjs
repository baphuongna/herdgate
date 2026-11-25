import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const safeEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), LC_ALL: "C" });

function bunPath() {
  try { return execFileSync("which", ["bun"], { encoding: "utf8", timeout: 3_000, env: safeEnv() }).trim() || null; }
  catch { return null; }
}

function bunVersion(binary) {
  if (!binary) return null;
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 3_000, env: safeEnv() }).trim();
  } catch { return null; }
}

async function cacheInventory(cachePath) {
  let bytes = 0;
  let entryCount = 0;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        entryCount += 1;
        try { bytes += (await stat(file)).size; } catch { /* cache may be concurrently pruned */ }
      }
    }
  }
  await walk(cachePath);
  return { path: cachePath, entryCount, bytes };
}

async function readInstalledVersion(nodeModules, name) {
  try {
    const pkg = JSON.parse(await readFile(path.join(nodeModules, name, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch { return null; }
}

export async function inspectConsolePreflight(rootUrl) {
  const root = fileURLToPath(rootUrl);
  const vendor = path.join(root, "console/vendor/ovis");
  const packagePath = path.join(vendor, "package.json");
  const lockPath = path.join(vendor, "bun.lock");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const lockText = await readFile(lockPath, "utf8");
  // Bun's JSON lock format permits trailing commas; parse only after removing those delimiters.
  const lock = JSON.parse(lockText.replace(/,\s*([}\]])/g, "$1"));
  const lockRoot = lock.workspaces?.[""];
  const dependenciesMatch = ["dependencies", "devDependencies"].every((kind) => {
    const manifest = packageJson[kind] ?? {};
    const locked = lockRoot?.[kind] ?? {};
    return Object.keys(manifest).length === Object.keys(locked).length
      && Object.entries(manifest).every(([name, version]) => locked[name] === version);
  });
  const requiredBun = String(packageJson.packageManager ?? "").replace(/^bun@/, "");
  const actualBunPath = bunPath();
  const actualBun = bunVersion(actualBunPath);
  const actualNode = process.version;
  const nodeModules = path.join(vendor, "node_modules");
  const packageSpecs = Object.entries({ ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) });
  const packages = await Promise.all(packageSpecs.map(async ([name, required]) => ({
    name,
    required,
    installed: await readInstalledVersion(nodeModules, name),
  })));
  const missingPackages = packages.filter((pkg) => pkg.installed === null).map((pkg) => `${pkg.name}@${pkg.required}`);
  const cache = await cacheInventory(path.join(os.homedir(), ".bun/install/cache"));
  const lockBytes = Buffer.byteLength(lockText);
  const lockHash = createHash("sha256").update(lockText).digest("hex");
  const buildEntry = path.join(root, "console/src/entry.tsx");
  const viteConfig = path.join(root, "console/vite.config.ts");
  const buildReady = actualNode === "v22.23.5" && actualBun === requiredBun && dependenciesMatch
    && missingPackages.length === 0 && await stat(buildEntry).then(() => true, () => false)
    && await stat(viteConfig).then(() => true, () => false);
  const blockers = [];
  if (!actualNode.startsWith("v22.")) blockers.push("node-version-not-22");
  else if (actualNode !== "v22.23.5") blockers.push("node-version-not-pinned-22.23.5");
  if (actualBun !== requiredBun) blockers.push("bun-version-mismatch");
  if (!dependenciesMatch) blockers.push("lock-manifest-mismatch");
  if (missingPackages.length) blockers.push("frontend-dependencies-missing");
  if (!await stat(buildEntry).then(() => true, () => false)) blockers.push("console-entrypoint-missing");
  if (!await stat(viteConfig).then(() => true, () => false)) blockers.push("console-vite-config-missing");

  const preloadCommand = `mkdir -p <worktree>/console/vendor/ovis/node_modules <private-preloaded-cache> && bwrap --unshare-net --die-with-parent --ro-bind / / --tmpfs /tmp --dir /tmp/herdgate-preload --dir /tmp/herdgate-preload/worktree --dir /tmp/herdgate-preload/cache --dir /tmp/herdgate-preload/tools --ro-bind <worktree> /tmp/herdgate-preload/worktree --bind <worktree>/console/vendor/ovis/node_modules /tmp/herdgate-preload/worktree/console/vendor/ovis/node_modules --bind <private-preloaded-cache> /tmp/herdgate-preload/cache --ro-bind <approved-bun-1.4.4-binary> /tmp/herdgate-preload/tools/bun --tmpfs /home --tmpfs /root --tmpfs /run --dir /tmp/herdgate-preload/home --chdir /tmp/herdgate-preload/worktree/console/vendor/ovis --clearenv --setenv PATH /tmp/herdgate-preload/tools:/usr/bin:/bin --setenv HOME /tmp/herdgate-preload/home --setenv LC_ALL C -- /tmp/herdgate-preload/tools/bun install --frozen-lockfile --ignore-scripts --cache-dir=/tmp/herdgate-preload/cache`;
  return {
    requiredNode: "v22.23.5 (spec requirement >=22)",
    actualNode,
    nodeOk: actualNode === "v22.23.5",
    requiredBun,
    actualBun,
    actualBunPath,
    bunOk: actualBun === requiredBun,
    lock: { present: true, lockfileVersion: lock.lockfileVersion, bytes: lockBytes, sha256: lockHash, manifestMatches: dependenciesMatch, frozenInstallSupported: dependenciesMatch && lock.lockfileVersion === 2 },
    cache: { ...cache, contents: "opaque Bun cache entries; no package names inferred" },
    packageCount: packages.length,
    missingPackages,
    installedPackages: packages.filter((pkg) => pkg.installed !== null),
    buildReady,
    blockers,
    preloadCommand,
    installAttempted: false,
    credentialsUsed: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL("../../", import.meta.url);
  const report = await inspectConsolePreflight(root);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.buildReady) process.exitCode = 2;
}
