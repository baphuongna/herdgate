# Nghiên cứu sâu: junghan0611/entwurf — áp dụng vào herdgate

Repo: TypeScript (pnpm monorepo), 834 file, MIT license, branch `main`.
Miêu tả: nối các harness agent độc lập thành "siblings" nhìn thấy được (Herdr/tmux), đánh địa chỉ bằng **garden id** trỏ vào record; retire chỉ khi operator yêu cầu rõ ràng.

## Kiến trúc cốt lõi (file-level)

- `pi-extensions/lib/meta-session.ts` (173KB) — **record authority duy nhất**. `MetaIdentity` V3: `gardenId` (SSOT `generateSessionId`, mint đúng lúc birth, tái dùng không re-derive), `backend` (pi/claude-code/codex/copilot/omp/antigravity/pi-durable/openclaw), `nativeSessionId` (unique store-wide), `cwd`, `model`, `transcriptPath`, `attachIncarnation`, `renewing?/chapters?/outline?`. Store = các file JSON trong `<pi-agent-dir>/meta-sessions/`, **lookup bằng scan record bodies**, không DB/index. Capability registry (`wakeMode: self-fetch|direct-inject`, `deliveryLevel`) re-read mỗi lần load, không cache.
- 4 thư mục sibling cùng root: `meta-sessions/` (record), `meta-mailbox/<gid>/inbox.signal` (volatile queue), `meta-senders/` (marker keyed theo owner ppid — MCP process tìm được sender identity qua process ancestry), `meta-receivers/` (presence marker keyed theo gardenId, mang owner pid + start-key), `meta-record-arm-locks/` (lock ghi record).
- `pi-extensions/lib/entwurf-v2-decider.ts` — **pure dispatch decider** cho verb `entwurf_v2`. 7 bước đóng băng: requireGardenId → resolveTarget (probe-free) → backend → acquireLock (in-domain, trước lstat/connect — đóng TOCTOU) → inspect/probe socket → control-socket plan | meta-mailbox plan (lock-free) | native-push plan (lock-free). Output `DispatchDecision = reject{receipt, diagnostic?} | execute{receipt, ExecutionPlan, lock}`; mọi IO là **required dep không default**.
- `pi-extensions/lib/entwurf-v2-mailbox.ts` — enqueue-only: render body từ plan có sẵn, KHÔNG quyết routing, KHÔNG có releaseLock dep (rò rỉ lock bất khả thi về cấu trúc). Enqueue thành công trả `messagePath` verbatim; fail thì throw — mailbox không có "success:false" in-band.
- `pi-extensions/lib/control-retire.ts` — retire leaf: "Internal Pi lifecycle leaf, not an authorization boundary". `requestControlRetire` đồng bộ, check binding-generation (object identity của binding + gardenId + nativeSessionId khớp), refuse theo tên: `target-closing|target-stale|target-context-unavailable|target-non-tui|target-busy|target-pending`. Một attempt, không retry, không unlatch cùng generation; 1 response rồi FIN.
- `pi-extensions/lib/record-arm-lock.ts` — `withRecordArmLock`: ghi record là MỘT section đồng bộ (re-read→compare→rename, cấm promise), poll tối đa 2s (`Atomics.wait`); lỗi đặt tên: `RecordArmLockBusyError` (không ghi gì), `RecordArmLockReleaseError` (ghi rồi nhưng release fail — giữ `written`).
- `pi-extensions/lib/entwurf-facts.ts` — `PeerFact`: identity verbatim từ record + `liveness` 4-giá-trị + 3 trục **observation** (`receiver/transcript/placement`) — "facts, not verbs: chúng nói cái gì thấy trên disk, không nói caller được làm gì". `UNOBSERVED_PEER` greppable — không bao giờ im lặng default thành `none`.
- `pi-extensions/lib/entwurf-core.ts` — sync exec/routing fallback, KHÔNG import pi SDK (thuần Node); các v1 registry/spawn-guard đã xoá sạch, comment ghi lại lý do.
- Docs hệ thống: `DELIVERY.md` (74KB, matrix D0–D8 per-rail, control-socket acceptance, remote pairs), `AGENTS.md` (17 Hard Rules + ACP boundary). `protocol.js` = hằng số wire-format 1 file dependency-free cho 2 runtime path.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Record là authority địa chỉ duy nhất** (AGENTS.md Rule 2). Decider bước 2b: socket tồn tại nhưng không record → reject `record-less-socket`, không phải `bad-target` dối — "a diagnostic state named honestly". Socket/env/marker/model/transcript đều chỉ là carrier hoặc evidence. Từ khóa: `TargetResolution.recordLessSocket`, `isRecordLessSocketCandidate` (socket-discovery.ts).
2. **Liveness đọc tại dispatch-time, không lưu** (Rule 4 "Live-fact dispatch"). Probe lstat-then-connect chạy DƯỚI lock đã acquire (đóng TOCTOU); marker receiver chỉ tin khi owner pid còn sống VÀ start-key khớp; `attachIncarnation` (randomBytes(16)) mint trong cùng atomic upsert với attach, copy sang marker — bằng chứng "không có arm nào sau đó". Từ khóa: `inspectTargetControlSocket`, `mapInspectionToLiveness`, `attachIncarnation` (meta-session.ts:370-410).
3. **Receipt ≠ kết quả turn của sibling.** Open trả launch receipt; reopen tách launch khỏi observation; retire báo action/record/lock RIÊNG; mailbox enqueue trả đúng `messagePath` nó vừa ghi ("reported verbatim... never re-derived"); `wants_reply` là etiquette không phải chờ. `lastEnqueuedAt/lastDeliveredAt/lastReadAt` là 3 mốc tách bạch ("last 1 cm": body có tới model-visible context không).
4. **Retire 3 lớp tách bạch**: (a) operator nêu đích danh target+action — "no role, caller identity or tool annotation grants it", không timer/idle-heuristic; (b) decider refuse `renew-in-progress`...; (c) leaf `requestControlRetire` là check đồng bộ cuối với binding-generation snapshot tại lúc accept — listener có thể sống qua rebind cùng path, connection cũ giữ binding cũ, `state.binding !== serverBinding → target-stale`.
5. **Pure decider + DI toàn phần**: `DispatchDeciderDeps` mọi seam required (B1: default bị xoá vì từng leak lock ra `~/.pi` thật); plan "planted once" — executor tiêu thụ plan không re-derive path/arg ("재유도 금지"); `requireGardenId` chạy TRƯỚC khi build bất kỳ path nào (F2-P1: chặn internal caller bypass MCP schema).
6. **RejectDiagnostic đi kèm reject** (#101): `target-locked` mang `LockConflict` (holder pid/host/createdAt, lockPath) để quan sát/xoá PID-reuse lock; `mailbox-undeliverable` mang câu chữ của predicate phân biệt 3 tình huống (no record / owner chết / watch không còn armed).
7. **Facts là quan sát, pane không phải liveness** (Rule 16): "a pane can outlive its process and a process can outlive its pane" — `placement` nằm cạnh `receiver/transcript`, không nằm cạnh `liveness`. Screen text/keystroke không phải delivery evidence.
8. **Birth idempotent**: `decideUpsert` key theo record-existence (không phải source field); duplicate hook fires absorbed; `certifyActiveStore` quét chứng minh toàn store trước khi ghi (record+filename khớp, non-symlink, nativeSessionId unique); ghi atomic. Crash-don't-warn: malformed record throw `MetaRecordError`.
9. **wakeMode self-fetch vs direct-inject** — trung thực về cơ chế: Claude doorbell chỉ WAKE, body do model tự fetch (nên cần active-receiver check); codex/agy inject thẳng. Deliverability = wake-mode capability AND live active-receiver, fail-closed — "a terminated citizen's mailbox is refused, never enqueued as garbage" (SE-2).
10. **Sender identity qua process ancestry** (meta-senders): hook và MCP child cùng owner process → cùng `process.ppid`, không env var, không cwd inference.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên)

- [CAO] Spawn registry (task.mjs + pipeline worktree): mỗi agent một record JSON một-id kiểu `MetaIdentity` (`agentId, nativeSessionId(pi session id), cwd, model, transcriptPath, createdAt/recordUpdatedAt, attachIncarnation`) tách khỏi receipts JSONL; birth idempotent (upsert key theo record existence, ghi atomic) — trị duplicate `start`/revive. Ưu tiên copy đúng tinh thần schema, không cần V3 đầy đủ.
- [CAO] `task.mjs close` → 3 lớp retire: operator nêu đích danh (giữ nguyên nhận lệnh từ người), preflight refuse theo tên (`busy`, `pending`…), leaf check binding-generation (sessionId khớp record + pid sống) một attempt không retry — thay cho close "best effort". Receipts thêm `retire:<id>` báo action/record/lock riêng.
- [CAO] Deliver/poke (cmd qua relay, wake-on-settle): liveness đọc tại thời điểm dispatch (probe socket/pid + start-key) thay vì tin trạng thái cache; presence marker pid+start-key cho publisher Pi sessions; không bao giờ enqueue vào hộp thư của session đã chết.
- [CAO] Nguyên tắc "receipt không phải turn-result" cho relay receipts: `spawn:<id>` giữ; thêm `deliver:<id>` trả đúng path file đã ghi (verbatim), 3 mốc enqueued/delivered/read tách bạch để PWA Jobs/Timeline hiển thị trung thực.
- [TB] RejectDiagnostic cho mọi reject relay/CLI: kèm holder/conflict/reason machine-readable (PWA Cmd+K hiển thị nguyên nhân + cách xử).
- [TB] wake-on-settle → herdr pane events: coi pane event là **placement observation** (bằng chứng nơi nhìn thấy), KHÔNG phải liveness claim — giữ 2 trục riêng trong data model.
- [TB] Pure-decider pattern cho dispatch logic relay (route cmd → agent): DI seams, plan planted-once, test bằng fakes không cần FS thật.
- [TB] `record-less-socket` style: đặt tên reject trung thực theo trạng thái thật (không gộp thành "not found" khi thứ gì đó thật sự đang trả lời theo id đó).
- [THẤP] Sender identity qua ppid marker nếu relay cần biết "lệnh này từ agent nào" mà không truyền env qua SSH.

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- **Không copy code trực tiếp**: MIT cho phép nhưng code móc sâu vào pi SDK internals (pi-durable carrier, control socket của Pi TUI) và Herdr plugin runtime — herdgate relay self-host qua cloudflared có kiến trúc khác. Học schema/pattern, không vendoring.
- **Scan-store không index**: hợp lý cho vài chục citizen trên một máy; relay VPS herdgate nhiều machine + receipts JSONL append-only (hiện tại) tốt hơn cho audit và tra cứu nhanh — chỉ thêm record JSON, không thay JSONL bằng scan-store thuần.
- **ACP rail, native-push, /renew chapters, remote-pair**: ngoài phạm vi nhu cầu herdgate; độ phức tạp của renew state machine không đáng mang theo.
- **Verification cực đoan** (420 script gates, mutant JSON, frozen matrix test): mức này phục vụ phát hành npm package đa-harness; herdgate không cần nhân bản — chỉ lấy ý tưởng "reject phải có tên + test ma trận intent×capability".
- **Không coi pane text/keystroke là delivery evidence** (Rule 16) — cũng đúng cho Mobile TUI SSH của herdgate.
- Rule 6 (native module loading trắng-đen tuyệt đối) quá chặt cho plugin/pipeline của herdgate — nhu cầu khác, đừng kế thừa.

## File đã đọc

README.md (đủ); protocol.js (đủ); AGENTS.md (Architecture + 17 Hard Rules + ACP boundary + Retirement);
DELIVERY.md (TOC D0–D8 + control-socket acceptance + lifecycle-not-delivery). Nguồn:
1. `pi-extensions/lib/meta-session.ts` — header + `MetaIdentity` (dòng 346–530) + `defaultMetaSessionsDir/MailboxDir/SendersDir/ReceiversDir/RecordArmLocksDir` (1770–1870) + exports `enqueueMetaMessage/readMetaInbox/MAILBOX_RECEIPT_FIELDS`.
2. `pi-extensions/lib/entwurf-v2-decider.ts` — header + `ExecutionPlan/DispatchDecision/RejectDiagnostic/DispatchDeciderDeps` + `decideDispatch` bước 1–2d (dòng 1–360).
3. `pi-extensions/lib/entwurf-v2-mailbox.ts` — đủ (`executeMetaMailboxSend`, `makeProductionSendViaMailbox`).
4. `pi-extensions/lib/control-retire.ts` — đủ (`startOrRebindControlServer`, `requestControlRetire`, `retireResponseEnvelope`).
5. `pi-extensions/lib/record-arm-lock.ts` — đủ (`withRecordArmLock`, 2 error class).
6. `pi-extensions/lib/entwurf-facts.ts` — `PeerFact/ReceiverObservation/UNOBSERVED_PEER/resolvePeerFact/isOutOfSocketDomainGardenIdConflict` (dòng 43–155).
7. `pi-extensions/lib/socket-discovery.ts` — exports (`controlSocketPath`, `inspectTargetControlSocket`, `mapInspectionToLiveness`, `scanSocketProbes`).
8. `pi-extensions/lib/entwurf-core.ts` — header + exports + `RecordedSessionIdentity` (dòng 1–235).
9. `pi-extensions/lib/entwurf-v2-lock.ts`, `entwurf-mcp-server.ts`, `fresh-call-dispatch.ts` — đã fetch (tham chiếu chéo).
