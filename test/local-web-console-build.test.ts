import test from "node:test";
import assert from "node:assert/strict";
import { inspectConsolePreflight } from "../console/tools/preflight.mjs";
import { assertRealNodeModules, CONSOLE_CSP, createAssetAllowlist, sandboxArgs, verifyBuildOutput } from "../console/tools/build-console.mjs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = new URL("../", import.meta.url);

test("preflight reports pinned toolchain, complete package/cache inventory, and consistent blockers", async () => {
  const report = await inspectConsolePreflight(root);
  assert.equal(report.requiredNode, "v22.23.5 (spec requirement >=22)");
  assert.equal(report.requiredBun, "1.4.4");
  assert.equal(report.actualNode, process.version);
  assert.equal(typeof report.actualBun === "string" || report.actualBun === null, true);
  assert.equal(typeof report.cache.entryCount, "number");
  assert.equal(typeof report.cache.bytes, "number");
  assert.ok(report.lock.present);
  assert.ok(report.lock.frozenInstallSupported);
  assert.equal(report.packageCount, report.missingPackages.length + report.installedPackages.length);
  assert.equal(report.buildReady, report.blockers.length === 0);
});

test("preflight emits provisioning instructions without running an install or lifecycle script", async () => {
  const report = await inspectConsolePreflight(root);
  assert.match(report.preloadCommand, /--frozen-lockfile/);
  assert.match(report.preloadCommand, /--ignore-scripts/);
  assert.match(report.preloadCommand, /--unshare-net/);
  assert.equal(report.installAttempted, false);
  assert.equal(report.credentialsUsed, false);
});

test("build preflight rejects symlinked node_modules with an actionable sandbox error", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "herdgate-console-node-modules-"));
  try {
    const real = path.join(temp, "real-node-modules");
    const link = path.join(temp, "node_modules");
    await mkdir(real);
    await symlink(real, link);
    await assert.rejects(assertRealNodeModules(link), /requires a real vendor\/ovis\/node_modules directory; symlinks are not supported/);
    await assert.doesNotReject(assertRealNodeModules(real));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("build sandbox clears environment and user homes and denies networking", () => {
  const args = sandboxArgs({
    repositoryPath: "/home/bom/source/worktree",
    consolePath: "/home/bom/source/worktree/console",
    distPath: "/home/bom/source/worktree/console/dist",
    nodePath: "/home/bom/.nvm/versions/node/v22.23.5/bin/node",
    vitePath: "/home/bom/source/worktree/console/vendor/ovis/node_modules/vite/bin/vite.js",
  });
  assert.ok(args.includes("--unshare-net"));
  assert.ok(args.includes("--clearenv"));
  assert.ok(args.includes("--tmpfs") && args.includes("/home"));
  assert.ok(args.includes("/root"));
  assert.ok(!args.includes("--ro-bind /home /home"));
  const outputBind = args.indexOf("--bind");
  assert.equal(args[outputBind + 1], "/home/bom/source/worktree/console/dist");
  assert.equal(args[outputBind + 2], "/tmp/herdgate-console-sandbox/repo/console/dist");
  assert.ok(!args.includes("/home/bom/source/worktree"));
  const viteIndex = args.lastIndexOf("/tmp/herdgate-console-sandbox/tools/node");
  assert.deepEqual(args.slice(viteIndex + 2), [
    "build", "--config", "/tmp/herdgate-console-sandbox/repo/console/vite.config.ts", "--configLoader", "runner",
  ]);
});

test("build emits the Console manifest schema and allowlists only supported assets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "herdgate-console-build-test-"));
  try {
    await mkdir(path.join(temp, "assets"));
    await mkdir(path.join(temp, "notices"));
    await writeFile(path.join(temp, "index.html"), `<html><meta http-equiv="Content-Security-Policy" content="${CONSOLE_CSP}"><script type="module" src="/assets/app-a1b2c3d4.js"></script></html>`);
    await writeFile(path.join(temp, "assets", "app-a1b2c3d4.js"), "console.log('fixture')");
    await writeFile(path.join(temp, "notices", "LICENSE"), "fixture license");
    await writeFile(path.join(temp, "notices", "THIRD_PARTY_NOTICES.md"), "fixture notices");
    const expected = JSON.parse(await readFile(new URL("./fixtures/local-web-console-runtime-manifest.json", import.meta.url), "utf8"));
    const manifest = await createAssetAllowlist(temp);
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(expected).sort());
    assert.equal(manifest.version, expected.version);
    assert.equal(manifest.index, expected.index);
    assert.deepEqual(Object.keys(manifest.files).sort(), ["assets/app-a1b2c3d4.js", "index.html", "notices/LICENSE", "notices/THIRD_PARTY_NOTICES.md"]);
    assert.equal(manifest.files["notices/LICENSE"].type, "text/plain; charset=utf-8");
    assert.equal(manifest.files["notices/THIRD_PARTY_NOTICES.md"].type, "text/markdown; charset=utf-8");
    for (const entry of Object.values(manifest.files)) {
      assert.deepEqual(Object.keys(entry).sort(), ["path", "type"]);
      assert.ok(["text/html; charset=utf-8", "text/javascript; charset=utf-8", "text/css; charset=utf-8", "text/plain; charset=utf-8", "text/markdown; charset=utf-8", "font/woff2", "image/svg+xml", "image/png"].includes(entry.type));
    }
    assert.deepEqual(Object.keys(manifest.files["index.html"]).sort(), Object.keys(expected.files["index.html"]).sort());
    assert.deepEqual(JSON.parse(await readFile(path.join(temp, "manifest.json"), "utf8")), manifest);
    assert.equal(Object.keys((await verifyBuildOutput(temp)).files).length, Object.keys(manifest.files).length);
    await writeFile(path.join(temp, "assets", "app-a1b2c3d4.js"), "navigator.serviceWorker.register('/sw.js')");
    await assert.rejects(verifyBuildOutput(temp), /forbidden upstream\/PWA boot reference/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
