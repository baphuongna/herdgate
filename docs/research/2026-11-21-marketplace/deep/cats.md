# Đào sâu tầng 2 — zhiyao/herdcats (excavate toàn bộ)
Nguồn: clone /tmp/deep/cats (main, 2026-11-22). Quy mô: iOS 203 file Swift ≈66.6k dòng (Features 21.3k, Networking 5.5k, Support 4.8k, Models 2.8k; tests 21.8k dòng/44 file), bridge Rust 40.2k dòng (~10k là test), web Next.js 2.1k (site marketing, Cloudflare), compatibility Python ~1k, Jenkinsfile.deploy. Tier 1 đã phủ transport iOS; tầng này đào: bridge Rust, Pi extension, timeline/follower, core wire, tests, compat harness. License vẫn NOASSERTION → chỉ học thiết kế, không copy code.

## Kiến trúc đầy đủ (module graph)
```
iPhone (SwiftUI)
 ├─ HerdrConnection (actor trung tâm, generation-scoped)
 │   ├─ TUI path: SSH exec → herdr CLI/`herdr serve` unix socket (protocol 22)
 │   │   ├─ PanePersistentShell (marker framing) — tier 1
 │   │   └─ AgentBridgeClient (mỗi Timeline 1 SSH exec channel riêng)
 │   │        ↕ NDJSON stdio, 1 request 1 dòng, ≤1MiB
 │   │        herdcats-bridge serve --stdio --socket $HERDR_SOCKET (Rust, sync, 0 async dep)
 │   │         ├─ herdr::Client — unix socket, MỖI request 1 connection mới
 │   │         │   (session.snapshot / pane.read / pane.send_text / pane.send_keys /
 │   │         │    agent.prompt — cùng route iOS composer dùng)
 │   │         ├─ resolver — openat-beneath-anchor O_NOFOLLOW, reject symlink
 │   │         ├─ follower — tail transcript JSONL theo stamp+byte-verify
 │   │         ├─ adapter claude/codex/agy/cursor: đọc file transcript
 │   │         ├─ pi: extension socket ~/.pi/agent/herdcats/<session>.sock
 │   │         │    ↕ runtime.mjs chạy TRONG Pi TUI (pi -e index.ts)
 │   │         ├─ question_screen/approval_screen — parse màn hình TUI khi blocked
 │   │         ├─ hooks — PermissionRequest hook non-deciding + spool (bounded)
 │   │         ├─ model_control — đi menu /model bằng keystroke, verify từng bước
 │   │         └─ service::serve — stdin thread + sync_channel(16) + poll deadline
 │   └─ Core path: hc connect → CoreRPCClient (JSON-RPC NDJSON) + CoreWire
 │        (binary frame: channel u32 LE + kind u8 + len u32 LE, mux 1 channel)
 └─ HostHelperCommand — kênh lệnh một-lần (probe/install bridge, hooks, pi-extension)
```
Dữ liệu chảy: poll (mặc định theo interval) → snapshot herdr → resolve transcript (qua anchor fd) → follower refresh (so stamp + bytes) → diff entries → emit `timeline.updated` (inserted/updated/evicted_ids/revised) hoặc `timeline.unavailable` (đổi triple code+agent+daemon mới emit, bump generation). Phone phản hồi → `interaction.respond` → bridge xác thực response_key → gửi keystroke qua herdr socket → re-read màn hình xác nhận → `interaction.resolved`. Pi thì mọi thứ đi qua extension socket (state/history/prompt/cancel/dialog.respond/model.set) — bridge KHÔNG gõ bàn phím cho Pi.

## Máy trạng thái & luồng chi tiết
### 1. Follower — theo dõi transcript không tin metadata (follower.rs)
State: `stamp{dev,ino,len,mtime,ctime}`, `bytes` (prefix đã verify), `bytes_base`, `tail` (byte chưa consume), `generation`. Mỗi poll: đọc metadata BEFORE → đọc bytes → đọc metadata AFTER; stamp bằng nhau mà bytes khác = rewrite → reset. Test chứng minh tận cùng: same-length rewrite khi timestamp resolution thô (follower.rs:905-920):
```rust
let old = record("old"); let new = record("new");
assert_eq!(old.len(), new.len());   // cùng độ dài, cùng mtime
fs::write(&path.0, &old).unwrap();
follower.stamp = Some(Stamp::of(&fs::metadata(&path.0).unwrap()));
assert!(follower.refresh(&source_path, session).unwrap());
assert_eq!(follower.transcript.entries[0].text, "new");          // phát hiện
assert_eq!(follower.generation, generation + 1);                  // bump gen
```
Với agent append-only (Claude/Codex) chỉ verify HEAD 64KB + đuôi `verify` 8MB, giữa file không reread (`refresh_windowed`, follower.rs:541-575). Cursor ghi đè torn write `turn_ended` → dòng cuối bị HOLD BACK không consume (follower.rs:699-708):
```rust
// Cursor overwrites its trailing `turn_ended` marker in place when
// the next prompt starts, and that write can be observed torn.
// A final complete line that is the marker or unparsable is held
// back, not consumed: the next pass rewinds to this line's start,
if self.agent_type == AgentType::Cursor
    && part != b"\n" && index + part.len() == bytes.len()
    && part.len() <= MAX_RECORD
    && serde_json::from_slice::<serde_json::Value>(part)
        .map_or(true, |row| crate::cursor::is_turn_end(&row))
{ break; }
```
Action guard `verify_source` (follower.rs:470-489): trước khi PHÉP hành động dựa trên nội dung đã đọc, re-verify dev/ino/len + bytes + head — "rejects rotation or any modification to the verified bytes that authorized the displayed request". Content ref = `source:<offset>:<length>` trỏ vào byte đã verify, serve chunk 64KB từ cache hoặc file.

### 2. Watch/unavailable/delayed — service.rs poll (605-1015)
Identity quad `{pane_id, terminal_id, agent, native_session_id(+instance_id)}` — đổi identity ⇒ reset follower + xoá mọi cache + bump generation. Lỗi `source_changing` không立马 unavailable: đếm đến 10 (hoặc pi_transport_delayed) → state `delayed`, emit `timeline.updated` rỗng `delayed:true` giữ generation; hết lỗi thì poll lại bình thường. Unavailable chỉ emit khi triple (code, occupant agent, codex_daemon) đổi (service.rs:830-846) — tránh spam event khi pane lặp lỗi giống nhau.

### 3. Pi extension runtime — revision/instance guard + dialog race (runtime.mjs)
Mỗi mutation phải kèm `expect{session_id, instance_id, revision}`; revision bump trên MỌI hoạt động (authoritative fingerprint của session/file/leaf/model/effort/idle/queued/draft — runtime.mjs:107-110). Mutation được serialize:
```js
const action=serialized.then(run,run);serialized=action.catch(()=>{});return action;
// Serializing the async model mutation prevents another request from
// passing guards while setModel awaits credentials/model hooks.
```
Dialog confirm/select/input được WRAP: `Promise.race([terminal, remote])` — remote thắng thì abort terminal widget SAU khi resolve (kết quả huỷ không bao giờ đè câu trả lời explicit, runtime.mjs:206-210). Extension khác giữ method gốc → phát hiện qua `ui_prompt_start/end` public events → dialog đó thành "terminal" gate. Prompt chỉ chạy khi `isProjectTrusted && isIdle && !pending && !queued && editorText===''`; slash command từ chối (gõ terminal). Endpoint socket: mkdir từng cấp + lstat reject symlink + uid check + mode 0700/0600; socket đã tồn tại ⇒ `pi_endpoint_exists`, KHÔNG bao giờ unlink socket của process khác.

### 4. AgentBridgeClient (iOS↔bridge) — chính sách timeout phân loài (AgentBridgeClient.swift)
Read RPC (history/content/model.status) timeout/cancel ⇒ RETIRE riêng (bỏ pending, giữ watch; late reply bị bỏ qua, tụt 64 retired ⇒ đóng kênh, :246-256). RPC khác timeout ⇒ đóng cả kênh. Pending cap 16, frame ≤1MiB. Content fetch = hex chunk ≤128KB/lần, verify echo `identity==, generation==, offset==, total==, nextOffset==` từng reply (:219-244).

### 5. Question/approval screen — máy trạng thái UI TUI (question_screen.rs)
`QuestionStep::{ClaudeQuestion,ClaudeReview,CodexQuestion{index,total},AsyncQueued,AsyncPicker,AgyQuestion,CursorQuestion}` + cursor {Option,Submit,Notes} + countdown + multi-select checked; parse màn hình "anchored to structured pending questions" (fingerprint mọi dòng dialog). Response guard `response_key` (service.rs:80-100): option number phải khớp VÀ `label_lines` phải KHỚP CHÍNH XÁC từng dòng label đã quảng cáo — chống client gửi câu trả lời cho dialog khác.

### 6. OptimisticPaneStatus (iOS, Support/OptimisticPaneStatus.swift:10-148)
Override "working" ngay khi user submit; reconcile theo REVISION (snapshot cũ hơn submission bị ignore), `blocked` thắng ngay, `done` từ base≠done = turn kết thúc ⇒ bỏ override; grace 15s tự hết; `withdraw(token)` khi submit fail; clock đi lùi ⇒ loop sleep đến khi thật sự hết hạn.

## Cơ chế áp vào herdgate
1. **[CAO] Stamp+byte-verify cho mọi file herdgate tail** (receipts JSONL, session log). Excerpt follower.rs:483-488:
```rust
let mut bytes=Vec::new();
read_range(&file,self.bytes_base,cached_end,&mut bytes).map_err(|_|"stale")?;
let after=Stamp::of(&file.metadata().map_err(|_|"stale")?);
if before!=after || bytes!=self.bytes || (self.bytes_base>0 && head!=self.head)
    {return Err("stale");}
```
Áp: `src/host/herdr.ts` + publisher tail receipts — không tin mtime/size; detect truncate/regrow/same-length rewrite; đổi file ⇒ bump generation tương tự `spawn:` receipts. Vì sao: receipts là nguồn chân lý của gate; một rotate/write-đè nuốt các dòng mà không ai biết.
2. **[CAO] Hold-back dòng cuối chưa hoàn chỉnh** khi parse stream JSONL (follower.rs:699-708 ở trên). Áp: parser receipts/stream publisher (`src/host/*.ts`) — chỉ consume dòng kết thúc bằng `\n` + JSON hợp lệ; dòng cuối giữ lại chờ pass sau. Vì sao: JSON torn giữa hai chunk là bug class kinh điển.
3. **[CAO] openat-beneath-anchor O_NOFOLLOW** (resolver.rs:102-140):
```rust
let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
    | if i + 1 < parts.len() || directory { libc::O_DIRECTORY } else { 0 };
let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
```
Áp: gate VPS đọc mọi path do agent/user cung cấp (attachments, worktree, config) — đi qua dirfd anchor thay vì path string; từ chối symlink từng cấp. Vì sao: gate chạy trên máy user, path substitution qua symlink/renamed-parent là tấn công thật.
4. **[CAO] expect{session,instance,revision} cho mọi mutation Pi + serialize** (runtime.mjs:140-143). Áp: `src/agent/adapter.ts` khi steer/wake/prompt agent đang chạy — mỗi op mang identity + revision; stale ⇒ từ chối, KHÔNG retry; các mutation xếp hàng tuần tự. Vì sao: herdgate đã có receipts + wake-on-settle; thêm revision guard chống op chạm agent sau khi session đổi.
5. **[CAO] Herdr socket client chuẩn** (herdr.rs:114-136): 1 request = 1 connection mới, set timeout TRƯỚC khi gửi ("macOS EINVAL despite unread data" — chú thích thật), id echo check, kiểm `protocol != 22 ⇒ unsupported_herdr_protocol`, mọi lỗi map về code tĩnh. Áp: `src/host/herdr.ts` — nếu đang держ connection dài, cân nhắc pattern 1-conn/request cho lệnh đơn (đơn giản hoà fault-isolation); luôn echo-check id. Vì sao: chống confused response khi nhiều lệnh bay.
6. **[CAO] serve loop: stdin thread + bounded channel + poll deadline** (service.rs:3192-3228): reader thread đẩy frame vào `sync_channel(16)`, main loop `recv_timeout(deadline)` xử lý request, đến deadline thì poll 1 lần (coalesce). Frame >1MiB hoặc thiếu `\n` ⇒ error + thoát. Áp: relay `src/host/mobile-tui.ts` / `src/cloud/ssh-bridge.ts` — tách read blocking khỏi xử lý, poll không bao giờ chồng nhau. Vì sao: identical bài toán "vừa đọc stdin vừa định kỳ poll".
7. **[CAO] Retire read-RPC, không giết watch** (AgentBridgeClient.swift:246-256): read timeout ⇒ bỏ pending + ignore late reply (cap 64); mutation timeout ⇒ đóng kênh. Áp: `src/cloud/gateway.ts`/PWA fetch timeline — request đọc chậm bị abandon nhưng không reset stream; chỉ op ghi mới phá session. Vì sao: scroll-back không nên kéo ngắt kết nối live.
8. **[TRUNG] Unavailable-triple + delayed state** (service.rs:787, 830-846): chỉ emit error khi (code, agent, phụ cảnh) đổi; lỗi nhất thời ⇒ `delayed:true` với entries rỗng, giữ generation. Áp: publisher wake-on-settle pane events — dedupe theo nội dung event, có state "chưa biết" tách bạch "mất". Vì sao: PWA không nhấp nháy error mỗi poll lỗi nhẹ.
9. **[TRUNG] response_key exact-label guard** (service.rs:80-100): câu trả lời remote phải khớp số option VÀ từng dòng label. Áp: nếu herdgate có approval/question remote qua PWA — echo label đã hiển thị. Vì sao: chống trả lời dialog cũ/sai sau khi màn hình đổi.
10. **[TRUNG] packWindow byte-budget + cursor kép** (runtime.mjs:41-80): cửa sổ trả về tính theo BYTE (1MiB) chứ không chỉ số entry, tính cả cursor-overhead; cursor exclusive (id) vs `herdcats-through:<id>` inclusive. Áp: API timeline/receipts cho PWA (`src/cloud/gateway.ts`) — paginate theo budget byte + cursor inclusive cho "tail-only window". Vì sao: entry agent dài ngắn thất thường; count-based paging vỡ trên record khổng lồ.
11. **[TRUNG] OptimisticPaneStatus** (OptimisticPaneStatus.swift:104-135 reconcile): optimistic "working" + revision-guard + grace-expiry + withdraw-on-fail. Áp: `src/web/app.js` pane list khi user gửi prompt từ PWA. Vì sao: UX ngồi chờ poll 5-15s nhìn như lag; port trực tiếp được vì logic thuần.
12. **[TRUNG] Spool bounded ring cho hook request** (spool.rs:14-33): 256KB/file, 64 record, O_NOFOLLOW|O_NONBLOCK read, invalid session-id ⇒ rỗng. Áp: nếu publisher cần spool event ra đĩa khi gate offline. Vì sao: best-effort, bounded, fail-closed — không bao giờ OOM vì log.
13. **[THẤP] Binary frame channel+kind+len** (CoreWire.swift:88-135): `channel u32 LE | kind u8 | len u32 LE`, cap 16MiB, parser buffer BYTE không phải string ("a read may end inside a header or UTF-8 scalar"). Áp: nếu ssh-ws cần mux nhiều luồng (terminal + events + files) trên 1 socket. Vì sao: đã có WebSocket binary sẵn — thêm header 9 byte này là mux rẻ.
14. **[THẤP] Metrics nearest-rank p50/p95 chỉ-thời-gian** (PaneLiveInputMetrics.swift:17-30): "no text, keystrokes, pane output, hostnames… only durations, depths, and counts". Áp: diagnostics gate/publisher. Vì sao: telemetry tôn quyền riêng tư y hệt ràng buộc herdgate.
15. **[THẤP] Pinned installer: SHA256 installer-script + curl hard flags + marker lines** (AgentBridgeClient.swift:524-548: `--proto '=https' --max-filesize 65536 --retry 1`, verify sha trước khi chạy, in `HC_HELPER_INSTALLED` rồi verify version-json). Áp: tham chiếu cho bootstrap windows-CLI/host-zip của herdgate (hiện đẩy qua gate — giữ pipeline, nhưng checklist verify này đáng chép thành runbook). Vì sao: nguyên tắc "verify-then-execute, marker, managed-vs-external probe" dùng được cho mọi self-update.

## Cách họ test (bài học cho suite 213 test của ta)
- **656 Rust test + 21 extension test + 36 installer Python test** chạy trước mỗi release; `clippy --locked --all-targets -D warnings`; release JSON ghi bằng chứng (compatibility/release/v0.6.1-preparation.json: số test, version report, tag, SHA).
- **Fake server Unix socket in-process** (tests/protocol.rs:26-87): spawn thread accept-loop trả snapshot theo state mutable `Arc<Mutex<Value>>` — không cần herdr thật. Herdgate có sẵn `test/ssh-bridge.test.ts`, `fake-hc.tmp.mjs` — chuẩn hoá thành helper dùng chung.
- **Temp file + atomic counter** tránh đụng nhau (follower_window_tests.rs:10-17: `hc-window-{name}-{pid}-{N}`); Drop cleanup. Và quy tắc VÀNG trong test helper (protocol.rs:81-84):
```rust
// Never truncate in place: fs::write empties the file before writing, and
// the bridge's watcher can snapshot that empty file. Growth is appended
// like a live transcript; anything else is replaced via write-then-rename.
```
→ test fixture phải mô phỏng SEMANTIC ghi thật của app, không chỉ nội dung.
- **Vét mọi split point**: PanePersistentShellTests.swift:10-17 loop `for split in 0..<wire.count` cắt UTF-8 multibyte mọi vị trí — framing không bao giờ corrupt. Áp cho test SSH-WS/mobile-tui framing của ta.
- **Fixture SHA256 manifest + danh sách FORBIDDEN** (compatibility/phase2/verify.py:33-45): mỗi fixture ghi bytes+sha, assert không chứa chuỗi nhạy cảm; fixture "derived, not live capture". Áp: test receipts/PWA không nhét dữ liệu thật.
- **Test contract thay vì version**: runtime.mjs validate `typeof object[method]==='function'`; test inject fixture ctx fake toàn bộ API (runtime.test.mjs:8-15) rồi assert cả lỗi `stale`/`invalid_response`/`terminal_required`. Áp cho `src/agent/adapter.ts` — test adapter với fake Pi API surface.
- **Compat theo phase** (phase0 probe session dùngđonacci `hc-phase0-*` bắt buộc, phase1/2 fixture offline, release checklist) — herdr nâng cấp không phá client.
- **Test lỗi cụ thể là spec**: service_pi_tests.rs:3-63 dựng Watch tay, đợi mọi biến thể expect sai trả `stale` đúng — guard được test như bảng quyết định.

## Anti-pattern / không lấy gì
- **Screen-scrape + gõ keystrokes đi menu** (model_control.rs 2023 dòng, question_screen 1217 dòng, sleep 150-350ms loop): quá công phu (mismatch ⇒ dismiss picker, recheck idle từng batch keystroke) nhưng bản chất vẫn brittle — herdgate có receipts/sự kiện chính xác, đừng port.
- **1-conn-mỗi-request của herdr.rs**: chỉ ổn vì request ngắn; đừng áp cho stream dài của gate.
- **Hex transfer content qua NDJSON** (2 byte/byte + overhead JSON): cần vì kênh text-only; herdgate có SFTP/binary WS thì dùng binary.
- **Tự tải GitHub release trong app** (pinned installer): herdgate self-host qua gate, cơ chế download-in-app không phù hợp (tier 1 đã nói; giữ chỉ làm runbook verify).
- **Reread 64MB mỗi poll cho agent whole-file**: cái giá của correctness (chống stamp-collision) — với receipts herdgate nhỏ, ok; nhưng nếu file lớn phải chuyển windowed như họ cho Claude/Codex.
- **Bridge là binary sidecar người dùng phải cài trên máy**: herdgate gate đã giải quyết phân phối; kiến trúc "helper trên host" này chỉ lấy bài học guard/verify, không lấy mô hình.
- **NOASSERTION license** — tuyệt đối không copy code/artwork; DESIGN.md theme là tài sản thương hiệu của họ.
- **Stack iOS/Keychain TOFU/Observation** — không liên quan Node/TS.

## File đã đọc (tầng 2; tier 1 xem r-cats.md)
ĐỌC TRỌN: DESIGN.md (391); AgentBridgeClient.swift (942); follower.rs (922); herdr.rs (161); resolver.rs (160 đầu + open_beneath 102-160); pi.rs (200 đầu); question_screen.rs (60 đầu); hooks.rs (120 đầu); spool.rs (60 đầu); pi-extension/index.ts (22); pi-extension/runtime.mjs (280); pi-extension/README.md (50); CoreWire.swift (172); OptimisticPaneStatus.swift (148); PaneLiveInputMetrics.swift (80); Cargo.toml+main.rs (60); follower_window_tests.rs (100); protocol.rs (90); service_pi_tests.rs (70); runtime.test.mjs (~150); compatibility/phase2/verify.py (120); phase0/probe_herdr.py (40); release/v0.6.1-preparation.json (30); PanePersistentShellTests.swift (80); Jenkinsfile.deploy (grep); web/ (vai trò: site Next.js).
ĐỌC LỚN THEO PHẦN: service.rs 3793 — đọc ~1.300 dòng (struct Watch/PendingApproval/PendingQuestion 56-275; poll_inner 605-763; poll unavailable/delayed/diff 763-1015; model-control bracketed-keystroke 2270-2445; serve 3192-3250; test fixtures 3246-3322). LIỆT KÊ THEO VAI TRÒ (chưa đọc dòng): service.rs phần còn lại (pi_action/respond dispatch 1433-2270, 2445-3192), model_control.rs (2023), codex_config.rs (1394), codex.rs (1173), question_screen.rs phần còn lại, claude.rs (627), approval_screen.rs (578), cursor*.rs (~2.6k), agy.rs, content.rs, service/*_tests.rs (~5k), tests/ còn lại (~7k), iOS Features/ AgentTimeline 4.7k + PaneDetail 3.3k (tier 1 đã đọc PaneInputSurfaceModel), KeychainStore.swift (940), HerdrModels/AgentTimelineModels/QuotaModels (1.9k), HerdrConnection+{Queries,AgyAndPanes,Core,Errors}.swift (1.1k), CoreRPCClient/BridgeReleaseUpdate/ConnectionTimeout/ConnectionOwnership/OpenSSHKeyParser (1.4k), tests iOS còn lại (~20k), ios/docs research/*.md, compatibility phase1/release còn lại, scripts/.
Phát hiện giá trị nhất: **follower.rs — verified-byte tailing (stamp+bytes, torn-write hold-back, source:offset:len content refs, verify-before-action) cùng hệ quả test "never truncate in place"** — chuẩn mực trực tiếp cho receipts/publisher của herdgate.
