# 13 · Workflow candidate và tối ưu agent

Triển khai 31/10/2026; chưa benchmark tốc độ trên một trận LLM mới.

## API và trách nhiệm

| Tool | Hành vi |
|---|---|
| prepare_item | Job Start Work, materials, worktree/setup/index, profile/models/timeBox và paths viết brief |
| worker_checkpoint | ready_for_evidence/candidate nhường quyền ghi; ready_for_evidence tự sync worktree rồi mở ghi lại (xung đột hay cài lại dependency thì chờ root), có testsAdded thì chạy pre-gate; resume mở lại; root đăng ký threadId |
| candidate_preflight | Validate contract/claims/answer/evidence/fingerprint; candidateId, reviewScope và repair.todo hợp nhất; chỉ còn sửa evidence/answer thì chạy pre-gate |
| run_gate / job_status | Helper chạy/chờ gate, không cần verifier LLM quản lý job |
| result_handoff | Validate và bind review/solver/hypothesis/arbitration vào candidate, lỗi chỉ field |
| next_actions | Hàng đợi có tham số và waitMs theo release/deadline; pre_gate_failed, spawn_evidence_worker |
| publish_item | Job single-owner: verification, integrate, main gate khi cần, push, submit idempotent |

Code item mặc định worker + reviewer; answer_only worker + solver độc lập. Reviewer sở hữu ý nghĩa MVS và nội dung
evidence, helper kiểm phần tất định. PI/tranh chấp có thể thêm checker. team_verifier còn cho tương thích/điều tra riêng.
Root thực hiện native agent operations và Company Tools lookup; helper không thêm agent CLI. Proxy worker chỉ có
read_item, run_gate, job_status, worktree status và worker_checkpoint, không Company Tools/publish.

## Candidate, retry và proof

Mỗi bàn giao là <ID>-fixer-<version>.json mới, tách số spawn. Reviewer/solver/pi_hypothesis/arbitration cũng có version.
Ghi tạm rồi rename. Runtime validate strict schema, path trực tiếp trong results/ và symlink. RESULT_INVALID chỉ field;
RESULT_MUTATED chặn ghi đè. Helper trả nextFixResultFile. candidateId bind hash kết quả, source/environment và answer tree.
Review không bind lại cho candidate khác. Delta review giữ source approval còn hợp lệ nhưng vẫn xem evidence mới.

Mỗi requirement đúng một entry; PASS scenario có verification.check bằng scenario ID. Preflight gom mọi việc thiếu
từ worker, answer/evidence, gate và review high. Answer/evidence repair thường followup worker cũ, keepImplementation,
time box ngắn; code thất bại/đổi giả thuyết/model escalation mới cân nhắc worker mới. Yield trước sync/capture final.

Proof code chỉ tái dùng khi source/test/dependency/config/môi trường/policy khớp. Snapshot loại answers/; environment
hash env files, marker dependency, runtime/commands và biến build/test liên quan, không xuất secret. Hậu tố database
theo trận/item mà helper gắn vào DATABASE_URL/TEST_DATABASE_URL và virtualStoreDir (đường dẫn tuyệt đối) không tính, nên
checkout chính và worktree cùng source có cùng fingerprint (NBDB5U0O: PI-01, TASK-03, TASK-04 cùng source tree mà vẫn
chạy ba gate đầy đủ 52–69 s). Guard/answer/schema/evidence/requirements vẫn kiểm lại. Reproduction chưa đạt không trở
thành cache pass. Proof chung cho answer_only chỉ khi snapshot khớp và diff chỉ thuộc answers item đó. Bản build
production thành công của đúng snapshot (app evidence hay gate trước) cho gate bỏ bước build khi test không đọc thứ build
sinh ra (05 §5.10). Pre-gate (test, fail-before, tái hiện; không build, không typecheck, không answer) chạy trong lúc
worker chụp evidence và lưu testProof theo snapshot + policy; gate của candidate cùng snapshot/policy chỉ còn
typecheck và build. Policy chuẩn hoá thứ tự test và khoá test_change. Dịch vụ/DB ngoài có thể đổi mà fingerprint không
thấy; khi nghi ngờ phải chạy lại gate. Invalidation bảo thủ theo toàn source, chưa dùng dependency graph.

Verification tách mvs (testResults thật + gate), acceptance (check/requirement có tên + gate), answer_only
(schema/source, independent derivation/đủ field và code proof/gate). BACKLOG_TESTS đếm kiểm tra được nêu rõ,
không gọi answer_only là scenario. Inconclusive không PASS; last-chance có thể nộp với UNVERIFIED trung thực khi code
gate hợp lệ, không bịa kết quả hoặc bỏ file evidence bắt buộc.

## Evidence và recovery

download nằm cùng capture_evidence/profile/login; listener trước click, chờ completed HTTP/Blob localhost, tối đa5MB,
giữ bytes/BOM/CRLF, trả path/bytes/sha256. Timeout/cancel có failedStep/page state. waitFor: visible/hidden/enabled.
context có backlogItemKey, matchRoot, scenario, appMode, phase before_fix/final. Manifest ở .team-work/evidence/<ID>.json
giữ source/environment/worktree/scenario/mode/time/hash. App helper có snapshot: sai mode/worktree hoặc app cũ bị từ chối.
Preflight phát hiện bytes đổi/final stale; before-fix riêng. Reviewer vẫn mở file; artifact thủ công/cũ chưa có manifest
không được tự nhận provenance như capture helper.

Publish ghi checkpoint từng bước. integratedWorktreeHead tránh tích hợp trùng; integratePlan lưu source/parent/cursor
trước mỗi cherry-pick và nhận diện commit đã xong trước mất checkpoint. Divergence dừng và giữ trạng thái.
Remote rebase luôn vô hiệu gate/dừng GATE_STALE trước push tiếp. Main phải khớp candidate được review;
publishedCandidateId gắn revision đã push. Intent lưu trước POST và replay cùng body/key/SHA; chưa rõ kết quả chặn sửa
candidate/sync, receipt có rồi không POST lại. Job ID có runId, thread/job RAM không được coi còn sống sau restart.

## Đo và kiểm

journal.metrics: prepare, code_test, evidence, handoff, publish; jobs: gate/setup. dispatchMs từ lúc helper quan sát
item tới Start Work, không phải release server. usage.mjs xuất bảng giai đoạn/token/credit/thread; không cộng hoạt động
song song thành thời gian toàn trận. Chạy node --test "tests/pack/*.test.mjs" với git/PowerShell/browser; replay và chấm lại
cùng bộ đề sau cài pack mới. Khoảng 10 thay vì 23 subagent là mục tiêu W4T85TGM, không phải kết quả đo hay trần cứng.
