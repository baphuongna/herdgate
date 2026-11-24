# Đánh giá hiệu năng sâu — Herdgate (24/11/2026, 23:30–23:55)

Phép đo lặp lại ở hai thời điểm trong ngày để thấy độ biến thiên; mọi con số dưới đây có mốc giờ.
Tài liệu nối tiếp `ANALYSIS.md` (đo 24/11 ban ngày). Không có số nào trong đây là suy luận từ mã
nguồn: mã nguồn chỉ được đọc để xác nhận cơ chế sau khi đo.

## 1. Kết luận điều hành

1. **Gate không phải nút thắt.** 86 MB RSS, 21 s CPU trong 4 h 03 phút, 28 socket; healthz loopback
   1,2 ms; chi phí phía gate cho một phiên SSH qua WS 179 ms kể cả KEX (`ANALYSIS.md` mục 3).
2. **Nút thắt là đường truyền ra quốc tế rồi quay lại.** Nhà ↔ edge Cloudflare (HKG) 47 ms một chặng;
   mỗi request đi **hai chặng** (client → edge → tunnel → nhà). RTT ổn định 150 ms lúc vắng, tới
   915 ms lúc 20:00. Nội địa cùng ISP: 9–11 ms một chặng.
3. **Cải thiện lớn nhất chỉ đến khi bỏ hairpin**: VPS tại Việt Nam (Pha B, runbook đã sẵn) hoặc đường
   thẳng IPv6 (đã có thiết kế, đang hỏng). Tinh chỉnh phần mềm gate không đổi được số này.
4. **Cải thiện nhỏ đo được ngay, không đổi code**: `ControlMaster` cho alias SSH — lần gọi sau từ
   1,98 s xuống **0,40 s** (≈5×, đo cùng lúc 23:5x; riêng lúc 20:2x một lần gọi mới tốn 2,2–5,0 s).
5. Phát hiện kèm theo: (a) script so sánh A/B tunnel hỏng từ lúc viết — đã sửa, đối chiếu khớp số
   đếm tay; (b) DDNS `ssh.phuongnb.io.vn` không chạy (thiếu token), bản ghi trỏ sang máy khác;
   (c) SSH-leg lắng nghe `*:2299` trong khi nhà có IPv6 công cộng — **chưa kiểm được từ ngoài**.

## 2. Ngân sách độ trễ đo được

| Pha | 20:1x (tối) | 23:41 (khuya) | Cách đo |
|---|---|---|---|
| DNS / TCP / TLS xong / TTFB healthz | — | 1–19 / 44–70 / 93–131 / 259–388 ms | curl + `https.request`, 8 lần mỗi loại |
| Request đầu tiên (kết nối mới) | 1 259 ms | 333–392 ms | `fetch()` trong một tiến trình mới |
| WS hello, kết nối mới — p50 / p90 / max | 1 140 / 1 777 / 2 765 | 485 / 730 / 811 | 20 và 15 mẫu, `stab.mjs` |
| RTT ổn định trên một kết nối — p50 / p90 / max | 182 / 421 / 915 | 144–156 / 163–171 / 265–272 | 14 request giữ mở, `rtt.mjs` |
| Alias SSH tới laptop, gọi mới | 2,24–5,04 s (p50 3,07) | 1,98 s | 10 mẫu, probe chỉ đọc |
| Alias SSH, `ControlMaster` còn giữ | — | **0,40–0,42 s** | 5 mẫu |
| Round-trip thuần qua master (mở kênh + exec + laptop trả lời) | — | 376–389 ms | 5 mẫu |
| `herdgate-via.mjs --check` (node khởi động + WS + banner) | — | 0,57–0,79 s | 3 lần |

Độ trễ theo giờ: dữ liệu 7 ngày của tunnel **không** cho thấy mẫu theo giờ — đỉnh lỗi tập trung ở
một ngày 21/11 (13:50, 14:05, 23:07, 23:21) chứ không lặp lại hằng ngày. Hai thời điểm đo ở trên
chỉ nói được "20:00 tệ hơn 23:41 trong ngày 24/11", chưa thành quy luật.

## 3. Thời gian đi đâu

```
client ──47ms──▶ edge HKG/SIN ──47ms──▶ cloudflared (nhà) ──loopback──▶ gate
                                              ▲                              │
                                              └──────── 150 ms RTT ◀─────────┘
gate ──WS──▶ publisher laptop: laptop ──▶ edge ──▶ tunnel ──▶ gate  ≈ 100 ms một chiều
```

- TCP connect từ nhà: `fpt.vn` 8–76 ms (p50 9), `vnpt.vn` 9–16 (p50 11), edge Cloudflare v6 40–49
  (p50 48), `google.com` 46–51 (p50 47). ICMP bị lọc ở tất cả các đích nên chỉ đo được bằng TCP.
- Một phiên SSH mới tốn ~10 RTT (`ANALYSIS.md` mục 2) → với RTT hiệu dụng 150–400 ms là 1,5–4 s,
  khớp số đo 2–5 s. `ControlMaster` trả trước phần lớn số RTT đó → mỗi lần gọi còn ~380 ms.
- Kỳ vọng cho đường không hairpin (tính từ chi phí chặng đã đo, **chưa đo**): VPS trong nước →
  round-trip thiết bị ↔ laptop ≈ 2×(10–40) + 2×(10–40) = **40–160 ms** (nay ~380); bắt tay
  50–120 ms (nay 300–1 300 ms). Đường thẳng IPv6 tới máy nhà → thiết bị ↔ agent nhà ≈ 20–80 ms.

## 4. Tunnel: baseline thật sau khi phân loại (7 ngày QUIC, chuẩn hoá /24h)

| Dòng journal | /24h | Bản chất |
|---|---|---|
| ` ERR ` tổng | 103,0 | |
| └ `context canceled` | 66,9 | client huỷ request — lành tính |
| └ `Unable to reach the origin` | 10,0 | gate đang restart — tự gây |
| ` WRN ` tổng | 19,9 | |
| └ `no recent network activity` | 9,1 | **mạng thật** |
| └ `Retrying connection` | 8,9 | **mạng thật** |
| `handshake did not complete` | 2,4 | phía client |

Tín hiệu mạng thật của tunnel ≈ **9 lần nối lại/ngày**. Con số "~101 ERR/24h" dùng làm baseline A/B
gồm 2/3 nhiễu lành tính; verdict A/B ngày 25/11 phải đọc theo bảng phân loại này.

Edge phía nhà đăng ký: **HKG 52 lần, SIN 4 lần** trong 7 ngày. http2 (4,1 h đầu, không phải verdict):
2 lần nối lại thật (22:02, 23:30), 0 lần "no recent network activity".

## 5. Những chỗ đã đủ tốt — không nên đụng

- **Keepalive có phán quyết hai đầu**: gate ping 8 s, không pong là terminate (`gateway.ts:365`);
  agent 25 s × 3 chu kỳ im lặng = 75 s, backoff 1–30 s có jitter.
- **Framing**: JSON + base64 cho dữ liệu SSH; nén WS mặc định của `ws`. Chi phí < 1 ms mỗi thông
  điệp, bỏ qua so với 150 ms mạng.
- **PWA**: brotli ở edge (app.js 149 KB → 43 KB), service worker precache shell; `no-store` chỉ tốn
  lại 51 KB khi cache SW chưa có. Cold load 5 file, 330–450 ms mỗi file khi tải tuần tự.
- **KEX/cipher/hostkey**: đã đo, không khác nhau (`ANALYSIS.md` mục 3).
- **Laptop sau cập nhật 0.13.3**: 3,6 h, 0 lần rớt (baseline 10,6 lần/ngày → kỳ vọng 1,6 lần trong
  3,6 h; 0 lần là tin tốt nhưng chưa có ý nghĩa thống kê). Hẹn số 6 h và 24 h trong
  `~/.local/state/herdgate/laptop-stab/after.txt`.

## 6. Kế hoạch cải tiến — xếp theo tác dụng đo được / chi phí / rủi ro

### Tầng 0 — không đổi code, áp dụng ngay

1. **`ControlMaster` cho alias SSH** (tác dụng: 5×; rủi ro thấp). Thêm vào `~/.ssh/config`:
   ```
   Host herdgate-laptop
       ControlMaster auto
       ControlPath ~/.ssh/cm-%C
       ControlPersist 10m
   ```
   Master là một `ssh` nền giữ một tiến trình `herdgate-via.mjs` (58 MB RSS, đo) tối đa 10 phút idle. Mất
   mạng: `ServerAliveInterval 10 × CountMax 2` đã có trong alias → master chết trong 20 s, lần gọi
   sau tự lập lại. Xoá tay: `ssh -O exit herdgate-laptop`.
   Nghiệm thu: 5 lần gọi liên tiếp ≤ 0,6 s; journal gate không thêm "disconnected".
2. Đã làm trong buổi này: sửa `compare.sh` (3 lỗi: trừ datetime naive/aware; `date -d "… -7 days"`
   đọc `-7` là múi giờ; đếm cả nhiễu restart), viết `laptop-stab/stats.py`.

### Tầng 1 — code nhỏ, chỉ làm khi có số đo bảo chứng

3. **`herdgate-via.mjs` giữ kết nối ấm** (tác dụng: −0,5–1,0 s mỗi lần gọi lạnh; chi phí vừa).
   Một listener unix-socket duy trì 1–2 WS đã bắt tay sẵn tới gate. Chỉ đáng làm nếu alias được
   gọi dày; `ControlMaster` đã lấy phần lớn lợi ích.
4. **App shell: `no-store` → `no-cache` + ETag/304** (tác dụng: −51 KB khi mở lại; thấp).
5. **Agent keepalive 25 s → 10 s trên laptop di động** (tác dụng: phát hiện kết nối chết 75 → 30 s;
   chi phí 6 ping/phút). Chỉ làm nếu `after.txt` 24 h còn có lần rớt > 60 s.

### Tầng 2 — thay đổi kích cỡ duy nhất cho độ trễ

6. **VPS tại Việt Nam (Pha B)** — `docs/runbooks/vps-cutover.md`. Bỏ hairpin cho mọi client, không
   phụ thuộc giờ, gate không còn phụ thuộc mạng nhà. Chi phí: thuê VPS + vận hành gate thứ hai
   (backup, migration đã diễn tập). Nghiệm thu: `probe/bench.mjs` từ điện thoại và từ nhà: healthz
   mới < 200 ms, RTT ổn định < 60 ms; journal không `minted`; host key `SHA256:OCMQlB…`.
7. **Đường thẳng IPv6 cho SSH-leg (Herdr TUI)** — thiết kế ở `DEPLOY.md:167`. Điều kiện: token
   Cloudflare cho `herdgate-ddns`; `ufw`/router cho inbound TCP 2299 qua IPv6; client có IPv6;
   chấp nhận SSH-leg không còn sau Cloudflare. Đã từng cho là retired (thiếu token) — cần chủ
   trương lại. Việc đầu tiên, mất 2 phút: từ điện thoại bật 4G/5G chạy
   `nc -6 -v -z 2402:800:61cd:a69f:683c:5b16:989c:41a0 2299` để biết router có chặn inbound không.

Không đề xuất: chỉnh KEX/cipher (đã loại), HTTP/3 cho WS (Cloudflare không dùng cho WS), Argo
(trả phí, không bỏ hairpin), tối ưu CPU gate (không có vấn đề để tối ưu).

## 7. Chưa đo được

- Phía điện thoại (độ trễ radio) và journal phía laptop (alias chỉ cho phép lệnh template).
- IPv6 inbound từ ngoài: `check-host.net` từ chối mọi dạng IPv6; ufw đang `active`, không đọc được
  rule không có sudo. Nếu cổng 2299 đang mở ra Internet thì đó là việc của đợt security-review,
  không phải hiệu năng.
- Nguyên nhân 4 đợt bùng nổ 21/11 (hàng chục request huỷ cùng phút): không khớp giờ restart gate
  (10:45, 23:35), mtime các script probe là ngày 22/11 — chưa quy được cho ai.
- A/B tunnel: verdict sau 25/11 19:42, đọc bằng `sh ~/.local/state/herdgate/tunnel-ab/compare.sh`.

## 8. Các tuyên bố trước đây đã sửa trong buổi này

| Đã nói | Đúng là | Vì sao sai |
|---|---|---|
| Laptop rớt "~7,7 lần/ngày" | **10,6 lần/ngày** | chia cho cửa sổ yêu cầu 168 h trong khi laptop chỉ quan sát được 122,6 h |
| Edge phía nhà "4 lần HKG, 4 lần SIN (7 ngày)" | **52 HKG, 4 SIN** | số 4/4 là của một ngày |
| "Cao điểm buổi tối tắc đường quốc tế" | **chưa chứng minh** | 7 ngày log không có mẫu theo giờ; chỉ có 2 thời điểm đo |
| "`compare.sh` sẵn sàng cho verdict" | **hỏng, đã sửa** | mới chỉ kiểm cú pháp (`sh -n`), chưa chạy đầu-cuối |

## Tái lập phép đo

Script ở `/tmp/hg-conn/` (không thuộc repo): `stab.mjs` (WS hello public), `rtt.mjs` (RTT giữ mở),
`nodeconn.mjs` (phân rã bắt tay phía Node), `winprobe.mjs` (probe chỉ đọc tới publisher Windows),
`laptop-leg.sh`. Lưu ý locale `vi_VN`: dấu phẩy thập phân làm awk/mawk đọc `1,259` thành 1 — mọi
pipeline đo phải `export LC_ALL=C` hoặc `tr ',' '.'`.
