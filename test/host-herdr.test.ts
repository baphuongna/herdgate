/**
 * The Herdr adapter against a synthetic `herdr api snapshot` document shaped like the
 * real one (protocol 22, herdr 0.9.5). No live Herdr needed: `mapSnapshot` is pure and
 * the adapter takes an injected reader.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HerdrAdapter, HOST_PROTOCOL, mapSnapshot } from "../src/host/herdr.ts";
import type { DeviceView } from "../src/protocol/agent.ts";

/** Mirrors the live shape: `{id, result:{snapshot:{…}}}`. */
const snapshot = {
  id: "cli:api:snapshot",
  result: {
    snapshot: {
      agents: [
        {
          agent: "reviewer",
          agent_session: { agent: "reviewer", kind: "path", source: "herdr:pi", value: "/tmp/session.jsonl" },
          agent_status: "working",
          cwd: "/home/dev/project",
          focused: true,
          foreground_cwd: "/home/dev/project",
          pane_id: "w1:p1",
          revision: 8,
          state_change_seq: 44,
          tab_id: "w1:t1",
          terminal_id: "term_abc",
          terminal_title: "pi - project",
          terminal_title_stripped: "pi - project",
          workspace_id: "w1",
        },
      ],
      focused_pane_id: "w1:p1",
      focused_tab_id: "w1:t1",
      focused_workspace_id: "w1",
      layouts: [],
      panes: [{ agent_status: "working", cwd: "/home/dev/project", focused: true, pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
      protocol: 22,
      tabs: [{ agent_status: "working", focused: true, label: "1", number: 1, pane_count: 1, tab_id: "w1:t1", workspace_id: "w1" }],
      version: "0.9.5",
      workspaces: [
        { active_tab_id: "w1:t1", agent_status: "working", focused: true, label: "project", number: 1, pane_count: 1, tab_count: 1, workspace_id: "w1" },
        { active_tab_id: "w2:t1", agent_status: "unknown", focused: false, label: "scratch", number: 2, pane_count: 1, tab_count: 1, workspace_id: "w2" },
      ],
    },
  },
};

const waitFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const devices: DeviceView[] = [{ id: "d1", name: "iPhone", scope: "read", connected: true }];

function harness(read: () => Promise<ReturnType<typeof mapSnapshot> extends never ? never : any>) {
  const sent: { device: string; payload: any }[] = [];
  const adapter = new HerdrAdapter({
    name: "dev-mac",
    pollMs: 60_000,
    log: () => {},
    read,
  });
  adapter.attach({ send: (device, payload) => sent.push({ device, payload }), devices, scopeOf: () => "read" });
  return { adapter, sent };
}

test("mapSnapshot: reads the live shape per field", () => {
  const view = mapSnapshot(snapshot, "2026-01-01T00:00:00.000Z");
  assert.equal(view.source, "herdr");
  assert.equal(view.herdrVersion, "0.9.5");
  assert.equal(view.protocol, 22);
  assert.equal(view.takenAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(view.focused, { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" });
  assert.equal(view.workspaces.length, 2);
  assert.deepEqual(view.workspaces[0], {
    id: "w1",
    label: "project",
    number: 1,
    tabs: 1,
    panes: 1,
    agentStatus: "working",
    focused: true,
  });
  assert.equal(view.agents.length, 1);
  assert.deepEqual(view.agents[0], {
    name: "reviewer",
    kind: "reviewer",
    status: "working",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/home/dev/project",
    title: "pi - project",
  });
});

test("mapSnapshot: tolerates a bare snapshot and junk fields", () => {
  const bare = mapSnapshot({ version: "9.9.9", protocol: 30, workspaces: [{ workspace_id: "w1", number: "x" }, 7], agents: "nope" });
  assert.equal(bare.herdrVersion, "9.9.9");
  assert.equal(bare.workspaces.length, 1);
  assert.equal(bare.workspaces[0].number, 0, "junk number degrades, never NaN");
  assert.equal(bare.workspaces[0].label, "");
  assert.deepEqual(bare.agents, []);
  assert.deepEqual(bare.focused, { workspaceId: null, tabId: null, paneId: null });

  const empty = mapSnapshot({});
  assert.equal(empty.workspaces.length, 0);
  assert.equal(empty.protocol, 0);
});

test("adapter: device gets the view, and the host protocol is read-only", async () => {
  const { adapter, sent } = harness(async () => mapSnapshot(snapshot));
  adapter.onDevices(devices);
  await adapter.refresh();

  // A `view` request is answered with the mapped snapshot.
  adapter.onFrame("d1", { op: "view" });
  const view = sent.find((m) => m.payload.op === "view");
  assert.ok(view, "a view reply is sent");
  assert.equal(view!.device, "d1");
  assert.equal(view!.payload.view.workspaces.length, 2);

  // A `ping` is answered, not executed against Herdr.
  adapter.onFrame("d1", { op: "ping", n: 7 });
  const pong = sent.find((m) => m.payload.op === "pong");
  assert.equal(pong?.payload.n, 7);

  // Anything else is refused HERE — the cloud cannot see payloads, so the host is the
  // last trusted decision point.
  for (const bad of [{ op: "run", cmd: "rm -rf /" }, { op: "key", text: "ls" }, { op: "prompt", text: "hi" }, {}]) {
    adapter.onFrame("d1", bad);
  }
  const refused = sent.filter((m) => m.payload.op === "error" && m.payload.code === "read-only");
  assert.equal(refused.length, 4);
  assert.match(refused[0].payload.message, new RegExp(HOST_PROTOCOL));
});

test("adapter: pushes on change only, and reports an unreadable Herdr honestly", async () => {
  let current: unknown = snapshot;
  const { adapter, sent } = harness(async () => mapSnapshot(current));
  adapter.onDevices(devices);

  await adapter.refresh();
  const first = sent.filter((m) => m.payload.op === "view").length;
  assert.equal(first, 1, "the first read pushes once");

  await adapter.refresh();
  assert.equal(sent.filter((m) => m.payload.op === "view").length, 1, "an unchanged view does not re-push");

  // A workspace appears → one more push.
  current = structuredClone(snapshot);
  (current as typeof snapshot).result.snapshot.workspaces.push({
    active_tab_id: "w3:t1",
    agent_status: "unknown",
    focused: false,
    label: "new",
    number: 3,
    pane_count: 1,
    tab_count: 1,
    workspace_id: "w3",
  });
  await adapter.refresh();
  assert.equal(sent.filter((m) => m.payload.op === "view").length, 2);
  assert.equal(adapter.view?.workspaces.length, 3);

  // Herdr becomes unreadable: paired devices are told, with the CLI's own words.
  const failing = harness(async () => {
    throw new Error("herdr: server is not running");
  });
  failing.adapter.onDevices(devices);
  await failing.adapter.refresh();
  const err = failing.sent.find((m) => m.payload.op === "error");
  assert.equal(err?.payload.code, "host-unavailable");
  assert.match(err!.payload.message, /server is not running/);
  assert.equal(failing.adapter.view, null);

  // Before any read, a `view` request reads once and then answers (never hangs).
  failing.sent.length = 0;
  let reads = 0;
  const lazy = harness(async () => {
    reads += 1;
    return mapSnapshot(snapshot);
  });
  lazy.adapter.onFrame("d1", { op: "view" });
  await waitFor(50);
  assert.equal(reads, 1, "an unanswered view triggers exactly one read");
  assert.equal(lazy.sent.filter((m) => m.payload.op === "view").length, 1, "and then answers with it");

  // A read that fails still answers, honestly.
  lazy.sent.length = 0;
  lazy.adapter.stop();
  const broken = harness(async () => {
    throw new Error("herdr: boom");
  });
  broken.adapter.onFrame("d1", { op: "view" });
  await waitFor(50);
  assert.equal(broken.sent[0].payload.code, "host-unavailable");
  assert.match(broken.sent[0].payload.message, /boom/);
});

test("adapter: act pairing is denied unless the operator opts in", () => {
  const ask = { requestId: "pr1", device: { name: "iPhone" }, scope: "act" as const };
  assert.equal(new HerdrAdapter({ name: "m" }).onPairAsk(ask), false);
  assert.equal(new HerdrAdapter({ name: "m", allowAct: true }).onPairAsk(ask), true);
  assert.equal(
    new HerdrAdapter({ name: "m", allowAct: true }).onPairAsk({ ...ask, scope: "read" }),
    false,
    "read never needs the act switch",
  );
});
