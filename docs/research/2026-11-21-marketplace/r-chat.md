# HerdrChat (cobanov/herdrchat) — nghiên cứu sâu, áp vào herdgate

Nguồn: Expo/RN app (iOS 17+, Android thử nghiệm), license **Apache-2.0** (NOTICE yêu cầu attribution nếu copy code; mượn ý tưởng/pattern thì không). Không relay, không account: phone SSH **trực tiếp** vào máy chạy herdr (thường qua Tailscale).

## Kiến trúc cốt lõi (file-level)

- `modules/herdr-ssh/` — native SSH transport tự viết (iOS: Citadel/SwiftNIO, Android: sshj). 1 connection/host lazy-reuse, TOFU host-key pinning, **line-framed streaming** (chỉ emit dòng hoàn chỉnh), native trả tagged result `{ok, code, message}` chứ không throw — policy sống ở TS. Keychain giữ credentials, không ghi secret xuống disk.
- `src/lib/herdr/protocol.ts` — envelope newline-JSON `{id, result|error}` dùng chung cho socket + CLI stdout. `HerdrError {code, transport, presentedFingerprint}`: union type ~60 code gồm server + app + ssh; `decodeEnvelope`, `exitCodeError` (exit 127 → `herdr_not_found`), `humanise()` đổi lời terminal thành lời phone.
- `src/lib/herdr/client.ts` (60KB) — `HerdrClient`: `pollSnapshot`, `sendPrompt`, `sendCommand`, `sendKeys`, `interrupt(+Hard)`, `startAgent/startNamedAgent`, workspace/worktree/tab/pane lifecycle, `locateHerdr`, cài/cập nhật herdr + integration từ phone.
- `src/lib/herdr/socket.ts` (34KB) — `HerdrSocket`: socket Unix của herdr không mở được từ phone nên bridge qua: `python3` one-liner > `herdr api-bridge` (fork) > `herdr remote-api-bridge` (0.9.1+); probe 1 lần/client, fallback CLI. Single-shot request/connection, riêng `events.subscribe` giữ stream.
- `src/lib/herdr/events.ts` — `EventFeed`: 1 subscription per consumer, reconnect khi tập pane đổi, poll chậm chỉ là safety net.
- `src/lib/transcript/{parser,message,codex,omp,acp,agy,harness}.ts` — mỗi agent 1 reader: 1 dòng JSONL → `TranscriptEntry {message, meta}`; meta (model/context) lấy ngay trong lần parse tail, không re-read.
- `src/lib/threadItems.ts` — `threadItems(messages)` → `ThreadItem`: user/agent/note/tools-run/**subagent card**/**workflow card**/**shell block**.
- `src/lib/subagents/{paths,reader,meta,taskNotice,workflowRun}.ts` — quy ước thư mục subagent/workflow của Claude Code + `SubagentReader` đọc qua SSH.
- `src/lib/transcript/blockedPrompt.ts` (36KB) — parse **màn hình pane** (ANSI, `herdr pane read --source visible`) thành prompt + options để trả lời approval từ phone.
- `docs/adding-an-agent.md` — bảng 11 bước thêm agent mới, mỗi bước kèm test pin.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Prompt delivery 3 trạng thái, host quan sát thay vì đoán** — `client.ts sendPrompt()` trả `delivered|stalled|unverified`; CLI path: `herdr agent prompt <pane> <text> --wait --timeout` (herdr tự xem agent đổi trạng thái, `agent_prompt_stalled` là ANSWER); socket path: `wait.until: ['working','blocked']` (agent dừng hỏi permission = đã đọc prompt). Probe `--help` 1 lần/host thay vì try-then-fallback vì verb "nửa landed" + retry = prompt đôi (#76, #83).
2. **Error envelope phân biệt transport vs server** — `protocol.ts HerdrError.transport`: timeout của herdr ("đã xem, không gì chạy") ≠ timeout của SSH ("không ai biết prompt có tới không") — retry cái sau là gửi 2 lần (#83). `exitCodeError`: herdr in envelope JSON lên stderr khi exit≠0 → decode trước khi fallback exit code; exit 127 → thông điệp "herdr chưa cài" có 1-tap recovery.
3. **Đọc file chỉ-khi-đổi bằng checksum** — `subagents/paths.ts readChangedCommand`: in 1 dòng `cksum` rồi chỉ `cat` khi khác `signature` (POSIX cksum, không stat); `delegationLinesCommand`: `grep -F -e id1 -e id2 file | cksum` rồi in matching-lines nếu đổi → chỉ vài dòng về agent này qua SSH. Exit 44 = `ABSENT_EXIT` (file chưa có = "starting", không phải lỗi).
4. **Không bao giờ đoán file transcript** — `resolveAgentCommand`: tìm subagent theo `toolUseId` grep trong `agent-*.meta.json` (2 agent spawn cách nhau <1ms; "file mới nhất" = preview sai người); `isInertId`/`^[A-Za-z0-9_-]{1,128}$` chống traversal — refuse chứ không quote. Dùng `find` thay glob vì zsh abort khi glob rỗng.
5. **Tool-run folding + identity 2 khóa** — `threadItems.ts`: chuỗi tool_use/tool_result gập thành 1 dòng "Ran 13 commands · 3 failed" (wording zeron, MIT); run kết thúc ở prose/image/user/note. `key` = call CUỐI (identity của list khi prepend history), `runKey` = call ĐẦU (ổn định khi run sống, giữ open/closed). Subagent/workflow luôn là **card riêng**, không đếm vào "N failed" của run.
6. **Delegation model đúng thực tế** — `Delegation {state, background, agentId, result, startedAt, endedAt, durationMs, tokens}`: agent background nhận result tức thì (chỉ nói "đã launch"), kết thúc thật đến qua `<task-notification>` (taskNotice) hoặc handback theo agentId; agent resume thì notification sau tên `SendMessage` nhưng taskId vẫn của agent → `noticesByTask`. Workflow: run file chỉ ghi khi xong → khi chạy chỉ có `journal.jsonl` (`workflowJournalPath`).
7. **Approval từ phone = parse màn hình** — `blockedPrompt.ts parseBlockedPrompt(paneVisible)`: options `{number, label, checked?, keys?}` (menu không số → arrows+Enter), `PromptDetails {title, summary, body[], notes[], deadline}` — deadline đọc **mỗi lần poll** từ screen, không đếm ngược local (đồng hồ phone ≠ agent). `dismissOnly` cho popup nguy hiểm (Enter/digit sẽ chọn file!). Trả lời = `sendKeys(pane, ['1'])` kiểu digit.
8. **Shell block pairing** — Claude ghi `! cmd` và output thành 2 user-turn liền nhau; `threadItems` ghép output với turn ngay trước **cùng agentLabel** (workspace thread trộn 2 agent); có dòng khác xen giữa = interrupt → `recorded:false`, không hiện "No output" sai.
9. **EventFeed thay poll** — 1 `events.subscribe` per mounted consumer, superseded stream cancel ngay; pane-set đổi → reconnect (subscription không amend được); poll chậm làm safety net. Bridge im lặng N lần liên tiếp → tạm exec CLI (`silentBridges`/`execUntil`).
10. **Chi tiết port chính xác** — `parser.ts projectDirName`: port nguyên hàm escape path của Claude Code gồm UTF-16 units (emoji = 2 hyphen) và >200 ký tự thì cắt + `claudeHash` (Java hashCode 32-bit) — approximation sai = thread chờ file không tồn tại (#89). Offset file tính theo **UTF-8 bytes**, không phải `String.length`.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên)

**Cao:**
- [ ] Gate/publisher send-path: thay xác nhận gửi kiểu blind bằng 3-trạng thái `delivered|stalled|unverified` + cờ transport-vs-app trong receipts `spawn:<id>` (làm cho wake-on-settle và retry an toàn — bài học #83). Đích: op send/spawn trong gate, schema receipts.
- [ ] Checksum-stamped reads cho mọi poll SSH/HTTP file JSONL (receipts, Pi session tail): `readChangedCommand` pattern (cksum + conditional cat, ABSENT_EXIT riêng) — tiết kiệm bandwidth mobile TUI/PWA rõ rệt. Đích: publisher poll loop + mobile TUI fetch.
- [ ] Timeline/PWA vẽ session Pi như chat: dùng đúng mô hình `ThreadItem` + tool-run folding + subagent card; map `spawn:<id>` receipts → `Delegation` (background, kết thúc qua settle event ≈ task-notification), `noticesByTask` cho task resume. Đích: module render timeline/PWA.
- [ ] Error taxonomy union-type + `humanise()` cho PWA/mobile: code là fact, câu chữ là decision, viết 1 chỗ có test pin. Đích: lib lỗi dùng chung gate/publisher.
- [ ] Chuyển wake-on-settle sang herdr pane events theo pattern `EventFeed`: 1 subscription per consumer, reconnect khi pane-set đổi, poll chậm safety net, bridge-silent → fallback. Đích: op subscribe của publisher.

**Thấp:**
- [ ] Line-framed streaming (chỉ dòng hoàn chỉnh) cho tail JSONL qua SSH — mobile TUI SSH đang có thể áp luôn.
- [ ] Probe verb 1 lần/host (`--help`) thay try-and-fallback cho mọi lệnh có tác dụng phụ.
- [ ] `projectDirName` + byte-offset nếu herdgate đọc Claude sessions trực tiếp.
- [ ] Slash-command catalogue refresh 10-phút + cache local cho Cmd+K PWA (`slashCommands/discover.ts`).
- [ ] Usage footer / statusline wrap (`usage/statusLineWrap.ts`) cho PWA Usage.

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- **Native iOS/Android modules** (Citadel, SwiftTerm, expo modules): herdgate là PWA/Node — chỉ lấy ý tưởng (TOFU pin, line-framing, tagged-result), không code.
- **Screen-scraping ANSI để approval** là last-resort vì herdr chỉ cho đọc pane visible; herdgate có receipts JSONL + structured events → luôn ưu tiên nguồn có cấu trúc, chỉ scrape khi không còn đường nào.
- **Polling CLI + --help probe mỗi thao tác**: chính họ đã thay bằng socket bridge; nếu herdgate làm thì đi thẳng events/structured từ đầu.
- **"Newest file in folder"** cho session lookup — họ nêu đích danh là bug; herdgate spawn registry one-id đã đúng hướng, giữ nguyên.
- **License**: Apache-2.0 — được dùng/mượn code nếu giữ NOTICE/attribution; wording tool-summary từ zeron (MIT) cần credit nếu copy nguyên câu.
- App Store subscription (`subscription_ended` code), push APNs watcher python — dư thừa với mô hình self-host relay của herdgate.

## File đã đọc (raw.githubusercontent.com, branch HEAD @ f7e00c6)

1. `README.md` — tính năng, kiến trúc tổng quan, SSH/Tailscale.
2. `src/lib/herdr/protocol.ts` (toàn bộ) — `HerdrError`, `decodeEnvelope`, `exitCodeError`, `humanise`, `transportError`.
3. `src/lib/herdr/client.ts` — exports + `sendMessage/sendPrompt/sendCommand` (dòng 624–760) + danh sách verb.
4. `src/lib/herdr/socket.ts` (1–60) — bridge python3/api-bridge/remote-api-bridge, vì sao bỏ `nc -U`.
5. `src/lib/herdr/events.ts` (1–90) — `EventFeed.watch/stop/restart`, subscription pane-set.
6. `src/lib/threadItems.ts` (1–340) — `ThreadItem`, `threadItems()`, `ShellItem`, `Delegation`, `toolRunSummary`.
7. `src/lib/transcript/parser.ts` (1–240) — `parseTranscriptEntry`, `projectDirName`, `claudeHash`, preview caps.
8. `src/lib/transcript/blockedPrompt.ts` (1–80 + exports) — `BlockedOption`, `PromptDetails`, `parseBlockedPrompt`.
9. `src/lib/subagents/paths.ts` (toàn bộ) — layout thư mục, `resolveAgentCommand`, `readChangedCommand`, `delegationLinesCommand`, `isInertId`.
10. `src/lib/subagents/reader.ts` (toàn bộ) — `SubagentReader.resolve/readIfChanged/linesNaming`, cache per-transport.
11. `modules/herdr-ssh/README.md` (toàn bộ) — thiết kế transport, tagged result, TOFU, line-framing.
12. `docs/adding-an-agent.md` (toàn bộ) — bảng 11 bước + quy tắc fixture.
13. `CLAUDE.md` (đầu), `LICENSE`, `NOTICE`, git tree API (782 blobs).
