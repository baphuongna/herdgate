# Đào sâu tầng 2: junghan0611/entwurf (excavate)

Đối chiếu tầng 1: `../r-entwurf.md` (V2 dispatch, record store, retire leaf). Tầng 2 đào phần tầng 1 KHÔNG chạm: **toàn bộ herdr rail** (2 rail launch + resume), **state machine reopen**, **lock primitive**, **birth/attach**, **sender identity**, **acceptance boundary**, **retirement event**, CI/verification, test patterns. Repo ~190k dòng TS/JS (pi-extensions 85k, scripts 85k, test 7.7k, plugins 3.3k) → đọc trọn lõi + liệt kê phần còn lại.

## Kiến trúc đầy đủ (module graph)

```
MCP bridge (mcp/entwurf-bridge) — registration duy nhất (issue #125)
├─ entwurf_v2 (send)        → entwurf-v2-decider → lock/socket/mailbox (tầng 1)
├─ entwurf_fresh_call       → fresh-call-dispatch  ← COMPOSITION ROOT chọn rail
│     ├─ selectFreshCallRail(env): HERDR_ENV==="1" ? herdr : tmux  (không phải param!)
│     ├─ tmux rail  → mux-fresh-call → mux-placement
│     └─ herdr rail → herdr-fresh-call
│           ├─ agent-start domain (pi|claude-code): tab create → agent start (2 mutations)
│           └─ layout domain (pi-durable): ONE layout.apply qua HERDR_SOCKET_PATH (unix socket)
├─ entwurf_resume_call      → entwurf-v2-visible-resume (lock + record + dormancy proof)
│     └─ deps.launch (INJECTED SEAM) → fresh-call-dispatch.dispatchResumeLaunch
│           ├→ mux-resume-call        └→ herdr-resume-call (pi agent-start; pi-durable + claude-code layout)
├─ control rail    → entwurf-control-rpc → control-steer / control-send-receipt / control-retire
└─ peers           → entwurf-facts + entwurf-peer-observe + herdr-placement (placement observation)

Hook-side (chạy trong harness): pi-citizen-birth (SessionStart attach), cc hooks → meta-session
upsert + meta-senders marker; meta-sender-identity (MCP child → owner qua ppid + start-key).
Sidecars: meta-sessions/ meta-mailbox/ meta-senders/ meta-receivers/ meta-record-arm-locks/
entwurf-v2-locks/ meta-retirements/<gid>.jsonl (append-only, retirement-event.ts)
plugins/herdr: installer + status pane; lib/*.mjs chỉ re-export scripts/herdr-runtime.mjs
(quan trọng: herdr plugin uninstall xoá checkout → code uninstall phải sống NGOÀI checkout).
```

Dữ liệu chảy: record là authority địa chỉ; socket/marker/pane/env chỉ là evidence. Address đến từ record (resume) hoặc callback envelope (fresh). Không gì đọc pane text làm bằng chứng delivery.

## Máy trạng thái & luồng chi tiết

### 1. Herdr fresh call — 2 domain launch, order-is-the-argument (herdr-fresh-call.ts:891-1020)
Mọi thứ quyết-xong-trước-mutation; một `pane get` (read, không tạo gì) chen giữa refusal và mutation đầu:
```ts
// herdr-fresh-call.ts (herdrFreshCall, thứ tự đã đóng băng)
const context = resolveHerdrContext(env);            // HERDR_ENV=1 + BIN + PANE_ID
const tmuxPlacement = rejectTmuxPlacementInHerdrContext(params.placement); // refuse, không drop
...
const callerPaneRun = await run(buildHerdrPaneGetArgs(context.context.callerPaneId));
if (callerPane.paneId !== context.context.callerId) return {..., reason: "herdr-caller-pane-drift"};
// ── everything above this line leaves nothing behind ──
const tabRun = await run(buildHerdrTabCreateArgs({workspaceId: callerPane.workspaceId, ...}));
```
Tab create phải có `--workspace` EXPLICIT — đo được: bỏ đi thì herdr đặt tab vào workspace đang focus = "silent relocation" (herdr-fresh-call.ts:596-604). Workspace lấy từ câu trả lời của herdr về pane của CALLER, không từ parse `w7:pA` (opaque, có pane `w7:pA` base-36).

### 2. Recovery taxonomy + occupancy 2 facts (herdr-fresh-call.ts:250-296, 759-800)
```ts
export type HerdrRecovery =
  | { readonly outcome: "none" }   // herdr declined bằng envelope riêng → chắc chắn không tạo gì
  | { readonly outcome: "unknown" }// timeout/kill của ta → tab CÓ THỂ tồn tại, không đoán, không close
  | { readonly outcome: "closed"; readonly paneId: string; readonly terminalId: string }
  | { readonly outcome: "orphan-unreclaimed"; readonly paneId: string; reason: HerdrOrphanReason };

export function decideConditionalClose(created, current, getFailed) {
  if (current.paneId !== created.paneId) return { close: false, reason: "pane-id-mismatch" };
  if (current.terminalId !== created.terminalId) return { close: false, reason: "terminal-id-mismatch" };
  if (current.agent !== undefined) return { close: false, reason: "agent-present" };      // occupancy
  if (current.hasAgentSession) return { close: false, reason: "agent-session-present" };  // join key
  return { close: true };
}
```
Incident thật (LIVE run XimC19): bản cũ chỉ check `hasAgentSession` → pane có Claude con đang sống bị close 0.585s sau khi con ghi birth record, vì session id đến bằng hook round-trip RIÊNG sau start. Bài: **occupancy ≠ session-id-đã-báo**; "no finite wait converts 'nobody told us the id' into 'nobody is there'". Reclaim luôn bind theo CREATE receipt (paneId+terminalId), không theo start echo; `terminal_id` chỉ có ý nghĩa trong 1 server generation (restart đổi terminal id → mismatch = hướng an toàn).

### 3. Witness 3 trạng thái + settle window (herdr-fresh-call.ts:322-350, 1040-1110)
```ts
export interface HerdrWitness { readonly state: "reported" | "unavailable" | "unobserved";
  readonly reads: number; readonly settleMs: number; }
// reported:   herdr biết session id (join được placement)
// unavailable: ĐÃ THẤY agent trong pane ta mở nhưng chưa có id → KHÔNG phải failure, không reclaim
// unobserved: không đọc được gì → receipt không khẳng định gì về liveness
```
Settle = poll read-only 5s/100ms; expiry KHÔNG BAO GIỜ là quyền close. Rebinding 5 trục (pane/terminal/tab/name/kind): field thiếu = không dùng được (giữ poll), field có mà khác = drift → `herdr-agent-start-vanished`. Bounds: `HERDR_START_READY_MS=240s < HERDR_START_TIMEOUT_MS=300s` — vendor phải thua cuộc đua timeout để trả về error CÓ TÊN thay vì ta kill trước (herdr-fresh-call.ts:2107-2130).

### 4. Visible resume — 2 receipt tách bạch + lock-trước-liveness (entwurf-v2-visible-resume.ts:411-540)
```ts
const acquired = deps.acquireLock(targetGardenId);       // lock TRƯỚC câu hỏi liveness
...
const inspection = await deps.inspectSocket(targetGardenId);   // probe DƯỚI lock (đóng TOCTOU)
if (mapped.liveness === "alive") return { ok:false, reason:"target-live", ... };
const launched = await deps.launch({ backend:"pi", cwd: identity.cwd, runtimeArgs });
const observation = await observeSameGidSocket(targetGardenId, mapped.socketPath, deps);
return { ok: true, launch: {...}, observation };          // LAUNCH ≠ OBSERVATION
```
Dormancy proof per-backend (header module): pi = socket chết; claude-code = marker owner DEAD **và** record re-read SAU verdict vẫn cùng `attachIncarnation` (bind "không có arm nào commit sau owner chết"); pi-durable = reserve được session dir qua owner-fence. Observation = MỘT phép bounded (30s/500ms), không relaunch, không watcher, không env knob; hết hạn → **release lock, để nguyên window/tab mở** — "a retained lock on a visible artifact is the worse failure". Claude observation phải là owner MỚI (pid/startKey/incarnation khác cái đã chết) join vào pane pid (`observeReceiverReattached`, :1005-1045): "The old marker read again is never success".

### 5. Lock primitive (entwurf-v2-lock.ts:270-360) — wx + nonce + reclaim mutex
```ts
fd = openSync(lockPath, "wx");                       // atomic create-exclusive
// stale reclaim: chỉ same-hostname && kill(pid,0)===ESRCH; EPERM = fail-closed
const reclaimable = holder.hostname === hostname && classifyProcessLiveness(holder.pid, killFn) === "dead";
// reclaim chạy dưới <gid>.lock.reclaim wx mutex → hai reclaimer không thể cùng reclaim 1 lock chết
// release: unlink CHỈ khi nonce trên đĩa còn là của mình (successor không bị xoá nhầm)
if (onDisk === null || onDisk.nonce !== claim.nonce) return "not-owned";
```
Corrupt/empty lockfile → conflict kèm mtime cho người dọn, KHÔNG BAO GIỜ auto-delete (có thể là acquirer đang ghi dở). `lockPathFor` validate gid trước khi build path — layer không chấp nhận làm path-traversal sink.

### 6. Acceptance boundary — receipt nói "receiver chấp nhận ở đâu", không nói route (control-send-receipt.ts:14-50)
```ts
export const ACCEPTANCE_BOUNDARIES = [
  "sent",                    // idle + làm turn trigger trực tiếp — REQUEST được chấp nhận, không phải model đã thấy
  "queued-steer",            // vào steering queue (volatile, abort là mất)
  "queued-follow-up",        // vào follow-up queue (đợi inner loop kết thúc; steer đến sau vẫn đi trước)
  "steer-in-turn", "steer-unknown", "accepted-unknown-boundary",
] as const;
export function sendReceiptBoundary(input: { idle: boolean; mode: "steer" | "follow_up" }): ObservedBoundary {
  if (input.idle) return "sent";
  return input.mode === "follow_up" ? "queued-follow-up" : "queued-steer";  // PURE
}
```
Đo trong pi-agent-core 0.87: 2 queue độc lập each-one-at-a-time → `sent` từng có nghĩa là 4 thứ khác nhau. Receiver tự classify (pure), sender chỉ đọc; version skew = `accepted-unknown-boundary` "never rendered as a failure to retry".

### 7. Birth = ATTACH, không mint-mỗi-lần (pi-citizen-birth.ts:14-40)
```ts
// upsertMetaSession quyết create-vs-attach theo record EXISTENCE keyed by nativeSessionId
// pi tự mint uuidv7 (NORMAL), record mint gardenId, join = (backend, nativeSessionId)
// socket path DERIVED ngay đây → record và address không thể tính từ input khác nhau
```
Ghi vào record đang tồn tại phải dưới record-arm lock; lock busy = `RecordArmLockBusyError` named outcome duy nhất, không ghi gì.

### 8. Sender identity 3 lớp把关 (meta-sender-identity.ts:56-130)
```ts
// 0. isPlausibleOwnerPid (pid<=1 không thể là owner — init vẫn "alive" mãi)
// 1. pid + start-key (pid reuse không kế thừa garden-id)
// 2. record vouches: backend/nativeSessionId phải khớp record; record tồn tại nhưng đọc
//    không được → THROW EntwurfSenderRecordUnreadableError (F10: gộp vào "no marker" = sai nguyên nhân)
// 0 trusted → null; 1 → identity; 2+ khác gardenId → throw AmbiguityError (SE-1: refuse, không chọn theo thứ tự)
```

## Mọi cơ chế áp vào herdgate

1. **[CAO] Rail theo capability, không phải parameter** — `selectFreshCallRail: env.HERDR_ENV === "1" ? "herdr" : "tmux"` (fresh-call-dispatch.ts:50-54). Caller không được chọn rail; không fallback 2 chiều ("no tmux fallback... a sibling opened on a rail the caller did not ask for is worse than a refusal"). Áp: relay/pipeline herdgate khi chạy trong Herdr TUI (các skill herdr-*) nên detect `HERDR_ENV` một chỗ, refuse có tên thay vì improvise đường khác. File: `pi-extensions/lib/fresh-call-dispatch.ts:40-54`.
2. **[CAO] Occupancy 2 facts khi reclaim/close pane** — `agent-present` (herdr nói pane có agent) ≠ `agent-session-present` (đã báo session id). Tầng close/cleanup của `task.mjs close` + pipeline worktree cleanup: trước khi close pane/tmux, check cả 2; không bao giờ kết luận "pane trống" từ "chưa thấy session id". File: `herdr-fresh-call.ts:759-800` (decideConditionalClose).
3. **[CAO] Recovery taxonomy none|unknown|closed|orphan-unreclaimed** — mọi thao tác 2-bước (tạo rồi mới configure) của relay/PWA pipeline cần phân biệt "chắc chắn không tạo gì" (vendor envelope) vs "không biết" (timeout của chính ta → có thể tồn tại, bảo operator đi xem, không close không retry). File: `herdr-fresh-call.ts:250-262` + render `renderRecovery`. Áp vào: `spawn`/`revive` qua SSH có thể timeout giữa chừng.
4. **[CAO] Async runner bắt buộc — callback deadlock** (herdr-fresh-call.ts:2150-2160): sibling gọi callback về caller ĐÚNG lúc caller đang block trong `agent start` (tới 300s); sync wait giữ event loop → callback timeout. "The runner is therefore async: the child runs while the loop keeps serving sockets and timers." Áp: relay server herdgate không được block khi chờ agent/SSH lâu — wake-on-settle listener phải sống song song.
5. **[CAO] 2 receipt LAUNCH vs OBSERVATION cho revive** — `task.mjs revive` nên trả `{launch: {pane/tab/argv}, observation: {kind, waitedMs}}` tách bạch; observation bounded 30s/500ms, hết hạn = "unobserved, cửa sổ còn mở, lock đã release, không retry không kill". File: `entwurf-v2-visible-resume.ts:1005-1100` + renderer tách 2 đoạn "LAUNCH receipt:" / "OBSERVATION receipt:".
6. **[CAO] Lock wx + nonce + reclaim-mutex cho spawn/revive/close** — 2 lệnh `revive` cùng agent sẽ đặt 2 process lên 1 transcript. Copy nguyên `acquireLock/releaseLock` (entwurf-v2-lock.ts): `openSync(wx)` + claim JSON {pid,hostname,createdAt,nonce} + stale-reclaim chỉ same-host+ESRCH + mutex `<name>.lock.reclaim` + release theo nonce. Conflict mang holder JSON để người dọn. Áp: file `task.mjs` + worktree pipeline.
7. **[CAO] Acceptance boundary vocabulary cho relay receipts** — thay `delivered:true` bằng closed set `sent|queued|accepted-unknown` classify PURE ở receiver theo {idle, mode}. `deliver:<id>` receipt herdgate cần biết "accepted as turn trigger" ≠ "queued" ≠ "unknown". File: `control-send-receipt.ts:14-66`.
8. **[TB] Workspace từ caller pane, không từ focus** — `pane get $HERDR_PANE_ID` → workspaceId; drift check (reply phải nói đúng pane đã hỏi) rồi mới `--workspace <id>`; đo được: omit → tab vào workspace đang focus. Áp mọi nơi herdgate mở tab/pane qua herdr CLI. File: `herdr-fresh-call.ts:962-976`.
9. **[TB] Identity scrub `--env PI_SESSION_ID=`** — inject EMPTY value (không phải drop key); đo từ `/proc/<pid>/environ` rằng con không kế thừa id cũ. Áp: spawn agent mới từ trong session Pi đang có (tránh agent con tự xưng là citizen cha). File: `herdr-fresh-call.ts:607-625`.
10. **[TB] Envelope chặt: result XOR error + id correlation + pinned pre-create codes** — `readHerdrEnvelope` refuse payload có cả 2 arm hoặc sai id; "nothing created" chỉ kết luận từ code trong danh sách ĐÃ PIN theo source vendor (`HERDR_LAYOUT_NONE_CODES`), mọi code khác = unknown. Áp: mọi JSON reply từ herdr CLI/socket trong relay. File: `herdr-fresh-call.ts:1537-1560, 1236-1244`.
11. **[TB] Diagnostics bounded 256 + render quoted "display only"** — giá trị vendor cắt để hiển thị, quyết định đã lấy trên giá trị gốc; render `JSON.stringify` để không giả làm prose. Áp: PWA Cmd+K + receipts hiển thị lỗi vendor/SSH. File: `herdr-fresh-call.ts:1500-1510` (`boundHerdrDiagnostic`, surrogate-safe cut).
12. **[TB] Retirement event JSONL per-target + outcome vocab per-backend** — append-only `<gid>.jsonl`, mỗi dòng closed v1 JSON; outcome statuses pin theo backend, cross-domain pair (pi `exited`) REFUSE tại write-time. Áp: receipts JSONL herdgate thêm sidecar retire/spawn event per agent id với vocab đóng. File: `retirement-event.ts:30-60`.
13. **[TB] argi echo check** — `argvMatchesRequest`: reply `agent start` echo lại argv; khác argv compose = drift named, không tin receipt. Áp: xác nhận lệnh spawn qua herdr/SSH đúng args. File: `herdr-fresh-call.ts:793-806`.
14. **[TB] Record-unreadable ≠ no-marker** (F10): identity tồn tại nhưng đọc hỏng → throw với cause, không fold vào "không tìm thấy". Áp: spawn registry đọc record lỗi phải nói "record corrupt", không phải "chưa có agent". File: `meta-sender-identity.ts:118-130`.
15. **[THẤP] Vendor-timeout thua cuộc đua** — bound của ta > bound truyền cho vendor để vendor trả error CÓ TÊN (240s vs 300s, margin 60s). Áp: SSH/herdr command timeout nesting. File: `herdr-fresh-call.ts:2107-2130`.
16. **[THẤP] Plugin code sống ngoài checkout plugin** — plugins/herdr/lib chỉ re-export scripts/herdr-runtime.mjs vì `plugin uninstall` xoá checkout mà không gọi cleanup hook. Áp nếu herdgate làm herdr-plugin: journal/uninstall logic phải ở nơi không bị xoá. File: `plugins/herdr/lib/runtime-bootstrap.mjs` (full).

## Cách họ test (bài học cho suite 213 test)

- **Matrix test = bảng đọc được + coverage pass tự fail** (`entwurf-v2-decider.matrix.test.ts:283-320`): mỗi row {scenario, expect}; riêng biệt 3 assertion `reach:` (seam nào được chạm — DERIVED từ scenario, không hand-set), `lock class:` (đếm acquire/release từ fakes tracked — "counts ARE the assertion"), `diagnostic:` (KIND diagnostic, không boolean). Cuối file: coverage pass fail nếu thiếu transport/lock-class/reject-reason nào trong bảng → "a dropped decider cell makes this fail — it is not a silent green". Áp: bảng intent×state cho relay dispatch của ta.
- **Fakes tracked + "no fake binary"**: `HerdrRun` inject table cho CLI; nhưng transport socket dùng **real unix socket** trong tmpdir — "a fake would agree with whatever we believed on the day we wrote it" (`herdr-layout-fresh-call.test.ts:6-10`). Reply literal là reply THẬT ghi từ herdr 0.9.5, chỉ re-key id.
- **Mỗi claim một test title có mã** (HLFC-SAME-ENDPOINT, QK:RENEW-B2-LOCKED-WRITE-SYNC) — mutant kill được attribute qua title failed.
- **Test beside behavior**: `.test.ts` nằm cạnh module (`vitest.config.ts` include `pi-extensions/**/*.test.ts`), không tập trung 1 chỗ; `fileParallelism:false` DELIBERATE (gates spawn subprocess dùng chung checkout); testTimeout 30s với lí do ghi sẵn.
- **Contract-keyed test**: `LOCK_CONFLICT_REASON` literal được test cross-check với contract `ENTWURF_V2_REJECT_REASONS` để 2 chỗ không drift.
- **CI tiering** (ci.yml): push = floor đầy đủ (`check:full` + pinned herdr binary sha256 từ `scripts/fixtures/herdr-supply.json`, `ENTWURF_REQUIRE_HERDR=1` biến skip thành red); weekly cron = drift ceiling; tag push KHÔNG chạy gì (đo 66/66 lần rebuild trùng). `check-elapsed.sh` chặn script check chậm dần.

## Anti-pattern / không lấy gì

- **Độ phức tugs verification**: 254 script gates + run.sh 558KB + mutant argv + 420 frozen cells — phục vụ phát hành npm đa-harness; herdgate không nhân bản, chỉ lấy: matrix-with-coverage-pass, claim-coded titles, contract cross-check.
- **pi-durable owner-fence + /renew 5 bước + chapters**: state machine reserve/adopt/generation phục vụ một backend đặc thù; herdgate không có nhu cầu transcript-chapter — bỏ.
- **protocol.js dual-runtime hack** (.js cho cả tsc-emit và strip-types): artifact của toolchain riêng, không phải pattern.
- **Scan-store làm index** (tầng 1 đã nói, khẳng định lại): vài chục citizen/máy thì ổn; herdgate giữ JSONL append + record JSON, không thay bằng scan.
- **Remote-pair transport, ACP rail, native-push adapter**: ngoài phạm vi.
- **Learnt-the-hard-way story trong comment dài hàng chục dòng**: giá trị khảo cổ lớn nhưng README/code herdgate không nên copy văn phong này — comment trở thành tài liệu trộn lẫn; họ chấp nhận vì repo là working journal.
- **KHÔNG copy code**: MIT nhưng móc vào pi SDK internals, herdr pin digest, Claude hook — học protocol/predicate, không vendoring.

## File đã đọc (tầng 2; tầng 1 xem ../r-entwurf.md)

ĐỌC TRỌN: `pi-extensions/lib/herdr-fresh-call.ts` (2289d, hết); `herdr-resume-call.ts` (810d, hết); `entwurf-v2-visible-resume.ts` (1419d, hết); `entwurf-v2-lock.ts` (422d, hết); `entwurf-v2-decider.matrix.test.ts` (405d, hết); `protocol.js` (23d); `vitest.config.ts`; `plugins/herdr/lib/runtime-bootstrap.mjs`; `record-arm-lock.test.ts`.
ĐỌC SÂU (header + phần chính, dòng ghi rõ): `pi-citizen-birth.ts` 1-120/163; `meta-sender-identity.ts` 1-200/528; `entwurf-deliverability.ts` 1-60/290; `control-send-receipt.ts` 1-80/202; `fresh-call-dispatch.ts` 1-90/259; `renew-transition.ts` 1-70/386; `retirement-event.ts` 1-60/253; `herdr-layout-fresh-call.test.ts` 1-110/1169; `.github/workflows/ci.yml` (job check chính); `package.json` (toàn bộ script keys, 84 gates); `plugins/herdr/README.md` 1-60/867.
INVENTORY: cây thư mục đủ; LOC/dir (pi-extensions 85516, scripts 85203, pi 5416, test 7736, demo 4482, plugins 3259, native 1139, mcp 888); danh mục đầy đủ 150+ file pi-extensions/lib (X chương trình + .test.ts beside); docs/ 6 tài liệu (mux-launch-rail.md 13 mục, fresh-cut-policy, remote-sibling-principles, acp-backend-rail, external-mcp-host, renew-memory-outline) — headings quét; VERIFY.md/BASELINE.md/NEXT.md/FAQ.md headings; scripts/ 254 entries liệt kê.
PHẦN CHƯA ĐỌC (vai trò): pi-durable-carrier/owner-fence/runtime/location (12k dòng — backend pi-durable đặc thù); renew-writer/admission/front-gate/recover/command (~2k — /renew); cc-retire-request + cc-retire-pidfd.py (Claude retire qua pidfd); remote-pair-* (remote sibling); openclaw-*/copilot/codex/omp preflight (per-harness adapters); mux-* (tmux rail đối ứng herdr rail — đối chiếu được qua herdr twin đã đọc); acp/ (ACP rail); demo/ (repro); scripts/check-* (từng gate).
