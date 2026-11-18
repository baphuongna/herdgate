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

v0.1.0 — gateway (HTTP + 2 WS legs), pairing flows, routing, presence, rate limits, state persistence; agent
SDK with reconnect; **host adapter for official [Herdr](https://herdr.dev)**; 6 tests.

The Herdr adapter is read-only: it runs `herdr api snapshot` and serves workspaces/tabs/panes/agents/status to
paired devices. It never reads a pane, sends a keystroke, or prompts an agent. Terminal content is a later
slice, by design. No third-party plugin or relay is a dependency — only Herdr's own CLI.

## Layout

```
src/protocol/   the wire contract (envelope, agent leg, device leg)
src/cloud/      the gateway: stores, pairing, routing, HTTP/WS, CLI (main.ts)
src/agent/      HerdGateAgent SDK + AgentAdapter (what a host app implements)
src/host/       the Herdr host: adapter over `herdr api snapshot` + CLI (main.ts)
test/           e2e relay, plus the Herdr adapter against upstream snapshot shapes
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

**Run the host** (on the machine where Herdr runs — pair once, then keep it running):

```sh
HERDGATE_URL=https://herd.example.com HERDGATE_PROVISION=1 npm run host
#   → prints HERDGATE_ROOM_TOKEN=…   store it, then:
HERDGATE_URL=https://herd.example.com HERDGATE_ROOM_TOKEN=… npm run host
```

Devices pair into the room and ask for `{op:"view"}`; the host answers with the current Herdr metadata.
Anything that is not `view`/`ping` is refused **on the host** with `read-only` — the cloud cannot see payloads,
so the host is the last trusted decision point. `act` scope is denied unless `HERDGATE_ALLOW_ACT=1`.

Going public: [DEPLOY.md](DEPLOY.md) (cloudflared, on this machine).

## Herdr-relay lineage

herdgate borrows its *ideas* from [herdr-relay](https://github.com/Lapis0875/herdr-relay) — hello-first token
auth, one-time tickets, scope checks, opaque trees — but shares no code and no protocol. Where herdr-relay is a
Mac-local bridge over Tailscale, herdgate is the cloud in the middle: identity moves from the tailnet into the
gate itself. Herdr integration code belongs to herdgate; reference projects are not runtime dependencies.
