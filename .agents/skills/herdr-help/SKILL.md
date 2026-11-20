---
name: herdr-help
description: 'Giải thích và chẩn đoán Herdr TUI: cài đặt, phiên đang chạy, CLI/server, ConPTY, SSH và nhận diện agent/Pi. Ưu tiên chỉ đọc; không dùng để điều khiển agent hoặc tự sửa cấu hình.'
---

# Herdr Help

Phân biệt **Herdr TUI binary, server phiên, Herdr Desktop/Core/mod, extension trong agent**. Đừng dùng tài liệu Desktop mod để suy diễn plugin TUI, hay phiên bản client để kết luận server đã cập nhật. Hỏi người dùng đang thao tác ở đâu nếu chưa rõ.

1. Đọc [index tài liệu stable](https://herdr.dev/llms.txt); dùng trang đúng phiên bản/chủ đề, preview index chỉ cho bản preview. [Agent guide](https://herdr.dev/agent-guide.md) phù hợp setup lần đầu. Đối chiếu help thực tế trước khi đưa lệnh. Khi hostname/phiên chưa rõ, không query phiên đang focus từ ngoài; vẫn có thể kiểm `--version`/`--help`.
2. Nếu ở managed pane, dùng guard và `HERDR_BIN_PATH` của [skill gốc](../herdr/SKILL.md). So sánh `command -v herdr` hoặc `Get-Command herdr -All`, `herdr --version`, binary trong `HERDR_BIN_PATH` và `status`. Đọc trường client/server, endpoint/protocol compatibility và stale; khác version nhưng compatible không tự động là lỗi cần restart. Trên Windows lưu ý ConPTY, Windows OpenSSH và named pipe; không áp Unix socket/keybinding/handoff làm mặc định.
3. Nhận diện sai agent: xem `agent get <target>`, `agent explain <target>`, `pane process-info --pane <id>` và `integration status` nếu có. Với Pi, tìm extension Herdr-báo-trạng-thái theo output, kiểm xem Pi có chạy `--no-extensions` hoặc không ở Herdr. File có mặt chưa chứng minh đã nạp; agent status không chứng minh turn hoàn tất. Không tự cài lại extension.
4. Lỗi remote: phân biệt local với saved SSH machine; đọc `machine status <machine> --json` khi có target rõ. Không `machine reconnect` thay người dùng khi cần xác thực tương tác; không stop/thay server remote. Lỗi log: lấy đường dẫn theo `--help` hoặc docs đúng OS, chỉ đọc đoạn liên quan và che nội dung nhạy cảm. Tránh dump config/env/log đầy đủ.
5. Trả lời bằng hiện tượng, bằng chứng, nguyên nhân đã xác minh hoặc giả thuyết còn lại và bước ít rủi ro nhất. Không tự update, đổi PATH/config, reload, dừng/kill tiến trình, đổi session hay bật integration; nêu tác dụng phụ và xin phép nếu cần.
