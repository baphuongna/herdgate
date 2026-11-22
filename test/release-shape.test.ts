import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import test from "node:test";

const PLUGIN = join(import.meta.dirname, "..", "plugin", "server");

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

// And the npm file list must cover everything plugin/server needs transitively.
test("npm files list covers plugin/server", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const shipped = pkg.files.join("\n");
  assert.match(shipped, /plugin\/server\/\*\.mjs/);
});
