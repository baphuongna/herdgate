# herdr-agent-usage — Usage theo PAYER credential-scoped (nghiên cứu cho herdgate)

Repo: levi-qiao/herdr-agent-usage v1.7.0 (MIT) — Rust plugin cho Herdr TUI, hiển thị quota/context/cache
của 12+ agent CLI, gộp dòng theo **ai trả tiền** (payer), không theo tab/pane.

## Kiến trúc cốt lõi (file-level)

- `herdr-plugin.toml` — manifest: `startup` chạy watcher; actions `refresh|configure|open-settings|toggle-agent-order|uninstall`;
  **events**: `pane.agent_detected`/`pane.agent_status_changed` → `event`, `pane.focused`/`tab.focused`/`workspace.focused` → `focus`,
  `pane.closed|moved`, `tab.closed|moved` → `layout` (regroup ngay). Panes popup `dashboard` + `settings`.
- `src/model.rs` — domain lõi: `Provider`, `Harness`, `CredentialScope` (CANONICAL/OPENCODE_STORE/OMP_STORE/KILO_STORE),
  `BillingTarget{billing, credential_scope, scope_hash}` + `cache_identity()`, `Resolution{Subscription|NoSubscription|Indeterminate}`,
  `UsageWindow{kind, used_percent, remaining_percent, resets_at, source_label}`, `ProviderSnapshot` (account_id + credential-mtime gate),
  `ContextUsage`/`CacheUsage` (ttl estimate, session totals).
- `src/route.rs` — `resolve_with_identity(pane)`: mỗi harness một resolver riêng, "missing/malformed → Indeterminate,
  **không bao giờ suy đoán pane từ số credential trên đĩa**".
- `src/pi.rs` — parser JSONL v3 dùng chung Pi + omp (omp là fork Pi, cùng format, chỉ khác credential store + model catalog).
- `src/providers/*.rs` — collector từng harness: codex (app-server RPC + rollout files), claude/agy (StatusLine hook),
  grok/devin/muse/cursor (CLI endpoints), omp (`omp usage --json`), kilo (auth.json + gateway), `providers/mod.rs`: shared
  `ureq::Agent` (5s connect/10s read, `redirects(0)` để không replay credential sang host khác) + `credential_id(key) = "key:"+sha256`.
- `src/refresh.rs` — background watcher: file lock `turn.lock`, cap 1h, debounce 60s/target, settle pass sau turn, reexec khi
  binary/env Herdr đổi; failed request giữ lại reading cũ (không bao giờ về 0).
- `src/identity.rs` — plugin id + alias `herdr-agent-quota`, `adopt_alias_plugin_dirs()` migrate state khi đổi id.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **BillingTarget credential-scoped** (`model.rs:210-312`): payer = (billing provider, credential scope, sha256 scope_hash).
   `cache_identity()` là filename stem của cache/lease/debounce marker — "an omp-billed Claude can never overwrite the canonical
   Claude snapshot". Hai profile omp ≠ nhau không bao giờ share usage report (scope_hash gồm agent_dir + provider_id).
2. **Pi usage parse từ đâu** (`src/pi.rs`):
   - `PiPaths::from_env()`: `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), `PI_CODING_AGENT_SESSION_DIR` (default `sessions/`);
     `auth.json`, `models.json`, `models-store.json`.
   - `read_transcript()`: file >8MB (`MAX_SESSION_BYTES`) thì đọc **header 64KB + 8MB mới nhất**, mở đúng line boundary
     (line bị cắt bởi window start bị bỏ, không parse); window đo từ length lúc đọc nên line append giữa chừng đợi lượt sau.
   - `parse_session_file()`: validate header `session` v3 + `filename_matches_session_id` (stem == id hoặc `*_<id>`);
     `active_branch()` walk newest→root theo `id`/`parentId` (transcript windowed chấp nhận parent nằm trước window);
     `active_model()`: `model_change` (role default) + assistant message cuối; `message_provider_id` = provider của assistant
     reply mới nhất — **phải bằng provider của session** mới tính.
   - `usage_counters()`: Pi viết `input/output/cacheRead/cacheWrite/cacheWrite1h/totalTokens/contextTokens` (omp viết
     `cttl.ephemeral1h`). `context_tokens()` = contextTokens || totalTokens || tổng 4 counter (saturating).
   - Tổng session: cộng usage của message assistant/**toolResult** + `branch_summary` + `compaction`; windowed sum không phải
     tổng session → cờ `usage_totals_cover_session` mới cho hiển thị CacheTotals.
3. **Pi → quota Codex chỉ khi account khớp** (`pi.rs:resolve_with_session`): đọc `auth.json[provider_id]` (chỉ deserialize
   metadata `type`/`accountId`, **token không bao giờ vào Rust value**); `api_key` → `NoSubscription` (PAYG);
   `oauth` + provider `openai-codex` + `auth.accountId == codex::current_account_id()` (từ `~/.codex/auth.json`
   `tokens.account_id|chatgptAccountId`, `codex.rs:account_id_from_auth`) → `Subscription(Codex)`. Sai một điều kiện → Indeterminate.
4. **Context meter Pi** (`pi.rs:session_context` + `context_usage`): từ chối publish % nếu `models.json` tồn tại (override cục bộ
   làm effective contextWindow không ghi ở đâu); else `models-store.json[provider].models[contextWindow]` vs
   `context_tokens()` — context lấy **sau `compaction` cuối cùng** (`context_tokens(branch)`). Cache hit-rate từ turn mới nhất
   (input/cacheRead/cacheWrite); TTL estimate: anthropic 5m/1h theo `cacheWrite1h>0`, openai-codex cố định 30m
   (`CODEX_PROMPT_CACHE_TTL_SECONDS`) neo theo timestamp message chạm cache cuối.
5. **"Payer không chứng minh được giữ dòng riêng"**:
   - `ProviderSnapshot::usable_for_account()` (model.rs:1040): snapshot có account_id ≠ current → unusable; snapshot không
     account mà credential file mtime > fetched_at → unusable.
   - Claude `quota_session_for_lookup()` (model.rs:849): session không có account digest → **giữ window của riêng nó**
     ("nothing proves who pays"); cùng account thì share reading mới nhất, so từng window-kind độc lập (5h mới không đè 7d tươi hơn).
   - `model_for_session`/`context_for_session`: session đã biết không mượn giá trị provider-level của pane khác.
   - `unattributed_session_reason()` (refresh.rs:1035): lý do actionable — `restart pane: no pi session` / `first turn writes the
     pi session` (`transcript_unwritten`: file absent hoặc rỗng).
6. **Quota windows** (`model.rs:440-501`, `codex.rs:57-160`): `UsageWindow` validate used 0..100, remaining = 100-used;
   `is_current`: thiếu reset time thì "cannot be proved stale" → vẫn hiển thị; `window_kind()` map theo **duration** với tolerance
   (299/10079 phút vẫn là 5h/7d), không theo vị trí primary/secondary; `merge_omitted_windows()`: upstream bỏ sót window
   (Codex `secondary:null` sau reset) → chỉ khôi phục khi reset vẫn ở tương lai VÀ sibling window chung hai snapshot chưa reset;
   list rỗng = "rate limits absent" → clear, không phải giữ cũ.
7. **Watcher & debounce** (refresh.rs:115-243, 1669-1733): `watch()` đổi theo `working_pane_ids` (chỉ pane đang chạy turn), settle
   pass cuối sau debounce; `should_skip_fetch_for_account`: snapshot **account khác thì không được debounce** (fetch ngay);
   không có snapshot gì thì vẫn debounce (missing credentials không được đập API); `debounce_reuses_snapshot`: window đã hết hạn
   → force refetch dù trong cửa sổ debounce.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên cao/thấp)

- [CAO] Publisher Pi: port parser `pi.rs` sang Node (publisher per-machine đã observe sessions): tail-window 8MB line-aligned,
  active-branch walk, model sau `model_change`, context sau `compaction`, usage counters + tổng session, cache TTL estimate.
  Dùng cho trang Usage + Jobs (tokens/turn). Không cần API nào — chỉ đọc JSONL.
- [CAO] Payer model cho Usage PWA: thêm khái niệm `BillingTarget` tương đương (provider + credential-scope + hash account);
  mỗi row Usage = một payer đã **chứng minh được** (auth.json accountId khớp account của nguồn quota); không chứng minh được →
  row riêng + reason (`first turn writes the session`), không merge, không đoán từ số credential.
- [CAO] Codex quota cho Pi sessions: fetch rate_limits qua codex app-server (hoặc đọc rollout) — parse `windowDurationMins`/
  `usedPercent`/`resetsAt` theo duration với tolerance; chỉ gán cho Pi session khi `auth.accountId == ~/.codex/auth.json` account.
- [CAO] Semantics `is_current` + `merge_omitted_windows` cho receipts/state JSONL của gate: window thiếu reset time không bị coi
  là stale; window bị omit chỉ khôi phục khi reset còn tương lai; request fail giữ reading cũ.
- [TRUNG] Context meter: `contextTokens/totalTokens/tổng-counters` so `models-store.json` contextWindow; tắt khi có `models.json`
  override. Cache hit-rate + `ttl≈` như trên.
- [TRUNG] Debounce per-target keyed bởi cache_identity (60s), invalidate khi auth file mtime > fetched_at — thay wake-on-settle
  thô bằng event `pane.agent_status_changed` → refresh 1 pass + settle (đúng hướng chuyển sang herdr pane events).
- [THẤP] Dashboard/settings popup, toggle order, gauges — chỉ nếu làm TUI view; PWA đã có UI riêng.

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- Toàn bộ tầng trình bày Herdr: icon font PUA U+E1A0–U+E1B6, gauges, sidebar width detect, row gap — dính TUI Herdr, herdgate là PWA.
- macOS Keychain approve flows (cursor/muse), font-bundle pipeline, install.sh/adoption alias — platform/installer cụ thể.
- Collectors khác (kilo/cursor/devin/muse/omp pools) — chưa cần; chỉ lấy ý tưởng scoping.
- KHÔNG dùng `herdr pane read` để lấy data (chính repo cấm — repaint agent TUIs); herdgate publisher giữ nguyên đọc file passive.
- License: code MIT (học được, port cần attribution); font binaries là OFL/issued riêng — không reuse asset.
- Bài học âm tính: Claude/Agy không có account id đáng tin → không share reading giữa session — chấp nhận giới hạn này thay vì hack.

## File đã đọc

- README.md (full qua raw.githubusercontent, bước 1) + repo tree API (bước 2, 162 files).
- `herdr-plugin.toml` (full): manifest, events, actions, panes.
- `src/pi.rs` (dòng 1–1000, phần còn lại là test): `PiPaths::from_env`, `resolve_with_session`, `read_transcript`,
  `parse_session_file`, `active_branch`, `active_model`, `context_tokens`, `usage_counters`, `session_context`, `cache_activity`.
- `src/model.rs` (185–330, 435–510, 830–940, 1037–1099): `CredentialScope`, `BillingTarget::cache_identity`, `Resolution`,
  `UsageWindow::is_current`, `quota_session_for_lookup`, `usable_for_account`, `merge_omitted_windows`.
- `src/route.rs` (14–164): `resolve_with_identity`, `resolve_pi_with_identity`, `pi_identity`.
- `src/providers/codex.rs` (52–162, 938–1018): `parse_rate_limits`, `window_kind`, `account_id_from_auth`, `account_is_chatgpt`.
- `src/refresh.rs` (115–245, 1035–1135, 1669–1734): `watch`, `unattributed_session_reason`, `transcript_unwritten`,
  `should_skip_fetch_for_account`, `debounce_reuses_snapshot`.
- `src/providers/mod.rs` (full): shared HTTP agent `redirects(0)`, `credential_id`.
- `src/identity.rs` (full): plugin id/alias, `adopt_alias_plugin_dirs`.
