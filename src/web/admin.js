// herdgate admin — the DOM half of /admin (the pure half is admin-model.js).
//
// House rules it respects (same as the PWA):
//   - every read and write is the gate's own HTTP API, same origin, with the owner's token in
//     the Authorization header — the token never rides in a URL and goes nowhere else;
//   - every string from the wire is set with textContent; nothing is parsed as HTML;
//   - the page polls while it is visible and signed in, and not otherwise.

import * as M from "/admin-model.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "herdgate.token"; // shared with the PWA: an owner signs in once per browser

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  view: "overview",
  overview: null,
  events: [],
  cursor: 0,
  paused: false,
  onlyMine: false,
  keysOpen: new Set(), // device ids whose key panel is expanded
  keys: new Map(), // device id → keys[] once fetched
  error: null,
  inFlight: false,
  updatedAt: 0,
};

/** `el("td", { class: "x", onclick: fn, title: "t" }, child, "text")` — attributes, then children. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const td = (cls, ...children) => el("td", cls ? { class: cls } : {}, ...children);
const th = (text) => el("th", { text, scope: "col" });
const pill = (cls, text) => el("span", { class: `pill ${cls}`, text });
const button = (label, act, id, extra) => el("button", { type: "button", "data-act": act, "data-id": id, ...extra }, label);

class Refused extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: { authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    signOut("Token không được gate chấp nhận.");
    throw new Refused("401");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(M.errorText(res.status, data));
  return data;
}

let toastTimer = null;
function toast(text, bad = false) {
  const node = $("toast");
  node.textContent = text;
  node.classList.toggle("error", bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, bad ? 9000 : 5000);
}

/** Run one owner action, then refresh: the page shows the gate's answer, not an optimistic guess. */
async function act(label, fn) {
  try {
    await fn();
    toast(`${label} — xong`);
    await refresh();
    for (const id of state.keysOpen) if (!state.keys.has(id)) await loadKeys(id);
    if (state.keysOpen.size) renderDevices();
  } catch (e) {
    if (!(e instanceof Refused)) toast(`${label} thất bại: ${e.message}`, true);
  }
}

// ---- polling -------------------------------------------------------------------
let timer = null;
function schedule() {
  clearTimeout(timer);
  const ms = M.pollIntervalMs({ visible: !document.hidden, signedIn: !!state.token });
  if (ms) timer = setTimeout(tick, ms);
}
async function tick() {
  if (document.hidden || !state.token) return schedule();
  await refresh();
  schedule();
}
async function refresh() {
  if (state.inFlight || !state.token) return;
  state.inFlight = true;
  try {
    const events = state.paused ? Promise.resolve(null) : api(`/v1/admin/events?after=${state.cursor}`);
    const [overview, tail] = await Promise.all([api("/v1/admin/overview"), events]);
    state.overview = overview;
    state.error = null;
    state.updatedAt = Date.now();
    if (tail) {
      state.events = M.mergeEvents(state.events, tail.items);
      state.cursor = tail.latest;
    }
  } catch (e) {
    if (!(e instanceof Refused)) state.error = e.message;
  } finally {
    state.inFlight = false;
  }
  render();
}

// ---- views -----------------------------------------------------------------------
const VIEWS = ["overview", "rooms", "devices", "pairing", "events"];
function show(view) {
  state.view = VIEWS.includes(view) ? view : "overview";
  for (const b of document.querySelectorAll("#nav button")) b.classList.toggle("on", b.dataset.view === state.view);
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== state.view;
  render();
}

function render() {
  const pillNode = $("status");
  if (state.error) {
    pillNode.className = "pill bad";
    pillNode.textContent = `lỗi: ${state.error}`;
  } else if (state.overview) {
    pillNode.className = "pill good";
    pillNode.textContent = `đang nối · cập nhật ${M.fmtClock(new Date(state.updatedAt).toISOString())}`;
  } else {
    pillNode.className = "pill";
    pillNode.textContent = "đang tải…";
  }
  $("version").textContent = state.overview ? `v${state.overview.gate.version || "?"} · ${state.overview.counts.rooms} máy · ${state.overview.counts.devices} thiết bị` : "";
  renderOverview();
  renderRooms();
  renderDevices();
  renderPairing();
  renderEvents();
}

const empty = (text) => el("p", { class: "muted", text });

function table(head, rows) {
  if (!rows.length) return empty("Không có gì để hiển thị.");
  return el("table", {}, el("thead", {}, el("tr", {}, ...head.map(th))), el("tbody", {}, ...rows));
}

function pendingList(target, withActions) {
  const pending = state.overview?.pairing?.pending ?? [];
  const rows = pending.map((p) => {
    const asked = `máy «${p.hostName}» · xin từ ${M.fmtDuration(p.ageSec)} trước · còn ${M.fmtDuration(p.expiresIn)}`;
    const buttons = withActions ? [button("Duyệt", "approve", p.code, { "data-code": p.code }), " ", button("Bỏ qua", "deny", p.code, { class: "link" })] : [];
    return el("div", { class: "row" }, el("span", { class: "mono name", text: p.code }), el("span", { class: "grow", text: asked }), ...buttons);
  });
  target.replaceChildren(rows.length ? el("div", { class: "list" }, ...rows) : empty("Không có máy nào đang chờ duyệt."));
}

function renderOverview() {
  const o = state.overview;
  if (!o) return;
  $("cards").replaceChildren(...M.countCards(o).map((c) => el("div", { class: "card stat" }, el("div", { class: "value", text: String(c.value) }), el("div", { class: "label", text: c.label }), el("div", { class: "small dim", text: c.note }))));
  $("gate-facts").replaceChildren(...M.gateFacts(o.gate).flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
  pendingList($("pending"), true);
  $("overview-rooms").replaceChildren(
    table(
      ["Máy", "Host", "Publisher", "Thiết bị"],
      M.filterRooms(o.rooms, "").map((r) =>
        el("tr", {},
          td("", el("span", { class: "name", text: r.name }), el("span", { class: "sub mono", text: r.id })),
          td("", r.host?.name ?? "—", r.host?.version ? el("span", { class: "sub", text: `bản ${r.host.version}` }) : []),
          td("", r.connected ? pill("good", "online") : pill("bad", "offline")),
          td("actions", `${r.devices.live}/${r.devices.total}`, " ", button("Thiết bị", "jump-devices", r.id, { class: "link", "data-name": r.name })),
        ),
      ),
    ),
  );
}

function renderRooms() {
  const o = state.overview;
  if (!o) return;
  const q = $("room-query").value;
  $("rooms").replaceChildren(
    table(
      ["Máy", "Host", "Trạng thái", "Thiết bị", ""],
      M.filterRooms(o.rooms, q).map((r) =>
        el("tr", {},
          td("", el("span", { class: "name", text: r.name }), el("span", { class: "sub mono", text: r.id })),
          td("", r.host?.name ?? "—", el("span", { class: "sub", text: `ghép ${M.fmtDateTime(r.created)}` })),
          td("", r.connected ? pill("good", "publisher online") : pill("bad", "publisher offline"), el("span", { class: "sub", text: M.roomStateText(r) })),
          td("", `${r.devices.live} sống / ${r.devices.total}`),
          td("actions", button("Đổi tên", "room-rename", r.id), " ", button("Gỡ", "room-remove", r.id, { class: "link danger" })),
        ),
      ),
    ),
  );
}

function keysPanel(d) {
  const keys = state.keys.get(d.id);
  const items = keys === undefined ? [el("li", { class: "muted", text: "đang tải key…" })] : keys.length ? keys.map((k) =>
    el("li", {}, el("span", { class: "mono", text: k.fp }), k.comment ? el("span", { class: "muted small", text: k.comment }) : [], el("span", { class: "small dim", text: `${k.algo} · ${M.fmtDateTime(k.at)}` }), " ", button("Xoá", "key-del", d.id, { class: "link danger", "data-b64": k.b64 })),
  ) : [el("li", { class: "muted", text: "chưa có key SSH — Herdgate thêm khi «hc machine add»" })];
  return el("tr", {}, el("td", { colspan: "7" },
    el("ul", { class: "keys" }, ...items),
    el("form", { "data-device": d.id },
      el("input", { type: "text", name: "pubkey", placeholder: "ssh-ed25519 AAAA… comment", required: true, "aria-label": "Public key" }),
      el("button", { type: "submit" }, "Thêm key"),
    ),
  ));
}

function renderDevices() {
  const o = state.overview;
  if (!o) return;
  const q = $("device-query").value;
  const rows = [];
  for (const d of M.filterDevices(o.devices, q)) {
    rows.push(
      el("tr", {},
        td("", el("span", { class: "name", text: d.name }), el("span", { class: "sub mono", text: d.id })),
        td("", d.roomName),
        td("", pill(M.scopeLabel(d.scope), d.scope)),
        td("", d.connected ? pill("good", M.legsText(d)) : pill("", "offline")),
        td("", M.lastSeenText(d.lastSeen, state.updatedAt)),
        td("actions",
          button("Đổi tên", "device-rename", d.id),
          d.scope === "act" ? [" ", button("Thu quyền", "device-withdraw", d.id, { class: "warn", title: "act → read" })] : [],
          " ", button(d.keys ? `Key (${d.keys})` : "Key", "keys-toggle", d.id, { class: "link" }),
          d.push ? [" ", button("Tắt push", "push-off", d.id, { class: "link" })] : [],
          " ", button("Thu hồi", "device-revoke", d.id, { class: "link danger" }),
        ),
      ),
    );
    if (state.keysOpen.has(d.id)) rows.push(keysPanel(d));
  }
  $("devices").replaceChildren(table(["Thiết bị", "Máy", "Scope", "Đang nối", "Thấy lần cuối", ""], rows));
}

function renderPairing() {
  if (!state.overview) return;
  pendingList($("pairing-pending"), true);
}

function renderEvents() {
  const list = $("events");
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const rows = (state.onlyMine ? state.events.filter((e) => M.isOwnerAction(e.line)) : state.events).slice();
  list.replaceChildren(...rows.map((e) =>
    el("li", { class: M.isOwnerAction(e.line) ? "mine" : "" },
      el("span", { class: "t", text: M.fmtClock(e.at) }),
      el("span", { class: "k", text: M.KIND_LABEL[e.kind] ?? e.kind }),
      el("span", { text: e.line }),
    ),
  ));
  if (!rows.length) list.append(el("li", {}, el("span", { class: "t", text: "—" }), el("span", { class: "k", text: "" }), el("span", { class: "muted", text: state.paused ? "đang tạm dừng" : "chưa có sự kiện nào" })));
  if (stick) list.scrollTop = list.scrollHeight;
}

// ---- actions (event delegation: every button says what it wants in data-act) -------------
const askName = (current) => {
  const raw = window.prompt("Tên mới (1–64 ký tự, không ký tự điều khiển):", current);
  if (raw === null) return null;
  const name = M.validateName(raw);
  if (!name) toast("Tên không hợp lệ: để trống, quá 64 ký tự hoặc có ký tự điều khiển.", true);
  return name;
};

async function onAction(ev) {
  const btn = ev.submitter?.dataset?.act ? ev.submitter : ev.target.closest("button[data-act]");
  if (!btn?.dataset?.act) return;
  const { act: what, id } = btn.dataset;
  const o = state.overview;
  const room = o?.rooms?.find((r) => r.id === id);
  const device = o?.devices?.find((d) => d.id === id);
  switch (what) {
    case "approve": {
      const code = btn.dataset.code || $("approve-code").value.trim().toUpperCase();
      if (!code) return;
      await act(`Duyệt máy «${o?.pairing?.pending?.find((p) => p.code === code)?.hostName ?? code}»`, async () => {
        const r = await api("/v1/agent/approve", { method: "POST", body: { code } });
        $("approve-code").value = "";
        const note = $("approve-note");
        note.textContent = `Đã tạo máy «${r.name}» (${r.roomId}). Máy kia nhận token ở lần poll kế tiếp.`;
        note.hidden = false;
        show("rooms");
      });
      return;
    }
    case "deny":
      return act("Bỏ qua mã ghép", () => api("/v1/agent/deny", { method: "POST", body: { code: btn.dataset.code } }));
    case "room-rename": {
      const name = askName(room?.name ?? "");
      if (name === null) return;
      return act("Đổi tên máy", () => api("/v1/room/rename", { method: "POST", body: { room: id, name } }));
    }
    case "room-remove":
      if (!room || !window.confirm(M.removeRoomText(room))) return;
      return act("Gỡ máy", () => api("/v1/room/remove", { method: "POST", body: { room: id } }));
    case "jump-devices":
      $("device-query").value = btn.dataset.name ?? "";
      return show("devices");
    case "device-rename": {
      const name = askName(device?.name ?? "");
      if (name === null) return;
      return act("Đổi tên thiết bị", () => api("/v1/device/rename", { method: "POST", body: { device: id, name } }));
    }
    case "device-withdraw":
      if (!device || !window.confirm(M.withdrawText(device))) return;
      return act("Thu quyền act", () => api("/v1/device/scope", { method: "POST", body: { device: id, scope: "read" } }));
    case "device-revoke":
      if (!device || !window.confirm(M.revokeText(device))) return;
      return act("Thu hồi thiết bị", () => api("/v1/device/revoke", { method: "POST", body: { device: id } }));
    case "push-off":
      return act("Tắt push", () => api("/v1/device/push", { method: "DELETE", body: { device: id } }));
    case "keys-toggle":
      if (state.keysOpen.has(id)) state.keysOpen.delete(id);
      else {
        state.keysOpen.add(id);
        if (!state.keys.has(id)) await loadKeys(id);
      }
      return renderDevices();
    case "key-del": {
      const b64 = btn.dataset.b64;
      if (!b64 || !window.confirm("Xoá key SSH này khỏi thiết bị?\n\nMáy dùng key đó sẽ không đăng nhập được nữa.")) return;
      return act("Xoá key SSH", async () => {
        await api("/v1/device/sshkey", { method: "DELETE", body: { device: id, b64 } });
        state.keys.delete(id);
        await loadKeys(id);
      });
    }
    default:
  }
}

async function onKeyAdd(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const device = form.dataset.device;
  const input = form.querySelector("input[name=pubkey]");
  const pubkey = input.value.trim();
  if (!pubkey) return;
  const label = "Thêm key SSH";
  try {
    const r = await api("/v1/device/sshkey", { method: "POST", body: { device, pubkey } });
    toast(`${label} — ${r.fp}`);
    input.value = "";
    await refresh();
  } catch (e) {
    if (!(e instanceof Refused)) toast(`${label} thất bại: ${e.message}`, true);
  }
}

/** Keys of one device, as the gate lists them (fingerprints; never key material beyond the public blob). */
async function loadKeys(id) {
  try {
    const r = await api(`/v1/device/sshkey?device=${encodeURIComponent(id)}`);
    state.keys.set(id, r.keys ?? []);
  } catch (e) {
    if (!(e instanceof Refused)) toast(`Không tải được key: ${e.message}`, true);
  }
}

// ---- sign in / out -----------------------------------------------------------------
function signIn(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  $("signin").hidden = true;
  $("app").hidden = false;
  refresh();
  schedule();
}
function signOut(reason) {
  localStorage.removeItem(TOKEN_KEY);
  state.token = "";
  state.overview = null;
  state.events = [];
  state.cursor = 0;
  clearTimeout(timer);
  $("app").hidden = true;
  $("signin").hidden = false;
  const err = $("signin-error");
  err.textContent = reason ?? "";
  err.hidden = !reason;
  $("token").value = "";
}

// ---- boot -----------------------------------------------------------------------------
function boot() {
  $("signin-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = $("token").value.trim();
    if (!token) return;
    signIn(token);
  });
  $("signout").addEventListener("click", () => signOut(""));
  $("refresh").addEventListener("click", () => refresh());
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  $("room-query").addEventListener("input", renderRooms);
  $("device-query").addEventListener("input", renderDevices);
  $("approve-form").addEventListener("submit", (ev) => { ev.preventDefault(); onAction(ev); });
  for (const id of ["rooms", "devices", "pending", "pairing-pending", "overview-rooms"]) $(id).addEventListener("click", onAction);
  $("devices").addEventListener("submit", onKeyAdd);
  $("events-pause").addEventListener("click", (ev) => {
    state.paused = !state.paused;
    ev.currentTarget.textContent = state.paused ? "Tiếp tục" : "Tạm dừng";
    renderEvents();
  });
  $("events-clear").addEventListener("click", () => { state.events = []; renderEvents(); });
  $("events-only-owner").addEventListener("change", (ev) => { state.onlyMine = ev.currentTarget.checked; renderEvents(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else tick();
  });
  if (state.token) signIn(state.token);
  else $("signin").hidden = false;
}
boot();
