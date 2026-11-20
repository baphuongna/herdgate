---
name: herdr-committee
description: 'Dùng hai agent trong Herdr TUI để phân tích độc lập, phản biện và đề xuất kế hoạch cho bài toán khó. Chỉ khởi chạy khi người dùng yêu cầu committee qua Herdr; không triển khai code.'
---

# Herdr Committee

Đọc [Herdr TUI](../herdr/SKILL.md) trước. Chỉ bắt đầu khi người dùng yêu cầu thực thi. Lấy tối đa **hai agent mới** trong hai pane độc lập. Mặc định dùng cùng cwd/tab đang làm, giữ focus bằng `--no-focus`, chọn hướng split theo layout. Tôn trọng kind/model mà người dùng chọn; có thể dùng hai profile Pi trong catalog người dùng chọn nếu đã xác minh được máy đích. Nếu chỉ có một kind sẵn, dùng hai góc nhìn khác nhau (ví dụ RCA và phản biện) và nói rõ không có đa dạng provider; không âm thầm đổi service/tài khoản.

1. Khung bài toán chung: mục tiêu, hiện tượng, phạm vi, bằng chứng, thử nghiệm đã thất bại và ràng buộc. Cùng một dữ kiện cho hai agent; khác câu hỏi/góc nhìn. Prompt yêu cầu **chỉ đọc**, không sửa/tạo/xóa file, không chạy lệnh có tác dụng phụ, không tạo thêm agent. Read-only là ràng buộc tác vụ, không phải sandbox.
2. Tạo pane theo thứ tự, lấy hai ID khác nhau từ JSON; xác minh hai agent đã sẵn sàng và chưa có turn đang chạy. Gửi brief độc lập đến từng đích, có marker mới khác nhau. Với Pi/helper, tạo UUID riêng và đặt marker đúng dòng đầu cho từng lần gửi, rồi `observe` riêng theo pane/ID. Chạy hai lời gọi `agent prompt --wait --timeout …` độc lập cùng lúc nếu có thực thi song song; kiểm cả hai exit result. Không dùng `agent wait` rời như bằng chứng prompt đã được nhận.
3. Đọc từng kết quả, so sánh nguyên nhân, bằng chứng và điểm bất đồng. Nếu hữu ích, thực hiện **tối đa một vòng** phản biện cho mỗi agent đã sẵn sàng: gửi lập luận đối lập tóm tắt, không gửi transcript thô hoặc secret. Dùng marker mới, timeout hữu hạn; không tự approve, không retry mù, không mở thêm agent thay thế.
4. Báo điểm đồng thuận, điểm bất đồng chưa giải quyết, hướng thử nghiệm/plan và giới hạn dữ liệu. Báo riêng agent blocked/timeout/không có bằng chứng; không hạ xuống một advisor rồi gọi đó là kết luận của committee. Không triển khai code hay tự đóng pane. Nếu cần vòng mới, hỏi người dùng.
