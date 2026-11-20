// Opt-in Windows pilot. Run as the same user as the local Herdr TUI.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readConfig } from "./common.mjs";
import { publisherStatus, startPublisher, stopPublisher } from "./publisher-tui-lifecycle.mjs";

const run = promisify(execFile);
try {
  const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  const base = join(appHome, "herdgate");
  const state = join(base, "state");
  const [action, exe, ...args] = process.argv.slice(2);
  if (action === "status" || action === "stop") {
    if (exe || args.length) throw new Error(`usage: publish-tui.mjs ${action}`);
    const result = action === "status" ? publisherStatus(state) : await stopPublisher(state);
    console.log(JSON.stringify(result));
    if (action === "stop" && result.state !== "stopped") process.exitCode = 1;
  } else {
    const bin = ["start", "check", "--worker"].includes(action) ? exe : action;
    if (args.length && (args.length !== 2 || !["--hc", "--mobile-tui", "--mobile-tui-act"].includes(args[0]) || !args[1])) throw new Error("expected --hc <path to herdr-core.exe>, --mobile-tui <read device ID>, or --mobile-tui-act <act device ID>");
    const mobile = args[0] === "--mobile-tui" || args[0] === "--mobile-tui-act" ? args[1] : "";
    const mobileScope = args[0] === "--mobile-tui-act" ? "act" : "read";
    if (mobile && !/^d_[A-Za-z0-9]{1,32}$/.test(mobile)) throw new Error(`the Mobile TUI option requires a paired ${mobileScope} device ID (d_…)`);
    await launch({ action, bin, hc: args[0] === "--hc" ? args[1] : undefined, mobile, mobileScope, base, state });
  }
} catch (e) {
  console.error(`herdgate: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}

async function launch({ action, bin, hc, mobile, mobileScope, base, state }) {
  if (process.platform !== "win32") throw new Error("this publisher launcher is for Windows");
  if (typeof globalThis.WebSocket !== "function") throw new Error("use Node 22+ with WebSocket enabled to install and run the publisher");
  if (!bin || !/^[a-z]:[\\/]/i.test(bin) || !/\.exe$/i.test(bin) || !statSync(bin).isFile()) {
    throw new Error("usage: node publish-tui.mjs start <absolute path to herdr.exe> | status | stop");
  }
  const real = realpathSync.native(bin);
  if (!/^[a-z]:[\\/]/i.test(real)) throw new Error("Herdr must be installed on a local drive");
  const cfg = readConfig(join(base, "config", "herdgate.env"));
  if (!cfg.HERDGATE_URL || !cfg.HERDGATE_ROOM_TOKEN) throw new Error("pair this laptop in the Herdgate panel first");
  const gate = new URL(cfg.HERDGATE_URL);
  if (gate.protocol !== "https:" || gate.username || gate.password || cfg.HERDGATE_AGENT_LOOPBACK_PORT) {
    throw new Error("the Windows pilot requires an HTTPS gate and does not use loopback mode");
  }
  if (cfg.HERDGATE_HERDR_SESSION && cfg.HERDGATE_HERDR_SESSION !== "default") {
    throw new Error("this pilot exposes only the default TUI session");
  }

  let mobileHcBin = "";
  if (hc !== undefined) {
    if (!/^[a-z]:[\\/]/i.test(hc) || !/\.exe$/i.test(hc) || !statSync(hc).isFile()) {
      throw new Error("--hc needs the absolute path to herdr-core.exe on a local drive");
    }
    mobileHcBin = realpathSync.native(hc);
    if (!/^[a-z]:[\\/]/i.test(mobileHcBin) || !/\.exe$/i.test(mobileHcBin)) throw new Error("herdr-core must be a local executable");
    const result = await run(mobileHcBin, ["--version"], { timeout: 5_000, shell: false, windowsHide: true });
    if (!/\bhc\s+\d+\.\d+\.\d+\b|\bherdr-core\s+\d+\.\d+\.\d+\b/i.test(result.stdout)) {
      throw new Error("--hc did not identify itself as herdr-core");
    }
  }
  const env = {
    ...process.env,
    HERDGATE_MOBILE_HC_BIN: mobileHcBin,
    HERDGATE_MOBILE_TUI_DEVICE: mobile,
    HERDGATE_MOBILE_TUI_SCOPE: mobileScope,
    ...(mobile ? { HERDGATE_HOST_NAME: `${process.env.COMPUTERNAME || "windows"}-TUI` } : {}),
    HERDR_BIN_PATH: bin,
    HERDGATE_HERDR_BIN: bin,
    HERDR_SESSION: "default",
    HERDGATE_HERDR_SESSION: "default",
    HERDR_PLUGIN_ID: "dev.herdgate.host",
    HERDR_PLUGIN_CONFIG_DIR: join(base, "config"),
    HERDR_PLUGIN_STATE_DIR: state,
    HERDGATE_SETTINGS: join(base, "settings.json"),
    HERDGATE_TUI_ONLY: "1",
    HERDGATE_PUBLISHER_CHILD: "1",
  };
  const status = async (target) => JSON.parse((await run(bin, ["status", target, "--json"], {
    env, timeout: 5_000, shell: false, windowsHide: true,
  })).stdout);
  const client = await status("client");
  if (client.version !== "0.9.5" || client.remote_host_bridge !== true) {
    throw new Error("use the standalone Herdr v0.9.5 Windows package with its bundled ConPTY support");
  }
  const server = await status("server");
  if (!server.running || !server.capabilities?.detached_server_daemon) {
    throw new Error("start the local Herdr 0.9.5 TUI (default session) before publishing");
  }
  if (server.version !== client.version) {
    throw new Error(`the running Herdr server reports ${server.version}, expected ${client.version}; finish work in live panes before restarting Herdr`);
  }
  if (action === "check") return;
  if (action === "start") {
    const mode = mobile ? [mobileScope === "act" ? "--mobile-tui-act" : "--mobile-tui", mobile] : mobileHcBin ? ["--hc", mobileHcBin] : [];
    const result = await startPublisher(state, [fileURLToPath(import.meta.url), "--worker", bin, ...mode], env);
    console.log(JSON.stringify(result));
    if (!["connected", "connecting", "starting"].includes(result.state)) process.exitCode = 1;
    return;
  }
  if (action === "--worker" && !env.HERDGATE_TUI_RUN_ID) throw new Error("use start to launch the background publisher");
  if (action !== "--worker") {
    env.HERDGATE_TUI_RUN_ID = randomUUID();
    console.error("herdgate: publishing in the foreground; Ctrl+C stops publishing");
  }
  Object.assign(process.env, env);
  process.argv[2] = "serve";
  await import("./index.mjs");
}
