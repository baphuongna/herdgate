# herdgate — design

Architecture and trust boundaries. For installation and upgrade commands, see [README.md](README.md) and
[DEPLOY.md](DEPLOY.md).

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
| device | one room-scoped browser or SSH client | device ID + device secret, or registered SSH public key for SSH auth | `pair.begin` and key registration |

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
(replay what survived; the device re-requests its view). Device-targeted frames are
visible only to their destination device, live and in replay; sequence gaps between
its frames are normal because the cursor is room-wide. Frames with an `ssh.*` op are
**ephemeral**: sent raw, unstamped, never buffered — they belong to an SSH channel that
died with the drop, and replaying them into a new SSH session would corrupt its wire
protocol. `pair.granted` (carries the one-time device secret) is likewise never replayed.

HTTP: `GET /healthz`, `POST /v1/agent/code`, `POST /v1/agent/approve` (bearer account token),
`GET /v1/agent/code/:code/status`.

Limits: frames 256 KiB (`maxPayload`), 60 msg/s per socket (token bucket), hello within 10s, failed-hello
strikes per IP (5/min → 60s block), and WebSocket heartbeat pings (8s by default) with termination on silence.

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
| Cloud reading content | Gate routes application frames without interpreting them; only a negotiated Noise session protects that payload from the Gate. SSH terminates at the Gate. |
| Host confusion via cloudflared | optional `expectedHost` pin; nothing else about the edge is trusted |

Per-device secrets and Noise_XX payload sessions now exist. Noise applies to its own application payload
channel, not to SSH, which terminates at the Gate. Do not infer that all payloads use Noise or that the
single-owner deployment model provides multi-tenant isolation.

## 6. Roadmap

1. ~~**Per-device secrets**~~ — **done (v0.5.0)**: `pair.granted` returns a device secret once; hello uses it;
   the account token stays in the dashboard only (and is never an SSH credential).
2. ~~**Resume**~~ — **done (v0.6.0)**: room streams with `seq`/`gen`, a bounded replay buffer, gap declaration;
   see §3. Ciphertext-friendly by construction (the buffer stores opaque envelopes).
3. ~~**E2E payloads**~~ — **done (v0.7.0)**: Noise_XX (P-256/SHA-256/AES-256-GCM, WebCrypto-only so the
   plugin and the PWA run one identical module) over the payload channel; the device initiates after
   pairing, the host acks with `e2e.ready` (nothing encrypts before the ack — a frame racing the
   handshake's last step would desync the counters forever), and a decrypt failure drops the session for
   renegotiation. Cipher operations are serialized per direction. Host identity is TOFU: the PWA uses
   a full SHA-256 pin, upgrades a matching legacy pin and refuses changed keys or plaintext pane data
   on a pinned room. See `plugin/server/e2e.mjs`.
4. ~~**Official Herdr adapter**~~ — **done (v0.1.0)**, read-only. `src/host/herdr.ts` runs
   `herdr api snapshot` (verified on Herdr 0.9.5, protocol 22) and maps `workspaces[]`, `tabs[]`, `panes[]`,
   `agents[]` and the focused ids into a versioned view. Device ops are `view` and `ping`; every other op is
   refused on the host with `read-only`. Next in this line: an `act` op set once per-op policy and audit exist.
5. **Device PWA** — shipped: pairing, multi-room dashboard, per-device SSH key management and read-only pane views.
5b. **SSH through the Gate** — shipped: per-device public keys, TUI bridge, real Core and the scoped Mobile
   TUI adapter (see §8).
5c. **SSH without inbound publisher ports** — shipped: SSH over WSS for desktop clients and a tokenless
   TCP edge for Mobile. The old owner-token SSH bridge is a separate legacy deployment.
6. ~~**Push wake**~~ — **done (v0.8.0)**: VAPID keys beside the state file; a paired device stores its web-push
   subscription (`/v1/device/push`); the host sends `wake {device}` and the cloud delivers a silent,
   payload-less push — but only when the device is not connected (a connected one is already live). The
   PWA's service worker raises a notification only when no window is open. Off by default since v0.9.33;
   opt-in wake uses a fixed HTTPS provider list and connects only to an approved public IPv4 DNS result,
   retaining TLS verification for the provider name and never following redirects.
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

The table describes the standalone metadata adapter. The TUI publisher also exposes read-only
`term.list` and `term.read` for the PWA. Browser payload operations do not grant terminal input;
SSH access is a separate channel with its own authorization.

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

The plugin uses Herdr's CLI for metadata and pane reads, and fixed Herdr bridge commands for remote TUI
connections. The interactive Mobile adapter additionally uses Herdr's native terminal session control.
These integrations use the running TUI server's configured executable and socket, not a second Herdr
server. Nothing patches Herdr.

Credentials go in `HERDR_PLUGIN_CONFIG_DIR`, not the managed plugin checkout; runtime state goes in
`HERDR_PLUGIN_STATE_DIR`. The standalone plugin uses Node's native `WebSocket`; the opt-in Linux Gate
loopback transport uses the bundled `ws` dependency.

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

### SSH clients: TUI, real Core and the Mobile TUI adapter

The Gate (`src/cloud/sshd.ts`) terminates SSH and authenticates the device ID with its registered public
key or device secret, never with the owner token. Each exec is an ephemeral channel bound to the
authenticated device and room. The publisher dispatches supported commands to fixed argv, not a shell.
A VPS TCP edge, when used, carries raw SSH over WSS and holds no Gate credentials; the client verifies
and pins the Gate's SSH host key. SSH channels are not replayed or resumed after a disconnect.

| Target | Host scope enforcement |
|---|---|
| Existing Herdr TUI via the desktop TUI bridge | `act` only; the native two-way bridge is not a read filter. |
| Real `herdr-core` | A `read` device gets filtered plain JSON-RPC; framed hello is downgraded. Approved `act` gets byte-transparent Core RPC. |
| Existing TUI panes via the Mobile adapter | Read/observe attaches show a text snapshot; no input or resize. An explicitly configured device with matching `act` scope can use Send, keys, Interrupt and native attach with ANSI, input and resize. |

The Mobile adapter speaks the Core protocol subset needed for those operations and rejects unsupported
RPCs. It does not implement Core task lifecycle, templates or file operations. See
`plugin/server/mobile-tui-core.mjs` and `plugin/server/mobile-tui-stream.mjs`.

### Publisher releases and migration

The platform-specific publisher runtime is installed outside npm's cache. On Windows `herdgate install`
installs a per-user, Node-pinned command from npm. First setup also provisions it. Its `command` junction
is separate from the publisher's `current` junction, so publisher rollback does not remove the command.
User PATH registration is optional and never changes the machine-wide PATH. Migration stages and validates
first, then saves the existing device mode only after the new publisher connects; failure triggers a
rollback attempt. On Linux the CLI installs a user systemd unit, recognizes only the known legacy home
unit for adoption, and checks the new invocation's Gate hello. Both preserve the room config and the
running Herdr server. The Gate, TCP edge, and standalone Linux Mobile publishers have independent
lifecycles.

## 9. Herdr-relay comparison (why a new project)

herdr-relay: Mac-local bridge, Tailscale identity, renders Herdr's mods in sandboxed processes, diffs trees
bridge-side. herdgate: the cloud in the middle, own identity, host renders, cloud routes opaque frames. The
ideas kept: hello-first auth, hashed tokens, scope-aware routing, single-use artifacts, rate limits everywhere.
The parts dropped: mod sandboxing (the host is trusted code on its own machine), tree recording (the host owns
its UI), Tailscale (public via cloudflared).


## Wake by herdr event (2026-11-22)

Settles and pane deaths are **herdr's observations**, not the child's. The plugin manifest
hooks `pane.agent_status_changed`, `pane.exited`, `pane.closed` into
`plugin/server/wake-event.mjs` — a short-lived process per event:

```
herdr event ─▶ wake-event.mjs ─▶ registry lookup (spawn children only)
                                 ├─ settle (idle|done, revision-stable) ─▶ 🔔 frame → parent pane
                                 └─ death (no final receipt, not closedBy parent) ─▶ DIED frame (once)
```

Discipline layered from live incidents and the herdr-pings/sidebar/cats deep research:
flock try_lock per event (burst dedup) · heartbeat liveness (>20s stale revision =
corpse echo, dropped) · generation tokens on every frame (`gen=<revision>`) ·
stamp-and-byte-verify sidecar writes · parent quiet-wait before typing (pane run,
never the RPC channel) · `parentPaneId` recorded at spawn beats session-file lookup.
The publisher keeps receipts purely as evidence (device push); it no longer wakes.

## State discipline (2026-11-22)

Spawn registry and receipt-adjacent state follow herdr-portfwd's rules: a damaged file
throws WITH ITS NAME (never reads as empty), writes are O_EXCL temp + rename with a
stable sort (byte-stable files), and a state directory writable by group/other is
refused outright. `startCloud` resolves only after the sshd has bound (a Cloud whose
`.ssh.port` is still zero made ssh2 silently dial :22 — a live flake).
