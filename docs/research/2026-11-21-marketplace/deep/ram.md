# Đào sâu tầng 2: herdr-pc-ram-and-cpu-usage-overlay (v1.13.0, 13.744 dòng)

Nâng cấp của `r-ram.md` (tầng 1). Không lặp lại phần đã viết — chỉ đào thêm: module graph
đầy đủ, các máy trạng thái, và các cơ chế tầng 1 chưa đụng tới (claim/session, herdr_config,
icons, monitor, desktop mod, test discipline). Mọi excerpt trích nguyên văn từ `/tmp/deep/ram`.

## Kiến trúc đầy đủ (module graph: ai gọi ai, dữ liệu chảy thế nào)

16 module Rust + 4 file JS desktop. LOC / số test: daemon 1978/36, render 1475/38, config
1429/40, icons 1311/38, battery 1086/37, collect 819/23, herdr_config 728/23, herdr 696/17,
proc_macos 482/13, disk 414/12, proc_windows 413/9, main 351/2, proc 350/10, monitor 278/10,
desktop 199/2, model 231/2, tests/desktop.rs 117/1 (+16 test JS). Tổng ~313 test Rust + 16 JS.

```
main.rs ──flag dispatch──► daemon(--daemon/--enable/--disable/--toggle/--restore)
   │                          │                    │
   │                          ├─► herdr (JSON-RPC client, UnixStream/named pipe)
   │                          ├─► collect::snapshot ─► herdr::session_snapshot
   │                          │        │                + process_info (mỗi pane)
   │                          │        │                + worktree_list (mỗi repo)
   │                          │        ├─► proc::scan_proc ×2 (before/after) + sleep
   │                          │        └─► aggregate_families (fold worktree con)
   │                          ├─► render::{usage_row,totals_row} ─► icons (glyph tier)
   │                          ├─► battery::read / disk::read (Option, gate tại read)
   │                          ├─► herdr_config::ensure_usage_row (bootstrap 1 lần)
   │                          └─► proc::stop_process (SIGTERM daemon khác)
   ├─► render::run_once/run_json/run_interval (pane dashboard)
   ├─► monitor::run (exec btop/htop/top — thay thế process)
   └─► desktop::{install,run_json} ─► include_str! main.js/model.js/mod.json
desktop/main.js (GPUI) ─► model.js::sampleTargets ─► exec sampler TRÊN device sở hữu PID
```

Dòng dữ liệu một chu kỳ refresh: `session.snapshot` → classify_panes (agent/spare/pseudo) →
`pane.process_info` lấy shell_pid mỗi pane → `measure` = scan /proc, sleep, scan lại →
`delta_jiffies` per space → push `workspace.report_metadata` (TTL 3×interval) hoặc
`pane.report_agent`+token → `client.window_title.set` (tổng máy). Config + label + icon
tier re-read MỖI chu kỳ (`reload_settings`) nhưng interval cố định lúc khởi động.

Điểm mới đáng chú ý trong graph: (1) `sweep_targets` và `collect_spaces` **chia sẻ một walk**
`workspaces_with_roles` — hai reader phải đồng ý về workspace/pane nào tồn tại, "two walks
that could drift is the way to get that wrong quietly, so there is one" (collect.rs:116-160);
(2) desktop sampler **dùng lại** `collect::measure` và `render::json_spaces` — một thuật toán
đo, ba surface (terminal/JSON/desktop); (3) `render` là nơi DUY NHẤT dựng metric cell
"so the surfaces cannot drift apart" (render.rs:6).

## Máy trạng thái & luồng chi tiết

### 1. Wanted — marker tri-state quyết sống còn của "zero-setup" (config.rs:400-460)
```
absent → Undecided → wants_daemon()==true → fresh install TỰ BẠT, bootstrap chạy
"0"    → Disabled  → restore no-op vĩnh viễn (disable ghi "0", KHÔNG xóa file)
khác/1 → Enabled
```
Cờ `enabled` (quyết định người dùng) tách rời cờ `bootstrapped` (đã sửa config herdr chưa) —
gộp lại thì `status-enable` sau khi user tự xóa row sẽ re-add row họ chủ ý xóa (daemon.rs:880).

### 2. Claim (pid-file per session) — vòng đời chống daemon mồ côi (daemon.rs:150-280)
Claim 2 dòng `pid\nsocket\n`; parse chỉ đọc dòng 1 làm pid (file v1.11.1 cũ chỉ có pid →
socket=None, vẫn là claim hợp lệ). Ba lối ra đều đi qua `release_pid_claim` có guard:
```rust
fn release_pid_claim() {
    if claims_pid_file(read_pid_file(), std::process::id()) {
        let _ = std::fs::remove_file(config::pid_file());
    }
}
```
Guard này tồn tại vì hand-off spawn successor viết claim MỚI ngay — xóa file vô điều kiện
trên đường ra sẽ xóa claim của newcomer, mở đường cho daemon thứ ba. Tương tự `hand_off`
(daemon.rs:1144): **release TRƯỚC, spawn SAU** — ngược lại newcomer nhìn thấy claim của
mình thì exit ngay, sidebar mãi chạy build già.

### 3. Vòng daemon — 4 nhánh rời chính mỗi chu kỳ (daemon.rs:291-460)
```rust
if claim_still_ours(&config::pid_file()) == Some(false) && !stopping.swap(true, ...) {
    stand_down();            // (a) file không còn tên mình → im lặng exit, không clear gì
}
...
if build_changed(launched, current_stamp().as_deref()) && !stopping.swap(true, ...) {
    hand_off(Some(&mut client), &tracked);  // (b) binary được rebuild → nhường chỗ
}
match collect::snapshot(&mut client, window_ms) {
    Ok(spaces) => { push_statuses(...); failures = 0; }   // (c) đường chính
    Err(_) => { failures += 1;
        if failures >= 5 { shutdown(...) }                 // (d) 5 fail liên tiếp → server chết
        thread::sleep(1s); } }
```
Điểm tinh nhất: `claim_still_ours` trả `Option<bool>` — `None` (đọc KHÔNG được, NFS stale,
hết fd) **không** đứng xuống daemon khỏe mạnh; chỉ `Some(false)` (file biến mất hoặc tên
pid khác) mới (daemon.rs:214-227). Hai `--restore` đua nhau viết claim → luật hội tụ:
"whoever the file names is the updater, and everyone else stands down at their next cycle"
— hội tụ trong 1 interval, không cần lock.

### 4. Mode push — AgentsPanel vs Sidebar (daemon.rs:704-800)
Sidebar (default): `workspace.report_metadata` TTL. AgentsPanel: `report_agent` (claim row,
KHÔNG TTL) + token trên cùng pane; stale pseudo-claims thừa bị release (`skip(1)`); nếu
report_agent fail hoặc không còn spare pane → fall-through token lên agent pane đầu —
"we never claim a pseudo-AGENT on a pane we do not own".

### 5. Build stamp (daemon.rs:1050-1080)
`stamp = "{mtime_nanos}:{len}"` — không phải crate version (reinstall cùng version vẫn thay
binary; cargo build không bump version). Stat không đọc được ≠ changed — guess sẽ retire
daemon khỏe. Reinstall qua `plugin install` UNLINK binary (không rewrite) → daemon già không
tự nhận ra — chấp nhận, document lý do từng bước.

## Mọi cơ chế áp vào herdgate

### A. Sampler per-machine & đúng CPU của process con đã chết (tầng 1 đã nêu — giữ, bổ xung)
Cơ chế cốt lõi vẫn là `delta_jiffies` (collect.rs:338) với 3 case + walk ppid qua các pid
cũng biến mất (≤64 hop). Bổ sung tầng 2: hằng `FOLDS_REAPED_CHILDREN: bool` per-platform
(proc.rs:17 = true, proc_macos.rs:23 = false) — macOS/Win không fold CPU con đã chết vào
cha nên **không được trừ** — port sang JS (Linux) lấy true. Áp: `plugin/server/pi-usage.mjs`
— hiện plugin chỉ có usage đơn giản; port `scan_proc/parse_stat/subtree/delta_jiffies`
đọc `/proc` thuần (fs.readFile, không dependency) để publisher đẩy receipt `usage:<id>`.
Vì sao: herdgate chạy cargo test/build liên tục — không có cutime correction thì 5s cargo
test đọc 0% CPU.

### B. "Không đọc được ≠ đã đổi" — tam giá trị cho mọi check external state
`claim_still_ours` → `Option<bool>`; `build_changed` → stat fail là `false`. Nguyên tắc:
"where the question is 'has something changed underneath me', not being able to look is
not evidence that it has". Áp: `plugin/server/pi-receipt-watch.mjs` và `pi-receipt-gc.mjs` —
mọi check "file/receipt còn của mình không" phải phân biệt NotFound (chắc chắn đi tiếp) với
EACCES/EBUSY (bỏ qua chu kỳ này, không kết luận). Vì sao: host SSH/NFS hay có giây readable
sai lệch; GC vội xóa state đúng chỉ vì đọc không được là mất mát không hồi phục.

### C. Compile-time assert buộc 2 hằng ở 2 module khớp nhau
```rust
const MAX_TTL_MS: u64 = 86_400_000;
const _: () = assert!(config::MAX_INTERVAL_SECONDS.saturating_mul(3_000) <= MAX_TTL_MS);
```
(daemon.rs:1214-1223). TTL = 3×interval, clamp vào trần API 24h; ai sửa một hằng một mình
thì build fail. Áp: mọi cặp "refresh interval × N = timeout/TTL" trong herdgate (vd wake
timeout × interval publisher trong `plugin/server/pi-wake.mjs`, retry backoff trong
`src/host/ssh.ts`) — declare const ở 2 đầu + `const _assert` (TS: `satisfies`/throw ở
module-load hoặc test). Vì sao:类型的 drift này im lặng — TTL < interval làm status nháy tắt.

### D. Deadline wrapper cho blocking work không có timeout riêng
```rust
fn within(deadline: Duration, work: impl FnOnce() + Send + 'static) {
    let (done, wait) = std::sync::mpsc::channel();
    thread::spawn(move || { work(); let _ = done.send(()); });
    let _ = wait.recv_timeout(deadline);
}
```
(daemon.rs:613). Áp: Node tương đương là `Promise.race([work, sleep(deadline)])` trong
`plugin/server/publish-tui.mjs` / mọi sweep gọi ra socket herdr hoặc SSH của người khác.
Vì sao: lệnh user chờ (--disable) không được treo trên session của người khác đã wedged.

### E. Sweep "assume-most": xóa mọi thứ plugin CÓ THỂ đã đẩy, kể cả 2 lớp trên 1 pane
`everything_we_could_have_pushed` (daemon.rs:635) bỏ pseudo-pane vào CẢ bucket pseudo
(release row) LẪN metadata (clear token) — bug thật: sweep release row nhưng để lại con số
trong row thêm 15s. Áp: shutdown/cleanup path của publisher (kill TUI, hủy wake): với mỗi
id đã từng spawn, quét cả receipt type đã biết lẫn resource kề theo (proc, tmux pane, socket).
Vì sao: cleanup kiểu "chỉ xóa thứ mình nhớ" bỏ sót state sinh ra giữa lần ghi nhớ và crash.

### F. Tri-state + guard cho mọi file claim/registry herdgate tự viết
Pid-file per session + `is_our_process` so `/proc/<pid>/comm` với chính mình (chống pid
recycle), `reap_dead_claims` GC file không trỏ process sống ("mỗi file stale là một vé số
recycled-pid"). Áp: nếu herdgate publisher cần singleton per SSH session — nhưng KHÔNG port
nguyên dạng: herdgate đã có registry spawn (task.mjs). Chỉ lấy 2 ý: (1) claim file ghi kèm
"đường tới session" (giống dòng 2 socket) để bên khác hành động được; (2) parse forward-
compat: format mới giữ dòng 1 y nguyên, reader cũ vẫn đọc được.

### G. Icon tier: auto KHÔNG BAO GIỜ chọn tier "có trong font nhưng xấu", probe rẻ trước probe đắt
`auto_detect` (icons.rs:439): check locale (2 getenv) TRƯỚC, chỉ fork `fc-list` nếu qua;
kết quả cache `OnceLock`; auto chỉ chọn NerdFont/Text — Unicode tier có mặt khắp nơi nhưng
`░▒` là dither pattern "render as an indistinct blob at terminal sizes" — "Present and
legible are different properties". Áp: `src/web/app.js` + `src/host/mobile-tui-core.mjs`
khi thêm chế độ glyph — không auto chọn glyph "có khả năng lỗi hiển thị"; để user chọn và
cung cấp preview. Vì sao: sai bên an toàn luôn rẻ hơn đúng kiểu may rủi.

### H. Ramp table kín + xử lý NaN/∞ tường minh
```rust
const GAUGE_RAMP: [(f64, char); 4] = [(34.0,'░'),(67.0,'▒'),(90.0,'▓'),(f64::INFINITY,'█')];
fn ramp_pick(ramp: &[(f64, char)], percent: f64) -> char {
    let percent = if percent.is_nan() { f64::NEG_INFINITY } else { percent };
    ramp.iter().find(|&&(upper, _)| percent < upper).or_else(|| ramp.last())...
```
(icons.rs:61,360). NaN → bước thấp nhất, ∞ → cao nhất — "both compare false against every
bound and would otherwise land on whichever step the fallback happened to pick". Áp:
`src/web/app.js` mọi chỗ map số liệu → màu/bậc gauge (CPU load màu). Vì sao: JS `NaN < x`
luôn false — không xử lý thì NaN rơi vào default một cách ngẫu nhiên theo thứ tự if.

### I. Gate metric TẠI READ, một lần mỗi refresh: opt-out = 0 syscall
`Config::battery_reading()` = `self.battery.then(battery::read).flatten()` — `battery=false`
không đụng sysfs/pmset; mọi renderer thấy `None` giống máy không pin — "turning the metric
off therefore looks exactly like a desktop". Áp: `plugin/server/pi-usage.mjs` — đọc disk/
battery/usage theo config flag, nếu tắt thì không gọi gì, PWA nhận `null`/thiếu cell.
Vì sao: 4 check rải rác ở renderer sẽ drift; 1 gate ở nguồn thì downstream off by construction.

### J. Đặt hàng lỗi "names the way out"
Monitor không tìm thấy: `"no system monitor installed — looked for {candidates}. Install
one, or name yours with system_monitor = ... in the plugin's config.toml"` (monitor.rs:62) —
nêu cả thứ đã thử LẪN key config để thoát. Áp: mọi error message herdgate hướng user
(missing wake, SSH fail trong `src/host/ssh.ts`, plugin install). Vì sao: bare
`btop: command not found` không cho ai biết có setting.

### K. Desktop: PID remote chạy sampler TRÊN device sở hữu nó + per-device state guard
`model.js::sampleTargets` gom space theo `machine`, `main.js` giữ `{reading, error, busy,
nextRefresh}` mỗi device và `exec(command, {on: machine})` — "a remote PID can name an
unrelated local process". Áp: `plugin/server/pi-usage.mjs` khi publisher observe nhiều
SSH host — usage từng host phải do sampler chạy trên host đó đo, không `/proc` local.
Response validate chặt (`parseReading`: code!==0 throw, system fields finite + range).

### L. Ship JS trong binary: `include_str!` + placeholder thay lúc install
desktop.rs:12-14 nhúng `main.js/model.js/mod.json` vào binary; install ghi ra file và
`MAIN.replace("@SPACE_USAGE_BINARY@", BINARY)`; main.js publish SAU CÙNG (atomic-ish).
Config user giữ nguyên qua upgrade (`create_new(true)` — chỉ viết khi chưa có). Áp:
`src/web`/`templates` khi herdgate đóng gói PWA + host script thành 1 artifact deploy
(`scripts/`, DEPLOY.md) — giảm rủi ro lệch version giữa host binary và web assets.

## Cách họ test (pattern đáng học cho suite 213 test của ta)

1. **Comment-test là ghi chép lý do + pin bug bằng tên test**: `only_the_daemon_the_claim_names_keeps_running` mở bằng "The rule the loop applies every cycle, and the answer to a daemon nothing can see..." — mỗi test là minidoc về incident nó chống lại. Test cả **known limitation có chủ ý** (`classify_misreads_a_foreign_usage_token_as_ours` — "KNOWN LIMITATION, pinned deliberately rather than left as prose... If this test ever fails, the rename happened").
2. **Seam inject mọi thứ host-dependent**: `resolve_with(configured, env, has_nerd_font)`, `reap_dead_claims_among(files, is_live)`, `daemon_pid_at(path)`, `ram_cell_of(..., mem_total_mb)` — không test nào phụ thuộc máy chạy ("without a seam every auto-detection test would pass or fail depending on whether the machine running it happens to have a Nerd Font, which is no test at all").
3. **Pin payload thật của API ngoài**: model.rs nhúng `session.snapshot` verbatim từ herdr 0.8.0 protocol 19 "keeping the field names and nesting exactly as the server sends them. The point is to fail loudly if a herdr upgrade moves them". Tương tự: hash FNV pin về literal `"42c3c9646ad866b0"` vì "two processes... may have been built by different compilers".
4. **Round-trip**: test parse lại chính snippet mà UI bảo user paste (`icons::herdr_ui_snippet` → `parse_config`).
5. **Test chống flaky có ghi chú**: `read_keeps_the_selection_order` so tên thay vì float — "two statvfs calls a moment apart... Seen once in roughly a hundred local runs".
6. **Test song sinh biên dịch loại trừ**: `subtree` test copy ở proc/proc_macos/proc_windows — "the twins are compiled exclusively, so their common helpers are duplicated rather than shared".
7. **Test platform-only qua seam chạy mọi nơi**: `font_list_reports_coverage(status_ok, stdout)` compile mọi target dù chỉ Linux gọi; test `within()` deadline chạy cả unix vì "CI has no herdr to wedge, and this needs none"; riêng nhánh Windows-only (`release_stopped_claim`) có test `#[cfg(windows)]` kèm ghi chú "it was the one branch nothing anywhere executed".
8. **E2E integration thật 1 file** (tests/desktop.rs): install → assert đủ file → sửa config → upgrade install lại → assert config NGUYÊN VẸN → chạy sampler thật với PID của test process → assert JSON fields → input rác fail. RAII cleanup (Drop xóa temp home).
9. **JS test không framework ngoài**: `node:test` + `node:vm` Proxy giả GPUI view — test render của UI framework không cần browser/DOM.
10. **Scratch dir keyed pid+thread-id, xóa lúc VÀO không phải ra**: "a test that fails leaves its fixture behind to look at, and the next run still starts clean" (testutil.rs).
11. **CI 3 OS hard gate**: fmt --check, clippy `-D warnings`, cargo test --all, `node --test`, build release — cả 5 là gate bắt buộc.

## Anti-pattern / không lấy gì

- **Sửa config file của app host** (herdr_config.rs) — dù cực kỳ cẩn thận (marked block
  BEGIN/END, guarded, `.bak`, temp+rename, quote/comment-aware bracket scanner, fix dấu
  phẩy issue #13), đây vẫn là hack sinh ra vì plugin API thiếu contribute-UI. herdgate sở hữu
  UI/host riêng — không bao giờ cần. Chỉ học nếu một ngày phải viết vào file user: học
  toàn bộ precaution của họ, không học quyết định.
- **Named pipe Windows + SQOS + watchdog heartbeat**: chính xác về security nhưng herdgate
  là Linux/SSH — bỏ. (Watchdog pattern B/D ở trên thì vẫn lấy ý — không lấy code platform).
- **`sysinfo` crate chỉ cho whole-device của desktop** trong khi `/proc` đọc tay cho per-space —
  hai nguồn số trong 1 binary có thể lệch nhau; herdgate port thì dùng 1 nguồn duy nhất.
- **`thread::sleep` blocking trong loop**: đúng với Rust; port Node phải `await`, không block
  event loop (tầng 1 đã nêu — giữ nguyên).
- **Token heuristic `is_plugin_pane`**: flat `tokens` map không ownership — họ pin limitation
  làm test; herdgate receipt đã có id rõ ràng, đừng đưa heuristic tương tự vào protocol mới.
- **Daemon giữ interval cố định suốt đời** (đổi config không đổi cadence — vì TTL/refresh phải
  đồng bộ): hợp lý cho họ, nhưng nếu herdgate muốn hot-reload interval thì phải rebuild TTL
  cùng lúc trong cùng một atomic update — note để không copy "frozen interval" một cách mù.
- **PID compare qua `/proc/pid/comm` không phải ownership check** — chính tác giả ghi limit
  và recommend `File::try_lock` advisory lock làm follow-up chưa làm; nếu herdgate cần
  singleton, dùng lock file ngay từ đầu thay vì comm-compare.

## File đã đọc (đầy đủ danh sách + phần đã đọc)

Đọc TRỌN (100%): src/proc.rs (350), src/collect.rs (819), src/herdr.rs (696), src/model.rs (231),
src/daemon.rs (1978), src/main.rs (351), src/config.rs (1429), src/disk.rs (414), src/monitor.rs
(278), src/desktop.rs (199), src/testutil.rs (29), tests/desktop.rs (117), desktop/main.js (76),
desktop/model.js (50), desktop/mod.json (6), .github/workflows/ci.yml (50), Cargo.toml (40),
HANDOFF.md (87), herdr-plugin.toml (162).
Đọc phần lõi + khảo test bằng tên: src/render.rs (code 1-800 trọn, test 800-1475 liệt kê),
src/icons.rs (code 1-578 trọn), src/herdr_config.rs (code 1-500 trọn), src/battery.rs (header +
checked_percent + sysfs::aggregate 1-260), src/proc_macos.rs (1-60 module doc + cấu trúc twin),
desktop/main.test.mjs (1-80 + tên test), desktop/model.test.mjs (tên 6 test).
Chưa đọc chi tiết (chỉ theo vai trò): src/proc_windows.rs (twin Win32 của proc_macos — Toolhelp
snapshot, FILETIME 100ns), phần thân test của render/icons/battery/herdr_config, README.md 887d
(tầng 1 đã đọc phần dùng đến). Tổng ~9.900/13.744 dòng đọc trực tiếp, phần còn lại là test
của module đã đọc trọn code.
