# 05 · Đặc tả MCP helper `team_runtime`

Helper là phần **code** quan trọng nhất của pack: giữ credential, nói chuyện với Game Master, ghi progress
log, điều khiển git, chạy gate. Root gọi helper qua MCP; LLM không tự gọi HTTP, không tự viết JSON log,
không tự `git push`.

## 1. Vai trò và ranh giới

| Helper làm | Helper không làm |
|---|---|
| Kiểm tra frame, giữ secret trong RAM | Không ghi secret ra file, log, stdout, stderr, argv |
| Đăng nhập trang trận, đọc và parse backlog, poll nền | Không gọi origin ngoài danh sách; không follow redirect sang origin lạ |
| Start Work, Submit (idempotent), ghi biên nhận | Không đoán URL; không gọi Admin/Grader/Player |
| Ghi progress log (validate + ngân sách byte) | Không ghi event bịa (test chưa chạy, biên nhận chưa có) |
| git clone/worktree/commit/push vào repo + branch được giao | Không force-push, không đổi remote, không push branch khác |
| Cài dependency, build, test, gate (job nền) | Không quyết định chiến thuật (việc của root) |
| Tool không trạng thái cho mọi agent (`detect_profile`, `condense_log`) | Không cấp credential cho subagent |

## 2. Tiến trình và vòng đời

- Khai trong `TeamWorkspace/.codex/config.toml` (installer sinh từ `config/codex.toml`, [09 §3](09-dong-goi-va-van-hanh.md#3-configcodextoml-và-file-đăng-ký)):
  `command = "node"`, `args = ["<TeamWorkspace>/team-sdlc-pack/runtime/bin/runtime-server.mjs"]`.
- Codex khởi chạy helper khi thread nạp cấu hình MCP. Root có một tiến trình helper. Subagent có thể có
  tiến trình riêng (**Spike S4**). Chỉ tiến trình đã `configure_session` mới làm việc có trạng thái; tiến
  trình khác chỉ trả lời tool không trạng thái, còn tool khác trả `NOT_CONFIGURED`.
- Helper tự suy ra **TeamWorkspace** từ vị trí file của nó (`bin/` → `runtime/` → `team-sdlc-pack/` →
  TeamWorkspace), kiểm có `TeamWorkspace/.mtm/team-runtime.json`. Đây là mốc tin cậy để kiểm mọi path
  trong descriptor ("preparation derives paths from trusted cwd").
- Tiến trình sống cùng thread: giữa lượt PREPARE và GAME **thường** vẫn là cùng tiến trình (cookie và mật
  khẩu còn trong RAM). Mọi thứ cần sống qua lần kill nằm trong journal (§4) hoặc dựng lại được từ log, git
  và server.
- stdout **chỉ** chứa JSON-RPC. stderr chỉ ghi chẩn đoán ngắn, không có secret (Codex có thể lưu stderr).

## 3. Giao thức MCP (tập con)

- JSON-RPC 2.0, **mỗi message một dòng** (NDJSON) trên stdin/stdout, UTF-8.
- `initialize` → `{protocolVersion: <bản client yêu cầu nếu hỗ trợ>, capabilities: {tools: {listChanged: false}}, serverInfo: {name: "team_runtime", version}}`.
- `notifications/initialized` → không trả lời. `ping` → `{}`. `notifications/cancelled` → huỷ lời gọi
  đang chờ (`wait_for_update`).
- `tools/list` → mỗi tool có `name`, `description` (ngắn, tiếng Anh), `inputSchema` (object,
  `additionalProperties: false`), `annotations` (`readOnlyHint` cho tool chỉ đọc; xem Spike S3).
- `tools/call` → `{content: [{type: "text", text: "<JSON gọn>"}], structuredContent: {...kết quả..., networkActivity?: [...]}, isError}`.
- Method lạ → lỗi `-32601`; JSON hỏng → `-32700`; tham số sai → `-32602`.
- Giới hạn: request ≤ 1 MB; text kết quả ≤ 64 KB (cắt và trỏ tới file nếu dài); **mỗi lời gọi ≤ 55 s**.
  Việc lâu hơn chạy thành **job** (§5.15).
- `structuredContent.networkActivity`: liệt kê mọi request HTTP helper đã gửi kể từ lần trả kết quả
  trước, tối đa 100 mục, dạng `{url, method, httpStatus}` (url không có query). Player dùng mục này cho
  bảng Network & API ([02 §9](02-hop-dong-player.md#9-quan-sát-của-player-đội-cần-biết-để-không-bị-gắn-cờ)).
  Request của poller nền xuất hiện ở kết quả tool kế tiếp.

## 4. Trạng thái

**Trong RAM** (mất khi tiến trình chết):
- `session`: phase, descriptor (bản không secret), secret (`password`, `apiKeySecret`), cookie jar,
  policy (submission, model).
- `matchView` mới nhất ([03 §2.3](03-game-master.md#23-mô-hình-chuẩn-hoá-helper-phải-dựng-ra-matchview)),
  skew đồng hồ.
- Trạng thái item cục bộ: stage, worktree, lượt thử, gate gần nhất, chữ ký lỗi.
- Job đang chạy, hàng đợi sự kiện cho `wait_for_update`, writer của log (kích thước, trạng thái từng
  backlog, blocker đang mở, số restart).

**Journal bền**: `checkoutRoot/.team-work/journal.json`, ghi file tạm rồi rename. Không chứa secret.
```jsonc
{
  "version": 1, "matchId": "ABCD1234", "playerSessionId": "...",
  "preparation": {"revision": "<sha>", "profile": {...}, "baselineFailing": ["test id", "..."]},
  "items": {
    "BUG-01": {
      "startedAt": "...", "materials": ".team-work/items/BUG-01/",
      "attempts": 1, "lastSignature": "NullPointerException@OrderService.total",
      "worktree": ".team-work/wt/BUG-01", "publishedRevision": "<sha>",
      "submitIntent": {"n": 0, "clientSubmissionId": "<uuid>", "gitRevision": "<sha>", "body": "<chuỗi JSON đã gửi>"},
      "receipt": {"id": "<submission.id>", "receivedAt": "..."}
    }
  }
}
```
- `checkoutRoot/.team-work/` gồm `journal.json`, `items/<ID>/` (vật liệu Start Work), `wt/<ID>/`
  (worktree), `results/` (kết quả subagent), `logs/` (log lệnh của gate). Helper thêm `.team-work/` vào
  `checkoutRoot/.git/info/exclude` lúc chuẩn bị. **Không** đặt tên `.mtm` (T11).
- Khi `configure_session`, helper đọc journal (nếu có) và đọc lại progress log để dựng trạng thái của
  validator (§10).

## 5. Danh mục tool

> **Bản đã dựng (pack 0.1.0, 26/10):** `configure_session`, `prepare_checkout`, `setup_environment`, `login_match`,
> `report_ready`, `refresh_match`, `match_state`, `read_item` (mới), `start_work`, `worktree`, `run_gate` (thêm
> `tests-guard`, kiểm `submit.json` theo `submit.schema.json`, `baselineFailures`, `allowTestChange`), `record_verification`,
> `commit_and_push`, `submit_work`, `report_progress`, `wait_for_update`, `job_status`, `detect_profile` (A),
> `capture_evidence` (A, mới: Edge headless qua CDP), `company_tools`/`company_call` (mới: proxy Company Tools, 03 §9).
> `decide` (Jev, mới: `pack/src/jev.mjs`, `decisions.mjs`). **Chưa dựng:** `condense_log`. Code: `pack/src/tools.mjs`.

Ký hiệu: **R** = chỉ root (cần đã configure); **A** = mọi agent. "Job" = trả `jobId` ngay nếu chưa xong
trong ~45 s; kết quả tới qua `wait_for_update` (sự kiện `JOB_DONE`) hoặc `job_status`.

| # | Tool | Ai | Phase | Tóm tắt |
|---|---|---|---|---|
| 5.1 | `configure_session` | R | mọi | Nạp frame, kiểm tra, giữ secret |
| 5.2 | `prepare_checkout` | R | PREPARE, RESUME | Kiểm git auth, clone/kiểm checkout, trả revision |
| 5.3 | `setup_environment` | R (job) | PREPARE, RESUME_PREPARATION | Nhận diện stack, cài dependency, build, test baseline |
| 5.4 | `login_match` | R | mọi | Đăng nhập, mở `/match/<matchId>`, kiểm định danh |
| 5.5 | `report_ready` | R | PREPARE, RESUME_PREPARATION | Ghi `ENVIRONMENT_READY` khi đủ điều kiện |
| 5.6 | `refresh_match` | R | GAME | Đọc trang; lần đầu thì backlog sync; bật poller nền |
| 5.7 | `match_state` | R | GAME | Bảng trạng thái gọn + thứ tự gợi ý (không gọi mạng) |
| 5.8 | `start_work` | R | GAME | Start Work + lưu vật liệu + event |
| 5.9 | `worktree` | R | GAME | `create` / `integrate` / `remove` / `status` |
| 5.10 | `run_gate` | R (job) | GAME | Gate trên worktree hoặc checkout chính |
| 5.11 | `record_verification` | R | GAME | Tạo `BACKLOG_TESTS` từ kết quả checker + gate |
| 5.12 | `commit_and_push` | R | GAME | Kiểm answer + path, commit, push, xác minh SHA |
| 5.13 | `submit_work` | R | GAME | Nộp idempotent, ghi biên nhận |
| 5.14 | `report_progress` | R | mọi | Event do root quyết định (blocker, BLOCKED/FAILED, RESTARTED, ENDED) |
| 5.15 | `wait_for_update` | R | mọi | Chặn ≤ 55 s tới khi có thay đổi |
| 5.16 | `job_status` | R | mọi | Kết quả job |
| 5.17 | `detect_profile` | A | mọi | Nhận diện stack và lệnh build/test cho một path |
| 5.18 | `condense_log` | A | mọi | Rút gọn log lỗi, trả chữ ký |
| 5.19 | `decide` | R | GAME | Quyết định nhanh bằng Jev, có luật dự phòng (D9) |

### 5.1 `configure_session`

- **Input**: `{frame: string}`, là nguyên văn từ dòng marker (vd `START_GAME_V4`) tới hết các khối
  policy. Root chép **y nguyên**, không sửa.
- **Kiểm**: marker hợp lệ và khớp `descriptor.type`; `schemaVersion`; id; path tuyệt đối, nằm trong
  TeamWorkspace và đúng công thức (`checkoutRoot = TW/matches/<matchId>`,
  `matchRoot = checkoutRoot/<folder>`, `progressLogFile = TW/team-sdlc-pack/logs/<matchId>.progress.ndjson`);
  `repository.folder == matchId`; origin `https` (loopback chỉ khi `MTM_TEAM_TEST_MODE=1`); bearer có
  độ dài UTF-8 và SHA-256 khớp `apiKeyLength`/`apiKeySha256`; `apiKeyScopes` có `submission:create`;
  `playerSessionId` không đổi so với lần configure trước trong cùng tiến trình.
- `START_GAME` cần `username`/`password` từ lượt PREPARE. Thiếu (helper đã bị khởi động lại) thì trả
  `NEEDS_PREPARATION_FRAME`, và root gọi lại `configure_session` với frame PREPARE còn trong lịch sử
  thread, rồi gửi lại frame START.
- **Output** (không secret): `{phase, matchId, teamId, paths, restartAttempt, models: {orchestratorModel, allowedModels},
  log: {bytes, restartCount, backlogs: {ID: status}, openBlockers: [...]}, journal: {...tóm tắt}, next: [...]}`.
- **Lỗi**: `INVALID_FRAME`, `PATH_OUTSIDE_WORKSPACE`, `API_KEY_INTEGRITY_MISMATCH`, `SESSION_MISMATCH`.

### 5.2 `prepare_checkout`

1. `GIT_AUTH IN_PROGRESS` → `git ls-remote --heads <url> <branch>` (env §8) → `COMPLETED`, hoặc
   `BLOCKED` + blocker `GIT_AUTHENTICATION_REQUIRED`.
2. `REPOSITORY IN_PROGRESS` → nếu `checkoutRoot` trống: `git clone --branch <branch> --single-branch <url> <checkoutRoot>`.
   Nếu đã có (resume): kiểm `remote.origin.url` khớp `repository.url`, đúng branch, **không** clone lại,
   không xoá. Kiểm `matchRoot` tồn tại. Đặt `user.name`/`user.email` cục bộ của repo (tên đội, email
   noreply), thêm exclude `.team-work/`.
3. `revision = git rev-parse HEAD` (40/64 hex) → `REPOSITORY COMPLETED`.
4. **Output**: `{revision, branch, matchRootExists, clean}`.
- Lúc chuẩn bị chỉ được read/clone/fetch, **không** push.

### 5.3 `setup_environment` (job)

1. `ENVIRONMENT IN_PROGRESS`: `detect_profile(matchRoot)` → kiểm toolchain (`java -version`, `node -v`…)
   → cài dependency theo lockfile (`npm ci`, `mvnw -q -DskipTests dependency:go-offline` hoặc
   `mvnw -q -DskipTests package`, `pip install -r`, `dotnet restore`, `go mod download`, `composer install`)
   → `COMPLETED`/`FAILED`.
2. `BUILD IN_PROGRESS`: build → chạy `test_all` một lần (giới hạn mặc định **4 phút**, và không vượt mốc
   8 phút tính từ `configure_session`, vì cả pha chuẩn bị chỉ có ~10 phút theo Q5), lưu danh sách test đang
   fail sẵn vào `journal.preparation.baselineFailing` → `COMPLETED` nếu **build** pass (summary nêu số test
   fail sẵn có), `FAILED` nếu build fail. Test baseline quá giờ thì vẫn `COMPLETED` (build đã pass) với
   `baseline.status = "TIMEOUT"`; đầu lượt GAME helper chạy lại baseline thành job nền, và gate chỉ chờ job
   này khi cần so regression.
3. **Output**: `{profile, build: "PASS"|"FAIL", baseline: {total, failing}, durations}`.

### 5.4 `login_match`

- Dùng `username`/`password` trong RAM, theo luồng đăng nhập đã xác minh (Spike S2). Theo redirect cùng
  origin (≤ 3). Ghi `GAME_MASTER_API LOGIN` quanh request.
- Sau đó `GET /match/<matchId>` (ghi `REFRESH`), parse, kiểm định danh: `matchId`, team, repository.
  Phase PREPARE: ghi `MATCH_LOGIN IN_PROGRESS` → `COMPLETED` hoặc `FAILED` + blocker.
- **Output**: `{loggedIn, identityVerified, matchStatus, matchUuidFound}`.

### 5.5 `report_ready`

- Điều kiện, helper tự kiểm: `REPOSITORY`, `BUILD` và `MATCH_LOGIN` đã `COMPLETED` (trong phiên này,
  hoặc trong log khi resume); `HEAD` của checkout = revision đã ghi nhận; `requestId`, `repository` lấy từ
  descriptor.
- Log đã có `ENVIRONMENT_READY` **cùng nội dung** thì coi là xong (không ghi lại). Khác nội dung thì từ
  chối (`ENVIRONMENT_READY_CONFLICT`).
- **Output**: `{written: bool, revision}`. Sau đó root **kết thúc lượt** PREPARE.

### 5.6 `refresh_match`

- `GET /match/<matchId>` (ghi `REFRESH`), cập nhật `matchView`, so với lần trước: item mới, item đổi
  nội dung (hash khác), item đổi trạng thái, trận đổi trạng thái.
- **Lần đầu trong phase GAME** (log chưa có `BACKLOG_SYNC COMPLETED`): ghi `GAME_START_STATUS BACKLOG_SYNC IN_PROGRESS`
  → `DISCOVERED` cho mỗi item đang hiện → `BACKLOG_SYNC COMPLETED`, rồi bật poller nền (§6).
- Các lần sau: ghi `DISCOVERED` cho item mới (chỉ trong phase GAME).
- **Output**: `{status, minutesLeft, changes: [...], counts}`.

### 5.7 `match_state`

Không gọi mạng. Trả bảng gọn từng item: `key, type, title, status (trang), local (todo|started|working|gate|published|submitted|failed), deadlineIn, maxPoints, attempts`
và `suggestedOrder` theo luật xếp lịch ([07 §4](07-quy-trinh-tran.md#4-xếp-lịch)), cùng `lanes` đang bận.

### 5.8 `start_work`

- **Input**: `{backlogItemKey}`. Từ chối nếu item `CLOSED`, không thấy trên trang, hoặc thời gian còn
  lại quá ít (trả `TOO_LATE`, root vẫn được ép bằng `{force: true}`).
- `GAME_MASTER_API START_WORK` → POST → lưu `start.json`, `template.json`, `mvs.json`, `files/…` vào
  `.team-work/items/<ID>/` → `BACKLOG_STATUS IN_PROGRESS` → `BACKLOG_TESTS NOT_RUN` (`required` theo
  quy ước [04 §4](04-progress-log.md#4-luật-liên-field-player-kiểm-bằng-code)).
- Replay (200) không ghi lại `IN_PROGRESS` nếu log đã có.
- **Output**: `{type, replay, startInstruction, templateKeys, mvsCount, materialsDir, deadlineAt}`.

### 5.9 `worktree`

- `create {backlogItemKey}`: `git worktree add -b team/<ID> <checkoutRoot>/.team-work/wt/<ID> <HEAD chính>`;
  chép template thành `<wt>/<folder>/answers/<ID>/submit.json` (nếu chưa có), tạo `evidence/`. Nếu stack
  cần cài lại dependency cho worktree (vd `node_modules`), bắt đầu job cài. **Output**:
  `{worktreeRoot, matchRoot, baseRevision, setupJobId?}`.
- `integrate {backlogItemKey}`: trong worktree `git add -- <folder>` + commit cục bộ; ở checkout chính
  `git cherry-pick <sha>`. Xung đột thì `--abort` và trả danh sách file xung đột. **Output**:
  `{integrated, headRevision, baseChanged}`.
- `remove {backlogItemKey}`: `git worktree remove --force` + xoá branch cục bộ `team/<ID>`.
- Branch `team/<ID>` **chỉ** tồn tại cục bộ, không bao giờ push.

### 5.10 `run_gate` (job)

- **Input**: `{backlogItemKey, where: "worktree"|"main", testsAdded?: [..], needsDependency?: bool}`
  (lấy từ file kết quả của worker).
- Thứ tự (dừng ở lỗi đầu tiên), port từ `orchestrator/gate.py`, giới hạn trong `config/runtime.json`:
  1. Diff không rỗng và trong giới hạn (mặc định ≤ 15 file, ≤ 600 dòng; **không** tính `answers/<ID>/`)
     → `no_change` / `diff_too_large`.
  2. Thay đổi bị cấm: thêm marker skip vào test, xoá file test, giảm số assertion, đổi build file khi
     không `needsDependency`, đổi CI, file nằm ngoài `<folder>/`, evidence ở thư mục cấm → `forbidden_change`.
  3. Build → `compile`.
  4. `testsAdded` qua `test_one` (lọc bằng `SAFE_TARGET`; fail thì chạy lại 1 lần để loại flaky) →
     `original_still_failing`.
  5. `test_all`, so với `baselineFailing` (chỉ tính lỗi **mới**) → `regression`.
  6. Lệnh MVS nếu có → `mvs_fail`.
  7. Kiểm answer: `submit.json` là JSON hợp lệ, giữ đủ key của template, mọi chuỗi `evidence/<file>` đều
     tồn tại.
- Hết giờ → `timeout`. Log lệnh: `.team-work/logs/<ID>-gate-<n>-<check>.log`. Lỗi được chạy qua
  `condense_log` để có `signature`.
- **Output** (`GateReport`): `{passed, failKind, signature, checks: [{name, status, ms, log, condensed}], regression: {executed, passed, failed, skipped}}`.

### 5.11 `record_verification`

- **Input** (bản đã dựng): `{backlogItemKey, gateJobId, scenariosPassed, scenariosFailed, scenariosSkipped}`.
  Root báo số kịch bản đã thật sự chạy (từ evidence của fixer và tự kiểm). `required` = số kịch bản bắt buộc
  khai ở `start_work` + 1 (gate). `PASSED` chỉ khi mọi kịch bản bắt buộc pass **và** gate pass; kịch bản chưa chạy
  không bao giờ được tính là đạt (Practice #1, L4).
- Root **không** tự ghi `BACKLOG_TESTS` bằng `report_progress`; đây là chỗ duy nhất, để số luôn là số thật.

### 5.12 `commit_and_push`

1. Kiểm trên checkout chính: `answers/<ID>/submit.json` hợp lệ; evidence tham chiếu đều có; mọi file thay
   đổi nằm dưới `<folder>/`; không có `<folder>/evidence/`, `<folder>/challenge/evidence/`; không file
   > 5 MB; không có file trông như secret (`.env`, `*.pem`, token).
2. `git add -- <folder>` → `git commit -m "<ID>: <tóm tắt>"`.
3. `git push origin HEAD:refs/heads/<branch>` (không `--force`, env §8). Bị từ chối non-fast-forward thì
   `git fetch origin <branch>` + `git rebase origin/<branch>` (cục bộ) + build nhanh + push lại, tối đa 2
   lần.
4. Xác minh `git ls-remote origin refs/heads/<branch>` == `HEAD` → ghi `journal.publishedRevision` →
   (tuỳ chọn) `BACKLOG_STATUS COMPLETED`.
- **Output**: `{revision}` (SHA đầy đủ). Lỗi xác thực → blocker `GIT_AUTHENTICATION_REQUIRED`.

### 5.13 `submit_work`

1. **Input**: `{backlogItemKey, gitRevision}`. Kiểm: revision = `publishedRevision` đã xác minh trên remote;
   revision chứa `answers/<ID>/submit.json` và mọi evidence tham chiếu (`git cat-file -e`); trận `IN_PROGRESS`;
   item `OPEN`.
2. Tạo body theo [03 §6](03-game-master.md#6-clientsubmissionid-tất-định-d7); **ghi `submitIntent` vào
   journal trước** khi gửi.
3. `GAME_MASTER_API SUBMIT REQUESTED` → POST (header `Idempotency-Key`) → xử lý theo bảng
   [03 §5](03-game-master.md#5-mã-lỗi-và-cách-helper-xử-lý) → `SUCCEEDED`/`FAILED`.
4. 201 có `submission.id` → lưu `receipt` → `BACKLOG_STATUS SUBMITTED` (revision, `receiptId = submission.id`).
- **Output**: `{status: "SUBMITTED"|"PENDING_RETRY"|"REJECTED", receiptId?, replay?, errorCode?}`.

### 5.14 `report_progress`

- **Input**: `{event}`, không có envelope. Helper thêm `schemaVersion`, `playerSessionId`, validate rồi append.
- Root chỉ được dùng cho: `BLOCKER_OPENED`, `BLOCKER_RESOLVED`; `BACKLOG_STATUS` với `IN_PROGRESS` (bắt đầu
  lại), `COMPLETED`, `BLOCKED`, `FAILED`; `ORCHESTRATOR_RESTARTED` (helper điền `attempt` theo
  [04 §5](04-progress-log.md#5-luật-chuyển-trạng-thái)); `ORCHESTRATOR_ENDED`; `PREPARATION_STATUS` hoặc
  `GAME_START_STATUS` với `BLOCKED`/`FAILED`.
- Loại do helper giữ độc quyền: `ENVIRONMENT_READY`, `GAME_MASTER_API`, `DISCOVERED`, `SUBMITTED`,
  `BACKLOG_TESTS`. Riêng `ORCHESTRATOR_STARTED` thì không ai trong đội được ghi.

### 5.15 `wait_for_update`

- **Input**: `{timeoutMs ≤ 55000, cursor?}`. Có sự kiện chưa lấy thì trả ngay.
- Sự kiện: `ITEM_NEW`, `ITEM_CLOSING` (còn ≤ 5 phút tới deadline mà chưa
  nộp), `ITEM_CLOSED`, `MATCH_STATUS` (`PAUSED`, `FINISHED`, `TIME_OVER`, `CANCELLED`), `JOB_DONE`,
  `RESULT_FILE` (file mới trong `.team-work/results/`, tức subagent xong), `AUTH_EXPIRED`, `LOG_BUDGET`.
- **Output**: `{cursor, events: [...], state: {status, minutesLeft, open, working, submitted}}`.
- Trận kết thúc thì trả ngay `MATCH_STATUS`; poller dừng.

### 5.16 `job_status`

`{jobId}` → `{state: running|done|failed, result?}`.

### 5.17 `detect_profile` (A)

Port `orchestrator/profile.py`: `{path}` → `{stacks: [{id, root, build, test_all, test_one, run_app, forbidden_skip}]}`.
Không trạng thái, không mạng.

### 5.18 `condense_log` (A)

Port `orchestrator/logs.py`: `{path | text, maxLines}` → `{signature, lines}`. Chữ ký không chứa số dòng
và path worktree, nên giữ nguyên qua các lần thử.

## 6. Poller nền

- Bật sau lần `refresh_match` đầu tiên trong phase GAME. Chạy tuần tự, không chồng request, có jitter ±2 s.
- Nhịp theo ngân sách byte của log ([04 §7](04-progress-log.md#7-ngân-sách-byte-và-nhịp-polling)):
  15 → 30 → 60 s → dừng.
- Mỗi lần đọc: ghi `REFRESH` (REQUESTED + SUCCEEDED/FAILED), diff, đẩy sự kiện vào hàng đợi của
  `wait_for_update`, ghi `DISCOVERED` cho item mới.
- Gặp 401 hoặc redirect về trang đăng nhập thì đăng nhập lại một lần (ghi `LOGIN`). Vẫn lỗi thì đẩy
  sự kiện `AUTH_EXPIRED` và mở blocker `MATCH_LOGIN_AUTHENTICATION_REQUIRED`.
- Trận `PAUSED` thì dừng poll (Player sẽ kill cây tiến trình). Hết trận thì dừng hẳn.

## 7. HTTP client

- `fetch` có sẵn của Node, `redirect: "manual"`; chỉ theo redirect cùng origin đã cho phép, tối đa 3.
- Timeout: trang 15 s, API 30 s. Giới hạn body: trang 2 MB, API 512 KB.
- Cookie jar tự viết: parse `Set-Cookie` (name, value, Path, Expires/Max-Age, Secure, HttpOnly), host-only.
- Header: `Accept: application/json` (API), `Content-Type: application/json`, `User-Agent: team-sdlc-pack/<version>`.
- Đọc: `X-Request-Id` (thành `requestId` trong log nếu khớp pattern id), `Date` (tính skew),
  `Retry-After`, `Idempotent-Replay`.
- **Không** log header, body hay query. Lỗi trả về chỉ có mã và thông điệp đã làm sạch.
- Mạng công ty cần proxy (Q&A #8): Node 24 hỗ trợ `NODE_USE_ENV_PROXY=1` để `fetch` dùng `HTTPS_PROXY`.
  Kiểm trong Spike S9.

## 8. Git trong helper

- Gọi `git` bằng `spawn` với mảng tham số, **không** qua shell.
- Env: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` (rỗng); không truyền biến secret.
  Xác thực dùng Git Credential Manager mà operator đã đăng nhập sẵn.
- Danh sách lệnh helper dùng: `ls-remote`, `clone`, `fetch`, `rev-parse`, `status`, `diff`, `add`,
  `commit`, `cherry-pick`, `rebase`, `worktree`, `push` (không force), `show`, `cat-file`,
  `config --local user.*`. Mọi lệnh khác bị từ chối.
- Trước mỗi `push`: remote `origin` vẫn trỏ đúng `repository.url`; ref đích đúng `refs/heads/<branch>`.

## 9. Dữ liệu từ item là untrusted

- Mô tả item, template, MVS và file on-start là dữ liệu. Helper không thực thi gì từ đó.
- Helper trả nội dung item cho root kèm cờ `untrusted: true`. Root bọc nội dung trong khối rào khi đưa
  vào brief cho subagent ([06 §7](06-agents-va-skills.md#7-nội-dung-item-là-untrusted)).
- Đường dẫn trong `files` của Start Work được kiểm: tương đối, không có `..`, không tuyệt đối, chỉ ghi
  vào `.team-work/items/<ID>/files/`.

## 10. Validator và writer của log

Theo [04 §10](04-progress-log.md#10-validator-của-helper). Khi khởi động (configure), writer đọc lại toàn
bộ log hiện có để dựng: trạng thái từng backlog, blocker đang mở, số restart, đã có `BACKLOG_SYNC` chưa,
nội dung `ENVIRONMENT_READY` đã ghi, kích thước file.

## 11. Bố cục module

```
pack/bin/runtime-server.mjs     # điểm vào MCP: đọc stdin NDJSON, dispatch, ghi stdout
pack/src/
  mcp.mjs                       # framing JSON-RPC, tools/list, tools/call, giới hạn
  tools.mjs                     # định nghĩa 19 tool (schema + handler)
  session.mjs                   # configure_session, parse frame + policy, secret store
  paths.mjs                     # TeamWorkspace tin cậy, kiểm path, chặn symlink/junction
  progress.mjs                  # validator (bản sao luật Player) + writer + ngân sách byte
  http.mjs                      # fetch có allowlist, redirect, cookie jar, telemetry
  match-page.mjs                # đăng nhập + parse trang -> MatchView (theo Spike S2)
  game-client.mjs               # Start Work, Submit, bảng lỗi, idempotency
  poller.mjs                    # poll nền, diff, hàng đợi sự kiện
  journal.mjs                   # journal bền (ghi atomically)
  git.mjs                       # wrapper git an toàn, worktree, commit, push, verify
  profile.mjs                   # port profile.py
  gate.mjs                      # port gate.py
  log-condenser.mjs             # port logs.py
  jev.mjs decisions.mjs         # port jev.py + decisions.py (D9)
  jobs.mjs                      # job nền (spawn, timeout, kill cây tiến trình con)
  scheduler.mjs                 # thứ tự gợi ý (07 §4)
  redact.mjs                    # che secret trong mọi chuỗi trả ra
pack/config/runtime.json        # giới hạn gate, timeout, nhịp poll, ngưỡng byte
pack/contracts/*.schema.json    # progress-event (của BTC), worker-result, checker-result, agent-result
```

## 12. Mã lỗi ổn định

`NOT_CONFIGURED`, `INVALID_FRAME`, `NEEDS_PREPARATION_FRAME`, `SESSION_MISMATCH`, `PATH_OUTSIDE_WORKSPACE`,
`API_KEY_INTEGRITY_MISMATCH`, `ORIGIN_NOT_ALLOWED`, `MATCH_IDENTITY_MISMATCH`, `MATCH_UUID_NOT_FOUND`,
`LOGIN_FAILED`, `GIT_AUTH_FAILED`, `CHECKOUT_MISMATCH`, `ITEM_NOT_OPEN`, `TOO_LATE`, `WORKTREE_CONFLICT`,
`GATE_FAILED`, `ANSWER_INVALID`, `PATH_NOT_ALLOWED`, `PUSH_REJECTED`, `REVISION_NOT_ON_REMOTE`,
`SUBMIT_REJECTED`, `ALREADY_SUBMITTED_NO_RECEIPT`, `EVENT_INVALID`, `LOG_BUDGET_EXCEEDED`,
`ENVIRONMENT_READY_CONFLICT`, `JOB_TIMEOUT`.

### 5.19 `decide` (R, mới, D9)

- **Input**: `{point: "triage"|"route"|"claims_supported"|"root_cause_confirmed"|"next_action", backlogItemKey, context?}`.
  Helper tự lấy dữ liệu cần thiết (đề, kết quả worker, báo cáo gate, số lần thử) rồi dựng câu hỏi
  (`noul` / `choice` / `score`) như `orchestrator/decisions.py`.
- **Hành vi**: gọi Jev (`src/jev.mjs`, `fetch`, timeout 5 s, thử lại 1 lần). Lỗi hoặc dưới ngưỡng
  (`config/jev.json`) thì dùng luật code. Giới hạn cứng nằm trong code ([08 §8](08-guardrails.md#8-jev-typesafe)).
- **Output**: `{point, answer, source: "jev"|"rule", confidence?, reason}`; ghi vào `.team-work/decisions.ndjson`.
- `enabled = false` hoặc thiếu key → luôn `source: "rule"`.
- Tool này làm `suggestedOrder` và `match_state` tốt hơn (độ khó, mức độ) nhưng root vẫn quyết định cuối.
