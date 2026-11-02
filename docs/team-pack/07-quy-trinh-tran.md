# 07 · Quy trình trận

Cập nhật 31/10/2026; hợp đồng chi tiết ở [13](13-workflow-toi-uu.md).

## 1. Tổng quan thời gian
Giữ mục tiêu PREPARE khoảng 7 phút, hard budget helper 8 phút và hợp đồng Player.
GAME ưu tiên PI, deadline ít slack, shared baseline/layout, điểm rồi BUG > CR > TASK.
Tối đa bốn item code thường song song; PI và answer_only có thể bắt đầu ngay.
Dưới bốn phút không mở item thường mới; dưới hai phút tập trung publish candidate sẵn sàng.

## 2. Chuẩn bị
Configure frame, prepare_checkout, setup_environment và login_match song song; kiểm doctor/build/baseline/index.
report_ready rồi kết thúc lượt PREPARE. Không thêm coding-agent CLI hoặc đưa credential cho worker.

## 3. GAME
Configure frame GAME, login_match, refresh_match, company_tools, next_actions.
prepare_item trả materials/worktree/profile/timeBox/models, root lookup facts liên quan rồi brief worker.
Answer-only có solver độc lập từ đầu. Root chỉ dùng cơ chế agent native, helper không tự spawn.

## 4. Handoff và kiểm tra
Trước final evidence worker yield; root sync ở checkpoint, đợi setup nếu cần rồi cho resume.
Worker ghi fix-result mới, candidate_preflight gom tất cả việc thiếu.
Đủ điều kiện thì helper gate và reviewer chạy song song; answer_only dùng solver, không reviewer/verifier mặc định.
result_handoff validate/bind review/solver. Sửa answer/evidence thì tiếp tục worker cũ; code thất bại thì cân nhắc worker mới.

## 5. Publish
publish_item thực hiện verification -> integrate -> main gate khi cần -> push -> submit.
Mỗi bước lưu checkpoint; dừng khi lỗi. Main đổi yêu cầu sync worker đã yield và kiểm lại phần mất hiệu lực.
Remote rebase dù không conflict vẫn dừng GATE_STALE; không push snapshot chưa gate/review.
Intent chưa rõ kết quả replay trước khi sửa candidate. Receipt có rồi không nộp lại.
Không tự sửa git/main/journal hoặc kill process không thuộc thao tác helper.

## 6. PI
Attempt tối đa 12 phút, checkpoint phút sáu hoặc ngắn hơn theo deadline.
Chưa xác nhận giả thuyết thì trả partial/hypotheses; checker chỉ kiểm từng giả thuyết.
Root lấy recent_changes và company logs/facts. PI đổi code cần test mới fail-before; chỉ đổi answers không cần reproduction.
Reviewer chạy cùng gate. decide root_cause_confirmed là advisory, hard gate và last-chance thắng.

## 8. Answer và evidence
Giữ template/schema, đúng tên và nội dung evidence MVS. Download lấy bytes trình duyệt, không sinh lại CSV từ source.
Capture có context scenario/worktree/appMode/phase; manifest giữ source/environment/hash/time.
Before-fix và final riêng biệt. Reviewer vẫn mở file kiểm nội dung.
Worktree item có database dev riêng (migrate + seed khi tạo), nên item không chờ nhau; DB dùng chung (checkout chính)
mới giữ app_data lock từ seed đến capture. Không tiếp tục trên dữ liệu hỏng.
answer_only kiểm schema/source/derivation/solver/gate; không bịa số scenario.

## Recovery và cơ hội cuối
Resume không coi native thread/job cũ còn sống: dùng journal/git/server, dựng lại proof còn thiếu.
Last-chance có lý do rõ khi không còn thời gian: code gate vẫn phải hợp lệ, FAIL/NOT_RUN hoặc derivation chưa đủ
chứng cứ phải ghi trung thực. Không bịa PASS, evidence hoặc solver agreement; thiếu file bắt buộc vẫn bị chặn.
Auto-review rejection không được lách; dùng đường hợp lệ nếu có, nếu không ghi FAILED item và tiếp tục.
Không chờ người trả lời trong trận. FINISHED/CANCELLED ghi ORCHESTRATOR_ENDED nếu kịp rồi kết thúc.
