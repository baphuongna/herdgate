#!/usr/bin/env node
// dev.herdgate.devloop event hook — herdr-native chaining for the DEV-LOOP.
// One short-lived process per event; never a daemon, never a toast. The loop
// pane's id lives in ~/.local/state/herdgate-dev-loop.pane; only that pane is
// ever nudged (user panes exit silently). A settle (idle|done) sends the
// next-cycle prompt into the same pane; a nudge is rate-limited to one per
// minute — an agent flip-flopping statuses must not double-drive the loop.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const STATE = join(homedir(), ".local", "state", "herdgate-dev-loop.pane");
const LOG = join(homedir(), ".local", "state", "herdgate-dev-loop.log");
const NUDGE_MIN_GAP_MS = 60_000;
const log = (line) => { try { writeFileSync(LOG, `${new Date().toISOString()} ${line}\n`, { flag: "a" }); } catch { /* best effort */ } };

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function nudge(text) {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  const argv = ["--session", "default", "remote-api-bridge"];
  const child = bin.endsWith(".mjs")
    ? spawnSync(process.execPath, [bin, ...argv], { input: JSON.stringify({ id: "n1", method: "pane.send_text", params: { pane_id: readState().paneId, text } }) + "\n", encoding: "utf8", timeout: 15_000 })
    : spawnSync(bin, argv, { input: JSON.stringify({ id: "n1", method: "pane.send_text", params: { pane_id: readState().paneId, text } }) + "\n", encoding: "utf8", timeout: 15_000 });
  log(`nudge rc=${child.status ?? "?"} out=${String(child.stdout ?? "").slice(0, 80)}`);
}

try {
  const payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
  const event = payload?.event ?? "";
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const state = readState();
  if (!state.paneId || paneId !== state.paneId) process.exit(0); // not our pane — silent

  if (event === "pane.exited") {
    log(`loop pane ${paneId} exited — the chain broke; restart with loop-pane.sh`);
    process.exit(0);
  }
  const status = typeof data.agent_status === "string" ? data.agent_status : "";
  log(`loop pane ${paneId} status=${status}`);
  if (status !== "idle" && status !== "done") process.exit(0); // working/blocked: hands off
  const last = Number(state.lastNudgeAt) || 0;
  if (Date.now() - last < NUDGE_MIN_GAP_MS) { log("nudge suppressed (rate limit)"); process.exit(0); }
  writeFileSync(STATE, JSON.stringify({ ...state, lastNudgeAt: Date.now() }));
  nudge("\n\nVòng kế: đọc docs/DEV-LOOP.md + docs/DEV-LOOP/AUTO.md và chạy đúng MỘT vòng SDD tiếp theo (chọn vòng đầu chưa ✅/BLOCKED theo protocol, đủ các bước, commit + push). Không hỏi lại gì.\r");
} catch (e) {
  log(`hook error: ${e instanceof Error ? e.message : String(e)}`);
}
