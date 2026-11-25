import type { ConsolePaneScreen, ConsoleSessionSnapshot } from "./view-model.ts";

export interface ConsoleCapabilities {
  mode: "mirror";
  scope: "read";
  transport: "rpc" | "unavailable";
  features: { session: boolean; paneScreen: boolean; act: false; attach: boolean; chat: boolean; inbox: boolean; fileViewer: boolean };
}

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.code = code;
  }
}

const API = "/api/console/v1";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: unknown, keys: readonly string[]): boolean {
  return object(value) && keys.every((key) => typeof value[key] === "string");
}

function stringField(value: unknown, key: string): string | null {
  return object(value) && typeof value[key] === "string" && value[key].length > 0 ? value[key] : null;
}

/** Adapt the runtime's generated Herdr SessionSnapshot IDs/labels, not an invented camelCase wire shape. */
function adaptRuntimeSession(payload: unknown): ConsoleSessionSnapshot | null {
  if (!object(payload) || typeof payload.runtimeGeneration !== "string" || !payload.runtimeGeneration || !object(payload.snapshot)) return null;
  const raw = payload.snapshot;
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.tabs) || !Array.isArray(raw.panes)) return null;
  const workspaces: ConsoleSessionSnapshot["workspaces"][number][] = [];
  for (const item of raw.workspaces) {
    const id = stringField(item, "workspace_id");
    if (!id) return null;
    workspaces.push({ id, label: stringField(item, "label") ?? id });
  }
  const tabs: ConsoleSessionSnapshot["tabs"][number][] = [];
  for (const [index, item] of raw.tabs.entries()) {
    const id = stringField(item, "tab_id");
    const workspaceId = stringField(item, "workspace_id");
    if (!id || !workspaceId) return null;
    tabs.push({ id, workspaceId, label: stringField(item, "label") ?? `Tab ${index + 1}` });
  }
  const panes: ConsoleSessionSnapshot["panes"][number][] = [];
  for (const item of raw.panes) {
    const id = stringField(item, "pane_id");
    const tabId = stringField(item, "tab_id");
    const workspaceId = stringField(item, "workspace_id");
    if (!id || !tabId || !workspaceId) return null;
    panes.push({ id, tabId, workspaceId, title: stringField(item, "terminal_title_stripped")
      ?? stringField(item, "terminal_title") ?? stringField(item, "label") ?? id });
  }
  const focusedPaneId = stringField(raw, "focused_pane_id")
    ?? (Array.isArray(raw.panes) ? stringField(raw.panes.find((item) => object(item) && item.focused === true), "pane_id") : null);
  const focusedTabId = stringField(raw, "focused_tab_id") ?? (focusedPaneId ? panes.find((pane) => pane.id === focusedPaneId)?.tabId ?? null : null);
  const focusedWorkspaceId = stringField(raw, "focused_workspace_id")
    ?? (focusedPaneId ? panes.find((pane) => pane.id === focusedPaneId)?.workspaceId ?? null : null);
  const paneCounts = new Map<string, number>();
  const tabCounts = new Map<string, number>();
  const tabsByWorkspace = new Map<string, string[]>();
  for (const pane of panes) {
    paneCounts.set(pane.tabId, (paneCounts.get(pane.tabId) ?? 0) + 1);
    tabCounts.set(pane.workspaceId, (tabCounts.get(pane.workspaceId) ?? 0) + 1);
  }
  for (const tab of tabs) tabsByWorkspace.set(tab.workspaceId, [...(tabsByWorkspace.get(tab.workspaceId) ?? []), tab.id]);
  const ovisSnapshot = {
    ...raw,
    version: stringField(raw, "version") ?? "unknown",
    protocol: Number.isSafeInteger(raw.protocol) ? raw.protocol : 0,
    workspaces: workspaces.map((workspace, index) => {
      const source = raw.workspaces.find((item) => object(item) && item.workspace_id === workspace.id);
      const workspaceTabs = tabsByWorkspace.get(workspace.id) ?? [];
      return { ...(object(source) ? source : {}), workspace_id: workspace.id, label: workspace.label,
        active_tab_id: stringField(source, "active_tab_id") ?? (workspace.id === focusedWorkspaceId ? focusedTabId : null) ?? workspaceTabs[0] ?? "",
        agent_status: stringField(source, "agent_status") ?? "unknown", focused: source?.focused === true || workspace.id === focusedWorkspaceId,
        number: Number.isSafeInteger(source?.number) ? source.number : index + 1,
        pane_count: Number.isSafeInteger(source?.pane_count) ? source.pane_count : tabCounts.get(workspace.id) ?? 0,
        tab_count: Number.isSafeInteger(source?.tab_count) ? source.tab_count : workspaceTabs.length };
    }),
    tabs: tabs.map((tab, index) => {
      const source = raw.tabs.find((item) => object(item) && item.tab_id === tab.id);
      return { ...(object(source) ? source : {}), tab_id: tab.id, workspace_id: tab.workspaceId, label: tab.label,
        agent_status: stringField(source, "agent_status") ?? "unknown", focused: source?.focused === true || tab.id === focusedTabId,
        number: Number.isSafeInteger(source?.number) ? source.number : index + 1,
        pane_count: Number.isSafeInteger(source?.pane_count) ? source.pane_count : paneCounts.get(tab.id) ?? 0 };
    }),
    panes: panes.map((pane) => {
      const source = raw.panes.find((item) => object(item) && item.pane_id === pane.id);
      return { ...(object(source) ? source : {}), pane_id: pane.id, tab_id: pane.tabId, workspace_id: pane.workspaceId,
        title: stringField(source, "title") ?? pane.title, terminal_id: stringField(source, "terminal_id") ?? pane.id,
        terminal_title: stringField(source, "terminal_title") ?? pane.title, focused: source?.focused === true || pane.id === focusedPaneId,
        agent_status: stringField(source, "agent_status") ?? "unknown",
        revision: Number.isSafeInteger(source?.revision) ? source.revision : 0 };
    }),
    layouts: Array.isArray(raw.layouts) ? raw.layouts : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
  } as unknown as NonNullable<ConsoleSessionSnapshot["ovisSnapshot"]>;
  return { runtime: "available", runtimeGeneration: payload.runtimeGeneration, workspaces, tabs, panes,
    focused: { workspaceId: focusedWorkspaceId, tabId: focusedTabId, paneId: focusedPaneId }, ovisSnapshot };
}

function isScreen(value: unknown): value is ConsolePaneScreen {
  if (!object(value)) return false;
  const dimension = (entry: unknown): boolean => entry === null || (Number.isSafeInteger(entry) && Number(entry) > 0);
  return typeof value.paneId === "string" && typeof value.runtimeGeneration === "string"
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && dimension(value.cols) && dimension(value.rows) && typeof value.ansi === "string"
    && typeof value.capturedAt === "string" && typeof value.truncated === "boolean";
}

export class ConsoleApiClient {
  #token: string | null = null;
  readonly #fetch: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.#fetch = fetcher;
  }

  get authenticated(): boolean { return this.#token !== null; }

  async redeem(code: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(code)) throw new TypeError("Invalid local login code");
    const payload = await this.#request<unknown>("/auth/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
      authenticated: false,
    });
    if (!object(payload) || typeof payload.token !== "string" || !/^[0-9a-f]{64}$/.test(payload.token)
      || !Number.isSafeInteger(payload.expiresInMs) || Number(payload.expiresInMs) <= 0
      || !Number.isSafeInteger(payload.maxAgeMs) || Number(payload.maxAgeMs) <= 0) {
      throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid login response");
    }
    this.#token = payload.token;
  }

  async capabilities(): Promise<ConsoleCapabilities> {
    const payload = await this.#request<unknown>("/capabilities");
    if (!object(payload) || payload.mode !== "mirror" || payload.scope !== "read"
      || (payload.transport !== "rpc" && payload.transport !== "unavailable")
      || !object(payload.features) || typeof payload.features.session !== "boolean"
      || typeof payload.features.paneScreen !== "boolean" || payload.features.act !== false
      || typeof payload.features.attach !== "boolean" || typeof payload.features.chat !== "boolean"
      || typeof payload.features.inbox !== "boolean" || typeof payload.features.fileViewer !== "boolean") {
      throw new ConsoleApiError(502, "invalid_response", "Console returned invalid capability data");
    }
    return payload as unknown as ConsoleCapabilities;
  }

  async fetchSession(signal?: AbortSignal): Promise<ConsoleSessionSnapshot> {
    const payload = await this.#request<unknown>("/session", { signal });
    const snapshot = adaptRuntimeSession(payload);
    if (!snapshot) throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid session snapshot");
    return snapshot;
  }

  async fetchScreen(paneId: string, expectedGeneration: string, signal?: AbortSignal): Promise<ConsolePaneScreen> {
    if (!paneId || !expectedGeneration) throw new TypeError("paneId and runtime generation are required");
    const path = `/pane/${encodeURIComponent(paneId)}/screen`;
    const payload = await this.#request<unknown>(path, { signal, headers: { "x-herdgate-runtime-generation": expectedGeneration } });
    if (!isScreen(payload)) throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid pane screen");
    if (payload.paneId !== paneId) throw new ConsoleApiError(502, "pane_mismatch", "Console returned a screen for a different pane");
    if (payload.runtimeGeneration !== expectedGeneration) throw new ConsoleApiError(409, "generation_mismatch", "Runtime changed while reading pane screen");
    return payload;
  }

  async logout(): Promise<void> {
    if (!this.#token) return;
    try {
      await this.#request<void>("/auth/logout", { method: "POST", allowNoContent: true });
    } finally {
      this.#token = null;
    }
  }

  async #request<T>(route: string, options: { method?: "GET" | "POST"; body?: string; signal?: AbortSignal; authenticated?: boolean; maxBytes?: number; headers?: Record<string, string>; allowNoContent?: boolean } = {}): Promise<T> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && this.#token === null) throw new ConsoleApiError(401, "unauthenticated", "Sign in to the local Console");
    const headers = new Headers({ accept: "application/json", ...options.headers });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (authenticated && this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    const response = await this.#fetch(`${API}${route}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      mode: "same-origin",
    });
    if (response.status === 401) this.#token = null;
    if (response.status === 204 && options.allowNoContent) return undefined as T;
    let payload: unknown;
    try {
      const bytes = await response.arrayBuffer();
      const limit = options.maxBytes ?? 256 * 1024;
      if (bytes.byteLength > limit) throw new ConsoleApiError(413, "response_too_large", "Console response exceeded the local size limit");
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (error instanceof ConsoleApiError) throw error;
      throw new ConsoleApiError(response.status, "invalid_response", "Console returned a non-JSON response");
    }
    if (!response.ok) {
      const error = object(payload) && object(payload.error) ? payload.error : null;
      const code = error && typeof error.code === "string" ? error.code : "request_failed";
      const message = error && typeof error.message === "string" ? error.message : `Console request failed (${response.status})`;
      throw new ConsoleApiError(response.status, code, message);
    }
    return payload as T;
  }
}
