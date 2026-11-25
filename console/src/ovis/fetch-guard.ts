type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]> & {
  cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
};
type Fetcher = (input: FetchInput, init?: FetchInit) => Promise<Response>;
type NetworkGlobals = typeof globalThis & {
  location: { origin: string };
  WebSocket: typeof WebSocket;
  EventSource: typeof EventSource;
};

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
  const globals = globalThis as NetworkGlobals;
  const originalFetch = globals.fetch;
  const originalWebSocket = globals.WebSocket;
  const originalEventSource = globals.EventSource;
  globals.fetch = createConsoleFetchGuard(originalFetch, globals.location.origin);
  globals.WebSocket = denyNetworkConstructor(originalWebSocket, "WebSocket");
  if (typeof originalEventSource === "function") {
    globals.EventSource = denyNetworkConstructor(originalEventSource, "EventSource");
  }
  return () => {
    globals.fetch = originalFetch;
    globals.WebSocket = originalWebSocket;
    if (typeof originalEventSource === "function") globals.EventSource = originalEventSource;
  };
}
