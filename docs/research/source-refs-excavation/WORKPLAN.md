# WORKPLAN — phân tích từng phần, việc cần làm

Đối chiếu: collie (đã đọc lõi ~2.900 dòng: App, router, home, detail, agent-chat 711, composer 646, blocks 164, api 336, loaders 75, harness types/registry) vs hiện trạng herdgate (PWA app.js 2.886 dòng; plugin ops: view, term.list, term.read(lines 10–120, throttle 1/s), diff.get, receipt.*, usage.rollup, worker.*; SSH leg: hello, terminal.list, terminal.read, events.subscribe).

Tiền đề kỹ thuật đã kiểm chứng:
- `term.read` CÓ `lines` (kẹp 10–120) — Load-older khả thi, cần nới trần + map requestedLines.
- `term.read` KHÔNG trả `revision` — Mirror freeze bản đầy đủ (race guard) cần luồng revision/pane từ snapshot herdr (kiểm `src/host/herdr.ts` herdrPanes có lộ chưa; herdr 0.9.5 pane list thiếu `pid`, revision phải xác nhận).
- PWA hiện không có op gửi phím/nhập liệu (read-only qua WS; act pair mới có — kiểm gate act surface).

---

## Phần 1 — PWA viewer: mirror freeze · load-older · find-in-output
**Hiện trạng**: PWA render lại toàn bộ buffer mỗi lần view push; không đóng băng, không đọc scrollback cũ, không tìm kiếm.
**Việc cần làm** (từ agent-chat.tsx):
1. State `following` + cặp đóng băng `{text, revision}` + Object.is bailout (chống re-render mỗi push khi im lặng).
2. Chip "Nội dung mới ↓" khi `!following && display !== text` + nút jump-to-latest.
3. Load-older: map requestedLines theo pane (module cache, FIFO cap 20), grow → adopt theo `requestedLines` đạt (phòng poll cũ adopt sớm), neo scroll theo height-delta.
4. Nới trần `lines` 120 → 400 (cần cân nhắc payload E2E — measure trước).
5. Find-in-output trên buffer đóng băng: query + matchCount + prev/next + scroll-into-view; mở find = đóng băng tail.
6. Race guard revision cho mọi tap tương tác (khi có phần tương tác — thấy Phần 2).
**Khó**: vừa. **Phụ thuộc**: revision (mục 2.1). Có thể làm freeze bản 1 (không guard) trước.

## Phần 2 — Grammar engine cho agent Pi (port harness architecture)
**Hiện trạng**: PWA hiện ANSI thô; Pi TUI có dialog chọn (y/n, số), spinner, statusline — chưa parse gì.
**Việc cần làm**:
1. Port `lib/ansi.ts` (244) — parser AnsiSegment (thuần, không phụ thuộc React).
2. Port `lib/blocks.ts` AST: Block = raw | choice | … (bắt đầu với 1 grammar: dialog chọn của Pi) + `splitLines` + bất biến join("\n") == mirror text (find phụ thuộc).
3. Adapter registry (`harness/registry.ts` pattern): `adapterFor("pi")` — detection only; action recipes ở core.
4. Pi adapter: strip chrome (spinner/statusline), extractStatusLine (model · ctx% · cwd), extractInputDraft (draft kẹt dòng input — Pi có "❯"? xác nhận từ transcript thật).
5. Choice block → nút bấm native + macro gửi keys (Down→Up→verify→Enter từ multi-select-action.ts — cần op gửi keys, thấy Phần 3).
6. Test theo fixtures thật (bắt transcript Pi live vào test/fixtures).
**Khó**: lớn — làm theo grammar một-một, choice trước.

## Phần 3 — Act surface: composer + keys (PWA có thể GÕ)
**Hiện trạng**: PWA chỉ đọc; SSH leg cho phone Herdr app (đọc + events). Không có đường gửi text/keys qua WS cho PWA.
**Việc cần làm**:
1. Plugin op `term.write` (text + submit) và `term.keys` (mảng key có whitelist: Enter/Esc/Arrow*/y/n/0-9) — chỉ chạy khi device có act grant; tối ưu theo pattern send 3-trạng thái (delivered/stalled/unverified) của herdrchat.
2. Composer PWA: pending-send preview "You sent: …" (6s), destruct 2-tap (`isDestructiveInput` — port lib/destructive.ts), terminal-draft rescue đầy đủ (stable 1.5s + self-echo grace 5s + pre-clear ctrl+k/Backspace dư +32).
3. Keys tray (NavTray port —箭/pgup/…), Quick actions (continue/stop/…), per-agent slash palette (commandsFor — viết cho Pi).
4. Upload ảnh: đã có attachments op — thêm đường PWA pick ảnh → path chèn vào composer (đối chiếu attachments.mjs hiện có).
**Khó**: lớn (mặt act an toàn — giữ gate duyệt act-pair).

## Phần 4 — App-chrome PWA: idle lock · busy bar · connection banner · session/room
**Việc cần làm**:
1. IdleLock (unmount chính = pause polling — port use-idle-lock) — PWA hiện poll liên tục.
2. BusyBar (trackBusy mọi mutation) + connection-health anchor (markLive: 200/304 đếm live; view push với bridge-down KHÔNG reset) + banner leo thang (reconnecting → lost) — port connection-health.ts + connection-banner.tsx.
3. Timeout budget theo lớp op (GET 10s / mutation 20s / upload 60s) trong opFetch.
4. Reload-guard: chặn self-update reload khi có draft chưa gửi (useHoldReload pattern).
**Khó**: nhỏ-vừa. Độc lập, làm được ngay.

## Phần 5 — Push & self-update PWA
**Việc cần làm**:
1. Đối chiếu push-decision.ts với VAPID hiện có (khi nào đẩy: settle/died/needs-you; snooze toàn cục + notify prefs theo loại — port 2 endpoint ấy thành ops).
2. Self-update không-SW qua server-build header (mỗi response mang build id; khác → banner "tap to update" — áp cho gate serve PWA tĩnh).
3. sw.js: preload shell + reload-guard.
**Khó**: vừa.

## Phần 6 — Review diff (từ herdr-reviewr)
**Hiện trạng**: `diff.get` theo ref (git show) hiển thị text trong PWA.
**Việc cần làm**:
1. Syntax-highlight + walk hunk/file (f/F, ]/[ — keyboard PWA), scope uncommitted vs branch.
2. Comment theo dòng → gom notes → gửi lại cho agent Pi (op mới `diff.comment` → thành prompt con đường task.mjs; tích hợp `review` skill).
3. Worktree-safe: chỉ đọc qua gitRead hiện có.
**Khó**: vừa. Giá trị cao cho vòng review agent.

## Phần 7 — File viewer + deep-link (từ herdr-file-viewer)
**Việc cần làm**:
1. Op `file.view` (path whitelist trong repo dir, qua gitRead hardening sẵn có) + fuzzy search file name (port fuzzy.rs thuật toán — đọc trước khi port).
2. Deep-link `#file=path:line` từ receipt (stack trace / diff) → mở viewer đúng dòng.
3. Cột cây thư mục + content (đơn giản hóa 2 cột TUI → 1 cột mobile + breadcrumb).
**Khó**: vừa.

## Phần 8 — Mirror plugin (từ herdr-mirror) — SIDEBAR HERDR TUI
**Ý nghĩa ngược**: herdr-mirror = herdr local hiện workspace của herdr remote. Với herdgate: một plugin herdr (trên laptop/TUI bất kỳ) tự nói chuyện gate → sidebar "home: bom-Inspiron" hiển thị agents ở nhà, đọc pane, thậm chí split remote.
**Việc cần làm**: plugin riêng `plugin/mirror/*` (không đụng plugin chính): ws client gate (device read), panel render theo mod Files (herdr-app defaults), actions remote (tab/split qua act). **Khó**: lớn — để sau, nhưng là tính năng "wow" đúng dòng máu herdr.
**Bước nhỏ trước**: trong Herdr TUI của máy này, panel fleet (đã có pane herdgate status) nâng cấp thành list agents + số lượng cần-chú-ý từ snapshot publisher đẩy.

## Phần 9 — herdi (native/Telegram) + orchestrator web
- Telegram bot (herdr-remote): digest hằng ngày (reuse usage.rollup!) + one-tap approve (deep link vào PWA act-pair) — kênh thứ 4 không cần app mới. **Khó**: vừa (bot + webhook).
- herdi-mac MenuBarPanel / herdi-ios: học pattern RelayConnection + Updater — LATER (không build native lúc này).
- orchestrator/web (htmx của user): đọc kỹ src + so sánh — NEXT trong tracker.

---

## Thứ tự đề xuất (theo giá trị/độ khó)
1. **Wave UI-1**: Phần 4 (app-chrome — nhỏ, độc lập) + Phần 1 (freeze/load-older/find) → PWA đọc như native.
2. **Wave UI-2**: Phần 3 act surface (composer/keys, an toàn) + Phần 2 grammar Pi (choice) → PWA điều khiển được.
3. **Wave UI-3**: Phần 6 review + Phần 7 file viewer → vòng việc agent khép kín trên phone.
4. **Wave UI-4**: Phần 5 push/update + Phần 9 Telegram digest.
5. **Wave UI-5**: Phần 8 mirror plugin (lớn, để riêng).

Mỗi wave: port kèm test (fixtures transcript thật), giữ journal/receipt trung thực như mọi experiment trước.
