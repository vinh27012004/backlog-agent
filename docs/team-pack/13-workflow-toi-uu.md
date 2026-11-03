# 13 · Workflow candidate

Triển khai 31/10/2026; 03/11 rút còn một luồng (bỏ gate, reviewer, solver, verifier, pre-gate và vòng sửa), rồi sau
J56ZZWSS bỏ cả worker evidence riêng của item tier strong: một fixer làm từ code tới evidence.

## API và trách nhiệm

| Tool | Hành vi |
|---|---|
| prepare_item | Job Start Work, materials, worktree/setup/index, profile/models/timeBox và paths viết brief; chờ job tới 25 s nên thường trả kết quả luôn |
| worker_checkpoint | ready_for_evidence/candidate nhường quyền ghi; ready_for_evidence tự sync worktree rồi mở ghi lại (xung đột hay cài lại dependency thì chờ root); candidate (sau khi ghi fix-result) kiểm fix-result mới nhất, submit.json và cấu hình test, có lỗi thì giữ worker ghi tiếp (`handedOff:false`); resume mở lại; root đăng ký threadId |
| next_actions | Hàng đợi có tham số và waitMs theo release/deadline: prepare_item, spawn_worker, sync_before_evidence, refresh_candidate, publish_item, submit_work, stop_worker. wait_for_update trả cùng danh sách nên root chỉ vòng wait_agent → wait_for_update |
| publish_item | Job single-owner: ghi candidate từ fixResultFile, đếm verification, integrate, push, submit idempotent; chờ job tới 25 s (thường 10–15 s là xong) |

Mỗi item một team_fixer. Root thực hiện native agent operations và Company Tools lookup; helper không thêm agent CLI.
Proxy của worker chỉ có read_item, job_status, worktree status và worker_checkpoint, không Company Tools/publish.

## Candidate và phiên bản

Mỗi bàn giao là <ID>-fixer-<version>.json mới, tách số spawn. Ghi tạm rồi rename. Runtime validate strict schema, path
trực tiếp trong results/ và symlink. RESULT_INVALID chỉ field; RESULT_MUTATED chặn ghi đè. candidateId bind hash kết
quả, source/environment và answer tree; sửa gì sau bàn giao thì CANDIDATE_STALE.

Khi ghi candidate, helper kiểm (`match/answers.mjs`, `env/evidence.mjs`) và chỉ báo lại, không chặn: submit.json theo
template/schema, mỗi requirement đúng một entry, PASS scenario có verification.check bằng scenario ID và evidence MVS
đòi, evidence mô tả item đòi, evidence cũ so với source/environment. Không gì chặn ở bước này: lỗi mà worker luôn tự sửa
được (fix-result sai schema, submit.json hỏng hay sai schema/template, đổi cấu hình test) đã bị giữ lại ở
worker_checkpoint candidate. File test có sẵn bị sửa chỉ là cảnh báo (đề cho sửa test mâu thuẫn, kèm giải thích).

Snapshot loại answers/ và challenge/ (file BTC phát, không chạy trong app); environment hash env files, marker dependency, runtime/commands và biến build/test liên quan,
không xuất secret. Hậu tố database theo trận/item và virtualStoreDir không tính, nên checkout chính và worktree cùng
source có cùng fingerprint; app dùng lại bản build cùng snapshot (05 §5.23).

BACKLOG_TESTS (bước verification của publish) đếm testResults của submit.json, không có thì requirements của fix-result,
answer_only thì kết quả kiểm schema/source. Kịch bản chưa ghi không PASS; last-chance nộp với FAIL/NOT_RUN trung thực.

## Evidence và recovery

download nằm cùng capture_evidence/profile/login; listener trước click, chờ completed HTTP/Blob localhost, tối đa 5MB,
giữ bytes/BOM/CRLF, trả path/bytes/sha256. Timeout/cancel có failedStep/page state. waitFor: visible/hidden/enabled.
context có backlogItemKey, matchRoot, scenario, appMode, phase before_fix/final. Manifest ở .team-work/evidence/<ID>.json
giữ source/environment/worktree/scenario/mode/time/hash. App helper có snapshot: sai mode/worktree hoặc app cũ bị từ chối.
Publish báo bytes đổi/final stale; before-fix riêng.

Publish ghi checkpoint từng bước. integratedWorktreeHead tránh tích hợp trùng; integratePlan lưu source/parent/cursor
trước mỗi cherry-pick và nhận diện commit đã xong trước mất checkpoint. Divergence dừng và giữ trạng thái.
Remote đổi mà rebase sạch thì push tiếp. Main phải khớp candidate đã bàn giao ở file của item;
publishedCandidateId gắn revision đã push. Intent lưu trước POST và replay cùng body/key/SHA; chưa rõ kết quả chặn sửa
candidate/sync, receipt có rồi không POST lại. Job ID có runId, thread/job RAM không được coi còn sống sau restart.

## Đo và kiểm

journal.metrics: prepare, code_test, evidence, handoff, publish; jobs: worktree_setup/publish_item/drop_databases.
dispatchMs từ lúc helper quan sát item tới Start Work, không phải release server. usage.mjs xuất bảng
giai đoạn/token/credit/thread; không cộng hoạt động song song thành thời gian toàn trận. Chạy
node --test "tests/pack/*.test.mjs" với git/PowerShell/browser; replay và chấm lại cùng bộ đề sau cài pack mới.
