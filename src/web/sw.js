// Service worker: cache the shell so the app opens without a network, and never cache
// anything from `/v1/` (the API must always hit the cloud).
//
// Its business is the shell ONLY: the `/` navigation and the files in SHELL. Everything else on
// this origin — the API, /healthz, the admin page (/admin, /admin.*) — is left to the browser, so
// a deploy of the admin page is never held stale by this cache and an offline "/" never shows
// some other page that happened to be navigated to.
//
// Bump VERSION when a shell file changes; old caches are dropped on activate.

const VERSION = "herdgate-v18";
const SHELL = ["/", "/app.css", "/e2e.js", "/app.js", "/app.webmanifest", "/icons/icon.svg", "/push-decision.js"];

// The push decision table lives in its own plain file so Node tests can load it too
// (importScripts works in a classic worker; the file assigns onto `self`).
importScripts("/push-decision.js");

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

// Push wake: the gate sends either a silent payload-less ping (legacy / keyless
// subscriptions) or an encrypted payload (RFC 8291) saying WHAT changed — settle,
// died, needs-you or plain activity. The decision table is in push-decision.js:
// a visible client suppresses (the in-app UI already surfaces it), a retraction
// closes the slot regardless, otherwise one notification per room (tag coalesce).
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = null;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = null; // not JSON — treat as a legacy silent ping
      }
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const hasVisibleClient = all.some((c) => c.visibilityState === "visible");
      const d = self.hgDecidePush(data, hasVisibleClient);
      if (d.kind === "clear") {
        for (const n of await self.registration.getNotifications({ tag: d.tag })) n.close();
        return;
      }
      if (d.kind === "suppress" || d.kind === "legacy") {
        for (const client of all) client.postMessage({ t: "wake" });
        if (d.kind === "suppress" || all.length > 0) return;
        // legacy with no window at all → the generic notification below
      }
      if (d.kind === "show") {
        await self.registration.showNotification(d.title, {
          body: d.body,
          tag: d.tag,
          renotify: d.renotify,
          data: { room: d.room, agent: d.agent },
        });
        return;
      }
      // Legacy silent ping with no window: generic notification (old behaviour).
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
      const room = event.notification.data && event.notification.data.room;
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // An open window navigates in place (no reload — pairing and drafts survive);
      // with none open, land on the deep link `/#room=<id>` and let the app route it.
      if (all.length > 0) {
        const win = all.find((c) => "focus" in c) ?? all[0];
        await win.focus();
        if (room) win.postMessage({ t: "nav", room });
        return;
      }
      return self.clients.openWindow(room ? "/#room=" + encodeURIComponent(room) : "/");
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch another origin

  const isShellNavigation = request.mode === "navigate" && (url.pathname === "/" || url.pathname === "");
  if (!isShellNavigation && !SHELL.includes(url.pathname)) return; // not the shell: straight to the network

  // The shell navigation: network first (a new deploy should win), cache as the fallback.
  if (isShellNavigation) {
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
