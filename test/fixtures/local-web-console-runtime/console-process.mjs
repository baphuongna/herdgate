import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** True when the pid is a live, non-zombie process: signal 0 plus Linux /proc state. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

/** Resolves once the pid is gone (or was never alive), bounded by timeoutMs. */
export async function waitForExit(pid, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Locate console-server.mjs processes by cmdline carrying this test's state dir (exe/cmdline, not name). */
export function leakedConsoleServerPids(stateDir) {
  if (process.platform !== "linux") return [];
  const pids = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
    let cmdline;
    try { cmdline = readFileSync(join("/proc", entry.name, "cmdline"), "utf8"); } catch { continue; }
    if (cmdline.includes("console-server.mjs") && cmdline.includes(stateDir)) pids.push(Number(entry.name));
  }
  return pids;
}

/**
 * Cleanup that holds even when the test body failed or timed out: read the recorded pid,
 * run the stop command, wait for the process to exit, then kill any console-server still
 * carrying this state dir and throw "leaked console-server pid …" so the test fails loudly.
 */
export async function reapConsoleServer(stop, state) {
  const statePath = join(state, "instance.json");
  let pid;
  if (existsSync(statePath)) {
    try { pid = JSON.parse(readFileSync(statePath, "utf8"))?.pid; } catch { pid = undefined; }
    stop();
  }
  await waitForExit(pid);
  const candidates = [...new Set([...(pidAlive(pid) ? [pid] : []), ...leakedConsoleServerPids(state)])].filter((value) => pidAlive(value));
  if (candidates.length > 0) {
    for (const leaked of candidates) {
      try { process.kill(leaked, "SIGKILL"); } catch { /* already gone */ }
    }
    throw new Error(`leaked console-server pid ${candidates.join(", ")}`);
  }
}
