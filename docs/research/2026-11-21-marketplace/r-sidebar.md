# Nghiên cứu: alexarthurs/herdr-sidebar → herdgate

> Task file /tmp/task-r-sidebar.md trống 0 byte; repo suy ra từ series task anh em + cross-ref
> trong src-ram (`herdr-sidebar's ipc.rs`, tokens `herdr-sidebar-explorer/-git`). Repo Rust, MIT,
> 553★, min herdr 0.8. VS Code-style sidebar: Explorer + Search + Source Control trong 1 pane
> ratatui, activity-bar switch in-process, AI commit draft, preview/editor, takeover mode.

## Kiến trúc cốt lõi (file-level)

- `herdr-plugin.toml` — manifest duy nhất: 2 `[[panes]]` (sidebar + source-control, placement
  `split`), ~20 `[[actions]]` (open/show-*/quick-open/redeploy/update — mỗi cái nhân đôi bản
  `-windows` + gate `platforms`), 9 cặp `[[events]] on=pane.focused|tab.created|tab.focused|
  workspace.created|workspace.focused|pane.moved → --ensure` và `pane.exited|pane.closed → --reap`.
- `src/main.rs` — dispatch argv: `--ensure|--reap|--toggle|--show-*/--quick-open` (lifecycle),
  còn lại `--launch-decision|--focused-pane|--pane-has-token...` là helper stdin→stdout **test
  được không cần TUI**.
- `src/ipc.rs` — client socket herdr tối tiểu: newline-JSON 1 req/resp mỗi connection
  (`{"id","method","params"}`), timeout 5s, cap response 4MB; Unix = UDS read/write timeout
  native; Windows = named pipe qua `File` + thread-timeout (không spawn CLI → không flash cửa
  sổ console trong hook chain).
- `src/ensure.rs` — launcher `--ensure/--reap`: `LaunchLock` (flock `try_lock` cho focus hook,
  `lock` blocking cho action rời rạc), RefreshPlan/RefreshReport (refresh build không giết pane
  giữ draft), reap tab chỉ còn sidebar.
- `src/launch.rs` — toán panes thuần: `launch_decision` (json → OPEN/FOCUS/REPLACE),
  `HEARTBEAT_STALE_SECS=20`, `open_plan` (đock theo cột → ratio), `lonely_sidebar_tabs`,
  `FollowPoller` single-flight theo cwd sibling.
- `src/state.rs` — `enum View{Explorer,SourceControl}` (plugin_id/entrypoint/other), `spawn_env`
  (forward state dir + PATH), settings `state.json` + migrate legacy.
- `src/git.rs` — git plumbing: `discover_all` (multi-repo), `status --porcelain -z --branch
  --renames --untracked-files=all`, mọi read chạy `GIT_OPTIONAL_LOCKS=0` + timeout (kill cả cây
  child, Job Object trên Windows).
- `src/explorer_app.rs` / `src/scm_app.rs` — TUI 2 view; SCM có background status worker
  single-flight (`STATUS_REFRESH_MIN` 1.5s, gate `periodic_due`), `HERDR_SIDEBAR_BACKGROUND_REFRESH=1`
  để monitor thụ động cạnh agent.
- `src/suggest.rs` — ✧ AI commit: pipe diff (cap 16KB) vào CLI `claude -p --model haiku`,
  timeout 60s, fallback filename-heuristic; chạy thread nền, app poll channel theo refresh tick.
- `src/takeover.rs` — preview "replace": park panes đang chạy vào tab tạm, journal cây split
  (`Node::{Pane,Split}`) trong runtime dir, restore best-effort luôn hoàn tất + budget retry.
- `AGENTS.md` (1726 dòng) — living doc mọi herdr behavior "verified live": race hook, ratio clamp
  0.1, corpse/heartbeat, send-keys limits… vàng cho ai viết plugin herdr.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Heartbeat token = liveness pane duy nhất tin được** (`ipc.rs::report_identity`,
   `launch.rs::token_stale`): TUI re-stamp token `herdr-sidebar-explorer: <unix_now()>` mỗi vòng
   event-loop (**mỗi iteration**, không chỉ nhánh timeout — auto-repeat key làm `event::poll`
   luôn true sẽ đói heartbeat → bị REPLACE giữa lúc gõ); stale >20s hoặc label-mà-không-token =
   corpse → `REPLACE <id>`. Chống loop: budget 3 lần/phút/tab trong runtime dir.
2. **Serialize hook bursts bằng OS lock** (`ensure.rs::LaunchLock::acquire`, AGENTS.md "Focus
   events fire in bursts"): 1 tab switch phát `tab.focused`+`workspace.focused` chạy **đồng
   thời** — không lock thì 1 switch mở 4 pane. Focus hook dùng `try_lock` (skip nếu bận),
   action rời rạc dùng `lock` blocking; lock crash-released bởi OS, không cần stale-cleanup.
3. **Idempotent ensure-on-event heal** (manifest events + `ensure.rs`): server-restart resume
   tạo corpse không event nào heal — hook chạy trên cả `pane.focused`/`workspace.focused`/
   `tab.created`/`workspace.created`/`pane.moved` nên **thao tác đầu tiên của user tự heal tab**.
4. **IPC không spawn CLI** (`ipc.rs::call_text`): nói thẳng socket (UDS/named pipe) newline-JSON
   thay vì gọi `herdr` CLI trong hook — nhanh, không flash console Windows, timeout 5s + cap
   4MB chống wedge UI thread (kèm test "wedged peer must not hang").
5. **Git đọc cạnh agent an toàn** (`git.rs::run_read_in_with_timeout`): `GIT_OPTIONAL_LOCKS=0`
   cho mọi read (không ghi index khi pane khác đang giữ), timeout 2s kill cả process tree;
   `status -z` parse NUL-safe + `##` header lấy ahead/behind.
6. **Spawn pane không flash shell prompt** (`ipc.rs::open_plugin_pane` + `state.rs
   SPAWN_CWD_ENV`): `plugin.pane.open` với entrypoint manifest + env cwd/activity riêng — không
   qua `pane.split` + send-keys (hiện prompt giữa chừng).
7. **Graceful close TUI** (AGENTS.md "pane close kills with no chance to flush"): không bao giờ
   `pane.close` pane sống; gửi `Ctrl+Q` (qua `send-keys`) cho TUI tự persist draft rồi tự đóng.
8. **Follow sibling cwd kỷ luật** (`launch.rs::FollowPoller`, AGENTS.md #104/#119): single-flight
   worker, sample 300ms nhưng chỉ nhận khi **2 sample liên tiếp trùng**, manual chọn folder là
   override dính đến khi pane quan sát được đổi cwd; precedence deterministic (focused > cũ >
   lexical id); plugin-pane loại khỏi candidate để không tự đuổi nhau.
9. **Idle traffic = 0** (#125): marker focus nhỏ trong runtime dir (atomic replace, khóa per
   session) + `pane.get` — sidebar ẩn không poll `pane.list` gì cả; sidebar hiện tối đa 1 list/
   300ms; jitter hash per-pane chống burst sau restart.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên cao/thấp)

- [CAO] **Heartbeat tokens cho liveness**: publisher herdgate đã observe Pi sessions qua herdr
  events — thêm token `<pipeline>:<unix_ts>` re-stamp mỗi N giây vào wake-on-settle/pane event
  flow; publisher coi stale >20s là pane chết → bỏ qua settle giả từ corpse. Mục đích file:
  module observe/publisher của herdgate (nơi lắng nghe herdr pane events).
- [CAO] **flock try_lock cho event bursts**: herdr phát `tab.focused`+`workspace.focused` đồng
  thời — wake-on-setle handler herdgate phải lấy lock file (try_lock, skip nếu bận) trước khi
  quyết định spawn, tránh duplicate spawn:<id> receipts.
- [CAO] **GIT_OPTIONAL_LOCKS=0 + timeout** cho mọi git read của PWA (Diff/Timeline) và pipeline
  worktree — agent Pi đang giữ index, read herdgate phải vô hại + bounded.
- [CAO] **Graceful Ctrl+Q rồi mới close** cho `task.mjs close/revive` khi pane còn sống — persist
  state Pi trước khi giết; chỉ close trực tiếp pane mới spawn chưa vào event loop.
- [TB] **Nói socket herdr trực tiếp** (newline-JSON 1 req/resp, timeout+cap) thay vì shell out
  `herdr` CLI trong hook/publisher — giảm latency và rủi ro zombie process trên gate VPS.
- [TB] **Ensure-on-event heal idempotent** cho Mobile TUI SSH / PWA: mọi op "đảm bảo pane/tab tồn
  tại" phải idempotent + chạy trên nhiều loại event, chấp nhận heal lười ở tương tác đầu tiên.
- [TB] **AI suggest pattern** (thread nền + channel + cap 16KB + timeout + fallback heuristic)
  cho Recap/commit message trong Jobs của herdgate — không bao giờ block loop chính.
- [THẤP] **Budget thay thế** (3 lần/phút) cho revive loop — chống spawn vòng vô hạn khi agent
  crash lúc startup.
- [THẤP] **AGENTS.md living-findings** cho herdgate docs: ghi lại mọi herdr behavior verify-live
  (như loạt tìm hiểu ở đây) để agent sau không tái khám phá.

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- **Phức tạp Windows** (GUI-subsystem sidecar, named-pipe thread-timeout leak chấp nhận, .ps1
  nhân đôi mọi action): gate herdgate là Linux VPS + cloudflared — chỉ cần nhánh UDS, bỏ toàn bộ
  bản `-windows`.
- **Đóng đinh internals herdr 0.7.1–0.9.5** (ratio clamp 0.1, `pane close` không flush,
  `send-keys` từ chối `Home`/`PageDown`, focus theo slot): đây là quan sát version-specific,
  herdgate phải verify lại trước khi phụ thuộc — cứ coi là "cần test", đừng encode cứng.
- **Monolith Rust 5.6k/6.8k dòng** (explorer_app/scm_app): herdgate là relay Node + PWA; học
  *pattern* (single-flight worker, gate schedule, journal) chứ không đương đầu file khổng lồ.
- **Takeover mode** (park/restore pane): README tự cảnh báo "third-party TUIs not yet verified",
  restore có thể hỏng layout — rủi ro cao hơn giá trị với pipeline worktree herdgate.
- **Settings UI đồ sộ trong TUI**: herdgate đã có PWA + Cmd+K, không tái tạo settings modal
  trong terminal.
- License MIT — tương thích, chỉ cần attribution nếu port code thật.

## File đã đọc

README.md (root, 221d); herdr-plugin.toml (281d, đủ); src/ipc.rs (326d, đủ); src/lib.rs (31d);
src/main.rs (dispatch + tests); src/ensure.rs (LaunchLock/RefreshPlan, 76–230); src/launch.rs
(grepped: HEARTBEAT_STALE_SECS, launch_decision, open_plan, FollowPoller); src/state.rs (View,
spawn_env, envs); src/git.rs (status, run_read_in_with_timeout, GIT_OPTIONAL_LOCKS);
src/suggest.rs (168d, đủ); src/takeover.rs (1–60 + journal rules); AGENTS.md (§herdr behavior
findings, §heartbeat, §follow cwd, §idle traffic #125, §takeover); explorer_app.rs + scm_app.rs
(constants & worker highlights); tree.json (78 files). Repo: github.com/alexarthurs/herdr-sidebar
v0.16.0, fetched 2026-11-21.
