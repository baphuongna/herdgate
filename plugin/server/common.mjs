/** Shared pieces of the herdgate plugin: config, state, the Herdr CLI lane. */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The version the hello advertises: the shipped package's own version, read
 *  from the package.json two levels up (same path in the repo and in the npm
 *  tarball). Never a hard-coded literal — stale ads are worse than none. */
export function pkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" && pkg.version.length <= 32 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

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

/** Live panes — the PWA's terminal picker. One row per pane, grouped by workspace there. */
export async function herdrPanes(bin, timeoutMs = 8_000) {
  const { stdout } = await run(bin, ["pane", "list"], { timeout: timeoutMs, maxBuffer: 8 << 20 });
  const parsed = JSON.parse(stdout);
  const panes = parsed?.result?.panes ?? parsed?.panes ?? [];
  return panes
    .filter((p) => p && typeof p.pane_id === "string")
    .map((p) => ({
      id: p.pane_id,
      workspace: typeof p.workspace_id === "string" ? p.workspace_id : "",
      agent: typeof p.agent === "string" ? p.agent : null,
      status: typeof p.agent_status === "string" ? p.agent_status : "unknown",
      cwd: typeof p.cwd === "string" ? p.cwd : "",
      title: typeof p.terminal_title_stripped === "string" ? p.terminal_title_stripped : typeof p.terminal_title === "string" ? p.terminal_title : "",
    }));
}

/** One pane's screen as ANSI text — the PWA renders the colors itself. */
export async function herdrRead(bin, target, lines = 40, timeoutMs = 8_000) {
  // Agent panes read through `agent read`; plain terminal panes answer
  // `agent_not_found` and belong to `pane read` — same flags, same formats.
  const argv = (sub) => [sub, "read", String(target), "--source", "visible", "--lines", String(lines), "--format", "ansi"];
  try {
    const { stdout } = await run(bin, argv("agent"), { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return stdout;
  } catch (e) {
    if (!/agent_not_found|not found/i.test(`${e?.message ?? ""}${e?.stderr ?? ""}`)) throw e;
    const { stdout } = await run(bin, argv("pane"), { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return stdout;
  }
}

/** The publisher's adaptive tick: fast while agents work or the snapshot
 *  just changed (a settle must reach phones in seconds), relaxing ×1.5 per
 *  quiet tick down to hours-safe floors. Pure — the loop only feeds it flags. */
export function nextPublishDelay({ baseMs = 30_000, minMs = 5_000, maxMs = 60_000, busy = false, quietStreak = 0, changed = false } = {}) {
  const base = Math.max(2_000, Math.floor(baseMs));
  const min = Math.min(base, Math.max(2_000, Math.floor(minMs)));
  const max = Math.max(base, Math.floor(maxMs));
  if (busy || changed) return min;
  const grown = Math.round(base * Math.pow(1.5, Math.min(Math.max(quietStreak, 0), 10)));
  return Math.max(min, Math.min(max, grown));
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
