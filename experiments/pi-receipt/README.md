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

### Push khi agent chạy xong (`receipt.push`)

Khi `HERDGATE_PI_RECEIPTS=1`, publisher theo dõi journal (fs.watch + sweep định kỳ) và
**tự đẩy** `{op:"receipt.push", ...publicReceipt}` tới mọi thiết bị đang trong room ngay
khi receipt chốt (replied/failed/canceled/unknown) — controller không cần poll. Bản
baseline khi publisher khởi động không phát lại receipt cũ. Muốn chờ settle từ CLI:

```sh
node experiments/pi-receipt/query.mjs --gate ... --device d --secret s --id <uuid> --wait
```

MCP có tool `herdgate_receipt_wait {id, timeoutSeconds}` với ý nghĩa tương tự. Lưu ý:
chỉ **settle** được đẩy — trạng thái trung gian (`armed`/`received`) vẫn in-memory,
không push; push là metadata tới mọi device trong room (cùng herd của bạn).

### Lưu và lấy nội dung báo cáo (`receipt.body`)

Receipt cố ý chỉ là metadata. Nội dung **reply cuối** của request settle `replied`
được lưu **mặc định** cạnh journal: `<base>/<scope>/responses/<id>.md` (0600) — bản
answer vốn đã có trong session JSONL của Pi trên cùng máy, nên đây không mở lớp bí
mật mới; tắt bằng `HERDGATE_PI_RECEIPT_BODY=0`. Publisher phục vụ qua op
`receipt.body {id}` (read scope, vẫn gate ở `HERDGATE_PI_RECEIPTS=1`):
`{text, bytes, truncated}` — serve tối đa 64KB, không có thì `body_not_retained`;
`receipt.push` kèm `hasBody`. CLI: `query.mjs --id <uuid> --body`; MCP:
`herdgate_receipt_body`. Lưu ý: body là answer text trần trên kênh device (đã có
Noise nếu thiết lập); read scope vốn đã đọc được màn hình pane qua `term.read`.

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
Tắt cờ → trả `unknown/pi_receipts_disabled`. Đây vẫn là thử nghiệm: chưa có push/subscribe,
chưa đưa vào PWA, publisher production chưa bật cờ này.

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
