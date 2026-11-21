# Deep-dive Tầng 2: alexarthurs/herdr-sidebar → herdgate

> Báo cáo tầng 1: `../r-sidebar.md` (chỉ tóm lược — không lặp lại). Tầng này đào hết cơ chế.
> Repo: Rust 2024, 39.624 dòng Rust + AGENTS.md 1.726 dòng, 466 test inline, MIT.
> Clone `/tmp/deep/sidebar`. Plugin nằm `plugins/herdr-sidebar/` (root là monorepo doc/tools).

## Kiến trúc đầy đủ (module graph + data flow)

**Inventory**: 32 file src. Lõi: `scm_app.rs` 6.863, `viewer.rs` 5.989, `explorer_app.rs` 5.599,
`git.rs` 2.220, `launch.rs` 2.108, `takeover.rs` 2.009, `ensure.rs` 1.747, `state.rs` 1.582,
`editor.rs` 1.205, `actions.rs` 1.192, `ui.rs` 1.094, `focus.rs` 891, `fontsetup.rs` 858,
`updates.rs` 804, `main.rs` 772, `diffview.rs` 710; nhỏ: `ipc.rs` 326, `rundir.rs` 350,
`snooze.rs` 315, `gitdeco.rs` 319, `suggest.rs` 168, `autohide.rs` 115, `bin/ensure.rs` 50.
Test: 1 file `tests/manifest.rs` + 466 `#[test]` inline. CI: build+test+clippy 3 OS + arm64,
`clippy -D warnings`; release build 5 triple + verify tag==Cargo.toml==manifest==lock.

**Ai gọi ai** (→ = gọi; ↓ = spawn):

```
herdr events/actions (HERDR_PLUGIN_EVENT_JSON env)
  → main.rs (argv dispatch) ──┬→ ensure::run(Mode)      # --ensure/--reap/--toggle/--show-*
  → bin/ensure.rs (Win sidecar)┘
        ensure.rs → ipc.rs (socket) → launch.rs (PURE: json→decision)
        ensure.rs → LaunchLock (flock), snooze.rs, autohide.rs, takeover.rs, focus.rs
  main.rs --launch-decision/--open-plan/... : stdin→stdout helper (test được, không TUI)
  main.rs (TUI) → explorer_app.rs ⇄ scm_app.rs (switch IN-PROCESS)
        apps → git.rs, suggest.rs (thread), focus.rs (SidebarActivity), launch::FollowPoller
        apps → state.rs (state.json/tree.json/scm.json/roots.json + StateWriteLock)
        apps → ipc.rs (heartbeat pane.report_metadata), viewer.rs (--preview process riêng)
```

**Dữ liệu chảy**: event JSON → scope (tab/workspace) → `pane.list` snapshot → decision thuần
(OPEN/FOCUS/CLOSE/REPLACE) → `plugin.pane.open`/`pane.split`+swap+resize → TUI spawn với
`SPAWN_CWD_ENV` → TUI re-stamp token mỗi ~5s → launcher đọc token ở lần ensure sau.
State bền: `HERDR_PLUGIN_STATE_DIR` (settings, tree, scm drafts, roots — mọi file keyed, có
flock `StateWriteLock`). Runtime scratch: `rundir` riêng 0700 (snooze/focus marker/takeover
journal/replace budget), keyed theo socket-path hash = session.

## Máy trạng thái & luồng chi tiết

**1. Launch decision —Open|Focus|Close|Replace** (`launch.rs:310-350` thuần, idempotent):
đọc `pane.list`, tìm explorer trong tab của pane focused **trong scope sự kiện**; token stale
hoặc label-mà-không-token → REPLACE; focused → CLOSE; còn lại FOCUS; không có/garbage → OPEN
(safe default, không bao giờ hành động trên pane lạ):

```rust
// launch.rs:276-295 — liveness duy nhất tin được
pub const HEARTBEAT_STALE_SECS: u64 = 20;
fn token_stale(tokens: &serde_json::Map<String, serde_json::Value>, key: &str, now: u64) -> bool {
    let Some(value) = tokens.get(key) else { return false; };
    let ts = value.as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()));
    match ts {
        Some(ts) => now.saturating_sub(ts) > HEARTBEAT_STALE_SECS,
        None => true, // pre-heartbeat token format: treat as dead once seen
    }
}
```

**2. RefreshGate —single-flight status worker** (`scm_app.rs:687-760`): generation/running/
queued/next_periodic; mọi thay đổi (git action, refresh, sync xong) `invalidate()` bump
generation; kết quả cũ thế hệ bị drop thay vì revert view; periodic throttle `max(1.5s, 3×
thời gian read trước)` — repo chậm tự đông cứng nhịp:

```rust
// scm_app.rs:740-747
fn finish(&mut self, generation: Option<u64>, now: std::time::Instant) -> bool {
    let Some((_, started)) = self.running.take() else { return false; };
    self.next_periodic = now + STATUS_REFRESH_MIN.max(now.duration_since(started) * 3);
    generation == Some(self.generation)
}
```

**3. Visibility —Visible|Hidden|Unknown → cadence** (`focus.rs:257-280`): marker focus
(session-file JSON, generation tăng dần) do hook publish; pane ẩn = 0 traffic `pane.list`,
hiện = 1 list/300ms, unknown = 5s idle. `SidebarActivity::poll()` (focus.rs:384-440) là 1
worker single-flight duy nhất cho cả 2 view + membership qua `pane.get` 60s + staggered start
theo hash pane-id (focus.rs:325-331) chống burst sau restart.

**4. Takeover journal** (`takeover.rs:35-160`): cây split `Node::{Pane,Split}` + `prune()`
collapse đúng như herdr collapse split; restore best-effort luôn discard journal — "a restore
can never leave the tab trapped". `Trigger::{ViewerClosing,Recover}` phân biệt viewer của
journal (được phép move) vs viewer còn sống (blocks).

**5. UnifiedClose —Waiting|Closed|TimedOut** (ensure.rs:697-780): poll `pane.get` throttle
120ms, timeout 2s, sibling "gone" = `pane_not_found` HOẶC đổi tab — nhưng API error khác
không tính gone.

**6. View switch in-process** (main.rs:245-275): `Exit::{Quit,Switch,Search,QuickOpen}`;
một terminal session cho cả 2 view, App bị drop và build lại nhưng `RootMemory` + process sống.

## Mọi cơ chế áp vào herdgate

1. **[CAO] flock serialize event bursts — try_lock cho focus, lock blocking cho discrete**
   (`ensure.rs:81-120`, AGENTS.md "Focus events fire in bursts"): 1 tab switch phát
   `tab.focused`+`workspace.focused` chạy đồng thời; không lock → 4 pane nhân bản.
   ```rust
   // ensure.rs:86-93
   pub fn acquire(wait: bool) -> Option<Self> {
       ...
       let acquired = if wait { file.lock().is_ok() } else { file.try_lock().is_ok() };
       if !acquired { return None; }
   ```
   → Áp `plugin/server/wake-event.mjs`: herdgate hook 3 event (`pane.exited`,
   `pane.agent_status_changed`...) cũng burst (1 agent chết phát cả 3). Wake handler phải lấy
   lockfile (`flock` trong .mjs, hoặc atomic mkdir 1-lần) theo chế độ: focus-type → skip nếu
   bận, discrete (exit) → chờ; tránh gửi duplicate wake frame cho 1 settle. Vì sao: herdr chạy
   hook concurrent, không có sequence number (AGENTS.md #125 xác nhận live).

2. **[CAO] Retry window tính từ lúc HOÀN TẤT, không phải lúc bắt đầu** (`main.rs:355-380`
   `RootMemory::record_with`; `focus.rs:457-468` `apply_membership_check`): lookup socket chậm
   (timeout 5s) nếu tính từ start thì xong là due lại ngay → tự DDoS host.
   ```rust
   // main.rs:358-361 — "a lookup that took its whole socket timeout must not
   // leave the next retry immediately due"
   if self.pending && self.last_attempt != before {
       self.last_attempt = Some(clock());
   }
   ```
   → Áp `plugin/server/index.mjs` (serve/publisher): mọi reconnect/retry cloud relay, poll
   agent status — đo `lastAttempt = Date.now()` SAU khi promise settle, không trước await.

3. **[CAO] Heartbeat token thay process-info cho liveness** (`ipc.rs:74-110` report_identity;
   AGENTS.md 595-601: "You cannot detect a dead TUI from outside" — process_info chỉ thấy
   shell, corpse giữ cả label lẫn token): TUI tự re-stamp `unix_now()` string mỗi ~5s, stale
   >20s = chết.
   ```rust
   // ipc.rs:77-84 — token map MERGE nên phải ghi explicit null để xóa
   let mine = serde_json::json!({
       my.plugin_id(): now,
       crate::launch::STARTING_TOKEN: serde_json::Value::Null,
   });
   ```
   → Áp publisher herdgate (`plugin/server/index.mjs` observe flow): khi quyết định "pane
   agent còn sống để gửi settle?", đừng tin sự kiện cuối — yêu cầu stamp/hoặc check age của
   observation. Ngược lại, chính publisher nên stamp token riêng lên pane nếu cần marker
   cross-process. Vì sao: herdr server-restart resume tạo corpse không phát event nào (AGENTS
   603-608) — herdgate publisher reconnect sau handoff sẽ gặp đúng tình huống này.

4. **[CAO] Budget loop 3 lần/phút + sweep** (`ensure.rs:15-16, 793-846`): REPLACE-crashloop
   bị chặn bởi file counter `"<attempts> <unix_ts>"` trong rundir, FNV-hash theo scope; explicit
   action bypass + clear; sweep file quá 2 window.
   ```rust
   // ensure.rs:803-806
   if now.saturating_sub(last) >= REPLACE_WINDOW_SECS { attempts = 0; }
   if attempts >= REPLACE_ATTEMPTS_PER_WINDOW { return Ok(false); }
   std::fs::write(path, format!("{} {now}\n", attempts + 1))?;
   ```
   → Áp `pi-receipt-gc.mjs` / revive flow herdgate: mọi vòng "phát hiện chết → spawn lại" cần
   budget per (agent, window) ghi ở runtime dir, kèm sweep; chống spawn vòng vô hạn khi
   startup crash. Tier-1 đã nêu THẤP; tầng này xác nhận cài đặt cụ thể rẻ (2 file ops) → đáng
   nâng CAO cho revive.

5. **[CAO] Graceful close: Ctrl+Q cho TUI sống, pane.close chỉ cho pane chưa vào event loop**
   (`ensure.rs:735-750` request_close kiểm `pane_is_starting`):
   ```rust
   // ensure.rs:737-748
   if launch::pane_is_starting(panes_json, pane_id) {
       ipc::call_text("pane.close", ...)?;      // no TUI state exists yet
   } else {
       ipc::call_text("pane.send_input",
           json!({ "pane_id": pane_id, "text": "", "keys": ["ctrl+q"] }), ...)?; // TUI tự flush + tự đóng
   }
   ```
   → Áp task close/revive của herdgate khi thao tác pane Pi đang chạy: gửi `ctrl+q` (Pi tự
   persist session) rồi mới cân nhắc close; chỉ close trực tiếp pane mới spawn có marker
   "starting". Vì sao: AGENTS.md 641-644 "`pane close` kills the TUI process with no chance to
   flush" — verified live.

6. **[CAO] Nói socket trực tiếp newline-JSON, không spawn CLI trong hook** (`ipc.rs:30-45`
   timeout 5s + cap 4MB; unix dùng native read/write timeout — comment ipc.rs:218-227 lý do
   thread-timeout Windows leak fd):
   ```rust
   // ipc.rs:240-250 (unix path)
   stream.set_read_timeout(Some(IPC_TIMEOUT))?;
   let mut line = String::new();
   BufReader::new(stream.take(MAX_RESPONSE_BYTES)).read_line(&mut line)?;
   ```
   → Áp `plugin/server/wake-event.mjs` + `src/host/herdr.ts`: thay `spawnSync("herdr", ...)`
   bằng connect `$HERDR_SOCKET_PATH` (node `net.connect`), write 1 JSON line, đọc 1 line, có
   timeout. Vì sao: hook chạy mỗi event — latency spawn + rủi ro zombie process trên gate VPS;
   response shape giống CLI output nên parser không đổi.

7. **[TB] Hai mẫu liên tiếp trùng mới nhận (chống transient)** (`launch.rs:107-118` doc +
   165-185 `FollowPoller::accept`): sample `foreground_cwd` 300ms nhưng chỉ accept khi 2 sample
   liên tiếp bằng nhau — tool chạy lướt qua thư mục khác không re-root view.
   → Áp PWA/Mobile-TUI observe: settle/agent-status chỉ publish khi 2 observation liên tiếp
   đồng ý; single-flight (1 in-flight, request mới coalesce thành 1 follow-up).

8. **[TB] Generation-guard cho kết quả async về muộn** (`RefreshGate` — mục 2 state machine):
   mọi thứ đụng dữ liệu nguồn (event mới, action) bump generation; kết quả về với generation
   cũ bị drop. → Áp wake/settle của herdgate: wake frame chứa generation; cloud relay/PWA bỏ
   frame stale để không "revert view" (đúng lỗi AGENTS issue #97 của họ).

9. **[TB] Id-safe + strip BOM cho mọi giá trị từ host** (`launch.rs:1130-1137` `is_flag_safe`
   — alphanumeric + `:._-`, không leading `-`; `launch.rs:261` `strip_bom` vì PowerShell 5.1
   prepends UTF-8 BOM khi pipe):
   ```rust
   // launch.rs:1130-1137
   pub(crate) fn is_flag_safe(id: &str) -> bool {
       !id.is_empty() && !id.starts_with('-')
           && id.chars().all(|c| c.is_ascii_alphanumeric()
               || matches!(c, ':' | '.' | '_' | '-'))
   }
   ```
   → Áp `wake-event.mjs`: mọi id/scope lấy từ `HERDR_PLUGIN_EVENT_JSON` phải validate whitelist
   trước khi ghi file/dùng làm key; garbage JSON → no-op im lặng (decision degrade-to-OPEN của
   họ là khuôn mẫu: fail theo hướng an toàn nhất).

10. **[TB] Per-session runtime scratch keyed theo socket path** (`snooze.rs:11-19`: dir =
    `rundir("snooze")/<hash(socket_path)>`; vì tab id `w1:t1` lặp lại across sessions — issue
    #115 của họ: session này honored marker của session kia). → Áp herdgate: mọi marker
    receipt/pause/spawn-registry scratch phải namespace theo `HERDR_SOCKET_PATH` (1 VPS chạy
    2 herdr = 2 session).

11. **[TB] Test manifest vì "manifest được herdr đọc, không ai trong code đọc"**
    (`tests/manifest.rs:13-44`): parse TOML thật + assert mọi command không chứa control char
    (TOML escape bug từng giết plugin trên mọi platform: `\h` không phải escape hợp lệ).
    ```rust
    // tests/manifest.rs:25-31
    assert!(!program.chars().any(char::is_control),
        "{section} program has a control character (a TOML escape?): {program:?}");
    ```
    → Áp herdgate: thêm `test/plugin-manifest.test.ts` parse `plugin/herdr-plugin.toml`, assert
    entrypoint file tồn tại + command không control-char + event names hợp lệ. 213 test của ta
    hiện không phủ file quan trọng nhất mà herdr đọc.

12. **[THẤP] `pane.list` stale ngay sau close** (AGENTS.md 245-247): snapshot cũ vẫn report
    pane đã đóng là focused → `pane_not_found`. Quy tắc: re-list sau MỌI close trước khi tính
    target (họ làm ở REPLACE path ensure.rs:667-671). → Áp wake-event: sau khi nhận
    `pane.closed`, đừng dùng cache list cũ để resolve parent edge — gọi list mới.

13. **[THẤP] Timeout kill cả process tree** (`git.rs:741-800`): Windows CREATE_SUSPENDED +
    Job Object rồi resume (kill cả subtree); unix kill child. Poll nap exponential 1ms→25ms
    (đa số read xong trong vài ms). → Áp host/herdr.ts khi phải spawn `herdr`/`git` từ Node:
    wrap với timeout + tree-kill (`detached:true` + `process.kill(-pid)`).

## Cách họ test (bài học cho suite 213 test của herdgate)

- **Pure core / IO shell tách tuyệt đối**: `launch.rs` 2.108 dòng không có 1 dòng I/O — toàn
  `fn(&str json) -> String`; mọi parser nhận chuỗi JSON y hệt CLI in ra → 47 test chỉ feed
  string. herdr-sidebar expose chúng qua stdin→stdout mode `--launch-decision` để debug live.
  → herdgate: tách pure decision (scope→action, receipt→wake frame) ra module không fs/net.
- **Host-trait fakes** (`ensure.rs:1236+ FakeRefresh`, `1418+ FakeReap`; `takeover.rs:160 Env`):
  toàn bộ flow multi-step (refresh đóng/mở/verify từng tab) chạy contra fake host có behavior
  injection (`open_noop`, `refuse_input`, `closes` counter = "đóng sau N lần wait"). Test cả
  "open Ok nhưng không dock pane gì" — verify bằng state, không tin Ok().
- **Test tự sự thật bug**: tên test = hiện tượng ("a_followed_root_is_saved_under_the_workspace
  _s_current_label" kèm comment câu chuyện bug thật; "wedged peer must not hang" ipc.rs:289).
- **Hostile-input tests** là mặc định: `"not json"`, `"--evil"`, `"\u{feff}"`, `"; rm -rf /"`,
  `$(whoami)` — mỗi parser có test từ chối.
- **Clock/time inject**: `record_with(root, clock: impl Fn() -> Instant, ...)` — retry window
  test bằng fake clock chạy nhanh 60s window; không sleep trong test.
- **Concurrency tests thật**: socket thật (`UnixListener` bind temp, peer giữ connect không
  đáp — ipc.rs:291-326), flock thật (try_lock trên dir 0755 phải fail), symlink thật.
- **CI clippy `-D warnings` + test installer script trên 3 OS + arm64**; release verify
  tag==crate==manifest==lockfile (release.yml:27-36) — chống lệch version manifest.

## Anti-pattern / không lấy gì

- **Host/guest 2-process view switch** — chính họ đã đập bỏ (AGENTS.md 654-660: "The old
  two-crate host/guest process-swap protocol is gone") vì flash + phức tạp. herdgate
  Mobile-TUI/PWA đừng multi-process cho UI state.
- **Poll toàn cục để biết focus** (pre-#125: mỗi sidebar `pane.list` 300ms + global list 2s)
  — thay bằng marker + event publish. herdgate publisher đừng poll list định kỳ.
- **`pane.close` pane sống / kill exe broad khi rebuild** (AGENTS.md: never kill broadly vì
  preview pane giữ unsaved buffer).
- **Nhân đôi action id per-platform** (`open-sidebar` + `open-sidebar-windows` × ~10) — system
  của họ bắt id globally-unique; herdgate chỉ linux/macos, đừng khởi đầu pattern này.
- **Legacy migration lock dance** (LaunchLock giữ thêm `_legacy` lock file cho upgrade window
  ensure.rs:96-118) — chi phí tương thích họ phải trả; herdgate 0.1 chưa có legacy, design
  đúng path ngay từ đầu thay vì gánh dual-path.
- **Hand-rolled state JSON writer** (state.rs `write_state` format! chuỗi JSON tay) — khó đọc
  hơn serde derive; họ có lý do (file nhỏ, Copy struct) nhưng herdgate TS dùng JSON.stringify.
- **Windows GUI sidecar + pipe thread-timeout leak** (ipc.rs:203-215 chấp nhận leak thread+fd
  khi peer wedge — "strictly better than hang, not a full fix"): bài học CHỈ lấy phần unix
  (native timeout); herdgate không target Windows nên tránh hẳn nhánh này.
- **Spawn `claude` CLI mỗi lần suggest** (suggest.rs:57-77): đơn giản nhưng 60s timeout +
  fallback heuristic là bắt buộc; herdgate nếu làm recap AI nên dùng cloud channel sẵn có.

## File đã đọc (đầy đủ + phạm vi dòng)

Đọc trọn (100%): `herdr-plugin.toml` (292), `tests/manifest.rs` (44), `Cargo.toml` (70),
`src/lib.rs` (31), `src/main.rs` (773), `src/ipc.rs` (326), `src/ensure.rs` (1.747),
`src/launch.rs` (2.108), `src/state.rs` (1.582), `src/suggest.rs` (168), `src/snooze.rs` (315),
`src/autohide.rs` (115), `src/bin/ensure.rs` (50). Đọc lõi + test tiêu biểu (chỉ phần nêu, còn lại là test/UI): `src/git.rs` (1-1300 trọn
module + runner/timeout/parse), `src/takeover.rs` (1-640 trọn journal/restore/abandon),
`src/rundir.rs` (1-180 trọn), `src/focus.rs` (1-498 publish/marker/visibility/SidebarActivity),
`src/scm_app.rs` (680-810 RefreshGate+worker, 1560-1740 collect/heartbeat/tick/follow),
`src/explorer_app.rs` (749-805 heartbeat), `AGENTS.md` (headers + 233-343 herdr findings +
519-658 focus/liveness), `.github/workflows/ci.yml` (trọn), `release.yml` (1-50),
`agent-command-guard.yml` (1-30), `README.md` (skim cấu trúc). Chưa đọc (đã định vị vai trò,
là render/UI layer ít liên quan herdgate): `viewer.rs`/`editor.rs`/`diffview.rs`/`wrap.rs`/
`syntax.rs`/`ansi.rs`/`icons.rs`/`ui.rs`/`branch_ui.rs`/`gitconfirm.rs`/`gitdeco.rs`/
`fontsetup.rs`/`updates.rs`/`tree.rs`/`actions.rs`, `tools/screenshots/*`, `scripts/*`.

**Phát hiện giá trị nhất**: bộ ba "pure decision + flock-serialized hooks + heartbeat-token
liveness" là kiến trúc đúng duy nhất để sống sót với herdr event system (burst, concurrent,
không sequence, corpse sau restart) — herdgate publisher/wake đang giải đúng bài toán này ở
mức nhỏ hơn và nên copy nguyên ba nguyên lý, không chỉ từng mảnh.
