/** Shared pieces of the herdgate plugin: config, state, the Herdr CLI lane. */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function dirs(env = process.env) {
  return {
    pluginId: env.HERDR_PLUGIN_ID ?? "dev.herdgate.host",
    configDir: env.HERDR_PLUGIN_CONFIG_DIR ?? "",
    stateDir: env.HERDR_PLUGIN_STATE_DIR ?? "",
    herdrBin: env.HERDR_BIN_PATH ?? "herdr",
    configPath: env.HERDR_PLUGIN_CONFIG_DIR ? join(env.HERDR_PLUGIN_CONFIG_DIR, "herdgate.env") : "",
    statePath: env.HERDR_PLUGIN_STATE_DIR ? join(env.HERDR_PLUGIN_STATE_DIR, "pairing.json") : "",
  };
}

/** `key=value` lines. Credentials live here, mode 0600, never in the plugin root. */
export function readConfig(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function writeConfig(path, cfg) {
  if (!path) throw new Error("HERDR_PLUGIN_CONFIG_DIR is not set");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* filesystems without modes */
  }
}

export function readState(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(path, state) {
  if (!path) return;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** The Herdr CLI is the plugin API: `HERDR_BIN_PATH` keeps it portable. */
export async function herdrSnapshot(bin, timeoutMs = 8_000) {
  const { stdout } = await run(bin, ["api", "snapshot"], { timeout: timeoutMs, maxBuffer: 8 << 20 });
  const parsed = JSON.parse(stdout);
  return parsed?.result?.snapshot ?? parsed?.snapshot ?? parsed;
}

export function summarize(snap) {
  const ws = Array.isArray(snap?.workspaces) ? snap.workspaces : [];
  const agents = Array.isArray(snap?.agents) ? snap.agents : [];
  const count = (s) => agents.filter((a) => a?.agent_status === s).length;
  return {
    herdr: `${snap?.version ?? "?"} (protocol ${snap?.protocol ?? "?"})`,
    workspaces: ws.length,
    agents: agents.length,
    working: count("working"),
    blocked: count("blocked"),
    labels: ws.map((w) => w?.label).filter((l) => typeof l === "string"),
  };
}
