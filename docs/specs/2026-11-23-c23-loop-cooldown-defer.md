# C23 — Loop cooldown phải *hoãn* nudge, không *bỏ rơi* (liveness)

- Vòng: C23 · Loại: bug vành máy (liveness) · Ưu tiên: cao — loop đang mắc kẹt lành trên main
- Trạng thái: **spec v1 — chờ critic → implement**
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
R2. Nudge hoãn, khi đến giờ, **không tự ý nudge**: nó kiểm tra lại toàn bộ như một settle thật —
    status `running`, không `paused` (nếu `paused` thì áp đúng luật C20 auto-resume), không `auditHold`,
    `maxCycles`, auto-pause C17 — rồi mới đến cooldown. Nói cách khác: nudge hoãn **là** một settle tổng hợp,
    không phải đường dẫn thứ hai.
R3. Trước khi nudge, nudge hoãn hỏi herdr một lần trạng thái pane: `working|blocked` → **bỏ** (agent đang
    bận — một settle thật sẽ đến); pane không còn → **bỏ** + log (KHÔNG tự ghi `chain-broke`: sự kiện
    `pane.exited` của herdr mới là chủ vòng đời — loop không bị절 dẫn lifecycle).
R4. **Idempotent**: nhiều settle trong cùng cửa sổ cooldown → một lịch hoãn (ghi đè cùng lúc đến);
    `kick`/`stop`/`start` xoá lịch hoãn; một lịch hoãn bị thay thế (id khác) phải tự thoát im lặng.
R5. Nudge thật (`lastNudgeAt` đổi) → xoá lịch hoãn còn treo.
R6. Không có tiến trình daemon: lịch hoãn là **một tiến trình node tách rời, ngắn sống** (ngủ tới giờ rồi
    chạy `deferred-nudge` và thoát). Mọi ràng buộc "one short-lived process per event; never a daemon"
    trong `herdr-plugin.toml` vẫn đúng.
R7. Chạy được trên **Linux và Windows** (C12): dùng `spawn(process.execPath, [SELF, "deferred-nudge",
    "--id", id], { detached: true, stdio: "ignore" }).unref()`; truyền env kế thừa (state/config dir).
R8. Log thật, một dòng mỗi việc (để `loop.status` logTail của C21 đọc được):
    `deferred nudge scheduled in Ns (id <8 ký tự>)` · `deferred nudge: firing (id …)` ·
    `deferred nudge dropped: <lý do> (id …)` với lý do ∈ {superseded, pane working, pane gone,
    status=<s>, paused by owner, audit hold, maxCycles, cooldown}.
R9. `loop.status` (C21) **thêm** `deferredUntil` (epoch ms | null) — additive, không đổi field cũ.
R10. Hành vi cũ giữ nguyên khi cooldown đã qua (nudge ngay) và khi `cooldownMs` không đổi (không có
    "cooldown = 0"; MIN 10s giữ nguyên).

## 3. Thiết kế chốt (implementer không quyết lại)

- State mới: `deferredUntil?: number` (epoch ms), `deferredId?: string` (uuid). File-first như các field khác.
- Subcommand mới: `node server/index.mjs deferred-nudge --id <uuid>`
  1. đọc state; thiếu / `deferredId !== id` → thoát im lặng (superseded).
  2. ngủ `max(0, deferredUntil - now)` bằng `setTimeout` (không busy-wait, không poll).
  3. đọc state **lần nữa**; `deferredId !== id` → `dropped: superseded`. 
  4. xoá `deferredUntil/deferredId` khỏi state, ghi.
  5. `getPane` (C20, một `pane.list`): không alive → `dropped: pane gone`; `working|blocked` → `dropped: pane working`.
  6. gọi **đúng hàm settle** của `cmdEvent` (refactor: tách phần từ "armed check" trở đi thành hàm dùng chung,
     nhận `agent_status` từ tham số thay vì từ event JSON) với `agent_status` = trạng thái vừa quan sát.
- Trong `cmdEvent`, nhánh cooldown: thay `exit(0)` bằng `scheduleDeferredNudge(s, until - last)` → ghi state
  (`deferredUntil = last + cooldown`, `deferredId = uuid` mới **chỉ khi** chưa có lịch cùng `deferredUntil`
  ± 250ms) → spawn (R7) → log → exit.
- Xoá lịch hoãn: trong `cmdKick`, `cmdStop`, `cmdStart` và ngay sau mỗi nudge thật (`lastNudgeAt` cập nhật).
- Không đổi thứ tự các lớp trong `cmdEvent` (audit → classify/auto-pause → maxCycles → cooldown);
  không đổi `noopPauseAfter`, `auditHold`, `shouldAutoResume`.

## 4. Non-goals

- Không đổi cooldown mặc định (60s) hay MIN (10s). Không introducing timer chung hay daemon.
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
| T6 | paused-by-owner / auditHold / status≠running khi đến giờ → tôn trọng | 0 send_text; log lý do đúng |
| T7 | `kick` xoá lịch hoãn | sau `event` trong cooldown → `kick` → state không còn `deferredUntil`; `deferred-nudge --id cũ` → 0 call |
| T8 | vượt cooldown → nudge ngay như cũ, không lên lịch | `lastNudgeAt = now - cooldown - 1000` → 1 send_text, state không có `deferredUntil` |

Suite hiện có (`loop-plugin`, `loop-audit`, `loop-status-op`, `devloop-docs`, `release-shape`) phải xanh.
Chỉ chạy `node --test test/<file>` — **không** chạy full suite.

## 6. Nghiệm thu sống (controller làm sau merge, trên main)

Scratch loop, không đụng loop dev-loop thật: `loop.json` mới (label `c23-verify`, `maxCycles: 3`,
`cooldownMs: 60000`, `noopPauseAfter: 0`) với prompt file một dòng: *"Trả lời đúng một từ: OK. Không làm gì khác."*
→ `start` → agent trả lời trong vài giây → log phải cho thấy chuỗi:
`nudge #1` → `nudge suppressed (cooldown 60000ms)` → `deferred nudge scheduled in ~5Ns` → (đến giờ)
`deferred nudge: firing` → `nudge #2` → … → `nudge #3` → `maxCycles 3 reached — loop done`.
Sau đó `stop` (đóng workspace). Loop dev-loop thật: `kick` một lần, quan sát log có `deferred nudge scheduled`.

## 7. Guardrail cho agent thực hiện

- Worktree riêng, branch từ `main`. KHÔNG push/tag/bump version/npm publish; KHÔNG sửa `AUTO.md`,
  systemd units, `scripts/`, bảng Backlog/Cycle Log (controller ghi lúc review).
- KHÔNG can thiệp pane/tab/workspace herdr của người dùng; KHÔNG chạy full suite.
- Test đỏ trước (T1→T8), rồi code, rồi xanh. Kết thúc bằng dòng `C23-DONE <pass>/<fail> <sha>`.
