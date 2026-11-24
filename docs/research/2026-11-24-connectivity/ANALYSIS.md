# Kết nối của gate — đo và kết luận (24/11/2026)

Câu hỏi: vì sao mỗi hành động từ xa tốn 1–3 giây, và gate có thể làm gì? Mọi số liệu dưới đây
đo trên gate production (bản ghim 0.13.2) hoặc trên một gate tạm dựng từ source của repo
(`probe/bench.mjs` + `probe/timing.py` — chạy lại được, xem cuối bài). Không có suy đoán nào
được ghi thay cho số đo; chỗ nào chỉ là giả thuyết thì ghi rõ.

## 1. Gate thật đang phục vụ thế nào (journal 26h, `herdgate.service`)

| Thiết bị | phiên SSH-leg | p50 | ≤5s | nhận xét |
|---|---|---|---|---|
| app mobile (Herdr app trên điện thoại) | 215 | **1.0s** | 81% | mỗi chạm = một kết nối |
| herdr-mobile **và** herdr-mobile-home-act (cùng một key) | 68 + 68 | 62s | 6% | đi **đôi 68/68** (±3s): mỗi lần attach mở 2 kết nối với 2 danh tính |
| DESKTOP-37QJAHC (cli) — Windows | 99 + 31 | 45 phút / 3.8h | ~30% | bridge dài ổn định; phần ngắn là ~30–40 lệnh một-shot/ngày |
| laptop-tui | 30 | 1.0s | 80% | một-shot |

551 phiên đóng / ~610 auth; 3 cặp Stopped→Started sạch trong cùng giây (restart tay khi triển khai), không crash.
WS ping 8s (`gateway.ts`, `heartbeatMs ?? 8_000`) — dưới ngưỡng idle 100s của Cloudflare, giữ được NAT 4G.

## 2. Chi phí theo chặng

| Chặng | Đo | Kết luận |
|---|---|---|
| HTTP tới gate, local | `curl 127.0.0.1:8833/healthz` ×3 | **1.2 ms** |
| Cùng request qua `https://gate.phuongnb.io.vn` (edge **SIN**) | ×4 | **0.37 / 1.04 / 1.57 / 2.66 s**; connect 0.05–1.09 s |
| Tunnel cloudflared 26h | journal `herdgate-tunnel` | 54 dòng lỗi, **7 lần đăng ký lại + 10 retry**, chủ yếu `QUIC … no recent network activity`, dồn vào 00–04h |

Tức là: gate xử lý trong 1 ms, nhưng mỗi kết nối **mới** phải trả 0.4–2.7 s cho chặng
điện thoại → Cloudflare SIN → máy nhà (hairpin: cả hai đầu ở Việt Nam, đi vòng Singapore),
và chặng này biến thiên 7 lần giữa các lần đo (mất gói/tắc trên ISP↔Cloudflare).

Số round-trip của một hành động một-shot qua đường hiện tại: WS (TCP + TLS 1.3 + upgrade) ≈ 3,
KEX ≈ 2, auth publickey với OpenSSH (`none` → hỏi key → ký) ≈ 3, mở channel + exec + trả lời ≈ 2
→ **~10 RTT**. Với RTT hiệu dụng 100–250 ms → 1–2.5 s, khớp p50 1–3 s quan sát được.

## 3. Chi phí phía gate tách khỏi mạng (loopback, median 8 lần)

| Biến thể | KEX | auth+channel+exec | exec→byte đầu | tổng |
|---|---|---|---|---|
| raw TCP, **trước** sửa | 59 ms | 53 ms | 98 ms | **219 ms** |
| raw TCP, **sau** sửa NoDelay | 59 ms | **12 ms** | 94 ms | **173 ms** |
| qua WS (`herdgate-via --tunnel`) | 10 ms | 7 ms | 66 ms | 179 ms (+ ~90 ms khởi động node của ProxyCommand mới thấy banner) |
| KEX ecdh-nistp256 / dh-group14 / curve25519; cipher chacha20 / aes128-gcm; hostkey ed25519 | 60–73 ms | — | — | **không khác nhau** |

Đã sửa (commit này): `src/cloud/sshd.ts` bật `TCP_NODELAY` trên socket của đường TCP.
ssh2 ghi mỗi gói SSH thành một `write()` nhỏ; với Nagle bật, gói thứ hai chờ ACK bị hoãn
~40 ms của client → mất 41 ms mỗi phiên (test `test/ssh-tcp-nodelay.test.ts` ghim hành vi).
Đường WS không cần sửa: `VirtualSshSocket` là Duplex thuần bộ nhớ.

**Đã sửa (cùng đợt) — host key sinh hỏng.** Khi đào flake `ssh leg: publickey auth … ECONNREFUSED
127.0.0.1:22` (comment trong `gateway.ts` đã ghi "seen ~1/3 full runs" và tin rằng đã sửa) thì tìm ra
gốc thật: `ssh2.utils.generateKeyPairSync("ed25519")` của ssh2 1.17.0 trả key **malformed ~0,3%**
(18/3000; `keygen.js` strip mọi byte 0x00 đầu tưởng là pad của BIT STRING, trong khi key ed25519
được phép bắt đầu bằng 0x00). `new Server()` ném lỗi → chân SSH là `null` → client rơi về port 22.
Ở production còn nặng hơn: key hỏng **đã được ghi ra đĩa** (`loadOrMintHostKey` ghi trước khi ai kịp
kiểm) nên mỗi lần khởi động đều lặp, còn healthz vẫn 200. Gate hiện tại không trúng — nhưng trên VPS
mới (Pha B) xác suất ~1/300 lần cài. Sửa ở đúng nơi key sinh ra: parse bằng chính parser của ssh2,
retry nếu hỏng (tối đa 8), không bao giờ ghi key chưa qua kiểm; key đã lưu mà không parse được thì
dừng với thông điệp "restore it from backup" kèm lý do. Test: `test/ssh-hostkey-mint.test.ts` (3 ca);
stress 600 lần sinh thật: 1 key hỏng bị bắt, 0 thất bại. Nhánh fallback PEM cũng lộ ra là code chết
(ssh2 không đọc pkcs8 ed25519) → bỏ, thay bằng lỗi rõ ràng.

Chưa sửa, đã hiểu: pha KEX trên raw TCP vẫn còn ~45 ms. ssh2 gửi KEXINIT của server ngay sau khi
đọc version string của client (`protocol/Protocol.js`, `kexinit(this)`), nên nó không mang ACK cho
KEXINIT của client; OpenSSH còn giữ Nagle trong lúc KEX (chỉ tắt khi vào phiên) nên `ECDH_INIT`
phải chờ ACK delayed. Chỉ ảnh hưởng đường raw TCP — hiện không client production nào dùng (tất cả
đi WS). Không làm mẹo cork/uncork cho 40 ms đó.

## 4. Hướng xử lý — theo thứ tự hiệu quả chia chi phí

1. **Đã làm — NoDelay ở đường TCP** (0 rủi ro, đo được) **và host key sinh hỏng** (mục 3). Có ý nghĩa thật khi có đường thẳng
   (LAN, VPS): client Windows có delayed-ACK 200 ms nên stall có thể tới 200 ms/lần.
2. **Danh tính kép của mobile TUI** (việc của chủ máy, 0 code): 68 lần attach × 2 kết nối.
   Hai device `herdr-mobile` và `herdr-mobile-home-act` dùng chung một key, cùng scope `act`.
   Nếu Herdr trên điện thoại giữ hai "máy" trỏ về cùng một gate → gộp lại còn một.
   Rủi ro: nếu một trong hai là hồ sơ LAN (home) có chủ đích thì phải giữ — cần chủ máy xác nhận.
3. **Ổn định tunnel — A/B `protocol: http2` so với QUIC** (ops, cần đồng ý vì restart tunnel
   ~10 s gián đoạn): chạy mỗi cấu hình 24 h, so số `Retrying`/`Registered`/lỗi. Rủi ro: http2 qua
   TCP cũng có thể tệ hơn trên đường mất gói — nên đo, không nên đoán.
4. **Bỏ hairpin = VPS Pha B** (`docs/plans/vps-cutover.md`): đây là hướng thật sự đổi kích cỡ.
   RTT hiệu dụng từ 100–250 ms xuống ước tính 20–40 ms (VPS trong nước) → thiết lập kết nối
   ~10 RTT từ 1–2.5 s xuống ~0.3–0.5 s. Hostname giữ nguyên, client không đổi. Rủi ro: VPS thành
   bề mặt công khai (gate đã fail-closed + rate limit), và chi phí hàng tháng.
5. **Đã loại bằng số liệu: tune KEX/cipher** — chênh ≤ 13 ms trên một thành phần chỉ chiếm
   ~1/3 tổng thời gian phía gate.
6. **Ngoài tầm gate**: Herdr app mở một kết nối mỗi hành động; `herdgate-via` phải khởi động node
   (~70 ms Unix, nhiều hơn trên Windows) cho mỗi lệnh — có thể thay bằng forwarder cục bộ thường
   trú, nhưng thêm một daemon phía client; chưa đáng.

## 5. Câu hỏi còn mở

- `herdr-mobile-home-act` là hồ sơ gì trên điện thoại (LAN hay trùng)?
- Có VPS chưa (Hà Nội/HCM) để làm Pha B?
- Cho phép chạy A/B tunnel http2 24 h?

---

## Tái lập phép đo

```sh
# 1. gate tạm (state, host key, port riêng; agent giả như test/ssh.test.ts)
HERDGATE_BENCH_ROOT=/tmp/hg-conn node docs/research/2026-11-24-connectivity/probe/bench.mjs &
# 2. chờ /tmp/hg-conn/params.json xuất hiện rồi:
HERDGATE_BENCH_ROOT=/tmp/hg-conn python3 docs/research/2026-11-24-connectivity/probe/timing.py
# 3. dừng: kill "$(cat /tmp/hg-conn/bench.pid)"
```

Số liệu production: `journalctl --user -u herdgate.service --since -26h` (dòng
`ssh: device … authenticated with key` / `disconnected` ghép đôi theo device để ra thời lượng phiên);
`curl -w '%{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}'` cho healthz;
`journalctl --user -u herdgate-tunnel` cho tunnel.
