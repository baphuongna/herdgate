// herdgate PWA — the device side of the gate.
//
// What it does: signs in with an account token, lists the machines (rooms) that account
// has, pairs this device into one (scope read, or act with the host's approval), and shows
// the read-only view the host publishes.
//
// House rules it respects:
//   - the cloud routes opaque payloads, so the *host* decides what an op means; this client
//     only ever asks for `{op:"view"}` and `{op:"ping"}`, and shows what comes back;
//   - every string from the wire is rendered with `textContent`, never `innerHTML`;
//   - the token lives in localStorage on this device and is never sent anywhere but the
//     cloud's own WS endpoint.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "herdgate.token";
const CLOUD_KEY = "herdgate.cloud";
const DEVICE_KEY = "herdgate.device";

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  cloud: localStorage.getItem(CLOUD_KEY) ?? "",
  deviceId: localStorage.getItem(DEVICE_KEY) ?? "",
  ws: null,
  hello: null,
  roomId: null,
  view: null,
  viewError: null,
  retry: 0,
  closedByUs: false,
};

/** The cloud base: an explicit setting, else this page's origin (same-origin deployment). */
function cloudBase() {
  const raw = (state.cloud || location.origin).replace(/\/$/, "");
  return raw;
}

function wsUrl() {
  return `${cloudBase().replace(/^http/, "ws")}/v1/device/ws`;
}

// ---- tiny DOM helpers (no innerHTML anywhere) ------------------------------

function show(id, on) {
  $(id).hidden = !on;
}
function text(id, value) {
  $(id).textContent = value ?? "";
}
function setStatus(label, kind) {
  const el = $("status");
  el.textContent = label;
  el.dataset.kind = kind ?? "";
}

function showError(id, message) {
  const el = $(id);
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

// ---- screens ---------------------------------------------------------------

function render() {
  const signedIn = Boolean(state.token);
  show("signin", !signedIn);
  show("rooms", signedIn && !state.roomId);
  show("room", signedIn && Boolean(state.roomId));

  if (signedIn && !state.roomId) renderRooms();
  if (state.roomId) renderRoom();
}

function renderRooms() {
  const list = $("room-list");
  list.replaceChildren();
  const agents = state.hello?.agents ?? [];
  show("rooms-empty", agents.length === 0);

  for (const room of agents) {
    const node = $("room-row").content.cloneNode(true);
    node.querySelector(".name").textContent = room.name || room.roomId;
    const meta = [];
    meta.push(room.online ? "online" : "offline");
    if (room.scope) meta.push(`paired · ${room.scope}`);
    node.querySelector(".meta").textContent = meta.join(" · ");
    node.querySelector(".row").dataset.roomId = room.roomId;
    node.querySelector(".rowbtn").addEventListener("click", () => {
      const mine = (state.hello?.agents ?? []).find((r) => r.roomId === room.roomId);
      if (mine?.scope) {
        state.roomId = room.roomId;
        state.view = null;
        state.viewError = null;
        render();
        askView();
      } else {
        openPair(room.roomId);
      }
    });
    list.append(node);
  }
}

function renderRoom() {
  const room = (state.hello?.agents ?? []).find((r) => r.roomId === state.roomId);
  text("room-name", room?.name || state.roomId);
  text("room-state", room ? (room.online ? "host online" : "host offline") : "unknown room");

  const box = $("view");
  box.replaceChildren();

  if (!room?.online) {
    box.append(note("The host is not connected. Start its publisher — in Herdr, press Publish."));
    return;
  }
  if (state.viewError) {
    box.append(note(state.viewError, "error"));
    return;
  }
  if (!state.view) {
    box.append(note("Waiting for the host…"));
    return;
  }

  const v = state.view;
  const summary = v.summary ?? v;
  if (!summary || typeof summary !== "object") {
    box.append(note("The host answered something this app does not understand."));
    return;
  }

  const grid = document.createElement("dl");
  grid.className = "grid";
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    grid.append(dt, dd);
  };
  add("herdr", summary.herdr);
  add("spaces", summary.workspaces);
  add("agents", summary.agents);
  add("working", summary.working);
  add("blocked", summary.blocked);
  box.append(grid);

  if (Array.isArray(summary.labels) && summary.labels.length > 0) {
    const list = document.createElement("ul");
    list.className = "chips";
    for (const label of summary.labels) {
      const li = document.createElement("li");
      li.textContent = String(label);
      list.append(li);
    }
    box.append(list);
  }
  if (v.takenAt) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `as of ${new Date(v.takenAt).toLocaleTimeString()}`;
    box.append(p);
  }
}

function note(message, kind) {
  const p = document.createElement("p");
  p.className = kind === "error" ? "error" : "muted";
  p.textContent = message;
  return p;
}

// ---- the socket ------------------------------------------------------------

function connect() {
  if (!state.token) return;
  state.closedByUs = false;
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    return retryLater();
  }
  state.ws = ws;
  setStatus("connecting", "wait");

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        v: 1,
        t: "hello",
        accountToken: state.token,
        ...(state.deviceId ? { device: state.deviceId } : {}),
        name: deviceName(),
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage(m, ws);
  });

  ws.addEventListener("close", (event) => {
    state.ws = null;
    state.hello = null;
    if (state.closedByUs) return;
    if (event.code === 4001) {
      // The cloud refused the token: do not hammer it, send the person back to sign-in.
      setStatus("signed out", "bad");
      forgetToken();
      return;
    }
    setStatus("offline", "bad");
    retryLater();
  });

  ws.addEventListener("error", () => {
    /* close carries the retry */
  });
}

function onMessage(m, ws) {
  switch (m.t) {
    case "hello": {
      state.retry = 0;
      state.hello = { agents: Array.isArray(m.agents) ? m.agents : [] };
      if (m.device?.id) {
        state.deviceId = m.device.id;
        localStorage.setItem(DEVICE_KEY, m.device.id);
        if (!state.roomId) state.roomId = m.device.roomId;
      }
      // Keep the chosen room only while it is still visible to this account/device.
      if (state.roomId && !state.hello.agents.some((r) => r.roomId === state.roomId)) state.roomId = null;
      setStatus("online", "good");
      render();
      if (state.roomId) askView();
      return;
    }
    case "frame": {
      const payload = m.payload;
      if (payload && typeof payload === "object" && payload.op === "view") {
        state.view = payload.view;
        state.viewError = null;
      } else if (payload && typeof payload === "object" && payload.op === "error") {
        // The host refused or could not answer: an op we may not use, or its Herdr is down.
        state.viewError = payload.message ?? payload.code ?? "the host refused";
        state.view = null;
      }
      if (state.roomId) renderRoom();
      return;
    }
    case "pair.granted": {
      state.deviceId = m.device?.id ?? state.deviceId;
      if (state.deviceId) localStorage.setItem(DEVICE_KEY, state.deviceId);
      state.roomId = m.device?.roomId ?? state.roomId;
      closePair();
      render();
      askView();
      return;
    }
    case "pair.denied": {
      showError("pair-error", m.reason ? `Denied: ${m.reason}` : "Denied");
      return;
    }
    case "presence": {
      const room = (state.hello?.agents ?? []).find((r) => r.roomId === m.roomId);
      if (room) room.online = m.online === true;
      if (state.roomId === m.roomId) {
        renderRoom();
        if (m.online === true) askView();
      } else {
        renderRooms();
      }
      return;
    }
    case "error": {
      // A protocol-level complaint (bad message, not paired, …).
      if (m.code === "not-paired") state.roomId = null;
      render();
      return;
    }
    default:
      return;
  }
}

function retryLater() {
  const wait = Math.min(30_000, 1_000 * 2 ** state.retry) + Math.random() * 500;
  state.retry += 1;
  setTimeout(connect, wait);
}

/** Ask the host for its view: the only op this app ever sends. */
function askView() {
  if (state.ws?.readyState !== WebSocket.OPEN || !state.roomId) return;
  state.ws.send(JSON.stringify({ v: 1, t: "frame", payload: { op: "view" } }));
}

function send(message) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify({ v: 1, ...message }));
  return true;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac browser";
  return "browser";
}

// ---- pairing ---------------------------------------------------------------

function openPair(roomId) {
  state.pairRoom = roomId;
  show("pair", true);
  show("rooms", false);
  showError("pair-error", null);
  const name = $("pair-name");
  if (!name.value) name.value = deviceName();
  name.focus();
}

function closePair() {
  show("pair", false);
  showError("pair-error", null);
}

$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showError("pair-error", null);
  const name = $("pair-name").value.trim() || deviceName();
  const scope = $("pair-scope").value === "act" ? "act" : "read";
  const ok = send({ t: "pair.begin", roomId: state.pairRoom, name, scope });
  if (!ok) return showError("pair-error", "not connected to the cloud");
  // `act` waits for a human on the host; read is immediate.
  $("pair-form").querySelector("button").disabled = true;
  setTimeout(() => {
    const b = $("pair-form").querySelector("button");
    if (b) b.disabled = false;
  }, 3_000);
});

// ---- sign-in, settings -----------------------------------------------------

$("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  if (!token) return showError("signin-error", "a token is required");
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  showError("signin-error", null);
  $("token").value = "";
  render();
  connect();
});

$("menu").addEventListener("click", () => {
  $("cloud").value = state.cloud;
  $("settings").showModal();
});

$("settings-form").addEventListener("submit", () => {
  const value = $("cloud").value.trim().replace(/\/$/, "");
  if (value !== state.cloud) {
    state.cloud = value;
    if (value) localStorage.setItem(CLOUD_KEY, value);
    else localStorage.removeItem(CLOUD_KEY);
    // A different cloud is a different account: reconnect from scratch.
    state.hello = null;
    state.roomId = null;
    if (state.ws) {
      state.closedByUs = true;
      state.ws.close();
    }
    connect();
  }
});

$("signout").addEventListener("click", () => forgetToken());

$("back").addEventListener("click", () => {
  state.roomId = null;
  state.view = null;
  state.viewError = null;
  closePair();
  render();
  if (state.hello) renderRooms();
});

function forgetToken() {
  state.token = "";
  state.deviceId = "";
  state.roomId = null;
  state.hello = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(DEVICE_KEY);
  if (state.ws) {
    state.closedByUs = true;
    state.ws.close();
  }
  $("settings").close();
  render();
}

// ---- boot ------------------------------------------------------------------

render();
if (state.token) connect();

// A phone that wakes up should not show a dead screen.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    if (state.roomId) askView();
  } else {
    state.retry = 0;
    connect();
  }
});

// Installable shell (offline start). Registered late so it never delays first paint.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* an app without offline start is still an app */
    });
  });
}
