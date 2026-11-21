# Nghiên cứu fullerzz/herdr-plugin-sesh (v0.17.0, Go, MIT, 52★)

## Kiến trúc cốt lõi (file-level)
- `herdr-plugin.toml` — manifest plugin Herdr: `[[startup]]` + 2 `[[events]]` (workspace.focused/closed → `plugin watch-history`), `[[panes]]` overlay picker/settings, `[[actions]]` open-picker/last. Min herdr 0.8.2, linux/macos.
- `cmd/herdr-sesh/main.go` (16d) → `internal/app/app.go` (884d) — router lệnh: list|connect|preview|clone|root|last|window|picker|plugin|app|config.
- `internal/sources/` — 4 nguồn cùng interface `Source{Name(); List(ctx) (model.Sessions, error)}`: `herdr_workspaces.go` (running), `config_sessions.go` ([[session]]/[[workspace]] TOML), `zoxide.go` (exec `zoxide query -l -s`), `directories.go` (DirectPath). `merge.go` gộp.
- `internal/herdr/` — `client.go` (Client interface 15 method: WorkspaceCreate/TabCreate/PaneSplit/PaneWaitOutput/PaneRun…), `backend.go` (CLI vs app backend), `events.go` (subscribe event stream unix socket), `app_client.go` (650d, herdr-app + MachineClient qua hc).
- `internal/model/session.go` — Session thống nhất 1 struct cho mọi nguồn (Source/Name/Path/WorkspaceID/Machine/WindowConfigs/Worktree); `Sessions` = Directory map + OrderedIndex.
- `internal/state/history.go` — history ring 50 workspace + lock + Revision; `internal/app/last_marker.go` — token `sesh_last` lên sidebar.
- `internal/connect/connect.go` + `internal/startup/startup.go` — resolve target → focus/create + dựng layout tabs/panes theo template.
- `herdr-app/mods/sesh{,-last}/main.js` — mod desktop mở picker TUI trong dialog terminal.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)
1. **Merge fan-out song song + dedupe có "absorb"** (`sources/merge.go` `Merge`): mọi nguồn List đồng thời (WaitGroup), sort theo `cfg.SortOrder`; dedupe key = `[2]string{Machine, Name|Path}`; khi trùng, workspace đang mở **hấp thụ** entry config: giữ `PreviewCommand`, set `Configured=true` (biết "open space đứng thay cho configured entry"). Blacklist là list regex compile từng dòng.
2. **Track navigation NGOÀI sesh — watcher event stream** (`herdr/events.go` `WatchWorkspaceEvents`): dial unix socket `HERDR_SOCKET_PATH`, gởi `events.subscribe {subscriptions:[workspace.focused, workspace.closed]}`, đợi ack `subscription_started`, decode stream. Khởi động: `session.snapshot` lấy focused hiện tại + tập workspace sống → replay-dedupe (protocol <21 mới cần so snapshot mỗi batch event). **Không tự reconnect** — server restart để lifecycle hook sau bầu lại watcher.
3. **Bầu cử watcher bằng flock** (`app.go` `electHistoryWatcher` + `state.TryHistoryWatcherLock`): lock file `history-watch-%x(sha256 socketPath).lock`, `flock LOCK_EX|LOCK_NB`; startup hook chờ holder cũ 5s (poll 50ms) rồi SIGTERM holder cũ (`historyWatcherPIDs`), focus/close hook không chờ. Chỉ 1 subscriber/herdr socket.
4. **Optimistic concurrency cho ghi đè song song** (`state/history.go` `RecordSwitch`): caller capture `HistoryRevision()` TRƯỚC khi focus, ghi lại chỉ khi `h.Revision == observedRevision` — nếu watcher đã ghi event focus rồi thì revision đổi → plugin bỏ ghi, "watcher's ordered events win". `writeHistory` luôn `h.Revision++`. `RecordUnwatchedSwitch` cho backend không có watcher (app), `RetainWorkspaces(dir, live)` prune history theo workspace còn sống. Lock: flock 250ms timeout, retry 10ms; JSON hỏng đọc rỗng thay vì fail.
5. **State phân theo socket** (`state.SessionHistoryDir`): dir con `history/<sha256(socketPath)>` — history không lẫn session herdr khác; session default copy-once từ legacy.
6. **Template workspace tabs/panes** (`startup.go` `Plan/PlanInitialTab/Apply/applyPanes`): tab đầu tái dùng tab init của workspace (rename `claimInitialTab`) chỉ khi không có startup command ở workspace/root và cwd khớp path; split theo `split_from` với **đảo ratio** (`req.Ratio = 1 - pane.Ratio` vì config tính share pane mới, herdr tính share pane bị chia); `WaitFor` = barrier 1 lần qua `PaneWaitOutput` (match cả output in TRƯỚC khi wait); focus pane chỉ sau khi layout xong; lỗi giữa chừng "the workspace was kept" — không phá workspace.
7. **Stale-fallback + cache** (`app.go` `capturingSource`, `list`): source herdr lỗi → trả list cũ (fallback) + tách `HerdrErr` để UI hiện warning thay vì list rỗng; cache 5s keyed theo config path, lỗi cache chỉ warn rồi bỏ.
8. **Marker "last" trên UI** (`last_marker.go` `syncLastWorkspaceMarker`): diff token `sesh_last` từng workspace (`w.Tokens`), chỉ `WorkspaceReportToken` khi giá trị đổi — tự repair marker stale ở sync sau.
9. **ResolveTarget 4 tầng** (`connect.go`): workspace-ID (mọi machine) → local name/path → thư mục local (dir=true, Namer đặt tên qua git) → remote config theo name. Remote path không bao giờ match dir local (guard tường minh).

## Áp vào herdgate (checklist)
- [CAO] **Revision optimistic-concurrency cho receipts one-id** khi chuyển wake-on-settle → herdr pane events: thêm `revision` vào JSONL state, publisher capture trước khi phát lệnh, chỉ ghi nếu revision còn nguyên — hoà giải race "event watcher vs lệnh chủ động" giống `RecordSwitch`. Đích: module publisher/receipts writer.
- [CAO] **Single-observer election flock per-machine** cho publisher (mỗi máy 1 file lock sha256(machine/socket), SIGTERM holder cũ sau handoff timeout) — thay/ an toàn cho wake-on-settle khi restart máy. Đích: publisher startup.
- [CAO] **Stale-fallback pattern** cho PWA Jobs/Search: khi gate/cloudflared đứt, relay trả snapshot cuối + flag lỗi tách biệt (như `pickerCollection.HerdrErr`) thay vì list rỗng.
- [TRUNG] **Sources fan-out + Merge dedupe (machine,key) với absorb** cho Cmd+K: hợp running Pi sessions + spawn registry + worktree pipeline thành 1 danh sách, entry đang chạy giữ metadata của entry configured. Đích: op Cmd+K / search.
- [TRUNG] **RetainWorkspaces pruning** cho spawn registry `task.mjs revive`: history chỉ giữ task còn "sống" theo live snapshot — GC tự nhiên.
- [TRUNG] **WaitFor barrier qua PaneWaitOutput** cho pipeline worktree spawn: chờ server/agent in dòng sẵn sàng trước khi tạo pane kế tiếp; lỗi giữa chừng giữ workspace đã tạo (idempotent reconnect).
- [THẤP] Token marker kiểu `sesh_last` (diff-only report) cho badge "task cuối" trên PWA/TUI; zoxide integration cho Cmd+K đường dẫn; fzf fallback khi TUI không khả dụng.
- [THẤP] Xem `internal/herdr/events.go` làm tham chiếu giao thức khi herdgate tự subscribe herdr pane events (ack `subscription_started`, không reconnect, snapshot đầu).

## KHÔNG nên học
- **Plugin manifest/herdr-app mods**: ràng buộc platform linux/macos + hệ sinh thái herdr (`herdr-plugin.toml`, `hc run`, gpui-kit) — herdgate chạy Pi/SSH/PWA, không phải plugin TUI; chỉ mượn ý pattern.
- **Dual backend CLI+app 650 dòng** (`app_client.go`) + 2 bộ state dir tách biệt — độ phức tạp.getVersion thủ công; herdgate chỉ cần 1 đường.
- **zoxide/`eza` qua exec + giả định PATH login shell** — môi trường VPS/mobile SSH của herdgate không đảm bảo; nếu dùng phải qua publisher có PATH chuẩn.
- **Marker sync đồng bộ 2s mỗi event** (code comment "ponytail" tự thừa nhận) — herdgate nên coalesce nền.
- `ApplyConfig` mutate map sessions tại chỗ + wildcard matching regex — dễ lỗi âm thầm; herdgate nên immutable.
- License MIT — được phép học/tái sử dụng code (giữ attribution).

## File đã đọc (raw.githubusercontent, main@HEAD)
1. `herdr-plugin.toml` (manifest) 2. `cmd/herdr-sesh/main.go` 3. `internal/app/app.go` (884d, đủ) 4. `internal/app/picker_backend.go` 5. `internal/app/last_marker.go` 6. `internal/sources/{source,merge,zoxide,herdr_workspaces,config_sessions,directories}.go` 7. `internal/herdr/{client,events}.go` (client.go 300/631d) 8. `internal/state/history.go` 9. `internal/model/session.go` 10. `internal/connect/connect.go` 11. `internal/startup/startup.go` 12. `herdr-app/mods/sesh/main.js` + `mod.json` 13. README.md (grep cấu hình).
