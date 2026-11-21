// herdgate PWA — the device side of the gate.
//
// What it does: signs in with an account token, lists the machines (rooms) that account
// has, manages a separate pairing per machine, and shows
// the read-only view the host publishes.
//
// House rules it respects:
//   - the cloud routes opaque payloads, so the *host* decides what an op means; this client
//     only ever asks for `{op:"view"}` and `{op:"ping"}`, and shows what comes back;
//   - every string from the wire is rendered with `textContent`, never `innerHTML`;
//   - the token lives in localStorage on this device and is never sent anywhere but the
//     cloud's own WS endpoint.

const BUILD = "v0.9.33-web.1";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "herdgate.token";
const CLOUD_KEY = "herdgate.cloud";
const DEVICE_KEY = "herdgate.device";
const DEVICE_SECRET_KEY = "herdgate.deviceSecret";
const PAIRS_KEY = "herdgate.roomPairs";

function roomPairs() {
  try { return new Map(JSON.parse(localStorage.getItem(PAIRS_KEY) ?? "[]")); }
  catch { return new Map(); }
}

function savePair(roomId, pair) {
  const pairs = roomPairs();
  if (pair) pairs.set(roomId, pair);
  else pairs.delete(roomId);
  localStorage.setItem(PAIRS_KEY, JSON.stringify([...pairs]));
}

function clearLegacyPair() {
  localStorage.removeItem(DEVICE_KEY);
  localStorage.removeItem(DEVICE_SECRET_KEY);
}

import { DeviceChannel, generateKeyPair } from "/e2e.js";

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
const e2e = { ch: null, initing: false, ready: false, verified: false, epoch: 0, keyChanged: false, beganAt: 0 };
const pinnedHost = () => state.deviceRoom && localStorage.getItem(e2eFpKey(state.deviceRoom));
function e2eReset() {
  e2e.epoch++;
  e2e.ch = null;
  e2e.initing = false;
  e2e.ready = false;
  e2e.verified = false;
  e2e.keyChanged = false;
  e2e.beganAt = 0;
}

/** Begin (or restart) the Noise_XX handshake with this room's host. */
async function e2eBegin() {
  if (e2e.ready || e2e.initing || e2e.keyChanged || Date.now() - e2e.beganAt < 5000) return;
  if (!(state.deviceSecret && state.deviceId && state.roomId)) return;
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const epoch = e2e.epoch;
  e2e.initing = true;
  e2e.beganAt = Date.now();
  try {
    const self = await e2eSelfKey();
    const ch = new DeviceChannel(self);
    const init = await ch.begin();
    if (epoch !== e2e.epoch) return;
    e2e.ch = ch;
    send({ t: "frame", payload: { op: "e2e.init", e: init.e } });
  } catch {
    // A pinned room stays closed to plaintext even if WebCrypto is unavailable.
  } finally {
    if (epoch === e2e.epoch) e2e.initing = false;
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
  deviceRoom: null,
  pairRoom: null,
  pairSocket: null,
  ws: null,
  hello: null,
  roomId: null,
  view: null,
  viewError: null,
  roomUi: null,
  terms: null,
  termTarget: null,
  termAnsi: null,
  termTimer: null,
  termBody: null,
  termPre: null,
  retry: 0,
  worker: { health: null, jobs: new Map(), error: null },
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
  show("rooms", signedIn && !state.roomId && !state.pairRoom);
  show("room", signedIn && Boolean(state.roomId) && !state.pairRoom);

  if (signedIn && !state.roomId) renderRooms();
  if (state.roomId) renderRoom();
}

function renderRooms() {
  const list = $("room-list");
  list.replaceChildren();
  const agents = state.hello?.agents ?? [];
  const pairs = roomPairs();
  show("rooms-empty", agents.length === 0);

  for (const room of agents) {
    const node = $("room-row").content.cloneNode(true);
    node.querySelector(".name").textContent = room.name || room.roomId;
    const meta = [];
    meta.push(room.online ? "online" : "offline");
    const scope = pairs.get(room.roomId)?.scope;
    if (scope) meta.push(`paired · ${scope}`);
    node.querySelector(".meta").textContent = meta.join(" · ");
    node.querySelector(".row").dataset.roomId = room.roomId;
    node.querySelector(".rowbtn").addEventListener("click", () => {
      const pairing = roomPairs().get(room.roomId);
      if (pairing) selectRoom(room.roomId, pairing);
      else openPair(room.roomId);
    });
    list.append(node);
  }
}

function renderRoom() {
  if (!state.roomId) return;
  const room = (state.hello?.agents ?? []).find((r) => r.roomId === state.roomId);
  text("room-name", room?.name || state.roomId);
  text("room-state", room ? (room.online ? "host online" : "host offline") : "unknown room");

  // E2E status: the pinned host fingerprint, or a loud note when it changed.
  const e2eNote = $("e2e-note");
  const pinned = state.roomId ? localStorage.getItem(e2eFpKey(state.roomId)) : null;
  const current = e2e.verified ? e2e.ch.hostFingerprint : null;
  if (e2e.keyChanged) {
    e2eNote.hidden = false;
    e2eNote.className = "error small";
    e2eNote.textContent = "Host key changed. Pane data is blocked. Verify the key with the host administrator.";
  } else if (current || pinned) {
    e2eNote.hidden = false;
    e2eNote.className = "muted small";
    e2eNote.textContent = current ? `end-to-end encrypted · host key ${current}` : "Waiting for an encrypted connection to the pinned host…";
  } else {
    e2eNote.hidden = true;
  }

  if (!state.roomUi) {
    const summary = document.createElement("div");
    const live = document.createElement("div");
    const worker = document.createElement("div");
    const controls = document.createElement("div");
    $("view").replaceChildren(summary, live, worker, controls);
    const updateSshHint = renderRoomControls(controls);
    const updateWorker = renderWorkerBox(worker);
    state.roomUi = { summary, live, worker, controls, updateSshHint, updateWorker };
  }
  const ui = state.roomUi;
  const online = Boolean(room?.online);
  if (ui.online !== online || ui.view !== state.view || ui.error !== state.viewError) {
    ui.online = online;
    ui.view = state.view;
    ui.error = state.viewError;
    ui.summary.replaceChildren();
    renderHostView(ui.summary, room);
  }
  const { live, updateSshHint, updateWorker } = ui;
  renderLiveTerminals(live, online);
  updateWorker?.(online);
  updateSshHint?.();
}

function renderHostView(box, room) {
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

function renderLiveTerminals(box, online) {
  box.hidden = !online;
  if (online && !state.termBody) {
    const tblock = document.createElement("details");
    tblock.className = "terms";
    const ts = document.createElement("summary");
    ts.textContent = "Live terminals — this machine's panes, read-only";
    tblock.append(ts);
    const tbody = document.createElement("div");
    tbody.className = "termbody";
    tblock.append(tbody);
    tblock.addEventListener("toggle", () => {
      if (tblock.open && !state.terms) sendPayload({ op: "term.list" });
    });
    box.append(tblock);
    state.termBody = tbody;
    renderTerms();
  }
}

// ---- Pi worker panel (experimental) -----------------------------------------
// Submit/health/status against the host's opt-in worker queue (HERDGATE_PI_WORKER=1)
// plus per-request receipt watches: the settle report pushes back, no polling loop.

const WORKER_ERROR_CODES = new Set([
  "pi_worker_disabled", "requires-act", "bad-prompt", "bad-workspace", "queue-full", "worker-queue",
  "receipt.watch", "pi_receipts_disabled", "pi_receipt_body_disabled",
]);

function renderWorkerBox(box) {
  const details = document.createElement("details");
  details.className = "worker";
  const summary = document.createElement("summary");
  summary.textContent = "Pi worker (experimental)";
  const health = document.createElement("p");
  health.className = "muted small";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "link";
  refresh.textContent = "refresh";
  const form = document.createElement("form");
  form.autocomplete = "off";
  const promptLabel = document.createElement("label");
  promptLabel.textContent = "Prompt for a fresh worker run (one job, one session)";
  const prompt = document.createElement("textarea");
  prompt.rows = 3;
  prompt.maxLength = 16384;
  prompt.required = true;
  prompt.placeholder = "e.g. summarize today's commits in 5 bullets";
  const wsLabel = document.createElement("label");
  wsLabel.textContent = "Workspace (optional name from the host allowlist)";
  const workspace = document.createElement("input");
  workspace.type = "text";
  workspace.maxLength = 64;
  workspace.placeholder = "default";
  workspace.pattern = "[a-z0-9][a-z0-9-]{0,63}";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Submit job";
  const formError = document.createElement("p");
  formError.className = "error small";
  formError.hidden = true;
  form.append(promptLabel, prompt, wsLabel, workspace, submit, formError);
  const jobs = document.createElement("ul");
  jobs.className = "list";
  details.append(summary, health, refresh, form, formError, jobs);
  box.append(details);

  const askHealth = () => sendPayload({ op: "worker.health" });
  refresh.addEventListener("click", askHealth);
  details.addEventListener("toggle", () => { if (details.open) askHealth(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    formError.hidden = true;
    const text = prompt.value.trim();
    if (!text) return;
    sendPayload({ op: "worker.submit", prompt: text, ...(workspace.value.trim() ? { workspace: workspace.value.trim() } : {}) });
    prompt.value = "";
  });

  const ui = { details, health, jobs, formError, asked: false };
  const update = (online) => {
    const w = state.worker;
    form.hidden = !online;
    if (online && details.open && !ui.asked) { ui.asked = true; askHealth(); }
    const h = w.health;
    if (!online) {
      health.textContent = "host offline";
    } else if (!h) {
      health.textContent = h === null ? "asking the host…" : "";
    } else if (!h.enabled) {
      health.textContent = "worker queue disabled on this host (HERDGATE_PI_WORKER)";
    } else {
      const beat = h.heartbeat ? ` · heartbeat ${h.heartbeat.source} ${h.heartbeat.ageSeconds}s ago` : " · no heartbeat";
      health.textContent = `queue ${h.queued ?? "?"} waiting, ${h.running ?? "?"} running${beat}`;
    }
    formError.hidden = !w.error;
    formError.textContent = w.error ?? "";
    jobs.replaceChildren();
    for (const job of [...w.jobs.values()].slice(-12).reverse()) {
      const row = document.createElement("li");
      row.className = "row";
      const head = document.createElement("span");
      head.textContent = `${job.id.slice(0, 8)} · ${job.status}${job.reason ? ` (${job.reason})` : ""}${job.duplicate ? " · duplicate" : ""}`;
      row.append(head);
      if (job.status === "replied" && job.hasBody) {
        const view = document.createElement("button");
        view.type = "button";
        view.className = "link";
        view.textContent = job.body === undefined ? "view report" : "hide report";
        view.addEventListener("click", () => {
          if (job.body === undefined) sendPayload({ op: "receipt.body", id: job.id });
          else job.body = undefined;
          update(online);
        });
        row.append(" ", view);
        if (typeof job.body === "string") {
          const pre = document.createElement("pre");
          pre.textContent = job.body;
          row.append(pre);
        } else if (job.body && typeof job.body === "object") {
          const why = document.createElement("span");
          why.className = "muted small";
          why.textContent = `report not available (${job.body.reason ?? "unavailable"})`;
          row.append(why);
        }
      }
      jobs.append(row);
    }
  };
  return update;
}

function workerJobTouched(id, fields) {
  const job = state.worker.jobs.get(id);
  if (!job) return;
  Object.assign(job, fields);
  state.roomUi?.updateWorker?.(Boolean(state.hello?.agents?.find((r) => r.roomId === state.roomId)?.online));
}

function renderRoomControls(box) {
  let updateSshHint;
  // The SSH leg: this device's own key dials the gate. In the Herdr phone app, add a
  // machine with this host/port and the key shown once at pair time.
  if (state.deviceSecret && state.deviceId) {
    const details = document.createElement("details");
    details.className = "ssh";
    // Open after pairing; live frames never replace the user's controls.
    details.open = state.showSecretOnce === true;
    const summary = document.createElement("summary");
    summary.textContent = "SSH for the Herdr app";
    const pre = document.createElement("pre");
    const host = location.hostname || "your-gate";
    // The port comes from the cloud's hello (its SSH leg); the host is whatever the
    // person typed to reach this page. The cloud advertises the SSH hostname it
    // wants phones to use (bridge / AAAA name); only without one do we fall back
    // to this page's host.
    const { deviceId, deviceSecret, roomId, token } = state;
    const base = cloudBase();
    let selected = deviceId;
    const allowed = new Set([deviceId]);
    const chooser = document.createElement("label");
    chooser.textContent = "SSH username ";
    const picker = document.createElement("select");
    picker.className = "ssh-user-select";
    const option = (id, label) => {
      const item = document.createElement("option");
      item.value = id;
      item.textContent = label;
      return item;
    };
    picker.append(option(deviceId, `${deviceId} (this browser)`));
    picker.value = deviceId;
    picker.disabled = true;
    chooser.append(picker);
    details.append(summary, chooser, pre);

    // The device secret is the SSH password. Reveal only on request and only
    // for the device that owns this panel.
    const keyRow = document.createElement("div");
    keyRow.className = "keyrow";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "link";
    reveal.textContent = "Show this device's key";
    reveal.addEventListener("click", () => {
      const keyEl = document.createElement("pre");
      keyEl.textContent = deviceSecret;
      keyEl.setAttribute("aria-label", "device key");
      keyRow.replaceChildren(keyEl);
    });
    keyRow.append(reveal);
    details.append(keyRow);

    // Registered SSH PUBLIC keys: the machine that runs `hc machine add` can then log
    // in with its key (system ssh prefers keys/agent) — no password prompt, which the
    // app's non-interactive add screen requires.
    const keysBlock = document.createElement("div");
    keysBlock.className = "sshkeys";
    const keysTitle = document.createElement("p");
    keysTitle.className = "muted small";
    keysTitle.textContent = "Public keys — paste the output of `cat ~/.ssh/id_ed25519.pub` from the machine that will add this one:";
    keysBlock.append(keysTitle);
    const keyList = document.createElement("div");
    keysBlock.append(keyList);
    const addRow = document.createElement("div");
    addRow.className = "keyrow";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "ssh-ed25519 AAAA… your@machine";
    addInput.setAttribute("autocomplete", "off");
    addInput.setAttribute("spellcheck", "false");
    addInput.className = "pubkey-input";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add key";
    addBtn.className = "primary";
    addRow.append(addInput, addBtn);
    keysBlock.append(addRow);
    const cfgHint = document.createElement("p");
    cfgHint.className = "muted small";
    updateSshHint = () => {
      const port = state.sshPort ?? 2222;
      const sshHost = state.sshHost || host;
      const command = `ssh -p ${port} ${selected}@${sshHost}`;
      if (pre.textContent === command) return;
      pre.textContent = command;
      cfgHint.textContent = `Herdr Mobile: SSH username ${selected}, port ${port}. Register the public key shown by the phone for this username.`;
    };
    keysBlock.append(cfgHint);
    details.append(keysBlock);

    const status = document.createElement("p");
    status.className = "muted small";
    status.setAttribute("role", "status");
    keysBlock.append(status);
    const keyAuth = (id) => id === deviceId ? { "x-herdgate-secret": deviceSecret } : { authorization: `Bearer ${token}` };
    let keyRequest = 0;

    const renderKeys = (keys, owner) => {
      keyList.replaceChildren();
      for (const k of keys) {
        const row = document.createElement("div");
        row.className = "keyrow";
        const pre = document.createElement("pre");
        pre.textContent = `${k.fp} ${k.comment}`.trim();
        row.append(pre);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "link";
        rm.textContent = "remove";
        rm.addEventListener("click", async () => {
          if (selected !== owner) return;
          try {
            const response = await fetch(`${base}/v1/device/sshkey`, {
              method: "DELETE",
              headers: { "content-type": "application/json", ...keyAuth(owner) },
              body: JSON.stringify({ device: owner, b64: k.b64 }),
            });
            if (selected === owner) {
              if (response.ok) void loadKeys();
              else status.textContent = `Could not remove key (HTTP ${response.status}).`;
            }
          } catch {
            if (selected === owner) status.textContent = "Could not reach the gate.";
          }
        });
        row.append(rm);
        keyList.append(row);
      }
      if (!keys.length) {
        const none = document.createElement("p");
        none.className = "muted small";
        none.textContent = "No public key registered for this username.";
        keyList.append(none);
      }
    };
    const loadKeys = async () => {
      const target = selected;
      const request = ++keyRequest;
      try {
        const r = await fetch(`${base}/v1/device/sshkey?device=${encodeURIComponent(target)}`, { headers: keyAuth(target) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { keys = [] } = await r.json();
        if (request === keyRequest) renderKeys(keys, target);
      } catch {
        if (request === keyRequest) status.textContent = "Could not load public keys.";
      }
    };
    const selectUsername = (id) => {
      if (!allowed.has(id) || id === selected) return;
      selected = id;
      keyRow.hidden = id !== deviceId;
      // Require a fresh paste when switching recipients to avoid granting access to the wrong device.
      addInput.value = "";
      status.textContent = "";
      keyList.replaceChildren();
      updateSshHint();
      void loadKeys();
    };
    picker.addEventListener("change", () => selectUsername(picker.value));
    let pickerRequest = 0;
    const loadUsernames = async () => {
      if (!token || !roomId) return;
      const request = ++pickerRequest;
      try {
        const r = await fetch(`${base}/v1/devices?room=${encodeURIComponent(roomId)}`, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const { devices = [] } = await r.json();
        if (request !== pickerRequest) return;
        allowed.clear();
        allowed.add(deviceId);
        const options = [option(deviceId, `${deviceId} (this browser)`)];
        for (const d of devices) {
          if (allowed.has(d.id)) continue;
          allowed.add(d.id);
          options.push(option(d.id, `${d.name} · ${d.scope} · ${d.id}`));
        }
        if (!allowed.has(selected)) selectUsername(deviceId);
        picker.replaceChildren(...options);
        picker.value = selected;
        picker.disabled = options.length === 1;
      } catch { /* existing pairing still works */ }
    };
    details.addEventListener("toggle", () => { if (details.open) void loadUsernames(); });
    addBtn.addEventListener("click", async () => {
      const pubkey = addInput.value.trim();
      const target = selected;
      if (!pubkey || !allowed.has(target)) return;
      status.textContent = "";
      try {
        const r = await fetch(`${base}/v1/device/sshkey`, {
          method: "POST",
          headers: { "content-type": "application/json", ...keyAuth(target) },
          body: JSON.stringify({ device: target, pubkey }),
        });
        const result = await r.json().catch(() => ({}));
        if (selected !== target) return;
        if (!r.ok) {
          status.textContent = result.error ?? `Could not add key (HTTP ${r.status}).`;
          return;
        }
        if (addInput.value.trim() === pubkey) addInput.value = "";
        status.textContent = `Key saved for ${target}.`;
        void loadKeys();
      } catch {
        if (selected === target) status.textContent = "Could not reach the gate.";
      }
    });
    void loadKeys();
    void loadUsernames();
    details.append(keysBlock);
    box.append(details);
  }

  // The owner's roster for this machine: every paired device, its scope, live dot,
  // public-key count — and the two things the owner always needs: pairing one more
  // device (e.g. an `act` one) and un-pairing (revoke). Works with the account
  // token, so it is here even when this browser itself is only a read device.
  if (state.token && state.roomId) {
    const block = document.createElement("details");
    block.className = "devices";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "Devices — paired phones, browsers and machines";
    block.append(summaryEl);
    const roster = document.createElement("div");
    block.append(roster);
    const pairMore = document.createElement("button");
    pairMore.type = "button";
    pairMore.className = "primary";
    pairMore.textContent = "Pair another device (pick act for full control)";
    pairMore.addEventListener("click", () => openPair(state.roomId));
    block.append(pairMore);
    box.append(block);

    const loadDevices = async () => {
      try {
        const r = await fetch(`${cloudBase()}/v1/devices?room=${encodeURIComponent(state.roomId)}`, {
          headers: { authorization: `Bearer ${state.token}` },
        });
        if (!r.ok) return;
        const { devices = [] } = await r.json();
        roster.replaceChildren();
        for (const d of devices) {
          const row = document.createElement("div");
          row.className = "keyrow";
          const pre = document.createElement("pre");
          pre.textContent = `${d.name}  ·  ${d.scope}${d.connected ? "  ·  live" : ""}  ·  ${d.keys} key(s)  ·  ${d.id}${d.id === state.deviceId ? "  (this browser)" : ""}`;
          row.append(pre);
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "link danger";
          rm.textContent = "revoke";
          rm.addEventListener("click", async () => {
            if (!confirm(`Revoke ${d.name}? Its key and access die immediately.`)) return;
            const result = await fetch(`${cloudBase()}/v1/device/revoke`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
              body: JSON.stringify({ device: d.id }),
            });
            if (!result.ok) return;
            if (d.id === state.deviceId) dropDevice();
            else loadDevices();
          });
          row.append(rm);
          roster.append(row);
        }
        if (!devices.length) roster.append(note("none yet — pair a device below", "muted"));
      } catch {
        /* offline: the section stays as-is */
      }
    };
    block.addEventListener("toggle", () => { if (block.open) void loadDevices(); });
  }
  return updateSshHint;
}

// ---- live terminals (read-only) ---------------------------------------------

function startTerm(target) {
  stopTerm(false);
  state.termTarget = target;
  state.termAnsi = null;
  sendPayload({ op: "term.read", target, lines: 40 });
  state.termTimer = setInterval(() => {
    if (!state.termTarget || !state.roomId) return stopTerm();
    sendPayload({ op: "term.read", target: state.termTarget, lines: 40 });
  }, 2_000);
  renderTerms();
}

function stopTerm(rerender = true) {
  if (state.termTimer) clearInterval(state.termTimer);
  state.termTimer = null;
  state.termTarget = null;
  state.termAnsi = null;
  if (rerender) renderTerms();
}

/** The panes list + the live pane, inside the details' body (survives view re-renders). */
function renderTerms() {
  const body = state.termBody;
  if (!body) return;
  body.replaceChildren();
  if (state.termTarget) {
    const bar = document.createElement("div");
    bar.className = "termbar";
    const name = document.createElement("span");
    name.className = "muted small";
    name.textContent = `${state.termTarget} — live, refreshes every 2s`;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "link";
    stop.textContent = "close";
    stop.addEventListener("click", () => stopTerm());
    bar.append(name, stop);
    body.append(bar);
    const pre = document.createElement("pre");
    pre.className = "termscreen";
    pre.textContent = state.termAnsi ?? "waiting for the pane…";
    body.append(pre);
    state.termPre = pre;
    paintTerm();
    return;
  }
  const list = document.createElement("div");
  list.className = "termlist";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link";
  btn.textContent = "refresh the pane list";
  btn.addEventListener("click", () => sendPayload({ op: "term.list" }));
  list.append(btn);
  const panes = state.terms ?? null;
  if (panes === null) {
    list.append(note("loading…", "muted"));
  } else if (!panes.length) {
    list.append(note("no panes — is a workspace open on the machine?", "muted"));
  } else {
    const labels = new Map((state.view?.workspaces ?? []).map((w) => [w.id, w.label]));
    for (const p of panes) {
      const row = document.createElement("div");
      row.className = "keyrow termrow";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "link termname";
      const ws = labels.get(p.workspace) || p.workspace;
      label.textContent = `${ws} · ${p.agent ? `${p.agent} (${p.status})` : p.title || "terminal"}`;
      label.title = `${p.cwd} — ${p.id}`;
      label.addEventListener("click", () => startTerm(p.id));
      row.append(label);
      list.append(row);
    }
  }
  body.append(list);
}

function paintTerm() {
  const pre = state.termPre;
  if (!pre || !state.termAnsi) return;
  pre.replaceChildren(...ansiToNodes(state.termAnsi));
  pre.scrollTop = pre.scrollHeight;
}

/** SGR-only ANSI → DOM nodes: colors (palette + truecolor), bold. Cursor and other
 *  sequences are dropped — this is a reading view, not an emulator. No innerHTML:
 *  every byte from the wire becomes text nodes, never markup. */
function ansiToNodes(s) {
  const pal = ["#5b5b5b", "#d54e53", "#5db542", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#acacac", "#8a8a8a", "#ff6f6f", "#8ce07d", "#ffe08a", "#93c5fd", "#e2a2ff", "#8be9fd", "#ffffff"];
  const out = [];
  let fg = null;
  let bg = null;
  let bold = false;
  let i = 0;
  s = String(s).replace(/\r\n?/g, "\n");
  const flush = (text) => {
    if (!text) return;
    if (fg === null && bg === null && !bold) {
      out.push(document.createTextNode(text));
      return;
    }
    const span = document.createElement("span");
    if (fg) span.style.color = bold ? `color-mix(in srgb, ${fg} 70%, white)` : fg;
    if (bg) span.style.background = bg;
    if (bold && !fg) span.style.fontWeight = "600";
    span.textContent = text;
    out.push(span);
  };
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      const rest = s.slice(i);
      let m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(rest);
      if (m) {
        if (m[2] === "m") {
          const parts = m[1] === "" ? [0] : m[1].split(";").map((x) => (x === "" ? 0 : Number(x)));
          for (let k = 0; k < parts.length; k += 1) {
            const p = parts[k];
            if (p === 0) { fg = bg = null; bold = false; }
            else if (p === 1) bold = true;
            else if (p === 22) bold = false;
            else if (p === 39) fg = null;
            else if (p === 49) bg = null;
            else if (p >= 30 && p <= 37) fg = pal[p - 30];
            else if (p >= 90 && p <= 97) fg = pal[p - 90 + 8];
            else if (p >= 40 && p <= 47) bg = pal[p - 40];
            else if (p >= 100 && p <= 107) bg = pal[p - 100 + 8];
            else if ((p === 38 || p === 48) && parts[k + 1] === 2) {
              const c = `rgb(${parts[k + 2] || 0},${parts[k + 3] || 0},${parts[k + 4] || 0})`;
              if (p === 38) fg = c; else bg = c;
              k += 4;
            } else if ((p === 38 || p === 48) && parts[k + 1] === 5) {
              const n8 = parts[k + 2] || 0;
              const c = pal[n8 % 16];
              if (p === 38) fg = c; else bg = c;
              k += 2;
            }
          }
        }
        i += m[0].length;
        continue;
      }
      m = /^\x1b\][^\x07]*(?:\x07|\x1b\\)/.exec(rest) || /^\x1b./.exec(rest);
      i += m ? m[0].length : 1;
      continue;
    }
    let j = s.indexOf("\x1b", i);
    if (j < 0) j = s.length;
    flush(s.slice(i, j));
    i = j;
  }
  return out;
}

function note(message, kind) {
  const p = document.createElement("p");
  p.className = kind === "error" ? "error" : "muted";
  p.textContent = message;
  return p;
}

// ---- the room socket -------------------------------------------------------

function disconnect() {
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  e2eReset();
}

function selectRoom(roomId, pair, fresh = false) {
  resetRoomView();
  state.roomId = roomId;
  state.showSecretOnce = fresh;
  if (state.deviceRoom !== roomId || state.deviceId !== pair.id) {
    disconnect();
    state.deviceRoom = roomId;
    state.deviceId = pair.id;
    state.deviceSecret = pair.secret;
    state.retry = 0;
    connect();
  }
  render();
  if (state.hello && state.ws?.readyState === WebSocket.OPEN) askView();
}

function dropDevice() {
  const roomId = state.deviceRoom;
  if (roomId && roomPairs().get(roomId)?.id === state.deviceId) savePair(roomId, null);
  clearLegacyPair();
  disconnect();
  state.deviceRoom = null;
  state.deviceId = "";
  state.deviceSecret = "";
  goMachines();
  connect();
}

function connect() {
  if (!state.token || state.ws) return;
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
    if (state.ws !== ws) return;
    const hello = state.deviceSecret && state.deviceId
      ? { device: state.deviceId, deviceSecret: state.deviceSecret }
      : { accountToken: state.token };
    const resume = loadStream(state.deviceRoom);
    ws.send(JSON.stringify({
      v: 1,
      t: "hello",
      ...hello,
      name: deviceName(),
      ...(resume ? { resume: { room: state.deviceRoom, gen: resume.gen, seq: resume.seq } } : {}),
    }));
  });

  ws.addEventListener("message", (event) => {
    if (state.ws !== ws) return;
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    void onMessage(m, ws);
  });

  ws.addEventListener("close", (event) => {
    if (state.ws !== ws) return;
    state.ws = null;
    e2eReset();
    if (state.roomId && pinnedHost()) clearRoomPayload();
    if (event.code === 4001 && ["unknown device credentials", "revoked"].includes(event.reason)) {
      dropDevice();
      return;
    }
    if (event.code === 4001 && event.reason === "unknown account token") {
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
    const rid = m.t === "presence" ? m.roomId : state.deviceRoom;
    const cur = loadStream(rid);
    if (cur && m.seq > cur.seq) saveStream(rid, cur.gen, m.seq);
  }
  switch (m.t) {
    case "hello": {
      state.retry = 0;
      state.hello = { agents: Array.isArray(m.agents) ? m.agents : [] };
      if (m.device?.id) {
        const { roomId, id, scope } = m.device;
        if (!state.deviceRoom) {
          // Migrate the legacy single pairing only after the gate identifies its room.
          savePair(roomId, { id, secret: state.deviceSecret, scope });
          clearLegacyPair();
          state.roomId = roomId;
        }
        state.deviceRoom = roomId;
      }
      // Resume outcome: the stream header carries the cloud's position; when the
      // replay had a hole (too long away), askView() below re-fetches the state.
      const rid = m.device?.roomId ?? null;
      if (m.ssh && typeof m.ssh.port === "number") {
        state.sshPort = m.ssh.port;
        if (typeof m.ssh.host === "string") state.sshHost = m.ssh.host;
      }
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
      if (payload?.op === "e2e.ready") {
        if (!e2e.ch?.ready() || e2e.ready || e2e.initing || e2e.keyChanged) return;
        e2e.ready = true;
        renderRoom();
        void askView();
        return;
      }
      if (payload?.op === "e2e") {
        const ch = e2e.ch;
        if (!e2e.ready || !ch?.ready()) return;
        try {
          const inner = await ch.recv(payload);
          if (state.ws !== ws || e2e.ch !== ch) return;
          if (!e2e.verified) {
            // The plaintext ready ack only starts transport. A valid encrypted
            // response proves the peer has the static key before we store the pin.
            localStorage.setItem(e2eFpKey(state.deviceRoom), ch.hostFingerprint);
            e2e.verified = true;
            renderRoom();
          }
          applyPayload(inner);
        } catch {
          if (state.ws === ws && e2e.ch === ch) restartEncryptedRoom();
        }
        return;
      }
      if (e2e.keyChanged) return;
      if (pinnedHost() || e2e.ch?.ready()) {
        // Plaintext after a publisher restart may trigger renegotiation, but is never displayed.
        if (e2e.ready && (payload?.code === "e2e" || payload?.op === "view")) restartEncryptedRoom();
        else if (!e2e.ready) void e2eBegin();
        return;
      }
      applyPayload(payload);
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
function clearRoomPayload() {
  state.view = null;
  state.viewError = null;
  state.terms = null;
  state.termAnsi = null;
  renderRoom();
  renderTerms();
}

function restartEncryptedRoom() {
  e2eReset();
  clearRoomPayload();
  void e2eBegin();
}

async function sendPayload(message) {
  const ws = state.ws;
  if (ws?.readyState !== WebSocket.OPEN || !state.roomId || e2e.keyChanged) return;
  const ch = e2e.ch;
  if (ch?.ready() && e2e.ready) {
    try {
      const payload = await ch.send(message);
      if (state.ws === ws && e2e.ch === ch) send({ t: "frame", payload });
    } catch {
      if (state.ws === ws && e2e.ch === ch) restartEncryptedRoom();
    }
    return;
  }
  void e2eBegin();
  if (!pinnedHost() && !ch?.ready()) send({ t: "frame", payload: message });
}

function askView() {
  return sendPayload({ op: "view" });
}
function applyPayload(payload) {
  // The plaintext (or decrypted) payload from the host lands here.
  if (payload && typeof payload === "object" && payload.op === "view") {
    state.view = payload.view;
    state.viewError = null;
  } else if (payload && typeof payload === "object" && payload.op === "term.list") {
    state.terms = Array.isArray(payload.panes) ? payload.panes : [];
    renderTerms();
    return;
  } else if (payload && typeof payload === "object" && payload.op === "term.read") {
    if (payload.target === state.termTarget && typeof payload.ansi === "string") {
      state.termAnsi = payload.ansi;
      paintTerm();
    }
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.health.result") {
    state.worker.health = payload;
    state.worker.error = payload.enabled === false ? payload.message ?? "worker queue disabled on this host" : null;
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.submitted") {
    state.worker.jobs.set(payload.id, { id: payload.id, status: payload.state, duplicate: payload.duplicate === true, hasBody: false });
    sendPayload({ op: "receipt.watch", id: payload.id, wantBody: true });
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "worker.status.result") {
    workerJobTouched(payload.id, { status: payload.state, ...(payload.reason ? { reason: payload.reason } : {}) });
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.watched") {
    workerJobTouched(payload.id, payload.pending ? { status: "pending" } : { status: payload.status, ...(payload.reason ? { reason: payload.reason } : {}) });
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.push") {
    workerJobTouched(payload.id, { status: payload.status, ...(payload.reason ? { reason: payload.reason } : {}), hasBody: payload.hasBody === true });
    sendPayload({ op: "receipt.ack", id: payload.id }); // displayed — retire the intent
    return;
  } else if (payload && typeof payload === "object" && payload.op === "receipt.body.result") {
    workerJobTouched(payload.id, payload.text !== undefined
      ? { body: payload.text }
      : { body: { reason: payload.reason ?? "unavailable" } });
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error" && payload.code === "busy") {
    return; // our poll raced the host's 1/s throttle — the next tick catches up
  } else if (payload && typeof payload === "object" && payload.op === "error" && WORKER_ERROR_CODES.has(payload.code)) {
    // Scoped to the worker panel: a refused submit/watch must not blank the room view.
    state.worker.error = payload.message ?? payload.code ?? "the host refused";
    state.worker.health = null;
    state.roomUi?.updateWorker?.(true);
    return;
  } else if (payload && typeof payload === "object" && payload.op === "error") {
    // The host refused or could not answer: an op we may not use, or its Herdr is down.
    state.viewError = payload.message ?? payload.code ?? "the host refused";
    state.view = null;
  } else {
    return;
  }
  renderRoom();
}

// ---- push wake ---------------------------------------------------------------

/** Subscribe this device to silent wake pushes; ask for permission only once paired. */
async function subscribePush() {
  const { deviceId, deviceSecret } = state;
  const base = cloudBase();
  if (!(deviceSecret && deviceId)) return; // paired devices only
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await fetch(`${base}/v1/push/key`);
      if (!keyRes.ok) return; // push disabled on this cloud
      const { publicKey } = await keyRes.json();
      const raw = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    }
    const endpoint = sub.endpoint;
    if (cloudBase() !== base || state.deviceId !== deviceId) return;
    await fetch(`${base}/v1/device/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: deviceId, deviceSecret, endpoint }),
    });
  } catch {
    /* permission denied or push unavailable: the gate still works without it */
  }
}

/** The host answered our handshake: finish it, pin its fingerprint (TOFU). */
async function onE2eReply(payload) {
  const ch = e2e.ch;
  const roomId = state.deviceRoom;
  if (!ch || !roomId || ch.ready() || e2e.initing || e2e.keyChanged) return;
  e2e.initing = true;
  try {
    const finish = await ch.acceptReply(payload, pinnedHost());
    if (e2e.ch !== ch) return;
    clearRoomPayload();
    send({ t: "frame", payload: { op: "e2e.finish", c: finish.c } });
  } catch (err) {
    if (e2e.ch !== ch) return;
    e2eReset();
    if (err?.code === "host-key-changed") {
      e2e.keyChanged = true;
      clearRoomPayload();
    }
  } finally {
    if (e2e.ch === ch) e2e.initing = false;
  }
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
  show("room", false);
  showError("pair-error", null);
  const name = $("pair-name");
  if (!name.value) name.value = deviceName();
  name.focus();
}

function pairStatus(message = "") {
  text("pair-status", message);
  show("pair-status", Boolean(message));
}

function closePair() {
  state.pairSocket?.cancel();
  pairStatus();
  state.pairRoom = null;
  show("pair", false);
  showError("pair-error", null);
}

$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.pairSocket || !state.pairRoom || !state.token) return;
  showError("pair-error", null);
  const { pairRoom: roomId, token: accountToken } = state;
  const name = $("pair-name").value.trim() || deviceName();
  const scope = $("pair-scope").value === "act" ? "act" : "read";
  // Pairing is an owner operation. Do not promote or replace the room socket.
  let ws;
  try { ws = new WebSocket(wsUrl()); }
  catch { return showError("pair-error", "Could not connect to the gate"); }
  const button = $("pair-form").querySelector("button");
  button.disabled = true;
  pairStatus("Connecting to the gate…");
  let requested = false;
  const operation = { cancel: () => finish() };
  state.pairSocket = operation;
  const timeout = setTimeout(() => finish("Pairing timed out"), 70_000);
  function finish(error) {
    if (state.pairSocket !== operation) return;
    state.pairSocket = null;
    button.disabled = false;
    pairStatus();
    clearTimeout(timeout);
    ws.close();
    if (error) showError("pair-error", error);
  }
  const sendPair = (message) => ws.send(JSON.stringify({ v: 1, ...message }));
  ws.addEventListener("open", () => {
    if (state.pairSocket === operation) sendPair({ t: "hello", accountToken, name: deviceName() });
  });
  ws.addEventListener("close", (event) => finish(event.reason || "Pairing connection closed"));
  ws.addEventListener("message", (event) => {
    if (state.pairSocket !== operation) return;
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m?.t === "hello" && !requested) {
      requested = true;
      pairStatus(scope === "act" ? "Waiting for the host to approve control…" : "Pairing…");
      sendPair({ t: "pair.begin", roomId, name, scope });
    } else if (m?.t === "pair.denied" || m?.t === "error") {
      finish(m.reason || m.message || "Pairing refused");
    } else if (m?.t === "pair.granted" && requested) {
      if (m.device?.roomId !== roomId || m.device.scope !== scope || typeof m.device.id !== "string" || typeof m.deviceSecret !== "string") {
        return finish("Invalid pairing reply");
      }
      const pairing = { id: m.device.id, secret: m.deviceSecret, scope };
      savePair(roomId, pairing);
      closePair();
      selectRoom(roomId, pairing, true);
      void subscribePush();
    }
  });
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

// Approve a new machine: the owner types the code its herdgate panel shows.
$("addmachine").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("addmachine-code").value.trim();
  const noteEl = $("addmachine-note");
  noteEl.hidden = false;
  noteEl.className = "muted small";
  noteEl.textContent = "approving…";
  try {
    const r = await fetch(`${cloudBase()}/v1/agent/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    $("addmachine-code").value = "";
    noteEl.textContent = "approved — the machine appears when its publisher connects";
    // A fresh hello lists the new room (rooms come from hello).
    disconnect();
    connect();
  } catch (e) {
    noteEl.className = "error small";
    noteEl.textContent = String(e.message ?? e);
  }
});

$("menu").addEventListener("click", () => {
  $("cloud").value = state.cloud;
  $("settings").showModal();
});

$("settings-form").addEventListener("submit", () => {
  const value = $("cloud").value.trim().replace(/\/$/, "");
  if (value !== state.cloud) {
    // Never forward credentials from one cloud to another.
    forgetToken();
    state.cloud = value;
    if (value) localStorage.setItem(CLOUD_KEY, value);
    else localStorage.removeItem(CLOUD_KEY);
  }
});

$("signout").addEventListener("click", () => forgetToken());

/** Back to the machine list — from the pair screen or the room screen.
 * Delegated at the document level so it works no matter what rebuilt the DOM
 * (and with a generous tap target; see .backbtn in the CSS). */
function resetRoomView() {
  stopTerm(false);
  state.terms = null;
  state.termBody = null;
  state.termPre = null;
  state.view = null;
  state.viewError = null;
  state.roomUi = null;
  $("view").replaceChildren();
}

const goMachines = () => {
  resetRoomView();
  state.roomId = null;
  closePair();
  render();
};
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("#back, #pair-back") : null;
  if (target) goMachines();
});

function forgetToken() {
  state.token = "";
  state.deviceId = "";
  state.deviceSecret = "";
  state.deviceRoom = null;
  state.hello = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PAIRS_KEY);
  clearLegacyPair();
  disconnect();
  goMachines();
  $("settings").close();
}

// ---- boot ------------------------------------------------------------------

// Which build is this? Shown in the machine list so a stale phone install is
// obvious at a glance (the service worker updates on the second launch).
{
  const el = document.getElementById("build");
  if (el) el.textContent = "herdgate " + BUILD;
}

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
