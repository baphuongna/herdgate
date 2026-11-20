# Herdgate ↔ Pi/Herdr: delivery evidence over a remote session

- Document-updated-at: `2026-11-20`
- Document-status: `PROTOTYPE` — [local Pi receipt experiment](../../experiments/pi-receipt/README.md) verified offline and over a loopback Gate. No new remote protocol or durable store.
- Companion docs: [skill guide](HERDR_SKILLS_GUIDE.md), [Pi extension research](HERDR_PI_EXTENSION_RESEARCH.md), [helper spec](../../specs/herdr-pi/HERDR_PI_PARITY.md).

## Why this concerns Herdgate

The skill pack lets a Pi agent use Herdr TUI panes and Pi session files as evidence: `herdr_pi.py observe`
reads the Pi JSONL session and answers whether a marked request is present and whether a response exists.
That works when the agent, the session file and the pane are on one machine.

Herdgate changes that assumption. A controller can reach a Herdr TUI through
`plugin/server/herdr-ssh.mjs` (`remote-client-bridge`, `remote-api-bridge`), or reach existing TUI panes
through the Mobile adapter. In both cases the agent must not pretend it knows more than it can prove.
Three different facts look identical from a terminal:

| Fact | What it requires | What Herdgate can currently prove |
|---|---|---|
| Herdr submitted input | `agent prompt` reports successful submission without `--wait` | The Herdr result is not a Pi acknowledgement; `--wait` matches lifecycle, not a turn. |
| Pi recorded this request | a user entry whose first line is the marker, in the expected Pi session | The helper must run on the target host (or read a synthetic local file for tests). |
| Pi produced a reply | a non-empty assistant text response associated with that marker | `observe` can find a `stopReason: stop` response, but does not prove Pi settled or the task succeeded. |

## What was verified in this repository

Local, read-only checks on Pi 1.5.2, Herdr 0.9.5, Python 3.12 (no model calls, no live pane control):

1. **Trust gates the skills.** `DefaultResourceLoader` with the same `cwd` and `agentDir`:
   `projectTrusted: false` → 0 skills; `projectTrusted: true` → exactly the six skills, 0 diagnostics.
   This applies to the project-local copy. Since Herdgate 0.9.31, the npm installer can also sync the
   six skills into the user's Pi profile, outside project trust. Neither copy enables an observer or
   starts an agent; loading an observer needs a separate opt-in.
2. **An unpinned `observe` can pick up a fork's copied response.** A synthetic conversation written with the
   real Pi `SessionManager.create()` and copied using `SessionManager.forkFrom()` kept the marker and both
   entry IDs but acquired a different session ID. Unpinned `observe` returns `response_observed` on both.
   The Herdgate copy of the helper now takes `--expect-session <id>` and rejects the fork with
   `unexpected_session_id`. Supply the ID verified before sending; taking the ID from the very snapshot
   being checked adds no protection. This is an identity comparison, not host attestation or protection
   against a file copied with the same header. See `test/herdr-pi-skills.test.ts`.
3. **Herdr itself cannot carry per-turn correlation.** `herdr agent start` takes `[-- AGENT_ARG]...`;
   `herdr agent prompt <TARGET> <TEXT> --wait` matches `idle|working|blocked|done|unknown` observed after
   submission and explicitly does not track turns. So no Herdr-side state proves "this request was answered".
4. **Loopback E2E uses the real bridge.** [The Pi receipt Gate test](../../test/pi-receipt-gate.test.ts)
   starts a separate Pi TUI with a fake provider and sends through Herdr's native SSH bridge over
   WebSocket. It verifies the exact brief (including Unicode), matching receipts before and after
   settle, reconnect without resend, wrong-marker rejection, remote Escape and reload. The fixture
   writes only test events and an input hash; no real transcript or credentials are used. No
   publisher, relay or Mobile path calls the local helper.

## Where a correct integration has to live

- **Pi extension (host side).** Only the Pi process knows the final `agent_settled`, whether the run was
  aborted, and the session file it wrote. Pi 1.5.2 emits `agent_start`, `agent_end`,
  `agent_before_settle`, `agent_settled { aborted }`, `turn_start`, `turn_end`, and `message_start/end`.
  `agent_end` may be followed by retries, compaction or queued follow-ups; `agent_settled` is the only
  final-idle signal. `ctx.sessionManager.getSessionFile()` and `getSessionId()` identify the target session.
  `message_end` extension handlers run **before** Pi appends that message; neither that hook nor `input`
  is a persisted receipt. `turn_end` runs after the assistant/tool entries are appended but may be an
  intermediate step. At `agent_settled`, inspect the active branch via `ctx.sessionManager.getBranch()`
  and match entries newer than a baseline captured before submit. The event by itself has `aborted`, not a
  request ID or proof of success. A follow-up can share that settle, and a raw `stop` reply may already
  exist when a run aborts or may be omitted from model context by a `context_edit`. Reload can keep the
  same session ID; tree navigation can change the branch and return to the original leaf. Use an
  observer epoch and a branch generation rather than comparing final IDs alone. See the
  [offline SDK probe](probes/pi-settlement.mjs) and [MVP receipt contract](HERDR_PI_EXTENSION_RESEARCH.md#lát-cắt-đầu-tiên-chỉ-quan-sát-local-và-xuất-receipt-metadata).
  Extensions run as the user; this must be opt-in per workspace.
- **Herdr/Gate transport.** Herdr moves bytes; it cannot attribute a turn. Herdgate must not synthesize a
  receipt from `ssh.closed`, from an `agent prompt` exit code, or from terminal echo — the marker appears in
  the echo before any Pi input exists.
- **Observe (read-only fallback).** `observe` remains a transcript check, even with `--expect-session`.
  Do not resolve a path reported by another host in the controller's filesystem. `--pane` talks only to
  the local Herdr session, and Herdgate's SSH command translator allows fixed bridges, not a shell,
  SFTP, or arbitrary helper execution. Do not expand that allowlist to fetch transcripts.

## Observer prototype and next slices

1. **Opt-in local-only Pi observer (prototype).** Arm one expiring intent in the idle target Pi TUI.
   The observer is scoped to that runtime and Pi session; it invalidates on tree navigation and
   journals unfinished intents as `unknown` on shutdown. Use a unique matching user entry in the
   active suffix as `received`. At `agent_settled`, recheck attribution; distinguish `replied`,
   `failed`, `canceled` and `unknown`. A reply is not task success. Use the slash commands in the
   same Pi TUI; there is no remote query API or independently verified host/Herdr terminal binding.
2. **Bounded local journal (implemented).** Finished receipts persist in a per-workspace JSONL
   journal (0600, newest few hundred entries, opaque IDs/status/reasons/entry references only — no
   prompt/answer text or transcript paths) so they survive `/reload`, session switches and Pi
   restarts. No network listener, scheduler, background agent, or publisher hook; a broken journal
   fails closed to `unknown`.
3. **Structured status channel (prototype, opt-in).** With `HERDGATE_PI_RECEIPTS=1`, the
   publisher answers `receipt.get` device frames from the local journal — no TUI, no SSH, exact
   UUID lookup only, metadata only, read scope sufficient, disabled by default — and pushes
   `receipt.push` only to devices holding a durable `receipt.watch` for that request the
   moment a receipt settles, so a controller learns "agent finished" without polling
   (settles only; intermediate states stay in-memory; unacknowledged intents replay on
   reconnect; `receipt.ack` retires them; no baseline replay). The observer itself still
   opens no socket. Verified over loopback; not yet in the PWA or the production
   publisher config. A two-host trial still needs a separate test window. Do not implement a
   remote file read or repurpose the Mobile Core adapter. Read-only scope gains only this
   deliberately published metadata, nothing else.

4. **Owned worker (prototype, opt-in).** With `HERDGATE_PI_WORKER=1`, the publisher
   admits `worker.submit` device frames (act scope only) into a local durable queue and
   answers `worker.status` (read scope, no prompt echo). A separately started
   experiments/pi-worker drains that queue through the real Pi SDK — one session per job,
   pid-locked, drain-then-exit — and journals receipts into the same per-workspace journal,
   so `receipt.get` serves them too. Admission is idempotent (duplicate ids never re-run);
   a worker killed mid-run fails closed to `unknown/worker_restarted` for that job while
   later queued jobs still run. The worker is not a scheduler, never resends, and this
   prototype runs a fixture provider only (no network, no tools). Verified over loopback;
   multi-workspace routing, real providers, push notifications and `pi-durable` evaluation
   remain future slices. Windows untested.

5. **Scheduler, heartbeat, API (prototype, opt-in).** `experiments/pi-worker/scheduler.mjs`
   enqueues deterministic per-bucket runs (restart-safe, never resends) and writes the
   heartbeat served by the new read-only `worker.health` device op (queue depth + last
   heartbeat; missing heartbeat reports null). `experiments/pi-worker/mcp.mjs` exposes
   submit/status/receipt/health as MCP tools over stdio, connecting out to the Gate with
   device credentials — no listener. All still gated behind HERDGATE_PI_WORKER=1 on the
   host and verified over loopback. PWA act UI, real providers and multi-workspace
   routing remain future slices; Windows untested.

### Acceptance criteria

- Helper regression (implemented): a fork with a different session ID is rejected when pinned to the
  original, and a pinned result does not include answer text by default. Synthetic tool output and
  ambiguous branches are not mistaken for a reply.
- Prototype offline tests: neither `agent_end` without settle nor an aborted settle can produce
  `replied`. An unfinished intent becomes `unknown/runtime_changed` on reload; finished receipts
  reload from the journal with the same entry IDs, bounded and scoped per workspace. Manual input,
  duplicate markers, branch navigation back to the same leaf, and second-worker events do not
  complete the request. SDK and local TUI checks use a fake provider.
- Loopback remote TUI (verified): the client can disconnect while Pi has received the request but has
  not settled. Once Pi settles, the same Pi process returns the matching receipt after reattach with
  no second provider call; the receipt also survives `/reload` and a full Pi process restart. This
  does not establish behavior across a WAN or after host/publisher failure.
- Live (separate test window): one advisor run through the existing TUI bridge yields a receipt for that
  request only; a second agent finishing first does not satisfy it; loss of observation mid-run leaves
  an unknown outcome until reconciled and never triggers an automatic resend.
- Scope: no change to pairing, room tokens, SSH keys or device scope; read-only devices gain no new channel.

## Do not claim

- A Herdr `done`/`idle` status is not a completion receipt for a specific request.
- `request_not_observed` does not prove the prompt was not sent.
- `response_observed` does not prove the task succeeded, only that an assistant message with `stopReason:
  stop` exists in the marker's branch.
- The Mobile TUI adapter implements a subset of Core for pane control, not a Pi turn API.

## Reproduce and check sources

- `node --test test/herdr-pi-skills.test.ts` (Python 3.11+). Only synthetic snapshots and the shipped profile catalog.
- Pi 1.5.2: installed docs `skills.md`, `extensions.md`, `rpc.md`, `session-format.md`; SDK `DefaultResourceLoader`,
  `SettingsManager.inMemory`, `SessionManager.create`, `SessionManager.forkFrom`; handler order in
  `dist/core/agent-session.js` (`_handleAgentEvent` and `_emitAgentSettled`).
- Herdr 0.9.5: `herdr agent prompt --help`, `herdr agent start --help` (do not attach for help); Herdgate
  `plugin/server/herdr-ssh.mjs`, `plugin/server/herdr-ssh-win.mjs`, `plugin/server/mobile-tui-core.mjs`,
  and `test/herdr-tui-e2e.test.ts`.
