/* Pure decision logic for the service worker's push handler, in its own file so it
 * is testable without service-worker globals (sw.js is a classic script and pulls
 * this in with importScripts; Node tests import the file and read globalThis).
 *
 * The gate sends one small encrypted payload per push (RFC 8291; the push provider
 * only ever sees ciphertext):
 *   { v: 1, kind: "settle" | "died" | "needs-you" | "activity", agent?, room }
 * and a retraction when the news resolves before the phone looks:
 *   { type: "clear", tag }
 *
 * Everything DECIDED here — suppress vs show vs clear, the notification slot tag,
 * the Vietnamese copy — is plain data in, plain data out. The SW keeps only glue:
 * parse the event, ask clients for visibility, perform what this returns. */
(function (root) {
  "use strict";

  var KINDS = { settle: true, died: true, "needs-you": true, activity: true };

  function isPayload(m) {
    return !!(m && typeof m === "object" && m.v === 1 && KINDS[m.kind] &&
      typeof m.room === "string" && m.room.length <= 64);
  }

  /** One notification slot per room so a busy fleet coalesces instead of stacking. */
  function tagFor(room) { return "hg:" + room; }

  /** The copy shown for a payload. Kept here (not in the SW) so it is testable. */
  function copyFor(p) {
    var who = typeof p.agent === "string" && p.agent ? p.agent : "Agent";
    switch (p.kind) {
      case "settle": return { title: "Agent đã xong lượt", body: who + " đã settle — chạm để xem kết quả." };
      case "died": return { title: "Agent đã chết", body: who + " không sống sót — chạm để xem." };
      case "needs-you": return { title: "Agent cần bạn", body: who + " đang chờ quyết định của bạn." };
      default: return { title: "Có hoạt động mới", body: "Máy của bạn có thay đổi — chạm để mở." };
    }
  }

  /**
   * Decide what the SW should do with a push event.
   *   data          — event.data ? event.data.json() : null (null = legacy silent ping)
   *   hasVisibleClient — a PWA window is open and visible (in-app UI already shows it)
   * Returns one of:
   *   { kind: "legacy" }                     silent ping: wake windows or notify generically
   *   { kind: "clear", tag }                 retraction: close the slot even if a client is visible
   *   { kind: "suppress" }                   visible client already surfaces the news
   *   { kind: "show", title, body, tag, room, agent, renotify, urgent }
   */
  function decidePush(data, hasVisibleClient) {
    if (data && data.type === "clear" && typeof data.tag === "string" && data.tag.length <= 80) {
      return { kind: "clear", tag: data.tag };
    }
    if (!isPayload(data)) return { kind: "legacy" };
    if (hasVisibleClient) return { kind: "suppress" };
    var copy = copyFor(data);
    return {
      kind: "show",
      title: copy.title,
      body: copy.body,
      tag: data.tag || tagFor(data.room),
      room: data.room,
      agent: typeof data.agent === "string" ? data.agent : undefined,
      renotify: true,
      urgent: data.kind === "needs-you" || data.kind === "died",
    };
  }

  root.hgDecidePush = decidePush;
  root.hgTagFor = tagFor;
  root.hgCopyFor = copyFor;
})(typeof self !== "undefined" ? self : globalThis);
