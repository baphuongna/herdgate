import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "plugin", "server");
const WEB = join(ROOT, "src", "web");
const CONSOLE_DIST = join(ROOT, "console", "dist");
const ASSET = /\.(html|js|css|webmanifest|svg|png)$/;

// Shipped code must be self-contained: nothing under plugin/server may import
// from outside the shipped tree (experiments/, docs/, test/). The npm "files"
// list ships plugin/** and src/** — an import escaping them breaks every
// install from npm (the 0.9.39 laptop rollback: pi-wake imported
// experiments/pi-spawn/registry.mjs and the publisher crashed at load).
test("plugin/server modules never import from outside the shipped tree", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(PLUGIN).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(PLUGIN, f), "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const spec = m[1];
      // plugin/server may reach sibling files and nothing else (src/host is
      // bundled into the release separately by build scripts).
      const depth = spec.split("/").filter((p) => p === "..").length;
      if (depth >= 2) offenders.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "imports escaping plugin/ break the npm install");
});

// The gate serves the PWA and /admin from src/web beside its entry point, on every
// install from npm. `files` is a whitelist, so a page listed nowhere is a 404
// on npm installs while the repo tests stay green (caught before the 0.14.0
// publish: admin.js/.css shipped through the *.js/*.css globs, admin.html did
// not). The tarball listing is the source of truth, not a regex over `files`.
// Versioned install bundles (herdgate-win-*.zip, *.tgz) sit beside the sources
// and are dropped on purpose via src/web/.npmignore — they are not assets.
test("npm tarball ships every asset under src/web, the admin page included", { timeout: 60_000 }, () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const packed = new Set((JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const abs = join(dir, e.name);
    return e.isDirectory() ? walk(abs) : e.isFile() ? [abs] : [];
  });
  const missing = walk(WEB)
    .filter((p) => ASSET.test(p))
    .map((p) => `src/web/${relative(WEB, p)}`)
    .filter((p) => !packed.has(p));
  assert.deepEqual(missing, [], "assets under src/web that the npm tarball would drop");
  for (const p of ["src/web/index.html", "src/web/admin.html", "src/web/admin.js", "src/web/sw.js", "src/web/icons/icon-192.png"]) {
    assert.ok(packed.has(p), `${p} must be in the npm tarball`);
  }
});

// And the npm file list must cover everything plugin/server needs transitively.
test("npm files list covers plugin/server", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const shipped = pkg.files.join("\n");
  assert.match(shipped, /plugin\/server\/\*\.mjs/);
});

// The mirror plugin ships its own manifest and server — same self-containment
// rule, same coverage check. Nothing under plugin/mirror reaches outside.
test("npm tarball wires Console runtime and excludes vendor/build source", { timeout: 60_000 }, (t) => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const packed = (JSON.parse(out)[0].files as { path: string }[]).map((file) => file.path);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("console/dist/**"), "the npm allowlist must carry the built Console dist only");
  assert.equal(pkg.scripts["build:console"], "node console/tools/build-console.mjs");
  assert.ok(!pkg.files.some((pattern: string) => /^console\/(?:vendor|src|tools)(?:\/|$)/.test(pattern)), "Console sources and tools must not enter the package allowlist");
  for (const path of ["bin/console.mjs", "bin/console-server.mjs", "bin/console-service.mjs", "bin/console-rpc.mjs"]) {
    assert.ok(packed.includes(path), `${path} must be present in the tarball`);
  }
  assert.ok(!packed.some((path) => /^console\/(vendor|src|tools)(\/|$)/.test(path)), "vendor, source and build tools stay out of the runtime package");

  const manifestPath = join(CONSOLE_DIST, "manifest.json");
  if (!existsSync(manifestPath)) {
    t.skip("console/dist is not present in this clean checkout; build:console requires the separately staged Bun 1.4.4 toolchain");
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, { path: string }> };
  const required = new Set([
    "console/dist/manifest.json",
    "console/dist/notices/LICENSE",
    "console/dist/notices/THIRD_PARTY_NOTICES.md",
    ...Object.values(manifest.files).map((entry) => `console/dist/${entry.path}`),
  ]);
  for (const path of required) assert.ok(packed.includes(path), `${path} from the built Console dist must be in the tarball`);
});

test("plugin/mirror is self-contained and shipped", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.match(pkg.files.join("\n"), /plugin\/mirror\/herdr-plugin\.toml/);
  assert.match(pkg.files.join("\n"), /plugin\/mirror\/server\/\*\.mjs/);
  const mirrorDir = join(import.meta.dirname, "..", "plugin", "mirror", "server");
  for (const f of readdirSync(mirrorDir).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(mirrorDir, f), "utf8");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
      const target = join(mirrorDir, m[1]);
      assert.ok(existsSync(target), `plugin/mirror/server/${f} imports ${m[1]} — must be a shipped sibling`);
    }
    assert.ok(!/from "(\.\.\/){2,}/.test(src), `plugin/mirror/server/${f} must not reach outside plugin/mirror`);
  }
});
