// C9 — plugin/loop: the shipped agent-loop pane. Manifest rules, npm shape,
// and the event engine against a stubbed herdr bridge. The live cutover (the
// herdgate dev-loop itself running on this plugin) is the field acceptance.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const LOOP = join(ROOT, "plugin", "loop");
const MANIFEST = readFileSync(join(LOOP, "herdr-plugin.toml"), "utf8");
const INDEX = join(LOOP, "server", "index.mjs");

test("loop manifest: declares lifecycle actions and both chain events", () => {
  assert.match(MANIFEST, /^id = "dev\.herdgate\.loop"$/m);
  assert.match(MANIFEST, /^name = /m);
  assert.match(MANIFEST, /^version = /m);
  assert.match(MANIFEST, /^min_herdr_version = /m);
  assert.match(MANIFEST, /^platforms = \[/m);
  for (const action of ["status", "start", "stop", "pause", "resume"]) {
    assert.match(MANIFEST, new RegExp(`^id = "${action}"$`, "m"), `action ${action}`);
  }
  // Herdr's rule: local ids carry no dots (only the plugin id itself may).
  for (const id of [...MANIFEST.matchAll(/^id = "([^"]+)"$/gm)].map((m) => m[1])) {
    if (id.startsWith("dev.")) continue;
    assert.ok(!id.includes("."), `local id "${id}" must not contain a dot`);
  }
  const events = [...MANIFEST.matchAll(/^on = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.ok(events.includes("pane.agent_status_changed"), "settles drive the chain");
  assert.ok(events.includes("pane.exited"), "a dead pane is recorded, not respawned");
});

test("loop plugin: self-contained, and shipped by npm", () => {
  const src = readFileSync(INDEX, "utf8");
  const offenders = [...src.matchAll(/from\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith("node:") && !spec.startsWith("./") && !spec.startsWith("../"));
  assert.deepEqual(offenders, [], "imports escaping the plugin tree break every npm install");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const shipped = pkg.files.join("\n");
  for (const need of ["plugin/loop/herdr-plugin.toml", "plugin/loop/server/*.mjs"]) {
    assert.ok(shipped.includes(need), `npm files must ship ${need}`);
  }
});

// ---- harness ---------------------------------------------------------------

function stubHerdr(dir, replies) {
  // One JSON-RPC request per process: the stub logs the method and answers
  // from the per-case reply map, exactly like the real bridge contract.
  const bin = join(dir, `herdr-stub-${Math.random().toString(36).slice(2)}.mjs`);
  const calls = join(dir, "calls.log");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8").split("\\n")[0]);
appendFileSync(${JSON.stringify(calls)}, req.method + " " + JSON.stringify(req.params) + "\\n");
const map = ${JSON.stringify(JSON.stringify(replies))};
const r = JSON.parse(map)[req.method] ?? { result: {} };
process.stdout.write(JSON.stringify({ id: req.id, ...r }) + "\\n");
`);
  return { bin, calls };
}

function run(dir, argv, { event, config, state } = {}) {
  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (config !== undefined) writeFileSync(join(configDir, "loop.json"), JSON.stringify(config));
  else rmSync(join(configDir, "loop.json"), { force: true });
  if (state !== undefined) writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
  else rmSync(join(stateDir, "state.json"), { force: true });
  const { bin } = stubHerdr(dir, (argv.stubReplies ?? {}));
  const child = spawnSync(process.execPath, [INDEX, ...argv.cmd], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: bin,
      HOME: dir, // cwd-under-home validation sees the sandbox as home
      ...(event ? { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event) } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const callsFile = join(dir, "calls.log");
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean) : [];
  if (existsSync(callsFile)) rmSync(callsFile);
  return { code: child.status, stdout: child.stdout, stderr: child.stderr, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), "hg-loop-"));

const goodConfig = (dir, over = {}) => ({
  v: 1, label: "probe", promptFile: join(dir, "prompt.md"), cwd: dir, cooldownMs: 10_000, maxCycles: 0, ...over,
});

// ---- event hook ------------------------------------------------------------

test("loop event: foreign panes are never touched", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const r = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, {
      config: goodConfig(dir),
      state: { paneId: "wA:p1", status: "running", cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wB:p9", agent_status: "idle" } },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, [], "a user pane settling must not reach the bridge");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop event: settle nudges our pane, counts the cycle, respects cooldown", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const base = { config: goodConfig(dir), event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "idle" } } };
    const a = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, { ...base, state: { paneId: "wA:p1", status: "running", cycles: 0, lastNudgeAt: 0 } });
    assert.equal(a.code, 0);
    assert.equal(a.calls.length, 1);
    assert.ok(a.calls[0].startsWith("pane.send_text"), "the nudge is the only bridge call");
    assert.ok(JSON.parse(a.calls[0].slice("pane.send_text ".length)).text.endsWith("\r"), "submitted with Enter");
    let st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.cycles, 1, "cycle counted");

    // Immediately settling again must be muted by the cooldown.
    const b = run(dir, { cmd: ["event"] }, { ...base, state: st });
    assert.equal(b.code, 0);
    assert.deepEqual(b.calls, []);
    st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.cycles, 1, "cooldown did not count as a cycle");

    // After the cooldown window it nudges again.
    st.lastNudgeAt = Date.now() - 60_000;
    const c = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, { ...base, state: st });
    assert.equal(c.calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop event: working/blocked hands off, exited marks the chain broken", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const r = run(dir, { cmd: ["event"] }, {
      config: goodConfig(dir),
      state: { paneId: "wA:p1", status: "running", cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "working" } },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, []);

    const x = run(dir, { cmd: ["event"] }, {
      config: goodConfig(dir),
      state: { paneId: "wA:p1", status: "running", cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.exited", data: { pane_id: "wA:p1" } },
    });
    assert.equal(x.code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).status, "chain-broke");
    assert.match(readFileSync(join(dir, "state", "loop.log"), "utf8"), /chain broke/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop event: paused mutes, maxCycles finishes the loop honestly", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const base = { config: goodConfig(dir, { maxCycles: 2 }), event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "idle" } } };
    const p = run(dir, { cmd: ["event"] }, { ...base, state: { paneId: "wA:p1", status: "running", paused: true, cycles: 0, lastNudgeAt: 0 } });
    assert.deepEqual(p.calls, [], "paused: no nudge");

    const m = run(dir, { cmd: ["event"] }, { ...base, state: { paneId: "wA:p1", status: "running", cycles: 2, lastNudgeAt: 0 } });
    assert.deepEqual(m.calls, [], "cap reached: no nudge");
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.status, "done", "the loop reports done instead of nudging forever");

    // A config that went bad mutes the chain rather than nudging blind.
    const bad = run(dir, { cmd: ["event"] }, { ...base, config: { v: 1, label: "probe" }, state: { paneId: "wA:p1", status: "running", cycles: 0, lastNudgeAt: 0 } });
    assert.deepEqual(bad.calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- actions ----------------------------------------------------------------

test("loop start: boots the pane with a properly escaped pi command", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe prompt");
    const replies = {
      "workspace.list": { result: { workspaces: [{ workspace_id: "w7", label: "⚙ probe" }] } },
      "tab.create": { result: { root_pane: { pane_id: "w7:p3" } } },
      "pane.send_text": { result: { type: "ok" } },
    };
    const r = run(dir, { cmd: ["start"], stubReplies: replies }, { config: goodConfig(dir) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.split(" ")[0]), ["workspace.list", "tab.create", "pane.send_text"], "reuses the labeled workspace, one request per process");
    const send = r.calls.find((c) => c.startsWith("pane.send_text"));
    const text = JSON.parse(send.slice("pane.send_text ".length)).text;
    assert.equal(text, `cd ${dir} && pi "$(cat ${join(dir, "prompt.md")})"\r`);
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.paneId, "w7:p3");
    assert.equal(st.status, "running");

    // Idempotent while alive: one pane.list, then refuses.
    const again = run(dir, { cmd: ["start"], stubReplies: { "pane.list": { result: { panes: [{ pane_id: "w7:p3" }] } } } }, { config: goodConfig(dir), state: st });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already running/);
    assert.equal(again.calls.length, 1, "the refusal costs exactly one pane.list");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: fail closed on bad owner input", () => {
  const dir = tmp();
  try {
    const r = run(dir, { cmd: ["start"] }, { config: { v: 0, label: "x" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /loop\.json/);
    const missing = run(dir, { cmd: ["start"] }, {});
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /loop\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop stop/pause/resume: owned workspace only, already-gone is success", () => {
  const dir = tmp();
  try {
    const ok = run(dir, { cmd: ["stop"], stubReplies: { "workspace.close": { result: { type: "ok" } } } },
      { state: { paneId: "w7:p3", workspaceId: "w7", status: "running", cycles: 1 } });
    assert.equal(ok.code, 0);
    assert.match(ok.calls[0], /^workspace.close \{"workspace_id":"w7"\}$/);
    assert.equal(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).status, "stopped");

    const gone = run(dir, { cmd: ["stop"], stubReplies: { "workspace.close": { error: { code: "workspace_not_found", message: "workspace w7 not found" } } } },
      { state: { paneId: "w7:p3", workspaceId: "w7", status: "running", cycles: 1 } });
    assert.equal(gone.code, 0, "a workspace that is already gone is a successful stop");

    const p = run(dir, { cmd: ["pause"] }, { state: { paneId: "w7:p3", workspaceId: "w7", status: "running" } });
    assert.match(p.stdout, /"paused":true/);
    const res = run(dir, { cmd: ["resume"] }, { state: { paneId: "w7:p3", workspaceId: "w7", status: "running", paused: true } });
    assert.match(res.stdout, /"paused":false/);
    assert.equal(run(dir, { cmd: ["pause"] }, {}).code, 1, "nothing to pause fails honestly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop status: honest JSON for humans and scripts", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const r = run(dir, { cmd: ["status"], stubReplies: { "pane.list": { result: { panes: [{ pane_id: "w7:p3" }] } } } }, {
      config: goodConfig(dir, { cooldownMs: 30_000, maxCycles: 5 }),
      state: { paneId: "w7:p3", workspaceId: "w7", status: "running", cycles: 2, lastNudgeAt: 123 },
    });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.config.ok, true);
    assert.equal(j.config.maxCycles, 5);
    assert.equal(j.state.cycles, 2);
    assert.equal(j.state.paneAlive, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
