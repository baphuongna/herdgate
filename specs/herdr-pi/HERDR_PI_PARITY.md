# Herdr + Pi: profile và đối chiếu phản hồi theo yêu cầu

- Document-updated-at: `2026-11-20`
- Document-status: `WRITTEN`

## Mục tiêu và phạm vi

Thu hẹp hai điểm khác biệt dễ gặp khi dùng Herdr thay Paseo cho agent Pi: lưu cấu hình khởi chạy dùng lại và đọc đúng phản hồi từ dữ liệu phiên thay vì đoán bằng màn hình. SLP, đồng bộ transcript/credential giữa máy, lịch/heartbeat, web/mobile/relay, thay thế transport Herdr và auto-launch nằm ngoài phạm vi. Cài skill không cài script, daemon hay dependency toàn cục.

## Hợp đồng

- **HP-1 — Profile portable:** file TOML có `schema_version = 1`, bảng `profiles` theo tên. Chỉ cho `notes`, `model` dạng `provider/id` và `thinking` mức Pi. `profile list` và `profile show NAME` trả JSON; `show` trả `kind: pi`, `pi_args` có cấu trúc. Không nhận script, path, credential, env, alias provider hoặc cờ tùy ý. Không gọi Pi để kiểm catalog; skill phải xác minh model/thinking ở máy đích khi chạy. Có thể chuyển file chứa cấu hình không bí mật giữa máy; mỗi máy tự cài Pi và đăng nhập.
- **HP-2 — Đối chiếu đọc-only:** `new-request` tạo UUID ngẫu nhiên + dòng `[herdr-request:<uuid>]` để đặt đầu prompt. Không tự gửi. `observe REQUEST_ID` dùng một trong `--pane` hoặc `--session-file`. Pane lookup chỉ gọi `agent get` trên Herdr **local** trong managed pane, yêu cầu pane ID cụ thể và session Pi dạng path được integration báo; kiểm lại binding sau lần đọc. File mode yêu cầu absolute path `.jsonl` trên máy đang đọc, cho phép offline. Không đoán path bằng tên máy/repo; không tìm file SSH qua filesystem local. Cả hai mode hỗ trợ `--expect-session <id>`: so khớp chính xác với ID trong header Pi, trả `unverified` (`unexpected_session_id`) nếu khác. ID lấy từ target đã xác minh lúc gửi, không lấy từ snapshot đang kiểm để tự xác nhận. Đây không phải kiểm tra provenance hay xác thực host. Chỉ read snapshot có giới hạn, không sửa session/khởi chạy agent.
- **HP-3 — Báo trạng thái trung thực:** parse session Pi JSONL v3, kiểm header, ID và links theo thứ tự. Tìm đúng một user message có marker ở dòng đầu và đi theo ancestry đến trước user message kế tiếp. Bỏ qua system/tool content; phân nhánh mơ hồ, ID trùng, format lạ, file chưa ghi xong/thay đổi hoặc binding đổi phải trả `unverified`. `request_not_observed` không có nghĩa chưa gửi, `request_observed` chỉ nghĩa đã thấy user entry. `response_observed` yêu cầu assistant message mới nhất trong nhánh có `stopReason: stop` và có text; không khẳng định agent đã idle, không xác nhận delivery exactly-once. Mặc định chỉ in trạng thái và IDs, không in prompt/answer. `--include-answer` mới trả text, không trả reasoning/tool output. Observe exit `0` khi có response, `1` khi chưa quan sát response, `2` khi không xác minh được. Không resend tự động.
- **HP-4 — Tích hợp skill và deploy:** sáu skill vẫn hoạt động khi không có helper, nêu preflight OS/CLI, ưu tiên profile/observe nếu helper có sẵn và phù hợp. Remote chỉ dùng helper ở máy đích có file session; không chuyển path qua máy khác. Không cài user-level hoặc bắt buộc Python nếu chỉ dùng skill thuần terminal.

## Kế hoạch và kiểm thử

1. Viết helper Python 3.11+ stdlib, sample TOML và hướng dẫn chạy trên các máy. Profile chỉ cho cờ model/thinking; input sai dừng trước khi đụng runtime.
2. Kiểm thử offline bằng TOML/snapshot tổng hợp, thư mục tạm có khoảng trắng và fake Herdr runner: marker khớp user message, nhánh khác/marker trùng, lỗi/timeout/thay file/binding, không in text mặc định. Không dùng session thật làm fixture.
3. Chạy bộ test repo và probe local **chỉ đọc** với một UUID mới để xác minh nhận diện session và trạng thái không quan sát được. End-to-end hai agent/máy, scheduled workflows và RPC bridge thực sự để riêng; không quy đổi offline test thành nghiệm thu live.
