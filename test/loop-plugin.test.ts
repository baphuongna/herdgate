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
  // It answers on the first complete line and exits — the EOF-answer shape
  // (a bridge that waits for stdin to close before replying).
  const bin = join(dir, `herdr-stub-${Math.random().toString(36).slice(2)}.mjs`);
  const calls = join(dir, "calls.log");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl === -1) return;
  const req = JSON.parse(buf.slice(0, nl));
  appendFileSync(${JSON.stringify(calls)}, req.method + " " + JSON.stringify(req.params) + "\\n");
  const map = ${JSON.stringify(JSON.stringify(replies))};
  const r = JSON.parse(map)[req.method] ?? { result: {} };
  process.stdout.write(JSON.stringify({ id: req.id, ...r }) + "\\n");
  process.exit(0);
});
`);
  return { bin, calls };
}

// The real herdr 0.9.5 bridge shape, caught live on Windows: it replies on
// its own schedule and does NOT exit on stdin EOF — a client that closes
// stdin after writing (spawnSync `input`) races EOF against the reply and
// loses (observed: the server executed the request, the plugin saw
// "no-reply" and died). This stub delays its reply and stays alive.
function holdingStubHerdr(dir, replies, delayMs = 250) {
  const bin = join(dir, `herdr-hold-${Math.random().toString(36).slice(2)}.mjs`);
  const calls = join(dir, "calls.log");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buf = "";
const timer = setInterval(() => {}, 1 << 30);
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl === -1) return;
  const req = JSON.parse(buf.slice(0, nl));
  appendFileSync(${JSON.stringify(calls)}, req.method + " " + JSON.stringify(req.params) + "\\n");
  const map = ${JSON.stringify(JSON.stringify(replies))};
  const r = JSON.parse(map)[req.method] ?? { result: {} };
  setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, ...r }) + "\\n"), ${delayMs});
  process.stdin.resume();
});
`);
  return { bin, calls };
}

function run(dir, argv, { event, config, state, bin } = {}) {
  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (config !== undefined) {
    // A string is written raw (byte-exact fixtures — e.g. a UTF-8 BOM);
    // anything else is serialized like the owner's real config.
    writeFileSync(join(configDir, "loop.json"), typeof config === "string" ? config : JSON.stringify(config));
  } else rmSync(join(configDir, "loop.json"), { force: true });
  if (state !== undefined) writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
  else rmSync(join(stateDir, "state.json"), { force: true });
  const { bin: defaultBin } = stubHerdr(dir, (argv.stubReplies ?? {}));
  const child = spawnSync(process.execPath, [INDEX, ...argv.cmd], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: bin ?? defaultBin,
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
    const a = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, { ...base, state: { paneId: "wA:p1", status: "running", armed: true, cycles: 0, lastNudgeAt: 0 } });
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

test("loop event: a settle at birth is not work — no nudge until armed", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const r = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, {
      config: goodConfig(dir),
      state: { paneId: "wA:p1", status: "running", armed: false, cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "idle" } },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, [], "herdr's birth-idle must not earn a nudge");
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.cycles, 0, "an unarmed settle counts nothing");
    assert.equal(st.armed, false);
    assert.match(readFileSync(join(dir, "state", "loop.log"), "utf8"), /no work/, "the skip is logged honestly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop event: work arms the loop, then a settle nudges", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const w = run(dir, { cmd: ["event"] }, {
      config: goodConfig(dir),
      state: { paneId: "wA:p1", status: "running", armed: false, cycles: 0, lastNudgeAt: 0 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "working" } },
    });
    assert.equal(w.code, 0);
    assert.deepEqual(w.calls, []);
    assert.equal(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).armed, true, "seeing work arms the loop");

    const s = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, {
      config: goodConfig(dir),
      state: JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")),
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "idle" } },
    });
    assert.equal(s.calls.length, 1, "the settle after real work is the one that nudges");
    assert.equal(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).cycles, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop event: grandfathered pre-arming state still nudges (upgrade continuity)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const r = run(dir, { cmd: ["event"], stubReplies: { "pane.send_text": { result: { type: "ok" } } } }, {
      config: goodConfig(dir),
      // Exactly the shape the live pre-C10 build writes: no `armed` field.
      state: { paneId: "wA:p1", status: "running", cycles: 1, lastNudgeAt: Date.now() - 60_000 },
      event: { event: "pane.agent_status_changed", data: { pane_id: "wA:p1", agent_status: "done" } },
    });
    assert.equal(r.calls.length, 1, "a running loop upgraded in place must not stall");
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.cycles, 2);
    assert.equal(st.armed, true, "the upgrade persists the grandfathered arm");
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

test("loop start: boots the pane with a shell-neutral pi command, born in cfg.cwd", () => {
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
    const create = r.calls.find((c) => c.startsWith("tab.create"));
    assert.deepEqual(JSON.parse(create.slice("tab.create ".length)), { workspace_id: "w7", label: "probe", cwd: dir }, "the pane is born in cfg.cwd — the boot text carries no `cd`");
    const send = r.calls.find((c) => c.startsWith("pane.send_text"));
    const text = JSON.parse(send.slice("pane.send_text ".length)).text;
    // C11: `pi "$(cat …)"` was POSIX-only; @file is a plain quoted path —
    // passed verbatim by sh, PowerShell (quotes kill @ splatting) and cmd.
    assert.equal(text, `pi "@${join(dir, "prompt.md")}"\r`);
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.paneId, "w7:p3");
    assert.equal(st.status, "running");
    assert.equal(st.armed, false, "a fresh run must prove itself before settles count");

    // Idempotent while alive: one pane.list, then refuses.
    const again = run(dir, { cmd: ["start"], stubReplies: { "pane.list": { result: { panes: [{ pane_id: "w7:p3" }] } } } }, { config: goodConfig(dir), state: st });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /stop/, "running or done, the way out is the same: stop first");
    assert.equal(again.calls.length, 1, "the refusal costs exactly one pane.list");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: a live pane from a finished run is not garbage — refuse until stopped", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe prompt");
    const r = run(dir, { cmd: ["start"], stubReplies: { "pane.list": { result: { panes: [{ pane_id: "w7:p3" }] } } } }, {
      config: goodConfig(dir),
      // maxCycles reached, but the pane (and its final answer) is still on screen.
      state: { paneId: "w7:p3", workspaceId: "w7", status: "done", cycles: 2, lastNudgeAt: 0 },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /status: done/, "the refusal names the state it saw");
    assert.match(r.stderr, /stop/, "the message must name the way out");
    assert.deepEqual(r.calls.map((c) => c.split(" ")[0]), ["pane.list"], "the refusal costs exactly one pane.list — no tab.create, no boot text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: a broken chain with a dead pane restarts cleanly", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe prompt");
    const replies = {
      "pane.list": { result: { panes: [] } }, // the old pane is gone
      "workspace.list": { result: { workspaces: [{ workspace_id: "w7", label: "⚙ probe" }] } },
      "tab.create": { result: { root_pane: { pane_id: "w7:p9" } } },
      "pane.send_text": { result: { type: "ok" } },
    };
    const r = run(dir, { cmd: ["start"], stubReplies: replies }, {
      config: goodConfig(dir),
      state: { paneId: "w7:p3", workspaceId: "w7", status: "chain-broke", cycles: 2, lastNudgeAt: 0 },
    });
    assert.equal(r.code, 0, r.stderr);
    const st = JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
    assert.equal(st.paneId, "w7:p9", "a fresh pane takes over the same owned workspace");
    assert.equal(st.status, "running");
    assert.equal(st.cycles, 0, "a restart counts from zero");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: a Windows-shaped cwd under home passes the under-home check", () => {
  const dir = tmp();
  try {
    // 0.12.0 hardcoded home + "/": on Windows the separator is "\\", so every
    // real cwd (C:\Users\x\proj) failed validation — the loop could only
    // run with cwd == home exactly. A dir whose name contains a literal
    // backslash reproduces the Windows path shape on Linux: <home>\proj.
    const winDir = dir + "\\proj";
    mkdirSync(winDir);
    writeFileSync(join(dir, "prompt.md"), "probe");
    const replies = {
      "workspace.list": { result: { workspaces: [] } },
      "workspace.create": { result: { workspace: { workspace_id: "w9" } } },
      "workspace.rename": { result: { type: "ok" } },
      "tab.create": { result: { root_pane: { pane_id: "w9:p1" } } },
      "pane.send_text": { result: { type: "ok" } },
    };
    const r = run(dir, { cmd: ["start"], stubReplies: replies }, {
      config: { v: 1, label: "probe", promptFile: join(dir, "prompt.md"), cwd: winDir, cooldownMs: 10_000, maxCycles: 1 },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.calls.some((c) => c.startsWith("tab.create ") && JSON.parse(c.slice("tab.create ".length)).cwd === winDir),
      "the Windows-shaped cwd reaches tab.create (pane born in it — no cd typed)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: cwd outside home is still rejected, whatever the separator", () => {
  const dir = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const bad = run(dir, { cmd: ["start"] }, { config: goodConfig(dir, { cwd: outside }) });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /must live under the owner's home/);
    assert.deepEqual(bad.calls, [], "a rejected cwd never reaches the bridge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("loop status: a UTF-8 BOM in loop.json still loads (Windows Notepad/PowerShell default)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    // PowerShell 5.1 `Set-Content -Encoding utf8` and old Notepad write a
    // UTF-8 BOM; JSON.parse chokes on it and the plugin reported the
    // misleading "loop.json not found (CONFIG_DIR)" — caught live on the
    // owner's Windows laptop during the C12 probe.
    const bom = "\uFEFF" + JSON.stringify(goodConfig(dir));
    const r = run(dir, { cmd: ["status"] }, { config: bom });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.config.ok, true, `config must load, got: ${out.config.error}`);
    assert.equal(out.config.label, "probe");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: a bridge that holds stdin open (real 0.9.5 shape) still gets its reply", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe");
    const { bin, calls } = holdingStubHerdr(dir, {
      "workspace.list": { result: { workspaces: [] } },
      "workspace.create": { result: { workspace: { workspace_id: "w9" } } },
      "workspace.rename": { result: { type: "ok" } },
      "tab.create": { result: { root_pane: { pane_id: "w9:p1" } } },
      "pane.send_text": { result: { type: "ok" } },
      "pane.list": { result: { panes: [] } },
    });
    // The stub replies after 250ms and never exits: spawnSync(input) would
    // race its own EOF against the delayed reply and starve the start —
    // exactly the Windows failure (request executed server-side, plugin
    // died "no-reply"). The client must hold stdin open until the reply.
    const r = run(dir, { cmd: ["start"] }, { config: goodConfig(dir), bin });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.calls.some((c) => c.startsWith("workspace.create ")), "the request reached the bridge");
    assert.ok(r.calls.some((c) => c.startsWith("pane.send_text ")), "boot was typed after the delayed replies");
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
    // A bootCommand with a newline would type a half-command plus Enter.
    writeFileSync(join(dir, "prompt.md"), "probe");
    const badBoot = run(dir, { cmd: ["start"], stubReplies: { "tab.create": { result: { root_pane: { pane_id: "w7:p3" } } } } },
      { config: goodConfig(dir, { bootCommand: "pi one\ntwo" }) });
    assert.equal(badBoot.code, 2, "untypeable bootCommand dies before touching the bridge");
    assert.match(badBoot.stderr, /bootCommand/);
    assert.deepEqual(badBoot.calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop start: bootCommand override reaches the pane verbatim (substituted)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompt.md"), "probe prompt");
    const replies = {
      "workspace.list": { result: { workspaces: [] } },
      "workspace.create": { result: { workspace: { workspace_id: "w9" } } },
      "workspace.rename": { result: { type: "ok" } },
      "tab.create": { result: { root_pane: { pane_id: "w9:p1" } } },
      "pane.send_text": { result: { type: "ok" } },
    };
    const r = run(dir, { cmd: ["start"], stubReplies: replies },
      { config: goodConfig(dir, { bootCommand: 'cd /d {cwd} && pi "@{promptFile}" --mode text' }) });
    assert.equal(r.code, 0, r.stderr);
    const send = r.calls.find((c) => c.startsWith("pane.send_text"));
    const text = JSON.parse(send.slice("pane.send_text ".length)).text;
    assert.equal(text, `cd /d ${dir} && pi "@${join(dir, "prompt.md")}" --mode text\r`, "the owner's shell gets the owner's syntax; Enter still ours");
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
      state: { paneId: "w7:p3", workspaceId: "w7", status: "running", armed: true, cycles: 2, lastNudgeAt: 123 },
    });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.config.ok, true);
    assert.equal(j.config.maxCycles, 5);
    assert.equal(j.config.boot, `pi "@${join(dir, "prompt.md")}"`, "operators can see exactly what will be typed");
    assert.equal(j.state.cycles, 2);
    assert.equal(j.state.armed, true);
    assert.equal(j.state.paneAlive, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
