/**
 * The Herdr adapter: official Herdr (https://herdr.dev) as a herdgate host.
 *
 * Upstream contract used here — and nothing else:
 *   - `herdr api snapshot` → one JSON object `{id, result:{snapshot}}`, printed by the
 *     Herdr CLI without a TUI (`herdr api --help`, protocol 22 on 0.9.5). The snapshot
 *     carries `version`, `protocol`, `workspaces[]`, `tabs[]`, `panes[]`, `agents[]`
 *     and the focused ids. Verified against a live server; shapes are read per field,
 *     never predicted.
 *   - `herdr status --json` (optional) distinguishes "no server running" from a real
 *     failure so the device sees an honest state instead of an empty list.
 *
 * This adapter is **metadata-only and read-only**. It never runs `pane read`, never
 * writes a keystroke, never prompts an agent, and never starts or splits layout — the
 * device view is workspaces/tabs/panes/agents/status and nothing else. Terminal
 * content is deliberately out of scope for the first slice.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAdapter, PairAsk } from "../agent/adapter.ts";
import type { DeviceView } from "../protocol/agent.ts";

const run = promisify(execFile);

/** Biggest snapshot we accept from the CLI (a session with thousands of panes). */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export interface HerdrWorkspace {
  id: string;
  label: string;
  number: number;
  tabs: number;
  panes: number;
  agentStatus: string;
  focused: boolean;
}

export interface HerdrAgent {
  name: string;
  /** Herdr's recognized agent kind (`pi`, `claude`, `codex`, …). */
  kind: string;
  /** `idle` | `working` | `blocked` | `done` | `unknown` — upstream's own words. */
  status: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
  title: string;
}

export interface HerdrView {
  v: 1;
  source: "herdr";
  herdrVersion: string;
  protocol: number;
  takenAt: string;
  focused: { workspaceId: string | null; tabId: string | null; paneId: string | null };
  workspaces: HerdrWorkspace[];
  agents: HerdrAgent[];
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Only object entries: a junk element in `workspaces[]` is dropped, not shown empty. */
const objs = (v: unknown): Record<string, unknown>[] =>
  arr(v).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x));
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

function unwrapSnapshot(raw: unknown): Record<string, unknown> {
  const top = obj(raw);
  const result = obj(top.result);
  if (result.snapshot !== undefined) return obj(result.snapshot);
  if (top.snapshot !== undefined) return obj(top.snapshot);
  return top; // already the snapshot itself
}

/**
 * Map a `herdr api snapshot` document onto the device view. Pure and tolerant: every
 * field is read defensively, so a newer Herdr that adds keys keeps working and a
 * missing key degrades to an empty/honest value rather than throwing.
 */
export function mapSnapshot(raw: unknown, takenAt: string = new Date().toISOString()): HerdrView {
  const snap = unwrapSnapshot(raw);
  const workspaces = objs(snap.workspaces).map((o): HerdrWorkspace => {
    return {
      id: str(o.workspace_id),
      label: str(o.label),
      number: num(o.number),
      tabs: num(o.tab_count),
      panes: num(o.pane_count),
      agentStatus: str(o.agent_status, "unknown"),
      focused: bool(o.focused),
    };
  });
  const agents = objs(snap.agents).map((o): HerdrAgent => {
    return {
      name: str(o.agent),
      kind: str(obj(o.agent_session).agent, str(o.agent)),
      status: str(o.agent_status, "unknown"),
      workspaceId: str(o.workspace_id),
      tabId: str(o.tab_id),
      paneId: str(o.pane_id),
      cwd: str(o.cwd),
      title: str(o.terminal_title_stripped, str(o.terminal_title)),
    };
  });
  const focused = obj(snap);
  return {
    v: 1,
    source: "herdr",
    herdrVersion: str(focused.version),
    protocol: num(focused.protocol),
    takenAt,
    focused: {
      workspaceId: typeof focused.focused_workspace_id === "string" ? focused.focused_workspace_id : null,
      tabId: typeof focused.focused_tab_id === "string" ? focused.focused_tab_id : null,
      paneId: typeof focused.focused_pane_id === "string" ? focused.focused_pane_id : null,
    },
    workspaces,
    agents,
  };
}

export interface HerdrReadOptions {
  /** `herdr` on PATH by default (or $HERDGATE_HERDR_BIN). */
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run `herdr api snapshot` once and map it. Throws with the CLI's own words. */
export async function readHerdrView(o: HerdrReadOptions = {}): Promise<HerdrView> {
  const bin = o.bin ?? process.env.HERDGATE_HERDR_BIN ?? "herdr";
  let stdout: string;
  try {
    ({ stdout } = await run(bin, ["api", "snapshot"], {
      timeout: o.timeoutMs ?? 5_000,
      maxBuffer: MAX_SNAPSHOT_BYTES,
      env: o.env ?? process.env,
    }));
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    const detail = (err.stderr ?? "").trim() || err.message || "herdr api snapshot failed";
    throw new Error(`herdr: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("herdr: `api snapshot` did not print JSON");
  }
  return mapSnapshot(parsed);
}

export interface HerdrPane {
  id: string;
  workspace: string;
  agent: string | null;
  status: string;
  cwd: string;
  title: string;
}

/** Live panes (`herdr pane list`), mapped for the term.list op. */
export async function readHerdrPanes(o: HerdrReadOptions = {}): Promise<HerdrPane[]> {
  const bin = o.bin ?? process.env.HERDGATE_HERDR_BIN ?? "herdr";
  const { stdout } = await run(bin, ["pane", "list"], { timeout: o.timeoutMs ?? 5_000, maxBuffer: MAX_SNAPSHOT_BYTES, env: o.env ?? process.env });
  const parsed = JSON.parse(stdout) as { result?: { panes?: unknown[] }; panes?: unknown[] };
  const panes = parsed?.result?.panes ?? parsed?.panes ?? [];
  return panes
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof (p as Record<string, unknown>).pane_id === "string")
    .map((p) => ({
      id: String(p.pane_id),
      workspace: typeof p.workspace_id === "string" ? p.workspace_id : "",
      agent: typeof p.agent === "string" ? p.agent : null,
      status: typeof p.agent_status === "string" ? p.agent_status : "unknown",
      cwd: typeof p.cwd === "string" ? p.cwd : "",
      title: typeof p.terminal_title_stripped === "string" ? p.terminal_title_stripped : typeof p.terminal_title === "string" ? p.terminal_title : "",
    }));
}

/** One pane's visible screen as ANSI (`herdr agent read --format ansi`). */
export async function readHerdrTerm(target: string, lines = 40, o: HerdrReadOptions = {}): Promise<string> {
  const bin = o.bin ?? process.env.HERDGATE_HERDR_BIN ?? "herdr";
  if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(target)) throw new Error("bad pane id");
  const n = Math.max(10, Math.min(120, Math.trunc(lines) || 40));
  const { stdout } = await run(bin, ["agent", "read", target, "--source", "visible", "--lines", String(n), "--format", "ansi"], {
    timeout: o.timeoutMs ?? 5_000,
    maxBuffer: MAX_SNAPSHOT_BYTES,
    env: o.env ?? process.env,
  });
  return stdout;
}

/** What the host can push/drive; the agent supplies it (see `HerdrAdapter.attach`). */
export interface HostLink {
  send(device: string, payload: unknown): void;
  readonly devices: readonly DeviceView[];
  scopeOf(device: string): "read" | "act" | null;
}

export interface HerdrAdapterOptions {
  /** Report name; defaults to the machine's hostname-ish label. */
  name: string;
  /** Snapshot poll interval. Default 5s. */
  pollMs?: number;
  /** Pair `act` devices without asking a human. Default **false**. */
  allowAct?: boolean;
  log?: (line: string) => void;
  /** Injectable reader (tests). Default: the real CLI. */
  read?: () => Promise<HerdrView>;
  now?: () => Date;
}

/**
 * The payload contract between a paired device and this host. The cloud never looks
 * inside `payload`, so this is herdgate's own business — versioned with `op` strings.
 *
 *   device → host   {op:"view"}                  → {op:"view", view}
 *                   {op:"ping", n?}              → {op:"pong", n, at}
 *   host  → device  {op:"view", view}            (pushed when the view changes)
 *                   {op:"error", code, message}  (unknown/refused op; `read-only` today)
 */
export const HOST_PROTOCOL = "herdgate.herdr.v1" as const;

export class HerdrAdapter implements AgentAdapter {
  readonly #o: HerdrAdapterOptions;
  readonly #log: (line: string) => void;
  #link: HostLink | null = null;
  #view: HerdrView | null = null;
  /** Per-device last-call times for the subprocess-backed term.* ops (1/s each). */
  #termThrottle = new Map<string, number>();
  #sig = "";
  #lastError: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #reading = false;

  constructor(o: HerdrAdapterOptions) {
    this.#o = o;
    this.#log = o.log ?? (() => {});
  }

  /** Wire the adapter to the live agent connection (idempotent). */
  attach(link: HostLink): void {
    this.#link = link;
  }

  info(): { name: string; version: string; capabilities?: string[] } {
    return { name: this.#o.name, version: "0.0.1", capabilities: [HOST_PROTOCOL, "read-only"] };
  }

  /** Latest view pushed (or `null` before the first successful read). */
  get view(): HerdrView | null {
    return this.#view;
  }

  /**
   * Read Herdr once and push to devices if the view changed. Public so a host can
   * refresh on demand (and so tests drive it without timers).
   */
  refresh(): Promise<void> {
    return this.#tick();
  }

  /** Begin polling. Safe to call once; `stop()` then `start()` restarts. */
  start(): void {
    if (this.#timer) return;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), this.#o.pollMs ?? 5_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  onDevices(devices: DeviceView[]): void {
    this.#log(`devices: ${devices.length === 0 ? "none" : devices.map((d) => `${d.name}:${d.scope}`).join(", ")}`);
    // A new device gets the current view at once instead of waiting for the next change.
    if (this.#view) this.#pushAll();
  }

  onFrame(device: string, payload: unknown): void {
    const link = this.#link;
    if (!link) return;
    const op = typeof payload === "object" && payload !== null ? (payload as { op?: unknown }).op : undefined;
    switch (op) {
      case "view": {
        const view = this.#view;
        if (view) return link.send(device, { op: "view", view });
        // No snapshot yet (fresh adapter, or polling off): read on demand once, then
        // answer — a device request must never hang on the host's poll schedule.
        void this.#tick({ push: false }).then(() => this.#replyView(device));
        return;
      }
      case "ping":
        return link.send(device, { op: "pong", n: (payload as { n?: unknown }).n ?? null, at: (this.#o.now?.() ?? new Date()).toISOString() });
      case "term.list": {
        // Subprocess-backed: throttle per device so a poll loop cannot fork herdr hot.
        const now = this.#o.now?.() ?? new Date();
        const last = this.#termThrottle.get(`list:${device}`) ?? 0;
        if (now.getTime() - last < 1_000) return link.send(device, { op: "error", code: "busy", message: "term.list is throttled (1/s)" });
        this.#termThrottle.set(`list:${device}`, now.getTime());
        readHerdrPanes()
          .then((panes) => link.send(device, { op: "term.list", panes }))
          .catch((e: unknown) => link.send(device, { op: "error", code: "herdr", message: `pane list failed: ${e instanceof Error ? e.message : String(e)}` }));
        return;
      }
      case "term.read": {
        const target = typeof (payload as { target?: unknown }).target === "string" ? (payload as { target: string }).target : "";
        if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(target)) return link.send(device, { op: "error", code: "bad-target", message: "term.read needs a pane id" });
        const lines = Math.max(10, Math.min(120, Number((payload as { lines?: unknown }).lines) || 40));
        const nowT = this.#o.now?.() ?? new Date();
        const lastT = this.#termThrottle.get(`read:${device}`) ?? 0;
        if (nowT.getTime() - lastT < 1_000) return link.send(device, { op: "error", code: "busy", message: "term.read is throttled (1/s)" });
        this.#termThrottle.set(`read:${device}`, nowT.getTime());
        readHerdrTerm(target, lines)
          .then((ansi) => link.send(device, { op: "term.read", target, ansi }))
          .catch((e: unknown) => link.send(device, { op: "error", code: "herdr", message: `read failed: ${e instanceof Error ? e.message : String(e)}` }));
        return;
      }
      default:
        // The read-only invariant lives HERE: the cloud cannot inspect payloads, so the
        // host is the last trusted decision point for "this device may not do that".
        return link.send(device, { op: "error", code: "read-only", message: `${HOST_PROTOCOL} has no op ${String(op)}` });
    }
  }

  onPairAsk(ask: PairAsk): boolean | Promise<boolean> {
    const ok = ask.scope === "act" && this.#o.allowAct === true;
    this.#log(`pair request from ${ask.device.name} for ${ask.scope}: ${ok ? "approved" : "denied"}`);
    return ok;
  }

  async #tick(o: { push?: boolean } = {}): Promise<void> {
    if (this.#reading) return; // one read at a time; a slow CLI must not pile up
    this.#reading = true;
    try {
      const view = await (this.#o.read ?? (() => readHerdrView()))();
      this.#lastError = null;
      const sig = JSON.stringify([view.workspaces, view.agents, view.focused]);
      const changed = sig !== this.#sig;
      this.#view = view;
      this.#sig = sig;
      if (changed && o.push !== false) this.#pushAll();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.#lastError) {
        this.#lastError = message;
        this.#log(`herdr read failed: ${message}`);
        // Tell devices the host is reachable but Herdr's state is not readable.
        if (this.#link) for (const d of this.#link.devices) this.#link.send(d.id, { op: "error", code: "host-unavailable", message });
      }
    } finally {
      this.#reading = false;
    }
  }

  #replyView(device: string): void {
    const link = this.#link;
    if (!link) return;
    const view = this.#view;
    if (view) link.send(device, { op: "view", view });
    else
      link.send(device, {
        op: "error",
        code: "host-unavailable",
        message: this.#lastError ?? "the host has not read a Herdr snapshot yet",
      });
  }

  #pushAll(): void {
    const link = this.#link;
    const view = this.#view;
    if (!link || !view) return;
    for (const d of link.devices) link.send(d.id, { op: "view", view });
  }
}
