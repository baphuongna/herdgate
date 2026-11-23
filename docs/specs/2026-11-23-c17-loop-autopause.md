# Spec C17 — Loop tự pause sau K no-op liên tiếp

Ngày: 2026-11-23 · Vòng: DEV-LOOP (worktree `c17`, branch `c17-loop-autopause`) ·
Chủ đề: vòng no-op vô hạn đốt ~13k token/vòng chỉ để đọc DEV-LOOP.md, lặp mỗi ~60s
vì `maxCycles 0` + giao thức cấm tự pause.

## Bối cảnh (bằng chứng)

- Backlog rỗng → mỗi vòng no-op là một turn pi (~13k token chỉ để đọc lại
  DEV-LOOP.md), chạy lại mỗi ~60s vô hạn: `maxCycles` mặc định 0 (không giới hạn)
  và AUTO.md cấm tự pause ("quyết định dừng là của owner") → phải có người pause tay.
- Quan sát thật 2026-11-23: 11:01→11:02 hai no-op liên tiếp, ai đó phải pause tay.
- Vòng no-op để lại dấu vết ĐO ĐƯỢC trong git: subject commit chứa "no-op"
  (quy ước Cycle Log: `no-op — backlog trống`). Đây là nguồn sự thật khách quan —
  không tin lời tự khai của agent.

## Tính năng

1. `loop.json` thêm tuỳ chọn:
   - `noopPauseAfter`: integer ≥ 0, mặc định **2**; `0` = tắt auto-pause.
   - `noopPattern`: string regex (JS), dài 1–120, mặc định `"no-op"`.
   - Validate fail-closed trong `validateConfig`, thông báo lỗi nêu rõ tên trường
     (như `cooldownMs`/`bootCommand` hiện có).
2. State thêm: `noopStreak` (integer, mặc định 0), `pausedBy` (`"auto" | "owner"`, vắng khi không pause).
3. Phân loại vòng trong `cmdEvent`, SAU khi settle được coi là hợp lệ
   (armed, status running, không paused) và TRƯỚC khi quyết định nudge —
   hàm riêng `classifyCycle(cfg, sinceMs, now)` → `"work" | "no-op" | "unknown"`:
   - `git -C cfg.cwd log --since=<ISO(sinceMs)> --until=<ISO(now)> --format=%s`
     qua `spawnSync` timeout 10s. `since = s.lastNudgeAt || s.startedAt`.
   - git lỗi / không phải repo / 0 commit trong cửa sổ → `"unknown"`: KHÔNG đổi
     `noopStreak`, KHÔNG pause — xử lý như cũ (nudge theo cooldown).
   - Có ≥1 commit và MỌI subject khớp `noopPattern` → `"no-op"` → `noopStreak += 1`.
   - Ngược lại → `"work"` → `noopStreak = 0`.
   - Chỉ đọc subject commit — không đọc file, không đoán từ nội dung agent.
4. Auto-pause: khi verdict `"no-op"` và `noopPauseAfter > 0` và
   `noopStreak >= noopPauseAfter`: `saveState({...s, paused: true, pausedBy: "auto",
   status: "running"})`, log `auto-pause: <streak> no-op cycles in a row — resume
   with the resume action`, KHÔNG nudge, exit 0.
5. `resume` và `start`: reset `noopStreak = 0`, xoá `pausedBy`. `pause` (owner):
   ghi `pausedBy: "owner"`.
6. `status` lộ thêm `noopStreak`, `pausedBy` (state) và `noopPauseAfter` (config).
7. Giữ hành vi cũ khi config không có trường mới — trừ việc **mặc định 2 là chủ ý
   "an toàn theo mặc định"** (safe by default): từ bản này loop KHÔNG có config
   cũng tự pause sau 2 no-op liên tiếp. Đây là thay đổi hành vi ĐÚNG CHỦ Ý:
   chuỗi no-op vô hạn là lỗi vận hành đã quan sát thật, không phải trạng thái
   trung tính cần bảo toàn.

## Tiêu chí nghiệm thu (đo được)

1. `node --test test/loop-plugin.test.ts` XANH tuyệt đối, gồm 6 test mới:
   config fail-closed (âm / lẻ / regex hỏng / >120); 2 no-op liên tiếp → pause
   + streak 2 + không nudge lần 2 + log `auto-pause`; no-op→work → streak 0
   + nudge; `noopPauseAfter: 0` → 3 no-op vẫn nudge; resume/pause/start state
   đúng; cwd không phải repo → unknown → nudge như cũ, streak nguyên vẹn.
2. Test ĐỎ đúng chỗ trước khi implement (mỗi test fail vì thiếu tính năng, không
   phải lỗi harness).
3. Docs: đúng 1 câu trong `docs/DEV-LOOP.md` mục "Tự vận hành" được thay.
4. Không bump version, không đụng toml manifest ngoài phạm vi.

## Thiết kế

- `classifyCycle` là hàm thuần trong `plugin/loop/server/index.mjs` (self-contained,
  chỉ dùng `node:child_process.spawnSync` đã có sẵn trong stdlib). Bounded:
  `timeout: 10_000`; git lỗi → `"unknown"` (fail-open về hành vi nudge cũ, vì
  không đọc được bằng chứng thì không được phạt theo đoán).
- Điểm chèn trong `cmdEvent`: sau các check `status !== "running"` và `paused`,
  trước check `maxCycles`/cooldown. Auto-pause chỉ đánh giá khi verdict là
  `"no-op"` (vòng vừa đẩy streak chạm ngưỡng) — nhờ đó `"unknown"` với streak cũ
  cao (config đổi ngưỡng) vẫn nudge như cũ, không pause oan.
- Streak phải SỐNG QUA các settle bị cooldown chặn: nhánh cooldown-suppressed
  giờ `saveState(s)` khi verdict ≠ unknown (trước đó nhánh này không ghi state).
- Nudge saveState dùng `{...s}` nên `noopStreak` mới chảy vào tự nhiên.
- `pausedBy` là bằng chứng ai pause: `"auto"` để owner biết loop tự dừng (resume
  là quyết định của owner — đúng tinh thần giao thức cũ, chỉ thêm van tự đóng
  khi vô ích), `"owner"` cho pause tay.

## Kế hoạch test (thêm vào `test/loop-plugin.test.ts`, harness `stubHerdr`/`run` sẵn có)

Repo tạm: `git init -q -b main` + `commit --allow-empty` với
`-c user.name=t -c user.email=t@t.t` (đã xác nhận `--allow-empty` chạy trên
unborn branch; `--since/--until` ISO filter đúng theo commit date). Cooldown
được "vượt" bằng cách đặt `lastNudgeAt` lùi 60s trong fixture (pattern có sẵn
trong test cooldown cũ — không sleep).

1. Config: `noopPauseAfter` -1 / 1.5, `noopPattern` "(" / 121 ký tự → `start`
   exit 2, stderr nhắc đúng trường, không đụng bridge; vắng mặt → status
   `config.noopPauseAfter === 2`.
2. Hai settle với commit no-op liên tiếp → settle #1 nudge + streak 1; settle #2:
   state `paused:true, pausedBy:"auto", noopStreak:2, status:"running"`,
   stub KHÔNG nhận `pane.send_text` lần 2, log có `auto-pause: 2 no-op cycles in a row`.
3. No-op rồi commit `feat(x): ...` → settle #2: streak về 0, có nudge, cycles 2.
4. `noopPauseAfter: 0` → 3 settle no-op liên tiếp vẫn nudge đủ 3, không pause.
5. `resume` → pausedBy xoá + streak 0; `pause` → pausedBy "owner"; `start` →
   state mới có streak 0, không pausedBy.
6. cwd không phải git repo → verdict "unknown" → nudge như cũ, `noopStreak`
   giữ nguyên giá trị cũ (fixture streak 5 chứng minh không bị đụng), không pause.

## Rủi ro

- **Mặc định 2 đổi hành vi loop đang chạy thật**: loop đang live không có
  `noopPauseAfter` trong loop.json sẽ tự pause ở lần thứ 2 no-op — ĐÚNG chủ ý,
  nhưng reviewer cần biết: resume là một action `resume`, không mất gì.
- Cửa sổ `since/until` theo commit date (giây): commit ngay ranh giới giây có
  thể rơi nhầm cửa sổ kề — ảnh hưởng tối đa 1 vòng, verdict tự sửa ở vòng kế.
- Vòng no-op KHÔNG commit gì (agent trả lời rỗng) → "unknown" → không đếm.
  Chấp nhận: quy ước no-op hiện có buộc 1 dòng Cycle Log = 1 commit có subject.
- `spawnSync git` thêm ~10-30ms mỗi settle — không đáng kể so với turn giây-phút.
- Regex từ owner (ReDoS?): pattern ≤120 ký tự chạy trên subject ngắn — mặt tấn
  công cực hẹp; `new RegExp` reject ở validate nếu cú pháp hỏng.

## Nghiệm thu (điền khi xong)

- **Red-first**: sau bước test-trước, `node --test test/loop-plugin.test.ts`
  → 21 pass / 5 fail, ĐỎ đúng chỗ: hai settle fail ở `noopStreak expected 1,
  actual 0` (chưa đếm), 3-no-op fail ở `expected 3, actual 0`, resume/start
  fail ở "resume clears pausedBy", config fail ở default chưa lộ trong status.
  Trung thực: test thứ 6 (cwd không phải repo → unknown → nudge như cũ) xanh
  SẴN cả trước lẫn sau implement — nó là regression guard cho hành vi cũ,
  không phải red-first.
- **Green**: sau implement, `node --test test/loop-plugin.test.ts` →
  **26 pass / 0 fail** (tuyệt đối, gồm 6 test C17 + 20 test cũ);
  `node --test test/loop-boot.test.ts` → 4 pass / 0 fail.
  Một vòng sửa test trong quá trình đỏ→xanh: lệnh `start` trong test E thiếu
  fixture config (harness xoá loop.json khi không truyền tuỳ chọn) — lỗi harness,
  không phải code plugin.
- Docs: đúng 1 câu trong `docs/DEV-LOOP.md` mục "Tự vận hành" đã thay
  (cấm tự-pause → tự pause sau 2 no-op + log `auto-pause` + resume của owner);
  `git diff main --stat` chỉ gồm spec + test + plugin/loop/server/index.mjs
  + DEV-LOOP.md.
- Verify sống: KHÔNG làm (ràng buộc vòng cấm restart service / can thiệp pane
  herdr) — đã nêu trong "Ghi chú cho reviewer"; suite targeted là bằng chứng
  của vòng này.

## Ghi chú cho reviewer

- Thay đổi hành vi mặc định (điểm 7 Tính năng) là chủ ý — đã nêu lý do ở trên.
- Nhánh cooldown-suppressed giờ có `saveState` khi streak đổi — trước đó nhánh
  này không ghi state; cần cho streak sống qua settle bị chặn, không đổi gì khác.
- Không đụng `plugin/loop/herdr-plugin.toml` (không bump version theo 2b),
  không đụng AUTO.md/service/scripts theo ràng buộc vòng.
- Verify sống (loop thật trên máy home) KHÔNG nằm trong phạm vi vòng này:
  ràng buộc cấm restart service / can thiệp pane herdr — controller quyết định
  lúc merge. Bằng chứng của vòng = suite targeted xanh + red-first đúng chỗ.
