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
- **No inbound ports** — the cloud binds loopback and is published through `cloudflared`; the cloud itself is the
  identity provider (no Cloudflare Access needed, none of its headers trusted).

## Status

v0.2.0 — gateway (HTTP + 2 WS legs), pairing flows, routing, presence, rate limits, state persistence; agent
SDK with reconnect; **a real Herdr plugin** (`plugin/`) using Herdr's official extension surface; 11 tests.

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
