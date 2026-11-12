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

## Cache package và setup worktree (06/11/2026)

- Main và worktree dùng kho tải package trong `team-sdlc-pack/local/package-cache/<manager>-<major>/`.
  Yarn 2+ dùng global folder/mirror, giữ cấu hình cache local của repo; Yarn 1 và npm dùng cache folder,
  pnpm dùng store với tên biến môi trường tương ứng phiên bản. Không sửa lockfile hay chia sẻ `node_modules`.
- `env/setup-cache.mjs` ghi proof thành công của install/prepare-source/build vào
  `.team-work/logs/setup-cache/`, riêng theo đường dẫn bản sao. Gọi lại chỉ bỏ qua bước đã thành công khi
  input, dependency hiện có và (với build/prepare-source) nội dung artifact vẫn khớp. Proof chứa hash, không ghi secret.
  File manifest của workspace, lockfile, cấu hình manager, release/plugin/patch, script BTC, env và runtime tham gia input.
  Script prepare-source, build, install hook và file dependency có thể đọc source nên dùng input source đầy đủ.
  Nếu không chứng minh được dependency/artifact (ví dụ Yarn PnP), chạy thật thay vì đoán PASS.
- Source thông thường đổi không buộc install lại khi dự án không có install hook/file dependency.
  Thiếu package, đổi lock/config hoặc artifact bị xóa/sửa sẽ làm proof hết hiệu lực. Lỗi/timeout xóa proof cũ.
  Doctor, baseline và các bước database vẫn chạy theo quy trình; không dùng proof setup làm kết quả test.
- Prewarm/create đồng thời cùng item được gộp; setup đang chạy được dùng lại. START_GAME nhận job prewarm một lần,
  các lần create sau kiểm tra lại setup. Nếu template thật đòi test thì không nhận kết quả prewarm đã bỏ qua setup.
  Không Start Work trước GAME. TASK chỉ trả lời và PI report-only bỏ setup cả khi sync kéo dependency mới từ main.
- `run_checks` và app tiếp tục dùng cache source/environment hiện có. Một lượt model/followup mới không phải lý do
  cài lại hay build lại; source hoặc môi trường thay đổi thì kiểm tra lại như bình thường.

Kiểm tra: `setup-cache.test.mjs`, các ca prewarm/create/sync trong `workflow.test.mjs`, và luồng thật trong `e2e.test.mjs`.

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
  tới brief). Root spawn tất cả bằng các tool call song song trong một lượt; helper tự đăng ký thread khi worker
  gọi tool lần đầu, không cần resume sau spawn (05/11, sau ME1X0FFX).
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

### node_modules liên kết (10/11, sau QDYZMY1K)

QDYZMY1K chạy pack có lệnh setup đã sửa (7fd07aa): mỗi worktree chạy `prepare-source` của BTC (yarn install rồi build
cả app web). Bước link của yarn build lại gói native (esbuild, argon2, bcrypt) 2m58s, build web 1m23s; 6–7 worktree cùng
lúc nên job setup mất 5–13 phút mỗi worktree, typecheck của BUG-09 229 s, full suite timeout 600 s ở 5/6 item, PI-03
hết giờ trước khi sửa source, BUG-11 lên main muộn làm CR-07 không có dữ liệu official. Ở OMZJW0S0 lệnh setup hỏng ngay
(`yarn` không có trên PATH, 1–2 s) nên không tốn gì; fixer tự `yarn install` khi cần (link 23 s, một mình).

- `linked-modules.mjs`: mỗi thư mục node_modules của app ở checkout chính (gốc và `packages/*/node_modules`) có bản
  tương ứng trong worktree là thư mục thật chứa junction từng mục: gói bên thứ ba → checkout chính; gói workspace (yarn
  để junction tuyệt đối vào `packages/` của checkout chính) → `packages/` của worktree; thư mục ẩn tạo rỗng riêng
  (`.vite`, `.vite-temp`, `.vitest-cache`, `.cache`), trừ `.bin`; file ẩn (`.yarn-state.yml`) chép sang; chép
  `.yarn/install-state.gz` để `yarn run` coi là đã cài. Đo trên checkout QDYZMY1K: 1227 junction trong 0,56 s; test
  loot-core 69/69, `yarn run typecheck` 46 s và `lage build:browser` 34 s chạy được, output ở worktree, build của checkout
  chính không đổi; gỡ 1,6 s, checkout chính còn nguyên.
- `prepareWorktreeEnv {linked, issuedRevision}` (`linkOptions()`, công tắc `"linkedModules"`): liên kết khi stack node,
  không có bước `generate` (Prisma sinh client vào node_modules: generate của worktree sẽ đè lên checkout chính), checkout
  chính đã cài và `git diff <issuedRevision>` của worktree không có file dependency (`setupInputFile`). Khi đó bỏ
  install/`prepare-source` (không build: `run_checks` và `app start` build khi cần), vẫn migrate/seed database riêng.
  Không đủ điều kiện thì cài thật như cũ, gỡ junction trước (install ghi xuyên junction sang checkout chính).
- **`git worktree remove --force` và `git clean -x` đi xuyên junction và xoá file ở thư mục đích** (kiểm trên git for
  Windows: xoá worktree làm mất file của thư mục được junction tới). `worktree remove` và dọn thư mục worktree sót gọi
  `unlinkNodeModules` trước; `fs.rmSync` của Node không đi xuyên junction. Khối `<environment>` của brief cấm cài
  package, `git clean -x` hay xoá node_modules trong worktree.
- TASK-10/11/12 của bộ 12 item có mục Acceptance criteria nên không được nhận là TASK chỉ trả lời (setup 5–13 phút);
  giữ nguyên bộ nhận diện (TASK-08 cũng có Acceptance criteria mà phải sửa code), setup liên kết của chúng chỉ còn ~1 s.

## Bớt lượt model của fixer: run_checks, candidate {result}, skill trong brief (05/11, sau 9O802QWE)

9O802QWE (10/10 item đạt): BUG/CR mất 7–13 phút, trong đó 65–80% là model suy nghĩ (gpt-6.1-sol high, 12–14 s mỗi
lượt, 22–33 lượt), mỗi lượt gửi lại context 60–110K; fixer chiếm 85/88 credit. Lượt bị phí: BUG-04 10 lượt `wait`
1 s chờ chuỗi typecheck → build → test, CR-01/CR-02 4 lượt, nhiều lượt chỉ để `Get-Content -Tail build.log`; lượt cuối
viết fix-result 8–11 KB mất 30–71 s; 2–3 lượt đầu chỉ để mở brief rồi 4–6 file skill (~40K ký tự); BUG-04 mất 4 lượt
(~35 s) đọc mã nguồn helper (`proxy.mjs`, `tools.mjs`) để hiểu `company_lookup` / `job_status`. Sửa:
- Tool `run_checks` (05 §5.27): helper chạy typecheck, build và cả bộ test theo profile, song song, log vào
  `answers/<ID>/evidence/` (`typecheck.log`, `build.log`, `full-suite.log`), chờ tới 110 s và trả trạng thái từng
  bước, số test, test fail, đuôi log khi hỏng. Ghi `.team-work/items/<ID>/checks.json`. Build đạt trên source không đổi
  thì ghi nhớ bản build như `app start`, nên `app start` sau đó dùng lại (khỏi build lần hai).
- `worker_checkpoint candidate {result}`: worker chỉ gửi phần cần suy luận (status, summary, requirements, các dòng
  scenario MVS, root_cause/hypotheses… khi có); helper thêm `changed_files` (git so với `worktreeBase`), `tests_added`
  (file test mới, theo đích `test_one`), các dòng typecheck/build/full suite từ `checks.json` (ghi chú khi mọi test fail
  đều là baseline phát ra, hay khi source đổi sau lần chạy) và giá trị mặc định, kiểm contract trước khi ghi (sai thì
  không ghi gì, không tốn số phiên bản), rồi ghi fix-result đánh số kế tiếp và bàn giao như cũ. Kết quả có
  `fixResultFile`. Worker tự viết file vẫn được.
- Brief: khối cuối `<skill_text>` chép sẵn backlog-references/SKILL.md, skill theo loại item, stack notes, bug-patterns
  (BUG), pi-triage (PI), domain-checks và phần cốt lõi của evidence-playbook (chỉ khi item cần bằng chứng trên trang,
  `needsPages`; item khác có một dòng chỉ tới file, từ sau WQ7T6CEC; `evidence-playbook-details.md` không bao giờ chép,
  thợ mở đúng mục khi cần), bỏ front matter. Đặt sau `<item>`
  để output bị cắt thì mất skill chứ không mất đề; `item_meta` thêm `fix_result_schema`. Report-only PI giữ quy trình riêng.
- `team-fixer.toml`: đọc brief một lệnh (`max_output_tokens 40000`), không mở lại file skill; liệt kê đúng các tool
  team_runtime của worker, cấm đọc mã nguồn/pack đã cài của helper; closing checks bằng `run_checks`; mọi exec chờ việc
  lâu bắt đầu bằng `// @exec: {"yield_time_ms": 120000}`; bàn giao bằng `candidate {result}`.
- evidence-playbook §8: bỏ mẹo gắn cứng BUG-01/BUG-02 của bộ đề luyện tập (ở giải thật cùng ID là bài khác; mẹo sửa
  `cascade.test.ts` còn trái luật "không sửa test phát ra"), thay bằng bài học chung: trang poll không ngừng, script
  kiểm của BTC chờ network idle quá hạn.
- Ước tính: bớt 5–15 lượt mỗi item BUG/CR (≈ 1–3 phút và 0,5–1,5M input). Đo lại bằng bench sau trận kế. Chưa đổi
  model fixer để trận kế đo riêng tác động của thay đổi này; A/B model (gpt-6-sol / 6.1-sol medium) để trận sau.

### Đo lại sau 08OQBPW8 (05/11)

10/10 đạt judge, credit 88 → 77, input fixer 14,0M → 10,6M, lượt fixer 217 → 170, cả 7 fixer bàn giao bằng
`candidate {result}` ngay lần đầu. Nhưng thời gian item không giảm (TB 7m23s → 8m05s, evidence 3m54s → 5m12s): mỗi
lượt dài 32 s vì tool chờ lâu. Nguyên nhân và sửa:
- Mỗi worker chạy `run_checks` 3–4 lần, 40–95 s mỗi lần (BUG-01 ~175 s, CR-01 ~200 s): trước sync, sau sync, sau khi
  chép script seed vào `src/`, trước candidate; 6/7 worker tự chọn `parallel:false`; BUG-04 chụp evidence trên app tự
  build (56 s) rồi `run_checks` build lại.
  - `run_checks` cache: lần chạy xong ghi `snapshot` (source ngoài answers/, challenge/ và môi trường) khi không đổi
    trong lúc chạy; gọi lại với cùng snapshot thì trả lần đó ngay (`cached: true`), `force: true` để chạy lại.
  - `worker_checkpoint ready_for_evidence` (helper của root) tự chạy `run_checks` ngay sau sync, trên source cuối
    cùng, trả `checks {state, runId}`; worker chỉ gọi `run_checks status`. Tắt: `"autoChecks": false`.
  - `app start` thấy `run_checks` của chính item đang build thì chờ bước build (tới `waitSeconds`) rồi dùng lại bản build;
    quá hạn thì trả `waiting_for_checks`. Không chờ bộ test: fixer chụp evidence trong lúc full suite còn chạy và xem
    `run_checks status` trước candidate (sau UOMNKT6Z).
  - Bỏ `parallel` khỏi schema (luôn song song). `team-fixer.toml`: không chạy full `run_checks` trước
    ready_for_evidence (chỉ test_one, `checks: ["typecheck"]` khi đổi kiểu), chép script seed/report vào `src/`
    trước ready_for_evidence.
- Brief ~45K ký tự bị exec cắt ở ~10K token dù `exec_command` có `max_output_tokens`: BUG-04, CR-03 đọc hai lần (một
  lượt, thêm ~10K token context mỗi lượt sau). Lời spawn và profile bảo mở exec bằng
  `// @exec: {"max_output_tokens": 40000}`.

### ME1X0FFX (05/11): nhanh hơn, nhưng BUG-02 mất 80 điểm

TB item 7m12s (tốt nhất bộ), evidence 4m00s, trận 30m05s, credit 74. BUG-02 được 20/100: đã chạy đạt cả 3 kịch bản UI
(49360 VND, 15000 PARTIAL, 12375 USD) và ghi submit.json DONE, nhưng:
- candidate trả problems vì bản sửa baseline của BUG-01 vừa lên main (chạy lại cả bộ test); `run_checks` chạy lại 89 s
  và typecheck hỏng giả: tsc đọc `.next/types/**` (include của tsconfig Next.js) đúng lúc next build xoá và dựng lại
  (TS6053). Sửa: typecheck chạy xong rồi mới build, test vẫn song song với cả hai.
- `candidate {result}` đã ghi BUG-02-fixer-1.json trước khi trả problems; `newResults` coi nó là kết quả mới nên
  nextActions đưa `publish_item`, publish hỏng (worker còn ghi), root nhắn worker hai lần giữa lúc chạy test. Sửa:
  `newResults` bỏ item có worker đang ghi.
- Gần hạn 18 phút, `stop_worker`: worker hạ 3 kịch bản đã đạt xuống NOT_RUN ("evidence chụp trước sync"). Sửa:
  `stop_worker` mang `followup` cố định (root gửi nguyên văn): bàn giao trong một lượt, giữ PASS những gì đã kiểm, chỉ
  NOT_RUN cái chưa từng chạy; profile fixer, playbook và lời candidate về baseline nói cùng điều đó.

### Wave đầu sau ME1X0FFX

- Số đo transcript root `rollout-…bba3…jsonl`: 19:11:52.4 server ra BUG-01/02 (pre-game watch thấy ngay);
  19:11:54.6 Player gửi START_GAME cho gpt-6-luna (~56 token/s). Root chép frame 4.333 ký tự, 1.413 token
  trong 19:12:02.7–19:12:26.8 (24 s); configure_session hoàn tất Start Work cả hai lúc 19:12:31.5 (5 s).
  Spawn BUG-01 lúc 19:12:43.6, BUG-02 lúc 19:12:55.0; giữa hai spawn có ba lượt model: resume → wait → spawn.
  Fixer chỉ ~5 s tới tool đầu tiên, giữ nguyên bước khởi động đó.
- START rút gọn còn marker và 12 trường descriptor cần thiết; helper lấy phần còn lại từ PREPARE trong RAM,
  kiểm session/match/team, scope, length/SHA-256 và dựng submission policy đúng Player. PREPARE và RESUME vẫn
  chép nguyên văn trong skill; frame đầy đủ vẫn dùng được. Công tắc `compactStartFrame` mặc định true, tắt rồi
  cài lại để về lời “Configure the Player frame verbatim”. Ước tính tiết kiệm khoảng 20 s ở wave đầu.
- Worker được phép ghi từ prepare; lần đầu gọi helper qua proxy tự đăng ký `/root/<task_name>`, không mở ghi
  lại nếu đã yielded. Spawn lỗi/hết thread chưa có lời gọi worker thì `spawn_worker` vẫn còn để thử lại.
  Root spawn mọi entry song song, bỏ resume sau spawn; resume khi trả lời `answer_worker` vẫn giữ.
- `wait_for_update` gom tối đa 2 s nếu chỉ có spawn và prepare cùng wave còn chạy; không chờ setup, không giữ
  PI hay việc khác, có abort. Cùng wave dựa trên phút revealedElapsedSec, dự phòng mốc phát hiện/ra đề.
  Transcript cho thấy prepare BUG-01 xong 19:12:34.615, BUG-02 xong 19:12:38.517: lệch 3,902 s, nên cửa sổ 2 s
  chưa gom đủ cặp này khi phát lại nguyên timing. Với các item xong sát nhau, một lượt trả đủ spawn; ước tính
  bớt khoảng 10 s cho mỗi item thứ hai trở đi, cần đo lại ở trận kế tiếp.

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

## Item phụ thuộc item khác và số liệu official (09/11, sau OMZJW0S0 CR-07)

CR-07 của OMZJW0S0 được 71/100. Code audit đạt mọi hidden test; mất 29 điểm ở dữ liệu official. Đề nói số liệu chỉ
đúng trên source có bản sửa BUG-11. BUG-11 lên main lúc 05:11:26; ba lần sync của CR-07 trước đó (05:06–05:10) đều
báo `WORKTREE_CONFLICT ... unknown`, nên fixer chụp evidence trên source cũ. CR-07 bàn giao 05:14:55 với CSV và
`auditSummary` cũ (boundary -70M thay vì -180M: mất 11 + 14 điểm); root bảo bàn giao lại như cũ khi publish báo
`CANDIDATE_STALE` (còn 5 phút). Test riêng `cr-07-official.test.ts` gõ tay expected Nguyên liệu -142M, chuẩn KB ra
-182M (mất 4 điểm). Chạy lại test đó trên đúng commit đã nộp (298cca1, đã có BUG-11) ra đủ số đúng trong vài giây, chỉ
dòng -142M fail: sync rồi chạy lại replay là đủ lấy lại 25 điểm.

- Sync: patch của CR-07 áp sạch lên main lúc đó (thử lại trên bản clone), "unknown" không phải xung đột. `git apply`
  không có file U thì reset rồi thử lại sau 2 s; vẫn hỏng thì `WORKTREE_SYNC_FAILED` kèm stderr của git, và hint
  `ready_for_evidence` bảo fixer dừng tiến trình nó tự chạy trong worktree rồi gọi lại. Fixer dừng test/build/server tự
  chạy trước `ready_for_evidence` (CR-07 để full suite và build chạy nền).
- `dependsOn`: lúc prepare helper lấy các khoá item khác có trong đề (`TASK|BUG|CR|PI-<số>`) và viết khối
  `<depends_on>` vào brief. `integratedAt` ghi khi một item lên main, `baseAt` khi worktree lấy main (tạo hay sync).
  Phụ thuộc lên main sau `baseAt`: `worker_checkpoint candidate` từ chối bàn giao (sync rồi chạy lại replay), và với
  candidate đã bàn giao thì `nextActions` giữ publish và đưa `refresh_candidate {reason: dependency_landed,
  dependency, followup}`, cả trong cửa sổ cơ hội cuối khi còn ≥ 3 phút; ít hơn thì nộp như đang có. Không khoá, không
  chờ: khác `18fd306` (requiredRevision, khoá app-data) làm UOMNKT6Z chậm.
- Skill CR §4.3 và evidence-playbook: số liệu official (CSV, trường summary) ra bằng một script replay gọi đúng
  handler của trang, ghi CSV bytes và JSON summary vào evidence, chạy lại sau mỗi lần sync. Root: `CANDIDATE_STALE`
  còn ≥ 3 phút thì làm mới, không bàn giao lại như cũ.
- Candidate từ chối khi test mới của chính item fail ở lần `run_checks` cuối (khớp tên file trong `failing`).
  Expected của test số liệu official lấy từ phép tính theo chuẩn KB, không gõ tay.

### Chép sớm bản sửa sang item đang chờ (10/11, sau LXRMBRA2)

LXRMBRA2: CR-07 (hạn 20 phút, ra cùng lúc BUG-11) mất 41 điểm vì source nộp chưa có bản sửa BUG-11. BUG-11 xong code
và test trọng tâm ở phút 7,5, nhưng evidence, check và publish hỏng kéo tới phút 25. Hai item không sửa chung file nào;
chỗ dính là luật chấm. Chờ "lên main" là quá muộn với item có hạn.

- `neededBy(key)`: item chưa xong mà đề nhắc tới `key`, đọc từ đề của mọi item đang thấy (không chờ chúng prepare).
  Brief của `key` có khối `<needed_by>`: ai chờ, đóng sau bao lâu, sửa product trước rồi `ready_for_evidence` ngay khi
  test trọng tâm xanh, sau đó giữ product ổn định.
- `shareWithDependents(key)` (`match/dependency.mjs`), ở `ready_for_evidence` và `candidate` của `key`: lấy file product
  `key` sửa so với `worktreeBase` (không test, cấu hình test, `answers/`, `.codegraph/`), `git diff --binary` + `git
  apply --check` rồi áp vào worktree item chờ; file mới chép thẳng. Item chờ cũng sửa một file đó, patch không áp
  sạch, hay worker nhận đã sửa bản chép trước thì không chép gì. Ghi `sharedFix {from, files, fingerprint, at}` và sự
  kiện `DEPENDENCY_READY`; lần sau chỉ chép lại khi nội dung đổi (gỡ bản cũ rồi áp bản mới).
- `pullFromDependencies(key)`, ở prepare của item chờ ngay sau khi worktree của nó dựng xong (2026-11-11, sau
  QDO8W480): item được chờ đã qua `ready_for_evidence` (có `workerPhase`) và chưa lên main thì chép ngay, và khối
  `<depends_on>` của brief ghi bản sửa đã có sẵn cùng danh sách file. QDO8W480: CR-05 gọi `ready_for_evidence` ở phút
  19,5, worktree của CR-08 tới phút 19,9 mới có nên lần chép đó bỏ qua CR-08; CR-05 handoff lại ở phút 38,4, CR-08
  (hạn 15 phút) nộp không có handler của CR-05 và được 0/110.
- Báo item chờ một lần: candidate từ chối (đang viết), hint của resume hay `ready_for_evidence`, hoặc `nextActions`
  `refresh_candidate {reason: dependency_ready}` khi đã bàn giao (giữ publish, còn ≥ 3 phút). Worker chạy lại replay,
  so với phép tính độc lập; bản chép làm hỏng build/test thì tự gỡ (`git checkout HEAD -- <file>`) và bàn giao không có nó.
- `key` lên main: `noteDependencyLanded` so nội dung các file đã chép với main. Giống thì `dependencyLanded` bỏ qua
  (khỏi sync và chạy lại); khác mà worker nhận chưa sửa gì vào bản chép thì gỡ bản chép, để sync lấy bản của main.
- Item chờ lên main trước `key` với cùng nội dung: kiểm `SYNC_REQUIRED` của `key` đã coi nội dung giống nhau là sạch.
- Item được chờ đứng đầu `nextActions` của root.
- Candidate còn ≥ 3 phút mà main đã đổi một file product của item với nội dung khác: từ chối, bảo `ready_for_evidence`
  (sync) thay vì để publish dừng ở `SYNC_REQUIRED` (LXRMBRA2 BUG-11 và `transfer.ts` của TASK-08).
- Giới hạn: chỉ nhận phụ thuộc khi đề nêu tên item kia; bản chép là product code lúc `ready_for_evidence`, chưa qua
  evidence và bộ test của item được chờ.

## Test đỏ không lên main, PASS phải có evidence MVS (10/11, sau QDYZMY1K)

- PI-03 hết giờ trước khi sửa source và bàn giao chỉ có test tái hiện `pi03-posted-amount.test.ts` (đỏ). Grader chạy test
  của đội ở commit của từng item: mọi item nộp sau mất `team-tests` (BUG-09 −5, BUG-11 −2). Kiểm "test mới của item fail
  ở run_checks cuối" không bắt được vì full suite của PI-03 timeout. `parkRedOnlyTests` (trong `worker_checkpoint
  candidate`, trước khi soạn fix-result): BUG/PI/CR có test mới mà không có thay đổi sản phẩm nào (ngoài `answers/`,
  test, cấu hình test) thì chuyển các test đó vào `answers/<ID>/evidence/unshipped-tests/` và cảnh báo worker ghi rõ bản
  sửa không có trong revision. TASK không áp dụng (bộ test của TASK là sản phẩm).
- BUG-11 kiểm lại TC-03/04 sau sync rồi trỏ sang `transfer-resync.log` thay cho `mvs-tests.log` mà MVS đòi: BTC chấm 0
  cả hai (−8). Lỗi `<TC> is PASS but its evidence lacks what the MVS requires` (và PASS trích ảnh `*.FAILED-step*`) giờ
  chặn bàn giao như lỗi schema, không chỉ cảnh báo; thông báo bảo trích file đó, chạy lại kịch bản ra file đó hay báo
  NOT_RUN.

## PI nhanh hơn: tra log hàng loạt, chỉ typecheck, không chờ codegraph (10/11, sau QDYZMY1K)

OMZJW0S0: PI mất ~11 phút (prepare 58–64 s, trong đó index codegraph ~45 s mà fixer không dùng; fixer ~10 phút: ~5,5
phút model, ~2,5 phút tự lật log, hỏi root schema `search_logs`, ~2 phút closing checks). QDYZMY1K (pack có setup
liên kết chưa có): PI-02 thử `limit`/`pageSize`/`take`, hỏi root schema ở giây 367 rồi lặp 716 truy vấn `TX-xxxx`;
PI-03 hỏi ở giây 357, lặp 320 truy vấn `SCH-xxxx` và chạm trần 12 phút trước khi sửa source; full suite timeout 600 s.

- `search_logs` (kiểm trên lời gọi thật): tham số `service`, `query`; tối đa 20 dòng mới nhất mỗi lời gọi kèm `total`,
  không có paging. Dòng (cả tên trường) và query viết thường, cắt thành từ ở mọi ký tự không phải chữ/số; mỗi từ của
  query phải trùng nguyên vẹn một từ của dòng. Từ giờ `DDtHH` chọn một giờ (ở mọi tháng), không chọn được ngày; số
  ngắn (`10`, `18`) khớp khắp nơi; không wildcard.
- Brief PI có khối `<search_logs>` (`searchLogsHelp`): schema thật lấy từ `company_tools`, quy tắc khớp từ kèm ví dụ,
  cách tra hàng loạt; khối `<report_only_pi>` và skill `backlog-pi` (Form B) dùng nó.
- `company_lookup {name: "search_logs", backlogItemKey, queries: [{service, query}…] (≤ 2500), hours: {from, to}}`
  (`match/logs.mjs`, `logLookup`): job `log_lookup` trong helper của root (tool MCP và proxy chỉ chờ ~120 s; trả kết quả
  trong 100 s hoặc `jobId`). Chạy song song 8, thử lại tới 3 lần (lùi 1–2–4 s), `hours` nhân mỗi truy vấn với từng
  từ giờ trong khung và bỏ dòng ngoài khung; giờ quá 20 dòng chia theo từ phút. Đủ khi số dòng khác nhau thấy được
  khớp truy vấn của giờ bằng `total` (nhánh phút trùng số tháng vẫn quá 20 nhưng các dòng đã tới qua phút thật của
  chúng); còn thiếu thì báo trong `incomplete`. Ghi MỘT file `NN-search_logs-bulk.json` (mọi dòng một lần, sắp theo ts
  rồi `context.seq`, `complete`). Mô phỏng trên bộ log đầy đủ 4057 dòng (độ trễ 300 ms): `SCH-0001..0320` 697/697 dòng,
  320 lời gọi, 12 s; rule-engine cả khoảng log 755/755, 744 lời gọi, 29 s; khung release 2025.10.3 370/370, 441 lời
  gọi, 17 s; cả log 4057/4057, 2244 lời gọi, 91 s. Thời gian thật phụ thuộc giới hạn tốc độ của Company Tools.
- PI dựng index codegraph nền, không giữ spawn. `run_checks` của PI mặc định chỉ typecheck (không build, không full
  suite): bản sửa được chấm bằng hidden test, đáp án đua theo thứ tự nộp; fixer chạy test của module bị sửa bằng test_one.
- Thứ tự Form B (`backlog-pi`, `team-fixer.toml`): sửa trước (red → fix → green), `ready_for_evidence` (typecheck nền),
  trong lúc đó tra log một lần và suy đáp án bằng script, rồi candidate; quá `checkpoint_by` mà chưa xanh thì vẫn bàn
  giao đáp án và nói thiếu bản sửa (test tái hiện không đi kèm bản sửa được helper chuyển vào evidence).

## Bộ test của run_checks theo gói grader chạy (10/11, sau RATH0OHJ)

- RATH0OHJ: `yarn test` (lage) chạy mọi workspace của Actual; riêng `web` (desktop-client) 6m08s, lần chạy cuối của
  TASK-08 6m43s, trong khi đề BUG/CR ghi "The grader runs the loot-core tests" và item chỉ sửa loot-core.
- `env/test-scope.mjs`: đề (page.json) có câu "the grader runs the <gói> tests" và <gói> khớp một workspace có script
  test (tên gói, đuôi sau `/` hay tên thư mục) thì bước test chỉ chạy gói đó (`yarn workspace <tên> test`, `pnpm
  --filter`, `npm test --workspace=`). Item sửa file của một workspace khác có test (git diff HEAD + file mới) thì chạy
  cả bộ: runner của repo chạy các gói song song, lệnh theo gói chạy lần lượt (LXRMBRA2 CR-07: core rồi web, hết 600 s).
  File sửa trong app mà ngoài mọi workspace (package.json gốc, tsconfig, lockfile) cũng chạy cả bộ. Đề ghi "the whole test suite" hay không
  nêu gói (TASK-08) thì chạy cả bộ như cũ. Kết quả test mang `scope {packages, reason}`, dòng verification ghi
  `scoped to …`; lệnh theo gói không kèm reporter JSON, số đếm đọc từ log. Typecheck và build vẫn chạy cả repo.
- Rủi ro còn lại: grader chấm thêm gói khác mà đề không nêu, và một thay đổi trong gói được chấm làm hỏng test của gói
  khác mà item không sửa. Tắt: `"scopedTests": false`.


## Sau QDO8W480 (11/11): hạn trả bài của item helper tự publish, tra log theo thứ tự và theo hạn

QDO8W480 (bộ 14 item): ba PI hạn 10 phút mất 164/260 điểm. PI-04 bàn giao ở phút 5,4 khi chưa sửa source (item đóng ở
phút 10); PI-02 tra 2 truy vấn × 507 giờ = 1015 lời gọi, job chạy 19 phút; 341 lời gọi của PI-03 chạy chung băng thông
mất 588 s; cả hai nộp trường báo cáo trống.

- `timeBox` (`tools.mjs`, `publishReserve`): item helper tự publish (PI, item chỉ trả lời, `autoPublish` bật) chừa
  `SELF_PUBLISH_RESERVE_MIN` = 2 phút thay vì 5 (publish thật của PI 12–49 s, không có lượt root). `timeBox` và dòng
  của `match_state` có `reserveMinutes`; ngưỡng cơ hội cuối (`lastCallThreshold`) của các item này bằng đúng mức đó,
  nên thợ không bị gọi dừng khi còn 4 phút như trước. BUG/CR (root publish) giữ 5 phút và ngưỡng cũ.
- Thứ tự gọi Company Tools (`company.mjs` `throttle(weight)`): request đang chờ có weight nhỏ hơn đi trước. Lời gọi lẻ
  weight 0; mỗi lời gọi của một lần tra hàng loạt mang weight bằng số lời gọi của cả lần tra (`planSize`), nên lần tra
  ngắn xong trước và lời gọi lẻ không bị giữ sau một lần tra dài.
- `logLookup` từ chối ngay (`LOOKUP_TOO_LARGE`) lần tra không kịp xong trước `returnBy` của item: số lời gọi tối thiểu
  (truy vấn × giờ) cộng phần còn lại của các lần tra ngắn hơn đang chạy, chia cho `ratePerMinute()` (cửa sổ chặt nhất
  của `companyLimits`, mặc định 108/phút). Lỗi ghi số lời gọi còn vừa và cách thu hẹp. Lần tra từ 20 lời gọi trở xuống
  và item chưa có `returnBy` không bị chặn. Khối `<search_logs>` của brief nói rõ giá của khung giờ.
- Slot (`maxItemsInFlight` = 5; PI và item chỉ trả lời không giữ slot; Codex cho 16 thread nên giới hạn là của helper):
  - `answerOnlyText` (`decide/signals.mjs`) nhận thêm item có tiêu chí nghiệm thu nhưng mục Grading ghi "Each field is
    compared exactly" và không nhắc test, suite, source, build, import, hidden. TASK-10, TASK-11, TASK-12 của bộ 12 và
    14 item (23 lần nộp, không lần nào sửa code) trước đây giữ slot như item code: QDO8W480 TASK-11, TASK-12 chờ slot
    7–9 phút. Giờ chúng bắt đầu ngay, không cài dependency, helper tự publish.
  - Item có hạn riêng (`deadlineMinutes`) được vượt giới hạn tối đa `deadlineOverflow` item (runtime.json, mặc định 2,
    0–4; 0 là tắt): QDO8W480 TASK-07 (hạn 15 phút) ra ở phút 19,2 khi 5 slot bận, Start Work ở phút 28,3, đóng ở
    phút 34,4 chưa nộp. Thứ tự lấy slot vẫn là `suggestedOrder` (PI, rồi ít phút còn lại nhất).
- Bỏ giới hạn số item làm cùng lúc (quyết định của user 11/11): `maxItemsInFlight` mặc định 0 = không giới hạn
  (`loadRuntimeConfig` trả `Infinity`; 1–32 trong `local/runtime.json` đặt lại giới hạn, khi đó `deadlineOverflow` còn
  tác dụng). Mọi item được prepare và spawn thợ ngay khi ra đề; Codex `max_concurrent_threads_per_session` 16 → 32.
  Máy được giữ ở lúc chạy lệnh nặng: `env/heavy.mjs` `withHeavySlot` bọc từng lệnh typecheck, build, test của
  `run_checks`, tối đa `maxHeavyCommands` lệnh cùng lúc trên cả máy (mặc định một nửa số luồng CPU, ít nhất 3). Chỗ là
  file tạo độc quyền trong `.team-work/scratch/heavy/` vì `run_checks` chạy ở helper của root lẫn của từng thợ; chỗ của
  tiến trình đã chết được lấy lại. Lệnh đang chờ ghi `queued[name]` vào `checks.json`, kết quả có `queuedMs`; timeout
  của lệnh tính từ lúc có chỗ. Chưa bọc: build của `app start` khi không dùng lại bản build của run_checks, cài
  dependency của worktree.
- Script BTC phát chạy trong trang của app: `capture_evidence` có bước `runScript {file, arg | argFile, argPath}`
  (`env/browser.mjs` `scriptStep`). QDO8W480 CR-05: `challenge/CR-05-seed.js` ("Evaluate this function in the app's
  page ... page.evaluate(seed, data)") nạp dữ liệu chính thức vào budget đang mở; không có bước nào chạy được nên thợ
  tự viết script Playwright, mất 5 phút rồi hết giờ, TC-02..04 NOT_RUN (17/45 điểm; CR-08 cùng kiểu). Chỉ nhận file
  BTC phát cho item (`.team-work/items/<ID>/files/` hay `challenge/` trong matchRoot), không nhận script thợ viết;
  `argFile` là file JSON của item (file kết quả Company Tools được mở lớp `content[0].text`), `argPath` chọn nhánh.
  Kết quả của script nằm trong `steps[]`; lỗi là `SCRIPT_FAILED`, quá 40 s là `SCRIPT_TIMEOUT`. Brief có khối
  `<page_scripts>` (`pageScripts`: file .js của item nhắc `page.evaluate`, "in the app's page" hay `window.$send`)
  với đúng bước cần gọi.
- Đã xem lại, không phải lỗi hạ tầng: lần build app đầu của CR-05 hỏng vì chính code của thợ import
  `loot-core/platform/client/fetch` (không có trong `exports`; CR-07 mắc cùng lỗi và tự sửa ở phút 18,6), không phải
  do node_modules liên kết.
- PI-04 sai cả ba trường báo cáo (45 điểm) dù script tính đúng luật KB-OPS-13: danh mục trong test data có 70 schedule
  (SCH-1001..1070), thợ tự đoán `SCH-1001..SCH-1050` trước khi đọc danh mục; file kết quả ghi `complete: true` (mọi
  truy vấn ĐÃ GỬI đủ dòng) nên script không nghi ngờ, và tính trên 189/645 dòng của tháng 12. Sửa trong
  `match/logs.mjs`: dãy id liên tiếp từ 5 id trở lên được tra tiếp ra hai phía tới khi gặp 3 id liền không có dòng nào
  (`idRuns`, kết quả `extended`); mỗi service có dòng trong kết quả thêm `coverage {service, fetched, total}` (một lời
  gọi mỗi service); hint và khối `<search_logs>` nói rõ `complete` không có nghĩa là đủ sự cố, id lấy từ danh mục.
- Ba CR cùng sửa ba file đăng ký (`FinancesApp.tsx`, `PrimaryButtons.tsx`, `budget/app.ts`): CR-05 dừng ở
  `WORKTREE_CONFLICT`, thợ gỡ tay 3 phút, publish hỏng 3 lần (CR-07: 2 lần). `worktree sync` (`tools.mjs`
  `unionMerge`): file xung đột sau `git apply --3way` mà cả item lẫn main đều không xoá dòng nào của file đó (numstat
  xoá = 0) được gộp bằng `git merge-file --union` (giữ cả hai phần thêm), kết quả trả `autoMerged` và nhắc thợ đọc lại
  rồi `run_checks`. Một bên có sửa dòng thì vẫn là xung đột như cũ. Trong trận, thợ CR-07 nối route vào cuối dòng có
  sẵn bằng lệnh Replace (thành dòng bị sửa): `backlog-references` thêm luật mỗi đăng ký là một dòng mới, không đụng
  dòng có sẵn.
- CR-07 `hidden-fixture` (−11), chưa có cách sửa phía đội. Lỗi `Cannot read properties of undefined (reading 'get')`
  tái hiện được đúng một chỗ: `migrateIds` (`rules/rule-utils.ts:133`) gọi `mappings.get` khi một rule được dựng mà
  `loadMappings()` chưa chạy; `createSchedule` chèn một rule nên sập ở đó khi `loadRules()` đã đăng ký listener. Bước
  tạo và post schedule là phần mới của bộ 14 item (bộ 12 item không có, `hidden-fixture` từng đạt ở OMZJW0S0). Source
  nộp của CR-07 không gọi `.get` trên giá trị nào có thể undefined, và replay của đội (có `loadMappings()` ở đầu) chạy
  qua. Chưa xác định vì sao bản đúng của BTC qua được: cần hỏi BTC, kèm cách tái hiện này.
- Chưa làm: tải toàn bộ log một lần cho cả trận. Chia theo từ phút/giây bị trùng với tháng và ngày trong `dueDate`,
  chia theo giờ tốn 744 lời gọi mỗi service (4 service gần 25 phút ở 120 lời gọi/phút).

## Sau LXRMBRA2 (10/11): lỗi sớm của run_checks, tra log trước khi bàn giao, file lớn

- `run_checks`: mỗi check xong ghi vào `checks.json` (`finished`); một check hỏng trong lúc check khác còn chạy thì
  status/run trả ngay `failed[]` kèm đuôi log. `run` khi source đã đổi so với `startSnapshot` ghi `checks.cancel`
  (runId), tiến trình đang chạy đọc file mỗi giây, giết lệnh con, ghi `cancelled`, rồi lần mới bắt đầu.
- `worker_checkpoint candidate` chờ job `log_lookup` của item còn chạy (90 s, bỏ qua khi item còn dưới 3 phút) và từ
  chối một lần khi worker chưa nhận kết quả (`resultSeen`, đặt ở `job_status`/`company_lookup` trả kết quả).
- Push không còn giới hạn cỡ file; `unpushable` (integration.mjs) chặn đường dẫn cấm trước khi commit lên main local.
- `capture_evidence` nhận app `custom` với appMode worker khai.

## Checklist trước khi bàn giao, luật trong code (11/11, sau EXP3I47A và YSKRYL4B)

Thay cho việc thêm ghi chú theo từng trận: skill `backlog-references` có mục "Before handoff" (sáu câu hỏi chung cho mọi
item), và phần nào máy kiểm được thì `worker_checkpoint candidate` kiểm. Mỗi luật từ chối một lần cho cùng một trạng
thái, chỉ xét khi không còn lỗi nào khác.
- Mục 2, NOT_RUN (`notRunGate`): `submit.json` còn kịch bản NOT_RUN mà còn ít nhất 5 phút tới return_by thì từ chối một
  lần (`notRunAsked` = danh sách id), nhắc làm lại từ trạng thái sạch: browserProfile mới, khởi động lại app, seed lại,
  không dùng chế độ demo. EXP3I47A BUG-09 (−65): ba lần chụp trên profile đã bị "Try Demo" làm hỏng, bàn giao khi còn 23
  phút; YSKRYL4B đổi profile mới và chụp xong trong 9 s.
- Mục 3, test phát hiện được lỗi (`mutantGate`, BUG/CR/TASK, còn ít nhất 6 phút): item sửa code có sẵn và thêm test mà
  chưa có `run_checks {action: "mutants"}` trên source hiện tại thì từ chối một lần (`mutantsAsked` = source); có chỗ sửa
  `survived` thì từ chối một lần nữa (`mutantsSurvivorsSeen`). PI không áp dụng (đua thời gian). EXP3I47A TASK-08 (−4).
- Mục 5, phạm vi: file mới dưới `node_modules/` luôn bị từ chối (YSKRYL4B CR-07: vitest chạy từ thư mục trận ghi 32 file
  cache vào `<folder>/node_modules/`, helper commit lên main).
- `capture_evidence` lưu profile có hạn 8 s (trang kẹt làm `storageState` chờ mãi, lời gọi bị MCP cắt ở 120 s).
- `capture_evidence` báo ngay ở bước hỏng (`profileHint`): profile vừa khôi phục mà app chuyển đường dẫn của `goto` sang
  đường dẫn khác (không tính trang gốc) thì gợi ý thử một lần với browserProfile mới, không tính là lần sửa.
- Judge (`tools/judge/rubric.md`): J5 lần theo dòng cũ của từng hunk với fixture của case (và đọc `mutants.log`), là H
  cho TASK có sản phẩm là bộ test; thêm J11 (H) cho kịch bản không PASS; `fail` phải dựa trên điều đã thấy; cache tool
  commit nhầm chỉ fail J3 khi đổi cách app/test chạy. Sau hai lần chấm lệch grader: EXP3I47A TASK-08, BUG-09 pass; YSKRYL4B
  CR-07, TASK-07 fail.
- Agent kiểm riêng cho item khó và làm lâu: người dùng duyệt, làm sau phần luật code.

## Đo và kiểm

journal.metrics: prepare, code_test, evidence, handoff, blocked, publish; jobs: worktree_setup/publish_item/drop_databases.
Từ 09/11 các giai đoạn của worker đo bằng `phaseClock`: chỉ chuyển ở ready_for_evidence (code_test → evidence) và
candidate; resume không đặt lại đồng hồ, resume sau candidate mở giai đoạn làm lại (`handoff`), thời gian chờ root trả
lời blocked ghi `blocked`. Trước đó mỗi resume đặt lại đồng hồ: OMZJW0S0 TASK-08 chạy 22,7 phút mà ghi code_test 1 s,
evidence 76 s (11,5 phút trong đó là lỗi môi trường: run_checks không thấy yarn, `.snap` bị ghi lại bằng LF).
dispatchMs từ lúc helper quan sát item tới Start Work, không phải release server. usage.mjs xuất bảng
giai đoạn/token/credit/thread; không cộng hoạt động song song thành thời gian toàn trận. Chạy
node --test "tests/pack/*.test.mjs" với git/PowerShell/browser; replay và chấm lại cùng bộ đề sau cài pack mới.
