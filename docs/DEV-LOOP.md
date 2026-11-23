# DEV-LOOP — vòng phát triển tự vận hành của herdgate

> Protocol vận hành: mỗi vòng là **một chu kỳ SDD trọn vẹn**, không làm tạm bợ.
> Trạng thái vòng nằm ở cuối file này — lượt làm việc nào cũng đọc file này
> trước, nối đúng chỗ dừng, không hỏi lại user.

## Nguyên tắc bất biến (mọi vòng đều chịu ràng buộc)

1. **SDD đủ bước**: spec (acceptance rõ ràng) → design (đụng wire thì nêu
   frame-budget) → tasks → **test trước (red)** → implement (green) → full
   suite → **verify sống trên máy thật** → commit nhỏ, mesage thật →
   release/tag chỉ khi vòng đó có chủ đề release → cập nhật Cycle Log.
2. **Gate rules**: `read` không ghi; `act` cần `allowAct`; `unknown`
   fail-closed. Mọi op reply phải vừa khung `maxPayload` 256KiB
   (wire-budget shrink loop là mặc định cho mọi op trả dữ liệu lớn).
2b. **Chính sách release (chỉnh sau phản hồi user 2026-11-23)**: KHÔNG bump
   version theo từng vòng nhỏ. Mỗi vòng vẫn commit + test + verify sống, nhưng
   version/npm/laptop-update chỉ chạy khi (a) trọn một **chủ đề lớn** đủ giá trị
   người-dùng (ghi trong Cycle Log là theme nào), hoặc (b) user yêu cầu, hoặc
   (c) hotfix bảo mật/sự cố đang cháy production. Cỡ vòng cũng vậy: gộp các
   việc nhỏ liên quan thành một theme (1 vòng = 1 chủ đề dùng được, không phải
   1 regex).
3. **Self-contained**: `plugin/server` + `plugin/mirror` không import ra
   ngoài shipped tree (`test/release-shape.test.ts` canh).
4. **Không đụng tài sản user**: pane/tab/workspace của user không thuộc
   sở hữu plugin (ownership-by-label `M:<paneId>`, workspace `🏠 <room>`).
5. **Không in owner token**; probe device phải revoke + dọn sau verify.
6. **Trung thực nghiệm thu**: ghi nhận cả cái không đạt; "chưa đạt" được
   ghi vào log thay vì bị bỏ qua.
7. Test đầy đủ: `TEST_PI_BIN=$(which pi) TEST_HERDR_BIN=$(which herdr) npm test`
   (baseline tại lúc viết: **299 pass / 0 fail**).

## Protocol một vòng (10 bước)

1. Đọc Cycle Log cuối → xác định vòng tiếp theo trong Backlog (không hỏi user).
2. Viết spec `docs/specs/<ngày>-c<N>-<tên>.md`: bối cảnh, tính năng, tiêu chí
   nghiệm thu (đo được), thiết kế, kế hoạch test, rủi ro.
3. Sinh thay đổi backlog nếu spec làm lộ điều mới.
4. **Test trước**: viết test mới, chạy targeted → xác nhận red đúng chỗ.
5. Implement tối thiểu theo spec.
6. Targeted green → full suite xanh tuyệt đối.
7. Verify sống: home (source, restart service đúng vai) và/hoặc laptop
   (npm, qua drive script — `HG_VERIFY` chỉ cho lệnh ngắn, update dùng
   `HG_WAIT=75` + pre-clean `.setup`).
8. Commit (docs/impl tách commit), bump version + tag + npm publish nếu vòng
   có release; chờ `dist-tags.latest` flip rồi mới drive update từ xa.
9. Dọn rác probe (device revoke, temp file), cập nhật Cycle Log (đạt/chưa đạt).
10. Nếu còn giờ trong lượt: mở vòng sau từ bước 1. Dừng chỉ khi user báo dừng.

## Backlog (xếp hạng bởi PM — giá trị/ngày, rủi ro giảm dần)

| # | Vòng | Chủ đề | Giá trị | Trạng thái |
|---|------|--------|---------|------------|
| C1 | v0.9.43 | **Operability pack**: setup-tui idempotent với `.setup` mồ côi; publisher gửi version thật (bỏ hard-code 0.9.38) + gate lưu `hostInfo` + PWA roster hiển thị; mirror `[[startup]]` one-shot reconcile opt-in (`mirror autostart on/off`) | Cao (vết đứt vận hành đã gặp thật: EEXIST giữa update; không biết máy nào chạy bản nào; watch phải gọi tay) | 🔄 đang chạy |
| C2 | sau C1 | **Predictive echo enable path**: harness thu evidence typing (pane thử nghiệm riêng, không đụng pane user), auto-enable khi đủ 2 confirm như thiết kế predict.mjs; dashboard trạng thái echo | Trung bình–cao (UX typing mirror) | queued |
| C3 | sau C2 | **Security pass STRIDE** trên toàn bộ surface mới (fleet.detail, term.send/keys, file.*, review.*, mirror device identity, push payload) — findings → fix ngay trong vòng nếu nhỏ | Cao (surface mới chưa được audit) | queued |
| C4 | sau C3 | **Cadence thích ứng** (5s cố định → backoff khi yên tĩnh, burst khi settle) + sysmon khi herdr lộ `pid` | Trung bình | queued (sysmon blocked) |
| C5 | nhu cầu | **EXCAVATION chọn lọc** (collie harness grammars, 5 repo Rust) — chỉ đào khi vòng trước sinh nhu cầu thật | Tham khảo | parked |
| — | blocked | VPS cutover (việc user — `docs/plans/vps-cutover.md`); herdr > 0.9.5 lộ pid | — | blocked |

## Cycle Log

| Vòng | Ngày | Kết quả | Commit/Tag | Ghi chú nghiệm thu |
|------|------|---------|------------|--------------------|
| C1 | 2026-11-22 | ✅ xong — v0.9.43 + hotfix v0.9.44 | `f4a86ad` (feat) → tag v0.9.43 → fix staged package.json → tag v0.9.44 | Suite 303/0 (7 test mới/mở rộng). Live: home+laptop roster host.version 0.9.44 thật; laptop update 2 lần qua drive (`herdgate update` — tự học: `herdgate setup update` không tồn tại, chết an toàn ở check). Bug sống bắt thêm: staged release thiếu package.json → pkgVersion "unknown" → fix + test. askFleetOnce retry khi busy (throttle 1/2s đụng thật giữa pane và startup). Probe 5 device đã revoke |
| C2 | 2026-11-23 | ✅ xong — v0.9.45 | feat echo + tag v0.9.45 | Suite 306/0 (4 test mới). **Live evidence**: scratch pane + tmux + device act tạm qua gate thật — header `off 0/2 → 1/2 → on` sau 2 batch gõ, lệnh gõ chạy thật trên pane gốc; dọn sạch sau (tmux, tab, revoke, temp cfg). Cốt lõi: flush hỏi frame ngay trong throttle 1/s (AskScheduler) + grace 900ms cho kiến trúc poll — grace LAN 150ms của port khiến echo không bao giờ bật được qua WAN |
| C3 | 2026-11-23 | ✅ xong — review + fix F1, v0.9.46 | review `e034a54` + fix + tag v0.9.46 | STRIDE pass surface mới (docs/reviews/2026-11-23-c3-stride.md): **F1 Medium** — term.list/fleet.detail trả panes không giới hạn → tab storm ~2500 pane tự giết socket publisher (cùng lớp bug Part 7) → **fix cap 200 + {panesCapped,total}** (suite 307/0, test tab-storm 301 pane); F2/F3 Low ghi nhận chấp nhận; F4 (pane.focus không match `wG:p1`) → backlog C4. Live: home publisher restart nạp cap, fleet.detail probe xanh rồi revoke sạch; laptop 0.9.46 |
| C4 | 2026-11-23 | ✅ xong — v0.9.47 (bump cuối theo kiểu cũ) | feat + tag v0.9.47 | Suite 310/0 (4 test mới). Adaptive cadence (busy/changed=5s, quiet ×1.5→60s, timer chain — log `adaptive→60000ms`, chain sống >60s live); pane.focus nhận `wG:p1`; attachment.list cap 200; invariant tripwire. Từ C5 áp dụng chính sách release 2b |
| C5 | kế tiếp | 🔄 **THEME LỚN: Fleet control từ PWA** — tab.create/tab.close (ownership: chỉ tab do phone tạo trong session), pane.focus đã sẵn, terminal live pane chọn; act gate chặt; KHÔNG release giữa chừng — chốt 0.10.0 khi trọn theme | — | spec đầu vòng; nhỏ lẻ không thành vòng riêng nữa |

### Bài học C1 (nuôi vòng sau)
- Drive laptop: lệnh đúng là `herdgate update` (không phải `setup update`); flow transaction của setup-tui chết an toàn ở bước `check` trước khi đụng publisher — đã chứng minh trên máy thật.
- `$env:...` trong HG_CMD bị bash local expand — escape `\$` hoặc dùng single-quote quanh lệnh PS.
- Staged release giờ có package.json — mọi helper đọc metadata bản build đều theo đường đó.

### Bài học C2
- Port desktop sang kiến trúc poll phải soát lại mọi hằng số thời gian: grace 150ms tính cho RTT cục bộ thành "luôn contradiction" qua WAN — tham số hoá + bằng chứng sống mới đủ tin.
- Evidence là sản phẩm: header trust meter (`off 1/2`) khiến trạng thái tin cậy quan sát được, không phải đoán.

### Bài học C3
- Review read-only tách commit với fix — audit trail giữ được "tôi thấy gì" trước "tôi đổi gì".
- Lớp bug "reply tự giết socket publisher" lặp lại lần 3 (file.read → giờ panes) — mọi op trả danh sách phải có cap mặc định; cân nhắc invariant test chung ở C5.

### Bài học C4 (phản hồi user)
- Version không phải tiến độ: 5 bump/ngày là nhiễu (npm flip chờ 2-3 phút mỗi lần, laptop update mỗi lần). Release theo chủ đề người-dùng, việc nhỏ nằm gọn trong theme.
- Vòng nhỏ chỉ hợp lệ khi nó là bước NHỎ trong chủ đề lớn (như C3 review là bước của chủ đề ổn định).
