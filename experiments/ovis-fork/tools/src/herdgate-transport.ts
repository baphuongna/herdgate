// F1 spike: Herdgate's replacement backend for the UNMODIFIED Ovis app (Ovis 0.5.9 @ fe3058a3).
// Loaded before the app exactly like upstream's demo transport (site/demo/transport.ts): the app's
// Transport seam (src/lib/transport.ts) only needs window.fetch, window.WebSocket and window.EventSource.
// This build runs the app as a WATCHING device: reads come from the local Herdr runtime through the
// Herdgate source (/hg/*); every write is refused with the Ovis wire error `read_only`.
import { resolveHerdrKeys } from "../../../ovis-pin/shared/herdr-keys.ts";

const APP_VERSION = "0.5.9";
const realFetch = window.fetch.bind(window);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const READ_ONLY = { code: "read_only", message: "Herdgate runs the Ovis app as a watching device: this operation is not available." };
const AUTH = { required: false, authenticated: true, via: "device", role: "watch" };
const BOOT_ID = crypto.randomUUID();
const MIRROR_INTERVAL_MS = 1000;

type Session = { host: string; runtimeGeneration: string; snapshot: any };
let cached: { at: number; value: Session } | null = null;
async function readSession(): Promise<Session> {
  if (cached && Date.now() - cached.at < 1500) return cached.value;
  const res = await realFetch("/hg/session", { cache: "no-store" });
  if (!res.ok) throw new Error(`herdgate source: /hg/session ${res.status}`);
  const value = (await res.json()) as Session;
  cached = { at: Date.now(), value };
  return value;
}
const unavailable = () => error("server_unavailable", "Herdr runtime is unavailable", 503);
const machineOf = (s: Session) => ({
  id: "local", name: s.host, kind: "local", enabled: true, state: "connected", error: null, snapshot: s.snapshot,
  herdr: { version: s.snapshot.version, protocol: s.snapshot.protocol, terminal_attach: true },
});

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  if (method !== "GET") return error(READ_ONLY.code, READ_ONLY.message, 403);
  const path = url.pathname;
  if (path === "/api/health" || path === "/api/machines" || path === "/api/session") {
    let s: Session | null;
    try { s = await readSession(); } catch { s = null; }
    if (!s) return unavailable();
    if (path === "/api/health") return json({ ok: true, herdr: machineOf(s).herdr, version: APP_VERSION, web_ui: { boot_id: BOOT_ID, revision: null }, auth: AUTH });
    if (path === "/api/machines") return json({ machines: [machineOf(s)] });
    return json({ snapshot: s.snapshot });
  }
  switch (path) {
    case "/api/herdr-ui": return json({ copy_on_select: false, keys: resolveHerdrKeys(undefined) });
    case "/api/updates": return json({ managed: false, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: APP_VERSION, latest_version: null, available: false, checked_at: null, blocked_reason: null, error: null });
    case "/api/preferences": return json({ revision: 0, settings: {}, muted_panes: [] });
    case "/api/pane/commands": return json({ commands: [] });
    case "/api/pane/conversation": return json({ source: "scrollback", turns: [] });
    case "/api/pane/omo-tasks": return json({ tasks: [], runs: [], server_time: new Date().toISOString() });
    case "/api/pane/prompt": return json({ prompt: null, outcomes: [] });
    case "/api/seen": return json({ finishes: [] });
    case "/api/worktree/inventory": return json({ entries: url.searchParams.getAll("workspace_id").map((workspace_id) => ({ workspace_id, error: { status: 403, code: READ_ONLY.code, message: READ_ONLY.message } })) });
    default: return error("not_found", `Herdgate does not provide ${path}`, 404);
  }
}) as typeof fetch;

class HerdgateEventSource {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly url: string; readyState = 0; onopen: any = null; onmessage: any = null; onerror: any = null;
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  constructor(url: string | URL) {
    this.url = String(url);
    setTimeout(() => { this.readyState = 1; this.emit("open"); }, 0);
    setTimeout(async () => {
      try {
        const res = await window.fetch(this.url, { cache: "no-store" });
        if (res.ok) this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: (await res.json()).machines }) }));
      } catch { /* stays open, silent */ }
    }, 0);
  }
  close(): void { this.readyState = 2; }
  addEventListener(type: string, l: EventListenerOrEventListenerObject): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(l); }
  removeEventListener(type: string, l: EventListenerOrEventListenerObject): void { this.listeners.get(type)?.delete(l); }
  private emit(type: string, event?: Event): void {
    const e = event ?? new Event(type);
    (this as any)[`on${type}`]?.call(this, e);
    for (const l of this.listeners.get(type) ?? []) (typeof l === "function" ? l : l.handleEvent).call(this, e);
  }
}
window.EventSource = HerdgateEventSource as unknown as typeof EventSource;

class HerdgateSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly url: string; readyState = 0; bufferedAmount = 0; binaryType: BinaryType = "blob";
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private mirrors = new Map<string, ReturnType<typeof setInterval>>();
  constructor(url: string | URL) {
    this.url = String(url);
    setTimeout(() => { this.readyState = 1; this.emit("open"); }, 0);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1 || typeof data !== "string") return;
    let m: any; try { m = JSON.parse(data); } catch { return; }
    void this.handle(m);
  }
  close(): void { for (const timer of this.mirrors.values()) clearInterval(timer); this.mirrors.clear(); this.readyState = 3; this.emit("close", new CloseEvent("close", { code: 1000 })); }
  addEventListener(type: string, l: EventListenerOrEventListenerObject): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(l); }
  removeEventListener(type: string, l: EventListenerOrEventListenerObject): void { this.listeners.get(type)?.delete(l); }
  private push(frame: unknown): void { if (this.readyState === 1) this.emit("message", new MessageEvent("message", { data: JSON.stringify(frame) })); }
  private emit(type: string, event?: Event): void {
    const e = event ?? new Event(type);
    (this as any)[`on${type}`]?.call(this, e);
    for (const l of this.listeners.get(type) ?? []) (typeof l === "function" ? l : l.handleEvent).call(this, e);
  }
  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case "role": {
        // Herdgate grants observe only, whatever the page asks for.
        this.push({ type: "role-ack", mode: "observe" });
        try { this.push({ type: "snapshot", snapshot: (await readSession()).snapshot }); } catch { this.push({ type: "error", code: "runtime_unavailable", message: "Herdr runtime is unavailable" }); }
        return;
      }
      case "ping": if (Number.isSafeInteger(m.id)) this.push({ type: "pong", id: m.id }); return;
      case "attach": {
        if (typeof m.pane_id !== "string" || this.mirrors.has(m.pane_id)) return;
        this.mirrors.set(m.pane_id, setInterval(() => void this.mirror(m.pane_id), MIRROR_INTERVAL_MS));
        await this.mirror(m.pane_id);
        return;
      }
      case "detach": { const t = this.mirrors.get(m.pane_id); if (t) clearInterval(t); this.mirrors.delete(m.pane_id); return; }
      case "input": case "keys": case "submit": case "secret": case "insert": case "resize": case "release-size": case "take-over": case "pending-action":
        this.push({ type: "error", code: READ_ONLY.code, message: READ_ONLY.message, ...(typeof m.pane_id === "string" ? { pane_id: m.pane_id } : {}), ...(Number.isSafeInteger(m.id) ? { id: m.id } : {}) });
        return;
      default: return; // presence, watch/unwatch, conversation-watch, machine-events, pty-ack, device-notice-replay, features
    }
  }
  private async mirror(paneId: string): Promise<void> {
    let s: Session; try { s = await readSession(); } catch { return; }
    try {
      const res = await realFetch(`/hg/pane/${encodeURIComponent(paneId)}`, { cache: "no-store", headers: { "x-herdgate-runtime-generation": s.runtimeGeneration } });
      if (!res.ok) { if (res.status === 404 || res.status === 409) { const t = this.mirrors.get(paneId); if (t) clearInterval(t); this.mirrors.delete(paneId); this.push({ type: "error", code: "pane_gone", message: "The pane is no longer available", pane_id: paneId }); } return; }
      const f = await res.json();
      if (this.readyState !== 1 || !this.mirrors.has(paneId)) return;
      this.push({ type: "pane-geometry", pane_id: paneId, cols: f.cols, rows: f.rows });
      this.push({ type: "pty-data", pane_id: paneId, data: "\u001b[0m\u001b[2J\u001b[3J\u001b[H" + f.text });
    } catch { /* next tick */ }
  }
}
const NativeWebSocket = window.WebSocket;
window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
  const target = new URL(String(url), location.origin);
  return target.pathname === "/ws" ? (new HerdgateSocket(target.href) as unknown as WebSocket) : new NativeWebSocket(url, protocols as any);
} as unknown as typeof WebSocket;
for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(window.WebSocket, name, { value: NativeWebSocket[name] });
