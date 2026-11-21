# Nghiên cứu: herdr-pc-ram-and-cpu-usage-overlay (ezcorp-org, v1.13.0, MIT)

Plugin Herdr TUI + desktop mod viết Rust (~9k dòng) đo CPU/RAM **per space** bằng process-tree
attribution từ `/proc` (KHÔNG dùng cgroup), refresh 5s, zero-setup. Không phụ thuộc crate nặng:
`/proc` đọc tay, `sysconf` qua libc, socket JSON-RPC tự viết.

## Kiến trúc cốt lõi (file-level)

- `herdr-plugin.toml` — manifest: `[[build]] cargo build --release`, `[[startup]] --restore`,
  `[[events]] workspace.focused → --restore`, 2 pane (dashboard/monitor), 5 action. Không có hook
  nào contribute UI → phải tự sửa config herdr (xem anti-pattern).
- `src/main.rs` (351d) — dispatch flag `--once/--interval/--json/--daemon/--enable/--disable/
  --restore/--monitor/--icons/--desktop-json`. Icon preview chạy TRƯỚC `connect` (không cần herdr).
- `src/herdr.rs` (696d) — client JSON-RPC newline-delimited qua `UnixStream` (Windows: named pipe
  `\\.\pipe\<path>` + `SECURITY_IDENTIFICATION` + retry `ERROR_PIPE_BUSY`). IO_TIMEOUT 15s, tự
  reconnect 1 lần khi EPIPE. Method: `session.snapshot`, `pane.process_info`, `worktree.list`,
  `pane.report_agent`, `pane/workspace.report_metadata`, `client.window_title.set`.
- `src/model.rs` (231d) — serde view chỉ khai báo field dùng đến; test pin payload thật herdr 0.8.0.
- `src/collect.rs` (819d) — pipeline `collect_spaces → group_worktree_families → measure →
  aggregate_families`. Phân loại pane: agent/spare/pseudo + plugin-pane heuristic qua `tokens`.
- `src/proc.rs` (350d, Linux) — `scan_proc()` đọc toàn bộ `/proc/<pid>/stat` 1 lần; `parse_stat()`
  cắt sau `)` CUỐI (comm chứa space/dấu ngoặc); `subtree()` DFS có visited-set (chống cycle).
- `src/daemon.rs` (1978d) — vòng lặp đẩy status; pid-file **per session**, marker enabled
  tri-state (absent=fresh install=BẬT); watchdog chống treo; SIGTERM → clear status + title.
- `src/disk.rs` / `src/battery.rs` — statvfs / sysfs-power_supply, trả `Option`, `None` = ẩn cell.
- `src/herdr_config.rs` (728d) — chèn row `["$usage"]` vào `[ui.sidebar.spaces]` config herdr:
  guarded + comment-block `# --- added by ---` + `.bak` + temp-rename.
- `desktop/main.js` — mod GPUI: refresh per-device, guard `busy/nextRefresh`, PID remote chạy
  sampler trên device sở hữu nó (`exec(cmd, {on: machine})`).

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Process ancestry, không cgroup** (`collect.rs::collect_spaces` + `proc.rs`): lấy `shell_pid`
   mỗi pane từ `pane.process_info` → PID set = union `subtree()` của mọi root qua `children_map`
   (đồ thị ppid→con từ scan sau). CPU% = `ΣΔjiffies / CLK_TCK / elapsed_s / NPROC × 100`, min(100)
   — share toàn máy. RAM = Σ `statm` field-2 × page_size. Không cần root, không cgroup, chạy được
   cả SSH box thường.
2. **cutime/cstime — bắt CPU của process con đã chết** (`proc.rs::parse_stat`, `collect.rs::
   delta_jiffies`): jiffies = utime+stime+cutime+cstime. Build/test spawn con ngắn ngủi chết giữa
   2 sample → CPU bị mất trừ khi đếm cutime. Hàm `delta_jiffies` xử 3 case: sống cả 2 scan → delta;
   sinh trong window → tính toàn bộ; chết trong window → trừ jiffies-before của nó vì đã được gấp
   vào cutime tổ tiên còn sống (walk ppid chain qua các pid cũng biến mất, tối đa 64 hop). Đây là
   phần khó nhất và đúng đắn nhất của repo.
3. **Snapshot 1 call chống torn read** (`herdr.rs::session_snapshot`): trước đây `workspace.list`
   + `pane.list` từng workspace → workspace đóng giữa 2 call làm nguyên sample fail. Một
   `session.snapshot` trả workspaces+panes đồng thời.
4. **TTL status tự xoá** (`daemon.rs::push_statuses`, `status_ttl_ms = interval×3000, min MAX`):
   daemon chết → text tự biến mất, không rác UI. Pseudo-agent (mode agents-panel) thì KHÔNG TTL →
   phải sweep khi disable.
5. **Metric vắng = ẩn, không bịa 0%** (`battery.rs::read → Option<Battery>`, `disk.rs::read`):
   máy không pin/ổ không stat được → không vẽ cell. Disk % dùng `used/(used+avail)` giống `df`
   (không tính block reserve cho root), giá trị "used" mới đúng ngữ cảnh cạnh cpu/ram cùng là usage.
6. **Zero-setup thật sự**: build lúc install; `[[startup]]` chạy trên cả fresh start lẫn handoff;
   `plugin install` không chạy startup hook → thêm `[[events]] workspace.focused` gọi `--restore`
   (idempotent, exit trong ~µs khi daemon sống); marker tri-state phân biệt "chưa ai quyết" vs
   "user tắt". Daemon tự watch executable của nó để handoff khi dev-link rebuild.
7. **Window title là surface máy-wide** (`daemon.rs::set_title_totals`): tổng cpu/ram/bat/disk mọi
   space ghi vào terminal title — pin/disk chỉ vẽ 1 lần cho máy, không lặp per-space.
8. **Icon tier theo khả năng font** (`main.rs::ICON_TIERS` text/unicode/nerdfont/emoji + `--icons`
   preview): không đoán Nerd Font có hay không — auto detect khi có, preview cho user tự chọn.

## Áp vào herdgate (checklist)

Cao:
- [ ] Sampler per-machine trong publisher (Node, thư mục publisher hiện có): port `scan_proc/
  parse_stat/subtree/delta_jiffies` sang JS đọc `/proc` trực tiếp (thuần fs, không phụ thuộc).
  Root = PID của Pi session mà publisher đang observe → usage per agent/session thay vì per space.
  Đẩy receipt JSONL loại mới `usage:<id>` cùng JSON path với `spawn:<id>` hôm nay.
- [ ] Áp cutime/cstime + 3-case delta đúng nguyên văn (herdgate chạy build/test liên tục — đây là
  giá trị lớn nhất; không có nó, cargo test 5s là 0% CPU).
- [ ] Nguyên tắc "1 snapshot chống torn": mọi API gate/publisher gộp đọc state nhiều thực thể vào
  1 op khi có thể; id thực thể đóng giữa chừng chỉ bị bỏ, không fail cả batch.
- [ ] Usage PWA:.hide metric thiếu (không bịa 0%), disk % kiểu df `used/(used+avail)`, CPU share
  toàn máy 0–100 + cap min(100).
- [ ] TTL semantics cho mọi trạng thái đẩy xuống PWA (stale = tự biến mất sau ~3 chu kỳ refresh)
  — thay cho wake-on-settle đang vốn dĩ event-driven.

Trung bình:
- [ ] Worktree folding cho Usage page (pipeline worktree của herdgate): sum cpu/ram/proc con vào
  parent như `aggregate_families`, hiện label children gộp.
- [ ] Tổng máy-wide (cpu/ram/disk) vào title Mobile TUI SSH hoặc header PWA — 1 lần, không lặp.
- [ ] Config mặc định khoan cloned: `interval_seconds: 5`, `disks = ["/"]`, icon auto.

Thấp:
- [ ] Icon tier + preview (`--icons`) cho PWA/TUI khi thêm Nerd Font mode.
- [ ] `--monitor` exec btop/htop/top thay vì spawn-wrapped.

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- **Tự sửa config app host** (`herdr_config.rs` chèn `$usage` row vào config herdr): hack sinh ra
  vì plugin API thiếu; herdgate sở hữu UI riêng — không bao giờ cần, chỉ tạo rủi ro ghi file user.
- **Named-pipe Windows + SQOS**: herdgate là Linux/SSH, bỏ hoàn toàn.
- **Sleep blocking 500ms–5s giữa 2 scan** trong thread Rust ổn; publisher Node phải `await sleep`,
  không block event loop — port cơ chế, không port hình thức thread.
- **Token heuristic** (`is_plugin_pane` đoán pane của plugin khác qua flat `tokens` map không có
  ownership) — cấu trúc dữ liệu herdgate tự chọn, không áp vào receipt one-id đã có id rõ ràng.
- **Pid-file per session + SIGTERM sweep**: herdgate đã có spawn registry (task.mjs) làm việc này.
- License MIT (EZCorp 2026) — tương thích, nhưng nếu port code `delta_jiffies` nguyên văn thì giữ
  attribution; tốt hơn: reimplement theo thuật toán (đã mô tả đủ ở trên).

## File đã đọc (raw.githubusercontent, branch main)

README.md (40KB, phần zero-setup/icons), herdr-plugin.toml (đầy đủ), HANDOFF.md, Cargo.toml,
LICENSE (MIT), src/main.rs, src/model.rs, src/collect.rs (fn classify_panes, collect_spaces,
git_branch, group_worktree_families, measure, delta_jiffies, aggregate_families), src/proc.rs
(scan_proc, parse_stat, children_map, subtree, rss_mb, mem_total_mb), src/herdr.rs (connect, call,
round_trip, session_snapshot, process_info, worktree_list), src/disk.rs (Disk, used_percent,
statvfs::probe), src/battery.rs (read, State), src/daemon.rs (run_daemon, push_statuses,
status_ttl_ms, Tracked), src/config.rs (grep defaults), src/herdr_config.rs (ensure_usage_row,
with_usage_row), desktop/main.js, desktop/model.js (sampleSpaces), desktop/mod.json.
= 16 file nguồn thật, vượt yêu cầu ≥5.
