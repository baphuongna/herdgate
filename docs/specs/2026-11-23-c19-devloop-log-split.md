# Spec C19 — tách Cycle Log theo tháng (DEV-LOOP.md chỉ giữ 10 vòng gần nhất)

Ngày: 2026-11-23 · Vòng: DEV-LOOP C19 · Nhánh: `c19-devloop-log-split` (worktree `c19`) · Chủ đề: vòng dev-loop đọc lại toàn bộ `docs/DEV-LOOP.md` mỗi lần — file đã 47.7KB ≈ 13k token/vòng và phình dần theo mỗi dòng Cycle Log 1–2KB.

## Bối cảnh

- Agent loop đọc TOÀN BỘ `docs/DEV-LOOP.md` mỗi vòng. File 47.774 bytes hiện tại
  (`wc -c`), phần lớn là bảng Cycle Log: 31 dòng dữ liệu (10 dòng đầu C1–C10/C8 +
  21 dòng cuối từ v0.11.0 tới `verify`), phần lớn mỗi dòng 1–2KB.
- Cần: file chính = nguyên tắc + backlog + 10 vòng gần nhất + Bài học; lịch sử
  đầy đủ lưu theo tháng trong `docs/DEV-LOOP/LOG-YYYY-MM.md`.
- Lưu ý cấu trúc file: bảng Cycle Log KHÔNG liền khối — 10 dòng đầu nằm ngay sau
  `## Cycle Log` (dòng C8 nằm sau một dòng trống, giữ nguyên thứ tự), rồi tới các
  mục `### Bài học`, rồi 21 dòng cuối nằm cuối file. Tách phải giữ thứ tự nguyên
  văn, KHÔNG sắp xếp lại, KHÔNG đổi nội dung dòng.
- Trạng thái git lúc viết spec: nhánh này đứng trên commit `673a551`; `main` đã
  đi trước 4 commit (C16 spec/feat/close + no-op) và thêm **2 dòng Cycle Log**
  (dòng `C16` và `no-op` sau C16) vào cuối bảng trên main — không có trong base
  của nhánh này.

## Tính năng

1. **File mới `docs/DEV-LOOP/LOG-2026-11.md`**: tiêu đề ngắn giải thích (lịch sử
   đầy đủ các vòng — `docs/DEV-LOOP.md` chỉ giữ 10 vòng gần nhất; file lịch sử
   theo tháng `LOG-YYYY-MM.md`, chỉ đọc khi cần bối cảnh), rồi header bảng + TOÀN
   BỘ dòng Cycle Log TRỪ 10 dòng cuối, theo thứ tự nguyên văn hiện có (C1…C10,
   dòng trống, C8, rồi v0.11.0…v0.12.0 — 21 dòng dữ liệu).
2. **`docs/DEV-LOOP.md`**: đổi tiêu đề `## Cycle Log` → `## Cycle Log (10 vòng
   gần nhất — lịch sử đầy đủ: docs/DEV-LOOP/LOG-2026-11.md)`; mục đó giữ đúng 10
   dòng cuối của bảng (C12, C13, đính chính, no-op, no-op, C14, v0.13.0, C15,
   v0.13.1, verify — nguyên văn, đúng thứ tự). Header + separator bảng giữ ở cả
   hai file. Backlog và các mục `### Bài học` KHÔNG đổi.
3. **`docs/DEV-LOOP/AUTO.md` bước 1**: thêm ĐÚNG MỘT câu — "Lịch sử các vòng cũ
   nằm ở `docs/DEV-LOOP/LOG-2026-11.md` — chỉ đọc khi cần bối cảnh." (KHÔNG sửa
   gì khác ở AUTO.md — ngoại lệ được giao việc cho phép đúng 1 câu này).

## Tiêu chí nghiệm thu (đo được)

1. `wc -c docs/DEV-LOOP.md` ≤ 20000 (trước: 47.774).
2. Không mất, không nhân đôi dòng: số dòng khớp
   `grep -cE '^\| (C[0-9]|no-op|v0|đính|verify)'` trên file pre-split (base
   nhánh = blob `673a551:docs/DEV-LOOP.md`) là **46** = 15 dòng Backlog (giữ
   nguyên ở DEV-LOOP.md) + 21 dòng ở LOG-2026-11.md + 10 dòng ở DEV-LOOP.md.
   Dòng dữ liệu ở (LOG ++ phần Cycle Log của DEV-LOOP.md) khớp TỪNG BYTE, ĐÚNG
   THỨ TỰ với 31 dòng bảng Cycle Log của file pre-split; 10 dòng giữ lại đúng là
   10 dòng CUỐI của bảng pre-split.
3. Mỗi dòng bảng ở cả hai file có số dấu `|` bằng dòng header
   (`| Vòng | Ngày | Kết quả | Commit/Tag | Ghi chú nghiệm thu |` — 6 dấu `|`).
4. `docs/DEV-LOOP/AUTO.md` bước 1 chứa đúng câu trỏ tới archive; phần còn lại
   của AUTO.md byte-identical.
5. Diff so với merge-base main chỉ chạm 4 file: 2 spec (commit riêng) +
   `docs/DEV-LOOP.md` + `docs/DEV-LOOP/LOG-2026-11.md` + `docs/DEV-LOOP/AUTO.md`
   — tức 3 file docs DEV-LOOP như giao việc. Test đỏ→xanh:
   `node --test test/c19-devloop-log-split.test.ts`.

## Thiết kế

- Tách bằng script python đọc file, cắt theo dòng, ghép lại — KHÔNG gõ lại nội
  dung dòng nào (chống sai sót từng byte). Tiêu chí chọn dòng: sau `## Cycle Log`
  mọi dòng khớp ROW-regex là dòng dữ liệu; khối 1 = 10 dòng + 1 dòng trống trước
  C8; khối 2 = 21 dòng cuối file. LOG = khối 1 + 11 dòng đầu khối 2; DEV giữ 10
  dòng cuối khối 2 đặt vào mục Cycle Log (sau header/separator, trước Bài học);
  khối 21-dòng ở EOF xoá khỏi DEV.
- Test (`test/c19-devloop-log-split.test.ts`, node --test) đọc blob pre-split
  qua `git merge-base main HEAD` + `git show <base>:docs/DEV-LOOP.md` để đối
  chiếu độc lập với file đang sửa — bất khả hơn tự so với chính nó.

## Kế hoạch test

- Viết test TRƯỚC → chạy → đỏ đúng chỗ (LOG chưa tồn tại, tiêu đề chưa đổi, số
  dòng DEV Cycle Log = 31 ≠ 10, AUTO.md chưa có câu archive).
- Implement → chạy lại → xanh tuyệt đối (6 test).
- Không chạy full suite (ràng buộc vòng C19; docs-only, controller chạy lúc merge).

## Rủi ro

- Sai sót copy từng byte khi tách → giảm thiểu bằng script cắt/giữ nguyên văn +
  test đối chiếu blob git.
- `main` di chuyển (thêm 2 dòng C16) trước khi merge → controller xử lý lúc
  merge (đã ghi Ghi chú cho reviewer); split của nhánh này theo base `673a551`.
- Đếm `grep` trên main lúc merge sẽ là 48 (không phải 46 như task dự đoán) —
  expected, không phải mất dòng.

## Nghiệm thu (điền lúc xong)

- (chưa chạy — điền sau khi xanh)

## Ghi chú cho reviewer

- Khi merge, `main` có thể có thêm dòng Cycle Log mới (C16 và no-op sau C16 đã
  có trên main từ trước khi nhánh này bắt đầu) — controller chèn 2 dòng đó vào
  `## Cycle Log (10 vòng gần nhất …)` của DEV-LOOP.md (hoặc LOG file tuỳ tuổi)
  lúc merge; nhánh này không tự rebase/merge theo ràng buộc giao việc.
- `git diff main --stat` hai-chấm sẽ hiện cả reverse của 4 commit C16 trên main
  (không phải lỗi của nhánh này) — đo bằng `git diff main...HEAD --stat`
  (three-dot, so với merge-base) mới đúng.
- `git status --short` sẽ luôn hiện `?? node_modules` (symlink sang main repo,
  có sẵn từ đầu worktree — không phải rác của vòng này).
