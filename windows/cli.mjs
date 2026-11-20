import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withLatest } from "./npm-update.mjs";

const release = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const releases = dirname(release);
const root = dirname(releases);
const usage = `herdgate-tui start [path-to-herdr.exe] [--hc path-to-herdr-core.exe | --mobile-tui d_read | --mobile-tui-act d_act]
herdgate-tui update | status | stop | version | versions
herdgate-tui use <release-id>`;

function run(file, args) {
  const result = spawnSync(process.execPath, [resolve(release, file), ...args], { stdio: "inherit", windowsHide: true, shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function update() {
  const defaultRoot = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Herdgate", "cli");
  const pathKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  if (!defaultRoot || !existsSync(defaultRoot) || pathKey(realpathSync(defaultRoot)) !== pathKey(root)) {
    throw new Error("update requires the default per-user install location");
  }
  if (!existsSync(join(root, "publisher-profile.json"))) {
    throw new Error("no saved publisher mode; run npx --yes @bom0792/herdgate@latest tui setup with your current options once");
  }
  withLatest((pkg) => run(join(pkg, "bin", "herdgate.mjs"), ["tui", "update"]));
}

try {
  const [cmd, ...args] = process.argv.slice(2);
  if ((!cmd || cmd === "help" || cmd === "--help") && !args.length) {
    console.log(usage);
  } else if (cmd === "update" && !args.length) {
    update();
  } else if (cmd === "version" && !args.length) {
    console.log(readFileSync(join(release, "release.txt"), "utf8").trim());
  } else if (cmd === "versions" && !args.length) {
    for (const entry of readdirSync(releases, { withFileTypes: true })) {
      if (entry.isDirectory() && /^tui-[a-f0-9]{16}$/.test(entry.name)) {
        console.log(`${entry.name}${entry.name === basename(release) ? " (current)" : ""}`);
      }
    }
  } else if (cmd === "use" && args.length === 1) {
    run("windows/install-cli.mjs", ["--root", root, "--use", args[0]]);
  } else if ((cmd === "status" || cmd === "stop") && !args.length) {
    run("plugin/server/publish-tui.mjs", [cmd]);
  } else if (cmd === "start" || cmd === "check") {
    const requested = args[0] && !args[0].startsWith("--") ? args.shift() : null;
    if (args.length && (args.length !== 2 || !["--hc", "--mobile-tui", "--mobile-tui-act"].includes(args[0]) || !args[1])) throw new Error(usage);
    const pilot = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "HerdrPilot", "v0.9.5", "herdr.exe");
    const bin = requested || process.env.HERDGATE_HERDR_BIN || (pilot && existsSync(pilot) ? pilot : null);
    if (!bin) throw new Error("give the full path to Herdr 0.9.5: herdgate-tui start <path-to-herdr.exe>");
    run("plugin/server/publish-tui.mjs", [cmd, bin, ...args]);
  } else {
    throw new Error(usage);
  }
} catch (e) {
  console.error(`herdgate-tui: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
