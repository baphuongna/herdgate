---
name: herdr-handoff
description: 'Bàn giao công việc hiện tại cho một agent mới trong Herdr TUI với brief tự chứa và tiêu chí nghiệm thu. Chỉ chạy khi người dùng yêu cầu chuyển việc qua Herdr; hỗ trợ worktree riêng nếu được chỉ định.'
---

# Herdr Handoff

Đọc [Herdr TUI](../herdr/SKILL.md) trước. Handoff là **giao việc cho một agent mới**, không phải `--handoff` của Herdr (chuyển phiên/tiến trình khi update/attach), không copy toàn bộ session và không chuyển quyền Lead/Peer hay quyền nghiệm thu.

1. Xác minh yêu cầu, scope và người nhận. Giữ loại nhiệm vụ: điều tra vẫn chỉ đọc; fix thì mới được sửa trong phạm vi; review không biến thành rewrite. Nếu có thay đổi chưa commit, nói rõ file/commit nào agent mới thực sự nhìn thấy. Không để hai agent sửa chồng cùng phạm vi trong một checkout.
2. Mặc định dùng pane mới trong tab/cwd hiện tại như skill gốc. Nếu được yêu cầu worktree, xác minh repo và base Git, chọn tên branch mới không đụng branch sẵn; dùng worktree open nếu người dùng chỉ định checkout đã có. Mẫu cho branch mới, sau khi đã xác minh đầu vào:

   ```bash
   "$H" worktree create --cwd "$repo" --branch "$branch" --base "$base" --no-focus
   ```

   Lấy `.result.workspace.workspace_id`, `.result.root_pane.pane_id` và checkout từ response; xác minh cwd/pane trống trước `agent start`. Dùng profile Pi nếu người dùng chọn và máy đích hỗ trợ. Worktree không mang theo thay đổi chưa commit của checkout gốc. Không tự copy, cherry-pick, stash, commit hoặc push để làm brief “chạy được”; nếu thiếu input, hỏi người dùng. Không tự thêm `--trust-repository`.
3. Brief tự chứa: mục tiêu và phần việc còn lại; repo/cwd/branch/base; file và bằng chứng; hiện trạng và lần thử thất bại; quyết định đã khóa; mục không được động; tiêu chí nghiệm thu, phép kiểm chứng được phép và cách báo blocked. Không gửi credential hoặc nguyên transcript. Yêu cầu phản hồi nhận việc có marker riêng, nhắc lại scope hoặc blocker và không tự ủy quyền. Nếu người dùng chỉ yêu cầu chuẩn bị brief, dừng ở brief.
4. Gửi một lần bằng `agent prompt` theo skill gốc, **không `--wait`**: agent nhận việc tự báo cáo lại qua watch receipt cho ID đã đánh dấu (đăng ký trước khi gửi); không polling hay `sleep` chờ. Với Pi/helper, đặt marker request ở dòng đầu và giữ ID để watch/đối chiếu sau; không tự resend nếu chưa thấy ACK. Không bắt agent dừng sau ACK nếu mục tiêu là làm tiếp. Báo agent/pane/workspace và trạng thái đã quan sát: “đã submit” khác “đã nhận/đang làm” và “đã hoàn tất”. ACK nhìn thấy phải là câu trả lời, không phải echo prompt; nếu không biết, báo chưa xác minh. Sau bàn giao không tự triển khai song song hoặc đóng pane.
