// herdgate admin — the pure half of the admin page (/admin): everything that turns the gate's
// answers into what the owner reads. No DOM here, so Node tests load it like push-decision.js.
//
// Rules mirrored from the gate, not invented here:
//   - a name is trimmed, 1–64 characters, no control/format characters (src/cloud/util.ts cleanName);
//   - the gate only ever withdraws an act grant (src/cloud/gateway.ts /v1/device/scope);
//   - an event's kind is the gate's own classification (src/cloud/events.ts).

export const POLL_MS = 4000;
export const EVENT_VIEW_CAP = 500;

/** Same rule as the gate's `cleanName`; `null` when the gate would answer 400. */
export function validateName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > 64 || /[\p{C}]/u.test(name)) return null;
  return name;
}

// "đ" is a letter of its own, not a combining mark — fold it by hand or "điện" never finds "dien".
const fold = (s) => (typeof s === "string" ? s : "").toLowerCase().replaceAll("đ", "d").normalize("NFD").replace(/\p{M}/gu, "");

/** Case- and diacritic-insensitive substring match over the given fields ("Laptop" finds "laptop khác"). */
export function matches(query, ...fields) {
  const q = fold(query);
  return !q || fields.some((f) => fold(f).includes(q));
}

const byName = (a, b) => fold(a).localeCompare(fold(b));

export function filterDevices(devices, query) {
  return (devices ?? [])
    .filter((d) => matches(query, d.name, d.roomName, d.scope, d.id))
    .sort((a, b) => byName(a.roomName, b.roomName) || byName(a.name, b.name));
}

export function filterRooms(rooms, query) {
  return (rooms ?? [])
    .filter((r) => matches(query, r.name, r.host?.name, r.host?.version, r.id))
    .sort((a, b) => byName(a.name, b.name));
}

const pad = (n) => String(n).padStart(2, "0");

/** Seconds of uptime or age, in Vietnamese units, coarse to what matters. */
export function fmtDuration(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "—";
  if (sec < 0) sec = 0;
  if (sec < 60) return `${Math.floor(sec)} giây`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} ngày ${h % 24} giờ`;
  if (h >= 1) return `${h} giờ ${pad(m % 60)} ph`;
  return `${m} ph ${pad(Math.floor(sec % 60))} giây`;
}

/** Local HH:MM:SS of an ISO time, without a locale (the same text on every browser). */
export function fmtClock(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "web · 3 ph 04 giây trước" — which leg the device was last seen on, and how long ago. */
export function lastSeenText(lastSeen, now = Date.now()) {
  if (!lastSeen || typeof lastSeen.at !== "number") return "chưa thấy";
  const leg = lastSeen.leg === "ssh" ? "SSH" : "web";
  return `${leg} · ${fmtDuration((now - lastSeen.at) / 1000)} trước`;
}

export function legsText(d) {
  return Array.isArray(d?.legs) && d.legs.length ? d.legs.join(" + ") : "—";
}

export const KIND_LABEL = { gate: "gate", pair: "ghép nối", device: "thiết bị", agent: "máy", ssh: "ssh", other: "khác" };

/** The lines the owner's own actions write all end with "by <account name>". */
export function isOwnerAction(line) {
  return typeof line === "string" && / by \S+( |$)/.test(line);
}

/** Append what came after the cursor, drop duplicates, keep the newest `cap`. */
export function mergeEvents(existing, incoming, cap = EVENT_VIEW_CAP) {
  const seen = new Set((existing ?? []).map((e) => e.seq));
  const out = [...(existing ?? [])];
  for (const e of incoming ?? []) {
    if (typeof e?.seq !== "number" || seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function errorText(status, body) {
  const detail = body && typeof body.error === "string" ? body.error : "";
  if (status === 401) return "Token không được gate chấp nhận.";
  if (status === 404) return "Không tìm thấy — có thể vừa bị gỡ hoặc thu hồi.";
  if (status === 422) return detail || "Gate không cho phép thao tác này.";
  if (status === 429) return "Quá nhanh — chờ một chút rồi thử lại.";
  if (status === 400) return detail || "Dữ liệu không hợp lệ.";
  return detail || `Lỗi ${status}`;
}

export function removeRoomText(room) {
  const n = room?.devices?.total ?? 0;
  return `Gỡ máy «${room?.name ?? "?"}»${n ? ` cùng ${n} thiết bị` : ""}?\n\nThiết bị bị thu hồi phải ghép lại; máy đó phải chạy "herdgate pair" lại để nối về gate. Không hoàn tác được.`;
}

export function withdrawText(d) {
  return `Thu quyền act của «${d?.name ?? "?"}» (máy ${d?.roomName ?? "?"})?\n\nThiết bị bị ngắt kết nối hiện tại và nối lại với quyền read. Muốn cấp lại act phải ghép lại và được máy duyệt.`;
}

export function revokeText(d) {
  return `Thu hồi «${d?.name ?? "?"}» (máy ${d?.roomName ?? "?"})?\n\nThiết bị mất quyền truy cập vĩnh viễn, kèm key SSH và push. Không hoàn tác được.`;
}

/** Poll every 4 s while the tab is visible and signed in; never otherwise. */
export function pollIntervalMs({ visible, signedIn }) {
  return visible && signedIn ? POLL_MS : 0;
}

export function countCards(o) {
  const c = o?.counts ?? {};
  return [
    { label: "Máy", value: c.rooms ?? 0, note: `${c.agentsOnline ?? 0} publisher đang nối` },
    { label: "Thiết bị", value: c.devices ?? 0, note: `${c.devicesLive ?? 0} đang nối` },
    { label: "Mã ghép chờ", value: c.pendingCodes ?? 0, note: c.pendingCodes ? "cần duyệt" : "không có" },
  ];
}

export function gateFacts(g) {
  const ssh = g?.ssh?.enabled ? `bật · cổng công khai ${g.ssh.publicPort ?? "?"}` : "tắt";
  return [
    ["Phiên bản", g?.version || "?"],
    ["Đã chạy", fmtDuration(g?.uptimeSec)],
    ["Bắt đầu lúc", fmtDateTime(g?.startedAt)],
    ["SSH-leg", ssh],
    ["Push", g?.push ? "bật" : "tắt"],
    ["Web (PWA)", g?.web ? "bật" : "tắt"],
    ["Từ chối từ lúc khởi động", refusalText(g?.health)],
    ["Đang chặn", `${g?.health?.blockedNow ?? 0} địa chỉ`],
    ["Node", g?.health?.node ?? "?"],
  ];
}

/** The gate's own count of what it refused since it started — by reason, so the owner can tell
 *  a wrong token (theirs to fix) from a flood (the gate's to weather). "—" before 0.15.0. */
export function refusalText(h) {
  const r = h?.refused;
  if (!r) return "—";
  return `${r.total ?? 0} (${r.blocked ?? 0} bị chặn, ${r.hello ?? 0} sai token, ${r.timeout ?? 0} quá hạn, ${r.rate ?? 0} quá nhanh)`;
}

/** One line under a room's name: the publisher first (the axis an operator misreads), then the build. */
export function roomStateText(r) {
  if (!r.connected) return "publisher offline";
  return `publisher online · ${r.host?.version ? `bản ${r.host.version}` : "chưa báo phiên bản"}`;
}

export function scopeLabel(scope) {
  return scope === "act" ? "act" : scope === "read" ? "read" : String(scope ?? "?");
}
