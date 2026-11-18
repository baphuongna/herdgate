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
- `GET /v1/device/ws` — device leg. `hello {accountToken, device?}` first. Then `frame {payload}` (routed to
  the paired room's host), `pair.begin` → `pair.granted`/`pair.denied`, `presence`, `ping`/`pong`.

HTTP: `GET /healthz`, `POST /v1/agent/code`, `POST /v1/agent/approve` (bearer account token),
`GET /v1/agent/code/:code/status`.

Limits: frames 256 KiB (`maxPayload`), 60 msg/s per socket (token bucket), hello within 10s, failed-hello
strikes per IP (5/min → 60s block), protocol-level pings every 30s with terminate on silence.

## 4. State

`state.json` (atomic tmp+rename, 0600): rooms (token hashed) + devices. In-memory pending pairing codes never
touch disk. v0 loses open sockets on restart; resume is roadmap (§6).

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

What v0 does **not** promise: per-device secrets (account token = device identity today — roadmap), session
resume after reconnect, payload confidentiality on the wire beyond TLS (E2E roadmap), multi-account isolation.

## 6. Roadmap

1. **Per-device secrets** — `pair.granted` returns a device token; hello uses it; account token stays in the
   dashboard only.
2. **Resume** — session ids + seq + a per-session ring buffer of frames in the cloud (ciphertext-friendly).
3. **E2E payloads** — Noise_XX at pair time (device ↔ host key exchange), `payload` becomes a ciphertext
   string; the cloud is already a dumb router, so nothing changes server-side.
4. ~~**Official Herdr adapter**~~ — **done (v0.1.0)**, read-only. `src/host/herdr.ts` runs
   `herdr api snapshot` (verified on Herdr 0.9.5, protocol 22) and maps `workspaces[]`, `tabs[]`, `panes[]`,
   `agents[]` and the focused ids into a versioned view. Device ops are `view` and `ping`; every other op is
   refused on the host with `read-only`. Next in this line: an `act` op set once per-op policy and audit exist.
5. **Device PWA** — pairing page + dashboard + frame UI (static files served by the cloud).
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

## 8. Herdr-relay comparison (why a new project)

herdr-relay: Mac-local bridge, Tailscale identity, renders Herdr's mods in sandboxed processes, diffs trees
bridge-side. herdgate: the cloud in the middle, own identity, host renders, cloud routes opaque frames. The
ideas kept: hello-first auth, hashed tokens, scope-aware routing, single-use artifacts, rate limits everywhere.
The parts dropped: mod sandboxing (the host is trusted code on its own machine), tree recording (the host owns
its UI), Tailscale (public via cloudflared).
