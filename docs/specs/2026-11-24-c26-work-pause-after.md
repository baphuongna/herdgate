# Spec C26 — `workPauseAfter`: trần chuỗi work liên tiếp

Ngày: 2026-11-24 · Vòng: DEV-LOOP (C26, mục queued do owner queue khi kick
01:29Z) · Chủ đề: C17 chỉ cap chuỗi **no-op**; chuỗi **work** tự sinh việc
chạy mãi không trần chi phí — một loop tự biện minh (mỗi vòng để lại commit)
sẽ không bao giờ dừng.

## Bối cảnh

- C17: `noopStreak` + `noopPauseAfter` (mặc định 2) — no-op liên tiếp →
  auto-pause `pausedBy:"auto"`. Work reset `noopStreak`; `unknown` không đụng.
- Bằng chứng sống 18:10:29Z: auto-pause no-op chạy đúng; owner `kick` 01:29:23
  (UTC 18:29) sau khi queue C26 — chuỗi work giờ có thể chạy không giới hạn
  vì `maxCycles: 0` trong loop.json thật.
- Đối xứng thiết kế: work là trục còn thiếu của cùng một cơ chế — "chi phí có
  trần ở CẢ HAI phía im lặng lẫn bận rộn".

## Tính năng

1. **State**: `workStreak` (số nguyên, song song `noopStreak`).
   - classify `"work"` → `workStreak += 1`, `noopStreak = 0`.
   - classify `"no-op"` → `noopStreak += 1`, `workStreak = 0` (chiều về mặt
     đối xứng còn thiếu ở C17).
   - `"unknown"` → không đụng streak nào (không phạt bằng đoán).
2. **Auto-pause work**: khi verdict `"work"` và `workPauseAfter > 0` và
   `workStreak >= workPauseAfter` → `paused:true, pausedBy:"auto"`,
   `status:"running"` giữ nguyên (resume tái kích cùng loop), stop reason
   `"work-auto-pause"`, log `auto-pause: N work cycles in a row — resume with
   the resume action`. Đặt TRƯỚC maxCycles (đối xứng tuyệt đối với nhánh
   no-op của C17).
3. **Config**: `workPauseAfter` — integer ≥ 0, fail-closed như `noopPauseAfter`.
   **Mặc định 0 = tắt** — lý do: nâng cấp tại chỗ không được đổi hành vi các
   loop đang chạy (bài học C10: grandfather); trần là lựa chọn của người đặt
   chuỗi, không phải mặc định toàn cầu.
4. **Reset `workStreak`** ở mọi nơi `noopStreak` được reset: `start`, `kick`,
   `resume` (owner), auto-resume C20 (watched file đổi).
5. **status** lộ `workStreak` (state) + `workPauseAfter` (config). Op
   `loop.status` (C21) trả nguyên state → tự thấy field mới, không đổi op.
6. **Áp dụng dev-loop thật**: thêm `workPauseAfter: 12` vào
   `~/.config/herdr/plugins/config/dev.herdgate.loop/loop.json` (config của
   plugin, không phải systemd unit — backlog yêu cầu chọn default có lý lẽ và
   áp cho dev-loop thật). Bản hook đang chạy (pre-C26) bỏ qua key lạ → an
   toàn nâng cấp tại chỗ; trần sống hiệu lực từ event kế đọc code mới.

## Không làm

- KHÔNG đụng `noopPauseAfter`/`noopPattern`/`maxCycles`/`auditHold`/C23
  deferred-nudge — chỉ thêm trục song song.
- KHÔNG đổi `classifyCycle` (chứng nhân git giữ nguyên).
- KHÔNG sửa systemd unit nào, KHÔNG restart service, KHÔNG đụng pane user.

## Test (đỏ trước) — `test/loop-plugin.test.ts`, harness C17 tái sử dụng

- **T1** validate: `workPauseAfter` −1 / 1.5 → exit 2, lỗi nêu tên field;
  mặc định 0 hiển thị trong `status.config`; state lộ `workStreak`.
- **T2**: N=2 work settles liên tiếp → settle 1 vẫn nudge (streak 1 < 2),
  settle 2 auto-pause `pausedBy:"auto"`, KHÔNG nudge thêm, log đúng dòng.
- **T3**: no-op xen giữa reset `workStreak` (work–work–no-op–work: streak
  1→2→0→1, không pause).
- **T4**: `workPauseAfter: 0` (mặc định) — chuỗi work dài không bao giờ pause.
- **T5**: `resume` reset `workStreak`; `kick` reset; `start` reset.
- **T6**: `unknown` (git hỏng) không đụng `workStreak` lẫn `noopStreak`.

## Nghiệm thu (đo được)

1. T1–T6 đỏ đúng chỗ trước implement; targeted xanh; full suite xanh tuyệt
   đối (baseline 400/0).
2. Config thật của dev-loop có `workPauseAfter: 12` sau vòng này (đọc lại để
   chứng minh); `status` action (read-only, không đụng pane) vẫn trả
   `config.ok` với file mới.
3. Live bằng chứng trần work chỉ đến khi chuỗi thật đụng 12 work liên tiếp —
   ghi trung thực trong Cycle Log (giống C15: guard được chứng minh unit,
   chờ bằng chứng production).

## Rủi ro

- Chuỗi thật đang chạy (kick 01:29): settle kế của CHÍNH vòng này đọc code
  mới — `workStreak` khởi đầu undefined → `Number(undefined)||0` = 0, an toàn
  (bài học grandfather giữ nguyên).
- 12 work cycles ~ nửa ngày SDD liên tiếp — nếu owner muốn dài hơn, sửa 1 key.
