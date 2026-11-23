# C23 — Loop cooldown phải *hoãn* nudge, không *bỏ rơi* (liveness)

- Vòng: C23 · Loại: bug vành máy (liveness) · Ưu tiên: cao — loop đang mắc kẹt lành trên main
- Trạng thái: **spec v1.1 — đã qua critic (14 finding, xem mục 8) → implement**
- Liên quan: C11c (start-after-done + cooldown), C17 (auto-pause), C18 (audit), C20 (kick/auto-resume), C21 (`loop.status`)
- Bài học nguồn: pi-herdsman `recipient-fan-in.ts` — thông điệp đến trong lúc bận thì **xếp hàng at boundary**, không bao giờ drop

## 1. Vấn đề (bằng chứng sống)

`plugin/loop/server/index.mjs` `cmdEvent`: một settle (`idle|done`) của pane loop đến trong
`cooldownMs` kể từ nudge trước → ghi `nudge suppressed (cooldown …)` rồi `process.exit(0)`.
**Sự kiện settle bị tiêu thụ mà không sinh gì.** Không có event kế vì agent đã idle → loop đứng im:

```
16:24:43 nudge #4 rc=ok (pane wM:p2)          ← cycle #4 (no-op, ~34s)
16:25:17 AUDIT ok commits=1 tags=0
16:25:17 nudge suppressed (cooldown 60000ms)   ← settle rơi sau 34s < 60s → drop
(_im lặng ≥ 35 phút; noopStreak=1 nên C17 không auto-pause; backlog thêm việc cũng không có gì khởi động_)
```

Trước wave 2 không lộ vì các cycle thường > 60s. Hệ quả: loop "sống" trong state (`status: running`,
`paused: false`) nhưng không tiến — chỉ `kick` tay mới hồi phục.

## 2. Hành vi bắt buộc

R1. Một settle bị chặn vì cooldown **phải** lên lịch **đúng một** nudge hoãn tại `lastNudgeAt + cooldownMs`
    (không sớm hơn; trễ một vài trăm ms là chấp nhận được).
R2. Nudge hoãn, khi đến giờ, **không tự ý nudge** nhưng cũng **không chạy lại bookkeeping**: audit (C18),
    classify/auto-pause (C17) và `maxCycles` đã xử lý settle thật **đúng một lần** lúc lên lịch — chạy lại là
    đếm kép (F3). Nudge hoãn chỉ kiểm tra lại các **hàng rào**: `deferredId` khớp, config hợp lệ, `armed`,
    status `running`, không `paused`, không `auditHold`, pane còn sống và không `working|blocked` — rồi nudge.
    Nếu hàng rào chặn → `dropped: <lý do>`, state vòng đời **không** bị thay đổi.
R3. Trước khi nudge, nudge hoãn hỏi herdr một lần trạng thái pane: `working|blocked` → **bỏ** (agent đang
    bận — một settle thật sẽ đến); pane không còn → **bỏ** + log (KHÔNG tự ghi `chain-broke`: sự kiện
    `pane.exited` của herdr mới là chủ vòng đời — loop không tự sáng tạo chuyển trạng thái vòng đời).
R4. **Idempotent, đúng một tiến trình**: chỉ **mint `deferredId` mới + spawn** khi chưa có lịch trong cửa sổ
    ±250ms; nếu đã có lịch cùng lúc đến thì giữ nguyên và **không spawn con thứ hai** (F1). `kick` (mọi nhánh,
    kể cả early-exit khi pane `working` — F9)/`stop`/`start` xoá lịch hoãn; lịch bị thay thế phải thoát:
    phát hiện **trước khi ngủ** → im lặng tuyệt đối (không log, không mkdir — F4); phát hiện **khi thức dậy** →
    log `dropped: superseded`.
R5. Nudge thật (`lastNudgeAt` đổi) → xoá lịch hoãn còn treo.
R6. Không có tiến trình daemon: lịch hoãn là **một tiến trình node tách rời, ngắn sống** (ngủ tới giờ rồi
    chạy `deferred-nudge` và thoát). Mọi ràng buộc "one short-lived process per event; never a daemon"
    trong `herdr-plugin.toml` vẫn đúng.
R7. Chạy được trên **Linux và Windows** (C12): dùng `spawn(process.execPath, [SELF, "deferred-nudge",
    "--id", id], { detached: true, stdio: "ignore" }).unref()`; truyền env kế thừa (state/config dir).
R8. Log thật, một dòng mỗi việc (để `loop.status` logTail của C21 đọc được):
    `deferred nudge scheduled in Ns (id <8 ký tự>)` · `deferred nudge: firing (id …)` ·
    `deferred nudge dropped: <lý do> (id …)` với lý do ∈ {superseded, pane working, pane gone, status=<s>,
    paused by owner, audit hold, config invalid, bridge <code>}. `maxCycles`/`cooldown` **không** là lý do
    dropped: chúng thuộc bookkeeping đã xử lý ở settle (F10/F11).
R9. `loop.status` (C21) **thêm** `deferredUntil` (epoch ms | null) — additive, không đổi field cũ.
R10. Hành vi cũ giữ nguyên khi cooldown đã qua (nudge ngay) và khi `cooldownMs` không đổi (không có
    "cooldown = 0"; MIN 10s giữ nguyên).

## 3. Thiết kế chốt (implementer không quyết lại)

- State mới: `deferredUntil?: number` (epoch ms), `deferredId?: string` (uuid). File-first như các field khác.
- **Tách `cmdEvent` thành hai hàm thuần-về-điều-khiển, không `process.exit` bên trong** (F2/F12):
  1. `settleBookkeeping({ state, cfg, paneId }) → { state, action: "nudge-now" | "defer" | "stop", reason? }`
     — chạy đúng thứ tự cũ: config hợp lệ → `armed` → status → paused/C20 auto-resume → auditHold → **audit C18** →
     **classify/auto-pause C17** → `maxCycles`. Mọi `saveState` của bookkeeping giữ nguyên như hôm nay.
     `reason` là lý do dừng (`status=…`, `paused by owner`, `audit hold …`, `config invalid`, `maxCycles N reached`,
     `auto-pause …`, `armed …`) để `cmdEvent` log đúng dòng cũ.
  2. `nudgeNow({ state, cfg, paneId, agentStatus }) → { state, verdict: { nudged, reason? } }` — chỉ cooldown
     check + `pane.send_text` + cập nhật `lastNudgeAt/cycles/armed` (và xoá lịch hoãn — R5).
  `cmdEvent` = đọc event env → các guard pane/exited/working như cũ → `settleBookkeeping` → theo `action`:
  `nudge-now` → `nudgeNow` → `exit`; `defer` → `scheduleDeferred`; `stop` → log reason → `exit`.
- `scheduleDeferred(state, atMs)`: nếu state đã có `deferredUntil` trong ±250ms của `atMs` → giữ, **không spawn**;
  ngược lại mint `deferredId` mới, ghi `deferredUntil = atMs`, rồi
  `spawn(process.execPath, [SELF, "deferred-nudge", "--id", id], { detached: true, stdio: "ignore" }).unref()`.
  `SELF = fileURLToPath(import.meta.url)` (**cấm** `.pathname` của file URL — hỏng trên Windows, F7).
- Subcommand `deferred-nudge --id <uuid>` (không đọc `HERDR_PLUGIN_EVENT_JSON`; `paneId` lấy từ state):
  1. đọc state; thiếu file / `deferredId !== id` → thoát **im lặng** (không log, không mkdir).
  2. `setTimeout(max(0, deferredUntil − now))` — không busy-wait, không poll.
  3. đọc state lần nữa; `deferredId !== id` → log `dropped: superseded` → thoát.
  4. **hàng rào** (F6): config hợp lệ, `armed`, status `running`, không `paused`, không `auditHold` →
     vi phạm → log `dropped: <lý do>` + xoá lịch + thoát.
  5. `getPane` (C20, một `pane.list`): **phân biệt ba kết quả** (F5): danh sách trả về mà thiếu pane → `pane gone`;
     `working|blocked` → `pane working`; **lỗi hạ tầng** (`no-reply`, spawn lỗi, JSON hỏng) → **giữ lịch**, log
     `deferred nudge retry: bridge <code> (n=<lần>, 5s)` và tự lên lại sau 5s (tối đa 3 lần, rồi `dropped: bridge <code>`).
  6. `nudgeNow(...)` với `agentStatus` vừa quan sát — **một lần ghi state** gồm nudge + xoá lịch (F14: không xoá
     lịch trước khi có kết luận). Log `deferred nudge: firing (id …)` ngay trước `send_text`.
- Xoá lịch hoãn: trong `cmdKick` (mọi nhánh có ghi state + một ghi bổ sung ở nhánh early-exit `working`),
  `cmdStop`, `cmdStart`, và trong `nudgeNow` sau nudge thật.
- Không đổi thứ tự các lớp bookkeeping; không đổi `noopPauseAfter`, `auditHold`, `shouldAutoResume`, cooldown mặc định.

## 4. Non-goals

- Không đổi cooldown mặc định (60s) hay MIN (10s). Không đưa vào timer chung hay daemon.
- Không đụng `plugin/server/index.mjs` ngoài việc thêm `deferredUntil` vào op `loop.status`.
- Không sửa `scripts/`, systemd units, `docs/DEV-LOOP/AUTO.md`, `herdr-plugin.toml` (không cần action mới —
  `deferred-nudge` là lệnh nội bộ; nếu muốn đăng ký action thì **không**, giữ nội bộ).

## 5. Test (bất biến bền, không ghpin trạng thái một lần) — thêm vào `test/loop-plugin.test.ts`

| # | Tên | Chứng minh |
|---|---|---|
| T1 | settle trong cooldown lên lịch đúng một nudge hoãn | state có `deferredUntil ≈ lastNudgeAt+cooldown` (±250ms) và `deferredId`; log có `deferred nudge scheduled`; **chưa** có `pane.send_text` nào |
| T2 | hai settle trong cùng cửa sổ → một lịch | `deferredId` không đổi sau settle thứ hai; `deferredUntil` không trôi |
| T3 | `deferred-nudge` đến giờ → nudge đúng một lần | state chuẩn bị với `deferredUntil` đã qua, stub trả pane `idle` → **đúng 1** `pane.send_text`; state mất `deferredUntil`; `lastNudgeAt`/`cycles` cập nhật |
| T4 | id không khớp → thoát im lặng | state `deferredId` khác → 0 call herdr, 0 nudge |
| T5 | pane `working` / pane gone → dropped, không nudge, không đổi status | stub trả `working` → 0 send_text, status giữ `running`; stub không trả pane → `dropped: pane gone`, status **không** thành `chain-broke` |
| T6 | paused-by-owner / auditHold / status≠running / config hỏng khi đến giờ → tôn trọng | 0 send_text; log `dropped:` lý do đúng; **không** chạy lại audit/classify (state `noopStreak`/`lastAuditAt` không đổi) |
| T7 | `kick` xoá lịch hoãn | sau `event` trong cooldown → `kick` → state không còn `deferredUntil`; `deferred-nudge --id cũ` → 0 call |
| T8 | vượt cooldown → nudge ngay như cũ, không lên lịch | `lastNudgeAt = now - cooldown - 1000` → 1 send_text, state không có `deferredUntil` |
| T9 | nudge thật xoá lịch treo (R5) + `stop`/`start` xoá lịch (F8) | state có lịch stale → settle vượt cooldown → 1 send_text và không còn `deferredUntil/deferredId`; sau `stop` và sau `start` cũng không còn |
| T10 | cùng cửa sổ → **không** spawn thứ hai (F1); lỗi bridge → retry rồi drop (F5) | hai settle liên tiếp: `deferredId` không đổi (và không có lịch mới); stub `pane.list` không trả lời (holding stub) → log `retry: bridge …` (test chỉ cần 1 lần retry với `HERDR_LOOP_RETRY_MS`-free cách: stub trả lời sai JSON một lần rồi đúng) |

Ghi chú harness: con `deferred-nudge` do T1/T2 spawn sẽ thức dậy ≤ 10s sau khi test `rmSync(dir)` — bước 1
im lặng tuyệt đối bảo đảm không rác; test **không** chờ con. T3 chạy `deferred-nudge` trực tiếp với state đã
chuẩn bị (`deferredUntil` đã qua) — deterministic. Suite hiện có (`loop-plugin`, `loop-audit`, `loop-status-op`,
`devloop-docs`, `release-shape`) phải xanh.
Chỉ chạy `node --test test/<file>` — **không** chạy full suite.

## 6. Nghiệm thu sống (controller làm sau merge, trên main)

Scratch loop, không đụng loop dev-loop thật: `loop.json` mới (label `c23-verify`, `maxCycles: 3`,
`cooldownMs: 60000`, `noopPauseAfter: 0`) với prompt file một dòng: *"Trả lời đúng một từ: OK. Không làm gì khác."*
→ `start` → agent trả lời trong vài giây → log phải cho thấy chuỗi:
`nudge #1` → `nudge suppressed (cooldown 60000ms)` → `deferred nudge scheduled in ~55s` → (đến giờ)
`deferred nudge: firing` → `nudge #2` → … → `nudge #3` → `maxCycles 3 reached — loop done`.
Sau đó `stop` (đóng workspace). Loop dev-loop thật: `kick` một lần, quan sát log có `deferred nudge scheduled`.

## 7. Guardrail cho agent thực hiện

- Worktree riêng, branch từ `main`. KHÔNG push/tag/bump version/npm publish; KHÔNG sửa `AUTO.md`,
  systemd units, `scripts/`, bảng Backlog/Cycle Log (controller ghi lúc review).
- KHÔNG can thiệp pane/tab/workspace herdr của người dùng; KHÔNG chạy full suite.
- Test đỏ trước (T1→T8), rồi code, rồi xanh. Kết thúc bằng dòng `C23-DONE <pass>/<fail> <sha>`.

## 8. Changelog

- v1.1 (sau critic `c23-critic`, 14 finding): F1 spawn chỉ khi mint id mới · F2 hàm dùng chung trả verdict, không
  `process.exit` · F3 bookkeeping chạy một lần ở settle, nudge hoãn chỉ kiểm hàng rào (tránh đếm kép `noopStreak`) ·
  F4 superseded trước ngủ = im lặng · F5 lỗi bridge ≠ pane gone (retry 5s ×3) · F6 hàng rào gồm config/armed ·
  F7 `SELF = fileURLToPath` · F8 thêm T9 · F9 kick xoá lịch mọi nhánh · F10/F11 bỏ `cooldown`/`maxCycles` khỏi lý do
  dropped · F12 hàm nhận `{state, cfg, paneId, agentStatus}`, không đọc env event · F13 sửa `~55s` · F14 xoá lịch
  cùng lần ghi với nudge. Ghi nhận ngoài phạm vi: `plugin/server/index.mjs` dùng `new URL(...).pathname` cho
  supervisor (latent Windows bug) → ứng viên C24.
