# Đánh giá `@earendil-works/pi-durable` cho Pi worker — 2026-11-21

**Câu hỏi.** Job của pi-worker hiện fail-closed khi worker chết giữa chừng
(`unknown/worker_restarted`, không resend). pi-durable quảng cáo "process chết giữa
turn → mở lại storage → việc tiếp tục từ chỗ dừng". Có nên thay `SessionManager` của
worker bằng pi-durable để job sống sót crash không?

**Bằng chứng runnable.** `durable-probe.mjs` (cùng thư mục, chạy với
`PI_DURABLE_EVAL_DIR` trỏ dir có cài `@earendil-works/pi-durable@1.6.0` +
`pi-ai` + `chord` từ npm; provider faux của pi-ai, không mạng):

```
phase-a: submit (requestId hg-eval-1) → model gọi 1 lần → SIGKILL giữa stream (exit 137)
phase-b: reopen cùng SQLite → resume() → submit lại CÙNG requestId →
         {"status":"done","answerText":"DURABLE-RESUME-OK","modelCallsThisProcess":1}
```

Ba thuộc tính đều xác nhận: (1) turn bị gián đoạn được **retry và hoàn tất**, không
mất; (2) requestId idempotent — submit lại trả **cùng submission**, không lặp input;
(3) model gọi đúng 1 lần trong tiến trình mới (không chạy hai lần).

**Nhưng không phải drop-in — bốn khác biệt cốt lõi:**

1. **pi-durable là harness riêng, không phải pi-coding-agent.** Không bash/read/edit,
   không skills, không extensions Pi. Job worker hôm nay chạy *coding agent thật*
   (`--tools`, model host, skills). Muốn ngang phải viết lại toolset thành extensions
   pi-durable — dự án lớn và mất tương thích hệ sinh thái Pi.
2. **Transcript khác định dạng.** Toàn chuỗi receipt của worker dựa vào Pi session
   JSONL:
   `requestEntryId`/`responseEntryId`, body archive, `pi --session <file>` restore
   (pi-spawn). pi-durable ghi entries `pi.*` vào SQLite — lớp quan sát phải viết lại.
3. **Doctrine receipt đổi semantics.** Fail-closed khi restart là *trung thực*:
   "controller không biết job chạy tới đâu". Auto-resume cho owner kết quả tốt hơn,
   nhưng receipt phải ghi rõ resumed/số attempt (pi-durable có data này trong task
   state) — nâng cấp có điều kiện, không phải thay thế 1-1.
4. **Thành thạo API còn sớm.** Bản repo my-agent 1.4.0, npm 1.6.0, README ghi rõ
   "Experimental. The API changes without notice between releases." Dependency cốt
   lõi của worker không nên đứng trên nền đó lúc này.

**Những gì đáng mượn ngay — pattern, không cần đổi harness:**

- `requestId` idempotency == duplicate-id admission của worker (đã có; thiết kế hội
  tụ với Paseo/Pi-durable là tín hiệu đúng).
- **Ownership edge** (`createConversation` với owner task, con tự bị abort theo cha)
  == cơ chế "agent tự khai sinh cha" vừa land ở pi-spawn (`self` op, commit
  `9ae009c`). Xác nhận độc lập hướng thiết kế.
- Commit-before-show == journal-before-push của receipt (đã có).
- Retry limit chặn vòng "request giết process" — worker chưa có tương đương ở tầng
  job (systemd `Restart=on-failure` xử lý ở tầng tiến trình).

**Kết luận.** Giữ `SessionManager` + Pi SDK cho job worker — coding agent thật là giá
trị cốt lõi, chuỗi receipt/restore dựa trên session format Pi. pi-durable là lớp đúng
cho **controller/scheduler/daemon dài hạn mới** (task graph, sleep bền, background,
`onWake`): nếu làm scheduler prompt khung hay agent runtime thường trú, đặt pi-durable
*quanh* worker làm state machine, không thay session của từng job. Tái đánh giá khi
pi-coding-agent chính thức tích hợp durable resume cho `AgentSession`.
