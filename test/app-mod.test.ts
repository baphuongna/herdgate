/**
 * The Herdr app mod: manifest shape, and a real `herdr-app check`.
 *
 * `herdr-app check <mod folder>` is Herdr's own validator (docs/mods.md): it loads the
 * mod once and reports what is wrong. The app is not on every machine, so that part of
 * the suite is skipped when the binary is missing — the manifest assertions are not.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);
const MOD = new URL("../app-mod/herdgate/", import.meta.url).pathname;

const manifest = JSON.parse(readFileSync(join(MOD, "mod.json"), "utf8"));
const source = readFileSync(join(MOD, "main.js"), "utf8");

test("mod.json: places the panel the way Herdr expects", () => {
  assert.ok(["right", "left", "top", "bottom", "none"].includes(manifest.place), "place is one Herdr knows");
  assert.equal(typeof manifest.size, "number");
  assert.equal(manifest.title, "herdgate");
});

test("main.js: uses only documented mod surfaces", () => {
  // Imports must come from the three modules Herdr provides.
  const imports = [...source.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)].map((m) => ({
    names: m[1].split(",").map((s) => s.trim()).filter(Boolean),
    from: m[2],
  }));
  for (const i of imports) {
    assert.ok(["gpui-kit", "gpui-base", "herdr"].includes(i.from), `unexpected import from "${i.from}"`);
  }
  const fromHerdr = imports.find((i) => i.from === "herdr")?.names ?? [];
  for (const name of fromHerdr) {
    assert.ok(
      ["exec", "appHome", "readTextFile", "notify", "theme", "props", "closeOverlay", "run", "shared"].includes(name),
      `"${name}" is not a documented export of the herdr module`,
    );
  }

  // The runtime has no Node globals: a mod that reaches for them dies at load.
  for (const banned of ["process.", "require(", "setTimeout(", "__dirname"]) {
    assert.ok(!source.includes(banned), `"${banned}" does not exist in the mod runtime`);
  }
  // Timers must come from the app's clock, never a global.
  assert.match(source, /cx\.timer\.(after|every)\(/);

  // Secrets are written 0600 through sh; writeTextFile cannot set a mode.
  assert.match(source, /umask 077/);
  // Nothing is interpolated into a shell script: argv is passed positionally.
  assert.ok(!/exec\("sh", \["-c", `/.test(source), "no template-built shell scripts");
});

test("main.js: the token never leaves the config dir, and never in the plugin root", () => {
  assert.match(source, /config\/herdgate\.env/, "the token goes to the plugin config dir");
  assert.match(source, /HERDGATE_ROOM_TOKEN=/, "written in the format the publisher reads");
  assert.ok(!source.includes("localStorage.setItem"), "the token is not kept in localStorage");
});

const herdrApp = ["herdr-app", join(homedir(), ".local/bin/herdr-app")].find((p) => existsSync(p));

test("herdr-app check: Herdr's own validator accepts the mod", { skip: !herdrApp && "herdr-app is not installed" }, async () => {
  const { stdout, stderr } = await run(herdrApp!, ["check", MOD], { timeout: 120_000 });
  assert.match(`${stdout}${stderr}`, /check passed/);
});
