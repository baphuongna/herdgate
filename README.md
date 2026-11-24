# herdgate

**A cloud relay hub: host agents and devices meet behind one gate.**

```
Herdr (herdr.dev) ──local── herdgate agent ──WSS──▶ cloud gate ◀──WSS── browser/PWA
                             owns host policy       Cloudflare Tunnel

Both remote connections are outbound; the cloud gateway binds loopback.
```

- **One gate, three identities** — accounts (people), rooms (hosts), devices (browsers). Hosts pair by a
  GitHub-style device flow; devices pair into a room; `act` scope needs the host's own approval.
- **Separate payload and SSH channels** — the relay routes application frames without interpreting their
  contents, and the payload channel supports Noise_XX between device and host. SSH terminates at the Gate;
  it is not client-to-publisher Noise E2E.
- **No inbound ports on publishers** — they dial out over WSS. Use a public HTTPS Gate for desktop TUI
  connections. For Herdr Mobile on cellular, a [tokenless TCP edge](DEPLOY.md#deploy-the-tokenless-tcp-edge-on-a-vps)
  can forward SSH to the Gate without VPN, without storing room or owner credentials on the VPS.

## Status

| Client | What it connects to | What it can do |
|---|---|---|
| Browser/PWA | Herdgate publisher over HTTPS/WSS | View Herdr metadata and read pane snapshots; no terminal input |
| Herdr TUI | An existing Herdr TUI session over SSH/WSS | Connect and control it with an approved `act` device and its own SSH key |
| Herdr Mobile (Core) | A real `herdr-core` runtime over SSH | Core terminals and the Core API, subject to the device scope |
| Herdr Mobile (TUI adapter) | Existing Herdr TUI panes over SSH | Read-only snapshots, or opt-in Send, keys, Interrupt and native attach/resize for one approved `act` device; not the full Core API |

The Gateway also supports bounded room-stream resume and opt-in VAPID push wake (off by default). Pairing, publisher updates and
Mobile authorization are separate: changing the publisher release does not move a room or grant a new scope.

## Layout

```
src/protocol/   the wire contract (envelope, agent leg, device leg)
src/cloud/      the gateway: stores, pairing, routing, HTTP/WS, CLI (main.ts)
src/agent/      HerdGateAgent SDK + AgentAdapter (what a host app implements)
src/host/       standalone host CLI (no Herdr needed) + the `herdr api snapshot` adapter
plugin/         the Herdr TUI plugin: herdr-plugin.toml + server/ (what `herdr plugin link` loads)
                — op table, wake-event hooks, receipts/observers/attachments modules
experiments/    host-local CLIs + SDK pieces the controller drives by hand:
                pi-spawn (task.mjs lifecycle, registry, pipeline, dag),
                pi-receipt (observer that runs INSIDE children, query/search/usage/gc),
                pi-worker (run-jobs, scheduler, MCP, durable probes)
docs/research/  two-tier deep research on 12 herdr plugins (2,426 lines, file:line-sourced)
app-mod/        the Herdr app mod: mods/herdgate/ (what `herdr-app check` validates)
src/web/        the PWA a device opens — served by the cloud, same origin as the WS legs
test/           57 files / 275 tests: relay e2e, plugin ops over the device channel,
                wake-event semantics, spawn lifecycle, sysmon/port fixtures, web assets
```

## Self-hosted release

Herdgate ships as one versioned release set. Build it from the checkout with
`npm ci --ignore-scripts` and `npm run build:release`. The output under `dist/<version>/`
contains a clean **Cloud** archive (Gate, PWA, optional Mobile TCP edge), a **host** ZIP,
the **npm** package (CLI, publisher, plugin/mod and Pi skills), and `SHA256SUMS`.
See [Deploying a clean Gate](DEPLOY.md#deploying-a-clean-gate) for Docker Compose
or systemd. No credentials, keys, or live state are copied into the Cloud archive.

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

## The subagent fleet (receipts · wake · observers)

Beyond relaying, the Herdr plugin runs a full **subagent observability and lifecycle stack**.
Everything below is local-first (append-only JSONL + registry under XDG state dirs), fail-closed,
and testable — 275 tests cover it.

### Identity and evidence — receipts
Every spawned child gets a **one-id** (`spawn:<uuid>`) recorded in a bounded registry; panes and
session files are carriers, never the address. The arm→prompt handshake acknowledges via an ack
file (no sleep-and-hope). Each marked request becomes a **receipt**: status/reason, usage tokens/$,
`turns`/`lastActivityAt`, a leak-safe title, delivery state (`delivered|stalled|unverified`), a
failure **phase** (`failed_before_dispatch` vs post-dispatch), and an optional gated body archive.
Search is BM25 (diacritic-folded) over bodies+transcripts; devices see publicReceipt shapes only.
A journal GC (dry-run default) never deletes `unknown` — unresolved evidence stays.

### Wake — herdr is the observer
Settles no longer depend on child cooperation: the plugin manifest hooks herdr's own events
(`pane.agent_status_changed`, `pane.exited`, `pane.closed`) into `server/wake-event.mjs`, a
short-lived process per event. A child's closed turn (or death without a settle) becomes a
`🔔 WAKE` frame typed into the parent pane — after revision-stability quiet-wait, deduped by
generation, guarded against event bursts (flock) and corpse echoes (heartbeats), with title/tokens
enriched from the receipt journal when present. Receipts are evidence; **herdr is the trigger**.

### Lifecycle — one command per verb
```sh
node experiments/pi-spawn/task.mjs start <name> <taskfile> --tab    # spawn+arm+prompt, marker-safe
node experiments/pi-spawn/task.mjs continue <name> <text|file>      # self-describing re-prompt
node experiments/pi-spawn/task.mjs status [name]                    # recent-first, receipt-aware
node experiments/pi-spawn/spawn.mjs close <id>                      # 3-layer retire + generation check
node experiments/pi-spawn/spawn.mjs revive [--dry-run]             # after a reboot: exact sessions back
node experiments/pi-spawn/pipeline.mjs run <task.md> --fake        # worktree→agent→test→retry→reviewer
```
See `.agents/skills/herdr/SKILL.md` for the operating protocol (in-turn wake handling, the
no-accumulation close rule, worktree-vs-main-branch whitelists).

### Device-channel ops (the PWA's vocabulary)
`view` · `receipt.query/search/body/ack` · `receipt.enrich` (model/context/usage from the transcript)
· `usage.rollup` · `diff.get` (hardened git: hooks off, env scrubbed, `~ ^` refs)
· `sysmon.snapshot` (per-agent CPU/RAM from /proc, cutime-aware) · `ports.list` (listeners attributed
by process ancestry; unattributed stay honest) · `attachment.upload/list` (magic-byte photos from
the phone to the agent's own disk, 0700/0600, uuid names)
· `loop.status` (the dev-loop plugin's state.json + capped log tail, read-only; missing state answers `unknown` honestly) — plus the SSH/mobile leg below.

### Mobile transport
One persistent shell with marker framing replaces exec-per-command; phone keystrokes enter a
bounded, coalescing, in-order-acked queue that resyncs instead of replaying; file polls are
checksum-stamped (`unchanged` costs one word).

### Latency budget (measured 22/11)

Interactive typing (mobile TUI, remote herdr attach) rides the SSH bridge **direct**
to the host — no CDN hop, feels local. The control/PWA leg goes through the tunnel
edge (~130ms RTT hairpin from the same LAN; a phone on 4G sees similar). To keep
that leg smooth the publisher now:

- pushes view snapshots every `HERDGATE_PUBLISH_MS` (default 30s; the home unit sets
  5s — a settle is visible on the phone within seconds, not half a minute);
- pings the cloud every `HERDGATE_KEEPALIVE_MS` (default 20s) and redials after three
  silent intervals — a path that died without a reset used to leave the socket "open"
  for the 15–30 minutes TCP keeps retransmitting, the room offline at the gate throughout;
- replays the last snapshot for a `view` op inside `HERDGATE_SNAPSHOT_FRESH_MS`
  (default 2s) instead of spawning `herdr api snapshot` again — a view op costs ~0
  server-side work when the cache is warm;
- coalesces concurrent snapshot demands into one spawn (single-flight), and a cached
  view no longer resets the change-sig (so it cannot re-wake away phones for nothing).

## The SSH leg (the Herdr phone app)

The phone app adds machines over SSH. Herdgate terminates SSH at the Gate; use the Gate's reachable SSH
address or the TCP edge's address. Each entry uses the device ID and key for that room. A Core entry lands
on the host's real `herdr-core`; the opt-in TUI adapter described below lands on existing TUI panes instead:

```sh
ssh -p 2222 d_xxxxxxxx@your-gate        # password = the device key shown once at pair time
# then the phone speaks the hc API: hello, terminal.list, terminal.read, events.subscribe…
```

- Auth is **per device** (id + its one-time key), never the account token; wrong keys strike the IP out.
- **Public keys too**: `hc machine add` uses the system `ssh`, which prefers keys/agent and answers no
  prompts without a terminal. Register the adding machine's `~/.ssh/id_ed25519.pub` in the PWA (SSH →
  *Public keys*, or `POST /v1/device/sshkey`) and the add is passwordless — Ed25519/RSA/ECDSA, signatures
  verified per RFC 4252 §7.
- For real Core, the host rejects mutating calls from `read` devices and downgrades their framed hello.
  An approved `act` device gets byte-transparent Core RPC. The separate TUI adapter enforces its own
  read-only and interactive allowlists.
- Herdgate only starts supported Core exec commands or fixed Herdr bridge commands. It does not offer
  a generic SSH shell, SFTP or SSH port forwarding.
- Real Core mode requires `herdr-core` (`hc`); the TUI adapter does not.

**Note:** ssh2 1.17.0 has a malformed `server-sig-algs` EXT_INFO (a missing comma garbles the
algorithm list) that makes real OpenSSH clients silently abandon publickey auth right after
`PK_OK`. `scripts/patch-ssh2.mjs` (wired as `postinstall`) fixes the literal in place until
an upstream release carries the fix; the system-ssh test below guards the regression.

Gateway flags: `HERDGATE_SSH_PORT` (default 2222, `0` disables), `HERDGATE_SSH_BIND` (loopback; `0.0.0.0` for
LAN phones), `HERDGATE_SSH_KEY` (host key file). Set `HERDGATE_SSH_PUBLIC_PORT` if an external TCP edge
advertises a different port. Verified against real herdr-core 0.1.21.
Anything that is not `view`/`ping` is refused **on the host** with `read-only` — the cloud cannot see payloads,
so the host is the last trusted decision point. `act` scope is denied unless `HERDGATE_ALLOW_ACT=1`.

## Herdr TUI → an existing Herdr session

On the controlling machine, `herdgate connect` does the whole client side in one
command: device pairing (read or act), one SSH key per cloud, and the matching
`~/.ssh/config` blocks. The owner token is asked once on a hidden prompt and is
never stored; afterwards only per-device SSH keys remain on that machine.

```sh
herdgate connect --cloud <name> --room home --scope act
```

The manual equivalent, kept for reference and for non-CLI clients:

This is separate from `hc machine add` and the PWA. On the client use the official
[Herdr v0.9.5 release](https://github.com/herdrdev/herdr/releases/tag/v0.9.5), including the native Windows ZIP if applicable. On the host run the matching Herdr server and the updated Herdgate publisher. The publisher exposes one session (`default`, or `HERDGATE_HERDR_SESSION` in its environment/config); the SSH device must have **act** scope and its own registered SSH key. `act` can type into panes and control Herdr as the host user.

Add an alias to the user's `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows). Use your actual gate, device ID, key and tunnel-script path; example for Windows:

```sshconfig
Host herdgate-home
    HostName herdgate-home
    User d_xxxxxxxx
    HostKeyAlias herdgate
    IdentityFile ~/.ssh/herdgate
    IdentitiesOnly yes
    ProxyCommand node C:\Users\you\.config\herdr-app\herdgate\bin\herdgate-via.mjs --tunnel --gate https://gate.example.org
    ServerAliveInterval 15
```

Use the private key matching the public key registered to the device. On Windows OpenSSH 8.6,
use an unquoted, space-free path to the tunnel script as shown above.
`HostKeyAlias herdgate` reuses the pin from `herdgate-via` **for the same gate**.
For a new pin, compare the fingerprint against the one provided by the gate owner
before accepting it. Then, from a normal terminal, not from inside another Herdr pane:

```sh
ssh herdgate-home exit
herdr --remote herdgate-home
```

Or add the machine to the local TUI sidebar:

```sh
herdr machine add herdgate-home --label home --remote-session default
herdr
```

Use the publisher's configured session for `--remote-session` if not `default`.
Herdgate does not install, update or stop Herdr remotely. Upgrade the host locally
if its running server is incompatible. SSH terminates at the gate; this is not
client-to-publisher Noise E2E. No third-party relay or inbound client port is needed.

### Manage a paired publisher from one CLI

Install the command once (Node 22+). On Linux, use `npm install -g @bom0792/herdgate`.
On Windows, use the npm bootstrap instead; it installs the persistent command
without requiring admin rights, a separate global npm install, or a running publisher:

```powershell
npx --yes @bom0792/herdgate@latest install
```

Open a new PowerShell after installation. In a shell with the old PATH, or if
User PATH registration is blocked, call
`& "$env:LOCALAPPDATA\Herdgate\cli\bin\herdgate.cmd"` with the same arguments.
Use `install --no-path` to create only that shim, without modifying User PATH.
Use your own cloud URL; there is no built-in Gate address.

```sh
herdgate cloud add work https://gate.example.com
herdgate cloud list
herdgate pair --cloud work
herdgate setup
herdgate status
herdgate update
```

Skip `pair` on already-paired machines. Adding a cloud does not route an
existing pairing or its room token to that cloud. Pairing still requires
the cloud owner to approve the code. `setup`, `start`, `stop`, `status` and
`update` select the local Windows or Linux publisher implementation.
When upgrading an existing installation, run `herdgate migrate` once.
It keeps the configured cloud, pairing and device keys. On Windows, if an
older CLI did not save its publisher mode, supply the existing mode once:
`herdgate migrate --mobile-act d_device`, `--mobile-read d_device`,
`--hc <path>`, or `--plain` if Mobile was off. Do not change scope during
migration. On Linux it adopts the known legacy Herdgate service, waits for
a Gate hello from the new invocation, and restores the previous service
file on failure. It will not adopt an unrelated custom unit.
Migration or update may briefly disconnect remote clients, but never
restarts Herdr. The main publisher commands do not merge standalone Mobile
rooms or upgrade the VPS.

### Windows as a TUI host

Use this only where remote control is approved by the machine's owner/IT.
With Node 22+ on Windows and an existing Gate pairing, install and start the
TUI publisher (add the relevant Mobile flag if enabled):

```powershell
npx --yes @bom0792/herdgate@latest setup --mobile-act d_device
npx --yes @bom0792/herdgate@latest status
```

Omit `--mobile-act d_device` for a new TUI-only setup. Since `0.9.29`, Windows
`setup` and `migrate` from npm also install the durable `herdgate` command on
first success, even when invoked from `npx`. Use `--no-path` on the first
setup or migration if you do not want the User PATH entry. The first setup or
migration from a manual install needs the desired mode once; it is saved
locally only after the publisher connects. For subsequent updates:

```powershell
herdgate update
```

The update validates the new release before touching the old publisher. It
preserves the device ID and mode, restarts only the publisher if needed, and
tries to restore the old release if the new worker cannot connect. Pairing
and SSH keys are not rewritten. Before opening a new shell, or if Windows policy
blocks User PATH registration, use the full path to the Node-pinned shim:

```powershell
& "$env:LOCALAPPDATA\Herdgate\cli\bin\herdgate.cmd" update
```

Use `install-tui` for install without starting.

#### Windows: `npx` resolves the wrong Node

Check the runtime using its full path (adjust it if installed elsewhere):

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
& $node --version
& $node -p 'typeof(WebSocket)'
```

Expect Node 22+ and `function`. Starting with `0.9.28`, the main Windows CLI can
relaunch publisher-management commands using Node under `Program Files` if npm
started it with an older Node. It does not change `PATH` or override options
that disable WebSocket. If the fallback cannot find your installation, bypass the
`npm` and `npx` shims entirely. Example for an existing Mobile Act publisher:

```powershell
$npm = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
$dir = Join-Path $env:TEMP ('herdgate-' + [guid]::NewGuid())
& $node $npm install --prefix $dir --no-save --ignore-scripts --no-audit --no-fund @bom0792/herdgate@0.9.29
if ($LASTEXITCODE -ne 0) { throw 'Herdgate installation failed' }
& $node "$dir\node_modules\@bom0792\herdgate\bin\herdgate.mjs" migrate --mobile-act d_device
```

Replace `d_device` with the existing approved device ID, or use your actual
saved/legacy mode. Do not stop the publisher first. The **migration's own**
`"state":"connected"` output means it finished and saved the mode; `status`
can still report the old publisher after a failed migration. Verify both TUI
and Mobile before cleaning up the temporary npm directory.

The ZIP remains an alternative: extract it and run `& $node .\windows\install-cli.mjs`.

The installer stores each build under `%LOCALAPPDATA%\Herdgate\cli\releases`.
The directory junction `current` selects the build used by the stable
`bin\herdgate-tui.cmd` shim. Rerun `npx --yes @bom0792/herdgate@latest install-tui`
to switch builds. The `tui` subcommand forwards to the installed build; use
`tui versions` and `tui use <release-id>` to list/select existing builds.
The legacy `install-tui` and ZIP installer do not change PATH. The npm
`install` and first npm `setup`/`migrate` can register the directory in User PATH.
The main command is stored independently of the publisher selection: rolling
back the publisher does not remove `herdgate` or tie it to the npm cache.

After pairing the laptop and starting its default session with the official
Herdr Windows 0.9.5 package, run `herdgate-tui start <path-to-herdr.exe>`.
You can omit the path if the exe is in `%LOCALAPPDATA%\HerdrPilot\v0.9.5`.
When `herdgate-tui status` shows `connected`, you can close PowerShell.
`herdgate-tui stop` stops only the publisher. No login persistence, no inbound
port, no Windows SSH server. The publisher reuses the existing laptop pairing.
The controlling machine still needs its own approved `act` device and SSH key.
Add the saved machine with `herdr machine add <alias> --label laptop --remote-session default`.
The default publisher does not expose `hc`. If remote control is approved, opt
in to Herdr Mobile support with the installed Core executable:

```powershell
$hc = (Get-Command herdr-core.exe -ErrorAction Stop).Source
& $hc server status --json
herdgate setup --hc "$hc"
```

If Core is not running, start it locally with `& $hc server start`. The `--hc`
flag keeps the TUI bridge enabled and adds Core access for `act` devices only.
The publisher restart interrupts remote connections, not the local TUI server.
In `--hc` mode, Herdr Mobile sees Core terminals, not TUI panes.
To expose TUI panes directly instead, use `herdgate setup --mobile-read d_device`
with the ID of a paired `read` device in this laptop's room. This opt-in mode
serves only that device with a read-only Core protocol adapter, needs no `hc`
binary, and leaves the normal TUI bridge and its existing `act` devices intact.
Opening an individual pane in Herdr Mobile shows a periodically refreshed
text snapshot of its visible screen. The adapter does not forward keystrokes,
resize the pane, or reproduce its full ANSI rendering or scrollback.

For a phone explicitly approved to control this laptop, use
`herdgate setup --mobile-act d_device` instead. The device must already have `act`
scope, and the setting only enables the Core adapter for that device ID.
Non-observe attach uses Herdr's native terminal session to forward ANSI output,
keys and viewport resize. Resize changes the pane's real terminal size while
the controller is attached. Send (paste + Enter), named keys and Interrupt are
also mapped to TUI actions. The adapter does not implement Core-only features
such as templates, task lifecycle or file operations. Enable this mode only
where executing commands in existing panes from the phone is authorized.

### Linux as a TUI host

Run these commands as the user who owns the running Herdr server. For a newly
paired host use `herdgate setup`. For the previous Herdgate home service, use
`herdgate migrate` instead. Both install a durable systemd user service and
reuse the pairing and TUI socket. See the [migration checklist](DEPLOY.md#migrate-the-linux-tui-publisher).

### Linux: standalone Mobile TUI publishers

On Linux, use `npm run mobile-tui` (or `node src/host/mobile-tui.ts`) as the
user running Herdr, with
`HERDGATE_URL`, a dedicated `HERDGATE_ROOM_TOKEN`, and `HERDR_BIN_PATH` set.
Set `HERDR_SOCKET_PATH` if needed to select the existing TUI session. Without
`HERDGATE_MOBILE_TUI_ACT_DEVICE`, this publisher is read-only. For interactive
mode, use a separate room and set that variable to the exact existing `act`
device ID. The publisher never auto-approves new `act` pairings.

### Mobile TUI latency (0.9.30+)

Interactive Mobile TUI sends the first output after an idle period immediately,
while continuing to batch bursts. This applies to the Mobile TUI adapter on
Windows and Linux, not to real Core or read-only snapshot polling.

For a standalone Linux Mobile publisher on the **same machine** as the Gate,
opt into `HERDGATE_AGENT_LOOPBACK_PORT` to avoid routing that leg through the
public Gate. Keep the canonical HTTPS `HERDGATE_URL`; the room token and
public Host check still apply. See [deployment and rollback](DEPLOY.md#when-the-publisher-and-gateway-run-on-the-same-machine).
Do not set loopback on a laptop or other host with a remote Gate.

On Windows, `herdgate update` deploys the new adapter and preserves the
existing Mobile mode and device. On Linux, update and restart standalone
Mobile services separately; `herdgate update` updates only the main TUI
publisher. Neither operation updates the Gate or the VPS edge.

## The PWA (the device side)

The cloud serves the PWA itself (`src/web/`, `HERDGATE_WEB_ROOT`, `HERDGATE_NO_WEB=1` to disable). A phone
opens the public hostname, pastes the account token once, sees its machines, pairs into one, and reads the
view the host publishes.

```sh
HERDGATE_ACCOUNT_TOKEN=… npm start      # → http://127.0.0.1:8787/ is the app
```

PWA safeguards (see `test/web.test.ts` and `test/web-pairing.test.ts`):

- **no HTML from the wire** — incoming strings are shown as text, not injected as HTML;
- **read-only publisher operations** — the PWA can request `view`, `term.list` and `term.read`, but cannot type into a pane;
- **a locked-down CSP** — `default-src 'self'`, no inline script or style, `frame-ancestors 'none'`;
- **static can't escape** — `realpath`-pinned root, dotfiles and traversal refused (including `%2e%2e`);
- **API precedence** — `/v1/*` and `/healthz` are routed before static, so no file can shadow them.

Verified live: real Herdr → publisher → cloud → **headless Chrome** signed in, saw the machine, paired
`read`, and rendered the view (7 spaces, 1 agent, 0 page errors).

Going public: [DEPLOY.md](DEPLOY.md) (cloudflared, on this machine).

## Herdr skills for Pi

The npm package bundles six skills: `herdr`, `herdr-advisor`, `herdr-committee`,
`herdr-handoff`, `herdr-help` and `herdr-plugin` (sources: [`.agents/skills/`](.agents/skills)).
Starting with `0.9.31`, a global npm install with scripts enabled, the Windows
`herdgate install` bootstrap, and successful npm publisher `setup`, `migrate` or
`update` sync them for the current user. A local npm dependency install, a bare
`npx` fetch and a standalone host ZIP do not install user skills.

Pi discovers the managed pack in `~/.pi/agent/skills/herdgate`, or
`$PI_CODING_AGENT_DIR/skills/herdgate` for a custom agent directory. Use `/reload`
in an open Pi session or open Pi again; try `/skill:herdr-help`. Herdgate does not
install Pi, change its settings/trust, install an extension, or start an agent.
Python 3.11+ is optional for the profile and JSONL observation helper.

`herdgate pi-skills` syncs just the pack without touching the publisher. Set
`HERDGATE_NO_PI_SKILLS=1` before installation or update to skip syncing. The
installer leaves other skill folders and locally edited packs alone. Existing
same-name skills can cause Pi collision diagnostics; keep one copy active.
To remove only the managed copy, back up or remove the `skills/herdgate` folder
in your Pi profile; skip sync on later installs if you want it to stay removed.
The source checkout still provides project skills under the normal Pi trust rules.

For users working in this checkout: [skill guide](docs/herdr-skills/HERDR_SKILLS_GUIDE.md)
and [Herdgate research notes](docs/herdr-skills/HERDGATE_PI_OBSERVATION.md).

## Herdr-relay lineage

herdgate borrows its *ideas* from [herdr-relay](https://github.com/Lapis0875/herdr-relay) — hello-first token
auth, one-time tickets, scope checks, opaque trees — but shares no code and no protocol. Where herdr-relay is a
Mac-local bridge over Tailscale, herdgate is the cloud in the middle: identity moves from the tailnet into the
gate itself. Herdr integration code belongs to herdgate; reference projects are not runtime dependencies.
