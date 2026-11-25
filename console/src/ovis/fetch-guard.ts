type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const consoleRoutes = new Map<string, ReadonlySet<string>>([
  ["/api/console/v1/auth/redeem", new Set(["POST"])],
  ["/api/console/v1/auth/logout", new Set(["POST"])],
  ["/api/console/v1/capabilities", new Set(["GET"])],
  ["/api/console/v1/session", new Set(["GET"])],
]);
const screenRoute = /^\/api\/console\/v1\/pane\/[^/]+\/screen$/;

function allowedConsoleRequest(pathname: string, method: string): boolean {
  const fixedMethods = consoleRoutes.get(pathname);
  return fixedMethods?.has(method) === true || (method === "GET" && screenRoute.test(pathname));
}

/** Deny upstream Ovis API/remote requests even if a mounted dependency bypasses useMachineApi. */
export function createConsoleFetchGuard(fetcher: Fetcher, origin: string): Fetcher {
  const base = new URL(origin);
  return (input, init) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl, base);
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : undefined) ?? "GET").toUpperCase();
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/") || !allowedConsoleRequest(url.pathname, method)) {
      return Promise.reject(new TypeError("Request blocked by Herdgate Console local read-only policy"));
    }
    return fetcher(input, init);
  };
}

/** Prevent WebSocket/EventSource transports from bypassing the fetch/API allowlist. */
export function denyNetworkConstructor<T extends Function>(constructor: T, name: string): T {
  return new Proxy(constructor, {
    construct() { throw new TypeError(`${name} is disabled by Herdgate Console local read-only policy`); },
  });
}

/** Install before mounting vendor components; restore is useful for controlled tests/teardown. */
export function installConsoleNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalEventSource = globalThis.EventSource;
  globalThis.fetch = createConsoleFetchGuard(originalFetch, globalThis.location.origin);
  globalThis.WebSocket = denyNetworkConstructor(originalWebSocket, "WebSocket");
  if (typeof originalEventSource === "function") {
    globalThis.EventSource = denyNetworkConstructor(originalEventSource, "EventSource");
  }
  return () => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    if (typeof originalEventSource === "function") globalThis.EventSource = originalEventSource;
  };
}
