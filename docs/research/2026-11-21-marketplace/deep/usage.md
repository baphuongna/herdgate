# herdr-agent-usage — ĐÀO SÂU TẦNG 2 (excavate toàn bộ)

Repo: levi-qiao/herdr-agent-usage v1.7.0 (MIT, Rust, 54.5k dòng src + 6.5k dòng tests).
Tầng 1 (`../r-usage.md`) đã cover model/route/pi/providers/refresh cơ bản — bản này KHÔNG lặp; đào thêm: **cache.rs (toàn bộ lớp merge + lock + mailbox)**, watcher loop đầy đủ, máy trạng thái icon-attention, QuotaGroups, AGENTS.md invariants, 14 docs/research, và toàn bộ chiến lược test.

## Kiến trúc đầy đủ (module graph)

```
main.rs/cli.rs ── Commands{refresh,watch,startup,event,focus,layout,configure,
              claude-statusline,grok-statusline,dashboard,settings,toggle-order}
  ├─ refresh.rs (5143) ── mọi entrypoint; gọi route, cache, herdr, providers, presentation
  ├─ route.rs (1349) ── resolve_with_identity(pane)→ResolvedPane{resolution,identity,
  │     context,session_summary,omp}; dispatch theo Harness (12 harness)
  │     ├─ pi.rs (1582) ── parser JSONL v3 dùng chung Pi+omp (branch walk, usage,
  │     │     context, cache TTL, credential_pin/credentialId)
  │     ├─ opencode.rs/kilo.rs/mimo.rs ── parser riêng từng store
  │     └─ BillingTarget{billing,credential_scope,scope_hash} (model.rs:210)
  ├─ providers/* ── collector: codex(gRPC app-server), grok/devin/muse/cursor/kilo/
  │     opencode_go (HTTP, shared ureq agent), claude/agy (statusLine stdin hook),
  │     omp (spawn `omp usage --json`), statusline (enrich_cache_session)
  ├─ cache.rs (3270) ── CacheStore: snapshot/target JSON + refresh marker + lock file
  │     + statusline mailbox (.observation.json) + prefs + IconAttention + omp usage
  ├─ herdr.rs (5451) ── bridge: `herdr agent list` CLI + socket_request(HERDR_SOCKET_PATH),
  │     publish_pane_tokens/metadata_matches/QuotaGroups/vendor_nesting/icons
  ├─ presentation.rs (3063) ── MetadataTokens/RowStyle/Severity/format percent/gauges
  └─ configure/* (5.4k) ── viết config.toml sidebar rows, statusLine hook, font, integration
tests/: configure_round_trip (4299, 91 test), provider_contracts, watch_handoff,
  gauges_publish, plugin_manifest, install_upgrade, statusline_config, grok_hook_config,
  metadata_rendering + 40 fixtures JSON/JSONL (nhiều fixture ghi từ API thật, redacted)
```

Dòng dữ liệu: **event/focus/watch → 1 inventory read (`herdr agent list`) → route resolve
per-pane → collector fetch (debounce 60s/target, lock per-target) → merge vào cache
(session-keyed maps) → publish tokens per-pane qua `pane report-metadata` (chỉ khi drift)**.
StatusLine hook chạy độc lập: stdin JSON → parse → mailbox atomic write → nudge watcher.
Hai kênh Claude/Agy (mailbox vs refresh copy) hội tụ ở `provider_snapshot_for_display`: lấy bản `fetched_at_unix` mới hơn (refresh.rs:326-344).

## Máy trạng thái & luồng chi tiết

### 1. Watcher loop — một tiến trình toàn cục, lock file, reexec khi môi trường đổi

```rust
// refresh.rs:130-160 (watch)
let Some(_lock) = cache.try_lock_named(TURN_WATCH_LOCK)? else { return Ok(()) };
let mut mailbox_stamp = statusline_mailbox_stamp(&cache);   // (claude_mtime, agy_mtime)
let mut settling = BTreeMap::new();                          // pane_id → finished_at
loop {
    if cache.turn_watchers_stopped_after(started_millis)? { break; }
    let server_changed = server != WatchHerdrEnvironment::current();
    if server_changed || watch_binary_is_newer(started_at, current_exe_modified()) {
        drop(_lock); return reexec_watch(server.as_ref(), interval_seconds); }
    // ... list_agent_state → active=working panes; affected = active + settling + stale-idle
    if active.is_empty() && settling.is_empty() && !stale_icons && unseen.is_empty() { break; }
    wait_for_watch_tick(...)   // sleep 1s: poll focus, poll icons, mailbox drift publish
}
```

Điểm đáng học: (a) `WatchHerdrEnvironment{binary,socket}` lưu `watch-herdr.json` — watcher
detached outlives server Herdr, khi server handoff thì **reexec chính nó** với env mới thay
vì giữ socket cũ (refresh.rs:2218); (b) `settling` giữ pane đã xong turn thêm đúng 60s để
bắt reading hoàn tất (`watch_targets` refresh.rs:241-258) — "returning the final ids before
retiring them is what prevents the completion reading from being dropped"; (c) tick 1 giây
chỉ poll metadata (focus/icon/mailbox mtime), không đụng pane; (d) cap 1h
`MAX_ACTIVE_TURN_WATCH`; (e) stop-marker `turn-watch.stop` cho uninstall giết watcher sạch.

### 2. IconAttention — seen-state riêng vì `agent_status` của server nói dối

```rust
// cache.rs:49-60 — plugin tự track working/unseen/seen + seen_seq
pub struct IconAttention {
    pub working: BTreeSet<String>, pub unseen: BTreeSet<String>, pub seen: BTreeSet<String>,
    /// `state_change_seq` when the pane was acknowledged. A later working
    /// status at this same seq is the streak the user already saw.
    pub seen_seq: BTreeMap<String, u64>,
    pub last_focused: Option<String>,
}
```

Luồng (refresh.rs:718-815 `apply_icon_attention`): event working → insert `working`; turn
xong → move sang `unseen` (teal); focus pane → `seen` + ghi `seen_seq=state_change_seq`.
Quy tắc "same seq = streak user đã thấy" chống vẽ lại vàng khi inventory lag. File rỗng khác
file thiếu: "A missing file means never tracked; an empty file means everything has been seen"
(cache.rs:884-890) — luôn persist kể cả empty để hydrate không chạy lại.

### 3. omp — hai lớp cache chủ ý, `agent.db` không bao giờ mở

```rust
// refresh_omp_target (refresh.rs:1355-1391):
let Ok(Some(_lease)) = cache.try_lock_target_refresh(target) else { return OmpUsage::Unknown };
// Marked before the call so a failing binary cannot be retried on every
// event; the window applies to attempts, not to successes.
if cache.mark_refresh_target(target, now).is_err() { return OmpUsage::Unknown; }
```

Enum `OmpUsage{Account,PayAsYouGo,Pool,Unavailable,Unknown}` phân biệt 5 kết quả: có account
pin khớp → snapshot; chỉ API key → **Clear** (số cũ thuộc login khác); nhiều key không pin
→ `Pool(summary)` hiển thị pool state làm `quota_error`; fetch fail → giữ cache. Attribution
= `credential_pin` = `sha256(provider\0accountId\0email\0orgId\0projectId)` do omp ghi vào
transcript — digest là "persisted contract", có test pin cố định để phát hiện upstream đổi.

### 4. StatusLine merge — monotonic per-reset, observation age, api_generation

```rust
// cache.rs:1337-1352 (prefer_fresher_profile_window) — cùng reset chỉ đi lên:
match (stored.resets_at, current.resets_at) {
    (Some(sr), Some(cr)) if cr > sr => current.clone(),
    (Some(sr), Some(cr)) if cr < sr => stored.clone(),
    _ if current.used_percent > stored.used_percent => current.clone(),  // idle tick không hồi giá trị cũ
    _ => stored.clone(),
}
```

`merge_session_quota_observations` (cache.rs:1097-1168): mỗi window có `observed_at_unix`
riêng — Claude lặp lại cùng rate_limits trên timer → observation được coi "còn current",
không age; window bị omit giữ tuổi cũ. `SessionQuotaObservation{kind,observed_at_unix,
api_generation}` — api_generation là fingerprint "một provider response khác đã hoàn tất",
chỉ dùng làm bằng chứng freshness, "never used as account identity".

### 5. Claude share-quota theo account digest — so TỪNG window độc lập

```rust
// model.rs:849-881 (quota_session_for_lookup): session có account digest →
// tìm session MỚI NHẤT cùng digest có window của `kind`, so riêng 5h/7d:
.filter(|(seen, _)| !own_has_window || *seen > own)   // chỉ nhận fresh hơn hẳn
.max();
Some(newest.map_or(session_id, |(_, id)| id))          // tie → giữ của mình
```

## Mọi cơ chế áp vào herdgate

1. **[CAO] Mailbox pattern + "newer of two copies" cho publisher pi-receipt-watch**
   `plugin/server/pi-receipt-watch.mjs` — excerpt `provider_snapshot_for_display`
   (refresh.rs:326-344, chọn snapshot `fetched_at_unix` mới hơn giữa mailbox và refresh
   copy). Vì sao: publisher passive-đọc-file của ta có 2 nguồn ghi đè nhau (watch event vs
   poll); luôn render bản mới hơn theo fetched_at thay vì last-writer-wins — tránh sidebar/
   UI hiển thị giá trị cũ hơn cái user vừa thấy. Kèm `statusline_mailbox_stamp` (mtime
   tuple) để chỉ publish khi file thật sự đổi mtime.
2. **[CAO] Settling-pass 60s sau turn + mark-refresh TRƯỚC khi fetch**
   `plugin/server/pi-usage.mjs` / `pi-worker.mjs` — excerpt `watch_targets` +
   `refresh_omp_target` ở trên. Vì sao: turn của Pi agent kết thúc thường ghi usage sau
   giây cuối; pass cuối sau debounce bắt reading hoàn tất. Marker ghi trước call ⇒ binary/
   endpoint hỏng không bị retry mỗi event (window "applies to attempts, not successes").
3. **[CAO] File-lock per-target + marker file thay vì in-memory debounce**
   `plugin/server/pi-receipt-watch.mjs`, `pi-wake.mjs` — excerpt `try_lock_named`
   (cache.rs:505-521, `fs2 try_lock` non-blocking) và `should_debounce_target`
   (cache.rs:193-206, đọc marker `<identity>.refresh` so now-last < interval). Vì sao:
   nhiều tiến trình herdgate (wake event, worker, CLI) cùng spawn được publisher; lock file
   + marker không cần daemon sống liên tục — đúng mô hình stateless của ta.
4. **[CAO] Reexec watcher khi env đổi + stop marker**
   `plugin/server/pi-wake.mjs` — excerpt `WatchHerdrEnvironment::save/load` (refresh.rs:48-76:
   "A direct invocation without Herdr's environment cannot describe the server and must not
   replace its recorded connection") + reexec (refresh.rs:2218). Vì sao: herdr-bridge/
   tunnel đổi socket sau reconnect; watcher cũ phát hiện `watch-herdr.json` ≠ env hiện tại
   → tự exec lại thay vì câm lặng. Stop marker cho phép lệnh `stop`/redeploy giết watcher.
5. **[CAO] `format_percent` không làm tròn lên 100 + band theo số in ra**
   `src/web` Usage UI + mọi gauge — excerpt model.rs:1294-1306:
   ```rust
   let rounded = format!("{value:.0}");
   if value < 100.0 && rounded == "100" { "99".to_string() } else { rounded }
   // printed_percent: đọc lại từ chuỗi đã format, không round lần 2
   ```
   Vì sao: pool 99.86% còn lại không được vẽ bar đầy; màu band phải phân loại **số đã in**
   (remaining ≥50 OK / ≥20 WARN / LOW) để màu và số không bao giờ mâu thuẫn ngưỡng.
6. **[CAO] `metadata_matches` + danh sách token tĩnh — chặn no-op write**
   `plugin/server/publish-tui.mjs` / `publisher-tui-lifecycle.mjs` — excerpt herdr.rs:2347:
   ```rust
   fn metadata_matches(current, desired) -> bool {
       METADATA_TOKEN_NAMES.into_iter().all(|n| current.get(n) == desired.get(n))
           && OBSOLETE_METADATA_TOKEN_NAMES.into_iter().all(|n| !current.contains_key(n))
   ```
   Vì sao: mỗi lần publisher viết token giống giá trị cũ là một repaint/pulse lãng phí;
   thêm token mới mà quên đưa vào danh sách so sánh ⇒ mọi refresh thành write. Ta cần
   hằng số TOKEN_NAMES duy nhất + test "mọi token được publish đều nằm trong danh sách".
7. **[TRUNG] merge_omitted_window_list + sibling reset check** cho receipts/state window
   của gate (đã nêu tầng 1, tầng 2 bổ sung excerpt `sibling_quota_reset_in`,
   model.rs:1209-1227: reset khác nhau HOẶC used giảm >5 điểm = đã reset, không khôi phục).
8. **[TRUNG] prune map có giới hạn (MAX_STATUSLINE_SESSIONS=128)** — `prune_session_map`
   (cache.rs:1290-1304): xóa session-id cũ nhất không còn trong current set khi map vượt
   128. Áp vào mọi state map theo session của publisher (receipt cache, usage cache) để
   không mọc vô hạn theo số session.
9. **[TRUNG] AgentSelection SUPPORTED append-only + prefix rule** — AGENTS.md "Adding a
   harness": saved list là prefix của mảng ⇒ thêm harness không phá prefs cũ. Áp vào
   danh sách agent/model provider của herdgate nếu persist lựa chọn người dùng (#81 của
   họ là crash thật: Muse thêm vào giữa).
10. **[TRUNG] env không tới plugin action ⇒ prefs file là kênh duy nhất** — AGENTS.md đo
   bằng `printenv` probe: action chạy trong env server, 61 biến chỉ 2 Herdr-related sống.
   Áp vào cloud/gateway config passing: không bao giờ truyền lựa chọn qua env cho hook,
   dùng file trong state/config dir (`prefs.rs` pattern: file nhỏ, đọc trước env).
11. **[THẤP] `spells_period` tolerance + `source_label` giữ nguyên** (model.rs:366-386):
   window duration 299'/10079' vẫn map 5h/7d; label của upstream (`1d`, `Monthly`) đi
   theo window tới UI, không normal hóa tắt. Áp khi hiển thị nhiều loại plan window.
12. **[THẤP] `ResetAt` untagged Unix|RFC3339** (model.rs:425-454): deserialize cache cũ
   dạng chuỗi, serialize mới dạng số — bài học migration format cache không bump.

## Cách họ test (pattern đáng học cho suite 213 test của ta)

1. **Stub binary `herdr` bằng shell script + PATH/HERDR_BIN_PATH** — core pattern, dùng ở
   cả 6 test integration:
   ```rust
   // tests/configure_round_trip.rs:54 + watch_handoff.rs:60
   fs::write(&executable,
       "#!/bin/sh\nif [ \"$1 $2\" = \"agent list\" ]; then printf '%s\\n' '{}' \n\
        elif [ \"$1 $2\" = \"pane report-metadata\" ]; then printf '%s\\n' \"$*\" >> '{}' fi\n");
   fs::set_permissions(&executable, fs::Permissions::from_mode(0o755));
   ```
   Test chạy **binary thật** (`CARGO_BIN_EXE_herdr-agent-usage`) với `HERDR_PLUGIN_STATE_DIR`
   = tempdir, mọi phụ thuộc ngoài bị thay script ghi log → assert số lần gọi + argument.
   herdgate: stub `herdr` CLI + fake Pi sessions dir tương tự cho publisher e2e.
2. **Fixture = hợp đồng ghi từ API thật, redacted** (`provider_contracts.rs`): mỗi
   `fixtures/<provider>/*.json` chú thích nguồn "Recorded from a live ... call"; test chỉ
   assert mapping số liệu (remaining→used flip, ms→s, label). Ta cần bộ fixture
   `~/.pi/agent/sessions/*.jsonl` thật (redact) làm contract cho pi-usage parser.
3. **`test_support` line-builder + filler_run** (pi.rs:886-1010): sinh transcript >8MB
   bằng chuỗi `custom` entry pad 4KB — test window boundary mà không commit file lớn.
   `the_window_keeps_the_line_it_starts_on_and_drops_a_line_it_cuts` (pi.rs:1514) test đúng
   lỗi off-by-one ở line boundary. Áp trực tiếp cho test parser JSONL của ta.
4. **Deadline-loop + try_wait thay sleep cứng** (watch_handoff.rs): poll tới 5s, kill child,
   assert process còn sống/không; xử lý cả lease-collision bằng retry ("a lease collision
   is not read as a failed handoff"). Suite 213 test của ta nhiều test timer — chuyển hết
   sang pattern này chống flake.
5. **`env_guard()` mutex** (providers/mod.rs:70-79): "Environment variables are
   process-global. Keep provider tests that redirect credential paths from observing one
   another's values" — test song song đổi env phải qua lock. Áp cho vitest pool forks khi
   test đọc env (HOME, PI_CODING_AGENT_DIR).
6. **Guard chống watcher test ô nhiễm**: `nudge_quota_watch` từ chối chạy khi
   `RUST_TEST_THREADS` set (refresh.rs:2284) — child process không tự spawn watcher trong
   test. herdgate: publisher test cần cờ tương tự (`NO_WAKE_NUDGE`) để event không đẻ thêm
   process ngoài test.
7. **Test manifest như config contract** (`plugin_manifest.rs`): parse chính
   `herdr-plugin.toml` của repo, assert event→entrypoint routing, action tồn tại, và
   **height ≥ 3+7+fields+agents+6** walk danh sách sống — thêm option mà quên popup là test
   fail. Áp: test `plugin/herdr-plugin.toml` của herdgate mỗi event trỏ đúng command.
8. **Test hành vi install/upgrade bằng stub cargo+herdr** (`install_upgrade.rs`): chạy
   `install.sh` thật với `PATH` chỉ tới stub, assert preferences được giữ. Áp cho deploy/
   scripts của herdgate.
9. **Test tên là câu đặc tả hành vi**: `idle_statusline_tick_does_not_regress_profile_quota`,
   `an_unstamped_newest_reply_does_not_borrow_an_older_credential` — đọc tên biết invariant;
   ~135 test inline trong src + 91 test round-trip. Đáng chấm điểm suite ta theo tiêu chí này.
10. **CI** (.github/workflows/ci.yml): matrix ubuntu+macos, `RUSTFLAGS=-D warnings`,
    fmt+clippy+test `--locked`, build release `--locked`, **cron hàng tuần cho advisory**
    ("a dependency advisory can land without anyone touching this repository") + cargo-audit.

## Anti-pattern / không lấy gì

- **Toàn bộ tầng TUI Herdr**: vendor_nesting/nested head/mark_one_quota_row_per_vendor/
  gauges/sidebar width/icon font PUA — 5451 dòng herdr.rs + 3063 presentation.rs dính
  contract metadata-token của Herdr 0.9; herdgate PWA có UI riêng. Chỉ lấy ý metadata_matches.
- **Đọc pane từng bị đo 4.45s/lần + repaint 1:1** (docs/pane-repaint-diagnosis.md): nỗi đau
  của plugin-sidebar; herdgate publisher đã passive-đọc-file đúng — không học đường nào
  quanh `herdr pane read`.
- **Spawn process per refresh** (omp `usage --json`, `security find-generic-password`):
  chấp nhận được cho plugin desktop; cloud/pipeline herdgate không nên spawn CLI để lấy
  data mà ta đọc file được.
- **Keychain approve flows, TCC, font pipeline, install.sh/uninstall.sh, alias adoption**:
  platform/installer cụ thể macOS.
- **Debounce 60s + polling watcher là loop 1s thread::sleep**: hợp cho TUI desktop; herdgate
  nên giữ event-driven (wake-event) làm chính, debounce chỉ là lớp dưới — không copy loop.
- **Cache đẹp bằng JSON pretty từng file riêng** (`<identity>.json` + marker + lock = ~4
  file/target): đơn giản nhưng n file nhỏ; herdgate một máy có thể gộp, giữ nguyên nguyên
  lý atomic-replace-tmp-rename (cache.rs:1010 `atomic_replace` xóa tmp khi rename fail).
- **Bài học âm tính họ ghi lại**: (a) Claude/Agy không account id đáng tin trong statusLine
  → phải tự stamp digest từ file config riêng; (b) `state.vscdb`/`agent.db` không mở vì
  token sống; (c) "Inventing a TTL" — chỉ Codex được hardcode 30m vì documented, ai khác
  không có TTL thì ẩn. Nguyên tắc: **missing > confidently wrong**.

## File đã đọc (đầy đủ)

Đọc trọn (code + test-in-file):
- `src/cache.rs` 1–1710 (toàn bộ code; 1711–3270 là tests — đã enumerate 40 test name)
- `src/refresh.rs` 1–2370 (toàn bộ code; 2371–5143 tests, name list đã xem)
- `src/model.rs` 1–2291 (đọc 331–1470 mới ở tầng này; 16–330, 1040–1099 trùng tầng 1)
- `src/pi.rs` 1–1582 (trọn, gồm 26 test + test_support builder)
- `src/route.rs` 1–164 (tầng 1) + 38–344 `resolve_with_identity`/dispatch các harness
- `src/providers/mod.rs` (full 118 dòng): HTTP_AGENT, credential_id, env_guard, ProviderError
- `src/herdr.rs` 204–540 (AgentPane/session/socket_request/list_agent_*), 1088–1340
  (publish paths + metadata_matches), 1904–2113 (PayerEvidence/QuotaGroups/memoized_scope)
- `tests/provider_contracts.rs` (full), `tests/watch_handoff.rs` (full),
  `tests/plugin_manifest.rs` (full), `tests/gauges_publish.rs` 1–80,
  `tests/install_upgrade.rs` 1–60, `tests/configure_round_trip.rs` 1–60 + 91 test names
- `AGENTS.md` (full 599): event permission table, pane-read rule, 8 review invariants
- `herdr-plugin.toml` (full), `.github/workflows/ci.yml` (head 50)
Đọc lướt/nhanh (head + structure): docs/research/{cache-observability, codexbar-grok-usage,
codex-grok-context-cache, issue-22, omp-antigravity-daily-window, omp-integration,
omp-quota-sharing, opencode-go-console-meters, opencode-go-usage, oss-prompt-cache-ttl,
provider-quota-reset-ttl, quota-reset-capability, sidebar-dynamic-wrap}.md,
docs/pane-repaint-diagnosis.md; src/opencode.rs + src/cli.rs + src/presentation.rs
(structure + key fns); test count các file test còn lại.
Liệt kê theo vai trò (không đọc): src/configure/* (5.4k — writer config.toml), src/herdr_wrapper.rs,
src/dashboard.rs, src/settings.rs, src/prefs.rs, src/process.rs, src/icons.rs, src/identity.rs
(tầng 1), src/kilo.rs/mimo.rs/omp.rs, src/providers/{agy,claude,cursor,devin,grok,kilo,muse,
omp,opencode_go,statusline}.rs, install.sh/uninstall.sh, scripts/*, assets/fonts/*, CHANGELOG.

Phát hiện giá trị nhất (ngoài tầng 1): **lớp merge 2-kênh mailbox/refresh-copy trong cache.rs
+ settling-pass "mark-before-call" + máy trạng thái IconAttention seen_seq** — cùng bài học
cốt lõi: mọi cache/watch state phải keyed bằng identity chứng minh được, mọi write phải là
atomic replace, mọi marker ghi TRƯỚC khi thử, và mọi trạng thái "đã thấy" phải tự persist vì
nguồn sự kiện (server) sẽ nói dối bạn.
