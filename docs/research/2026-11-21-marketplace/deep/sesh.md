# herdr-plugin-sesh — Đào sâu tầng 2 (main@HEAD, Go ~24.2k LOC + 155d JS mod + docs + CI)

Tầng 1 (r-sesh.md) đã phủ: manifest, router app.go, sources merge, history revision/optimistic-lock, flock election, startup template, marker `sesh_last`, ResolveTarget. Tầng 2 này KHÔNG lặp — đào toàn bộ phần còn lại: picker TUI (1939d), AppClient dual-backend, settings editor + TOML patcher, config validation, preview engine, herdr-app mods, protocol doc, CI/verify harness, và 3 test file trọn.

## Kiến trúc đầy đủ (module graph: ai gọi ai, dữ liệu chảy thế nào)

```
cmd/herdr-sesh/main.go → internal/app.App (router 884d)
├─ config.Load (load.go: native `version=1` strict-decode / legacy sesh.toml + import đệ quy
│   + mergePresence — pointer distinguishes "absent" vs "explicit zero")
│   ├─ native.go: decodeNative + validate TOÀN BỘ layout khi load (fail trước khi tạo ws)
│   ├─ settings.go: SettingsDocument (baseline bytes + FileInfo + flock .settings.lock)
│   │   └─ settings_patch.go: patch AST TOML giữ comment/format (go-toml/v2/unstable)
│   └─ migrate.go/migration_review.go: legacy→native, validate bản dịch trước khi ghi
├─ sources.{herdr_workspaces,config_sessions,zoxide,directories} → merge.go (fan-out + absorb)
├─ state.{history (revision+flock), cache (sessions.json TTL keyed config-path), json (tmp+rename 0600)}
├─ connect.ResolveTarget (4 tầng) → startup.Plan/Apply (tabs/panes/wait_for, ratio đảo)
├─ herdr.NewBackend() → CLIClient (CLI + socket pane.focus) HOẶC AppClient (herdr-app do + hc)
│   ├─ client.go: Client interface 15 method + MachineClient (MachineHome/MachineExec)
│   ├─ app_client.go: execNamed (redaction), keepShown, shellArgv, PaneWaitOutput poll
│   ├─ events.go: WatchWorkspaceEvents (subscribe/ping/snapshot; proto 20 vs 21+)
│   └─ fake_client.go: FakeClient ghi Ops theo thứ tự gọi (dùng khắp test)
├─ picker: Model (filter 3 tầng) → tea.go (TUI chính) | fzf.go (fallback) | settings.go (embed)
│   └─ preview.{Render (runShell sentinel pgid), RenderPane (đọc screen), bat, remote (1 sh call)}
├─ settings (editor TUI 9 mode) — nhúng vào picker qua Backend.OpenSettings/ReloadSettings
├─ namer (git remote → tên session) · clone (git clone dest) · uitheme (OSC11 dark/light)
└─ herdr-app/mods/{sesh,sesh-last}/main.js — mod desktop (dialog terminal / block polling)
```
Dòng dữ liệu chính: config + 4 source → Sessions (thống nhất) → picker chọn 1 Session → connect.ResolveTarget → herdr Backend (focus/tạo) → startup.Apply → state.history ghi (revision) → watcher event → marker. Song song: picker → preview (cancellable) và Backend.RefreshAgentStatuses (tick 1s, generation).

## Máy trạng thái & luồng chi tiết

**1. Preview pipeline — request-ID generation (tea.go).** Mỗi chọn/move: `cancelActivePreview` bump `m.previewRequestID++` (tea.go:1295) rồi spawn render với ctx riêng; khi kết quả về, msg già bị drop:
```go
func (m teaModel) receivePreview(preview previewMsg) (teaModel, tea.Cmd) {
	if preview.requestID != m.previewRequestID || preview.key != m.previewKey {
		return m, nil                       // stale — rơi vào hư vô
	}
	m.preview = preview.text; m.previewLoading = false
	if m.cancelPreview != nil { m.cancelPreview(); m.cancelPreview = nil }
```
Loader "Loading preview..." chỉ hiện sau 500ms (`previewLoadingCommand`, tea.go:1304) — không nhấp nháy khi nhanh. Pane-preview tick 1s giữ snapshot cũ khi read kế đang bay (`refreshPanePreview`). Benchmark khóa hành vi: đúng 7 canceled/op + 1 completed/op.

**2. Đóng workspace trong picker — máy trạng thái 4 pha (tea.go:710–780).** `closingWorkspaceID` làm guard toàn cục: đang close thì enter/click bị nuốt; esc → hủy ctx + cờ `quitAfterWorkspaceClose`; msg về sai workspaceID bị drop. Reload thất bại → tự sửa list tại chỗ (bỏ entry closed, gỡ link parent của worktree con) thay vì ép reload lại. Selection được giữ bằng key so sánh sau re-filter.

**3. Settings editor — 9 mode (form/editing/array/arrayEditing/review/saving/discard/migration/reloadConfirm).** Save chạy trên bản sao doc ("render goroutine continues to read the old baseline", settings/settings.go:480); xung đột đĩa = `ErrSettingsConflict` (inode+mode+bytes) → hiện "r reload" thay vì mất draft.

**4. Watcher bootstrap 3-connection (events.go + docs/development/workspace-history.md).** sequence: `events.subscribe` → ack → decoder buffer chạy NGAY (đóng cửa sổ bootstrap) → `ping` riêng (≥20) → `session.snapshot` riêng. Proto 20: mỗi batch event lấy snapshot mới, focus chỉ ghi nếu ws còn sống / close chỉ ghi nếu đã chết, sau đó ghi `focused_workspace_id` của snapshot (re-anchor, không timer). Proto 21+: buffer + live theo decoder order. Buffer 1024 event; stream đóng = exit thành công, KHÔNG reconnect.

**5. sesh-last mod — settle-debounce + promise chain (mods/sesh-last/main.js:30,74).** App tự chuyển space khi `connect --no-focus` → flash giả; chỉ space giữ ≥500ms mới tính là switch. Các record switch xích tuần tự:
```js
this.recording = this.recording
  .then(() => sesh(["app", "record-switch", from, space]))
```
để switch nhanh vẫn tới history đúng thứ tự; lỗi chỉ notify 1 lần (`warned`).

**6. Sort "family" (tea.go:941).** Workspace + worktree con là một family, rank = rank tốt nhất của thành viên; cha trước con; prefix cây `├─/└─` chỉ vẽ khi family nằm liền kề trong danh sách HIỆN THỜI (visible) — không fake tree.

## Mọi cơ chế áp vào herdgate

1. **[CAO] Generation-token cho mọi async UI (requestID/generation).** Excerpt trên (tea.go:1239–1247); status tick cũng vậy: `if tick.generation != m.refreshGeneration || m.backend == nil { return m, nil }` (tea.go:457). Áp: op Cmd+K + PWA Jobs/Search của herdgate — mỗi query/job-fetch gắn `requestID` monotonic, response về với id khác id hiện tại thì drop (thay vì race "kết quả cũ đè mới"). Vì sao: herdgate relay/PWA nhiều nguồn async (gate, cloudflared, agent) — pattern này triệt tiêu stale-write không cần lock.
2. **[CAO] Guard đơn biến cho thao tác phá hoại (closingWorkspaceID).** `func (m teaModel) closeSelectedWorkspace()`: guard + cancel-func + cờ quit-sau-khi-xong + fallback sửa state cục bộ khi reload hỏng (tea.go:710–780). Áp: op kill/stop agent trong Cmd+K và PWA Jobs — một biến `pendingKillId`, esc = hủy, lỗi refresh = giữ snapshot cũ. Vì sao: chuyển việc phá hoại thành máy trạng thái mini thay vì flag rải rác.
3. **[CAO] Delayed-loading indicator (500ms) + giữ snapshot cũ trong lúc refetch.** `previewLoadingCommand` timer 500ms (tea.go:1304); `refreshPanePreview` "Keep the last snapshot visible while the next read is in flight". Áp: PWA Jobs/Search — spinner chỉ hiện nếu fetch >500ms, list cũ giữ nguyên tới khi có dữ liệu mới. Vì sao: xóa nhấp nháy, cảm giác "instant" cho cache hit.
4. **[CAO] Redaction nguồn lỗi: env/secret không bao giờ lọt error text.** `execNamed` (app_client.go:104) — tên lệnh thay argv; message của herdr-app bị withhold nếu chứa giá trị env (kiểm cả raw lẫn JSON-escape 2 biến thể HTML, `echoesAny` :145); CLI path: `redactEnvArgs` (client.go) đổi `--env K=V` thành `K=<redacted>`. Áp: publisher + mọi chỗ herdgate spawn lệnh có token (gate token, SSH key path) — error/log phải lọc giá trị trước khi ghi timeline/PWA. Vì sao: họ giải đúng bài toán "process echo lại argv của mình".
5. **[CAO] Env qua argv, không qua shell parse; lệnh cd gửi SAU login files.** `shellArgv` (app_client.go:334): `/bin/sh -c 'cd -- "$1"; shift; exec env "$@" "${SHELL:-/bin/sh}" -l' sh <dir> K=V...` — giá trị đi như argument, không qua parsing; cd vào dir lỗi vẫn start shell ("exiting would end the terminal before its startup command arrives"). Áp: task.mjs / publisher khi spawn agent với env — luôn argv-array + env-map, không bao giờ string-concat shell. Vì sao: phòng注入 + shell-escape đúng mọi nền tảng.
6. **[CAO] "keepShown" — undo focus副作用 của create.** herdr-app focus mọi thứ nó tạo; AppClient chụp tab đang shown trước, `defer errors.Join(err, restore())` (app_client.go:312). Áp: herdgate khi tạo pane/tab nền (worktree pipeline, job pane) — capture focus trước, restore sau, lỗi restore không nuốt lỗi chính (errors.Join). Vì sao: pattern 3 dòng cho "background create không ăn focus".
7. **[CAO] Settings doc: baseline bytes + inode/mode check + flock giữ inode + atomic no-clobber.** `persistModeChecked` (settings.go:294): flock file `.settings.lock` (comment: "deleting lock files lets concurrent writers lock different inodes"), double-check `unchanged()` trước VÀ sau write, missing-file tạo bằng `os.Link` (atomic no-clobber), chmod giữ mode cũ. Áp: mọi state file herdgate do PWA + TUI + publisher cùng ghi (jobs.jsonl, receipts) — kiểm baseline trước write, phát hiện "file đổi dưới tay". Vì sao: đây là bản đầy đủ nhất của optimistic-write tôi thấy trong 2 tầng đào.
8. **[TRUNG] TOML AST patch giữ comment (settings_patch.go:67–188).** `patchSetting` duyệt AST, splice byte theo offset; comment trong array được nhét lại vào array mới; CRLF-aware. Chỉ cho phép key trong whitelist `editableSetting`. Áp: nếu herdgate có config người-dùng-dựng (nếu thêm) — không re-marshal toàn file. Vì sao: 188d cho đúng bài toán "sửa 1 key không phá comment của user".
9. **[TRUNG] Validate toàn bộ config TRƯỚC khi tạo workspace.** native.go `validatePanes` (:345): pane đầu không được split; split_from phải là pane TRƯỚC đó; đúng 1 focus/tab; `wait_for.match` không được nằm trong startup (shell echo lệnh gõ — :415) và chỉ 1 dòng; ratio 0.1–0.9 "reject values it would silently change". Áp: config spawn/worktree pipeline của herdgate — validate đồ thị (step kế phải tham chiếu step trước, đúng 1 focus) ở load-time. Vì sao: lỗi config phải fail trước khi half-built workspace tồn tại.
10. **[TRUNG] Kill process-group bằng sentinel STOP.** runShell (preview.go:71–105): spawn `sh -c 'kill -s STOP "$$"'` làm sentinel, cho nó pgid riêng, lệnh preview thừa hưởng pgid đó; hết hạn → `kill(-pgid, SIGKILL)` giết cả cây cháu. Áp: publisher/PWA preview hoặc lệnh probe (git status qua SSH) cần timeout sát thực. Vì sao: exec.CommandContext chỉ giết tiến trình trực tiếp; con cháu mồ côi là bug thật.
11. **[TRUNG] Remote protocol 1-round-trip có header framing.** remote.go `remoteScript`: 1 lần `hc exec` chạy ls + git status, in header `"<git_status> <listing_len>"` rồi body — parser cắt theo byte-length, "the header splits them whatever the file names hold"; `LC_ALL=C` để parse "not a git repository"; chỉ dùng POSIX `ls -A -p -1`. Áp: herdgate probe máy SSH (direnv/git/phiên bản tool) — gộp N probe thành 1 call với framing tự mô tả. Vì sao: giảm round-trip VPS + miễn nhiễm tên file lạ.
12. **[TRUNG] Wait-for barrier chống self-match.** AppClient.PaneWaitOutput: từ chối match xuất hiện trong dòng cd đã echo (`directoryCommands` map nhớ lệnh cd từng gửi); native validate cấm match ⊂ startup. Áp: worktree pipeline chờ "server ready" — match phải không trùng chuỗi lệnh vừa gửi. Vì sao: barrier trở thành no-op nếu match ngay echo — họ đã gặp và test (TestApplyRejectsMatchEchoedByResolvedStartup, kể cả sau khi `{}` mở rộng).
13. **[TRUNG] Debounce settle + xích promise bảo thứ tự.** sesh-last mod (excerpt trên). Áp: PWA websocket events chuyển workspace/agent — chỉ ghi switch nếu trạng thái giữ ≥X ms; các ghi đi qua 1 promise-chain duy nhất. Vì sao: phân biệt flash (connect --no-focus) với switch thật.
14. **[TRUNG] Filter 3 tầng: name > path > home pinned đầu.** model.go `Filter`: homeMatches lên đầu, name-match giữa, path-match cuối; `Match` separator-aware thay `- _ / .` bằng space. Áp: Cmd+K herdgate — rank theo loại match, không chỉ score. Vì sao: 135d, dùng lại gần nguyên vẹn cho search session/worktree.
15. **[THẤP] Cache keyed theo config-path + TTL + invalidate-on-save.** state/cache.go: `payload.ConfigPath != configPath → miss`; settings editor xóa cache sau save (app/settings.go:37). Áp: cache Cmd+K/spawn-registry — key theo config; mọi path sửa config phải chủ động invalidate.
16. **[THẤP] Theme detect 1 lần qua OSC 11.** uitheme `DetectHostAppearance` = `lipgloss.HasDarkBackground(os.Stdin, os.Stdout)`. Áp: TUI herdgate chọn palette sáng/tối theo terminal thật.
17. **[THẤP] fzf-fallback mirror bằng "protocol" tab-framed.** fzf.go: input `%d\t...` index ở field 1, `--with-nth=3,4,5`, `--nth=2..3`; preview là script sh tái tạo logic preview Go. Áp: nếu TUI herdgate cần chế độ headless/scriptable. Vì sao: cùng data-model, 2 renderer — tách Model/View sạch.

## Cách họ test (bài học cho suite 213 test của ta)

- **Fake unix-socket server làm harness protocol (events_test.go).** `acceptRequest(listener, "ping")` assert method từng kết nối; server script từng kịch bản (replay trễ proto-20, event trong cửa sổ snapshot, stream đóng không reconnect, cancel giữa bootstrap). Mỗi test = 1 kịch bản giao thức viết như sequence-diagram sống. Áp: test relay/publisher herdgate bằng server socket giả thay vì mock object.
- **Self-reexec cho khóa liên tiến trình (history_test.go).** Test cha giữ flock, re-exec chính test binary với env `HERDR_SESH_HISTORY_LOCK_HELPER=1` làm helper in "ready", cha đo helper KHÔNG ghi khi lock giữ, ghi sau khi thả (assert timeout 100ms không nhận "done"). Áp: test publisher lock máy — không cần tiến trình ngoài.
- **Ops-log fake client.** FakeClient ghi `Ops []string` ("create tab dev", "wait new-pane:Local:", "split...") — assert cả THỨ TỰ thao tác, không chỉ kết quả (startup_test TestApplyWaitsForReadinessBeforeLaterPanes). Áp: fake cho publisher/worktree pipeline ghi op-log.
- **testing/synctest cho animation/timeout** (tea_test.go import `testing/synctest`) + TestMain khóa env (`HERDR_SESH_SMEAR_PRESET=crisp`, `HERDR_SESH_BACKEND=herdr` — "pane previews must never reach a live herdr-app"). Áp: suite herdgate phải khoá env biên giới (không agent thật) trong TestMain.
- **Benchmark behavioral metrics**: `canceled/op assume=exact 7`, `completed/op exact 1` — tối ưu không được đổi hành vi. Áp: benchmark Cmd+K filter với "kết quả đúng N item, 0 stale-write".
- **CI (test.yml)**: `gotestsum -- -race ./...` + build + CLI smoke `list --json --config testdata/...` + test release-ref. AGENTS.md kỷ luật: `require` cho prerequisite (trên goroutine test), `assert` cho expectation độc lập — testifylint cưỡng chế.
- **Verify skill (verify.py)**: evidence-dir pinned binary-hash, HOME riêng, `HERDR_BIN_PATH=/usr/bin/false` — "Herdr is unavailable, not simulated as successful"; PATH=/usr/bin:/bin; doctor chỉ-đọc. Áp: herdgate nên có harness verify CLI với biên giới "dependency = false" thay vì stub thành công.

## Anti-pattern / không lấy gì

- **Animation smear 3 preset + vật lý chuyển động** (smearPreset, acceleratedFocusSmearStep, ~300d tea.go + 600d test): đẹp nhưng chiếm ~1/4 picker; herdgate ưu tiên robust mobile/SSH — chỉ mượn ý `reduceMotion` env.
- **Dual backend CLI+App 650d** với 2 map nhớ pane↔terminal, poll `hc read --lines 1000` mỗi 250ms cho PaneWaitOutput (AppClient) — herdgate chỉ 1 đường Publisher, đừng nhân đôi.
- **Settings editor TUI 747d + patch AST 188d**: chỉ đáng nếu herdgate có config user-editable phức tạp; hiện tại overhead lớn.
- **Polling 100ms trong sesh-last mod** (timer.every(100)) để đo shown space — rẻ nhưng là polling; herdgate đã có event stream thì dùng event.
- **zoxide/eza/bat exec + PATH giả định login-shell** (fzf.go nhét hard-code list đường dẫn homebrew/mise) — môi trường VPS herdgate không đảm bảo; nếu mượn phải qua publisher PATH chuẩn (tầng 1 đã nói, vẫn đúng).
- **Marker sync 2s đồng bộ mỗi event** ("ponytail") — tầng 1 đã nêu; tầng 2 xác nhận ở docs: chỉ subscriber được report, lỗi = warning, nhưng vẫn blocking 2s context mỗi mutation.
- **Go-only + flock + /proc/locks + lsof bundling**: platform-specific (linux/darwin file riêng); herdgate cross-platform Node — chỉ mượn semantics, không mượn cài đặt.

## File đã đọc (đầy đủ + dòng đã đọc)

Tầng 2 (mới, trọn file): `internal/picker/tea.go` (1–1939), `internal/herdr/app_client.go` (1–651), `internal/herdr/client.go` (1–632, tầng 1 mới đọc 300), `internal/config/native.go` (1–560), `internal/settings/settings.go` (1–748), `internal/config/load.go` (1–372), `internal/config/settings.go` (1–352), `internal/config/migrate.go` (1–247), `internal/config/settings_patch.go` (1–189), `internal/state/cache.go` (1–46), `internal/state/json.go` (1–29), `internal/preview/preview.go` (1–133), `internal/preview/remote.go` (1–156), `internal/preview/bat.go` (1–116), `internal/clone/clone.go` (1–32), `internal/namer/namer.go` (1–70), `internal/model/options.go` (1–5), `internal/herdr/backend.go` (1–90), `internal/herdr/fake_client.go` (1–185), `internal/herdr/pane_preview.go` (1–37), `internal/picker/model.go` (1–136), `internal/picker/fzf.go` (1–171), `internal/app/settings.go` (1–62), `internal/app/history_watcher_linux.go` (1–53), `internal/config/wildcard.go` (1–48), `herdr-app/mods/sesh/main.js` (1–67), `herdr-app/mods/sesh-last/main.js` (1–90).
Docs: `docs/development/workspace-history.md` (1–361), `docs/development/benchmarks.md` (1–185).
Test (trọn): `internal/herdr/events_test.go` (1–551), `internal/state/history_test.go` (1–493), `internal/startup/startup_test.go` (1–328).
Test/harness (skIM có chủ đích): `internal/picker/tea_test.go` (1–90 + danh sách 40 tên test), `.github/workflows/test.yml` (1–58), `justfile` (recipe test/bench/check), `AGENTS.md` (1–50), `.agents/skills/verify-herdr-sesh/SKILL.md` (1–60) + `scripts/verify.py` (1–80), `internal/uitheme/theme.go` (grep + hàm DetectHostAppearance).
Không đọc lại (tầng 1 đã phủ, xem r-sesh.md): app.go, picker_backend.go, last_marker.go, sources/*, state/history.go, model/session.go, connect.go, startup.go, main.go, herdr-plugin.toml, events.go (đã đọc tầng 1; tầng 2 đọc lại qua test + doc).
Liệt kê theo vai trò (chưa đọc dòng, không phải lõi): config/migration_review.go, config/config.go, uitheme/theme.go phần palette, app/history_watcher_darwin.go, picker/{theme,settings}.go, các *_test.go còn lại (~8.5k dòng test), CHANGELOG.md, docs/{config,keybindings,commands,troubleshooting,herdr-app,index}.md, CI workflows khác (lint/release/benchmark/gitleaks), testdata/*.toml, install_plugin.sh.
