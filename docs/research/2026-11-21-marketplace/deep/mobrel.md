# Deep-dive 0cv/herdr-mobile-relay (tầng 2 — excavate)
Repo: 70.319 dòng Go prod + 97.362 dòng test, 68 package internal. Tầng 1 (r-mobrel.md) đã
cover setup-menu/transport/capability/inventory khái niệm — báo cáo này đào phần lõi chưa đọc:
scheduler, state machine revision, failure taxonomy, E2EE handshake, hub broadcast, cách test.
License AGPL: chỉ học thiết kế, không copy code.

## Kiến trúc đầy đủ (module graph)

```
phone (Svelte PWA, web/) ──WS/WSG/WebRTC──▶ transport.Hub (ws.go)
                                             │ E2EE handshake (e2ee.go) qua deviceauth.Store
                                             │ orderedIngress (cap 128) + handlerSlots
                                             ▼
                                     app.Server.handleMessage (message_handler.go)
                                       ├─ protocol.ScopeFor → ActionMetadata(class/coordinated/audited)
                                       ├─ authorizeDeviceAction (reader/controller)
                                       ├─ validateExactPaneTarget (TargetRef so generation)
                                       └─ nhánh: coordinator.Dispatcher.Handle (thao tác pane)
                                            │  poller.Poller ── backend.Backend ── herdr socket API
                                            │                └─ hc (herdr-core) hoặc herdr CLI
                                            ├─ app: pane_watch, conversation, upload, push, speech…
                                            └─ workspace/worktree → coordinator.Lifecycle
transport.Hub ──BroadcastBatchPrepared──▶ app.inventory_view (diff) ──▶ push_config/agents
gateway: transport.GatewayClient ◀── gatewaywire (HTTP healthz) + cmd/herdr-gateway (VPS blind relay)
```
LOC theo vai trò (prod/test): coordinator 6.8k/10k (state+scheduler+dispatch+lifecycle+approval);
app 7k/13.6k (wiring god-package); herdr 3.1k/3.9k (socket client); transport 2.8k/4.5k; question
3.6k/3.1k (ANSI-scrape 8 agent CLI); conversation 13.9k (!); slashcmd 4.4k; push 2.1k; gateway 2.1k;
panesize 1.4k; upload 1.3k; appdeploy 1.3k; update 1.25k; portmap 1.5k; webrtclink 1k; còn lại
<800/module (atomicfile, seqmatch, noecho, framing…). Dòng chảy dữ liệu 1 chiều:
herdr socket → poller/events → State (revisions) → inventory_view diff → Hub broadcast (barrier) → phone.

## Máy trạng thái & luồng chi tiết

### 1. Scheduler = 1 goroutine event-loop, mọi state dùng chung không lock (coordinator.go:403)
`serve()` ưu tiên theo thứ tự cứng: topology → batch 8 completion được bảo vệ → select
{ingress, completion, ledger, replay, topology, timer, cancel, stop}. Per-pane `PaneSlot` có
`Generation`; `deadlineHeap` (container/heap) quét hết hạn. Capacity mặc định 8.
```go
// coordinator/coordinator.go:403 (serve, rút gọn)
for {
    if l.stopCompleted() { return }
    select { case update := <-s.topology: l.applyTopology(update); continue; default: }
    for drained := 0; drained < protectedCompletionBatch; drained++ {
        select { case event := <-s.completions: l.complete(event)
        default: drained = protectedCompletionBatch }
    }
    select {
    case op := <-s.ingress:  l.admit(op)
    case event := <-s.completions: l.complete(event)
    ...
```

### 2. Idempotency ledger + replay (coordinator.go:753 admit, :312 ReplayLedger)
Key = `"stop\x00"+paneID+"\x00"+requestID` (dispatch.go:484) hoặc `approval\x00pane\x00eventID`.
`payloadHash` khác key trùng → `ErrConflict` ("A different response was already submitted").
Op đang in-flight → waiter mới gắn vào waiters cũ, nhận cùng result + cờ `replayed`. Result
`phase=="not_started"` thì XÓA ledger entry (retry sạch); result thật thì giữ 24h/256 entry.

### 3. Generation fencing chống "pane chết, pane khác tái dùng cùng ID" (state.go:316)
Mỗi pane có `generation int64`, tăng khi: session đổi, pane biến mất rồi xuất hiện lại, stop/clear.
`matchesTarget` so nguyên `TargetRef` gồm generation — lệnh tới pane cũ bị từ chối trước khi chạm
herdr. Scheduler tự `invalidateSlot` khi topology push generation mới: cancel in-flight, replyStale
hàng đợi. Quan trọng nhất là phân biệt 2 phase lỗi (coordinator.go:884):
```go
// coordinator/coordinator.go:884
phase := "failed"
publicError := ErrPaneReplaced.Error()
if op.dispatched {
    phase = "dispatched_unknown"
    publicError = "command was dispatched before the pane session was replaced; outcome is unknown"
}
```

### 4. Failure taxonomy 5 loại từ ngữ nghĩa "đã ghi bao nhiêu byte ra socket" (socket_api.go:86, failure.go:39)
`requestUnary` trả `wrote bool` = đã ghi >0 byte ra unix socket. Chưa ghi → `ErrNotStarted`
(retry safe); đã ghi mà lỗi → `ErrDispatchedUnknown`. Bậc thang classifyFailure: PartiallyApplied >
Refused > CreatedTargetUnknown > DispatchedUnknown > NotStarted. Multi-step (Qoder cần text rồi
Enter) bọc `partiallyApplied("prompt text was already delivered", err)` (dispatch.go:840) khi
step 1 đã tới agent. Phase public: not_started / dispatched_unknown / failed / completed_with_warning.
```go
// internal/herdr/socket_api.go:157 (requestResult)
raw, wrote, err := c.requestUnary(ctx, method, params)
if err != nil {
    var cliErr *CLIError
    if errors.As(err, &cliErr) { return err }
    if wrote { return errors.Join(ErrDispatchedUnknown, err) }
    return errors.Join(ErrNotStarted, err)
}
```

### 5. Pre-flight dispatch check chèn vào context (message_handler.go:74, dispatch.go:798)
Trước khi ghi socket, client gọi `CheckDispatch(ctx)` chạy closure kiểm: conn còn sống, device
còn quyền, target còn current. `herdr.WithDispatchCheck` đóng gói việc này chứ không copy logic.

### 6. Optimistic-concurrency poll: PollToken (state.go:485, poller.go)
Poll bắt đầu bằng `BeginPoll()` → {BaseRevision, TopologyGeneration}. Nếu topology đổi giữa
chừng → `CommitPoll` từ chối, poller retry ngay (tối đa 3 lần rồi `MarkTopologyDegraded`).
Event UDP đến trước khi pane tồn tại → `pendingEvents` (max 128, TTL 30s) áp khi pane xuất hiện.
Event > poll: `preserveRaw` giữ status từ event nếu `rec.rawRevision > baseRev`.

### 7. Completion state ảo cho UI (state.go:867 registerTransition, DisplayedStatus)
`completionState{unseenDone, ackDone, finishedNotif, completionRev}`: working/blocked → idle
đánh dấu unseen-done; người dùng acknowledge → hiển thị lại "idle". Chat-attention không sinh
finished-notification. Notification gửi đúng 1 lần nhờ `finishedNotif` + `RegisterFinishedNotificationForTransition`.

### 8. Blocked-event lifecycle (state.go:718)
Vào blocked: sinh `BlockedEventID` (12 byte random) một lần/chu kỳ; mọi câu trả lời approval
phải mang eventID + `ApprovalFingerprint` (sha256 của prompt/command/options sau khi strip
focus-marker/indent — question/attention.go:48). `attentionRev`/`contentRev` tăng riêng để
listener biết cái gì đổi. Trả lời approval khi pane đã rời blocked → hỏi ledger replay trước
(dispatch approval.go:62) — idempotent cả khi state đã chuyển.

### 9. E2EE handshake (e2ee.go:202): client gửi hello kèm HMAC-proof của secret (chưa ECDH);
server verify xong mới ECDH P-256 → HKDF-SHA256 2 directional keys ("c2s"/"s2c") → AES-GCM,
nonce = sequence cố định 8 byte, AAD = "herdr-e2ee-v2 "+direction+seq. Sequence cap 2^53-1
(JavaScript-safe). Invitation hoàn tất → server_finish (đã mã hoá) phát credential_secret mới.
Lỗi proof → `CompleteE2EEAuth(ctx, selector, false)` vẫn được gọi — để rate-limit invitation.

### 10. Chunk framing cho mọi transport (framing.go): `[u8 v1][u8 flags][payload]`, START kèm
`u32be logical_len`; sai thứ tự = protocol violation đóng kết nối; stall 30s thì bỏ; cap 21MiB
cho mọi transport để "no transport can buy more memory than another" (framing.go:26).

### 11. Hub: ordered ingress + admission barrier (ws.go:304, :321, :405)
Ingress đầy → trả ngay `phase:"not_started", "Relay is busy"` (không block). Handler chạy trên
goroutine có slot, nhưng `runOrderedIngress` CHỜ callback `admitted` trước khi nhận message kế
— bảo toàn thứ tự submit mà không giữ queue toàn cục cho tác vụ chậm. Broadcast:
```go
// internal/transport/ws.go:405
// BroadcastPrepared applies a logical state update under the same registration
// barrier used by onConnect, then snapshots recipients. A client therefore
// observes the update either in its handshake snapshot or as a live delta,
// never both and never neither.
```

### 12. Gateway selection (gateway_selection.go:86): probe đồng thời mọi candidate /healthz
(HTTP RTT đủ, không ICMP), mode ordered = "explicitly listed gateway is a priority, not a
suggestion", mode latency có tie-window rồi prefer index nhỏ hơn; entry active mà WS-registration
vừa fail bị exclude 1 pass. `activeFirstLocked()` đặt gateway hiện tại đầu descriptor để phone
resume không tốn 1 lần fail.

### 13. Dual freshness source (poller.go:291): event stream khoẻ → poll ngủ ở 15s; stream chết →
poll chạy interval cấu hình + backoff nhân đôi cap 60s (`pollRetryInterval`, poller.go:425);
`eventsActive` là atomic riêng không bị retry-poll reset.

## Cơ chế áp vào herdgate

1. **[CAO] Failure phase taxonomy cho receipts** — áp `src/agent/adapter.ts` (nơi gửi lệnh sang
   herdr/Pi) + receipts writer. Bài học: byte-đã-ghi ra socket là ranh giới not_started ↔
   dispatched_unknown; partial multi-step phải có marker riêng. Riêng 3 phase
   `not_started|dispatched_unknown|failed` + trường `replayed` đã đáng giá cho suite 213.
   Excerpt: socket_api.go:157 (mục 4 ở trên). Vì sao: herdgate receipts đang không phân biệt
   "chưa gửi" và "đã gửi mà không biết kết quả" — người dùng retry sai.
2. **[CAO] Idempotency ledger + payloadHash conflict** — áp `src/agent/adapter.ts` cho mọi mutating
   op (spawn, gate config). Key `action\x00target\x00requestID`, hash payload phát hiện "cùng
   request-id nhưng nội dung khác". Entry not_started bị xoá để retry sạch. Excerpt:
   ```go
   // coordinator/coordinator.go:753 (admit, rút gọn)
   if existing, ok := l.ledger[key]; ok {
       if existing.payloadHash != op.options.PayloadHash {
           s.reply(op, nil, ErrConflict); return
       }
       if existing.result != nil { s.replyReplayed(op, cloneResult(existing.result), nil); return }
       existing.operation.waiters = append(existing.operation.waiters, op.waiters...)
       return
   }
   ```
   Vì sao: PWA phone-mạng-yếu sẽ gửi trùng; publisher cần trả đúng 1 kết quả.
3. **[CAO] Ingress admission barrier** — áp `src/cloud/gateway.ts`: WS command queue đầy thì
   trả ngay not_started, không block; handler báo `admitted()` ngay khi vào scheduler để ingress
   đọc message kế. Excerpt ws.go:321 (mục 11). Vì sao: 1 client chậm không được làm nghẽn toàn
   bộ command path của gate.
4. **[CAO] PollToken optimistic concurrency cho inventory** — áp publisher observe Pi sessions:
   chụp {baseRevision, topologyGeneration} trước poll, commit bị từ chối nếu topology đổi giữa
   chừng, retry ngay tối đa 3 lần rồi mới báo degraded. Excerpt state.go:485:
   ```go
   // coordinator/state.go:485
   func (s *State) CommitPoll(agents []*AgentState, workspaces []herdr.Workspace, token PollToken) (workspaceChanged, committed bool) {
       s.mu.Lock()
       if s.topologyGen != token.TopologyGeneration {
           s.topologyRetries++; s.mu.Unlock(); return false, false
       }
   ```
   Vì sao: herdgate poll agent status sẽ gặp cùng race poll-vs-event; đây là lời giải
   được 10 test poller riêng kiểm chứng.
5. **[TRUNG] Generation fencing cho pane/agent target** — áp protocol target của herdgate
   (src/protocol/agent.ts): mọi lệnh mang generation; pane chết-tái-sinh bị tăng generation
   bằng đường riêng (BumpGeneration khi stop; tự tăng khi pane biến mất rồi quay lại — state.go
   comment "Reappearance must establish another epoch"). Vì sao: tránh gửi prompt vào pane thế thân.
6. **[TRUNG] Bounded ApiError** — protocol.go:324: code ≤64 ký tự, args sort key, ≤8 args, mỗi
   string ≤256, tổng JSON ≤1024, int phải fit 2^53 (JS-safe). Áp vào receipts/JSONL của
   publisher: log lỗi luôn bounded, máy đọc được, không truncate nửa UTF-8 (loop `utf8.ValidString`).
7. **[TRUNG] Dual-source freshness + backoff cap** — áp src/web store: khi event-push khoẻ thì
   poll chậm (15s); khi event chết thì poll nhanh + backoff nhân đôi cap 60s, đếm failures riêng
   cho từng nguồn. Vì sao: công thức đã có test poller_backoff_test.go riêng.
8. **[TRUNG] Approval/request fingerprint** — khi herdgate thêm confirm flow: fingerprint =
   hash(prompt+command+options) sau khi normalise focus-marker; trả lời mang fingerprint, server
   so lại trước khi gửi key — chống trả lời dialog cũ còn treo. Excerpt attention.go:48.
9. **[THẤP] Gateway candidate probing ordered|latency + tie-window** — cho gate VPS backup:
   probe đồng thời, ordered = độ ưu tiên không theo latency, log "position/healthy/rtt" để trả
   lời "why not my first gateway" chỉ từ log. Áp src/cloud/gateway.ts khi có >1 VPS.
10. **[THẤP] Scheduler stress-test with peak-concurrency assertion** — xem phần test.

## Cách họ test (bài học cho suite 213)

- **Golden fixture 2 chiều có -update và check exact-set** (question/golden_test.go:145): đọc
  toàn bộ `testdata/attention/*.ansi`, sinh output, so từng file VÀ so danh sách file trên đĩa
  bằng nhau — fixture thừa/thiếu đều fail. Một input chạy 4 biến thể (agent gốc, hermes, agy,
  CRLF). Học: golden cho parser ANSI/output formatter của herdgate, kèm rule "run with -update
  only for an intended behaviour change".
- **Fuzz seed từ contract vector** (transport/e2ee_fuzz_test.go:11): repo có `contracts/fixtures/`
  (e2ee/v2.json, pi_command_catalog.json…) làm test vector chung cho Go + frontend + mobile;
  fuzz corpus seed bằng vector hợp lệ + các case méo có chủ đích. Học: contracts/ dir dùng chung
  cho viestest + playwright.
- **Blackbox build thật binary trong TestMain** (tests/blackbox/testmain_test.go:34): build
  fake-herdr + relay + gateway 1 lần, mỗi test spawn relay thật với env + `scenario.json` +
  `operations.jsonl` (fake herdr ghi mọi thao tác nhận được → assert side-effect theo thứ tự).
  Học: fake Pi/herdr có operations-log JSONL là công cụ đo đạc chính xác hơn snapshot state.
- **Stress test có assertion định lượng** (coordinator/scheduler_stress_test.go:18): 80 goroutine
  burst, assert peak concurrency == capacity (4), metrics Completed == total, HerdrInUse == 0;
  test thứ tự receipt của 10 client trên 1 pane phải ra effect đúng thứ tự admission (line 83).
  Học: test concurrency bằng peak-metric, không chỉ "không deadlock".
- **CI tách job** (.github/workflows/check.yml): `go test -p 1` (serialize package vì lifecycle
  subprocess test ăn nhau), race detector là job riêng "more than doubles the Go suite",
  journal opt-in qua env `HERDR_TEST_JOURNAL=1`, `make shell-check production-path-audit` riêng.
  Học cho herdgate: vitest pool forks đã có — thêm 1 job "production-path-audit" kiểu này.
- **Idempotency + generation + continuation có file test riêng** (idempotency_test.go 13 test,
  generation_test.go, continuation_test.go, dispatch_safety_test.go 15 test) — mỗi cơ chế 1 file
  test, không trộn.

## Anti-pattern / không lấy gì

- **God package**: internal/app 7k dòng ghép 30 mối quan tâm (speech, upload, QR, hybrid, push);
  internal/conversation 14k dòng. Herdgate giữ module nhỏ theo vai trò như hiện tại.
- **ANSI screen-scraping 8 agent CLI** (question/ 3.6k + copyresponse + 100+ fixture .ansi):
  đây là chi phí bắt buộc của relay đa-agent; herdgate chỉ chạy Pi nên KHÔNG cần lớp
  này — đừng mang regex `╭─allow tool` về.
- **build artifact commit thẳng repo** (web/assets/*.js.br, web/builds/0.26.1-…/) — làm repo
  phình và diff ồn; herdgate đã đúng khi build ra dist/.
- **Comment tham chiếu spec không tồn tại trong repo** ("§10.3", "§16.13", "§9.8" trong state.go)
  — spec ở đâu đó ngoài repo; herdgate dùng specs/ nội bộ thì phải link file thật.
- **Go-only**: toàn bộ logic server là Go — pattern scheduler/ledger dịch sang TS phải cẩn thận
  event-loop (một async actor), không port máy móc goroutine + channel.
- Cùng lý do tầng 1: AGPL (không copy chunk), bash common.sh 2041 dòng, community gateway,
  WebRTC/STUN, mobile CI apparatus (tests/mobile ~ 60 file TS cho Android/iOS emulator) —
  ngoài phạm vi herdgate.

## File đã đọc (tầng 2; tier-1 đã đọc 12 file liệt kê trong r-mobrel.md)

Đọc trọn (100%):
1. internal/protocol/protocol.go (510) — catalog, ApiError bound, DecodeFrame.
2. internal/framing/framing.go (207) — chunk format, Reassembler, stall.
3. internal/transport/e2ee.go (504) — handshake, seal/open, auth binding.
4. internal/transport/gateway_selection.go (221) — probing, tie-window.
5. internal/coordinator/state.go (1271) — State, revisions, commit*, completion.
6. internal/coordinator/coordinator.go (1008) — Scheduler, ledger, serve loop.
7. internal/coordinator/dispatch.go (930) — Dispatcher, schedule, continuation.
8. internal/coordinator/failure.go (73) — classifyFailure, phase().
9. internal/coordinator/poller.go (434) — Run/RunEvents, backoff, hydrate.
10. internal/herdr/socket_api.go (244) — requestUnary/requestResult, wrote semantics.
11. internal/app/message_handler.go (266) — gate pipeline + switch 60 action.
12. tests/blackbox/testmain_test.go (66) — binary build pattern.
13. internal/question/golden_test.go (196) — golden 2 chiều.
14. internal/transport/e2ee_fuzz_test.go (91) — fuzz từ contract vector.
Đọc phần chính:
15. internal/coordinator/approval.go (1–95) — fingerprint + ledger replay path.
16. internal/question/attention.go (1–120) — Classify, fingerprint normalize.
17. internal/transport/ws.go (300–440 + bảng symbol 43–690) — hub ingress/broadcast.
18. internal/app/server.go (150–260) — wiring New(): state/hub/poller/profiles.
19. tests/blackbox/relay_test.go (1–120) — TestEnv, fake socket, scenario.
20. internal/coordinator/scheduler_stress_test.go (1–130) — burst + order test.
21. internal/protocol/outbound_fixtures_test.go (1–80) — fixture-vs-Go-type exact.
22. docs/security.md (1–70), docs/pane-size-leasing.md (1–60), .github/workflows/check.yml (1–80).
23. Inventory: cây file đầy đủ + LOC 68 package (find/wc), thư mục contracts/fixtures (6 vector).
