# 01 · Kiến trúc hiện hành

Cập nhật 31/10/2026. Chi tiết API, cache và recovery: [13 · Workflow tối ưu](13-workflow-toi-uu.md).

## Thành phần
MTM Player sở hữu một phiên Codex root. Subagent chỉ tạo bằng cơ chế native, không thêm coding-agent CLI.
Helper Node.js dùng built-in, giữ credential/API/git/gate/journal/progress/jobs; codegraph là MCP riêng do installer cài.

```text
MTM Player -> team_orchestrator
               |-> team_runtime: prepare -> preflight -> gate -> publish
               |                 journal / events / progress / evidence manifest
               |-> code item: team_fixer + team_reviewer, worktree riêng
               |-> answer_only: team_fixer + team_pi_hypothesis giải độc lập
```

Root giao việc, lookup Company Tools và thực hiện thao tác agent native. Helper trả nextActions có thứ tự.
Worker sửa code/test/answer/evidence. Reviewer kiểm source, ý nghĩa MVS và nội dung ảnh/CSV/log;
verifier tất định đã chuyển vào helper. Profile team_verifier còn để tương thích/điều tra được chỉ định,
không thuộc pipeline mặc định. PI khó hoặc tranh chấp đáp án có thể thêm checker.

## Quyết định thiết kế

| ID | Bất biến |
|---|---|
| D1 | Một phiên Codex do Player sở hữu, chỉ subagent native. |
| D2 | Runtime/installer dùng Node.js built-in; không thêm npm dependency. |
| D3 | Root mỏng, helper giữ logic tất định và trạng thái. |
| D4 | Helper root là một writer, giữ credential. Proxy worker: read_item, run_gate, job_status, worktree status, worker_checkpoint. Company Tools do root lookup. |
| D5 | Frame qua configure_session, credential không vào brief/log/file. |
| D6 | Worktree riêng, tích hợp tuần tự vào branch được giao, không force push. |
| D7 | Submit intent lưu trước POST, replay cùng body/key/SHA; receipt có rồi không nộp lại. |
| D8 | Progress một writer, schema và ngân sách byte; metrics/manifest nằm ngoài progress. |
| D9 | Jev có fallback/cờ tắt, không vượt hard gate. Workflow quyết định reviewer mặc định. |
| D10 | Worker + reviewer cho code; worker + solver cho answer_only. |
| D11 | Publish đúng snapshot có gate; rebase do push rejection luôn dừng để gate/review nguồn mới. |
| D12 | Giả định bị kill bất cứ lúc nào; journal/git/server là nguồn bền, thread/job RAM không còn sau restart. |
| D13 | Workspace phải trust để Codex nạp config. |
| D14 | Guardrail code, execpolicy, prompt và kiểm path/symlink cùng bảo vệ phạm vi trận. |

## Candidate và recovery
Mỗi bàn giao là một file kết quả bất biến có version mới, tách khỏi số lần spawn.
Preflight validate schema/claims/answer/evidence, trả toàn bộ repair.todo.
Worker nhường quyền ghi trước sync/final evidence; gate và reviewer chạy song song khi candidate đủ điều kiện.
Answer/evidence-only thường followup worker cũ; code thất bại/đổi giả thuyết/cần model mạnh hơn mới cân nhắc worker mới.

Code proof chỉ tái dùng khi source/test/dependency/config/môi trường còn khớp. Answer/evidence vẫn kiểm lại.
publish_item có checkpoint verification/integrate/main gate/push/submit. Integration có kế hoạch bền và dấu
cherry-pick để nhận ra commit đã tạo trước lúc mất checkpoint. Intent chưa rõ kết quả phải replay trước khi sửa candidate.

Mục tiêu khoảng 10 thay vì 23 subagent áp dụng bộ đề W4T85TGM, không phải giới hạn cứng hay benchmark đã đạt.
Đo lại wall-clock/credit và chấm lại độ đúng trước kết luận tăng tốc. Hợp đồng ngoài theo nguồn BTC/Player.
