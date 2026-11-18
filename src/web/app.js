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
const DEVICE_SECRET_KEY = "herdgate.deviceSecret";

import { DeviceChannel, generateKeyPair, fingerprint } from "/e2e.js";

// E2E payloads: this device's Noise_XX identity (kept locally, never sent to the cloud
// in the clear) and the host fingerprints it has pinned (TOFU per room).
const E2E_KEY = "herdgate.e2ekey";
const e2eFpKey = (roomId) => `herdgate.e2efp.${roomId}`;

async function e2eSelfKey() {
  try {
    const v = JSON.parse(localStorage.getItem(E2E_KEY) ?? "null");
    if (v?.jwk?.kty === "EC" && typeof v.pub === "string") return { jwk: v.jwk, pub: e2eB64d(v.pub) };
  } catch {
    /* mint below */
  }
  const self = await generateKeyPair();
  localStorage.setItem(E2E_KEY, JSON.stringify({ jwk: self.jwk, pub: e2eB64e(self.pub) }));
  return self;
}
function e2eB64e(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function e2eB64d(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Per-room channel state; reset when the socket drops. The channel only carries
// traffic after the host's `e2e.ready` ack — nothing may race the handshake's
// last step, or the transport counters desync for good.
const e2e = { ch: null, initing: false, ready: false };
function e2eReset() {
  e2e.ch = null;
  e2e.initing = false;
  e2e.ready = false;
}

/** Begin (or restart) the Noise_XX handshake with this room's host. */
async function e2eBegin() {
  if (e2e.ch?.ready() || e2e.initing) return;
  if (!(state.deviceSecret && state.deviceId && state.roomId)) return;
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  e2e.initing = true;
  try {
    const self = await e2eSelfKey();
    const ch = new DeviceChannel(self);
    const init = await ch.begin();
    e2e.ch = ch;
    send({ t: "frame", payload: { op: "e2e.init", e: init.e } });
  } finally {
    e2e.initing = false;
  }
}

// Resume bookkeeping: where this device stopped reading each room's stream, so a
// reconnect can replay what it missed. Keyed per room; cleared when the cloud
// says the stream's generation moved (gateway restart) or the state went stale.
const streamKey = (roomId) => `herdgate.stream.${roomId}`;
function loadStream(roomId) {
  if (!roomId) return null;
  try {
    const v = JSON.parse(localStorage.getItem(streamKey(roomId)) ?? "null");
    return v && typeof v.gen === "string" && typeof v.seq === "number" && v.seq >= 0 ? v : null;
  } catch {
    return null;
  }
}
function saveStream(roomId, gen, seq) {
  if (!roomId || typeof gen !== "string" || typeof seq !== "number" || seq < 0) return;
  localStorage.setItem(streamKey(roomId), JSON.stringify({ gen, seq }));
}
function clearStream(roomId) {
  if (roomId) localStorage.removeItem(streamKey(roomId));
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  cloud: localStorage.getItem(CLOUD_KEY) ?? "",
  deviceId: localStorage.getItem(DEVICE_KEY) ?? "",
  deviceSecret: localStorage.getItem(DEVICE_SECRET_KEY) ?? "",
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

  // E2E status: the pinned host fingerprint, or a loud note when it changed.
  const e2eNote = $("e2e-note");
  const pinned = state.roomId ? localStorage.getItem(e2eFpKey(state.roomId)) : null;
  const current = e2e.ch?.ready() && e2e.ready ? e2e.ch.hostFingerprint : null;
  const shown = current ?? pinned;
  if (pinned && current && current !== pinned) {
    e2eNote.hidden = false;
    e2eNote.className = "error small";
    e2eNote.textContent = `The host key changed (was ${pinned}, now ${current}). Re-pair if you did not do this.`;
  } else if (shown) {
    e2eNote.hidden = false;
    e2eNote.className = "muted small";
    e2eNote.textContent = `end-to-end encrypted · host key ${shown}`;
  } else {
    e2eNote.hidden = true;
  }

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

  // The SSH leg: this device's own key dials the gate. In the Herdr phone app, add a
  // machine with this host/port and the key shown once at pair time.
  if (state.deviceSecret && state.deviceId) {
    const details = document.createElement("details");
    details.className = "ssh";
    const summary = document.createElement("summary");
    summary.textContent = "SSH for the Herdr app";
    const pre = document.createElement("pre");
    const host = location.hostname || "your-gate";
    // The gate's SSH listener is a separate port the cloud operator publishes (default 2222).
    pre.textContent = `ssh -p 2222 ${state.deviceId}@${host}\npassword: the device key shown at pair time`;
    details.append(summary, pre);
    box.append(details);
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
    // A paired device re-attaches with its own key; the account token is the owner path
    // (first sign-in, pairing, management). A device that knows where it stopped reading
    // also asks to resume its room's stream.
    const hello = state.deviceSecret && state.deviceId
      ? { device: state.deviceId, deviceSecret: state.deviceSecret }
      : { accountToken: state.token, ...(state.deviceId ? { device: state.deviceId } : {}) };
    const resume = state.deviceSecret && state.deviceId ? loadStream(state.roomId) : null;
    ws.send(JSON.stringify({
      v: 1,
      t: "hello",
      ...hello,
      name: deviceName(),
      ...(resume ? { resume: { room: state.roomId, gen: resume.gen, seq: resume.seq } } : {}),
    }));
  });

  ws.addEventListener("message", (event) => {
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    void onMessage(m, ws);
  });

  ws.addEventListener("close", (event) => {
    state.ws = null;
    state.hello = null;
    e2eReset();
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

async function onMessage(m, ws) {
  // Track the room stream so the next reconnect resumes from here.
  if (typeof m.seq === "number" && (m.t === "frame" || m.t === "presence")) {
    const rid = m.t === "presence" ? m.roomId : state.roomId;
    const cur = loadStream(rid);
    if (cur && m.seq > cur.seq) saveStream(rid, cur.gen, m.seq);
  }
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
      // Resume outcome: the stream header carries the cloud's position; when the
      // replay had a hole (too long away), askView() below re-fetches the state.
      const rid = m.device?.roomId ?? null;
      if (m.resumed === true && m.stream && typeof m.stream.seq === "number") {
        saveStream(rid, m.stream.gen, m.stream.seq);
      } else if (rid) {
        if (m.stream && typeof m.stream.seq === "number") saveStream(rid, m.stream.gen, m.stream.seq);
        else clearStream(rid);
      }
      setStatus("online", "good");
      render();
      if (state.roomId) {
        void e2eBegin();
        askView();
      }
      return;
    }
    case "frame": {
      const payload = m.payload;
      if (payload && typeof payload === "object" && payload.op === "e2e.reply") {
        await onE2eReply(payload);
        return;
      }
      if (payload && typeof payload === "object" && payload.op === "e2e.ready") {
        e2e.ready = true;
        renderRoom();
        askView(); // now over the encrypted channel
        return;
      }
      if (payload && typeof payload === "object" && payload.op === "e2e") {
        if (!e2e.ch?.ready()) return; // ciphertext for a session we do not have
        let inner;
        try {
          inner = await e2e.ch.recv(payload);
        } catch {
          // Wrong key or tampered frame: start over rather than show nonsense.
          e2eReset();
          void e2eBegin();
          return;
        }
        applyPayload(inner);
        return;
      }
      if (payload && typeof payload === "object" && payload.code === "e2e" && e2e.ch) {
        // The host dropped our session (decrypt failed there): renegotiate.
        e2eReset();
        void e2eBegin();
        return;
      }
      if (payload && typeof payload === "object" && payload.op === "view" && e2e.ch?.ready() && e2e.ready) {
        // Plaintext view while an encrypted session is up: the host lost its side —
        // renegotiate (its publisher restarted).
        e2eReset();
        void e2eBegin();
        applyPayload(payload);
        return;
      }
      applyPayload(payload);
      return;
    }
    case "pair.granted": {
      state.deviceId = m.device?.id ?? state.deviceId;
      if (state.deviceId) localStorage.setItem(DEVICE_KEY, state.deviceId);
      // Shown once and kept only on this device: it is this phone's SSH key on the gate.
      if (typeof m.deviceSecret === "string" && m.deviceSecret) {
        state.deviceSecret = m.deviceSecret;
        localStorage.setItem(DEVICE_SECRET_KEY, m.deviceSecret);
        state.showSecretOnce = true;
      }
      state.roomId = m.device?.roomId ?? state.roomId;
      closePair();
      render();
      void e2eBegin();
      askView();
      void subscribePush();
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

/** Ask the host for its view: the only op this app ever sends (encrypted when up). */
async function askView() {
  if (state.ws?.readyState !== WebSocket.OPEN || !state.roomId) return;
  if (e2e.ch?.ready() && e2e.ready) {
    send({ t: "frame", payload: await e2e.ch.send({ op: "view" }) });
    return;
  }
  void e2eBegin(); // establish in the background; the ack path asks again over it
  send({ t: "frame", payload: { op: "view" } });
}
function applyPayload(payload) {
  // The plaintext (or decrypted) payload from the host lands here.
  if (payload && typeof payload === "object" && payload.op === "view") {
    state.view = payload.view;
    state.viewError = null;
  } else if (payload && typeof payload === "object" && payload.op === "error") {
    // The host refused or could not answer: an op we may not use, or its Herdr is down.
    state.viewError = payload.message ?? payload.code ?? "the host refused";
    state.view = null;
  }
  if (state.roomId) renderRoom();
}

// ---- push wake ---------------------------------------------------------------

/** Subscribe this device to silent wake pushes; ask for permission only once paired. */
async function subscribePush() {
  if (!(state.deviceSecret && state.deviceId)) return; // paired devices only
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await fetch(`${cloudBase()}/v1/push/key`);
      if (!keyRes.ok) return; // push disabled on this cloud
      const { publicKey } = await keyRes.json();
      const raw = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    }
    const endpoint = sub.endpoint;
    if (state.pushEndpoint === endpoint) return;
    state.pushEndpoint = endpoint;
    await fetch(`${cloudBase()}/v1/device/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: state.deviceId, deviceSecret: state.deviceSecret, endpoint }),
    });
  } catch {
    /* permission denied or push unavailable: the gate still works without it */
  }
}

/** The host answered our handshake: finish it, pin its fingerprint (TOFU). */
async function onE2eReply(payload) {
  const ch = e2e.ch;
  if (!ch) return;
  try {
    const finish = await ch.acceptReply(payload);
    send({ t: "frame", payload: { op: "e2e.finish", c: finish.c } });
  } catch {
    e2eReset();
    return;
  }
  const fp = ch.hostFingerprint;
  if (fp && state.roomId) {
    const stored = localStorage.getItem(e2eFpKey(state.roomId));
    if (!stored) localStorage.setItem(e2eFpKey(state.roomId), fp);
    renderRoom();
  }
  // The channel is up: ask for the view over it.
  askView();
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
  state.deviceSecret = "";
  localStorage.removeItem(DEVICE_SECRET_KEY);
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
