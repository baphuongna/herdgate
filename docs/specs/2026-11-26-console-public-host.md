# Console public-host mode (S4-lite) — 26/11/2026

Mở rộng của `docs/specs/2026-11-25-local-web-console.md` (lát S4 rút gọn): cho phép **một** hostname công khai (Cloudflare tunnel) vào đúng Console service đang chạy local, thay vì đợi một đường web riêng qua Gate.

## Quyết định

- **Service vẫn chỉ nghe `127.0.0.1`.** Không mở port nào ra ngoài máy. cloudflared (đang chạy trên cùng máy, nối qua loopback) là cầu duy nhất ra Internet.
- **Opt-in qua cấu hình, mặc định tắt:** `HERDGATE_CONSOLE_PUBLIC_HOST=bom.phuongnb.io.vn`. Không đặt biến này → hành vi y như 0.15.1 (L1 thuần loopback, cấm mọi forwarding header).
- **Host được chấp nhận:** đúng hostname công khai (đã chuẩn hoá: hostname thường, không scheme/port/path — giá trị lạ fail closed lúc khởi tạo) **hoặc** cửa loopback `127.0.0.1:cổng` như cũ. Host khác → 403.
- **Header chuyển tiếp:** chế độ public chấp nhận đúng `X-Forwarded-For`, `X-Forwarded-Proto`, `CF-Connecting-IP` (những gì cloudflared/edge thật sự thêm vào khi nối từ loopback). Mọi header khác (`X-Forwarded-Host`, `Forwarded`, `X-Original-*`) vẫn 403 ở cả hai chế độ. Không bao giờ tin header chuyển tiếp để quyết định Host.
- **Origin cho POST:** loopback origin hoặc `https://<public host>`; khác → 403.
- **Budget theo địa chỉ client cho redeem (chỉ chế độ public):** 10 lần / 10 phút / IP (lấy từ `CF-Connecting-IP` do edge đặt — tin được vì service chỉ nhận kết nối từ loopback; fallback là hop **cuối** của `X-Forwarded-For`, do cloudflared của mình thêm, không bao giờ hop đầu do client đặt). Vượt → 429 `login_rate_limited`. Cửa loopback không áp budget (người cùng máy, cùng ranh giới OS).
- **Giữ nguyên toàn bộ phần còn lại:** mã login một lần 120 s / 5 lần sai / 5 mã mỗi phút; token RAM-only 30 phút idle / 8 giờ tuyệt đối; CSP `connect-src 'self'`; generation fence; tự kết thúc khi mất state; `stop` trung thực.
- TLS do Cloudflare chấm dứt (browser↔edge), edge↔cloudflared là tunnel mã hoá, cloudflared↔Console là HTTP trên loopback — cùng mô hình tin tưởng với Gate hiện tại (`HERDGATE_TRUSTED_PROXY=1` + `CF-Connecting-IP`).
- Cổng cố định cho ingress: `HERDGATE_CONSOLE_PORT` (OS cấp mặc định 0). CLI `console start` truyền qua cả `HERDGATE_CONSOLE_PUBLIC_HOST` lẫn `HERDGATE_CONSOLE_PORT`.

## Mô hình đe doạ và giới hạn (ghi thẳng)

- Ai có mã (được in trên máy chủ) mới vào được; brute-force 256-bit là vô nghĩa, và 5 lần sai thì mã chết.
- **DoS khả thi từ xa:** kẻ tấn công có thể giết mã vừa cấp (5 lần sai) và đốt budget IP — chặn được *việc đăng nhập mới*, không đọc được gì, phiên đang sống không ảnh hưởng. Chấp nhận như Gate.
- Cloudflare thấy nội dung TLS (giống PWA/Gate cùng tunnel hiện tại). Muốn chặt thêm: xếp Cloudflare Access (zero-trust) phía trước hostname này — không bắt buộc ở lát này.
- Loopback door vẫn mở song song (người dùng cùng máy).

## Test

`test/local-web-console-service.test.ts` (4 test mới, 12/12):

1. Public host + loopback đều 200; Host sai/đổi port 403; header cloudflared được dung, `X-Forwarded-Host`/`X-Original-*`/`Forwarded` 403.
2. Redeem: origin chéo 403; loopback origin vẫn 200; 10 lần sai trong budget → 401; lần 11 → 429; IP khác budget riêng; hết cửa sổ 10 phút → mở lại.
3. Giá trị `publicHost` lạ (scheme, port, path, "localhost", rỗng) fail closed lúc khởi tạo.
4. `HERDGATE_CONSOLE_PORT` mở cổng cố định.

Đo trên deployment thật (tunnel Cloudflare thật, hostname `bom.phuongnb.io.vn`): xem `docs/reviews/2026-11-25-local-web-console-real-run.md` mục cập nhật 26/11.
