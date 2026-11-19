#!/usr/bin/env node
// herdgate CLI — brings a machine into the herd.
//
//   npx @bom0792/herdgate setup-host --cloud https://gate.example.com
//
// Installs the herdr-app mod and the publisher into the app's home, and
// prefills the panel's settings so the only thing left is Pair → Publish.
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // <pkg>/bin
const ROOT = dirname(HERE); // <pkg>

const help = `herdgate — every machine, one herd

  herdgate setup-host [--cloud <url>] [--name <machine-name>] [--app-home <dir>]
      Install the herdr-app mod + publisher and prefill the panel settings.
      --cloud     your gate, e.g. https://gate.phuongnb.io.vn   (required)
      --name      how this machine shows up on the phone        (default: hostname)
      --app-home  herdr-app home (default: the platform's usual one)
      --no-integrate  skip the tab-bar panel integration (pane.split still works)

Everything else lives in the app's herdgate panel: Pair, then Publish.`;

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
  const cloud = arg("cloud");
  if (!cloud) {
    console.error(help);
    process.exit(1);
  }
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
  settings  → ${settingsPath} (cloud: ${cloud}, name: ${name})

Next: open (or restart) herdr-app → herdgate panel → Pair, then approve the
code in the PWA (${cloud}) and click Publish. Requires node >= 22 on PATH
for the publisher (node -v).`);
  if (!arg("no-integrate")) integrate(home);
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

function integrate(home) {
  const probe = spawnSync("herdr-app", ["status"], { encoding: "utf8" });  if (probe.status !== 0) {
    console.log("herdgate: herdr-app not reachable — start the app, then re-run setup-host");
    return;
  }
  // 1. clone the tabs mod and add our button.
  let tabs = join(home, "mods", "tabs-herdgate", "main.js");
  if (!existsSync(tabs)) {
    const c = do_(["mod.clone", JSON.stringify({ name: "tabs", as: "tabs-herdgate" })]);
    if (!c.ok && !existsSync(tabs)) return console.log(`herdgate: could not clone tabs (${c.out.slice(0, 120)}) — panel stays reachable via pane.split`);
  }
  let src = readFileSync(tabs, "utf8");
  const anchor = `.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))`;
  const btn = `.when(enabled.includes("herdgate"), el => el.child(panelButton("herdgate", "herdgate", "mods/herdgate/herdgate.svg")))`;
  if (src.includes(anchor) && !src.includes(btn)) {
    src = src.replace(anchor, `${anchor}\n      ${btn}`);
    src = src.replace(`shared("workspace.panels") ?? ["files", "changes"]`, `shared("workspace.panels") ?? ["files", "changes", "herdgate"]`);
    writeFileSync(tabs, src);
  } else if (!src.includes(btn)) {
    console.log("herdgate: tabs mod anchors not found (Herdr version drift?) — button not added, pane.split still works");
  }

  // 2. clone the main layout, seat herdgate in panel-body, point the tab bar at the clone.
  const layoutPath = join(home, "layouts", "herdgate-main.json");
  if (!existsSync(layoutPath)) {
    const c = do_(["layout.clone", JSON.stringify({ name: "main", as: "herdgate-main" })]);
    if (!c.ok && !existsSync(layoutPath)) return console.log(`herdgate: could not clone layout (${c.out.slice(0, 120)})`);
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
  const set = do_(["layout.set", JSON.stringify({ layout: tree })]);
  if (!set.ok) return console.log(`herdgate: layout.set failed (${set.out.slice(0, 120)})`);
  do_(["layout.switch", JSON.stringify({ name: "herdgate-main" })]);
  console.log("herdgate: panel button added to the tab bar (layout herdgate-main) — press it any time;");
  console.log("           the shipped layout `main` stays untouched (layout.switch main goes back).");
}

const cmd = process.argv[2];
if (cmd === "setup-host") setupHost();
else {
  console.log(help);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
