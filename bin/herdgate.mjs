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
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // <pkg>/bin
const ROOT = dirname(HERE); // <pkg>

const help = `herdgate — every machine, one herd

  herdgate setup-host [--cloud <url>] [--name <machine-name>] [--app-home <dir>]
      Install the herdr-app mod + publisher and prefill the panel settings.
      --cloud     your gate, e.g. https://gate.phuongnb.io.vn   (required)
      --name      how this machine shows up on the phone        (default: hostname)
      --app-home  herdr-app home (default: the platform's usual one)

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
}

const cmd = process.argv[2];
if (cmd === "setup-host") setupHost();
else {
  console.log(help);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
