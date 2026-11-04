# 01 · Kiến trúc hiện hành

Cập nhật 03/11/2026. Chi tiết API và recovery: [13 · Workflow candidate](13-workflow-toi-uu.md).

## Thành phần
MTM Player sở hữu một phiên Codex root. Subagent chỉ tạo bằng cơ chế native, không thêm coding-agent CLI.
Helper Node.js dùng built-in, giữ credential/API/git/journal/progress/jobs; codegraph là MCP riêng do installer cài.

```text
MTM Player -> team_orchestrator
               |-> team_runtime: prepare -> publish
               |                 journal / events / progress / evidence manifest
               |-> mỗi item: một team_fixer, worktree riêng
```

Root giao việc, lookup Company Tools và thực hiện thao tác agent native. Helper trả nextActions có thứ tự.
Worker sửa code, chạy test, chụp evidence và ghi fix-result; helper kiểm fix-result, submit.json và cấu hình test ở
checkpoint candidate, rồi nộp nguyên kết quả đó, kiểm answer/evidence chỉ ra cảnh báo. 03/11 bỏ team_reviewer, team_pi_hypothesis, team_verifier và gate cho đơn giản (bản cũ ở git).

## Quyết định thiết kế

| ID | Bất biến |
|---|---|
| D1 | Một phiên Codex do Player sở hữu, chỉ subagent native. |
| D2 | Runtime/installer dùng Node.js built-in; không thêm npm dependency. |
| D3 | Root mỏng, helper giữ logic tất định và trạng thái. |
| D4 | Helper root là một writer, giữ credential. Proxy worker: read_item, job_status, worktree status, worker_checkpoint, company_lookup (từ 04/11: tra cứu Company Tools chỉ đọc; key vẫn chỉ ở helper root, kết quả lưu ở items/<ID>/company/). Tool công ty không phải tra cứu vẫn chỉ root gọi (company_call). |
| D5 | Frame qua configure_session, credential không vào brief/log/file. |
| D6 | Worktree riêng, tích hợp tuần tự vào branch được giao, không force push. |
| D7 | Submit intent lưu trước POST, replay cùng body/key/SHA; receipt có rồi không nộp lại. |
| D8 | Progress một writer, schema và ngân sách byte; metrics/manifest nằm ngoài progress. |
| D9 | Jev có fallback/cờ tắt, chỉ quyết định triage và tier model; luật cứng ở code. |
| D10 | Một worker mỗi item; kết quả bàn giao được nộp nguyên (03/11, trước đó worker + reviewer/solver). |
| D11 | Publish đúng snapshot đã bàn giao; push bị từ chối thì rebase, sạch thì push tiếp. |
| D12 | Giả định bị kill bất cứ lúc nào; journal/git/server là nguồn bền, thread/job RAM không còn sau restart. |
| D13 | Workspace phải trust để Codex nạp config. |
| D14 | Guardrail code, execpolicy, prompt và kiểm path/symlink cùng bảo vệ phạm vi trận. |

## Candidate và recovery
Mỗi bàn giao là một file kết quả bất biến có version mới, tách khỏi số lần spawn.
publish_item validate schema của fix-result, kiểm answer/evidence (chỉ cảnh báo) rồi nộp.
Worker nhường quyền ghi trước sync/final evidence.

publish_item có checkpoint verification/integrate/push/submit. Integration có kế hoạch bền và dấu
cherry-pick để nhận ra commit đã tạo trước lúc mất checkpoint. Intent chưa rõ kết quả phải replay trước khi sửa candidate.

Mục tiêu khoảng 10 thay vì 23 subagent áp dụng bộ đề W4T85TGM, không phải giới hạn cứng hay benchmark đã đạt.
Đo lại wall-clock/credit và chấm lại độ đúng trước kết luận tăng tốc. Hợp đồng ngoài theo nguồn BTC/Player.
