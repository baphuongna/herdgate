---
name: herdr-plugin
description: 'Thiết kế, viết hoặc chẩn đoán plugin Herdr TUI dùng herdr-plugin.toml, actions, event/startup hooks, terminal panes và CLI/socket. Không dùng cho Herdr Desktop mod, Pi extension hay Paseo plugin.'
---

# Herdr TUI Plugin

Xác nhận người dùng muốn **plugin Herdr TUI**. Mở [index Herdr](https://herdr.dev/llms.txt) và docs Plugins, Socket API đúng bản; xem help `herdr plugin` và `herdr api schema --json`. Khi đọc phiên sống, tuân thủ guard/target của [skill gốc](../herdr/SKILL.md). Nếu đề bài nói Desktop/Core, mod UI hoặc extension Pi, xác định runtime khác trước; không tạo nhầm manifest.

## Thiết kế và viết

- Dùng thư mục riêng với `herdr-plugin.toml` và script/binary. Manifest có `id`, `name`, `version`, `min_herdr_version`; khai báo `platforms` chính xác. Chọn `[[actions]]` cho thao tác theo yêu cầu, `[[events]]` cho sự kiện xác nhận có trong bản đích, `[[startup]]` cho init hữu hạn, `[[panes]]` cho UI terminal, `[[link_handlers]]` nếu thực sự cần. Event hook không phải preflight authorization, scheduler hay daemon được supervise.
- `command` là argv array; không chèn dữ liệu context vào chuỗi shell. Ưu tiên `HERDR_BIN_PATH` gọi CLI; dùng socket trực tiếp chỉ nếu có lý do (Unix socket khác Windows named pipe). Parse context `HERDR_PLUGIN_CONTEXT_JSON`/ID đúng phiên, không dựa vào focus hay suy đoán field thiếu. Chỉ lưu config/state vào `HERDR_PLUGIN_CONFIG_DIR` và `HERDR_PLUGIN_STATE_DIR`; không log prompt/secret và không ghi credentials vào repo.
- Windows: xác minh launcher/PATH/argv; đừng bê ví dụ `sh` vào Windows nếu không khai báo dependency/platform. Tránh gọi SDK/RPC hoặc native non-terminal UI của Paseo như thể Herdr có đối ứng. Plugin chạy với quyền người dùng, không sandbox; không hứa cổng cưỡng chế SLP, authority hay delivery receipt chỉ từ manifest/events.

## Kiểm chứng và vận hành

1. Trước hết kiểm manifest, input/argv, dữ liệu có thể thiếu và lỗi command bằng test offline; chẩn đoán chỉ đọc bằng `plugin list --plugin <id> --json`, `plugin action list --plugin <id>`, `plugin log list --plugin <id> --limit 20` nếu CLI hỗ trợ. Không invoke action để dò lỗi nếu action có thể đổi state.
2. Xem trước mọi build/startup/event/action command, trust nguồn và quyền scope. **Không** chạy link/install/enable/update/invoke/unlink khi mới được yêu cầu viết hay kiểm tra. Nếu người dùng yêu cầu chạy thử, chọn phiên thử riêng; xác nhận đăng ký plugin **global theo user** ngay cả khi có named session. Một phiên test không cô lập đăng ký plugin, file, môi trường hay quyền OS.
3. Với source local được duyệt, `plugin link <absolute-path> --disabled` là đăng ký không bật nếu bản CLI hỗ trợ, không phải cách test offline. Link không tự build. Enable/run là bước riêng, báo trước tác dụng phụ. Startup hook chạy khi server khởi động, không chạy lại chỉ vì link/enable/reload config; không restart server đang phục vụ để test nếu chưa được phép.
4. Báo riêng phần đã đọc, đã test offline, đã link/enable hay đã chạy thực tế; không đánh đồng “plugin xuất hiện trong list” với “hook đã chạy đúng”.
