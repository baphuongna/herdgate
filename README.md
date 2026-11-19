# herdgate

**A cloud relay hub: host agents and devices meet behind one gate.**

```
Herdr (herdr.dev) ──local── herdgate agent ──WSS──▶ cloud gate ◀──WSS── browser/PWA
                             owns host policy       Cloudflare Tunnel

Both remote connections are outbound; the cloud gateway binds loopback.
```

- **One gate, three identities** — accounts (people), rooms (hosts), devices (browsers). Hosts pair by a
  GitHub-style device flow; devices pair into a room; `act` scope needs the host's own approval.
- **Opaque payloads** — the cloud routes frames between legs and never inspects, logs or persists them.
  End-to-end encryption can be added later without changing the cloud.
- **No inbound ports on your machines** — publishers dial out over wss; the gate is published through
  `cloudflared`; and the phone app's SSH leg reaches machines with no open port at all via the
  one-file [`ssh-bridge`](DEPLOY.md#the-ssh-leg-is-not-a-cloudflare-tcp-leg--three-ways-in) on any
  reachable host — auth and the read-only allowlist stay in the cloud, the bridge carries no secrets;
  identity provider (no Cloudflare Access needed, none of its headers trusted).

## Status

v0.6.0 — gateway (HTTP + 2 WS legs), pairing flows, routing, presence, rate limits, state persistence; agent
SDK with reconnect; **a real Herdr plugin** (`plugin/`) using Herdr's official extension surface; an app mod,
a PWA, an SSH leg for the Herdr phone app, **room-stream resume** — a phone that drops off wifi replays
what it missed (frames + presence) instead of losing them — **end-to-end payloads** — Noise_XX between
device and host inside the opaque channel, so the cloud routes ciphertext it cannot read — and **push
wake**: VAPID-signed silent pings that raise a phone from its sleep when the host has news; 28 tests. All
of it verified live through a real Cloudflare Tunnel (gate.phuongnb.io.vn), push subscription and all, and systemd user units (gateway, tunnel, publisher) keeping it alive.

The Herdr adapter is read-only: it runs `herdr api snapshot` and serves workspaces/tabs/panes/agents/status to
paired devices. It never reads a pane, sends a keystroke, or prompts an agent. Terminal content is a later
slice, by design. No third-party plugin or relay is a dependency — only Herdr's own CLI.

## Layout

```
src/protocol/   the wire contract (envelope, agent leg, device leg)
src/cloud/      the gateway: stores, pairing, routing, HTTP/WS, CLI (main.ts)
src/agent/      HerdGateAgent SDK + AgentAdapter (what a host app implements)
src/host/       standalone host CLI (no Herdr needed) + the `herdr api snapshot` adapter
plugin/         the Herdr TUI plugin: herdr-plugin.toml + server/ (what `herdr plugin link` loads)
app-mod/        the Herdr app mod: mods/herdgate/ (what `herdr-app check` validates)
src/web/        the PWA a device opens — served by the cloud, same origin as the WS legs
test/           e2e relay, the adapter, and the plugin's own commands
```

## Quickstart

```sh
npm install
npm test                       # e2e: one cloud, one host, three devices

# run the cloud (state persists to ./herdgate-state.json)
HERDGATE_ACCOUNT_TOKEN=$(openssl rand -base64 32) \
HERDGATE_STATE=./herdgate-state.json \
npm start
```

Pair a host (on the host machine, or from a test script):

```sh
curl -XPOST localhost:8787/v1/agent/code -d '{"name":"bom-mac"}'        # → {code, url}
curl -XPOST localhost:8787/v1/agent/approve \
  -H "Authorization: Bearer $HERDGATE_ACCOUNT_TOKEN" -d '{"code":"XXXX"}'
curl localhost:8787/v1/agent/code/XXXX/status                            # → {roomToken} (once)
```

A device opens `ws://…/v1/device/ws`, sends `hello {accountToken}`, calls `pair.begin` — `read` pairs at once,
`act` waits for the host to answer `pair.request`.

**Install as a Herdr plugin** (the supported surface — `herdr plugin link` validates the manifest):

```sh
herdr plugin link /home/bom/source/herdgate/plugin
herdr plugin action list --plugin dev.herdgate.host
herdr plugin action invoke dev.herdgate.host.pair     # prints the code; approve it
herdr plugin pane open --plugin dev.herdgate.host --entrypoint status
```

**Install as a Herdr app mod** (the desktop app's own surface — `herdr-app check` validates it):

```sh
cp -r /home/bom/source/herdgate/app-mod/herdgate ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/herdgate      # → check passed
```

The panel docks on the right: set the cloud URL and the herdgate folder, press **Pair**, approve the code in
your dashboard, then **Publish**. The token goes to `~/.config/herdr-app/herdgate/config/herdgate.env` (0600).
The mod has `fetch` and `exec` but **no Node globals** (no `process`, `require`, `setTimeout`) — verified in a
real window.

Herdr then runs the `[[startup]]` hook itself: one publisher per server, read-only, reconnecting on its own.
Credentials live in `HERDR_PLUGIN_CONFIG_DIR/herdgate.env` (mode 0600), never in the plugin root — the plugin
uses only env Herdr injects (`HERDR_BIN_PATH`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, …) and
needs no `node_modules` (Node's global `WebSocket`).

**Or run the host standalone** (no Herdr, its own process):

```sh
HERDGATE_URL=https://herd.example.com HERDGATE_PROVISION=1 npm run host
#   → prints HERDGATE_ROOM_TOKEN=…   store it, then:
HERDGATE_URL=https://herd.example.com HERDGATE_ROOM_TOKEN=… npm run host
```

Devices pair into the room and ask for `{op:"view"}`; the host answers with the current Herdr metadata.

## The SSH leg (the Herdr phone app)

The phone app adds machines over SSH — herdgate terminates that SSH itself, so "add a machine" points at the
gate and the session lands on the host's real `herdr-core`:

```sh
ssh -p 2222 d_xxxxxxxx@your-gate        # password = the device key shown once at pair time
# then the phone speaks the hc API: hello, terminal.list, terminal.read, events.subscribe…
```

- Auth is **per device** (id + its one-time key), never the account token; wrong keys strike the IP out.
- **Public keys too**: `hc machine add` uses the system `ssh`, which prefers keys/agent and answers no
  prompts without a terminal. Register the adding machine's `~/.ssh/id_ed25519.pub` in the PWA (SSH →
  *Public keys*, or `POST /v1/device/sshkey`) and the add is passwordless — Ed25519/RSA/ECDSA, signatures
  verified per RFC 4252 §7.
- `read` devices get a filtered channel: mutating calls (`terminal.send`, `file.write`, …) are refused **on
  the host** with a real JSON-RPC error, and live-terminal mode is downgraded. `act` devices (approved on the
  host) get byte-transparent access.
- Only `hc …` runs — no shell, no sftp, no port forwarding.
- The host needs `herdr-core` (`hc`) on PATH or `HERDGATE_HC_BIN`.

**Note:** ssh2 1.17.0 has a malformed `server-sig-algs` EXT_INFO (a missing comma garbles the
algorithm list) that makes real OpenSSH clients silently abandon publickey auth right after
`PK_OK`. `scripts/patch-ssh2.mjs` (wired as `postinstall`) fixes the literal in place until
an upstream release carries the fix; the system-ssh test below guards the regression.

Gateway flags: `HERDGATE_SSH_PORT` (default 2222, `0` disables), `HERDGATE_SSH_BIND` (loopback; `0.0.0.0` for
LAN phones), `HERDGATE_SSH_KEY` (host key file). Verified against real herdr-core 0.1.21.
Anything that is not `view`/`ping` is refused **on the host** with `read-only` — the cloud cannot see payloads,
so the host is the last trusted decision point. `act` scope is denied unless `HERDGATE_ALLOW_ACT=1`.

## The PWA (the device side)

The cloud serves the PWA itself (`src/web/`, `HERDGATE_WEB_ROOT`, `HERDGATE_NO_WEB=1` to disable). A phone
opens the public hostname, pastes the account token once, sees its machines, pairs into one, and reads the
view the host publishes.

```sh
HERDGATE_ACCOUNT_TOKEN=… npm start      # → http://127.0.0.1:8787/ is the app
```

Safety properties, all asserted in `test/web.test.ts`:

- **no HTML from the wire** — every string is `textContent`; no `innerHTML`, no `document.write`;
- **one op** — the client only ever asks a host for `{op:"view"}`; the host, not the cloud, decides the rest;
- **a locked-down CSP** — `default-src 'self'`, no inline script or style, `frame-ancestors 'none'`;
- **static can't escape** — `realpath`-pinned root, dotfiles and traversal refused (including `%2e%2e`);
- **API precedence** — `/v1/*` and `/healthz` are routed before static, so no file can shadow them.

Verified live: real Herdr → publisher → cloud → **headless Chrome** signed in, saw the machine, paired
`read`, and rendered the view (7 spaces, 1 agent, 0 page errors).

Going public: [DEPLOY.md](DEPLOY.md) (cloudflared, on this machine).

## Herdr-relay lineage

herdgate borrows its *ideas* from [herdr-relay](https://github.com/Lapis0875/herdr-relay) — hello-first token
auth, one-time tickets, scope checks, opaque trees — but shares no code and no protocol. Where herdr-relay is a
Mac-local bridge over Tailscale, herdgate is the cloud in the middle: identity moves from the tailnet into the
gate itself. Herdr integration code belongs to herdgate; reference projects are not runtime dependencies.
