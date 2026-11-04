# 13 · Workflow candidate

Triển khai 31/10/2026; 03/11 rút còn một luồng (bỏ gate, reviewer, solver, verifier, pre-gate và vòng sửa), rồi sau
J56ZZWSS bỏ cả worker evidence riêng của item tier strong: một fixer làm từ code tới evidence.

## API và trách nhiệm

| Tool | Hành vi |
|---|---|
| prepare_item | Job Start Work, materials, worktree/setup/index, profile/models/timeBox và paths viết brief; chờ job tới 25 s nên thường trả kết quả luôn |
| worker_checkpoint | ready_for_evidence/candidate nhường quyền ghi; ready_for_evidence tự sync worktree rồi mở ghi lại (xung đột hay cài lại dependency thì chờ root); candidate (sau khi ghi fix-result) kiểm fix-result mới nhất, submit.json và cấu hình test, có lỗi thì giữ worker ghi tiếp (`handedOff:false`); blocked {question} ghi câu hỏi cho root (sự kiện WORKER_BLOCKED, nextActions answer_worker) thay cho send_message; resume mở lại, đóng câu hỏi; root đăng ký threadId |
| next_actions | Hàng đợi có tham số và waitMs theo release/deadline: prepare_item, spawn_worker, sync_before_evidence, refresh_candidate, publish_item, submit_work, stop_worker. wait_for_update trả cùng danh sách và là lệnh chờ duy nhất của root (từ 04/11, không wait_agent); answer_worker khi worker gọi `worker_checkpoint blocked` |
| publish_item | Job single-owner: ghi candidate từ fixResultFile, đếm verification, integrate, push, submit idempotent; chờ job tới 25 s (thường 10–15 s là xong) |

Mỗi item một team_fixer. Root thực hiện native agent operations và Company Tools lookup; helper không thêm agent CLI.
Proxy của worker có read_item, job_status, worktree status, worker_checkpoint và company_lookup (tra cứu chỉ đọc, từ 04/11), không company_call/publish.

## Candidate và phiên bản

Mỗi bàn giao là <ID>-fixer-<version>.json mới, tách số spawn. Ghi tạm rồi rename. Runtime validate strict schema, path
trực tiếp trong results/ và symlink. RESULT_INVALID chỉ field; RESULT_MUTATED chặn ghi đè. candidateId bind hash kết
quả, source/environment và answer tree; sửa gì sau bàn giao thì CANDIDATE_STALE.

Khi ghi candidate, helper kiểm (`match/answers.mjs`, `env/evidence.mjs`) và chỉ báo lại, không chặn: submit.json theo
template/schema, mỗi requirement đúng một entry, PASS scenario có verification.check bằng scenario ID và evidence MVS
đòi, evidence mô tả item đòi, evidence cũ so với source/environment. Không gì chặn ở bước này: lỗi mà worker luôn tự sửa
được (fix-result sai schema, submit.json hỏng hay sai schema/template, đổi cấu hình test, test mới mở trình duyệt khi
bộ test phát ra chưa có test nào làm vậy) đã bị giữ lại ở worker_checkpoint candidate. Test mở trình duyệt: grader chạy
cả suite ở môi trường không có trình duyệt, file đó hỏng ở beforeAll, vitest thoát 1 dù 0 test hỏng (BTZNI69E:
`layout.test.ts` của BUG-01 launch msedge, CR-01, CR-02, CR-03 mỗi item mất 10 điểm TC test tự động). File test có sẵn bị sửa chỉ là cảnh báo (đề cho sửa test mâu thuẫn, kèm giải thích).

Snapshot loại answers/ và challenge/ (file BTC phát, không chạy trong app); environment hash env files, marker dependency, runtime/commands và biến build/test liên quan,
không xuất secret. Hậu tố database theo trận/item và virtualStoreDir không tính, nên checkout chính và worktree cùng
source có cùng fingerprint; app dùng lại bản build cùng snapshot (05 §5.23).

BACKLOG_TESTS (bước verification của publish) đếm testResults của submit.json, không có thì requirements của fix-result,
answer_only thì kết quả kiểm schema/source. Kịch bản chưa ghi không PASS; last-chance nộp với FAIL/NOT_RUN trung thực.

## Root chỉ chờ bằng wait_for_update (04/11, sau BTZNI69E)

Root của BTZNI69E 142 lượt, context TB khoảng 120K: 27 lượt sau `wait_for_update` (7 lần về tay không), 17 sau
`wait_agent` (8 lần hết giờ), 15 sau `send_message`. Fixer nhắn root 20 lần giữa chừng (báo tiến độ), root trả lời
15 lần; mỗi tin khoảng 2 lượt root. Sửa:
- Ở GAME, `wait_for_update` chỉ trả về khi có nextActions, khi gặp MATCH_STATUS, ITEM_CHANGED, ITEM_CLOSED,
  POLL_ERROR, hoặc khi hết hạn chờ (tối đa 55 s, sớm hơn khi tới mốc ra đề/deadline). Sự kiện không sinh việc
  (WORKER_YIELDED của worker vừa được tự sync, JOB_DONE dọn database, TIMELINE) thì chờ tiếp; `events` vẫn trả đủ.
- Skill root: `wait_for_update` là lệnh chờ duy nhất, không `wait_agent`; nhắn worker bằng một `followup_task` chỉ khi
  nextActions bảo hoặc publish lỗi; không trả lời tin tiến độ.
- Fixer không `send_message` lên root. Cần root quyết/tra cứu thì `worker_checkpoint blocked {question}`: helper ghi
  câu hỏi, đẩy WORKER_BLOCKED, nextActions có `answer_worker` (question, workerThread); root trả lời bằng followup rồi
  gọi `worker_checkpoint resume {threadId}` để đóng câu hỏi. Worker yielded vì sync lỗi cũng chỉ kết thúc lượt;
  root thấy `sync_before_evidence` từ helper.
- Worker dừng ngang không checkpoint: tin cuối của nó nằm trong hàng đợi, root đọc ở lần thức sau (tối đa 55 s);
  worker treo vẫn bị `stop_worker` bắt ở returnBy như cũ. Trần 55 s nằm dưới `tool_timeout_sec = 120`.
- Kiểm ở trận sau (`usage.md`, `bench.md`): `wait_agent` = 0, lượt root giảm (142 ở BTZNI69E), thời gian từ
  candidate tới SUBMITTED không tăng.

## Bắt item nhanh: helper tự prepare, brief sẵn, tra cứu chỉ đọc (04/11, sau BTZNI69E)

Timeline BTZNI69E: helper thấy đề khoảng 7 s sau giờ ra, nhưng đề ra → Start Work 11–93 s và chuẩn bị xong → spawn
56–217 s; đề ra → worker bắt đầu 114–307 s (PI-01 184 s). Nguyên nhân: guardian duyệt từng lời gọi không chỉ đọc của
root lần lượt (3–4 s mỗi lần; lệnh prepare_item sau đợi lệnh trước chờ job 25 s, 4 company_call của PI mất 17 s),
root tự tra Company Tools và đọc skill PI trước khi spawn, tự soạn brief khoảng 2,5K ký tự, làm xen việc khác.
- A. Poller (mỗi giây) gọi `workflow.autoPrepare()`: mỗi prepare_item trong nextActions (đề mới còn slot, PI, answer-only)
  được helper tự chạy một lần (`ji.autoPrepared`; PI có force). Hỏng thì prepare_item vẫn nằm trong nextActions cho
  root. Tắt bằng `"autoPrepare": false` ở `config/runtime.json` hoặc `team-sdlc-pack/local/runtime.json`.
- B. Cuối job prepare, helper viết `.team-work/items/<ID>/brief.md` (item_meta, skills, profile, materials,
  requirements, required_evidence, baseline_failures, recent_changes, company_facts, knowledge_hints, related_events,
  item) và `ji.spawn`; nextActions `spawn_worker` mang `spawn` = đối số spawn_agent (task_name, model, effort, câu trỏ
  tới brief). Root spawn trong một lượt rồi resume đăng ký threadId.
- C. `prefetchCompany` song song với dựng worktree: `get_test_data` khi đề nhắc test data/fixture, `kb_search` (câu
  hỏi từ tiêu đề và Context/Expected outcome/Requirements, `kbQuery`) khi đề đòi theo chuẩn công ty hoặc là PI.
- D. `company_lookup` (readOnly, không qua guardian) chỉ cho tool tra cứu (cờ readOnlyHint của tool, hoặc tên
  kb_/search/get_/list_/find_/read_/lookup), có trong proxy của worker; tool khác `NOT_A_LOOKUP`, root gọi
  company_call. Số thứ tự file kết quả cấp đồng bộ để lời gọi song song không ghi đè nhau.
- Kiểm ở trận sau: đề ra → worker bắt đầu (mục tiêu 45–70 s), không còn prepare_item/company_call của root trước spawn.

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
