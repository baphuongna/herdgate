// Service worker: cache the shell so the app opens without a network, and never cache
// anything from `/v1/` (the API must always hit the cloud).
//
// Bump VERSION when a shell file changes; old caches are dropped on activate.

const VERSION = "herdgate-v6";
const SHELL = ["/", "/app.css", "/e2e.js", "/app.js", "/app.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* a missing asset must not block installation */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Push wake: the cloud sends a silent, payload-less ping (VAPID) when the host has
// news and this device is away. If a window is already open its socket reconnects on
// its own — otherwise raise a notification that opens the app.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (all.length > 0) {
        for (const client of all) client.postMessage({ t: "wake" });
        return;
      }
      await self.registration.showNotification("herdgate", {
        body: "Có hoạt động mới trên máy của bạn — chạm để mở.",
        tag: "herdgate-wake",
        renotify: true,
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) if ("focus" in client) return client.focus();
      return self.clients.openWindow("/");
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch another origin
  if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") return; // API: always live

  // Navigations: network first (a new deploy should win), cache as the fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? new Response("offline", { status: 503 }))),
    );
    return;
  }

  // Assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => hit);
      return hit ?? network;
    }),
  );
});
