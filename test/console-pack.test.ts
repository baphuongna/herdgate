import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { assertConsolePackContents } from "../scripts/console-pack.mjs";
import { startFixtureRuntime } from "./fixtures/local-web-console-runtime/runtime.mjs";

const ROOT = join(import.meta.dirname, "..");

const FIXTURE = join(import.meta.dirname, "fixtures", "local-web-console-runtime", "dist");
function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "console-pack-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function copyDist(root: string) {
  const dist = join(root, "console", "dist");
  mkdirSync(join(root, "console"), { recursive: true });
  cpSync(FIXTURE, dist, { recursive: true });
  return dist;
}
function pathsUnder(dist: string) {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    return entry.isDirectory() ? walk(abs) : entry.isFile() ? [abs] : [];
  });
  return walk(dist).map((file) => `package/console/dist/${relative(dist, file).split(sep).join("/")}`);
}
function getWithHost(url: string, host: string) {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = http.get({ host: target.hostname, port: Number(target.port), path: target.pathname, headers: { host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
  });
}

test("pack validator accepts manifest files, manifest, and both notices", (t) => {
  const dist = copyDist(scratch(t));
  const result = assertConsolePackContents(pathsUnder(dist), dist);
  assert.equal(result.requiredFiles.length, 5);
  assert.ok(result.requiredFiles.includes("console/dist/manifest.json"));
});

test("pack validator fails closed when dist is missing", (t) => {
  const root = scratch(t);
  assert.throws(() => assertConsolePackContents([], join(root, "missing")), { code: "console_dist_missing" });
});

test("pack validator fails closed on a malformed manifest", (t) => {
  const dist = copyDist(scratch(t));
  writeFileSync(join(dist, "manifest.json"), "{");
  assert.throws(() => assertConsolePackContents(pathsUnder(dist), dist), { code: "console_manifest_invalid" });
});

test("pack validator requires manifest.json in the tarball", (t) => {
  const dist = copyDist(scratch(t));
  const paths = pathsUnder(dist).filter((path) => !path.endsWith("manifest.json"));
  assert.throws(() => assertConsolePackContents(paths, dist), { code: "console_pack_missing_manifest" });
});

test("pack validator rejects a manifest asset missing from the tarball", (t) => {
  const dist = copyDist(scratch(t));
  const paths = pathsUnder(dist).filter((path) => !path.endsWith("assets/console.fixture.js"));
  assert.throws(() => assertConsolePackContents(paths, dist), { code: "console_pack_missing_file" });
});

test("pack validator rejects required notices missing from the tarball", (t) => {
  const dist = copyDist(scratch(t));
  const paths = pathsUnder(dist).filter((path) => !path.endsWith("notices/THIRD_PARTY_NOTICES.md"));
  assert.throws(() => assertConsolePackContents(paths, dist), { code: "console_pack_missing_notice" });
});

test("pack validator rejects either vendor or frontend source in the tarball", (t) => {
  const dist = copyDist(scratch(t));
  const paths = pathsUnder(dist);
  for (const forbidden of ["package/console/vendor/ovis/package.json", "package/console/src/main.ts", "package/console/tools/build-console.mjs"]) {
    assert.throws(() => assertConsolePackContents([...paths, forbidden], dist), { code: "console_pack_contains_source" });
  }
});

test("packed npm install boots Console from a clean unpacked tarball with only the runtime fixture", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows Console lifecycle remains intentionally blocked pending live verification");
    return;
  }
  const root = scratch(t);
  const packDir = join(root, "packs");
  const extractDir = join(root, "clean-install");
  const state = join(root, "state");
  const runtimePath = join(root, "runtime.sock");
  mkdirSync(packDir);
  mkdirSync(extractDir);
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(pack.status, 0, pack.stderr);
  const archiveName = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  assert.ok(archiveName, "npm pack must create a real .tgz");
  const archive = join(packDir, archiveName);
  execFileSync("tar", ["-xzf", archive, "-C", extractDir]);
  const packageRoot = join(extractDir, "package");
  const tarPaths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const realDist = join(ROOT, "console", "dist");
  if (existsSync(join(realDist, "manifest.json"))) {
    assertConsolePackContents(tarPaths, realDist);
  } else {
    // No Bun-built artifact in this checkout: install the isolated fixture into the unpacked package.
    mkdirSync(join(packageRoot, "console"), { recursive: true });
    cpSync(FIXTURE, join(packageRoot, "console", "dist"), { recursive: true });
  }
  for (const path of ["bin/herdgate.mjs", "bin/console.mjs", "bin/console-server.mjs", "bin/console-service.mjs", "bin/console-rpc.mjs"]) {
    assert.ok(existsSync(join(packageRoot, path)), `${path} must be in the unpacked package`);
  }
  assert.equal(existsSync(join(packageRoot, "console/vendor")), false, "npm install must not need Ovis vendor dependencies");

  const runtime = await startFixtureRuntime(runtimePath, {
    snapshot: { version: "fixture", protocol: 1, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] },
  });
  const env: NodeJS.ProcessEnv = { ...process.env, HERDGATE_CONSOLE_STATE_DIR: state, HERDGATE_CONSOLE_RPC_SOCKET: runtimePath };
  delete env.HERDGATE_CONSOLE_ASSET_DIR;
  const run = (...args: string[]) => spawnSync(process.execPath, [join(packageRoot, "bin/herdgate.mjs"), "console", ...args], { env, encoding: "utf8", timeout: 10_000 });
  const runAsync = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, "bin/herdgate.mjs"), "console", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
  t.after(async () => {
    if (existsSync(join(state, "instance.json"))) run("stop");
    await runtime.close();
  });
  const started = await runAsync("start");
  assert.equal(started.status, 0, started.stderr);
  const status = await runAsync("status", "--json");
  assert.equal(status.status, 0, status.stderr);
  const { address } = JSON.parse(status.stdout) as { address: string };
  const shell = await fetch(`${address}/`);
  assert.equal(shell.status, 200);
  const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; manifest-src 'none'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  assert.equal(shell.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal((await fetch(`${address}/api/console/v1/session`)).status, 401);
  assert.equal(await getWithHost(address, "evil.example"), 403);

  const login = run("login");
  assert.equal(login.status, 0, login.stderr);
  const code = /expires in 120s\): ([0-9a-f]{64})/.exec(login.stdout)?.[1];
  assert.ok(code);
  const redeemed = await fetch(`${address}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { origin: address, "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
  assert.equal(redeemed.status, 200);
  const stopped = run("stop");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(existsSync(join(packageRoot, "console/vendor")), false);
});
