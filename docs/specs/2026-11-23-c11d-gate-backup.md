# Spec C11d — Gate resilience: backup thật, restore được chứng minh, runbook

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #4) · Chủ đề: Pha A của VPS
cutover plan (docs/plans/vps-cutover.md) — đúng phần KHÔNG cần user

## Lý do chọn theme (bằng chứng)

- `docs/plans/vps-cutover.md` ghi thẳng: "gate chạy từ source trên máy
  nhà = điểm đơn. Máy nhà chết → mất tất cả". Pha A của plan (diễn tập +
  runbook + backup) **không cần VPS, không cần user** — nhưng chưa ai
  làm: hôm nay `~/.local/state/herdgate/` chỉ có MỘT bản backup thủ công
  `backup-pre-0.9.35` (3 ngày cũ, trước cả các bản 0.10/0.11).
- Mất `ssh_host_ed25519.json` = mọi phone/laptop phải re-pair toàn bộ;
  mất `state.json` = mất rooms/devices/vapid push identity. Chi phí
  backup gần bằng 0, chi phí mất bằng mất fleet.
- Owner chưa publish loop-windows-boot (npm latest = 0.11.0) — các nợ
  kia vẫn không trả được; đây là việc giá trị cao duy nhất trong tầm tay
  không đụng tài sản user.

## Phạm vi (tôn trọng ranh giới "việc user")

- LÀM: script backup (repo) + test + runbook `docs/runbooks/` + **diễn
  tập restore trong sandbox** (gate thứ 2 từ source, port scratch,
  `HERDGATE_NO_SSH=1`, `HERDGATE_NO_PUSH=1`, state scratch) — không
  đụng gate thật (8833), không đụng service nào, không cài timer.
- KHÔNG làm: cutover thật (Pha B — root key/DNS của user), không cài
  cron/timer (guardrail systemd; runbook chỉ kèm ĐOẠN template để owner
  tự 2 lệnh), không dựng gate từ Cloud archive 0.9.38 (đúng nghĩa chữ
  của plan là của owner; diễn tập source→source chứng minh cơ chế
  backup/restore, leg 0.9.38→0.11.0 migration ghi nợ owner).

## Thiết kế

### scripts/gate-backup.mjs

```
node scripts/gate-backup.mjs [--state <state.json>] [--out <dir>]
                             [--keep N] [--verify <archive>]
```

- `--state` (mặc định `~/.local/state/herdgate/state.json`): file state
  của gate; các artifact CÙNG CHỖ được gom theo danh sách cố định của
  plan: `state.json` (bắt buộc), `ssh_host_ed25519.json`,
  `vapid.json`, `attachments/`, `pi-receipts/`, `tasks/` (tùy chọn,
  thiếu thì ghi absent trong manifest).
- Archive = thư mục `<out>/gate-<ISO8601>/`: copy nguyên file/thư mục +
  `manifest.json` (created, source, từng entry: sha256, size, mode,
  present/absent). Giữ mode nhạy cảm (host key 0600).
- `--keep N` (mặc định 14): prune archive cũ nhất vượt N.
- `--verify <archive>`: tính lại sha256 mọi entry, khớp manifest → rc 0;
  lệch một byte → rc 1 + tên file. Backup không verify được là rác.
- Không in nội dung file (chỉ tên + hash + size). rc 2 cho lỗi cấu hình.

### docs/runbooks/gate-migration.md

Runbook đúng plan: stop → flush journal → backup (script) → verify →
restore → start → verify (`/healthz`, `/v1/devices` đếm rooms), kèm:
cảnh báo "herdr remote client BỎ CUỘC sau 5 lần retry (upstream) —
restart gate phải báo/reconnect tay" (ghi chú vận hành hôm nay trong
plan), flip-back 5 phút về gate nhà, và ĐOẠN systemd timer template
(backup hằng ngày) để owner tự cài — loop không cài.

## Nghiệm thu (đo được)

1. Unit (tmp dir): backup đủ 6 entry + manifest sha256 đúng; mode 0600
   giữ nguyên cho host key; retention --keep 2 giữa 3 archive prune 1
   cũ nhất; `--verify` OK bản tốt, rc 1 khi đổi 1 byte; thiếu state.json
   → rc 2.
2. Full suite xanh tuyệt đối (baseline 340/0 + test mới).
3. **Live diễn tập trên máy nhà**: backup state THẬT bằng script →
   `--verify` xanh → restore vào scratch (`/tmp` không phải — phải under
   home? scratch state không phải config loop; dùng `~/.cache/hg-c11d/`)
   → start gate scratch từ source (port 8899, NO_SSH, NO_PUSH, account
   token truyền qua env lấy từ systemd, KHÔNG in) → `/healthz` 200 →
   `/v1/devices?room=<id>` trả đúng số device của room thật (chứng minh
   state restore SỐNG ở tầng API) → stop gate scratch → dọn scratch.
   Gate thật + token không in ra bất kỳ đâu.
4. Cycle Log ghi trung thực: leg 0.9.38-archive + cài timer + Pha B
   vẫn là của owner.

## Kế hoạch test

- Mới `test/gate-backup.test.ts` (spawn script như CLI, tmp dirs).
- Live: script bash từng bước, mỗi bước verify trước khi sang bước.

## Rủi ro

- Backup chứa host key riêng tư → archive phải nằm trong vùng tin cậy
  của owner (mặc định `~/.local/state/herdgate/backups`, mode chặt);
  runbook cảnh báo không đẩy backup lên cloud công cộng.
- Gate scratch đọc state copy có thể GHI lại scratch state (nội bộ) —
  scratch nằm dưới `~/.cache`, dọn sạch sau.
- Nếu gate scratch cần env ngoài dự kiến (fail-fast lúc start) → dừng
  diễn tập, ghi chưa đạt, không cố vượt.
