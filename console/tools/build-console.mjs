import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectConsolePreflight } from "./preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(root, "..");
const output = path.join(root, "dist");
const requiredAssets = ["index.html", "notices/LICENSE", "notices/THIRD_PARTY_NOTICES.md"];
const runtimeMimeTypes = new Set([
  "text/html; charset=utf-8", "text/css; charset=utf-8", "text/javascript; charset=utf-8",
  "application/javascript; charset=utf-8", "application/json; charset=utf-8", "image/svg+xml",
  "image/png", "image/jpeg", "image/webp", "image/gif", "font/woff2", "font/woff",
]);
const forbiddenBuildPatterns = [
  /navigator\.serviceWorker|serviceWorker\.register\s*\(/i,
  /https?:\\?\/\\?\/(?:app\.)?ovis\.sh/i,
  /\/api\/(?:health|machines)(?:[/?"'`]|$)/,
  /\/ws\?machine_id=/,
];

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  })[extension] ?? "application/octet-stream";
}

async function listFiles(directory, prefix = "") {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`build output contains a symlink: ${relative}`);
    if (entry.isDirectory()) results.push(...await listFiles(full, relative));
    else if (entry.isFile()) results.push({ relative, full });
    else throw new Error(`unsupported build output entry: ${relative}`);
  }
  return results;
}

export async function createAssetAllowlist(distDirectory) {
  const outputFiles = await listFiles(distDirectory);
  const files = {};
  for (const entry of outputFiles.sort((a, b) => a.relative.localeCompare(b.relative, "en"))) {
    if (entry.relative === "manifest.json") continue;
    const relative = entry.relative.split(path.sep).join("/");
    if (relative.startsWith("assets/") && !/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.basename(relative))) {
      throw new Error(`asset is not content-hashed: ${relative}`);
    }
    const type = contentType(relative);
    if (!runtimeMimeTypes.has(type)) {
      if (relative.startsWith("assets/")) throw new Error(`asset MIME type is not supported by Console runtime: ${relative} (${type})`);
      continue;
    }
    files[relative] = { path: relative, type };
  }
  for (const required of requiredAssets) {
    if (!outputFiles.some((entry) => entry.relative === required)) throw new Error(`required Console build file missing: ${required}`);
  }
  if (!files["index.html"]) throw new Error("runtime manifest is missing index.html");
  if (!Object.keys(files).some((asset) => asset.startsWith("assets/") && asset.endsWith(".js"))) {
    throw new Error("Console build is missing its JavaScript bundle");
  }
  const manifest = { version: 1, index: "index.html", files };
  await writeFile(path.join(distDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

export async function verifyBuildOutput(distDirectory) {
  const manifest = await createAssetAllowlist(distDirectory);
  for (const [urlPath, entry] of Object.entries(manifest.files)) {
    if (!/\.(?:html|js|css)$/.test(urlPath)) continue;
    const text = await readFile(path.join(distDirectory, entry.path), "utf8");
    for (const pattern of forbiddenBuildPatterns) {
      if (pattern.test(text)) throw new Error(`forbidden upstream/PWA boot reference in built asset: ${urlPath}`);
    }
  }
  const html = await readFile(path.join(distDirectory, "index.html"), "utf8");
  if (!html.includes('src="/assets/') || html.includes("/src/pwa.ts") || /https?:\/\//i.test(html)) {
    throw new Error("built shell is not a local root-only Console entrypoint");
  }
  return manifest;
}

export function sandboxArgs({ repositoryPath, consolePath, distPath, nodePath, vitePath }) {
  const worktree = "/tmp/herdgate-console-sandbox/repo";
  const relative = (input) => {
    const result = path.relative(repositoryPath, input);
    if (!result || result === ".." || result.startsWith(`..${path.sep}`) || path.isAbsolute(result)) throw new Error("sandbox path escapes the worktree");
    return result.split(path.sep).join("/");
  };
  const sandboxConsole = `${worktree}/${relative(consolePath)}`;
  const sandboxDist = `${worktree}/${relative(distPath)}`;
  const sandboxVite = `${worktree}/${relative(vitePath)}`;
  const sandboxNode = "/tmp/herdgate-console-sandbox/tools/node";
  const sandboxRoot = "/tmp/herdgate-console-sandbox";
  const sourceWeb = path.join(repositoryPath, "src/console/web");
  const sandboxSourceWeb = `${worktree}/src/console/web`;
  const args = [
    "--die-with-parent", "--new-session", "--unshare-net",
    "--ro-bind", "/", "/",
    "--tmpfs", "/tmp", "--dir", sandboxRoot, "--dir", worktree,
    // Mount only the console build tree and the typed API seam, not the repository (or its .env files).
    "--ro-bind", consolePath, sandboxConsole,
    "--dir", `${worktree}/src`, "--dir", `${worktree}/src/console`,
    "--ro-bind", sourceWeb, sandboxSourceWeb,
    "--bind", distPath, sandboxDist,
    "--dir", `${sandboxRoot}/tools`,
    "--ro-bind", nodePath, sandboxNode,
    "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/run",
    "--dir", "/tmp/herdgate-console-home", "--dir", "/tmp/herdgate-console-empty-env", "--dir", "/tmp/herdgate-console-vite-cache",
    "--proc", "/proc", "--dev", "/dev",
    "--chdir", sandboxConsole, "--clearenv",
    "--setenv", "PATH", `${sandboxRoot}/tools:/usr/bin:/bin`,
    "--setenv", "HOME", "/tmp/herdgate-console-home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LC_ALL", "C",
    "--setenv", "LANG", "C",
    "--setenv", "NODE_ENV", "production",
    "--setenv", "CI", "1",
    "--setenv", "NPM_CONFIG_USERCONFIG", "/dev/null",
    "--", sandboxNode, sandboxVite, "build", "--config", `${sandboxConsole}/vite.config.ts`, "--configLoader", "runner",
  ];
  return args;
}

async function main() {
  const report = await inspectConsolePreflight(new URL("../../", import.meta.url));
  if (!report.buildReady) {
    process.stderr.write(`${JSON.stringify({ error: "console_build_blocked", report }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "linux") throw new Error("Console builds require Linux bubblewrap sandboxing in this S1 toolchain");
  const sandbox = spawnSync("bwrap", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
  if (sandbox.status !== 0) throw new Error("bubblewrap is required; refusing an unsandboxed Console build");
  const vendor = path.join(root, "vendor/ovis");
  const vite = path.join(vendor, "node_modules/vite/bin/vite.js");
  const node = process.execPath;
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const outputStat = await lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("unsafe Console output directory");
  try {
    const args = sandboxArgs({ repositoryPath: repository, consolePath: root, distPath: output, nodePath: node, vitePath: vite });
    const result = spawnSync("bwrap", args, { stdio: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sandboxed Vite build failed (status ${result.status ?? "unknown"})`);
    const manifest = await verifyBuildOutput(output);
    process.stdout.write(`Built ${Object.keys(manifest.files).length} runtime-allowlisted files at console/dist (loopback app base /).\n`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
