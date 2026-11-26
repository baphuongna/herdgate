# Nghiệm thu thật Local Web Console (L1) — 25–26/11/2026

Đối chiếu theo `docs/specs/2026-11-25-local-web-console.md`. Mọi số dưới đây là đo trực tiếp, không số do agent tự báo. Môi trường: Herdr 0.9.5 (protocol 22) chạy **session cô lập** (HOME/XDG riêng, socket riêng, không phải phiên người dùng), service Console thật (`bin/console-server.mjs`), bundle thật build trong bwrap (`node console/tools/build-console.mjs`, Bun 1.4.4, 99 file allowlist), headless Chrome qua CDP.

## 1. Vòng review delegation (2 agent Herdr, 5 vòng)

| Vòng | Agent | Commit | Kết quả reviewer đo lại |
|---|---|---|---|
| S1–S3 | `hg-console-rpc` / `hg-console-web` | `a9a260f`+`c852400`+`768325b` / `33afcde`+`30d6e77` | test xanh nhưng test thật lộ 7 lỗi (mục 2) |
| S4 | rpc `867604a` / web `3625456` | typecheck 0 mới / CSP meta, favicon, chọn pane bằng phím | còn: bẫy Tab trong textarea xterm; 4 service mồ côi trên máy |
| S5 | rpc `2607d45` / web `23fa78b` | tự kết thúc khi mất state, `stop` trung thực | đạt — đóng vòng |

Reviewer tự thêm `test/local-web-console-csp-contract.test.ts` (`d0da293`) ràng buộc CSP của service (nhánh runtime) với CSP của build (nhánh web) — hai nhánh không test được nhau.

## 2. Lỗi tìm thấy trên hệ thống thật (test xanh vẫn hụt)

1. App sập sau login (`paneLocks.ts` đọc settings thiếu trường) — settings shim chỉ có 4 trường.
2. Mất màu/đậm/gạch chân: CSP `style-src 'self'` chặn DOM renderer của xterm 6 (1 màu, 24 vi phạm CSP).
3. Pane thứ hai trong tab không chọn được (`solo` + `lastViewedPane` shim).
4. `cols/rows: null` → "?×?", wrap sai.
5. `console/.gitignore` khiến npm pack bỏ `console/dist` (0 file Console).
6. `console status` nói `runtime-unavailable` ngay sau start.
7. Asset hash không `immutable`; `/notices/*` 404 (MIME); meta CSP chứa `frame-ancestors` (Chrome log error mỗi lần load); `/favicon.ico` 404; bẫy bàn phím Tab; service mồ côi khi tiến trình chủ chết.

Tất cả đã sửa; mục 2.5 là của reviewer trên nhánh tích hợp.

## 3. Số đo cuối (bundle `index-9x0Tyog_.js`, 819.606 B JS + 185.852 B CSS, 99 file, 3 lần build sha256 giống nhau)

**Geometry — đối chiếu `stty size` trong pane shell (ground truth, client TUI 50×160):**

| Layout | `stty size` thật | API trả | Đạt |
|---|---|---|---|
| đơn pane | 133×49 | cols 133, rows 49 | ✓ |
| split phải 67×49 | 64×47 | cols 64, rows 47 | ✓ |
| split xuống 134×25 | 131×23 | cols 131, rows 23 | ✓ |
| zoomed | 131×47 | cols 131, rows 47 | ✓ |
| detach, rect stale 40×120 | 64×47 thật | `cols: null` (không đoán) | ✓ trung thực |

**Trình duyệt (Chrome headless mới, profile mới):** login 210 ms, frame đầu 209 ms, frame ~1/s; 10 màu chữ + 9 loại class fg/bg trên pane demo, 0 vi phạm CSP; 12/12 pane chọn được bằng chuột; Enter/Space chọn pane, Tab đi qua 10 điểm dừng (không còn "Terminal input"); 0 request ngoài origin loopback; 0 ghi storage (localStorage/sessionStorage/cookie rỗng, 0 sự kiện DOMStorage); gõ phím thật vào mirror → chỉ GET, phiên Herdr không đổi (5 ws/9 tab/12 pane trước–sau); "New terminal" disabled; nút pane-actions 0×0, click không mở gì; outage → "Runtime unavailable", ẩn mirror; Herdr chạy lại → tự phục hồi ~2,3 s không reload/login; Lock + reload → phải login lại.

**API (fail-closed):** thiếu/sai token 401, sai Host 403, thiếu Origin 403, sai/thiếu generation 409, pane lạ 404, route act/ovis 404, code một lần (dùng lại 401), token chết sau logout, không serve `manifest.json`, traversal 404; asset hash `Cache-Control: immutable`; notices 200 đúng MIME, file lạ 404.

**Vòng đời:** `start` → ready ngay; `stop` 185 ms và chỉ in "stopped" khi pid thoát thật; xoá state dir → service tự thoát 839 ms; service để nguyên sống sót (không false positive). Sau suite: 0 tiến trình `console-server` sót.

**Suite/typecheck trên `main` sau merge `6518801`:** 540 test, 526 pass, 0 fail, 14 skip (nhánh cần `TEST_HERDR_BIN`/`TEST_PI_BIN`); tsc 209 diagnostic = mức nền trước thay đổi (0 mới); `npm pack` 255 file, `console/` 100 file (96 asset + 2 notices + manifest… không ship vendor/src/tools).

## 4. Còn treo / giới hạn

- **Windows launcher Console vẫn khóa có chủ ý** (`console_windows_launcher_blocked`) — chưa nghiệm thu trên Herdr App thật.
- **Mirror trên viewport điện thoại (390 px) rộng hơn pane thật** — cuộn ngang trong khung mirror; chấp nhận cho L1 chỉ đọc.
- **Flake có sẵn** `test/loop-status-op.test.ts` (timeout 8 s khi chạy `--test-concurrency=4`), có từ trước khi merge Console.
- **Thử trên phiên Herdr thật (26/11, sau merge `6518801`):** `console start` với socket thật `~/.config/herdr/herdr.sock`, Chrome có giao diện trên display người dùng: login 233 ms, frame đầu 235 ms, mirror pane thật `w8:p1` đúng geometry thật **253×78**, 7 workspace thật đều chọn được, 0 request ngoài origin, 0 ghi storage, 0 vi phạm CSP; ô mã login `type="text"` + `webkitTextSecurity: disc` (không còn trường password → password manager không liên quan). Ảnh: `/tmp/hg-console-review/real/real-{desktop,phone}.png`.

## 5. Public-host mode (S4-lite) — đo trên tunnel thật 26/11 (release 0.15.2)

Cấu hình: `herdgate-console.service` (systemd user, ghim npm 0.15.2) nghe `127.0.0.1:41280`, `HERDGATE_CONSOLE_PUBLIC_HOST=bom.phuongnb.io.vn`; cloudflared ingress `bom.phuongnb.io.vn → http://127.0.0.1:41280`, thêm bằng SIGHUP (hot-reload, không gián đoạn chân gate/ssh — đo ngay sau HUP: gate healthz 200, banner sshd loopback, laptop auth OK).

Đo qua edge Cloudflare thật (curl, IP công khai thật của người đo):

- Shell `https://bom.phuongnb.io.vn/` 200; `manifest.json` 404; traversal `/%2e%2e/package.json` 400 (chuẩn hoá ở edge); API không token 401; sai code 401.
- Mã thật (in tại máy chủ, redeem kèm Origin `https://bom.phuongnb.io.vn`) → 200, token 64 hex, `expiresInMs` 30 phút; session đọc 7 workspace/7 pane; `pane w2:pEG` 253×78, ANSI thật, generation fence hoạt động.
- **Budget theo IP:** lượt redeem 4–10 của IP → 401; lượt 11 → **429** `login_rate_limited` (đúng 10/10 phút/IP).
- Cửa loopback song song vẫn 200; Host lạ 403; `X-Forwarded-Host` giả 403; `X-Forwarded-For`/`X-Forwarded-Proto` (cloudflared) được dung.
- Trình duyệt qua HTTPS: login form ~230 ms khi đã ấm (lần đầu qua TLS mới 26 s), ô mã `type=text` + `webkitTextSecurity: disc`.
- **Cloudflare chèn beacon `static.cloudflareinsights.com`** vào trang; CSP `script-src 'self'` của Console **chặn** nó (1 vi phạm CSP được ghi, beacon không tải). Muốn hết dòng log này: tắt Web Analytics/auto-inject trên zone. Đây là hành vi của zone, không phải của Console.
- Đã ghi nhận một điểm công cụ: `/tmp/hg-conn/laptop-leg.sh` (probe shell thô kiểu Linux) bị whitelist của publisher Windows từ chối "unsupported Herdr probe" — script cũ, không phải chân SSH hỏng; đường api-bridge chạy lệnh thật trên laptop ngay lúc đó (LEG-OK trong pane).
