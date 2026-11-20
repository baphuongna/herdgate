# Pi request receipt — thử nghiệm local

Đã thử với Pi **1.5.2**. Extension nằm ngoài thư mục tự nạp và ngoài gói npm/ZIP;
không có lệnh cài, không bật integration hoặc mở API. Chỉ dùng ở **pane thử**.

## Thử trong một phiên mới

Tại checkout Herdgate trên **máy chạy Pi đích**, mở một Pi TUI mới:

```sh
pi --no-extensions --no-session --no-tools -e ./experiments/pi-receipt/observer.js
```

`--no-extensions` tắt tự nạp, nhưng vẫn nạp đường dẫn `-e` chỉ định.
`--no-session` không lưu transcript và `--no-tools` tắt tool; khi bạn gửi prompt,
Pi vẫn dùng **model đã chọn**. Nếu muốn kiểm tra hoàn toàn không gọi model thật,
dùng probe offline ở cuối trang.

1. Khi Pi rảnh, gõ `/herdgate-arm`. Pi hiển thị JSON có `id`, `marker` và thời hạn 10 phút.
2. Dán **cả hai dòng** dưới đây vào editor Pi rồi nhấn Enter một lần. Lấy đúng
   `marker` vừa xuất, không gửi riêng dòng đầu và không gõ dấu ngoặc góc:

   ```text
   [herdr-request:<id>]
   Chỉ trả lời OK, không thao tác gì khác.
   ```

3. Trong **chính pane Pi đó**, gõ `/herdgate-receipt <id>`. Hai lệnh slash chỉ
   hiển thị metadata; không tự gửi prompt cho model. Không gửi lại chỉ vì `unknown`.

| Trạng thái | Bằng chứng |
|---|---|
| `armed` | Có intent; observer chưa xác nhận user entry. Không có nghĩa là chưa gửi. |
| `received` | Đã thấy user entry đúng marker ở `turn_end`; chưa có kết luận settle. |
| `replied` | Pi đã settle; reply cuối có text và khớp nhánh/request. Không có nghĩa task thành công. |
| `failed` / `canceled` | Lỗi/truncation cuối hoặc Pi báo abort, với request vẫn đối chiếu được. |
| `unknown` | Không đủ chứng cứ: hết hạn, input chen vào, đổi nhánh, runtime khác, context không hỗ trợ hoặc receipt không còn giữ. |

Một intent mỗi Pi runtime, không khóa đường nhập tay. Receipt đã kết thúc được ghi vào
journal JSONL **riêng theo workspace** (mặc định
`$XDG_STATE_HOME/herdgate/pi-receipts/<hash-cwd>/receipts.jsonl`; đặt
`HERDGATE_PI_RECEIPT_DIR` để đổi chỗ), mode 0600, chỉ chứa ID/trạng thái/lý do/entry
ID và session ID — không có prompt, answer hay đường dẫn transcript. Journal giữ
vài trăm mục mới nhất rồi tự nén; `/reload`, đổi session hay khởi động lại Pi vẫn
đọc lại được receipt đã lưu, còn intent chưa kết thúc bị ghi `unknown/runtime_changed`.
Hai Pi cùng workspace dùng chung lịch sử; xóa thư mục state là xóa lịch sử; journal
hỏng thì observer trả `unknown` và tắt journal, không làm Pi lỗi. Nếu chỉ mất kết nối
TUI mà process Pi vẫn chạy, có thể hỏi lại trong cùng pane sau khi kết nối lại; test
qua Gate loopback xác nhận trường hợp này khi chỉ client bị ngắt. Không coi marker
là xác thực nguồn gửi.

## Kiểm tra offline

```sh
node --test test/pi-receipt.test.ts
node docs/herdr-skills/probes/pi-settlement.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
```

Probe SDK dùng provider giả và Pi 1.5.2, không dùng profile người dùng.

### Push khi agent chạy xong (`receipt.push`) — theo subscription, học từ Paseo

Khi `HERDGATE_PI_RECEIPTS=1`, publisher theo dõi journal (fs.watch + sweep định kỳ) và
đẩy `{op:"receipt.push", ...publicReceipt}` **chỉ tới thiết bị đã đăng ký watch cho đúng
request ID** ngay khi receipt chốt — không broadcast cả room. Subscription là **bền**:
ghi trong `watch.json` cạnh journal, sống qua restart của publisher và qua mất kết nối
của thiết bị; thiết bị reconnect sẽ được **phát lại push chưa ACK**. Chỉ `receipt.ack`
(từ thiết bị đăng ký) mới retire intent; hết hạn (mặc định 10 phút) thì tự dọn.

- Đăng ký: frame `{op:"receipt.watch", id, wantBody?, ttlMs?}` → trả `{op:"receipt.watched", pending:true}`
  hoặc kèm receipt hiện tại nếu đã chốt (chống race). Read scope đủ.
- ACK sau khi controller đã xử lý/lưu báo cáo: `{op:"receipt.ack", id}` → `{op:"receipt.acked", retired}`.

CLI tự làm trọn gói này — tra một lần, nếu chưa chốt thì đăng ký watch, chờ push
(tải body nếu `--body`, lưu file nếu `--out`) rồi ACK:

```sh
node experiments/pi-receipt/query.mjs --gate ... --device d --secret s --id <uuid> \
  --wait --body --out /path/to/new-report.md
```

MCP `herdgate_receipt_wait {id, timeoutSeconds}` cũng đăng ký watch, chờ push rồi ACK.
Lưu ý: chỉ **settle** được đẩy; trạng thái trung gian vẫn in-memory; baseline khi publisher
khởi động không phát lại receipt cũ — chỉ subscription chưa ACK mới được replay.

### Lưu và lấy nội dung báo cáo (`receipt.body`)

Journal và push chỉ chứa metadata. Muốn lấy **reply cuối**, gõ
`/herdgate-arm --body` và kiểm tra JSON báo `retainBody: true` trước khi gửi. Chỉ
request này được phép ghi reply khi `replied` vào `<base>/<scope>/responses/<id>.md`
(0600). Không cần chỉnh env hay khởi động lại Pi để chọn lưu theo request.
`HERDGATE_PI_RECEIPT_BODY=0` trong tiến trình Pi vô hiệu hóa `--body`; không
ảnh hưởng `/herdgate-arm` thường. Worker riêng chỉ lưu khi được khởi chạy với
`HERDGATE_PI_RECEIPT_BODY=1`.

Publisher chỉ phục vụ `receipt.body {id}` khi chủ host bật **cả**
`HERDGATE_PI_RECEIPTS=1` và `HERDGATE_PI_RECEIPT_BODY=1` cho publisher. Push
báo `hasBody`, không gửi kèm text. Device đã pair có scope `read` và biết đúng
UUID có thể lấy `{text, bytes, truncated}` (tối đa 64 KiB UTF-8; `bytes` là
kích thước gốc); đây là text
trên kênh device, chỉ được mã hóa đầu-cuối nếu dùng client có Noise session.
Không bật cho room có thiết bị không được phép đọc báo cáo.

```sh
node experiments/pi-receipt/query.mjs --gate ... --device d --secret s --id <uuid> \
  --wait --body --out /path/to/new-report.md
```

CLI truy vấn ban đầu một lần rồi nghe push, tải text và lưu vào file mới 0600
(không ghi đè); đồng thời in JSON chứa text cho controller chuyển tiếp. Bỏ
`--wait` để lấy body cho receipt đã chốt. MCP có `herdgate_receipt_body`.
Nếu chưa có body, trả lý do rõ ràng, không tự đọc pane, transcript hoặc gửi lại.

### Truy vấn qua Gate (thử nghiệm)

Publisher trả lời frame JSON `receipt.get` từ **thiết bị đã pair** — không cần mở TUI,
không cần SSH. Tắt mặc định; bật bằng `HERDGATE_PI_RECEIPTS=1` trên publisher cùng
`HERDGATE_PI_RECEIPT_DIR` (hoặc cùng user/XDG mặc định) với Pi đích:

```sh
# phía host (publisher)
HERDGATE_PI_RECEIPTS=1 herdgate …  # cùng thư mục journal observer đang ghi

# phía máy điều khiển
node experiments/pi-receipt/query.mjs --gate https://gate.example.com \
  --device d_xxx --secret <device-secret> --id <request-uuid>
```

Wire format: thiết bị gửi `{op:"receipt.get", id}` trong frame; publisher đọc journal
và trả `{op:"receipt.result", id, status, reason?, requestEntryId?, responseEntryId?}`.
Tìm theo đúng UUID, không liệt kê; scope `read` là đủ vì chỉ có metadata. Frame đi qua
WSS của Gate dạng plaintext như các op `ssh.*`, trừ khi thiết bị đã có Noise session.
Tắt cờ → trả `unknown/pi_receipts_disabled`. Đây vẫn là thử nghiệm: push chưa
có subscription theo từng device và chưa có UI trong PWA.

Xem thêm `experiments/pi-worker/` — worker riêng chạy request qua Pi SDK và ghi receipt
vào cùng journal này (bước 3 của lộ trình).

### Tích hợp qua Gate loopback

Trên Linux có Herdr 0.9.5, Pi 1.5.2, tmux, OpenSSH và dependencies của repo:

```sh
TEST_HERDR_BIN="$(command -v herdr)" TEST_PI_BIN="$(command -v pi)" \
  node --test test/pi-receipt-gate.test.ts
```

[Test E2E](../../test/pi-receipt-gate.test.ts) tự dựng hai profile Herdr, Gate và
publisher thử, key SSH tạm và Pi với provider giả. Client gửi/đọc cả hai lệnh qua
Herdr TUI trên SSH qua WebSocket loopback. Test đối chiếu prompt nhiều dòng có
tiếng Việt, chặn Pi ngay trước settle để kiểm `received`, ngắt client và nối lại
để kiểm `replied` với cùng entry ID và chỉ một lần gọi provider. Marker sai,
Escape ra `unknown`/`canceled`; `/reload` và cả khởi động lại tiến trình Pi vẫn
giữ receipt từ journal mà không gửi thêm.
Test không chạm Gate public, profile thật, Windows hay 4G/5G. Xem thêm
[nghiên cứu và thiết kế](../../docs/herdr-skills/HERDR_PI_EXTENSION_RESEARCH.md).
