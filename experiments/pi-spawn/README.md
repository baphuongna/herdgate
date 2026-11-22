# pi-spawn — the subagent lifecycle

One-id children of a Pi controller, in visible Herdr panes, with receipts, herdr-event wakes
and a bounded registry that survives reboots.

```
task.mjs start ─▶ spawn (own tab) ─▶ arm (ack-file handshake) ─▶ prompt (marker line 1)
      │                                                                    │
      │                                     herdr pane events ─▶ wake-event.mjs ─▶ 🔔 frame
      │                                     (agent_status_changed / exited / closed)
      ▼
 close (3-layer retire) ─▶ record kept ─▶ restore/revive reopen the SAME session id
```

## Commands

```sh
# The standard path — one command, marker-safe, failure reported per step:
node experiments/pi-spawn/task.mjs start <name> <taskfile> [--cwd DIR] [--tab] [--body]
node experiments/pi-spawn/task.mjs continue <name> <text|file>   # envelope-wrapped re-prompt
node experiments/pi-spawn/task.mjs status [name]                 # recent-first, receipt-aware
node experiments/pi-spawn/task.mjs close <name>

# The raw verbs (task.mjs delegates where it can):
node experiments/pi-spawn/spawn.mjs spawn <name> [--cwd DIR] [--tab] [-- parent-session ID]
node experiments/pi-spawn/spawn.mjs arm   <name-or-id> [--body]  # /herdgate-arm + ack poll
node experiments/pi-spawn/spawn.mjs close <name-or-id>           # preflight + generation check
node experiments/pi-spawn/spawn.mjs restore <name-or-id>         # reopen the exact session
node experiments/pi-spawn/spawn.mjs revive [--name N] [--dry-run]# post-reboot bulk restore
node experiments/pi-spawn/spawn.mjs list

# The tree, and the governed pipeline:
node experiments/pi-spawn/dag.mjs [--json]                       # spawn tree + receipt status
node experiments/pi-spawn/pipeline.mjs run <task.md> [--fake]    # worktree→agent→test→retry→reviewer
node experiments/pi-spawn/pipeline.mjs clean <id> --approved
```

## Semantics worth knowing

- **Identity**: `spawn:<uuid>` is the citizen; pane/session are carriers (`entwurf`'s rule).
  Duplicate names resolve to the LIVE record first (an orphan half-spawn can't shadow a child).
- **Arm handshake**: `arm` is only real once the child's observer writes `<id>.armed.json`;
  arm polls it (15s) instead of sleeping — the prompt can never precede the baseline.
- **Marker**: `[herdr-request:<id>]` owns the start of the prompt; a newline **or one space**
  may follow. `task.mjs` builds it — don't hand-assemble.
- **Close is a 3-layer retire**: explicit target → working/blocked preflight refusal → generation
  check (the pane's current session must still match the record; a reused pane is never closed).
- **Wake** comes from herdr's own events (see `plugin/server/wake-event.mjs`), not from the
  child's cooperation: settle frames carry `via=herdr-event`, `gen=<revision>`, title/tokens
  when the receipt journal has them. Death without a settle fires one `DIED` frame
  (`closedBy: parent` closes are silent).
- **Revive**: after a reboot, records that are not closed, not died, have no live pane and still
  have their transcript are reopened on the exact session — never "the latest jsonl".
- **Registry discipline** (`registry.mjs`): damaged files throw WITH the file name (never an
  empty read), writes are O_EXCL temp + rename with a stable sort (byte-stable output),
  and a state dir writable by group/other is refused outright.

## Worktree rule (conflict avoidance)

Direct on the open branch only when exactly one writer per file set (controller alone, or
subagents with fully disjoint whitelists). A dedicated `herdr worktree create` is mandatory for
parallel agents touching the same files, long tasks that may collide with the human, or
experiments. Whitelist first, worktree second; merging is the controller's job on the main
checkout after every child settles. `pipeline.mjs` bootstraps its own worktrees (env copy +
deps install) and never merges by itself.

## Tests

`test/pi-spawn.test.ts` (registry), `test/pi-task.test.ts` (one-command flow, marker shape,
failure reporting, argv-recording seam), `test/pi-revive.test.ts`, `test/pi-state-hard.test.ts`
(damaged/ownership/byte-stable/generation), `test/pi-pipeline.test.ts` (fake-provider e2e).
