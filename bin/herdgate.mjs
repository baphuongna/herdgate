#!/usr/bin/env node
// herdgate CLI — brings a machine into the herd.
//
//   npx @bom0792/herdgate setup-host --cloud https://gate.example.com
//
// Installs the herdr-app mod and the publisher into the app's home, and
// prefills the panel's settings so the only thing left is Pair → Publish.
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { manageCloud, resolveCloud } from "./cloud-config.mjs";
import { trySyncPiSkills } from "./pi-skills.mjs";
import { readConfig } from "../plugin/server/common.mjs";
import { withLatest } from "../windows/npm-update.mjs";
import { windowsNode } from "../windows/node-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // <pkg>/bin
const ROOT = dirname(HERE); // <pkg>

const help = `herdgate — every machine, one herd

  herdgate install [--no-path]        Install the persistent Windows command (no publisher restart).
  herdgate pi-skills                   Sync the bundled skills into your Pi profile.
  herdgate cloud add <name> <https-url>
  herdgate cloud list
  herdgate cloud serve                Run a self-hosted Gate from the full npm package (uses HERDGATE_* env).
  herdgate pair --cloud <name>       Pair this machine with owner approval.
  herdgate setup [--cloud <name>] [--mobile-act <device-id>]
                                    Install/configure the publisher for this OS.
  herdgate migrate [--mobile-act <device-id> | --plain]
      Adopt an existing publisher without changing its cloud or pairing.
  herdgate start | stop | status | update
      Manage the publisher. Update fetches the latest npm release.

  Compatibility commands:
  herdgate setup-host [--cloud <url>] [--name <machine-name>] [--app-home <dir>]
      Install the herdr-app mod + publisher and prefill the panel settings.
      --cloud     your gate, e.g. https://gate.example.com      (required)
      --name      how this machine shows up on the phone        (default: hostname)
      --app-home  herdr-app home (default: the platform's usual one)
      --no-integrate  skip the tab-bar panel integration (pane.split still works)

  herdgate install-tui
      Install or update the per-user Windows TUI publisher. Does not start it.
  herdgate tui setup [path-to-herdr.exe] [--mobile-tui d_read | --mobile-tui-act d_act | --hc <exe>]
      Install, start and save the selected publisher mode (existing pairing required).
  herdgate tui update
      Install this npm version and restart only the publisher, preserving its mode.
  herdgate tui start [path-to-herdr.exe]
  herdgate tui status | stop | version | versions | use <release-id>
      Manage the installed publisher without adding it to PATH.
  herdgate home-tui setup [--adopt] | status | restart | stop
      Manage the Linux TUI publisher as a systemd user service.`;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 && process.argv[i + 1]) || fallback;
}

function appHome() {
  const forced = arg("app-home");
  if (forced) return forced;
  if (process.env.HERDR_APP_HOME) return process.env.HERDR_APP_HOME;
  // herdr-app keeps the same home everywhere: ~/.config/herdr-app ("Home:" line in
  // `herdr-app --help`) — Windows included.
  return join(homedir(), ".config", "herdr-app");
}

function setupHost() {
  const cloud = resolveCloud(arg("cloud"));
  checkCloud(cloud);
  const home = appHome();
  const name = arg("name") ?? hostname();

  const modSrc = join(ROOT, "app-mod", "herdgate");
  const pluginSrc = join(ROOT, "plugin");
  if (!existsSync(modSrc) || !existsSync(pluginSrc)) {
    console.error("herdgate: package assets missing (app-mod/, plugin/) — install the package, not a checkout");
    process.exit(1);
  }

  mkdirSync(join(home, "mods"), { recursive: true });
  cpSync(modSrc, join(home, "mods", "herdgate"), { recursive: true });
  const base = join(home, "herdgate");
  mkdirSync(base, { recursive: true });
  cpSync(pluginSrc, join(base, "plugin"), { recursive: true });
  // The --via transport for `hc machine add` when the SSH leg's TCP host is
  // unreachable from THIS machine (e.g. IPv4-only network vs an AAAA record):
  // it pipes the system ssh through wss on port 443. One stable path for --via.
  const viaSrc = join(ROOT, "templates", "herdgate-via.mjs");
  if (existsSync(viaSrc)) {
    mkdirSync(join(base, "bin"), { recursive: true });
    cpSync(viaSrc, join(base, "bin", "herdgate-via.mjs"));
  }

  // Prefill what the panel would otherwise ask for. The publisher is spawned from
  // <root>/plugin/server/index.mjs — keep root pinned to where we just put it.
  const settingsPath = join(base, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    /* first install */
  }
  settings.cloud = cloud;
  settings.root = base;
  settings.name = name;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log(`herdgate: installed for herdr-app at ${home}
  mod       → ${join(home, "mods", "herdgate")}
  publisher → ${join(base, "plugin", "server", "index.mjs")}
  via       → ${join(base, "bin", "herdgate-via.mjs")}
  settings  → ${settingsPath} (cloud: ${cloud}, name: ${name})

Next: open (or restart) herdr-app → herdgate panel → Pair, then approve the
code in the PWA (${cloud}) and click Publish. Requires node >= 22 on PATH
for the publisher (node -v).`);
  if (!arg("no-integrate")) integrate(home);
  // The other direction — THIS machine controlling one that is already paired —
  // needs one command. Print it ready to paste (cmd expands %USERPROFILE%).
  const viaPath = join(base, "bin", "herdgate-via.mjs");
  if (existsSync(viaPath)) {
    console.log(`
To connect FROM this machine to another machine in the herd (no admin,
works on IPv4-only networks — ssh over wss/443), first:
  ssh-keygen -t ed25519 -f "%USERPROFILE%\\.ssh\\herdgate" -N "" -q
and register the printed key in the PWA (machine → Public keys). Then:
  hc machine add --name home --via "node ${viaPath} --gate ${cloud} --user <device-id>"`);
  }
}

// ---- first-class panel: clone the main layout + tabs mod, add herdgate to both ----
//
// Shipped Herdr is read-only: the right-sidebar stack (panel-body) holds files and
// changes, and the tab-bar buttons for them are hardcoded in the shipped `tabs` mod.
// Herdr's own sanctioned escape hatch (see its AGENTS.md — and how the community
// gallery shares layouts) is cloning: `mod.clone` + `layout.clone` are yours and
// never overwritten. We clone `tabs` (one extra button) and `main` (herdgate joins
// panel-body), then switch to the clone. Everything is idempotent; if the anchors
// drift in a future Herdr, we warn and leave the app untouched — the panel still
// opens with `pane.split`.
function do_(args) {
  const r = spawnSync("herdr-app", ["do", ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** A clone the app rejects (version drift, a broken older patch) must never stay:
 *  verify, and on failure rebuild from the shipped mod and re-patch once. */
function verifyTabs(home, live) {
  const dir = join(home, "mods", "tabs-herdgate");
  const main = join(dir, "main.js");
  if (!existsSync(main)) return false;
  if (live) {
    const r = spawnSync("herdr-app", ["check", dir], { encoding: "utf8" });
    return r.status === 0 && !/failed|error/i.test(`${r.stdout}${r.stderr}`);
  }
  const r = spawnSync(process.execPath, ["--check", main], { encoding: "utf8" });
  return r.status === 0;
}

function integrate(home) {
  const probe = spawnSync("herdr-app", ["status"], { encoding: "utf8" });
  const live = probe.status === 0;
  // 1. clone the tabs mod and add our button. Live: the app's own command (it also
  // registers the clone). Offline: shipped mods are plain files — copy them; a
  // closed app reads the folder at start.
  let tabs = join(home, "mods", "tabs-herdgate", "main.js");
  if (existsSync(tabs) && !verifyTabs(home, live)) {
    console.log("herdgate: the existing tabs-herdgate does not load — rebuilding it from the shipped tabs mod");
    cpSync(join(home, "mods", "tabs"), join(home, "mods", "tabs-herdgate"), { recursive: true });
  }
  if (!existsSync(tabs)) {
    let ok = false;
    if (live) ok = do_(["mod.clone", JSON.stringify({ name: "tabs", as: "tabs-herdgate" })]).ok;
    if (!ok) cpSync(join(home, "mods", "tabs"), join(home, "mods", "tabs-herdgate"), { recursive: true });
    if (!existsSync(tabs)) return console.log("herdgate: could not clone the tabs mod — panel stays reachable via pane.split");
  }
  let src = readFileSync(tabs, "utf8");
  const anchor = `.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))`;
  // The exact line we insert — the idempotency marker. (An earlier build checked
  // for a different .when(…) string and never matched, so every re-install added
  // one more button — this marker is the inserted text itself.)
  const inserted = `.child(panelButton("herdgate", "herdgate", "mods/herdgate/herdgate.svg"))`;
  const marker = 'panelButton("herdgate"';
  // Repair old duplicates first: drop every inserted line, re-add exactly one.
  const dupes = src.split("\n").filter((l) => l.trim().startsWith(inserted)).length;
  let dropped = false;
  if (dupes > 1 || (dupes === 1 && src.includes(anchor))) {
    if (dupes > 1) console.log(`herdgate: removing ${dupes - 1} duplicate button(s) from earlier installs`);
    src = src.split("\n").filter((l) => !l.trim().startsWith(inserted)).join("\n");
    dropped = true;
  }
  let changed = false;
  if (src.includes(anchor) && !src.includes(marker)) {
    // Unconditional .child — no shared("workspace.panels") gate, no new imports:
    // the button exists on every Herdr version (older apps may lack setShared).
    src = src.replace(anchor, `${anchor}\n      ${inserted}`);
    src = src.replace(
      `const enabled = shared("workspace.panels") ?? ["files", "changes"];`,
      `const enabled = shared("workspace.panels") ?? ["files", "changes", "herdgate"];`,
    );
    changed = true;
  } else if (!src.includes(marker)) {
    console.log("herdgate: tabs mod anchors not found (Herdr version drift?) — button not added, pane.split still works");
  }
  if (dropped || changed) writeFileSync(tabs, src);
  if (changed && !verifyTabs(home, live)) {
    console.log("herdgate: the patched tabs clone does not load — retrying from a fresh copy");
    cpSync(join(home, "mods", "tabs"), join(home, "mods", "tabs-herdgate"), { recursive: true });
    const fresh = readFileSync(tabs, "utf8");
    if (fresh.includes(anchor)) {
      writeFileSync(tabs, fresh.replace(anchor, `${anchor}\n      ${inserted}`));
    }
    if (!verifyTabs(home, live)) {
      console.log("herdgate: still no — restoring the shipped tabs mod untouched (button not added; pane.split still works)");
      cpSync(join(home, "mods", "tabs"), join(home, "mods", "tabs-herdgate"), { recursive: true });
    }
  }

  // 2. clone the main layout, seat herdgate in panel-body, point the tab bar at the clone.
  const layoutPath = join(home, "layouts", "herdgate-main.json");
  if (!existsSync(layoutPath)) {
    let ok = false;
    if (live) ok = do_(["layout.clone", JSON.stringify({ name: "main", as: "herdgate-main" })]).ok;
    if (!ok) cpSync(join(home, "layouts", "main.json"), layoutPath);
    if (!existsSync(layoutPath)) return console.log("herdgate: could not create the herdgate-main layout");
  }
  const tree = JSON.parse(readFileSync(layoutPath, "utf8"));
  const find = (n, id) => {
    if (!n || typeof n !== "object") return null;
    if (n.id === id) return n;
    for (const c of n.children ?? []) { const hit = find(c, id); if (hit) return hit; }
    return null;
  };
  const body = find(tree, "panel-body");
  if (body) {
    body.children ??= [];
    if (!body.children.some((c) => c.id === "herdgate"))
      body.children.push({ id: "herdgate", type: "block", content: { mod: "herdgate" } });
  }
  const tabsBlock = find(tree, "tabs");
  if (tabsBlock?.content?.mod === "tabs") tabsBlock.content.mod = "tabs-herdgate";
  if (live) {
    const set = do_(["layout.set", JSON.stringify({ layout: tree })]);
    if (!set.ok) return console.log(`herdgate: layout.set failed (${set.out.slice(0, 120)})`);
    do_(["layout.switch", JSON.stringify({ name: "herdgate-main" })]);
  } else {
    // App closed: the files are ours to write. Switch the layout and join the panel
    // list directly (the tab-bar clone re-checks at load, this just makes it immediate).
    writeFileSync(layoutPath, JSON.stringify(tree, null, 1) + "\n");
    const sharedPath = join(home, "shared.json");
    let sh = {};
    try { sh = JSON.parse(readFileSync(sharedPath, "utf8")); } catch { /* none yet */ }
    sh.layout = "herdgate-main";
    const panels = Array.isArray(sh["workspace.panels"]) ? sh["workspace.panels"] : ["files", "changes"];
    if (!panels.includes("herdgate")) panels.push("herdgate");
    sh["workspace.panels"] = panels;
    writeFileSync(sharedPath, JSON.stringify(sh, null, 2) + "\n");
  }
  console.log("herdgate: panel button added to the tab bar (layout herdgate-main) — press it any time;");
  console.log("           the shipped layout `main` stays untouched (layout.switch main goes back).");
}

function runNode(file, args, env = process.env) {
  const child = spawnSync(process.execPath, [file, ...args], { env, stdio: "inherit", shell: false, windowsHide: true });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

function runInstalledTui(args, useSavedProfile = false) {
  if (!process.env.LOCALAPPDATA) throw new Error("the TUI publisher CLI is for Windows (%LOCALAPPDATA% is unset)");
  const root = join(process.env.LOCALAPPDATA, "Herdgate", "cli");
  const current = join(root, "current");
  if (!existsSync(current)) throw new Error("run herdgate install-tui first");
  const release = realpathSync(current);
  const releases = realpathSync(join(root, "releases"));
  const key = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  if (!/^tui-[a-f0-9]{16}$/.test(basename(release)) || key(dirname(release)) !== key(releases)) {
    throw new Error("current does not point to an installed release; rerun install-tui");
  }
  runNode(join(release, "windows", useSavedProfile ? "setup-tui.mjs" : "cli.mjs"), args);
}

function pairedConfig() {
  const base = join(appHome(), "herdgate");
  const config = join(base, "config");
  return { base, config, current: readConfig(join(config, "herdgate.env")) };
}
function checkCloud(origin) {
  const { current } = pairedConfig();
  if (current.HERDGATE_ROOM_TOKEN && origin && resolveCloud(current.HERDGATE_URL) !== origin) {
    throw new Error("this machine is already paired to another cloud; adding a cloud does not move a pairing");
  }
  return Boolean(current.HERDGATE_ROOM_TOKEN);
}
function cloudOption(args) {
  const out = [...args];
  const i = out.indexOf("--cloud");
  if (i < 0) return { options: out };
  const value = out[i + 1];
  if (!value || value.startsWith("--")) throw new Error("--cloud requires a configured name or HTTPS URL");
  out.splice(i, 2);
  if (out.includes("--cloud")) throw new Error("only one --cloud value is allowed");
  return { options: out, origin: resolveCloud(value) };
}
function pairHost(args) {
  const { options, origin } = cloudOption(args);
  if (!origin || options.length) throw new Error("usage: herdgate pair --cloud <name>");
  const { base, config } = pairedConfig();
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const lock = join(config, ".pairing");
  mkdirSync(lock);
  try {
    if (checkCloud(origin)) { console.log("herdgate: already paired to this cloud"); return; }
    // Pairing is explicit and still needs approval; the room token stays in host config.
    runNode(join(ROOT, "plugin", "server", "index.mjs"), ["pair"], {
      ...process.env, HERDGATE_URL: origin,
      HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: join(base, "state"),
    });
  } finally { rmdirSync(lock); }
}
function managePublisher(cmd, args) {
  const { origin, options } = cloudOption(args);
  if (!["setup", "migrate"].includes(cmd) && origin) throw new Error("--cloud is only used with setup, migrate or pair");
  if (["setup", "migrate"].includes(cmd) && !checkCloud(origin)) {
    throw new Error("this machine is not paired; run herdgate pair --cloud <name> first");
  }
  const win = process.platform === "win32";
  if (!win && process.platform !== "linux") throw new Error("publisher management requires Windows or Linux with systemd");
  if (cmd === "update") {
    if (options.length) throw new Error("usage: herdgate update");
    return withLatest((pkg) => runNode(join(pkg, "bin", "herdgate.mjs"), win ? ["tui", "update"] : ["home-tui", "setup"]));
  }
  if (win) {
    const flags = options.map(flag => flag === "--mobile-act" ? "--mobile-tui-act" : flag === "--mobile-read" ? "--mobile-tui" : flag);
    if (cmd === "setup" || cmd === "migrate") return runNode(join(ROOT, "windows", "setup-tui.mjs"), [cmd, ...flags]);
    // Starting must not reinstall an older globally installed npm package.
    if (cmd === "start") return runInstalledTui(["setup", ...flags], true);
    return runInstalledTui([cmd, ...flags]);
  }
  if (cmd === "migrate") {
    if (options.length) throw new Error("usage: herdgate migrate [--cloud <name>]");
    return runNode(join(HERE, "home-tui.mjs"), ["setup", "--adopt"]);
  }
  return runNode(join(HERE, "home-tui.mjs"), [cmd, ...options]);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "setup-host") {
    setupHost();
    trySyncPiSkills();
  } else if (cmd === "pi-skills" && !args.length) trySyncPiSkills();
  else if (cmd === "cloud" && args.length === 1 && args[0] === "serve") {
    const entry = join(ROOT, "src", "cloud", "main.ts");
    if (!existsSync(entry)) throw new Error("cloud serve requires the full npm package; use the Cloud archive for Docker or systemd");
    runNode(entry, []);
  } else if (cmd === "cloud") manageCloud(args);
  else if (cmd === "pair") pairHost(args);
  else if (process.platform === "win32" && (
    ["install", "setup", "migrate", "start", "update", "install-tui"].includes(cmd) ||
    (cmd === "tui" && ["setup", "migrate", "start", "update"].includes(args[0]))
  ) && (Number(process.versions.node.split(".")[0]) < 22 || typeof globalThis.WebSocket !== "function")) {
    const node = windowsNode();
    const r = spawnSync(node, [fileURLToPath(import.meta.url), cmd, ...args], { stdio: "inherit", shell: false, windowsHide: true });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } else if (["setup", "migrate", "start", "stop", "status", "update"].includes(cmd)) managePublisher(cmd, args);
  else if (cmd === "home-tui") runNode(join(HERE, "home-tui.mjs"), args);
  else if (cmd === "install") {
    if (args.length && !(args.length === 1 && args[0] === "--no-path") && !(args.length === 2 && args[0] === "--root" && args[1])) {
      throw new Error("usage: herdgate install [--no-path | --root <dir>]");
    }
    runNode(join(ROOT, "windows", "install-cli.mjs"), ["--command", ...args]);
  }
  else if (cmd === "install-tui") runNode(join(ROOT, "windows", "install-cli.mjs"), args);
  else if (cmd === "tui") {
    if (["setup", "migrate", "update"].includes(args[0])) runNode(join(ROOT, "windows", "setup-tui.mjs"), args);
    else runInstalledTui(args);
  } else {
    console.log(help);
    process.exitCode = !cmd || cmd === "help" || cmd === "--help" ? 0 : 1;
  }
} catch (e) {
  console.error(`herdgate: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
