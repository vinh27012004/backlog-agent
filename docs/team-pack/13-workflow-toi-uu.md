# 13 · Workflow candidate

Triển khai 31/10/2026; 03/11 rút còn một luồng (bỏ gate, reviewer, solver, verifier, pre-gate và vòng sửa), rồi sau
J56ZZWSS bỏ cả worker evidence riêng của item tier strong: một fixer làm từ code tới evidence.

## API và trách nhiệm

| Tool | Hành vi |
|---|---|
| prepare_item | Job Start Work, materials, worktree/setup/index, profile/models/timeBox và paths viết brief; chờ job tới 25 s nên thường trả kết quả luôn |
| worker_checkpoint | ready_for_evidence/candidate nhường quyền ghi; ready_for_evidence tự sync worktree rồi mở ghi lại (xung đột hay cài lại dependency thì chờ root); candidate (sau khi ghi fix-result) kiểm fix-result mới nhất, submit.json và cấu hình test, có lỗi thì giữ worker ghi tiếp (`handedOff:false`); blocked {question} ghi câu hỏi cho root (sự kiện WORKER_BLOCKED, nextActions answer_worker) thay cho send_message; resume mở lại, đóng câu hỏi; root đăng ký threadId |
| next_actions | Hàng đợi có tham số và waitMs theo release/deadline: prepare_item, spawn_worker, sync_before_evidence, refresh_candidate, publish_item, submit_work, stop_worker. wait_for_update trả cùng danh sách và là lệnh chờ duy nhất của root (từ 04/11, không wait_agent); answer_worker khi worker gọi `worker_checkpoint blocked` |
| publish_item | Job single-owner: ghi candidate từ fixResultFile, đếm verification, integrate, push, submit idempotent; chờ job tới 25 s (thường 10–15 s là xong). PI và item chỉ trả lời: helper tự gọi (autoPublish), root chỉ gọi khi lần tự publish hỏng |

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

Đợt đầu còn chậm hơn: BTZNI69E ra BUG-01/BUG-02 lúc 04:08:05.6 (giờ máy), helper thấy 04:08:49 (44 s), thợ bắt đầu
2m30s/2m44s sau giờ ra. 24 s là root chép frame START vào configure_session (khoảng 1.350 token output; frame có
apiKeySecret nên chỉ root chuyển được), khoảng 10 s là hai lượt login_match và refresh_match; hai prepare_item cùng exec
chạy nối đuôi (BUG-01 chờ 30 s); worktree xong rồi root còn job_status, company_call và soạn brief 53–69 s. Sửa:
- configure_session GAME tự login, đọc backlog (bật poller, gọi autoPrepare ngay không đợi tick đầu) và lấy danh sách
  Company Tools, trả `boot` {ok, items, companyTools, next}; root đi thẳng vào wait_for_update. Một lần mỗi tiến trình
  helper; hỏng thì `boot.ok:false`, root gọi login_match/refresh_match như cũ. Tắt bằng `"bootOnConfigure": false`.
- absorb so view mới với view đã đối chiếu lần trước, không với `gm.view` (login_match cũng fetch, trước đây làm đợt đầu
  không có ITEM_NEW).
- Item đang prepare (Start Work chưa xong, vẫn todo) giữ slot trong nextActions, để tick sau không tự prepare quá
  maxItemsInFlight.
- Đo: journal ghi `releasedAtServer` (updatedAt của bản đầu) và `revealedElapsedSec` khi helper thấy đề. `usage.mjs`
  (`releaseTimes`) đổi sang giờ máy bằng độ lệch đồng hồ ước lượng từ các item poller thấy (max giờ server − giờ thấy,
  sai số khoảng một nhịp poller; BTZNI69E +2,7 s, khớp lúc Player thấy IN_PROGRESS); trận cũ còn checkout đọc
  `page.json`. Bench có "TB đề ra → thợ bắt đầu" (từ giờ ra), "· đề ra → helper thấy", "· helper thấy → thợ bắt đầu"
  và cột "Đề ra → thợ" theo item. Trận không còn checkout chỉ có đoạn helper thấy → thợ.

## Thấy đề sớm: poll trước START_GAME, worktree dựng sẵn, poll nhanh quanh mốc ra đề (04/11, sau CA3WKX60)

Timeline CA3WKX60, đợt đầu: report_ready 08:24:31, đề ra 08:24:42, root nhận START_GAME, đọc skill orchestrator rồi mới
gọi configure_session lúc 08:25:14; helper thấy đề 38 s sau giờ ra, prepare thêm 33–36 s (install khoảng 20 s, prisma
generate 14 s, codegraph 12 s, migrate + seed 7 s), root spawn sau khoảng 6 s nữa. Đợt phút 20 helper thấy muộn 4,3 s:
README bộ 10 item viết "released in four waves (minutes 0, 8, 12 and 20)", `parseReleaseMinutes` đòi chữ "at" nên
poller không biết mốc nào, chỉ hỏi feed mỗi giây. Server cho đề hiện khoảng 1 s sau mốc phút (`revealedElapsedSec`
481, 721, 1201). Sửa:
- `report_ready` bật `startPreGameWatch`: trong phase PREPARE helper đọc trang trận mỗi `preGamePollMs` (500). Đề hiện
  thì ghi `ji.seenAt`, `releasedAtServer`, `revealedElapsedSec`, `page.json` và dựng sẵn worktree (`prewarmWorktree`:
  git, job worktree_setup, index codegraph; tối đa maxItemsInFlight item). Không Start Work, không DISCOVERED (03 §2.1;
  API key chỉ có trong frame START_GAME). Sang GAME thì vòng này dừng, poller của refreshMatch làm tiếp.
- `worktree create` (trong prepare_item) chờ worktree dựng sẵn và dùng lại job setup cùng kết quả codegraph của nó;
  job hỏng hay worktree mất thì dựng lại như cũ. Phần git + setup + index tách thành `createWorktree`.
- Poller GAME: từ 1 s trước tới 20 s sau mỗi mốc ra đề (`releaseWindow`) đọc thẳng trang trận mỗi `releasePollMs` (250)
  thay vì hỏi feed; ngoài cửa sổ hẹn tick đúng lúc cửa sổ mở. `parseReleaseMinutes` nhận cả "released ... (minutes …)".
- Poll nhanh dùng `fetchMatch({ log: false })`: như feed, chỉ networkActivity, không GAME_MASTER_API (hai dòng khoảng
  600 byte mỗi lần, trần log 230 KB).
- Tắt: `"preGameWatch": false`, `"prewarmWorktrees": false`; chỉnh nhịp `preGamePollMs`, `releasePollMs` (50–10 000 ms).
  Nhanh hơn `pollActiveMs` 2000 của UI: theo dõi 429 hay cảnh báo của BTC.
- Đo: `usage.mjs` và `items.mjs` lấy giờ thấy từ `seenAt` (trước đây `discoveredAt`, lúc ghi DISCOVERED); "đề ra → helper
  thấy" dưới 10 s ghi theo ms. Đích: đợt đầu dưới 1 s; helper thấy → thợ bắt đầu chỉ còn Start Work, brief và một lượt
  spawn của root (khoảng 6–10 s; root phải gọi spawn_agent nên không xuống mức ms).

## PI chỉ báo cáo trong 1–2 phút, helper tự publish PI và item chỉ trả lời (04/11, sau CA3WKX60)

PI-01 của CA3WKX60 (Form A, "Out of scope: Changing the application source") mất 4m02s từ Start Work tới nộp:
`git worktree add` 8 s, worktree_setup 43 s (install, generate, migrate, seed) và index codegraph mà PI không dùng;
root spawn 24 s; fixer 2m28s cho 10 lượt (đọc brief + 42K ký tự skill 22 s, tự gọi search_logs từng service 41 s vì mỗi
lời gọi trả tối đa 20 dòng và không có limit/offset, viết derive.mjs + submit.json 47 s, viết fix-result 27 s); bàn
giao → root gọi publish_item 10 s, publish 8 s. Sửa:
- `reportOnlyPI(key)` (PI và `answerOnlyText`): `createWorktree` chỉ tạo worktree git, job worktree_setup trả ngay
  `skipped: 'report-only PI'`, không index codegraph. Áp dụng cả cho worktree dựng sẵn trước START_GAME. TASK chỉ trả
  lời: từ 04/11 (sau EIOR38SI) cũng bỏ setup, xem mục "Spawn fixer không chờ setup".
- `prefetchCompany` của PI (khi search_logs có tham số `service`) gọi thêm `harvestLogs`: lấy tên service từ lời gọi
  không lọc, từ danh sách service trong KB ("service name exactly as it appears in logs: web, api, …") và từ tên có gạch
  nối trong đề/KB (tối đa 24), gọi song song `{service, query: ''}`, lưu service có dòng (`saveFact`, như company_lookup),
  gộp mọi dòng theo `ts` vào `company/timeline.json` kèm bảng `services` (total, returned, complete). Brief ghi
  `search_logs (service X: returned/total[ INCOMPLETE])` và `timeline (N entries …)`.
- prepare chép các file đó vào `answers/<ID>/evidence/` của worktree.
- Brief có khối `<report_only_pi>` thay mọi skill (không còn `<skills>`, `<profile>`): ba lượt (đọc timeline + KB +
  template/schema; viết và chạy derive.mjs rồi ghi submit.json; worker_checkpoint candidate), bẫy release sau, khiếu
  nại không đủ, thanh toán sau sự kiện. `team-fixer.toml`: có khối này thì đó là toàn bộ quy trình.
- Item chỉ trả lời (`verificationKind: answer_only`, cả PI lẫn TASK): worker_checkpoint candidate mà chưa có fix-result
  mới thì helper lập `<ID>-fixer-<n>.json` từ submit.json (`writeAnswerResult`: status theo DONE/PARTIAL/BLOCKED,
  summary các trường phẳng, root_cause từ incidentRecord.rootCause, changed_files trong answers/<ID>/, risks ghi rõ do
  helper viết), rồi kiểm như thường. Worker vẫn có thể tự viết; submit.json còn lỗi thì chỉ báo lỗi đó.
- `autoPublish()` cạnh `autoPrepare()` (nhịp poller và đầu wait_for_update): publish_item của PI hay item chỉ trả lời
  mà worker đã bàn giao (không còn `writing`) được helper tự gọi `publish`, mỗi kết quả bàn giao một lần
  (`ji.autoPublished` = fixResultFile; publishMark coi candidateId ghi từ chính file đó là cùng một lần). Không gắn vào
  worker_checkpoint vì tool đó readOnly (không qua guardian) còn publish đụng git và Game Master. Root không thấy
  publish_item đó (`actions()` lọc, `all: true` cho helper; notice và `state.newResults` dùng `rootResults()`), cũng
  không thấy publish_item khi job publish đang chạy. Hỏng thì job failed (JOB_DONE) hay lỗi trước job (sự kiện
  AUTO_PUBLISH_FAILED, `ji.autoPublishError`): publish_item/submit_work hiện cho root như cũ. Code BUG/CR vẫn do root
  publish. Tắt: `"autoPublish": false`.
- Ước tính PI-01 sau sửa: Start Work 2 s, prepare ~8 s, root spawn ~20 s, fixer ~35 s (2–3 lượt), publish ~8 s:
  khoảng 1m15s. Đo lại bằng bench sau trận kế.

## Test fail sẵn: chủ đưa bản sửa lên main trước, item khác chờ khi publish (04/11, sau EIOR38SI)

Bản phát của EIOR38SI có 2 test fail sẵn (`accounting.test.ts` trạng thái PAID, `cascade.test.ts` RESTRICT do migration
`company_delete_cascades_financials`). Helper giao BUG-01 làm chủ; BUG-02 (`youFix:false`) nộp DONE lúc 14:20 với TC-04
FAIL, BUG-01 lên main lúc 14:27. Grader chạy cả bộ test **trên commit của từng item** sau khi khôi phục test gốc: commit
BUG-02 còn 2 test hỏng, mất 20/100. Chủ BUG-01 còn viết lại assertion của `cascade.test.ts` thay vì sửa migration, nên
test gốc vẫn hỏng ở mọi commit sau đó. Sửa:
- Chủ (`youFix:true`) sửa baseline **trước** việc của nó, bằng sản phẩm (code, schema, migration, data), rồi gọi
  `worker_checkpoint baseline_fixed {files}` (đường dẫn trong matchRoot). Helper từ chối test BTC phát, cấu hình test,
  `answers/`, `.env` và file không đổi; chép đóng băng vào `.team-work/baseline/<ID>/`, ghi
  `preparation.baselineFix = {owner, state: pending, files}`. `files: []`: không sửa được (`abandoned`), item khác thôi chờ.
- `autoBaseline()` trong nhịp poller: `landBaseline()` giữ khoá publish (`publishOwner = 'BASELINE'`), chép các file đó
  vào main và commit riêng `<chủ>: make the tests that fail in the issued code pass (baseline)` (sự kiện
  BASELINE_LANDED; lỗi thì thử lại, 3 lần thì `failed`). Sau đó `syncHeldItems()` sync worktree đã bàn giao còn thiếu
  commit đó (`ji.baselineSynced`), candidate cũ thành stale.
- Item cần cả bộ test (`ji.needsSuite`, cùng regex NEEDS_SUITE với chọn chủ; trừ PI và item chỉ trả lời) mà worktree
  chưa có bản sửa (`ji.baselineFixIn`, ghi khi create/sync) bị giữ publish (`baselineWait`: `owner` khi chủ còn làm,
  `sync` khi đã lên main): không có publish_item trong nextActions hay `state.newResults`, `publish_item` trả
  `BASELINE_PENDING`. Hết giữ khi chủ bàn giao/kết thúc mà không báo, sync hỏng, hay item vào phút cuối (lastCall).
- Sau sync: nextActions `refresh_candidate {reason: baseline_fix, followup}`; root gửi nguyên `followup`, worker chạy
  lại cả bộ test và bàn giao bản kế. Worker còn ghi: `worker_checkpoint candidate` tự sync (đợi tới 15 s nếu bản sửa
  đang chờ commit) và giữ worker lại với yêu cầu chạy lại; `ready_for_evidence` sync mang bản sửa về thì hint nhắc chạy lại.
- Chủ publish sau: file trùng nội dung với main không tính là "cùng sửa" (không SYNC_REQUIRED, cherry-pick sạch); sync
  của chủ bỏ qua file chưa track trùng nội dung với file main vừa thêm (migration của chính nó).
- Item bắt đầu sau khi bản sửa lên main nhận `baselineFailures.fixedOnMain`; không giao chủ mới khi bản sửa đang chờ.
- `worker_checkpoint candidate` chặn (không còn chỉ cảnh báo) mọi thay đổi ở file test BTC phát (`issued tests
  changed`); file test mới của item vẫn được.

## Spawn fixer không chờ setup, TASK chỉ trả lời không cài gì (04/11, sau EIOR38SI)

EIOR38SI: helper thấy → fixer bắt đầu trung bình 1m24s. Ngoài đợt đầu (36 s chờ root xử lý START_GAME), phần lớn là
prepare chờ job worktree_setup: install 25–46 s (link 360 package dù "downloaded 0"; chậm hơn khi 3 item ra cùng phút),
prisma generate 6–18 s, migrate 6–12 s, seed 5–11 s, chạy nối tiếp; prepare tổng 54–105 s, rồi root spawn thêm 4–25 s.
Phút đầu fixer chỉ đọc brief, skill và code, chưa cần dependency. TASK-03/04 (Form A, không build/test/app) chờ setup
71–80 s mà không dùng bước nào. Sửa:
- `prepare` không chờ job setup nữa: xong khi có worktree, index codegraph, dữ liệu công ty và brief; kết quả mang
  `setup {jobId, state, skipped}`. Job setup đã hỏng sẵn (worktree dựng trước giờ) thì vẫn `SETUP_FAILED` như cũ.
- Brief có khối `<environment>`: setup đang chạy thì ghi job id và bảo fixer gọi `job_status {jobId, waitSeconds: 110}`
  trước lần build/typecheck/test/migrate/seed/app đầu tiên, lặp khi còn running; failed thì `worker_checkpoint blocked`;
  không tự install/generate/migrate khi job đang chạy. `team-fixer.toml` nhắc khối này.
- Job setup tự chạy lại một lần khi lỗi (`retriedAfter`): không còn prepare_item hỏng để root thử lại.
- `worktree sync` chờ job setup đang chạy của item trước khi reset worktree hay cài lại.
- `answerOnlyTask(key)` (TASK, `answerOnlyText`, template không có `testResults`): `createWorktree` không install,
  generate, migrate, seed (job trả `skipped: 'answer-only TASK'`), vẫn index codegraph. Brief nói không cài, build, test
  hay chạy app, và chỉ `createRequire("<app của checkout chính>/package.json")` để nạp package dự án (derive.mjs của
  TASK-04 nạp typescript để transpile source) khi checkout chính đã có node_modules.
- Ước tính: BUG/CR từ helper thấy tới fixer bắt đầu còn khoảng 25–40 s (git worktree, codegraph, brief, một lượt spawn
  của root); TASK chỉ trả lời khoảng 20–30 s. Đo lại bằng bench sau trận kế ("· helper thấy → thợ bắt đầu").

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
