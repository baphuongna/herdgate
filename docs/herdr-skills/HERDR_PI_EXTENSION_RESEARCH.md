# Nghiên cứu: Pi extension hay Herdr TUI plugin để tiến gần Paseo?

- Document-updated-at: `2026-11-20`
- Document-status: `PROTOTYPE` — [observer local thử nghiệm](../../experiments/pi-receipt/README.md), nạp thủ công; chưa phát hành.
- Phạm vi kiểm chứng: Pi 1.5.2 SDK/TUI và Herdr 0.9.5 qua Gate loopback, provider giả, profile tạm; không nạp extension vào Pi đang dùng, không thay publisher hay relay đang chạy.

## Kết luận

Nếu chỉ làm một, **ưu tiên Pi extension opt-in**. Nó quan sát được dữ liệu mà Herdr TUI không có: Pi đã nhận request nào, có ghi nhận phản hồi/lỗi/hủy cho request đó hay chưa. **Herdr TUI plugin** nên là lớp thao tác và hiển thị thêm, dùng lại CLI và dữ liệu đó. Không dựng hai bộ điều phối độc lập.

Phạm vi so sánh là **Paseo cho workflow Pi + Herdr TUI + SSH**, không tính SLP. Port được sáu skill hoặc có cùng nút bấm không đồng nghĩa với tương đương về trạng thái, phục hồi hay quyền.

## Hiện có và khoảng cách còn lại

| Hạng mục | Hiện có | Muốn tương đồng hơn |
|---|---|---|
| Advisor, committee, handoff | Sáu skill mô tả luồng thao tác; Herdr quản lý pane và tiến trình | Định danh worker ngoài pane ID, quan hệ parent–worker, trạng thái và kết quả theo request; handoff chuyển brief, không mặc nhiên chuyển session hay quyền. |
| Profile và workspace | Profile TOML cho Pi (`model`, `thinking`, `notes`); Herdr có pane/workspace và Git worktree | Profile theo host/provider với mode/tùy chọn tương ứng, chọn trong UI; registry project/workspace, lifecycle script, archive và dọn worktree chỉ khi hệ thống sở hữu. |
| Prompt và timeline | `agent prompt` gửi qua terminal; `herdr_pi.py observe` đọc Pi JSONL v3 để đối chiếu marker | Phân biệt gửi, Pi nhận, hoàn tất/lỗi/hủy theo request; theo dõi/reconcile sau disconnect. Khi B được gửi lúc A còn chạy, `agent prompt --wait` có thể kết thúc theo A, không phải B. |
| Phiên và khôi phục | Herdr có detach/reattach và native agent session restore khi integration hỗ trợ | Resume hội thoại không phục hồi lượt đang chạy hay hàng đợi điều phối. Cần checkpoint và quy tắc xử lý trạng thái không xác định. |
| Điều phối bền và toàn sản phẩm | SSH và CLI/socket Herdr hỗ trợ vận hành từ xa | Scheduler/heartbeat, API/MCP chung, ghép nối host, web/mobile/relay, nhiều provider và plugin UI/hook tương đương Paseo vẫn là các bài toán riêng. SSH không phải relay hay đồng bộ session giữa máy. |

Xem [hướng dẫn skill](HERDR_SKILLS_GUIDE.md) và [đặc tả helper hiện tại](../../specs/herdr-pi/HERDR_PI_PARITY.md) để phân biệt phần đã làm với phần đề xuất.

## So sánh cách triển khai

| Cách | Phù hợp | Giới hạn |
|---|---|---|
| **Pi extension** | Quan sát nhánh và `agent_settled` ngay trong phiên Pi TUI hiện có, không thay đường nhập. | Chỉ thấy phiên opt-in. Tín hiệu settle không mang request ID; phải đối chiếu nhánh và vòng đời. Không phục hồi công việc khi Pi chết. |
| **Herdr TUI plugin** | Manifest `herdr-plugin.toml`, action, phím tắt và pane tổng quan `worker / request / trạng thái / kết quả`; dùng lại CLI và dữ liệu observer. | Sự kiện và wait chỉ ở cấp pane, kể cả trạng thái Pi gửi bằng `pane.report_agent`. Plugin chạy với quyền user, không phải sandbox. |
| **Pi RPC/SDK bridge** | Điều phối Pi worker mà bridge sở hữu: gửi/hủy có cấu trúc, tách worker khỏi input tay. RPC `prompt` có disposition `started`, `queued`, `handled`. | RPC là subprocess riêng, không gắn được vào Pi TUI đang chạy. Response ID chỉ đối chiếu lệnh; `started` chưa phải receipt entry, `handled` có thể không có settle. Vẫn cần tương quan, lưu và phục hồi. |
| **Pi Durable / dpi-backend** | Nếu sản phẩm cần admit idempotent, inbox, submission ID và phục hồi task sau khi process chết: đây là runtime sở hữu input, không phải observer. | API Pi Durable experimental. Cần worker/storage riêng và quy tắc cho side effect của tool; idempotent admission không có nghĩa mọi tool chạy đúng một lần. Không ghép vào Pi TUI đang mở bằng cách đọc JSONL. |

Hai mẫu trong `herdr-pi-plugins` thuộc hai tầng khác nhau: `pi.agent-monitor` log sự kiện trạng thái
pane; `pi.durable-bridge` khai báo action kết nối một durable backend riêng. Không mẫu nào
là receipt theo request cho Pi TUI đang dùng. Mã/dữ liệu Durable mới được đối chiếu ở mức tài liệu
cục bộ (`packages/durable/README.md`, `apps/dpi-backend/API.md`), chưa thử backend trong nghiên cứu này.

## Kiểm chứng thực nghiệm: Pi 1.5.2

[Probe tái lập](probes/pi-settlement.mjs) chạy 12 kịch bản bằng SDK thật, provider giả, không tool
và không có cấu hình Pi/Herdr của người dùng. Các handler trong probe chỉ được đăng ký trong
process thử. Probe còn nạp rõ ràng file observer để chạy thêm 4 tình huống bằng lệnh slash thật
qua SDK; không có bước cài extension vào profile.

| Quan sát được | Hệ quả cho thiết kế |
|---|---|
| `input` có thể bị consume; `message_end` của user chạy trước append và handler sau có thể xóa marker. `turn_end` thấy user/assistant entry đã ghi. | Không phát `received` từ `input`, `before_agent_start` hay `message_end`. Dùng `turn_end` làm mốc kiểm tra sớm sau append; có thể chưa báo `received` nếu turn chưa tới mốc này. Kiểm tra lại ở settle. |
| Retry tạo hai `agent_end` nhưng chỉ một settle. Handler `agent_before_settle` có thể tiếp tục sau reply `stop` đầu tiên. Follow-up thêm một user message trước cùng settle. | Không chốt ở `turn_end`/`agent_end`; không quy reply cuối cho request đầu nếu suffix có input cạnh tranh. Follow-up và extension continuation là hai ca khác nhau: continuation có thể không thêm `message:user`. |
| `agent_settled { aborted: false }` vẫn có thể kết thúc với `stopReason: error`. Ngược lại abort ở `agent_before_settle` có thể để lại assistant entry `stop` trước đó. | Kiểm tra `aborted` và assistant entry cuối của chính lượt; không đi lùi chọn một reply cũ khi đoạn cuối lỗi hoặc bị hủy. `replied` không có nghĩa công việc thành công. |
| `context_edit` có thể bỏ reply khỏi model projection nhưng raw entry còn `stop`; Pi có thể bắt đầu lượt mới ngay sau khi dispatch settle. | Không coi raw assistant `stop` là đủ. Ghi receipt trong chính handler settle, dựa trên snapshot đã đọc ở handler, không đợi job ngoài rồi mới lấy nhánh. Settle là ranh giới của lượt, không phải lời hứa pane tiếp tục rảnh. |
| `/tree` đi sang ancestor rồi quay lại có thể khôi phục đúng leaf; `/reload` giữ nguyên session ID và leaf. Session in-memory vẫn có entry và settle dù không có JSONL. | Cần branch generation tăng tại `session_tree` và epoch mới khi runtime thay thế. Không dùng session ID/leaf cuối làm bằng chứng liên tục; không coi `getSessionFile()` là chứng cứ file đã có hoặc đã fsync. |

Chạy từ checkout với Node 22+ (đổi đường dẫn tới package Pi **1.5.2** đang cài):

```sh
node docs/herdr-skills/probes/pi-settlement.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
```

## Phương án MVP: extension trước, dùng chung CLI

### Lát cắt đầu tiên: chỉ quan sát local và xuất receipt metadata

**Đã thử:** `/herdgate-arm` và `/herdgate-receipt <id>` trong cùng Pi TUI. Prototype dùng scope
của một runtime, hủy intent trực tiếp khi `session_tree`/đổi session, chứ chưa định danh hay xác minh
host/Herdr pane cho caller bên ngoài. Receipt kết thúc được lưu vào journal JSONL theo workspace
(giới hạn vài trăm mục, mode 0600) nên sống qua `/reload` và restart Pi. Publisher có thể
trả lời frame `receipt.get` từ thiết bị đã pair khi bật `HERDGATE_PI_RECEIPTS=1` (đã thử
qua Gate loopback; mặc định tắt).
Không đọc lại transcript để biến intent của epoch cũ thành `replied`.
Danh sách dưới đây phân biệt thiết kế đầy đủ hơn với lát cắt đã thử.

1. **Opt-in rõ ràng**, chỉ trong workspace thử; không đặt extension vào đường dẫn Pi tự phát hiện
   trong gói npm/ZIP, không thay `herdr-agent-state.ts` hay Pi settings. Herdgate 0.9.31 tự đồng bộ
   **skill**, không bật observer. Không có CLI gửi/hủy, agent tự khởi chạy, listener hoặc cron.
2. **Arm từ trong Pi đích** khi `ctx.isIdle()` và `!ctx.hasPendingMessages()`. Lưu intent
   có deadline, dùng UUID mới, rồi người dùng mới gửi thử; ghim
   `{worker, epoch, sessionId, treeGeneration, baselineLeafId}`. Arm không khóa input tay.
   Một intent đang hoạt động mỗi worker. Worker thuộc host/Herdr session/pane/terminal đã được xác minh
   host-local; pane ID không phải danh tính worker. Tạo epoch ngẫu nhiên ở `session_start`, vô hiệu tại
   `session_shutdown` và không tái kích hoạt intent cũ. Tăng generation khi có `session_tree`.
   Nếu chưa xác minh được binding, không báo receipt cho target đó. MVP receipt không có ý nghĩa
   xác thực trước process khác cùng user.
3. **Đối chiếu phần nhánh mới.** Từ leaf lần ngược `parentId` tới baseline, có giới hạn số entry;
   baseline không còn trong ancestry, quá giới hạn hoặc binding đổi → `unknown`. Chỉ nhận đúng một
   `message:user` mới có marker chính xác ở dòng đầu; không nhận marker từ custom message,
   reasoning hay tool output. Nếu `turn_end` đã ghi nhận `requestEntryId`, phải khớp lại ID đó
   ở settle; nếu chưa, có thể xác nhận lần đầu ở settle. Nếu lượt settle đầu tiên sau arm không có
   marker, hoặc có user message khác hay duplicate marker trong suffix, kết thúc `unknown`,
   không chờ lượt sau dùng lại marker. Nếu không có settle trước deadline (ví dụ hook consume input),
   báo `unknown`, không suy ra chưa gửi. Không dùng timestamp để gán lượt.
4. **Kết quả tại `agent_settled`.** Nếu correlation còn nguyên, `aborted: true` → `canceled` kể cả
   khi đã có reply. Nếu không abort, ứng viên là assistant entry cuối sau request: `stop` + text
   không rỗng + không tool call chờ + không bị loại/sửa khỏi projection → `replied`;
   `error`/`length` cuối → `failed` với mã lý do, không lấy reply trước thay thế. Thiếu bằng chứng
   hoặc cấu trúc chưa hỗ trợ → `unknown`. MVP nên báo `unknown` nếu suffix có compaction,
   `context_edit` chạm request/ứng viên trả lời, hoặc một `custom_message` can thiệp vào lượt mà
   observer không phân loại được. Observer không diễn giải lại context như Pi. `received` nghĩa
   branch đã có entry, không phải provider ack, xác thực nguồn nhập, hay cam kết fsync.
5. **Ghi metadata có giới hạn** vào journal JSONL riêng theo workspace (0600, giữ vài trăm mục
   mới nhất, chỉ ID/phase/lý do/entry ID). Đã triển khai trong prototype; hạn chế hiện tại:
   một journal mỗi workspace dùng chung cho mọi runtime cùng mở, compaction dùng lock file,
   chưa nghiệm thu trên Windows (đổi file khi reader đang mở). Intent dở dang bị ghi
   `unknown/runtime_changed` khi runtime thay; kill -9 không kịp ghi thì truy vấn sau là
   `unknown`. Nếu controller mất kết nối, chỉ báo **chưa biết** ở controller. Đã có đường
   truy vấn opt-in `receipt.get` qua device frame (mặc định tắt); chưa có push/subscribe.
   Không kích hoạt gửi lại.

### Điều phối và UI chỉ làm sau

Hiển thị riêng `Herdr submitted` / `Pi received` / `Pi replied|failed|canceled|unknown`;
không nâng một trạng thái thành trạng thái khác. Nếu sau này thêm CLI gửi, ghi intent trước khi gửi,
kiểm tra lại epoch/binding lúc gửi và không coi kiểm tra trước khi gửi bytes là thao tác atomic:
worker có thể đổi sau lần kiểm. Chặn resend trong phạm vi journal còn giữ ID; không tuyên bố exactly-once.
Không gửi phím hủy nếu worker hoặc request đã đổi. Plugin Herdr bắt đầu bằng pane tổng quan chỉ đọc.
Nếu cần guaranteed admission, queue/replay sau crash hay scheduling, đánh giá worker riêng qua RPC/SDK
hoặc Durable; đừng thêm chúng vào observer. Không mở shell/SFTP hoặc thêm RPC Mobile để lấy receipt;
[ranh giới remote](HERDGATE_PI_OBSERVATION.md) vẫn áp dụng.

**Worker riêng (prototype đã làm):** `experiments/pi-worker/worker.mjs` drain queue local
(`plugin/server/pi-worker.mjs` giữ định dạng file; publisher admit qua `worker.submit`
khi `HERDGATE_PI_WORKER=1`, chỉ scope act) và chạy từng request bằng Pi SDK — một session
một job, pid-lock, drain xong exit. Admission idempotent theo UUID; worker chết giữa chừng
→ `unknown/worker_restarted`, không gửi lại; job kế tiếp vẫn chạy. Receipt ghi chung journal
của observer nên `receipt.get` trả được. Prototype chỉ dùng provider fixture; chưa có
provider/tool thật, multi-workspace, push, hay đánh giá `pi-durable`.

### Mốc nghiệm thu đề xuất

- **Offline (đã làm):** 12 ca lifecycle và 4 ca observer qua SDK; unit test marker trùng/sai session, tool nhiều bước, branch vòng lại, timeout, cách ly hai worker, journal bền có giới hạn và tách workspace. Pi TUI riêng qua PTY cũng đã qua luồng `armed → replied` với provider giả. **Chưa làm:** observer bị kill -9 giữa chừng, đứt Gate qua hai máy thật, Windows. Không dùng transcript thật làm fixture.
- **E2E loopback (đã làm):** [test qua Gate](../../test/pi-receipt-gate.test.ts) gửi từ Herdr remote TUI tới Pi đích qua SSH/WebSocket thật; đối chiếu đủ hai dòng và Unicode. Ngắt client sau `received`, cho Pi settle, nối lại thấy `replied` cho đúng request/entry ID với chỉ một lần gọi provider. Marker sai → `unknown`; Escape → `canceled`; reload → `unknown`. Không restart host hoặc publisher đang dùng.
- **Worker queue (đã làm, prototype):** [test/pi-worker.test.ts](../../test/pi-worker.test.ts) và giai đoạn "owned worker" trong E2E Gate: submit từ device frame không cần TUI (scope act), duplicate id không chạy lại, submit khi worker tắt rồi khởi động sau vẫn chạy, SIGKILL giữa provider call → `unknown/worker_restarted` và job kế tiếp vẫn chạy, worker thứ hai bị pid-lock từ chối. Provider fixture; chưa nghiệm thu Windows/hai máy thật.
- **Scheduler/heartbeat/MCP (đã làm, prototype):** bucket deterministic idempotent qua restart (unit + E2E `worker.health` đúng depth/heartbeat, bucket kế tiếp enqueue run mới); MCP stdio server đủ 4 tool qua đúng channel device (act mới submit được, read bị `requires-act`). Chưa có PWA act UI, provider thật, multi-workspace; Windows chưa thử.
- **Live trên hai máy (chưa làm):** thử một advisor và một committee trong phiên riêng; hủy một worker không ảnh hưởng worker kia. Thử handoff sang Pi pane/worktree mới và báo riêng đường nào đã kiểm.
- **Portable:** thử độc lập trên Windows và ít nhất một host SSH/macOS/Linux; phát hiện binary từ môi trường/PATH, không mang path, ID, transcript hay credentials giữa các máy. Khi qua SSH, đọc dữ liệu phiên trên host sở hữu nó.

## Căn cứ và giới hạn bằng chứng

- Đối chiếu [Herdr agent automation v0.9.5](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/agent-automation.mdx), [plugins](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/plugins.mdx) và [session state/restore](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/session-state.mdx).
- Pi 1.5.2: `docs/extensions.md`, `docs/rpc.md`, `docs/sdk.md`, `docs/session-format.md`; thứ tự hook/append/settle trong `dist/core/agent-session.js`, cách ghi JSONL và projection trong `dist/core/session-manager.js`. RPC dispositions chỉ đối chiếu tài liệu, probe dùng SDK chứ không mở RPC subprocess.
- So sánh hợp đồng công khai của Paseo: [orchestration](https://paseo.sh/docs/orchestration.md), [SDK events](https://paseo.sh/docs/sdk/events.md), [profiles](https://paseo.sh/docs/agent-profiles.md), [workspaces](https://paseo.sh/docs/workspaces.md), [schedules/heartbeat](https://paseo.sh/docs/schedules.md), [connectivity](https://paseo.sh/docs/connectivity.md).
- JSONL helper vẫn là bằng chứng về transcript, không phải chứng cứ settle; các kiểm tra trước đó có probe chỉ đọc ở Windows với ID chưa gửi. Kết quả SDK/TUI dùng provider giả trên Linux, gồm gửi/hủy/reconnect qua Gate loopback; chưa kiểm production, Windows hay hai host vật lý. Đóng gói skill không bật hay cấp quyền vận hành runtime.
