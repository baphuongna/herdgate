# Bài học từ Paseo cho Pi agent và báo cáo Herdgate

Khảo sát source Paseo tại [`7e3826ad6ca0`](https://github.com/getpaseo/paseo/tree/7e3826ad6ca0b50bd405a302b345a3a22c087476). Đây là ghi chú thiết kế, không phải cam kết tương thích hay tính năng đã triển khai.

## Paseo tách cấu hình, chạy và thông báo ra sao

| Chủ đề | Quan sát từ Paseo | Áp dụng cho Herdgate |
|---|---|---|
| Cấu hình agent | [Agent profiles](https://paseo.sh/docs/agent-profiles.md) lưu trên host, gồm provider, model, thinking, mode và các tùy chọn tùy provider. Sửa profile không đổi agent đã chạy. [Pi runtime](https://github.com/getpaseo/paseo/blob/7e3826ad6ca0b50bd405a302b345a3a22c087476/packages/server/src/server/agent/providers/pi/runtime.ts) khởi chạy Pi trên host với argv và chỉ thêm cờ cho giá trị được cung cấp. [RPC adapter](https://github.com/getpaseo/paseo/blob/7e3826ad6ca0b50bd405a302b345a3a22c087476/packages/server/src/server/agent/providers/pi/cli-runtime.ts) đọc catalog và trạng thái thực bằng `get_available_models`, `get_state`. | Dùng mặc định Pi trên máy đích → profile host đã duyệt (nếu chọn) → override rõ ràng lúc launch. Kiểm tra model/thinking có hiệu lực, báo lỗi nếu override bị bác hoặc hạ cấp; không âm thầm đổi sang model khác. Tools, skills, extensions và MCP nên kế thừa cấu hình máy đích hoặc profile host; không nhận đường dẫn, env hoặc argv tùy ý qua `worker.submit`. |
| Ranh giới hoàn thành | [Pi adapter](https://github.com/getpaseo/paseo/blob/7e3826ad6ca0b50bd405a302b345a3a22c087476/packages/server/src/server/agent/providers/pi/agent.ts#L2329-L2350) ưu tiên `agent_settled` cho runtime mới; nó có nhánh tương thích fallback `agent_end` khi thiếu `willRetry`. | Giữ điều kiện chặt hơn của Herdgate: `agent_settled` + đúng request/response entry và session. Không lấy `agent_end`, pane `idle` hoặc process exit làm bằng chứng có reply. Không tự gửi lại khi thiếu bằng chứng. |
| Báo cáo tự động | [Finish subscriptions](https://github.com/getpaseo/paseo/blob/7e3826ad6ca0b50bd405a302b345a3a22c087476/packages/server/src/server/agent/finish-subscriptions/index.ts) giữ intent bền theo caller/child/host, quan sát sự kiện, đưa thông báo vào hàng đợi của caller và chờ ACK dispatch trước khi gỡ intent. [Nội dung thông báo](https://github.com/getpaseo/paseo/blob/7e3826ad6ca0b50bd405a302b345a3a22c087476/packages/server/src/server/agent/finish-subscriptions/internal/notification.ts) có trạng thái và phần reply cuối có giới hạn. | Đăng ký trước khi gửi, gắn với **request UUID và device đích** (không chỉ pane/agent), lưu trạng thái giao riêng với receipt. Chỉ trả nội dung đã opt-in cho bên được cấp quyền. Controller ghi file trước khi gửi ACK; preview là dữ liệu, không phải chỉ thị mới cho agent. |

## Lát cắt ưu tiên: đăng ký nhận báo cáo theo request

**Đã triển khai (prototype, opt-in `HERDGATE_PI_RECEIPTS=1`):** durable watch trong
`plugin/server/pi-receipt-watch.mjs` + ops `receipt.watch`/`receipt.ack`, replay khi
reconnect, `query.mjs --wait --body --out` và MCP `herdgate_receipt_wait` tự đăng ký và
ACK; nghiệm thu loopback trong `test/pi-receipt-gate.test.ts` (mất kết nối trước settle,
replay một lần, ACK retire, không broadcast). Các bước còn lại:

1. Dùng room/device đã xác thực; quyền đăng ký nhận **nội dung** phải do chủ host hoặc policy cấp cụ thể, không suy ra từ việc biết UUID. Đăng ký trước dispatch để không bỏ lỡ agent trả lời rất nhanh. Cho phép hết hạn hoặc hủy intent khi không dispatch.
2. Khi observer chốt, publisher push metadata đúng device. Controller tải reply nếu được phép, ghi file riêng hạn chế quyền với khóa theo UUID, sau đó gửi ACK. Nếu có forward vào pane, đó là bước riêng và phải có trạng thái riêng; ACK lưu file không có nghĩa pane đã nhận, và cả hai không có nghĩa task nghiệp vụ thành công.
3. Nếu mất kết nối, khi device kết nối lại chỉ phát lại **thông báo** cho registration còn hạn/chưa ACK. Không replay receipt cũ toàn room và không resend prompt. Chống trùng theo `requestId + recipient`; không hứa exactly-once cho hành động forward nếu crash ngay trước ACK.
4. Kiểm thử bằng fixture: reply tức thời, hai request settle ngược thứ tự, mất kết nối trước settle, restart publisher, crash sau lưu file trước ACK, device sai hoặc bị revoke. Kiểm riêng lỗi cấu hình: không gửi prompt nếu profile/model/thinking không được Pi áp dụng. Luồng bình thường không polling để chờ completion.

Hiện Herdr TUI đã có đường truyền cấu hình mặc định và cờ launch; thử nghiệm Gate loopback đã chứng minh controller nhận push, tải và lưu file. Worker fixture chưa có provider thật hay profile host; chưa có subscription/ACK bền, phân quyền body theo từng request hoặc forward vào pane đã nghiệm thu trên hệ thống thật. Không cần thay Herdr bằng Paseo hay đưa một daemon mới vào để làm lát cắt đầu.
