// C11 — loop boot path: the boot text must survive every shell herdr might
// spawn a pane in (POSIX sh, PowerShell, cmd.exe). boot.mjs is the pure seam:
// one cross-shell default (pi reads the prompt file through its @file arg —
// a plain quoted path, no command substitution), plus an owner escape hatch
// (bootCommand) for any shell or agent we didn't plan for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const BOOT = join(import.meta.dirname, "..", "plugin", "loop", "server", "boot.mjs");
const { buildBoot, bootText, validateBootCommand } = await import(BOOT);

const cfg = (over = {}) => ({ cwd: "/home/x/proj", promptFile: "/home/x/proj/.loop/prompt.md", ...over });

test("boot default: one template that no shell has to interpret", () => {
  const text = buildBoot(cfg());
  // A quoted path argument is passed verbatim by POSIX sh, PowerShell
  // (quotes neutralize @ splatting) and cmd.exe alike. No $( ), no cd /d,
  // no bare @word — the constructs that made the old boot POSIX-only.
  assert.equal(text, 'pi "@/home/x/proj/.loop/prompt.md"');
  assert.equal(bootText(cfg()), text + "\r", "Enter is appended by the plugin, never the template");
});

test("boot override: the owner's template wins, placeholders substituted", () => {
  assert.equal(
    buildBoot(cfg({ bootCommand: "cd {cwd} && my-agent --file {promptFile}" })),
    "cd /home/x/proj && my-agent --file /home/x/proj/.loop/prompt.md",
  );
  // No placeholders required: booting a different agent is the owner's call.
  assert.equal(buildBoot(cfg({ bootCommand: "pi --version" })), "pi --version");
});

test("boot override validation: fail closed on anything untypeable", () => {
  assert.equal(validateBootCommand(undefined), null, "optional field");
  assert.equal(validateBootCommand("pi @f"), null);
  for (const bad of ["", "x".repeat(501), "pi foo\r", "pi foo\n", 42, null, { tpl: 1 }]) {
    const err = validateBootCommand(bad);
    assert.ok(typeof err === "string" && err.includes("bootCommand"), `must reject ${JSON.stringify(bad)}`);
  }
  assert.match(validateBootCommand("x".repeat(501)), /1-500/);
  assert.match(validateBootCommand("pi foo\r"), /newline|Enter/i);
});

test("boot dependency is declared: loop manifest requires the herdr that owns tab cwd", () => {
  // The boot has no `cd` in it: the pane must be BORN in cfg.cwd, which
  // tab.create only honors since herdr 0.9.5 (TabCreateParams.cwd, schema
  // protocol 22). The manifest must not promise more than that.
  const manifest = readFileSync(join(import.meta.dirname, "..", "plugin", "loop", "herdr-plugin.toml"), "utf8");
  const m = manifest.match(/^min_herdr_version = "([^"]+)"$/m);
  assert.ok(m, "manifest declares min_herdr_version");
  const [maj, min] = m[1].split(".").map(Number);
  assert.ok(maj > 0 || min >= 5, `min_herdr_version ${m[1]} must be >= 0.9.5 (tab.create cwd)`);
});
