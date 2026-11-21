# Nghiên cứu: herdr-revive (cantona, v0.3.1, Apache-2.0)

Plugin Herdr TUI + desktop app (herdr-core) viết Rust (~26k dòng src, deps cực gọn: anyhow/clap/
serde/sha2/fs2/tempfile/toml/nix — `unsafe_code = "deny"` toàn crate, chỉ macOS FFI per-statement):
save/restore toàn session — layout + lệnh đang chạy + **agent session chính xác** (Claude/Codex/
Gemini/Copilot/Cursor, không bao giờ "latest"), allowlist, preview trước khi chạy, named spaces,
migrate TUI↔app qua `hc`. **Không daemon**: TUI dùng events của Herdr, app dùng bash hook trong rc.
Benchmark matched vs herdr-resurrect (Node): save 8.9x, preview 21.8x, event 67x nhanh, -92.7% RAM;
phần revive trong relaunch desktop ~10ms. Linux + macOS.

## Kiến trúc cốt lõi (file-level)

- `herdr-plugin.toml` (154d) — manifest v0.3.1, min_herdr 0.9.1: `cargo build --release --locked`;
  `[[startup]]` + 12 `[[events]]` (pane.agent_detected/agent_status_changed/exited/created/closed,
  workspace/tab created/closed/renamed) — tất cả trỏ về đúng 1 lệnh `--host herdr event` (1 binary
  1 flag, phân biệt bên trong); 5 popup pane `scripts/manage.sh` + action save/preview/restore/
  autosave/list/timer. Timer chạy trong pane `placement = "split"`.
- `src/main.rs` (59d) — dispatch 3 tầng: `setup_request` → `core::setup` (install/uninstall luôn
  plan+y/N), `migrate_request` → `migrate::run`, còn lại `app::run`. Xuất field `config`/`text`
  thô (cho manage.sh), ngoài ra JSON pretty + exit-code.
- `src/app.rs` (2499d) — `Cli`/`Action` (save, preview, restore{dry_run,recreate,rehydrate},
  autosave{force}, event, list, status, space{names,list,save,open,import,delete}, recovery
  {inspect,acknowledge}, init, timer, config); `HostKind::Herdr|Core` resolve từ env; `run()`:
  early-exit `disabled` theo config, session lock (event contention → backoff 5→50ms trong
  min(timeout+settle, 60s); hook bị lock → `"operation_in_progress"`, op tường minh → error);
  Journal `BootState` Unclaimed→Restoring→Done/Failed; `restore()`: settle_ms sleep → plan →
  **revalidate từng pane trước khi gửi** (generation, reload config từ disk, `allowed_argv`,
  pane identity, idle check); `save()`: merge `retain_autosaved_commands` (chỉ agent command cũ
  vào pane trống cùng pane/tab/cwd), `carry_unrelaunched` cho core recovery, `refresh_latest`
  khi snapshot giống hệt (không archive lại).
- `src/capture.rs` (2193d) — `capture_once`: host snapshot → 1 lần đọc process table → mỗi pane:
  cần `shell_pid` + `foreground_process_group_id`; **idle** = fg group == shell group && mọi fg
  pid == shell; leader foreground → `validate_foreground_tree`; process đọc không được (setuid
  như macOS `top`) → luồng "protected": argv từ platform hoặc hint dòng gõ, lưu `ProvenCommand`
  keyed `identity [pid,parent,group,start]` vào `protected.json`, tái dùng chỉ khi **cùng process**
  chạy tiếp; `terminal_stdio` → mask `null_stdio` (ProgramNullStdio/Agent); SSH fd1 đặc biệt
  (OpenSSH tự redirect fd1 trong — kiểm exe `/usr/bin/ssh` + session-descriptor triple liên tiếp);
  git pager pipe được chấp nhận (`git_pager_stdio`); `resolve_claude_attach` + Claude session
  record (xem cơ chế 6); `attempt_twice`: discard capture rồi thử lại **chung 1 record deadline**
  (2 deadline riêng = giữ session lock gấp đôi).
- `src/model.rs` (859d) — Config strict TOML `deny_unknown_fields` + `validate()` mọi bound
  (timeout 10..60000, retention 1..1000, allowlist không trùng, launcher cần env selector, extra
  args whitelist per-agent — `agent_option_takes_value`/`agent_boolean_option`); `Snapshot`
  schema 1: tool/schema/session(64 hex)/created_ms/scope{session|space}/panes/layout/focused;
  `CommandSpec::{Program, ProgramNullStdio, Agent}` — Agent: `session_id` phải UUID 36 ký tự chặt,
  `session_mode resume|create`, `claude_config_dir`/`claude_home`; `allowed_argv()` **re-check
  allowlist + policy lúc restore**, dựng create-mode qua `/usr/bin/env -u CLAUDE_CONFIG_DIR
  HOME=…` và null-stdio qua wrapper cố định (cơ chế 8); `claude_transcript_exists` (scan
  projects ≤4096) + fast-path `claude_project_transcript_exists` (cwd ASCII→'-', ≤200 char);
  `agent_launcher` nhận diện cả node wrapper (`@openai/codex/bin/codex.js`, `@anthropic-ai/
  claude-code/cli.js`…); validate_argv ≤4096 args, ≤128KiB tổng; `validate_text` cấm control char.
- `src/store.rs` (303d) — `session_identity`: SHA256 `cantona.herde-revive\0session-v1\0<canonical
  socket path>` — **giữ nguyên spelling cũ `herde-revive` trong hash** để rename không mất boot
  claims; `private_dir`: mkdir 0o700 + uid-owner check + fsync từng cấp; đọc: `O_NOFOLLOW|
  O_NONBLOCK` + regular-file + MAX_BYTES 8MiB; `atomic_write`: tempfile cùng dir → fsync →
  rename → parent fsync, "replacement failed"/"durability uncertain" phân biệt; `Store`:
  `operation.lock` flock exclusive (WouldBlock → None, không stale-PID heuristic), `library.lock`
  cho named spaces (thứ tự session→library cố định); archive `{created_ms:020}-{content-hash16}
  .json` + prune retention + dir sync; `read_snapshot` refuse cross-session.
- `src/planner.rs` (91d) — decision per pane: `NoCommand | MissingPane | IdentityMismatch |
  DeniedByPolicy | Candidate`; `index_live` validate cây live (orphan tab/pane, duplicate ID);
  output sort theo pane_id, **không bao giờ chứa shell text**.
- `src/transport.rs` (382d) — `Host` trait (+ `supports_layout`, `reports_agent_sessions`,
  `command_hint` cho host khác nhau); Direct: 1 connection/request JSON newline-delimited,
  nonblocking connect (EINPROGRESS), poll deadline phủ cả write+read, refuse nhiều response
  trong 1 frame; CLI: đúng `HERDR_BIN_PATH`, stdout nonblocking bounded, deadline kill/reap.
  Cả hai: **"mutations are never retried"**; ping 1 lần/operation; `pane.send_input` + keys
  `["Enter"]`.
- `src/timer.rs` (119d) — Linux signalfd (block SIGINT/TERM/HUP, poll 50ms chỉ trong wait), macOS
  kqueue `EVFILT_SIGNAL` timeout đúng interval (0 polling); shutdown → `final_save` **trừ host
  Core** (logout giết mọi pane cùng lúc → save lúc đó ghi mọi pane idle giả); mirror cùng quy tắc
  ở hook (bỏ save status 129/137/143 = HUP/KILL/TERM).
- `src/layout.rs` (871d) — BSP tree `Node::{pane, split{direction,ratio,children}}` depth ≤64,
  mọi leaf khớp đúng 1 SavedPane; rebuild: workspace mới, tab ≤24 pane/depth ≤16 dùng
  `layout.apply` native, to hơn thì 1 anchor pane + tạo splits trực tiếp trong tab (giữ
  `HERDR_TAB_ID` đúng — không move process đang chạy sang tab tạm); journal rebuild riêng
  (pending/acknowledge độc lập với restore).
- `src/platform.rs` (768d) + `platform/{linux,macos}.rs` — `process_table`, `idle_shell`,
  `shell_command` encode per-shell (bash/dash/zsh, giữ login command), **generation** (cơ chế 2),
  `environment` read bounded quanh PID-identity check.
- `src/core/hook.rs` (2012d) — bash hook chèn rc: DEBUG trap match allowlist theo pattern word
  (4 dạng: đứng đầu/cuối/giữa + basename caseless); save chạy subshell `( set -m; ( sleep 0.5;
  herdr-revive --host core autosave --force ) & )` — process group riêng, không block prompt;
  throttle 2 save/s qua stamp `$SECONDS`; hints file per-shell `<seq>\n<hint dòng lệnh>` — save
  bị defer lấy hint **mới nhất**, tự retire khi lệnh kế tiếp/prompt; chain đúng DEBUG trap +
  PROMPT_COMMAND có sẵn (extdebug, `$_`/`$?` giữ nguyên); test suite hook là bash thật chạy
  assertion từng hành vi (301 test line+).
- `src/core/setup.rs` (1504d) + `install.rs` (1007d) — plan install/uninstall (mod dialog GPUI
  merge keys `ctrl-alt-r`/`cmd-alt-r`, rc line, PATH lookup), confirm y/N bắt buộc, mọi thay đổi
  liệt kê trước; `src/core/host.rs`/`rpc.rs` — CoreHost JSON-RPC tới herdr-core socket,
  `hook_pane`, `listed/startup_panes`.
- `src/migrate/*` (10.4k dòng) — `to_app`/`to_tui` (copy workspace, capture rồi rebuild bên kia,
  source không bị sửa), `remote.rs` qua `hc exec` (`--machine M`, record ledger 2 chiều bằng
  `--record`/`--partial`), `ledger.rs` (migrated.json: entry to_app/to_tui, match qua
  `terminal_ids`/label sống sót renumbering, partial `unknown:true` cho build dở), `external.rs`
  (hidden `--export tui`: snapshot + launches + live_agents + tui_copies + missing_folders cho
  máy khác đọc), tree/tui.
- `mods/herdr-revive/main.js` (378d) — dialog desktop GPUI: **mọi fact từ 1 lệnh `status`**, nút
  chỉ chạy lệnh rồi đọc lại status, không timer/state song song; shim `FIND` tìm binary trên
  PATH của app + `~/.local/bin` + `~/.cargo/bin`; map `DECISION` hiển thị đúng ngôn ngữ planner
  (candidate/no_command/missing_pane/identity_mismatch/denied_by_policy).
- `docs/CONTRACTS.md` (441d) — tài liệu contract độc lập: storage/identity, schema 1 đầy đủ,
  restore state transitions, transport, intentional restrictions, agent options, custom
  launchers, migration JSON + ledger semantics. `docs/MATCHED_BENCHMARK.md` + `docs/benchmarks/
  *.json`: raw samples commit trong repo, chart sinh bằng `scripts/bench-chart.py`.
- `tests/` — Rust: contracts.rs, core_cli/host/rpc, migrate_cli, `common/fake_core.rs` (core giả
  qua socket riêng); Python integration: openssh, process_inspect, real_host, core_integration,
  migrate_integration — "private sockets and temporary directories; never touch real session".

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Identity bền vững qua rename — versioned hash namespace** (`store.rs::session_identity`):
   session dir = SHA256(`cantona.herde-revive\0session-v1\0<path>`). Tool đổi tên `herde-revive →
   herdr-revive` nhưng **string trong hash giữ spelling cũ** + `native_tool()` chấp nhận cả hai
   → mọi boot claim/snapshot cũ vẫn đúng chủ. Bài học: mọi identity persist nên có namespace
   versioned tách biệt tên hiển thị.
2. **Boot generation chống PID reuse** (`platform::generation`, CONTRACTS "Storage and
   identity"): Linux SHA256(`linux-server-v1:<OS boot UUID>:<SO_PEERCRED PID>:<process start
   ticks>`); macOS dùng `kern.bootsessionuuid` + `LOCAL_PEERPID` + start µs. Socket phải là
   socket thật, peer cùng UID; chmod/chown timestamp không tạo claim mới; connection chỉ-identity
   không tốn API request, đếm riêng (`identity_connections`).
3. **Journal write-ahead từng bước một** (`app.rs::execute/send_entry`, CONTRACTS "Restore state
   transitions"): `pending.json` với state Restoring → per-pane outcome; **persist `Sending`
   TRƯỚC khi viết vào pane**, Applied/Skipped/Failed sau; lỗi → dừng hẳn các pane sau; xong →
   sync `boots/<claim>.json` rồi xoá pending + dir sync. Gián đoạn để cả 2 file → **pending thắng,
   phải `recovery acknowledge`** (ack = đánh dấu Done, không retry input). Pending block mọi
   save/restore mới, kể cả cross-boot. Boot đã Done chặn auto-restore của generation đó.
4. **"Mutations are never retried" — fail closed** (`transport.rs` cả 2 adapter): không bao giờ
   retry gửi lệnh vào pane; chỉ *lock acquisition* của lifecycle event được retry backoff, và
   debounce/status recheck sau khi có lock. Mutation delivery chỉ do trigger mới (event/timer/
   manual) — không background worker.
5. **Idle = process tree, không tin label** (`capture.rs::capture_once`, `app.rs::restore`):
   idle shell ⇔ fg process group == shell group && mọi fg pid == shell pid. Restore đối chiếu
   `agent` label stale với process tree thật — "a stale label must not prevent the saved session
   from being resumed". Revalidate trước TỪNG pane: generation + **reload config từ disk** +
   `allowed_argv` + pane identity (workspace/tab/terminal) + idle check.
6. **Claude session record gắn với process ghi nó** (`capture.rs::claude_recorded_session`,
   `record_written_by`, `linux_pid_domain`/`linux_boot_ms`): record trong `~/.claude` chỉ tính
   khi **chính process này** ghi (đối chiếu domain của /proc/<pid> + boot ms, không phải
   "file mới nhất"); grace 5s / budget 4s (`CLAUDE_RECORD_GRACE/BUDGET`) chia sẻ cho cả 2 capture
   attempt — một lần giữ session lock; bare `claude` chưa kịp có transcript → `session_mode:
   create` + `--session-id UUID` + bind `claude_config_dir`; restore kiểm transcript lại,
   **nếu đã xuất hiện thì upgrade create→resume** (race lần save đầu). Không bao giờ
   `--continue`/latest/heuristic cwd.
7. **Proven-command cache keyed bằng process identity** (`capture.rs::Protected/Proven`,
   `save()` + `protected.json`): process không đọc được argv (setuid `top` macOS) → argv bằng
   chứng được lưu cùng `identity [pid,ppid,pgid,start]`; save sau tái dùng chỉ khi **đúng process
   đó còn chạy**; hint dòng gõ chỉ tin khi streams của shell còn ở terminal. Mỗi proof chỉ sống
   trong 1 generation (macOS không có start time → sau restart pid lặp lại).
8. **Shell encode bằng vị trí, không interpolate** (`model.rs::CommandSpec::allowed_argv`,
   `platform.rs::shell_command`): null-stdio → `/bin/sh -c 'exec "$@" 2>/dev/null'
   herdr-revive <argv...>` — argv là **positional params**, không arg nào chui vào shell source;
   validate cấm control char (PTY line editor) + cấm arg bắt đầu bằng '-' làm value option;
   agent extra args whitelist per-agent; create-mode Claude qua `/usr/bin/env -u CLAUDE_CONFIG_DIR
   HOME=…` — phân biệt "profile tường minh" vs default `~/.claude.json` lookup.
9. **Debounce chọn lọc theo ngữ cảnh event** (`app.rs::run` Event/Autosave, `last-save.json`):
   status event unchanged → debounce theo `debounce_ms` + cùng generation; **detection event
   naming new invocation → bypass**; status khác session/cwd với entry đã lưu → bypass; core hook
   save `--force` không debounce nhưng snapshot giống hệt → `refresh_latest` (không archive —
  不然 đẩy state thật ra khỏi retention). Timeout metadata → **giữ snapshot trước đó** thay vì
   lưu dở.
10. **Timer không daemon, không polling** (`timer.rs`): pane split; Linux signalfd, macOS kqueue
    với timeout = interval; shutdown làm final save — trừ host Core (mọi pane đang chết → idle
    giả) — và hook bỏ save khi last status 129/137/143, cùng một nguyên tắc ở 2 tầng khác nhau.
11. **Atomic write có phân loại lỗi** (`store.rs::atomic_write`): tempfile cùng dir + fsync file
    → rename → fsync dir; lỗi sau rename được báo "durability uncertain" (không im lặng, không
    giả định OK); input O_NOFOLLOW + size cap 8MiB + regular-file check; dir 0o700 + owner check.
12. **Named-space library 2 khóa có thứ tự** (`store.rs::Store`): session lock trước, library
    lock sau — thư tự quy ước tránh deadlock; space JSON validate chặt tên (1..64 ASCII), import
    cross-session yêu cầu mapping 1-1 tường minh.
13. **UI dialog = thin client 1 nguồn sự thật** (`mods/herdr-revive/main.js`): chỉ `status` đọc,
    mọi button = chạy CLI + đọc lại status; không state副本 trong JS, không timer poll. Lỗi hiển
    thị = dòng `herdr-revive:` cuối cùng (warning từng pane đi trước).
14. **Benchmark kỷ luật** (`docs/MATCHED_BENCHMARK.md`, `scripts/benchmark_matched.py`,
    `bench-chart.py`): so **whole implementations** trên cùng session thật 100 panes, median 30
    fresh launch, p95 kèm theo, raw samples JSON commit vào repo, chart sinh từ chính sample đó
    (không vẽ tay), tài liệu nêu pin commit đối thủ + cách reproduce từng bước.

## Áp vào herdgate (checklist)

Cao:
- [ ] Journal write-ahead cho mọi thao tác đột biến (rebuild worktree pipeline, khôi phục agent
  batch): persist trạng thái `sending` TRƯỚC khi mutate, `pending` block thao tác kế, ack tường
  minh không auto-retry — thay cho retry mù trong publisher hiện có.
- [ ] Generation/identity versioned cho mọi state path của herdgate (receipt JSONL, workspace
  state): namespace `<tool>\0<vN>\0<canonical path>` để đổi tên/refactor không mất state cũ;
  native_tool() chấp nhận tên cũ khi đọc.
- [ ] Nguyên tắc revalidate-per-mutation: trước mỗi tác động lớn, reload config/state từ disk +
  kiểm identity thực thể + idle/busy thật (process tree) — không tin label snapshot cũ.
- [ ] Debounce theo ngữ cảnh: event trùng nội dung → debounce; event chỉ ra thay đổi mới
  (id/cwd khác) → bypass ngay; save không đổi gì → chỉ refresh timestamp, không đẩy bản lưu
  thật ra khỏi retention window.
- [ ] Shell encode vị trí (`exec "$@"` + argv positional) cho mọi lệnh herdgate gửi vào pane/
  terminal; cấm control char + arg '-' làm value; không bao giờ ghép string vào shell source.
- [ ] Proven-command cache keyed `[pid,ppid,pgid,start]` cho process publisher không đọc được
  (permission/setuid) — tái dùng bằng chứng chỉ khi cùng process còn sống, tự hết theo generation.

Trung bình:
- [ ] UI/PWA herdgate theo mô hình dialog main.js: 1 endpoint status là nguồn sự thật, action chỉ
  chạy rồi đọc lại — bỏ state song song client-side.
- [ ] Atomic write phân loại lỗi (tempfile+fsync+rename+dir-fsync, "uncertain durability" báo
  rõ) cho mọi file state của publisher.
- [ ] Benchmark matched nội bộ (so bản cũ/bản Node trước khi thay): median 30 + p95 + raw JSON
  commit + chart sinh từ sample.
- [ ] Timer/background waiter dùng kqueue/signalfd (0 polling) nếu herdgate có tiến trình chờ
  dài; final-save tắt trên đường shutdown khi mọi đối tượng đang chết (tránh snapshot idle giả).
