# Đào sâu tầng 2: cantona/herdr-revive @ v0.3.1 (clone /tmp/deep/revive)

Nâng cao của `r-revive.md` (tầng 1) — không lặp lại; mọi phát hiện dưới đây là mới sau khi đọc
trọn src lõi + CONTRACTS/PARITY/VALIDATION + 3 suite test. Repo: 25.448d Rust src, 8.418d test,
7 crate dep (anyhow/clap/fs2/serde/serde_json/sha2/tempfile/toml + nix unix), `unsafe_code=deny`.

## Kiến trúc đầy đủ (module graph + dòng dữ liệu)

```
main.rs ──setup_request──▶ core/setup.rs (+install.rs)   ─ install/uninstall: plan → y/N
      ──migrate_request─▶ migrate/{mod,to_app,to_tui,remote,ledger,external,tree,tui}
      ──còn lại────────▶ app::run
app.rs ──▶ capture.rs ──▶ platform.rs ─▶ platform/{linux,macos}.rs   (/proc, kqueue/proc_info)
  │  ├─▶ planner.rs (pure: saved+live+config → Decision per pane)
  │  ├─▶ store.rs (identity/lock/atomic/retention)   ├─▶ transport.rs (Host trait; Direct socket/CLI)
  │  ├─▶ layout.rs (BSP capture/preview/rebuild + RebuildJournal)   └─▶ core/{host,rpc,paths}.rs
  │  ├─▶ timer.rs (signalfd/kqueue loop → app::run autosave --force)
  │  └─▶ core/hook.rs (bash snippet + hints file, dùng bởi init/save)
UI: mods/herdr-revive/main.js (GPUI) + scripts/manage.sh — cả hai chỉ gọi CLI, không state riêng.
```

Dòng dữ liệu save: `host.snapshot()` (1 lần) → `process_table()` (1 lần) → mỗi pane
`process_info` → idle? → argv/cwd/stdio từ /proc → CommandSpec → `snapshot.validate()` →
`store.save` (archive+latest+retention) → `last-save.json` + `protected.json`.
Dòng restore: settle sleep → snapshot → `planner::plan` → journal pending → **per pane: revalidate
(generation + reload config + allowed_argv + pane identity + idle) → Sending persisted → run →
Applied** → Done vào `boots/<claim>.json`, xoá pending. `Host` trait có 3 "năng lực khai báo"
(`supports_layout`, `reports_agent_sessions`, `command_hint`) — app tự hạ cấp hành vi theo host
thay vì if/else rải rác (transport.rs:22-40). Core host (`CoreHost::connect`, RunMode
Emit/Send) và Herdr transport cùng implement `Host`; `HostImpl` enum dispatch (app.rs:238).

Điểm mới so tầng 1: (a) `capture` và `migrate` dùng chung qua `capture_noting` trả warnings cho
caller thay vì in (capture.rs:53); (b) layout rebuild có journal **riêng** `rebuild-pending.json`
+ `operations/<id>.json` + `operations/<id>-snapshot.json` (snapshot nguồn được đóng băng ngay
khi bắt đầu — layout.rs:455-460); (c) hai đường "boot claim": generation tự động hoặc claim thủ
tục `digest("manual:<gen>:<now>:<pid>")` cho rehydrate lặp lại trong cùng generation
(app.rs:2115-2123).

## Máy trạng thái & luồng chi tiết

### 1. Restore journal — `Unclaimed→Restoring→{Sending,Applied,Skipped,Failed}→Done`
Nếp lõi: **persist `Sending` TRƯỚC khi gửi**, mọi chuyển state đều ghi đĩa (app.rs:1005-1040):

```rust
fn send_entry(...) -> Result<Outcome> {
    // Persist Sending before any operation that might write to a pane.
    journal.entries[i].outcome = Outcome::Sending;
    persist_pending(store, journal)?;
    let result: Result<Outcome> = (|| {
        let Some(text) = revalidate(&mut journal.entries[i], pane, entry, host)? else {
            return Ok(Outcome::Skipped);
        };
        host.run(&pane.pane_id, &text)?;
        Ok(Outcome::Applied)
    })();
```

Lỗi giữa chừng: `state=Failed` + persist + Err với context "restore stopped; inspect recovery
evidence before any further save/restore" — `require_clear` chặn cả save lẫn restore KỂ CẢ
cross-boot; `recovery acknowledge` chỉ đánh dấu Done+acknowledged, **không bao giờ retry**
(test `one_claim_per_boot_and_no_retry_after_ambiguous_failure`, contracts.rs:790). Crash trước
`run` (panic trong revalidate) để lại đúng `outcome=Sending` — test catch_unwind chứng minh
(contracts.rs:846). Phân biệt với tầng 1: `execute_pane` cho host core thêm ngữ cảnh relaunch
per-shell: boot record **mọc thêm 1 entry/pane/generation**, pane đã ghi rồi → `None` (không
chạy lại); `acknowledged` chỉ mô tả send chưa giải quyết cuối cùng (app.rs:1053-1095).

### 2. Capture — máy 2-attempt dùng chung 1 budget (capture.rs:103-125)

```rust
fn attempt_twice<T>(budget: Duration, warnings: &mut Vec<String>, keep_discarded: bool,
    mut once: impl FnMut(&mut Vec<String>, Instant) -> Result<Option<T>>) -> Result<T> {
    let start = warnings.len();
    let record_until = std::time::Instant::now() + budget;
    if let Some(captured) = once(warnings, record_until)? { return Ok(captured); }
    if !keep_discarded { warnings.truncate(start); }   // discard warnings của lần bỏ
    once(warnings, record_until)?.context("panes kept changing during capture ...")
}
```

Lý do 2 lần: metadata wait có thể trải qua pane/layout đổi + chương trình mới khởi động giữa 2
lần đọc process table → discard toàn bộ capture (trả `Ok(None)`) và lấy process table mới,
nhưng **deadline record giữ nguyên** — 2 deadline riêng = giữ session lock gấp đôi budget.
Test `both_capture_attempts_share_one_record_deadline` assert `deadlines[0]==deadlines[1]`.

### 3. Claude record — máy "not-ready có thể chờ, sai vĩnh viễn thì dừng"
`claude_recorded_session_waiting` (capture.rs:1349-1376): record JSON cắt giữa
(`serde Category::Eof`) → gói thành `RecordNotReady` và đọc lại đến deadline; record nguyên
vẹn nhưng sai schema → lỗi luôn, không chờ. Chốt thật: record chỉ tính khi **chính process này
ghi** (capture.rs:1265-1300):

```rust
Writer::Linux { domain } => {
    record.proc_start.as_deref() == Some(process.start.to_string().as_str())
        && match (record.pid_domain.as_deref(), domain) {
            (Some(written), Some(domain)) => written == *domain, _ => true }
}
// macOS: started_at(ms)*1000+999 >= process.start(µs)
```

và trên Linux, `started_at < btime` của /proc/stat → RecordNotReady "left by an earlier boot,
or the clock stepped forward" — phân biệt record cũ-boot với clock nhảy (không âm thầm `None`).
Grace 5s vì Claude đo được ghi record sau 1.3–3.3s (capture.rs:1326-1337).

### 4. Detection-event conflict guard (capture.rs:585-621) — máy trạng thái MỚI tầng 2
Khi event `pane.agent_detected`: argv có `--resume <id>` mà native metadata giữ `id` khác →
cấu trúc `expected=Some(id)`; vòng `command_with_metadata_retry` **chỉ chấp nhận native nếu
bằng đúng expected**, nếu không thì chờ metadata mới đến min(timeout,1000)ms; quá hạn →
`MetadataTimeout` → save **giữ nguyên snapshot trước** (`snapshot_retained`, app.rs:1774).
Kèm chuỗi ensure trong vòng chờ: pane identity, foreground group, argv/cwd, foreground tree,
và **đọc lại pane lần 2 xác nhận native không đổi giữa chừng** (capture.rs:530-540).

### 5. Hook bash — máy hint seq (core/hook.rs:66-77 + 226-247)
Mỗi shell ghi `<seq>\n<hint>` vào `hints/<pid>`; `__revive_retire` tăng seq khi lệnh kế/prompt;
save bị defer đọc hint **mới nhất** nhưng kiểm `hint_is_current(seq)` — save lấy hint seq cũ
bị vứt: một là `latest()` trước capture, hai là re-check `hint_seq` sau khi đọc process table
(app.rs:1360-1366, 1820-1827: "a newer command may have started in between and taken the hinted
one's place"). Hint chỉ tin khi 3 stream của shell còn là tty (`[ -t 0 ] && [ -t 1 ] && [ -t 2 ]`)
và từ khoá không phải function/alias — cả hai là builtin, 0 fork/lệnh.

## Mọi cơ chế áp vào herdgate

1. **Journal "sending" trước mutation + block-all + ack-no-retry** (app.rs:1005 + layout.rs:356-402).
   Layout còn journal **2 tầng**: step `sending` persist → gọi API → `applied` + ghi lại ID
   workspace/tab/pane tạo ra, để ack sau này biết đã tạo gì:
   ```rust
   journal.steps.push(Step { method: method.into(), source_id: source.into(),
       outcome: "sending".into(), ... });
   store::atomic_json(&store.root.join("rebuild-pending.json"), journal)?;
   let result = host.api(method, params, result_type)?;
   let step = journal.steps.last_mut().context("missing journal step")?;
   step.outcome = "applied".into();
   step.created_pane_id = ...;
   ```
   → herdgate: mọi pipeline đột biến (publish batch, worktree rebuild) đang có retry mù nên thay
   bằng pending-file này; file áp: `apps/publisher/*` + module receipt. Vì sao: bằng chứng
   crash-giữa-mutation phải tồn tại trên đĩa TRƯỚC khi mutation xảy ra, không reconstruct sau.
2. **Đóng băng snapshot nguồn vào operations/ trước khi rebuild** (layout.rs:455-460: ghi
   `<op>-snapshot.json` trước `rebuild-pending.json`). herdgate: trước batch dài, copy input
   state sang file operation riêng — recovery đối chiếu được đúng input đã chạy. Áp cho
   state/pipeline của workspace agent.
3. **attempt_twice với budget chung + truncate warnings** (capture.rs:103-125). herdgate: mọi
   thao tác "đọc thế giới rồi quyết định" (scan git status nhiều repo, đọc process) gặp race
   nên discard và thử lại đúng 1 lần trong cùng deadline/lock; warning của lần bỏ không lộ.
   Áp: job thu thập trạng thái repo/agent.
4. **Identity versioned giữ spelling cũ trong hash** (store.rs:24-41: hash chứa
   `cantona.herde-revive` — sai chính tả cố ý — cộng `native_tool()` nhận cả hai, model.rs:17).
   Test `rename_preserves_snapshot_and_boot_identity` chứng minh reader cũ vẫn được chấp nhận.
   herdgate: mọi path state (receipt JSONL, ledger) dùng namespace `<tool>\0<vN>\0<canonical>`,
   reader chấp nhận tên cũ 1 thế hệ. Áp: module store/state herdgate.
5. **Generation = boot_id + SO_PEERCRED pid + start ticks; identity connection đếm riêng**
   (platform/linux.rs:459-484: connect 1 socket chỉ để đọc peer credential, `IDENTITY_CONNECTIONS`
   atomic; app.rs trả `identity_connections` tách khỏi `requests`). herdgate: kiểm "server còn
   là server đó" trước mỗi mutation bằng identity rẻ (không tốn API), metric tách bạch.
6. **Revalidate-per-mutation: reload config từ disk + generation + pane identity + idle**
   (app.rs:2119-2151 trong closure revalidate của `restore`). Đoạn chốt:
   ```rust
   let current_config = store::load_config(config_dir)?;
   ensure!(!automatic || current_config.auto_restore, "automatic restore disabled during execution");
   let argv = saved.command.as_ref().context("missing command")?.allowed_argv(&current_config)?;
   ... ensure!(live.workspace_id == saved.workspace_id && ... , "pane identity changed during restore");
   let Some(shell) = platform::idle_shell(&info)? else { return Ok(None); };
   ```
   herdgate: trước mỗi bước tác động lên worktree/repo, re-load config + xác minh entity còn
   đúng (path mtime? branch?) — không tin snapshot đầu chuỗi.
7. **Idle = fg group + mọi fg pid == shell + không con (kể cả con của thread khác)**
   (platform.rs:101-121; linux.rs:125-160 đọc `/proc/<pid>/task/*/children` từng thread, fallback
   full table; comment "checking only the main thread can miss background work"). herdgate:
   kiểm tra "agent đang rảnh/đang chạy" phải nhìn process tree thật, không tin label.
8. **Shell encode bằng vị trí + wrapper `exec "$@"` dựng động** (model.rs:484-497):
   ```rust
   let mut script = String::from("exec \"$@\"");
   for (fd, redirect) in null_stdio.iter().enumerate() { if *redirect {
       script.push_str(&format!(" {fd}{} /dev/null", if fd == 0 { "<" } else { ">" })); } }
   let mut launch = vec!["/bin/sh".into(), "-c".into(), script, "herdr-revive".into()];
   launch.extend(argv);   // argv là positional params, không interpolation
   ```
   herdgate: mọi lệnh ghép vào terminal/pane dùng đúng khung này; cấm control char
   (`validate_text`, model.rs:709) + value option không bắt đầu '-'.
9. **Proven-command cache keyed [pid,ppid,pgid,start] + scope generation** (capture.rs:23-40;
   app.rs:1520-1546 `load_proven` — file khác generation → rỗng, format cũ → rỗng, JSON hỏng →
   ERR). herdgate: cache "bằng chứng không đọc lại được" (repo private, process setuid) gắn
   identity 4 phẩn + thế hệ boot; cache khác thế hệ tự vô hiệu.
10. **Debounce chọn lọc theo event + refresh_latest** (app.rs:1584-1647 `agent_session_needs_capture`:
    `pane.agent_detected` → bypass luôn (UUID có thể tái dùng nhưng cwd/launcher đổi); status
    event so pane thật: agent không resumable → giữ debounce "or it would rotate the retained
    restore points out"; session/cwd khác snapshot → bypass; app.rs:1867-1880 snapshot giống
    hệt → `refresh_latest` không archive). herdgate: event bus phân loại "nội dung trùng →
    debounce / danh tính mới → bypass / không đổi → chỉ chạm timestamp".
11. **Timer: kqueue timeout=interval (0 polling), signalfd 50ms chỉ trong wait; final_save trừ
    host Core** (timer.rs:98-112 + comment: "a logout or shutdown signals every terminal at
    once, and a save then would record each dying pane idle"; hook bỏ status 129/137/143 —
    cùng nguyên tắc 2 tầng). herdgate: worker nền không polling; hành vi tắt máy phải nhận biết
    "mọi thứ đang chết" và không ghi state giả.
12. **Auto_off mặc định + exit-code contract của init** (app.rs:298-306: init luôn exit 0, lỗi
    chỉ hiện khi REVIVE_DEBUG=1, "A failure before the hook exists prints nothing; a later
    failure still prints the hook, which parses and so cannot break the shell"). herdgate:
    mọi đoạn shell nhúng vào rc/hook của user phải vô hại khi hỏng — im lặng hoặc vẫn parse.
13. **Danh sách năng lực host thay vì feature-flag rải rác** (transport.rs:22-40: Host trait
    default `supports_layout()=true`, `reports_agent_sessions()`, `command_hint()`). herdgate:
    adapter (local/ssh/CI) khai báo năng lực, tầng trên tự hạ cấp — thay if host==X khắp nơi.
14. **Dialog 1-lệnh-status + FIND shim PATH** (mods/main.js:17-20: `FIND` quét PATH của app +
    ~/.local/bin + ~/.cargo/bin rồi `exec "$f" "$@"`; mọi nút = `act()` chạy CLI xong
    `this.read()` lại; `locked` state cho `operation_in_progress`). herdgate: PWA/dialog
    desktop lấy đúng 1 endpoint status; lỗi hiển thị = dòng `herdr-revive:` CUỐI (warning pane
    đi trước) — hàm `summary()` main.js:33-36.
15. **Benchmark raw-sample commit trong repo** (docs/benchmarks/*.json 12 file, chart sinh từ
    sample bởi scripts/bench-chart.py; VALIDATION.md ghi cả binary SHA-256 + lock SHA-256).
    herdgate: benchmark herdgate cũng commit sample JSON + hash binary để tái lập.

## Cách họ test (bài học cho suite 213 test của ta)

- **Fake Host tối tiểu trong Rust unit** (contracts.rs:753-779): struct 2 field `runs/fail`,
  impl `Host` 4 hàm, dùng cho 6 test journal — assert cả **số lần `run()` gọi** (chống retry
  ẩn) lẫn thứ tự outcome `[Applied, Failed, Pending]` của partial failure.
- **Panic làm lỗi có thể kiểm chứng** (contracts.rs:846-860): `catch_unwind` quanh `execute`
  với revalidate panic → assert pending có `Sending` và `host.runs==0`. herdgate: test
  "crash giữa mutation" bằng panic-closure, không cần kill -9.
- **Round-trip thật vào bash/dash/zsh** (contracts.rs:471-500): sinh 88 argphabet tổ hợp
  `'`, ` `, `$`, `\`, `"`, `;`, `|`, `漢`, encode rồi exec thật, so stdout byte-đối-byte
  (`printf %s\0`), kèm assert `!NEVER_CREATED.exists()` — chứng minh không có expansion.
- **PTY thật + socket server giả trong Python** (integration.py:41-244): Fixture mở pty,
  bash `--noprofile --norc -i`, `TIOCSCTTY`, chờ marker `FIXTURE_READY>`; server socket
  thread trả lời JSON-RPC và **ghi mutation vào `self.mutations`**, `drop_mutation_reply`
  mô phỏng mất ack; `before_run` hook chạy code giữa lúc nhận request — đúng chỗ sinh race.
  Chương trình choàng argv là stub python ghi argv vào JSON để assert. herdgate: fixture
  host giả cần: đếm mọi mutation + khả năng bỏ reply + hook giữa request.
- **Behavior-test hook bằng bash thật** (core/hook.rs:700+): `bash()` helper chạy snippet qua
  `eval "$1"` trong bash -c, stub binary ghi log, `wait_lines` poll log có deadline; test cả
  trap/PROMPT_COMMAND chain, bash 3.2 quirk (`IFS=';' read` drop dấu `;`), bash-preexec
  interop, và pty-probe Python kiểm "shell còn sống sau Ctrl-C" cho 7 shell × 3 mode chạy
  song song `std::thread::scope`, **gom mọi case fail rồi in 1 lần**.
- **Contract-test song song hai hướng**: schema strict (`deny_unknown_fields` test cả field
  lạ), nhưng LiveSnapshot chấp nhận host version/future_field mới (contracts.rs:547-557).
- **Probe giao thức 1 lần rồi cache** (integration.py:27-37 `functools.cache cli_protocol()`):
  fixture CLI đọc protocol của herdr thật; thiếu herdr chỉ fail nhóm cli, direct vẫn chạy.
- VALIDATION.md ghi rõ cái test KHÔNG che: power-cut, disk-full, older host — "remaining
  qualification" thành checklist release-gate. herdgate: viết section này cho suite 213.

## Anti-pattern / không lấy gì

- **Bash SNIPPET 200 dòng nhúng trong Rust string** (core/hook.rs:87-347): maintain cực khó,
  phải viết test bash-3.2 riêng; herdgate không nhúng shell dài — thay bằng binary tự gọi
  + 1 dòng rc (như chính init làm).
- **shell_words tự viết** (capture.rs:833-886): mini-parser word-split đúng bash (giữ `"\d"`,
  từ chối `$`, backtick...) — chỉ đáng vì họ CẦN prove "typed line chỉ là plain words". Với
  herdgate dùng `shlex.split` + whitelist ký tự là đủ, không cần fork-semantic 100%.
- **SSH fd-triple scan + git-pager forensics** (linux.rs:240-457): quá đặc thù OpenSSH/Git
  nhị phân hệ thống; chỉ lấy tinh thần "verify bằng fd thật trước khi tin".
- **Ledger migrate 10.4k dòng** với ngữ nghĩa matching-by-terminal/label/survive-renumbering
  (CONTRACTS.md ~120d mô tả): độ phức tạp bùng nổ vì cho phép copy chéo máy 2 chiều + partial
  + renumbering; herdgate nếu làm sync chéo máy nên chốt 1 chiều + ID ổn định từ đầu.
- **Không có daemon/watcher** là chủ ý nhưng đồng nghĩa mọi update chỉ đến từ trigger — với
  herdgate cần watchdog thì đây là điểm KHÔNG sao chép; thay vào giữ nguyên tắc "mutation
  không bao giờ retry nền".
- **MetadataTimeout giữ snapshot cũ** đúng cho save định kỳ, nhưng gây "snapshot già" nếu
  user chỉ save 1 lần rồi rời — herdgate cần nút force + cảnh báo snapshot age trong UI.
- **Cấm hẳn relative executable + non-UTF-8** (model.rs:684-693): hợp lý cho tool phục chế
  lệnh; herdgate đôi khi cần relative path trong repo — không copy validate đó.

## File đã đọc (trọn file trừ ghi chú)

- src/ trọn: main.rs (59), lib.rs (14), store.rs (303), planner.rs (91), transport.rs (382),
  timer.rs (119), model.rs (859), app.rs (2499), capture.rs (2193), layout.rs (871),
  platform.rs (768), platform/linux.rs (523)
- src/core/hook.rs: 1-700 (toàn bộ SNIPPET + relaunch + hints + mở đầu test suite; 701-2012
  là test bash hành vi, đã nắm pattern qua helper + 6 đoạn test tiêu biểu)
- docs/: CONTRACTS.md (441, trọn), PARITY.md (84, trọn), VALIDATION.md (166, trọn);
  GUIDE.md: lướt mục lục + phần recovery/safety limits (702-732)
- mods/herdr-revive/main.js (378, trọn), scripts/manage.sh (74, trọn), herdr-plugin.toml
  (events/startup), Cargo.toml
- tests/: contracts.rs (1505, trọn), integration.py (1-330: Fixture + 5 test đầu; phần còn
  lại theo cùng pattern đã xác minh qua VALIDATION/PARITY), core_cli.rs (1-120), common/
  fake_core.rs (1-60)
- Chưa đọc chi tiết (đã định vị vai trò): migrate/* (10.4k dòng — ledger/remote), core/setup.rs
  + install.rs (plan/confirm), platform/macos.rs, các test python còn lại, docs/MACOS.md,
  RELEASE.md, GUIDE.md phần desktop.
