# Spec C10 — Loop nudge arming: thưởng cho công việc, không thưởng cho lúc sinh

Ngày: 2026-11-23 · Vòng: DEV-LOOP C10 · Chủ đề: sửa đúng tính năng shipped C9

## Lý do chọn theme này (jobs-rich vẫn parked)

- **Bằng chứng sống, hôm nay, trên máy này**: log loop shipped
  `~/.local/state/herdr/plugins/dev.herdgate.loop/loop.log`:
  `03:54:08.268 start: pane wE:p3` → `03:54:10.036 nudge #1 rc=ok` —
  **nudge sau 1.77s**, khi agent chưa thể có một turn nào. Phiên pi đang
  chạy nhận nudge "Loop — vòng kế…" là **input thứ hai ngay lúc sinh**
  (trước khi làm bất cứ việc gì) — quan sát trực tiếp trong chính session
  viết spec này.
- Nhân giống hại: plugin loop là tính năng generic ("any prompt file, any
  cwd"), nhưng nudge mặc định mang văn bản dev-loop bị tiêm vào MỌI task
  ~2s sau start — user chạy "viết docs X" cũng nhận "chạy đúng MỘT vòng
  nữa rồi dừng".
- Jobs/results phong phú vẫn là giá trị phỏng đoán (không có nhu cầu quan
  sát mới từ C7/C8) — giữ parked, ghi lại trung thực.

## Nguyên nhân (đã khảo sát code + log)

- `cmdEvent` coi mọi `pane.agent_status_changed` có `agent_status ∈
  {idle, done}` của pane mình là **settle sau công việc**. Nhưng herdr cũng
  phát trạng thái `idle` quanh lúc pane sinh ra / agent mới attach (chưa
  từng working). Plugin không phân biệt "idle vì chưa bắt đầu" với "idle vì
  vừa xong turn".
- Cooldown không cứu được: `lastNudgeAt = 0` ở start ⇒ `Date.now() - 0`
  luôn vượt cooldown ⇒ nudge đầu tiên được phép bắn ngay.

## Thiết kế

Nguyên tắc: **một settle chỉ đáng nudge khi pane đã từng làm việc** trong
lần chạy này (`armed`). Thêm `state.armed`:

1. `start` ghi `armed: false` (mỗi lần chạy mới sinh đều phải tự chứng minh).
2. Event `working` hoặc `blocked` trên pane mình khi đang chưa armed ⇒
   `armed: true` + log một dòng `armed` (quan sát là vô hại, kể cả khi
   paused/done — flag chỉ là quan sát).
3. Settle (`idle|done`) khi **chưa** armed ⇒ bỏ qua, không đụng bridge,
   log `settle ignored — no work seen` (vận hành trung thực).
4. **Armed giữ nguyên suốt lần chạy** (không reset sau mỗi nudge): event
   `working` bị lỡ (herdr restart giữa turn) không được làm chết chuỗi —
   idle re-emit sau restart vẫn nudge như hành vi cũ (an toàn hơn đứng im).
5. **Grandfather nâng cấp tại chỗ**: state không có trường `armed` (do
   build trước C10 ghi) + `status: running` ⇒ coi như armed — loop đang
   chạy thật trên máy này nâng cấp qua event spawn kế tiếp (code đọc từ
   disk mỗi lần) mà chuỗi không đứt.
6. `pane.exited` ⇒ chain-broke như cũ, bất kể armed (pane chết lúc sinh
   vẫn là đứt chuỗi, trung thực).
7. `status` expose `state.armed` để người vận hành thấy giai đoạn sống.

## Nghiệm thu (đo được)

1. Unit: state `armed:false` + event `idle` ⇒ 0 bridge call, `cycles`
   không đổi, log có "no work".
2. Unit: `working` (0 call, chỉ arm) rồi `idle` ⇒ đúng 1 nudge, cycles 1.
3. Unit: grandfather — state kiểu cũ (không `armed`, running) + `idle` ⇒
   vẫn nudge (tính liên tục nâng cấp).
4. Unit: `start` ghi `armed:false`; `status` in ra `armed`.
5. Full suite xanh tuyệt đối (baseline 330/0 + test mới).
6. **Live probe** qua plugin shipped + herdr thật + pi thật (workspace riêng
   `⚙ c10probe`, maxCycles=1, nudgeText riêng rẻ token): KHÔNG nudge trong
   10s đầu sau start (code cũ nudge ở ~2s); có dòng `armed` khi pi bắt đầu
   làm; `nudge #1` chỉ sau settle thật; đạt cap ⇒ `done`; `stop` dọn sạch
   workspace; mọi dấu vết trong loop.log.

## Kế hoạch test

- Sửa/ thêm trong `test/loop-plugin.test.ts` (harness stub bridge sẵn):
  birth-settle im lặng; arm-qua-working rồi nudge; grandfather; start ghi
  armed; status expose armed. Test settle cũ giữ nguyên state kiểu cũ = tự
  thành test grandfather.
- Live probe: script env scratch (`HERDR_PLUGIN_CONFIG_DIR/STATE_DIR` trỏ
  thư mục probe), KHÔNG đụng state loop thật đang chạy cycle này; đo bằng
  timestamp trong loop.log của probe.

## Rủi ro

- herdr không phát `working` cho turn siêu ngắn ⇒ không arm ⇒ nhịn settle
  (an toàn: im lặng, không spam) — probe live sẽ chứng minh có working.
- State thật của loop đang chạy không có `armed` — phủ bởi grandfather +
  unit test 3; chuỗi cycle kế là chứng minh sống.
