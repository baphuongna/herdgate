import type { ConsolePaneScreen, ConsoleSessionSnapshot } from "./view-model.ts";

export interface ConsoleCapabilities {
  mode: "read-only";
  console: "ready";
  runtime: "available" | "unavailable" | "ambiguous";
  features: { session: boolean; mirror: boolean; act: false };
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

function isSession(value: unknown): value is ConsoleSessionSnapshot {
  if (!object(value)) return false;
  const runtimeKnown = value.runtime === "available" || value.runtime === "unavailable" || value.runtime === "ambiguous";
  const generationKnown = value.runtimeGeneration === null || (typeof value.runtimeGeneration === "string" && value.runtimeGeneration.length > 0);
  const workspacesValid = Array.isArray(value.workspaces) && value.workspaces.every((item) => hasStrings(item, ["id", "label"]));
  const tabsValid = Array.isArray(value.tabs) && value.tabs.every((item) => hasStrings(item, ["id", "workspaceId", "label"]));
  const panesValid = Array.isArray(value.panes) && value.panes.every((item) => hasStrings(item, ["id", "tabId", "workspaceId", "title"]));
  const focused = value.focused;
  const focusValid = object(focused) && ["workspaceId", "tabId", "paneId"].every((key) => focused[key] === null || typeof focused[key] === "string");
  return runtimeKnown && generationKnown && (value.runtime !== "available" || typeof value.runtimeGeneration === "string")
    && workspacesValid && tabsValid && panesValid && focusValid;
}

function isScreen(value: unknown): value is ConsolePaneScreen {
  if (!object(value)) return false;
  const dimension = (entry: unknown): boolean => entry === null || (Number.isSafeInteger(entry) && Number(entry) > 0);
  return typeof value.paneId === "string" && typeof value.runtimeGeneration === "string"
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
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
    if (!code || code.length > 256) throw new TypeError("Invalid local login code");
    const payload = await this.#request<unknown>("/auth/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
      authenticated: false,
    });
    if (!object(payload) || typeof payload.token !== "string" || payload.token.length < 16 || typeof payload.expiresAt !== "string") {
      throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid login response");
    }
    this.#token = payload.token;
  }

  async capabilities(): Promise<ConsoleCapabilities> {
    const payload = await this.#request<unknown>("/capabilities", { authenticated: false });
    if (!object(payload) || payload.mode !== "read-only" || payload.console !== "ready"
      || !["available", "unavailable", "ambiguous"].includes(String(payload.runtime))
      || !object(payload.features) || typeof payload.features.session !== "boolean"
      || typeof payload.features.mirror !== "boolean" || payload.features.act !== false) {
      throw new ConsoleApiError(502, "invalid_response", "Console returned invalid capability data");
    }
    return payload as unknown as ConsoleCapabilities;
  }

  async fetchSession(signal?: AbortSignal): Promise<ConsoleSessionSnapshot> {
    const payload = await this.#request<unknown>("/session", { signal });
    if (!object(payload) || !isSession(payload.snapshot)) {
      throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid session snapshot");
    }
    return payload.snapshot;
  }

  async fetchScreen(paneId: string, expectedGeneration: string, signal?: AbortSignal): Promise<ConsolePaneScreen> {
    if (!paneId || !expectedGeneration) throw new TypeError("paneId and runtime generation are required");
    const path = `/pane/${encodeURIComponent(paneId)}/screen?generation=${encodeURIComponent(expectedGeneration)}`;
    const payload = await this.#request<unknown>(path, { signal, maxBytes: 256 * 1024 });
    if (!object(payload) || !isScreen(payload.screen)) {
      throw new ConsoleApiError(502, "invalid_response", "Console returned an invalid pane screen");
    }
    if (payload.screen.paneId !== paneId) throw new ConsoleApiError(502, "pane_mismatch", "Console returned a screen for a different pane");
    if (payload.screen.runtimeGeneration !== expectedGeneration) throw new ConsoleApiError(409, "generation_mismatch", "Runtime changed while reading pane screen");
    return payload.screen;
  }

  async logout(): Promise<void> {
    if (!this.#token) return;
    try {
      await this.#request("/auth/logout", { method: "POST", body: "{}" });
    } finally {
      this.#token = null;
    }
  }

  async #request<T>(route: string, options: { method?: "GET" | "POST"; body?: string; signal?: AbortSignal; authenticated?: boolean; maxBytes?: number } = {}): Promise<T> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && this.#token === null) throw new ConsoleApiError(401, "unauthenticated", "Sign in to the local Console");
    const headers = new Headers({ accept: "application/json" });
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
    let payload: unknown;
    try {
      const bytes = await response.arrayBuffer();
      const limit = options.maxBytes ?? 1024 * 1024;
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
