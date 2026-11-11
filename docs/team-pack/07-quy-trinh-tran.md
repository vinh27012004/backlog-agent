# 07 · Quy trình trận

Cập nhật 03/11/2026; hợp đồng chi tiết ở [13](13-workflow-toi-uu.md).

## 1. Tổng quan thời gian
Giữ mục tiêu PREPARE khoảng 7 phút, hard budget helper 8 phút và hợp đồng Player.
GAME ưu tiên PI, deadline ít slack, shared baseline/layout, điểm rồi BUG > CR > TASK.
Tối đa năm item code thường còn cần worker (config/runtime.json, đổi ngay bằng team-sdlc-pack/local/runtime.json);
item đã bàn giao candidate, chỉ chờ publish, nhả slot.
PI và answer_only có thể bắt đầu ngay. Sau restart vẫn làm hết `next_actions`, kể cả `prepare_item`.
Dưới bốn phút không mở item thường mới; sáu phút cuối của item thì `next_actions` đưa lên đầu: dừng worker rồi
publish candidate đang có (thiếu evidence thì theo luật cơ hội cuối).
Không giữ evidence hay publish của item này để chờ item khác (kể cả bản sửa layout dùng chung) trừ khi MVS của chính
nó cần; main đổi ở file khác thì publish integrate luôn, chỉ sync khi hai bên cùng sửa một file.

## 2. Chuẩn bị
Configure frame, prepare_checkout, setup_environment và login_match song song; kiểm doctor/build/baseline/index.
report_ready rồi kết thúc lượt PREPARE. Không thêm coding-agent CLI hoặc đưa credential cho worker.

## 3. GAME
Configure frame GAME (từ 04/11 configure_session tự login, đọc backlog, bật poller, tự prepare và lấy danh sách Company
Tools, trả `boot`; hỏng thì root gọi login_match, refresh_match, company_tools), rồi vòng wait_for_update (trả cả nextActions; không gọi
thêm next_actions). Từ 04/11 đây là lệnh chờ duy nhất của root: không wait_agent; worker báo root qua worker_checkpoint
(ready_for_evidence, candidate, blocked {question}), không send_message; root nhắn worker bằng followup_task khi
nextActions bảo (answer_worker, stop_worker, sync_before_evidence, refresh_candidate) hay publish lỗi.
prepare_item trả materials/worktree/profile/timeBox/models, root lookup facts liên quan rồi brief worker.
Root chỉ dùng cơ chế agent native, helper không tự spawn.

## 4. Handoff
Mỗi item một `team_fixer` (03/11/2026 bỏ verified mode cùng reviewer, solver, verifier và gate). Worker code, chạy
typecheck, build và cả bộ test một lần (test fail không có trong baseline là regression của nó; chủ baseline sửa test
fail sẵn trước rồi báo `baseline_fixed`, item khác chờ bản sửa đó lên main trước khi publish, 13 §Test fail sẵn), ready_for_evidence
(helper sync rồi mở ghi lại), chụp evidence, ghi fix-result rồi checkpoint candidate (helper kiểm fix-result,
submit.json và cấu hình test; có lỗi thì worker sửa và ghi bản kế, khỏi vòng RESULT_INVALID qua root). Root gọi ngay
`publish_item {fixResultFile}`: helper ghi candidate, ghi BACKLOG_TESTS từ testResults của submit.json, integrate,
push, submit. Lỗi answer/evidence helper tìm thấy chỉ thành `warnings`/`answerWarnings`, không chặn.
PI và item chỉ trả lời (từ 04/11): helper tự publish ngay khi worker bàn giao (autoPublish, 13 §PI chỉ báo cáo); item
chỉ trả lời không cần worker viết fix-result, helper lập từ submit.json. Root chỉ gọi publish_item khi lần tự publish
hỏng.

Không còn worker evidence riêng cho item tier strong (bỏ sau J56ZZWSS, 03/11): cả ba lần chuyển giao ở trận đó chậm hơn
để một fixer tự làm (spawn terra lỗi capacity, worker mới đọc lại từ đầu, BUG-01 worker evidence vẫn phải sửa code vì
bản sửa chỉ đúng ở build production). Fixer không sửa cấu hình test: J56ZZWSS BUG-02 thêm `esbuild` vào
`vitest.config.ts`, TASK-02 nộp sau mang theo nên mất TASK-02-TC-04.

Lý do bỏ verified: trận 3OCNFC54 sau evidence còn ~2–3 phút reviewer mỗi item, BUG-01 lặp 5 vòng evidence ↔ preflight
(~10 phút). Đổi lại: không ai kiểm nội dung evidence sau worker (J5H1NBX4 CR-01 reviewer từng bắt lỗi bigint và control
bị sidebar che). Theo dõi bằng `/judge-practice`; luồng cũ ở git trước 03/11.

## 5. Publish
publish_item thực hiện verification (đếm) -> integrate -> push -> submit.
Mỗi bước lưu checkpoint; dừng khi lỗi. Main và item cùng sửa một file thì `SYNC_REQUIRED`: sync worker đã yield, chụp
lại phần bị ảnh hưởng, bàn giao bản mới. Remote đổi mà rebase sạch thì push tiếp; xung đột thì `PUSH_REJECTED`.
Intent chưa rõ kết quả replay trước khi sửa candidate. Receipt có rồi không nộp lại.
Không tự sửa git/main/journal hoặc kill process không thuộc thao tác helper.

## 6. PI
Attempt tối đa 12 phút, checkpoint phút sáu hoặc ngắn hơn theo deadline.
Chưa xác nhận giả thuyết thì trả partial/hypotheses.
Root lấy recent_changes và company logs/facts. PI đổi code cần test mới fail trên code chưa sửa (fixer tự kiểm); chỉ
đổi answers thì không cần. decide root_cause_confirmed là advisory.
PI chỉ báo cáo (Form A, 04/11): worktree không cài dependency, không index codegraph; helper kéo log mọi service vào
`company/timeline.json`, chép vào `answers/<ID>/evidence/`, brief có khối `<report_only_pi>` thay skill; fix-result
không bắt buộc (khi đó không có `hypotheses`, lập luận nằm trong incidentRecord); helper tự publish. Đích 1–2 phút.

## 8. Answer và evidence
Giữ template/schema, đúng tên và nội dung evidence MVS. Download lấy bytes trình duyệt, không sinh lại CSV từ source.
Capture có context scenario/worktree/appMode/phase; manifest giữ source/environment/hash/time.
Before-fix và final riêng biệt.
Worktree item có database dev riêng (migrate + seed khi tạo), nên item không chờ nhau; DB dùng chung (checkout chính)
mới giữ app_data lock từ seed đến capture. Không tiếp tục trên dữ liệu hỏng.
answer_only: helper kiểm schema/source của submit.json; không bịa số scenario.

## Recovery và cơ hội cuối
Resume không coi native thread/job cũ còn sống: dùng journal/git/server.
Last-chance có lý do rõ khi không còn thời gian: FAIL/NOT_RUN phải ghi trung thực. Không bịa PASS hay evidence.
Auto-review rejection không được lách; dùng đường hợp lệ nếu có, nếu không ghi FAILED item và tiếp tục.
Không chờ người trả lời trong trận. FINISHED/CANCELLED ghi ORCHESTRATOR_ENDED nếu kịp rồi kết thúc.
