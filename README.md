# herdgate

**A cloud relay hub: host agents and devices meet behind one gate.**

```
host app (bom-herdr, …) ──WS outbound──▶ ┌──────────────┐ ◀──WS outbound── device (PWA/browser)
   adapter: owns UI state, policy        │    cloud     │    pairs into one room, scope read/act
   renders per-device, enforces scope    │ gate · route │
                                         └──────────────┘
                        published to the internet via cloudflared (this Mac, no open ports)
```

- **One gate, three identities** — accounts (people), rooms (hosts), devices (browsers). Hosts pair by a
  GitHub-style device flow; devices pair into a room; `act` scope needs the host's own approval.
- **Opaque payloads** — the cloud routes frames between legs and never inspects, logs or persists them.
  End-to-end encryption can be added later without changing the cloud.
- **No inbound ports** — the cloud binds loopback and is published through `cloudflared`; the cloud itself is the
  identity provider (no Cloudflare Access needed, none of its headers trusted).

## Status

v0.0.1 — a working skeleton: gateway (HTTP + 2 WS legs), pairing flows, routing, presence, rate limits, state
persistence; agent SDK with reconnect; e2e test. See [DESIGN.md](DESIGN.md) for the full model and roadmap.

## Layout

```
src/protocol/   the wire contract (envelope, agent leg, device leg)
src/cloud/      the gateway: stores, pairing, routing, HTTP/WS, CLI (main.ts)
src/agent/      HerdGateAgent SDK + AgentAdapter (what a host app implements)
test/           e2e: provision → pair read/act → frames both ways
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

Going public: [DEPLOY.md](DEPLOY.md) (cloudflared, on this machine).

## Herdr-relay lineage

herdgate borrows its *ideas* from [herdr-relay](https://github.com/Lapis0875/herdr-relay) — hello-first token
auth, one-time tickets, scope checks, opaque trees — but shares no code and no protocol. Where herdr-relay is a
Mac-local bridge over Tailscale, herdgate is the cloud in the middle: identity moves from the tailnet into the
gate itself, and the host (e.g. `bom-pi/apps/bom-herdr`) renders for devices directly.
