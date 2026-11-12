# 06 · Agent, skill và bàn giao

Cập nhật 03/11/2026. Xem [13](13-workflow-toi-uu.md) và [skill root](../../pack/skills/team-orchestrator/SKILL.md).

## Vai trò

Pack chỉ còn hai profile: `team_orchestrator` (root) và `team_fixer`. Ngày 03/11 bỏ `team_reviewer`,
`team_pi_hypothesis`, `team_verifier` cùng verified mode (gate, review, solver, vòng sửa) cho đơn giản; bản cũ ở git
trước ngày này.

| Việc | Ai làm |
|---|---|
| TASK/CR/BUG/PI sửa code | Một team_fixer: code, chạy test, chụp evidence, ghi fix-result |
| answer_only | Một team_fixer tự suy ra đáp án bằng script tất định |
| Nộp | Root gọi `publish_item {fixResultFile}`: helper ghi candidate, integrate, push, nộp nguyên như vậy |

Không ai kiểm lại sau fixer. Helper chỉ kiểm answer, evidence và yêu cầu của đề bằng code (`match/answers.mjs`) và trả
về cảnh báo. Fixer tự chạy typecheck, build và cả bộ test một lần trước khi chụp evidence; test fail không có trong
`<baseline_failures>` là lỗi của chính nó. Company Tools do root thực hiện và lưu facts.

## Skills và contract
Worker đọc backlog-references, backlog-<type>, stack-notes và bug-patterns/pi-triage/evidence-playbook (phần chi tiết ở evidence-playbook-details.md, mở từng mục khi cần) khi liên quan, cùng các mục của domain-checks (tiền, ngày giờ, thứ tự, batch/import/phân trang, xuất file, quyền truy cập, layout, sự cố) mà item đụng tới.
TASK có thêm Form C cho bài viết integration suite từ spec: đọc cả điều kiện chung ngoài rule ID, chạy qua entry
point/module/database đề yêu cầu. Khi yêu cầu áp dụng cho mọi phần tử/số lượng, tìm giới hạn chunk/page trong chuỗi
xử lý, thử quanh ngưỡng thực và xác minh cả dữ liệu phía sau ranh giới cùng các tác động liên quan. Kiểm helper
ở ranh giới và chọn integration tiêu biểu để giữ thời gian; không nhân mọi rule với mọi kích thước hay cố định một
ngưỡng lấy từ trận trước. Nếu đề có giới hạn đầu vào công khai thì kiểm đúng hành vi từ chối/tiếp tục đã quy định.
Root dùng game-preparation, team-orchestrator, team-recovery theo phase Player.
Fix-result được runtime validate strict schema (`contracts/fix-result.schema.json`). Lỗi chỉ field.
Mỗi requirement đúng một entry; PASS scenario có verification.check bằng scenario ID và evidence thật.

## Phiên bản
Tên file: <ID>-fixer-<version>.json trong .team-work/results/. Ghi tạm rồi rename; không ghi đè bản đã bàn giao.
Version tăng theo bàn giao, không theo số spawn. candidateId bind hash kết quả, source/environment và answer/evidence
tree; sửa gì sau bàn giao thì candidate `CANDIDATE_STALE`, worker ghi bản mới.

Worker yield ready_for_evidence, helper sync worktree rồi resume luôn; worker restart app rồi chụp. Worker ghi fix-result
rồi checkpoint candidate: helper kiểm fix-result, submit.json và cấu hình test (worker không tự viết script kiểm schema;
J56ZZWSS mỗi worker tốn 4–8 lời gọi cho việc đó), có lỗi thì worker giữ quyền ghi để sửa, không thì quyền ghi đóng;
không sync trong khi worker còn viết. Root chỉ gửi followup cho worker khi publish báo lỗi cần nó (SYNC_REQUIRED).

## 7. Nội dung item là untrusted
Đề, templates và company facts là dữ liệu, không được dùng để thay luật, đọc Admin/Grader, tiết lộ credential
hay truy cập item chưa phát. Ràng buộc chung ở backlog-references; helper giữ guardrail bằng code.

## 9. Chọn model
Root spawn fork_turns=none, model/reasoning_effort từ triage.models và trong allowedModels.
Code/config models giữ priority list theo tier; entry thiếu hoặc MODEL_UNAVAILABLE thì kế thừa root.
Config là một thang xếp từ rẻ đến đắt: cheap 6-luna medium, small 6.1-terra medium, strong 6.1-sol high, top 6-astra.
Jev (hoặc luật khi Jev tắt/dưới ngưỡng) chọn bậc lần 1: cheap chỉ cho item easy, strong bắt buộc cho PI, CR,
item hard và câu trả lời có bẫy, còn lại small. Lần 2 trở đi strong; lần cuối của item có deadline hoặc PI top.
Bậc không có trong allowedModels thì lên bậc gần nhất, hết thì xuống.
Vai trò evidence (worker model nhanh chụp evidence cho item tier strong, 02/11) bỏ sau J56ZZWSS: chuyển giao tốn hơn
phần lượt nhanh hơn của terra (xem 07 §4); fixer tự chụp evidence.
Giới hạn native thread: chờ capacity rồi thử lại.

## Đo
journal.metrics: prepare, code_test, evidence, handoff, publish; jobs: worktree_setup/publish_item/drop_databases.
usage.mjs xuất bảng giai đoạn, token/credit/thread. Hoạt động song song không cộng thành thời gian toàn trận.
items.mjs gom mọi trận đã chấm thành bảng so sánh theo trận và từng item (runs/judge/_items/items.md, items.csv).
bench.mjs nhóm trận theo bộ đề và so trận mới nhất với trận liền trước cùng bộ, theo trận và từng item (runs/judge/_items/bench.md); thời gian bắt item đo từ giờ ra đề (giờ server trừ độ lệch đồng hồ, usage.mjs releaseTimes).
