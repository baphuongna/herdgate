---
name: herdr-advisor
description: 'Dùng một agent trong Herdr TUI để lấy góc nhìn thứ hai hoặc phản biện chỉ đọc. Chỉ khởi chạy khi người dùng yêu cầu advisor qua Herdr; không giao việc triển khai.'
---

# Herdr Advisor

Đọc [Herdr TUI](../herdr/SKILL.md) trước. Nếu chỉ được hỏi cách dùng, giải thích, không tạo pane. Xác minh đang ở Herdr, đúng cwd và kind/model. Hỗ trợ yêu cầu dạng `[--kind <kind>] <câu hỏi>` hoặc profile Pi theo catalog được chọn như skill gốc. Model/thinking nếu có thì kiểm qua CLI con, không suy diễn từ Paseo profile.

1. Chốt đúng **một** câu hỏi. Tạo **một** agent mới tên như `advisor-<slug>` bằng split/agent start theo skill gốc. Giữ workspace/cwd hiện tại và focus; trừ khi người dùng yêu cầu chỗ khác. Không tự mở thêm agent thứ hai. Có thể dùng kind/model khác nếu được yêu cầu hoặc đã được người dùng cho chọn và đã xác minh sẵn sàng.
2. Gửi brief: câu hỏi, hiện trạng, thay đổi đã thử, đường dẫn/commit liên quan và các giả định cần phản biện. Yêu cầu **chỉ đọc: không sửa/tạo/xóa file, không chạy lệnh có tác dụng phụ, không gọi agent khác**. Đề nghị trả về nhận định, bằng chứng, rủi ro và phương án khuyến nghị; cuối phản hồi ghi marker riêng theo task. Đây là ràng buộc tác vụ, không phải phân quyền OS.
3. Gửi một lần bằng `agent prompt` **không `--wait`**: advisor tự báo cáo lại qua watch receipt (đăng ký ID trước khi gửi — xem quy trình trong skill herdr); không polling, `sleep` hay vòng `agent get` chờ. Nếu dùng Pi với helper, tạo request marker trước khi gửi và `observe` đúng request **sau khi báo cáo về**; nếu không có helper thì `agent get`/`agent read` kèm giới hạn chỉ khi cần tra cứu. Không dùng trạng thái `done` làm đáp án và không gửi lại mù khi stall/timeout. Tổng hợp tách rõ **ý kiến advisor** và **khuyến nghị của mình**; nếu báo cáo chưa về trong lượt này, nói rõ đang chờ push thay vì giả sử kết quả. Dừng sau vòng này; không chỉnh code hay đóng pane thay người dùng.
