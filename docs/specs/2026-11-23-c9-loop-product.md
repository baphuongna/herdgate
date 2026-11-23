# Spec C9 — THEME: Loop như tính năng shipped của herdgate (→ release theo 2b khi trọn)

Ngày: 2026-11-23 · Vòng: DEV-LOOP C9 · Trạng thái: queued (spec sẵn sàng)

## Bối cảnh

Chain vòng lặp herdr-native (C8 đang chạy trên nó) đang là experiment local
`experiments/devloop-plugin/` — ngoài shipped tree. Người dùng herdgate khác
cũng muốn: "chạy agent theo vòng lặp trong pane herdr, settle → tự tiếp,
nhìn thấy trong TUI, có phanh". Đó là một năng lực sản phẩm thật — dạng
"agent loop pane" chung (không hard-code DEV-LOOP của repo này).

## Thiết kế (plugin/loop/ — shipped như plugin/mirror)

**Cấu hình** `loop.json` (config dir, mode 0600):
```
{ v: 1, promptFile: "docs/DEV-LOOP/AUTO.md", cwd: "<abs>",
  label: "dev-loop", cooldownMs: 60000, breatherMs: 15000, maxCycles: 0 (0=∞) }
```

**Manifest**:
- `[[actions]]`: `start` (đọc loop.json → workspace `⚙ <label>` + tab +
  gõ `pi "$(cat <promptFile>)"` — python-built JSON, bài học escape),
  `stop` (đóng workspace theo label — ownership), `pause`/`resume` (cờ
  trong config), `status` (JSON: pane, trạng thái, số vòng, lần nudge cuối).
- `[[panes]]` `fleet`-style không cần — pane là pi agent thường.
- `[[events]]` `pane.agent_status_changed` + `pane.exited` → `loop-event.mjs`.

**Event hook shipped**:
- Match pane THEO registry (state file ghi pane do plugin tạo) — pane lạ im
  lặng (nguyên tắc không đụng tài sản user).
- settle (idle|done) → nudge "vòng kế" vào chính pane (rate-limit theo
  cooldownMs); `PAUSE` (cờ config) → im lặng; `pane.exited` → log chain
  broke + ghi status.
- maxCycles > 0 → dừng nudge khi đủ, status `done`.

**An toàn shipped** (mặc định tắt, opt-in từng máy):
- start chỉ chạy khi config hợp lệ (promptFile tồn tại, cwd tuyệt đối thuộc
  home người dùng); không prompt trực tiếp trong config (phải là file).
- Không npm-publish/tag từ loop (vẫn là trách nhiệm người).
- Log một dòng/vòng vào file state (không toast).

**Tests** (mirror-ops pattern):
- manifest rules (plugin.test.ts): ids không chấm, self-contained.
- loop-event unit: pane lạ im, settle nudge (herdr stub), PAUSE im,
  rate-limit, maxCycles dừng, exited → status.
- loop-pane start/stop qua bridge stub (workspace ownership theo label).
- release-shape: `plugin/loop/**` trong npm files + self-contained.

## Nghiệm thu
- Suite xanh; live: cấu hình trỏ về chính DEV-LOOP của repo này → thay
  experiment local bằng plugin shipped trên máy home (chain tiếp tục chạy
  trên bản shipped) — THE SAME loop builds its own product.
- READY-TO-RELEASE khi trọn (gộp theme lớn kế tiếp nếu có).
