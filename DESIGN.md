# herdgate — design

v0 skeleton, 2026-11-18. This document is the contract the code aspires to; where they disagree today, the code
wins and this file gets fixed.

## 1. What herdgate is

A relay hub between **host apps** and **devices** (browsers, PWAs). The first host target is official
[Herdr](https://herdr.dev). A herdgate-owned local adapter will use a verified upstream interface; the adapter
runs on the host and the agent connects outbound to the gateway. No fork, third-party plugin, or relay project
is required. The hub handles identity, routing, and presence; content and policy stay in the host adapter. Payloads crossing the cloud are **opaque by rule**: the cloud never parses, logs or
persists them.

Three deployment properties:

1. Hosts and devices both connect **outbound**; only the cloud is publicly reachable (via cloudflared on the
   machine that runs it).
2. The cloud is the **identity provider**. No Cloudflare Access in front, no trusted proxy headers. If
   `HERDGATE_PUBLIC_HOST` is set, the Host header is enforced (anti host-confusion) but nothing else about the
   edge is trusted.
3. Single-owner v0: accounts come from config (env tokens). Multi-account signup is roadmap, not code.

## 2. Identity: accounts, rooms, devices

| Layer | Who | Credential | Minted by |
|---|---|---|---|
| account | a person | config token (v0) | operator (env) |
| room | one host app | room token (random 32B, stored **hashed**) | device-flow approval |
| device | one browser/PWA | device record id + the account token | `pair.begin` |

- **Host provisioning (device flow).** The host mints a code (`POST /v1/agent/code`), a human approves it from a
  logged-in device (`POST /v1/agent/approve`), the host polls `GET /v1/agent/code/:code/status` and receives the
  room token exactly once. The host stores it; re-provisioning rotates it.
- **Device pairing.** A device hellos with its account token, then `pair.begin {roomId, name, scope}`.
  `read` pairs immediately. `act` triggers `pair.request` **down to the host** — the human approves on the host
  (approve-on-host), the cloud grants on `pair.response`. Timeout 60s → denied.
- **Scopes.** `read` = view; `act` = may cause effects. The cloud knows scopes and reports them
  (`room.update`, `hello.devices`), but **enforcement of what an `act` payload may do is host-side** — the cloud
  cannot see payloads. This split is deliberate (see §5).

## 3. Wire protocol (v1)

One JSON object per WS text frame: `{v:1, t:"…", …}`. Unknown `v` → close. Legs:

- `GET /v1/agent/ws` — host leg. `hello {roomToken, info}` first (10s deadline, else close 4001). Then
  `frame {device, payload}` ⇄, `presence`, `pair.request`/`pair.response`, `ping`/`pong`, `room.update`.
  One live agent per room: a second connection supersedes the first (4000).
- `GET /v1/device/ws` — device leg. `hello {accountToken | device+deviceSecret, resume?}` first. Then `frame {payload}`
  (routed to the paired room's host), `pair.begin` → `pair.granted`/`pair.denied`, `presence`, `ping`/`pong`.

### Room streams and resume (v0.6.0)

Every host→device message that matters while a phone is away (frames, presence) carries a
room-scoped `seq` and is buffered briefly (last 256 KiB / 120 s per room). Device hello
responses carry a `stream {gen, seq}` header; a reconnecting device adds
`resume {room, gen, seq}` to its hello and receives `resumed:true` plus the buffered tail
in order. `gen` changes on every gateway process start, so stale bookkeeping from a
previous life invalidates in one comparison — the device gets a fresh hello (`resumed:false`)
and re-requests state. A resume from before what was kept answers `stream.gap:true`
(replay what survived; the device re-requests its view). Frames with an `ssh.*` op are
**ephemeral**: sent raw, unstamped, never buffered — they belong to an SSH channel that
died with the drop, and replaying them into a new SSH session would corrupt its wire
protocol. `pair.granted` (carries the one-time device secret) is likewise never replayed.

HTTP: `GET /healthz`, `POST /v1/agent/code`, `POST /v1/agent/approve` (bearer account token),
`GET /v1/agent/code/:code/status`.

Limits: frames 256 KiB (`maxPayload`), 60 msg/s per socket (token bucket), hello within 10s, failed-hello
strikes per IP (5/min → 60s block), protocol-level pings every 30s with terminate on silence.

## 4. State

`state.json` (atomic tmp+rename, 0600): rooms (token hashed) + devices. In-memory pending pairing codes never
touch disk. v0 loses open sockets on restart; the room stream resumes devices after a drop (§3), and the `gen`
header makes a restart a clean re-sync rather than a wrong replay.

## 5. Threat model — what the cloud promises

| Threat | Mitigation (v0) |
|---|---|
| Guessing a room token / account token | 256-bit random, hashed at rest, constant-time compare, failed-hello strikes |
| Brute-forcing pairing codes | 8-char no-lookalike alphabet, 10-min TTL, single retrieval, rate-limited mint per IP |
| A stolen `act` device | approve-on-host at pair time; host re-confirmation of dangerous ops is host policy |
| Hostile room claiming | codes bound to the approving account; rooms never cross accounts |
| DoS | per-IP blocks, per-socket rate, frame caps, supersede rule, unbounded fan-out is a bug |
| Cloud reading content | **opaque payloads rule** — nothing to read; E2E (§6) removes even the possibility |
| Host confusion via cloudflared | optional `expectedHost` pin; nothing else about the edge is trusted |

What v0 does **not** promise: per-device secrets (account token = device identity today — roadmap), payload confidentiality on the wire beyond TLS (E2E roadmap), multi-account isolation.

## 6. Roadmap

1. ~~**Per-device secrets**~~ — **done (v0.5.0)**: `pair.granted` returns a device secret once; hello uses it;
   the account token stays in the dashboard only (and is never an SSH credential).
2. ~~**Resume**~~ — **done (v0.6.0)**: room streams with `seq`/`gen`, a bounded replay buffer, gap declaration;
   see §3. Ciphertext-friendly by construction (the buffer stores opaque envelopes).
3. **E2E payloads** — Noise_XX at pair time (device ↔ host key exchange), `payload` becomes a ciphertext
   string; the cloud is already a dumb router, so nothing changes server-side.
4. ~~**Official Herdr adapter**~~ — **done (v0.1.0)**, read-only. `src/host/herdr.ts` runs
   `herdr api snapshot` (verified on Herdr 0.9.5, protocol 22) and maps `workspaces[]`, `tabs[]`, `panes[]`,
   `agents[]` and the focused ids into a versioned view. Device ops are `view` and `ping`; every other op is
   refused on the host with `read-only`. Next in this line: an `act` op set once per-op policy and audit exist.
5. **Device PWA** — pairing page + dashboard + frame UI (static files served by the cloud).
5b. ~~**SSH leg through the gate**~~ — **done (v0.5.0)**; see §8. Follow-ups: publickey auth, framed/live
   terminals for `read` devices via an observe-only proxy.
6. **Push wake** — VAPID keys in the cloud; hosts send opaque wake pings.
7. Multi-account signup, quotas, Postgres state, audit log.

## 7. Host payload contract (herdgate.herdr.v1)

The cloud routes `payload` blind, so the host and its devices own their own schema. Current ops:

| Direction | Message | Reply |
|---|---|---|
| device → host | `{op:"view"}` | `{op:"view", view}` (lazy read if none yet) |
| device → host | `{op:"ping", n?}` | `{op:"pong", n, at}` |
| host → device | `{op:"view", view}` | pushed when the view changes, and to a newly paired device |
| host → device | `{op:"error", code, message}` | `read-only` for any other op; `host-unavailable` when Herdr cannot be read |

`view` = `{v:1, source:"herdr", herdrVersion, protocol, takenAt, focused{workspaceId,tabId,paneId},
workspaces[{id,label,number,tabs,panes,agentStatus,focused}], agents[{name,kind,status,workspaceId,tabId,paneId,cwd,title}]}`.
A new Herdr version that adds keys keeps working (every field is read defensively); a missing key degrades to an
empty/honest value rather than throwing.

Pairing `act` is off unless the operator sets `HERDGATE_ALLOW_ACT=1`; the read-only op set means even an `act`
device has nothing to cause an effect with yet.

## 8. How herdgate attaches to Herdr (official surface only)

Herdr is not forked, patched, or re-implemented. herdgate is a **Herdr plugin**: a directory with
`herdr-plugin.toml` whose commands Herdr validates, launches, and logs — the surface Herdr documents for
extensions (`docs/plugins.mdx`) and lists in the marketplace (`herdr-plugin` GitHub topic, `/tui/plugins/`).

| Manifest entry | Command | Why |
|---|---|---|
| `[[startup]]` | `node server/index.mjs serve` | Herdr runs it once after the socket API is ready; it spawns the long-lived publisher and exits, so a failed publisher cannot fail the Herdr server |
| `[[actions]]` | `pair`, `status`, `stop` | the human-facing operations, invoked as `herdr plugin action invoke dev.herdgate.host.pair` |
| `[[panes]]` | `node server/index.mjs pane` | a `split` pane inside Herdr showing honest publish state (light 10s poll) |

Two official surfaces are used, one per program: the **plugin** (§ above, `herdr-plugin.toml`) for the TUI, and
the **app mod** (§ below, `mods/<name>/`) for the desktop app.

The plugin's only Herdr API is the documented one: `HERDR_BIN_PATH ... api snapshot`. Env it relies on is the
set Herdr injects (`HERDR_ENV`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`,
`HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, …). Nothing is read from a
private Herdr path and nothing patches Herdr.

Credentials go in `HERDR_PLUGIN_CONFIG_DIR` (user-editable, never in `HERDR_PLUGIN_ROOT`, which is a managed
source checkout); runtime state goes in `HERDR_PLUGIN_STATE_DIR`. The plugin has no `node_modules` dependency:
it uses Node's global `WebSocket`, so a GitHub `herdr plugin install` of just this directory works.

Note on Herdr's moving parts: the **TUI** (`herdr`) exposes workspaces/tabs/panes/agents; **herdr-core** (`hc`)
is the separate runtime under the Herdr app and its iPhone/iPad/Android app, with a JSON-RPC API of its own.
The plugin attaches to the TUI's documented CLI.

### The Herdr app mod (`app-mod/herdgate/`)

The desktop app extends through **mods**, a different official surface (`docs/mods.md`,
`defaults/AGENTS.md`): `mods/<name>/` with `mod.json` + `main.js`, written in gpui-kit. A mod is trusted code
with `fetch`, `exec`, and unrestricted network — but **no Node globals** (`process`, `require`, `setTimeout`
are absent). Verified in a real window: `herdr-app check` passes, `mod.open` reports `overlays:["herdgate"]`
with `errors: []`, and a probe mod reached a live herdgate cloud with `fetch` (HTTP 200).

The mod and the TUI plugin share one publisher: the mod owns the pairing conversation (mint a code, poll,
write the token 0600) and shells out to `plugin/server/index.mjs serve` for the long-lived connection. One
implementation, two surfaces.

### Mobile: over SSH, through herdgate (v0.5.0)

The Herdr phone app is closed source and has no extension surface. It talks to `herdr-core` **over SSH** —
`ssh <machine> hc connect`, JSON-RPC one message per line — and that is the supported path. herdgate now
**terminates that SSH leg itself** (`src/cloud/sshd.ts`, ssh2):

- the phone's "add a machine" points at the gate: username = the device id, password = the device secret
  `pair.granted` issued once (per-device secrets, roadmap §6 item 1, landed with this leg — the PWA stores
  its key locally and re-attaches with it; the account token is no longer a device credential and is NOT an
  SSH credential);
- each SSH exec session is one bridge channel: the cloud relays `ssh.*` payloads opaquely, and the host-side
  bridge (`src/host/ssh.ts`, mirrored in `plugin/server/ssh.mjs`) spawns exactly the requested `hc …` command
  (argv, `shell: false`) and pipes it byte by byte;
- **scope is enforced at the host bridge** — the trusted decision point, since the cloud cannot see payloads:
  a `read` device gets a filtered plain-mode channel (mutating JSON-RPC methods are refused with a real
  error and never reach herdr-core; a `framed: true` hello is downgraded so live terminals — which are
  write streams — cannot be typed into; garbage is cut off), while an `act` device, approved by a human on
  the host, gets byte-transparent access;
- the SSH host key is minted once (Ed25519, mode 0600) and its fingerprint is printed at boot.

Verified against real herdr-core 0.1.21: a `read` device authenticated with its key, listed terminals, read a
terminal, subscribed to events; `terminal.send` and `file.write` were refused at the gate and nothing was
written. An `act` device passes `framed: true` through untouched.

Scope of this slice: `password` auth only (no publickey yet), plain mode for `read` (framed/live terminal is
act-only), and no session resume. Reachability: on the LAN or via VPN/Tailscale to the machine running the
gate; the SSH listener binds loopback by default and needs `HERDGATE_SSH_BIND=0.0.0.0` for LAN phones.

## 9. Herdr-relay comparison (why a new project)

herdr-relay: Mac-local bridge, Tailscale identity, renders Herdr's mods in sandboxed processes, diffs trees
bridge-side. herdgate: the cloud in the middle, own identity, host renders, cloud routes opaque frames. The
ideas kept: hello-first auth, hashed tokens, scope-aware routing, single-use artifacts, rate limits everywhere.
The parts dropped: mod sandboxing (the host is trusted code on its own machine), tree recording (the host owns
its UI), Tailscale (public via cloudflared).
