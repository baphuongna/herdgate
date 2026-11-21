# Đào sâu tầng 2 — miko-misa/herdr-portfwd (0.2.1, Rust, ~26k dòng src)

Đào trên clone `/tmp/deep/portfwd`. Tầng 1 (`../r-portfwd.md`) đã tóm mechanism chính — bản này KHÔNG lặp, chỉ mở rộng: module graph, máy trạng thái, cơ chế mới chưa nêu (symlink-defense, merge reconcile, routing action/pane, remote stderr marker, cleanup panic-safe), và cách test. Repo 33.8k dòng (Rust src ~26k) → đọc trọn 15 module lõi + toàn bộ ARCHITECTURE.md + 2 test file + harness tests/cli.rs.

## Kiến trúc đầy đủ (module graph: ai gọi ai, dữ liệu chảy thế nào)

```
main.rs (2941) ─── duy nhất chỗ chọn implementation thật (SshProcess, HerdrCli::local, SystemPorts...)
 ├─ cli.rs (178)          parse argv thuần
 ├─ config.rs (664)       hosts.toml (share với herdr-mirror) + settings.toml; parse_hosts(&str) thuần
 ├─ context.rs (866)      HERDR_PLUGIN_CONTEXT_JSON → Invocation + resolve_host 4 mức + PluginInvocation (action/pane/other)
 ├─ actions.rs (5086)     scan/add/stop/stop-all/open-url/list/status/reconcile — tổ hợp qua trait
 │   ├─ discover.rs (979) parse lsof/ss/ps thuần + ProcessTree::ancestry + attribute()
 │   ├─ ssh.rs (164)      trait SshRunner + control_socket_path (sun_path ≤103B)
 │   ├─ ssh_process.rs (1186) argv builders thuần + SshSpawner (chỗ spawn thật duy nhất của module)
 │   ├─ herdr.rs (117)    trait HerdrClient {pane_list, pane_list_labelled, shell_pid, notify}
 │   ├─ herdr_cli.rs (1730) HerdrCli<R: HerdrRunner> local/remote + parse JSON + shell_quote
 │   ├─ state.rs (1506)   Store(forwards.json) trên JsonFile<T> chung
 │   ├─ request.rs (1084) RequestLog(requests.json) + ACK_FILE fold
 │   └─ confirm.rs (257)  ConfirmState — payload click đi vào pane qua env var
 ├─ local_agent.rs (4824) Agent::step/run (poll) + Attach::run (supervise) + RemoteRequests qua ssh cat
 └─ ui.rs (5564)          render thuần snapshot→bytes; Handoff trả về cho main thay vì tự mở pane
```

Dòng dữ liệu (mode `--remote`): click URL → plugin chạy TRÊN host → `parse_loopback_url` re-validate → placement=Remote → `RequestLog::enqueue_opening` ghi `requests.json` (dưới flock) → local agent (máy người ngồi) poll qua master SSH riêng → `handle_request` → `ssh -O forward` trên master của agent → ghi record vào Store local → ack bằng `remote_mark_command(id)` viết `requests.acked` = 1 số nguyên qua temp+mv → mọi lần đọc queue bên remote fold mark (`settle_to`) → `list/status` bên remote không báo "đang chờ" nữa. Mirror mode: cùng pipeline nhưng requests.json local, applier = chính process.

Điểm kiến trúc đáng chú ý nhất: **main.rs là mối nối duy nhất giữa thế giới thật và phần thuần** — mọi module dưới đều chỉ nhận trait object; `wired()` build `Ctx` một frame để lifetime trait object khớp. `HostServers` (main.rs:225) chọn herdr client per-host: master sống → `HerdrCli::remote` qua master, không → fallback local server.

## Máy trạng thái & luồng chi tiết

**1. Request lifecycle (request.rs:397-)** — queue có high-water mark hai lớp (trong file + ACK file):
```rust
fn settle_to(queue: &mut Queue, mark: u64) -> Vec<Request> {
    queue.last_consumed_id = queue.last_consumed_id.max(mark);
    let cut = queue.last_consumed_id;
    queue.pending.retain(|request| {
        if request.id <= cut { settled.push(request.clone()); false } else { true }
    }); settled
}
```
`apply_push` (request.rs:351) là luật idempotency thuần: `id <= last_consumed_id` → Stale; trùng id hoặc trùng `key()`=(host,local_port) → Superseded (chỉ khi id mới hơn); ngược lại Accepted. TTL 10 phút, `age_ms` saturating nên clock-skew (timestamp tương lai) đọc age 0 — không expire request mới.

**2. Agent cursor chỉ tiến qua "run liền không đứt"** (local_agent.rs:842-860):
```rust
let mut cursor = self.state.last_applied_id;
let mut stalled = false;
for request in pending {
    if self.handle_request(&request, now, report) {
        if !stalled { cursor = request.id; }
    } else { stalled = true; }
}
```
Request fail (port bị chiếm) → `false` → mọi request sau nó KHÔNG được đánh dấu dù đã áp dụng thành công — mark không được nhảy qua một request chưa settle. `mark_read` (local_agent.rs:322): pass đầu tiên PHẢI đọc `settled_mark()` trước khi áp dụng gì — "guessing zero here is how a restart re-opens a port the user stopped a minute ago".

**3. Routing action/pane/shell (main.rs:231-247, context.rs `pane_to_open`)**:
```rust
fn route<'a>(interactive: bool, nothing_was_named: bool,
             plugin: &'a PluginInvocation) -> Route<'a> {
    if !nothing_was_named { return Route::Run; }
    if let Some(plugin_id) = plugin.pane_to_open() { return Route::AskHerdr(plugin_id); }
    if interactive { return Route::Pane; }
    Route::Refuse
}
```
`pane_to_open` = (kind==Action && herdr_bin.is_some()) → Some(plugin_id). Pane command luôn `None` (đệ quy-guard: pane không được hỏi pane nữa). `interactive` đòi stdin VÀ stdout đều tty VÀ `!json`. Thứ tự "Herdr trước terminal" là sửa bug thật: server chạy foreground (`herdr server`) để plugin command inherit tty của nó → `is_terminal()` trước sẽ vẽ picker vào plugin log và ăn phím của chính Herdr. `handoff_placement` (main.rs:286): popup→popup phải `--placement overlay` vì Herdr chỉ có 1 popup slot — pane đang giữ slot của chính nó.

**4. Reconcile merge optimistic (actions.rs:1958-1996 `merge_reconciled`)**: pass đọc snapshot, quyết định qua nhiều giây SSH không giữ lock, rồi `store.update` merge: record còn **byte-identical** với snapshot → thay bằng quyết định của pass; record khác đi (ai đó add/stop giữa chừng) → giữ nguyên. Trả về `superseded` = record pass muốn keep mà biến mất → `absorb_supersession` (actions.rs:1706) còn **cancel lại forward vừa re-add** cho record đó — invariant 3 (không forward nào sống mà không có record).

**5. Attach supervision (local_agent.rs:1470-1530)**: đảm bảo master → spawn agent background (log riêng `<host>.ctl.agent.log`) → spawn `herdr --remote` trên terminal → supervise 100ms/tick; signal → SIGTERM client + `TERMINATE_GRACE_TICKS=100` rồi ép teardown. KHÔNG execve: "a replaced process cannot tear down the master it started". Mọi exit path qua một `Cleanup` (Arc<AtomicBool> chạy 1 lần) + `CleanupGuard` (Drop) + `install_panic_cleanup` — vì release build `panic=abort` không chạy destructor.

## Mọi cơ chế áp vào herdgate

Mỗi mục: excerpt thật + file:line + áp vào đâu của herdgate + vì sao.

**1. State dir ownership check — refuse dir người khác ghi được** (state.rs:613-650):
```rust
let me = unsafe { libc::geteuid() };
if metadata.uid() != me {
    return Err(unsafe_because(format!("it belongs to uid {}, not to uid {me}", metadata.uid())));
}
let mode = metadata.mode() & 0o777;
if mode & 0o002 != 0 {
    return Err(unsafe_because(format!("its mode is {mode:04o}, which lets anybody write in it")));
}
```
→ áp: mọi dir state của herdgate trên VPS (receipts, registry, spawn dirs) khi thêm writer machine-local. Vì sao: record quyết định port/command nào chạy — dir ghi được bởi user khác = chiếm quyền. Ghi chú: bản Node dùng `fs.statSync` uid/mode tương đương, group-writable auto-tighten (state.rs:655) thay vì refuse là chiều nhân từ đáng học.

**2. Temp file O_EXCL + tên không đoán được — chống symlink plant** (state.rs:700-718):
```rust
fn temp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|since| since.subsec_nanos()).unwrap_or(0);
    dir.join(format!(".{name}.tmp-{}-{seq}-{nonce:08x}", std::process::id()))
}
```
+ `create_new` (O_EXCL, mode 0o600) — "the latter follows a symlink somebody else planted at a guessable name and writes this file's JSON wherever that link points, as us" (state.rs:680). Test `a_planted_symlink_is_refused_rather_than_written_through` (state.rs:1006) plant symlink thật ở tên temp để pin hành vi. → áp: mọi chỗ herdgate ghi JSON dùng temp+rename trên VPS (`/tmp`-adjacent càng cần). Vì sao: herdgate relay chạy multi-user VPS — đây là lỗi bảo mật thật, không phải lý thuyết.

**3. Byte-stable output: sort trước khi ghi** (state.rs:471 `dedupe_by_key` — last-writer-wins theo key rồi sort theo (host, local_port)) "so the file is byte-stable across processes and diffable by a human". → áp: receipts/registry JSON herdgate — cùng input → cùng bytes → diff/audit/sync-friendly. Vì sao: rẻ, và biến file state thành thứ người đọc được khi debug.

**4. ACK = 1 số nguyên, file riêng, chỉ tiến** (request.rs:44-52 + local_agent.rs:287):
```rust
"t=\"$p/requests.acked.$$\"; \
 printf '%s\\n' {id} > \"$t\" && mv \"$t\" \"$p/requests.acked\"; fi; fi"
```
Writer không link được code applier (chỉ có shell) → không thể lấy lock → mark là payload nhỏ nhất có thể atomic-từ-shell (temp+mv), unreadable đọc là 0 vì "the mark can only ever *remove* requests" — hướng an toàn là "chưa apply". `remote_mark_command` guard `[ "$o" -ge {id} ]` để không bao giờ lùi; chỉ interpolate một `u64`. → áp: chiều ack-back cho queue指令 herdgate→publisher khi publisher chỉ shell-reachable. Vì sao: khớp receipts JSONL one-way hiện có, thêm chiều xác nhận mà không cần shared lock.

**5. Cursor unbroken-run + not-ours cũng settle** (local_agent.rs:842 trên; `is_ours` local_agent.rs:960): request tên host thứ ba "counts as settled... Leaving it unsettled would stall the mark behind it and keep every later request pending forever". → áp: mọi worker-queue của herdgate (jobs trên VPS): item không phải của mình vẫn phải được đánh dấu processed, nếu không một item lạ đốt cả queue. Vì sao: fail-safe hướng "queue không đơ" quan trọng hơn "chắc chắn bỏ qua đúng".

**6. Open-once per id, ring có giới hạn** (local_agent.rs:914-930):
```rust
if self.state.opened.contains(&request.id) { return; }
...
if self.state.opened.len() >= MAX_REMEMBERED_OPENS {
    self.state.opened.remove(0);
}
self.state.opened.push(request.id);
```
Key theo **request id**, không theo URL — click thứ hai cùng URL là request mới, xứng đáng có window mới. Bounded 64 vì "an unbounded set is memory a compromised remote can grow for free". → áp: dedup notification/side-effect theo event-id (không theo nội dung) + ring buffer giới hạn trong publisher/PWA worker. Vì sao: chống spam + chống memory-exhaustion từ remote trong một cấu trúc duy nhất.

**7. Merge-reconciled optimistic concurrency** (actions.rs:1958, excerpt mục §4 trên):
→ áp: mọi "sweep" của herdgate quét registry rồi quyết định chậm (gọi qua SSH/HTTP): merge theo "chỉ overrule record còn nguyên vẹn như lúc đọc"; record ai đó đổi giữa chừng là của người đó. Kèm undo: nếu pass vừa tạo side-effect (spawn/re-add) cho record đã bị ai xóa → undo side-effect đó. Vì sao: herdgate có nhiều actor (agent, human CLI, cron) — replace-whole-file sau sweep dài là chỗ mất dữ liệu kinh điển.

**8. Remote stderr qua marker trên stdout** (herdr_cli.rs:585-600):
```rust
Ok(format!(
    "{{ e=$({command} 2>&1 1>&3 3>&-); s=$?; \
     printf '{marker}%s\\n%s' \"$s\" \"$e\"; }} 3>&1",
    marker = REPORT_MARKER
))
```
Vì `SshRunner::exec` đã nuốt stderr remote (giữ dòng đầu) nên refusal của lệnh xa không bao giờ tới nơi — snippet dùng fd 3 đưa stdout đi thẳng, capture stderr, in status+stderr sau marker `\n#herdr-portfwd:status=`; parse lấy marker **cuối cùng** (`rsplit_once`) để payload chứa trùng text không đánh lừa được. Snippet exit 0 bất kể lệnh — exit ≠ 0 chỉ còn nghĩa là ssh fail. → áp: mọi chỗ herdgate chạy lệnh qua SSH và cần error-message thật của lệnh (hiện đang mất stderr nếu dùng pattern ssh đơn giản). Vì sao: đây là bug "log đọc vô ích" rất dễ mắc và fix rất gọn.

**9. Word-by-word shell quoting một vòng** (herdr_cli.rs:624 `shell_quote`): `'` → `'\''`, bọc mỗi argv word. "ssh hands the remote command to a shell, so the argv has to survive exactly one round of shell parsing". → áp: bất kỳ herdgate exec nào qua ssh/shell -c. Vì sao: quy tắc "argv array, never shell" phải có ngoại lệ duy nhất và ngoại lệ đó phải được quote đúng — họ làm đúng bằng hàm 10 dòng + test pin.

**10. Confirm payload qua env, không qua file** (confirm.rs:12-35, 4 lý do): lifetime = pane (không cần dọn), không second-writer (2 click = 2 env), hoạt động unchanged qua `--remote`, không secret. Encode 1 dòng JSON; `decode` reject array:
```rust
if !value.is_object() {
    return Err("expected a JSON object".to_string());
}
```
— vì "Serde reads a struct whose fields all default out of a JSON *array* as happily as out of an object" → `[]` thành screen trắng thay vì lỗi. → áp: mọi chỗ herdgate parse JSON từ nguồn không tin (env, queue): luôn check `is_object()` trước `from_value`. Vì sao: gotcha serde/JSON này áp cho mọi schema-all-default — herdgate có nhiều chỗ parse JSON lỏng như vậy.

**11. Kèm placement đã quyết theo click** (main.rs:895-915 `confirm_env`): host override `HERDR_PORTFWD_HOST` sẽ âm thầm tắt rule `WorkspacePrefix` — nên gửi kèm cả `MODE_ENV` "Placement is decided once, by the click, and the pane inherits the answer". → áp: khi herdgate forward context giữa hai tiến trình (agent→CLI, server→worker): kèm **cả kết luận lẫn input**, không chỉ input — vì receiver re-derive từ context đã di chuyển sẽ ra kết quả khác. Vì sao: bài học tổng quát về "decision travels with the data".

**12. Đọc status = không được thành failure nó đang tả** (actions.rs:1907-1960 `status`): mỗi read fail thành field (`state_error`, `request_error`), giá trị thành `null` "rather than an invented `0`", vẫn exit non-zero. → áp: lệnh `status`/`doctor` của herdgate: bán tài liệu, không chết giữa chừng; exit code nói run đó fail, report vẫn đầy đủ. Vì sao: user chạy status đúng lúc thế giới hỏng — chết ở đây là mất đúng thông tin cần nhất.

**13. Scope cho print vs pane: "narrows what it shows, never what it holds"** (actions.rs:1345 `list_for_pane` + ARCHITECTURE): CLI `--host` narrow list in; pane luôn giữ mọi row + `focus` làm filter mở đầu — cùng mechanism với phím `h`. → áp: nếu herdgate có TUI/dashboard: filter là state của view, không phải của query. Vì sao: header mô tả scope mà rows không khớp là bug UI đã xảy ra thật ở chính repo này (CHANGELOG 0.2.1).

**14. Ghi nhận một lần + re-offer khi đối tượng biến mất rồi quay lại** (local_agent.rs:1005): `handled: HashSet<u16>`, đầu mỗi pass `handled.retain(|port| live.contains(port))` — port mất → unmark → khi quay lại sẽ offer lại; port còn → im. Tách riêng `reported` (fail đã báo) KHÔNG prune theo listener vì "a port that failed to open here has nothing to do with what is listening on the far side". → áp: notification/dedup các job-event của herdgate cần cùng cặp set: offered (theo sự sống của đối tượng) vs reported-failure (theo port/target, sống độc lập). Vì sao: tránh spam theo poll mà vẫn không bỏ im lặng vĩnh viễn.

**15. Probe memory per host** (local_agent.rs:1100 `listeners()`): host không có `lsof` thì nhớ `Probe::Ss` để pass sau hỏi thẳng cái có — không thử lại chuỗi fail mỗi tick. → áp: mọi feature-detection lặp của herdgate (lệnh nào có trên máy remote) — cache kết quả probe theo máy. Vì sao: tiết kiệm + log sạch.

**16. Validate hostname thành filename** (main.rs:1103): reject `/`, `\0`, `.`, `..` vì `<dir>/<name>.ctl` là socket path. → áp: mọi chỗ herdgate nhét tên user-config vào path (spawn dirs theo tên job). Vì sao: cùng một dòng chảy dữ liệu name→path, cùng một bug.

**17. Exit code convention** (main.rs:107 `EXIT_INTERRUPTED=130`; local_agent.rs:1355 `exit_code` = 128+signal): → áp: herdgate CLI wrap process con — phân biệt "fail" với "bị giết", để log không đọc agent bị Ctrl+C như plugin hỏng. Vì sao: 1 dòng, đổi màu cả troubleshooting.

**18. Manifest là nguồn chân lý của test** (tests/cli.rs:351-438): test đọc `herdr-plugin.toml` thật, assert mọi argv manifest khai báo (a) chạy không panic (b) chạy được cả khi zero-config (c) id plugin/pane binary hardcode khớp manifest — "the two are not allowed to be two lists". → áp: herdgate nếu có config khai báo action/command: test đọc config thật thay vì copy list. Vì sao: chống drift cấu hình↔code không cần codegen.

## Cách họ test (pattern đáng học cho suite 213 test của ta)

Tổng ~865 test (835 #[test] đếm được: 763 unit inline + 72 integration + signals). Ba lớp:

**Lớp 1 — unit inline, pure-over-fixtures**: mọi parser (`parse_lsof`, `parse_ss`, `parse_ps`, `parse_mark`, `parse_pending`), mọi luật (`apply_push`, `merge_reconciled`, `settle_to`, `route`, `promoted`, `clamp_remote_bind`) là hàm thuần nhận `&str`/values — test không chạm fs/mạng. Env không bao giờ đọc trực tiếp: mọi module có `from_lookup(F: Fn(&str)->Option<String>)` cạnh `from_env()` (context.rs:172, confirm.rs:135) — "the whole environment-facing surface, kept as one function so tests need no process-global state". Clock tương tự: `Clock` injected, "every timestamp in a test is chosen by the test".

**Lớp 2 — fs thật trong TempDir cho state**: concurrency test thật (`concurrent_writers_lose_no_records` state.rs:1419) dùng flock thật — flock per-open-description nên 2 handle trong 1 process contended như 2 process. Symlink-attack test plant symlink tại chỗ `create_temp_file_named` với name-generator injected (state.rs:690: "A test cannot guess a production temp name — so it supplies its own and plants a symlink there"). Backward-compat test format: `a_request_with_no_url_serializes_exactly_as_it_did_before_the_field` (request.rs:511) pin bytes cũ — field optional mới KHÔNG đổi file của writer cũ.

**Lớp 3 — black-box binary với sandbox lệnh giả** (tests/cli.rs:48-200): `PATH` = đúng 1 dir chứa script giả (`ssh` giả **log rồi exit 255** — "an invocation has to be both visible and useless"; herdr giả trả JSON theo subcommand; lsof/ss/ps/open giả in fixture); `env_clear()` rồi set HOME/XDG/HERDR_* — "an inherited HERDR_* or a real PATH would make these tests depend on the machine"; `HERDR_BIN_PATH` trỏ vào dir KHÔNG trên PATH để pin đúng biến đó. `Run::new` tự assert mọi lần chạy: không chứa "panicked at" + có exit code (không chết bởi signal) — "a release build aborts on panic, and an aborted plugin command leaves Herdr's log with nothing to read". Panes test bằng stdin bytes + EOF (`run_with_stdin`): pane đọc keys là bytes vì không phải tty — đúng hành vi khi Herdr capture streams. Liveness test bind port thật (`held_loopback_port()` tests/cli.rs:1990) để đếm live vs recorded là thật. `tests/signals.rs` là binary riêng vì signal handler dùng static process-global — comment giải thích tại sao không trộn vào suite.

Bài học cho herdgate: (a) harness sandbox-PATH cho e2e CLI Node (child_process với PATH chỉ chứa stub + env sạch) thay vì mock module; (b) mỗi assert chạy kèm invariant chung ở wrapper `Run`; (c) pin-serialisation-cũ khi thêm field optional; (d) tách test cần process-global state ra file riêng.

## Anti-pattern / không lấy gì

- **SSH ControlMaster làm transport ngầm + 4 candidate dir probe** (`remote_state_dir!` local_agent.rs:230 sniff 4 đường dẫn vì plugin cũ/mới đặt state chỗ khác): đây là nợ version-skew họ phải trả vì chọn SSH+shell làm RPC. herdgate có gate VPS + channel riêng — đừng tự tạo lớp transport thứ 3 rồi phải viết probe như vậy.
- **Poll 5s cố hữu** (bị nhốt bởi `PLUGIN_HOOK_EVENT_KINDS` của Herdr không cho hook pane output): herdgate publisher event-driven trực tiếp được — polling ở đây là bù đắp thiếu sót platform, không phải thiết kế đáng bắt chước.
- **Backoff chỉ `2^n * base` cap 60s, không jitter** (local_agent.rs:346): đủ cho 1 agent 1 host; herdgate nếu có nhiều worker chung mục tiêu thì cần jitter tránh thundering herd.
- **Mac/Linux-only, lsof/ss/ps per-platform, binary Rust fetch theo platform** (scripts/install.sh, 202 dòng): không khớp stack Node single-binary của herdgate.
- **UI 5.5k dòng ANSI thủ công** (display_width CJK, ASCII-only chrome): chất lượng cao nhưng là bài toán của plugin-TUI; herdgate PWA/web — chỉ值得 lấy ý sanitize-escape-sequence (ui.rs:179) cho bất kỳ chỗ nào render text từ remote.
- **`#[serde(default)]` envelope nhưng record fields bắt buộc** (state.rs:33-46): họ arguy cẩn thận ("guessed as Auto it drops a forward the user pinned") — nhưng herdgate records có default hợp lý ở nhiều field; copy nguyên tắc "required on the way in" phải case-by-case, đừng máy móc.
- MIT license — dùng ý tưởng OK, port code phải giữ attribution.

## File đã đọc (đầy đủ danh sách + dòng đã đọc)

Clone `/tmp/deep/portfwd`, commit HEAD `depth 1`:
- `src/lib.rs` 1-39 (full) — crate docs, PLUGIN_ID + rationale manifest-drift test
- `src/state.rs` 1-733 (toàn bộ implementation; test names scan 734-1506: symlink/damaged/concurrent)
- `src/request.rs` 1-397 (toàn bộ implementation; test names scan 398-1084)
- `src/discover.rs` 1-390 (toàn bộ implementation)
- `src/confirm.rs` 1-150 (toàn bộ implementation)
- `src/context.rs` 1-418 (toàn bộ implementation)
- `src/types.rs` 1-263 (full cả tests inline)
- `src/herdr.rs` 1-117 (full)
- `src/ssh.rs` 1-164 (full)
- `src/main.rs` 1-1300 (wiring, Ctx, dispatch, route/scan_route/open_url_route/pane_route, panes callbacks, confirm_env, stop_summary, validate_host_name, exit codes; 1301-1595 render funcs — lùi ở phần đã hiểu)
- `src/actions.rs` 1-2049 (toàn bộ implementation: Env, placement, parse_loopback_url, add/apply_or_request_opening, open_url_for, preview_open_url, scope/list/list_for_pane, stop/stop_rows/stop_forwards, scan, reconcile/merge_reconciled/absorb_supersession, status, matching_port)
- `src/local_agent.rs` 1-1763 (toàn bộ implementation: seams, RemoteRequests + remote snippets, AgentState, Agent::step/run/apply_requests/handle_request/open_requested_url/discover/consider, Cleanup/signal, Attach/supervise, tear_down, attach_main/local_agent_main)
- `src/herdr_cli.rs` 1-635 (toàn bộ implementation: HerdrRunner, argv builders, parsers, command_failure, remote_report_line/parse_report, shell_quote)
- `src/config.rs` 1-354 (toàn bộ implementation)
- `src/ssh_process.rs` 1-150 (+ tầng 1 đã đọc argv builders; SshSpawner/run_forking mới đọc)
- `src/ui.rs` 1-60 (module docs) + cấu trúc scan (sanitize, Listing, Tally, Handoff, Outcome, open_*)
- `tests/cli.rs` 1-350 (toàn bộ harness Sandbox/Run/manifest-truth) + names của cả 72 test (list đầy đủ qua grep)
- `tests/signals.rs` 1-33 (full)
- `docs/ARCHITECTURE.md` 1-506 (full: 10 facts, pane-told-something, request/apply diagram, settling, attribution, automation table, module table, "record is not a port", 13 invariants, non-goals)
- `CHANGELOG.md` 1-60 (0.2.1 — các bug scope/liveness thật)
- `.github/workflows/ci.yml` (scan: fmt+clippy -D warnings, test 3 OS, MSRV check, manifest validate, install.sh asset check)
- `justfile` (full: check/link/unlink/logs workflow)
- Tầng 1 đã đọc trước đó: README.md, README.ja.md (skim), herdr-plugin.toml, Cargo.toml, ssh_process argv builders

Tổng: 22 file đọc tầng 2 (17 trong số đó đọc trọn phần implementation), cộng 6 file tầng 1.
