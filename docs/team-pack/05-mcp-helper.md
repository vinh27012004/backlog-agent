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
- Codex khởi chạy helper khi thread nạp cấu hình MCP. Root có một tiến trình helper. **Mỗi subagent có tiến
  trình riêng** (đã thấy 27/10: `/root/bug02_fix1` gọi `read_item` nhận `NOT_CONFIGURED`). Chỉ tiến trình đã
  `configure_session` mới làm việc có trạng thái; tiến trình khác chỉ trả lời tool không trạng thái, còn tool
  khác trả `NOT_CONFIGURED`. Đây là lựa chọn cài đặt, không phải luật BTC ([01 D4](01-kien-truc.md#5-quyết-định-thiết-kế)).
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
  Tool có `readOnlyHint` thì Codex không gửi cho `auto_review`; tool không có thì mỗi lời gọi tốn một lượt
  guardian (Practice #2: 88 lượt cho root, khoảng 17% token cả trận). Chỉ đọc: `match_state`, `read_item`,
  `wait_for_update`, `job_status`, `detect_profile`, `decide` (chỉ ghi sổ nội bộ), `company_tools`.
- `tools/call` → `{content: [{type: "text", text: "<JSON gọn>"}], structuredContent: {...kết quả..., networkActivity?: [...]}, isError}`.
- Method lạ → lỗi `-32601`; JSON hỏng → `-32700`; tham số sai → `-32602`.
- Giới hạn: request ≤ 1 MB; text kết quả ≤ 64 KB (cắt và trỏ tới file nếu dài); **mỗi lời gọi ≤ 55 s**,
  trừ `job_status` (≤ 110 s, dưới `tool_timeout_sec = 120`). Việc lâu hơn chạy thành **job** (§5.15).
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
  "preparation": {"revision": "<sha>", "profile": {...}, "baselineFailing": ["test id", "..."],
    "jobs": [{"id": "job-1-setup_environment", "kind": "setup_environment", "state": "done", "startedAt": "...", "ms": 84000}]},
  "items": {
    "BUG-01": {
      "startedAt": "...", "materials": ".team-work/items/BUG-01/",
      "attempts": 1, "lastSignature": "NullPointerException@OrderService.total",
      "worktree": ".team-work/wt/BUG-01", "publishedRevision": "<sha>",
      "submitIntent": {"n": 0, "clientSubmissionId": "<uuid>", "gitRevision": "<sha>", "body": "<chuỗi JSON đã gửi>"},
      "receipt": {"id": "<submission.id>", "receivedAt": "..."},
      "jobs": [{"id": "job-4-run_gate", "kind": "run_gate", "state": "done", "startedAt": "...", "ms": 155000}],
      "endedAt": "...", "outcome": "SUBMITTED"
    }
  }
}
```
- `jobs` (30 job gần nhất) và `endedAt` + `outcome` chỉ để đo sau trận (`tools/judge/usage.mjs`). `outcome`
  ghi lần đầu item kết thúc: `SUBMITTED`, `ALREADY_SUBMITTED`, `FAILED` (root ghi `BACKLOG_STATUS FAILED`, tức bỏ
  item) hoặc `CLOSED` (item bị đóng trước khi nộp).
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
> `capture_evidence` (A, mới: Edge headless qua CDP), `company_tools`/`company_call` (mới: proxy Company Tools, 03 §9;
> từ 29/10 `company_call {backlogItemKey}` tự lưu kết quả vào `.team-work/items/<ID>/company/<nn>-<tool>.json` và trả
> `savedTo`, vì ở TOKXKPBV chuẩn xuất CSV của CR-01 chỉ nằm trong brief, reviewer và người chấm không đối chiếu được).
> `decide` (Jev, mới: `pack/src/jev.mjs`, `decisions.mjs`). **Chưa dựng:** `condense_log` (chữ ký lỗi và rút log đã có
> bên trong gate, `pack/src/logs.mjs`). Code: `pack/src/tools.mjs`.
>
> **27/10 (ý tưởng từ harness mẫu, mục 1–3):** hard gate (integrate và `commit_and_push` chỉ nhận đúng nội dung gate
> đã kiểm, §5.9, §5.12), gate kiểm `testResults` theo template/MVS/status (§5.10), `record_verification` đếm từ
> `submit.json` (§5.11), gate trả `signature` + `repeat`, lần 3 thì `next_action` thôi đề xuất retry.
> **Cùng ngày, mục 5–7, 9, 10:** check `test-quality` (`weak_test`), kết quả test máy đọc theo id, chạy lại test
> flaky, `tests-kept`, `fail-before` trên worktree probe (§5.10).
> **Mục 13:** `capture_evidence` có bước `route` / `unroute` (CDP `Fetch`): trình duyệt tự trả lời request khớp `url`
> (chuỗi con hoặc mẫu `*`, lọc `method`) bằng `status` + `body`, `abort` (`TimedOut`, `Failed`, `InternetDisconnected`…)
> hoặc làm chậm `delayMs` rồi cho đi tiếp; `times` giới hạn số lần, luật mới nhất thắng. Dùng cho MVS kiểu "khi API lỗi
> / quá hạn thì hiện…" mà không phải sửa code (hard gate sẽ chặn) hay tắt server/database dùng chung. Kết quả có
> `routed` và `note` nhắc ghi vào answer rằng lỗi được giả lập. Test: `browser.test.mjs` (500, TimedOut, mạng chậm).
> **29/10 (Practice 9KNXREJ5, L60):** bước `login {url, matchRoot}` đăng nhập bằng tài khoản mà seed của app tạo
> (`pack/src/applogin.mjs`: biến `process.env.X ?? "mặc định"` trong file seed, giá trị trong `.env` nếu có, không thì
> mặc định). Helper tự điền form và kiểm form đã biến mất; kết quả chỉ nêu tên biến và nguồn, không có giá trị. Lý do:
> agent tự moi mật khẩu trong seed bị auto-review chặn như dò mật khẩu.
>
> **28/10:** codegraph (§5.21): MCP server ngoài `@colbymchenry/codegraph` thay cho CodeGraph của kiến trúc cũ (chưa từng
> dựng); helper chỉ dựng index. Bỏ "system map". Cùng ngày: proxy cho subagent (§5.22), để `team_verifier` chạy
> gate thay root; `run_gate` nhận thêm `fixResultFile`.

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
| 5.9 | `worktree` | R | GAME | `create` / `integrate` / `sync` / `remove` / `status` |
| 5.10 | `run_gate` | R (job) | GAME | Gate trên worktree hoặc checkout chính |
| 5.11 | `record_verification` | R | GAME | Tạo `BACKLOG_TESTS` từ kết quả checker + gate |
| 5.12 | `commit_and_push` | R | GAME | Kiểm answer + path, commit, push, xác minh SHA |
| 5.13 | `submit_work` | R | GAME | Nộp idempotent, ghi biên nhận |
| 5.14 | `report_progress` | R | mọi | Event do root quyết định (blocker, BLOCKED/FAILED, RESTARTED, ENDED) |
| 5.15 | `wait_for_update` | R | mọi | Chặn ≤ 55 s tới khi có thay đổi |
| 5.16 | `job_status` | R | mọi | Kết quả job |
| 5.17 | `detect_profile` | A | mọi | Nhận diện stack và lệnh build/test cho một path |
| 5.20 | `app_data` | A | mọi | Khoá database dùng chung của app khi seed / tạo dữ liệu kịch bản (mục 8) |
| 5.21 | (codegraph) | A | mọi | Không phải tool của helper: MCP server thứ hai, helper chỉ dựng index |
| 5.22 | (proxy) | subagent | GAME | Không phải tool mới: helper của subagent chuyển `read_item`, `run_gate {fixResultFile}`, `job_status`, `worktree status` sang helper của root |
| 5.18 | `condense_log` | A | mọi | Rút gọn log lỗi, trả chữ ký |
| 5.19 | `decide` | R | GAME | Quyết định nhanh bằng Jev, có luật dự phòng (D9) |

### 5.1 `configure_session`

- **Input**: `{frame: string}`, là nguyên văn từ dòng marker (vd `START_GAME_V4`) tới hết các khối
  policy. Root chép **y nguyên**, không sửa.
- **Kiểm**: marker hợp lệ và khớp `descriptor.type`; `schemaVersion`; id; path tuyệt đối, nằm trong
  TeamWorkspace và đúng công thức (`checkoutRoot = TW/matches/<matchId>`,
  `matchRoot = checkoutRoot/<folder>`, `progressLogFile = TW/team-sdlc-pack/logs/<matchId>.progress.ndjson`);
  `repository.folder == matchId`; origin `https` (loopback chỉ khi `MTM_TEAM_TEST_MODE=1`); bearer có
  độ dài UTF-8 và SHA-256 khớp `apiKeyLength`/`apiKeySha256`; `apiKeyScopes` có `submission:create` (hoặc `submissions:create` như guide ghi, T13);
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
Mỗi item chưa đóng có `returnBy` (PI thêm `checkpointBy`) tính từ lúc gọi, để lần thử mới lấy hạn mới. `releases` =
`{minutes, next: {minute, at}}`: mốc ra đề đọc từ `README.md` của thư mục trận (HIET12OA: "Game Master releases briefs
at minutes 0, 14 and 29"; `parseReleaseMinutes` nhận cả câu tiếng Việt "đề mở ở phút …"), `null` khi README không ghi.
Root canh `wait_agent` để trả về ngay sau mốc tiếp theo. `read_item` trả thêm `relatedEvents`: sự kiện trận nhắc tới
item (vd `INCIDENT: Cảnh báo production khẩn cấp`), vì PI ít thông tin.

### 5.8 `start_work`

- **Input**: `{backlogItemKey}`. Từ chối nếu item `CLOSED`, không thấy trên trang, hoặc thời gian còn
  lại quá ít (trả `TOO_LATE`, root vẫn được ép bằng `{force: true}`).
- `GAME_MASTER_API START_WORK` → POST → lưu `start.json`, `template.json`, `mvs.json`, `files/…` vào
  `.team-work/items/<ID>/` → `BACKLOG_STATUS IN_PROGRESS` → `BACKLOG_TESTS NOT_RUN` (`required` theo
  quy ước [04 §4](04-progress-log.md#4-luật-liên-field-player-kiểm-bằng-code)).
- Replay (200) không ghi lại `IN_PROGRESS` nếu log đã có.
- **Output**: `{type, replay, startInstruction, submitTemplate, minimumVerificationScenarios, files, materialsDir,
  minutesLeft, timeBox, triage, remote?, next}`. `timeBox` = `{minutesLeft, deadline, workMinutes, returnBy, checkpointBy?}`:
  `returnBy` là giờ UTC fixer phải trả kết quả, bằng lúc item (hoặc trận, cái nào đóng trước) đóng trừ 5 phút cho gate +
  nộp (`PUBLISH_RESERVE_MIN`), tối thiểu 1 phút làm việc. PI (đua tốc độ, Game Rules §6) thêm trần `PI_ATTEMPT_MIN` = 12
  phút mỗi lượt và `checkpointBy` = phút 6 (`PI_CHECKPOINT_MIN`): chưa xác nhận được giả thuyết nào thì fixer trả
  `partial` kèm `hypotheses` để root cho kiểm song song. `match_state` lặp lại `returnBy` cho mỗi item chưa đóng để lần thử
  lại lấy hạn mới; trận PAUSED thì hạn thật lùi lại, root đọc lại sau khi trận chạy tiếp.
  `triage.models` = `{fixer: [lần 1, lần 2, …], reviewer, piHypothesis}`, mỗi phần tử
  `{model, reasoning_effort, tier}` hoặc `null` ([06 §9](06-agents-va-skills.md#9-chọn-model)).
- PI: trước triage, `git fetch` nhánh được giao (helper vốn chỉ fetch khi push bị từ chối) rồi trả `remote` =
  `{fetched, newCommits: [{sha, author, date, subject, files}], merged, recentChanges, note?}`. Có commit mới, main không
  có commit chưa push và không có thay đổi chưa commit thì `merge --ff-only` để worktree của PI có commit đó; không thì
  `note` nói lý do (fixer đọc bằng `git show`). Root đưa `remote` vào brief làm `<recent_changes>` ("cái gì vừa thay đổi"
  là nghi phạm số một, SRE / PagerDuty).
- **Test fail ở baseline** (Practice #6 HIET12OA: một test cũ trái ý định của app, `cascade.test.ts`, làm CR-01, TASK-02,
  BUG-02 mất 80 điểm "existing tests"): `baselineFailures` = `{failing, owner, youFix, fixedBy?}` hoặc `null`. `failing` là
  test fail ở baseline mà main chưa có bản sửa. Chỉ **một** item chủ (`baselineOwner` trong journal) được giao xử lý:
  item đầu tiên có `start.json`/`page.json` đòi chạy cả bộ test (`pnpm test`, "existing tests", `mvn test`…); hai fixer
  cùng sửa một test thì item integrate sau bị `WORKTREE_CONFLICT`. Chủ đã nộp, bỏ hoặc integrate mà test vẫn fail thì
  item kế tiếp có MVS như vậy nhận việc. Root đưa nguyên khối vào brief (`<baseline_failures>`).
- `requiredEvidence` = `[{file, beforeFix}]` (bỏ khi rỗng): evidence mà mô tả item đòi ngoài MVS (§5.10 bước 7).
  `beforeFix` = câu chứa "before" (vd "before fixing"): fixer chụp trước khi sửa code. Root đưa vào brief
  (`<required_evidence>`).
- `requirements` = `[{id, text}]` (bỏ khi rỗng), cũng ghi ra `.team-work/items/<ID>/requirements.json`: yêu cầu của **cả
  đề**, vì BTC chấm theo cả đề chứ không chỉ MVS (HIET12OA: "pnpm test passes" chỉ ở Acceptance criteria, gate và
  reviewer cho qua 3 item hỏng; ZVUYZ41V: ảnh "before fixing" chỉ ở mục Submission). `itemRequirements` trong `gate.mjs`,
  thuần code: mục Acceptance criteria → `AC-n` (mỗi dòng danh sách), Expected outcome / Requirements / Canonical scope /
  Normalization / Answer format → `RQ-n` (danh sách thì mỗi dòng, đoạn văn thì mỗi câu), Submission / Evidence →
  `EV-n` (bỏ câu khuôn mẫu gate đã kiểm: chép template, `gitRevision`, `testResults`, schema). Bỏ bảng, khối code, câu
  điểm và hạn; tối đa 24. Root đưa đường dẫn vào brief fixer và reviewer (`<requirements>`); fixer khai từng id trong
  `requirements` của fix-result (`met`/`not_met`/`not_applicable` + bằng chứng), reviewer chấm lại từng id trong
  review. Gate từ fix-result đối chiếu bảng này (§5.10 bước 7).
- `independentAnswer` = `{fields, resultsFile}` (chỉ item có cờ `answerOnly`): `fields` là key của template có giá trị
  nguyên thuỷ trừ `schemaVersion`/`backlogId`/`status` (TASK-01: `position`). Root spawn cùng lúc với fixer một
  `team_pi_hypothesis` giải độc lập (không đọc `answers/` hay `results/`), ghi `answer_values` ra `resultsFile`;
  `record_verification` chặn khi hai đáp án khác nhau (§5.11). Đáp án sai là 0 điểm và không nộp lại được.

### 5.9 `worktree`

- `create {backlogItemKey}`: `git worktree add -b team/<ID> <checkoutRoot>/.team-work/wt/<ID> <HEAD chính>`;
  chép template thành `<wt>/<folder>/answers/<ID>/submit.json` (nếu chưa có), tạo `evidence/`. Nếu stack
  cần cài lại dependency cho worktree (vd `node_modules`), bắt đầu job cài. **Output**:
  `{worktreeRoot, matchRoot, baseRevision, setupJobId?}`.
- `integrate {backlogItemKey}`: trong worktree `git add -- <folder>` + commit cục bộ; ở checkout chính
  `git cherry-pick <sha>`. Xung đột thì `--abort` và trả danh sách file xung đột. **Output**:
  `{integrated, headRevision, baseChanged, baselineFixed?, syncWorktrees?, hint}`. Gate cuối của item làm pass test fail ở
  baseline (`lastGate.fixesBaseline`) thì helper ghi `preparation.baselineFixed[test] = ID` và trả các item còn worktree mở,
  chưa integrate (`syncWorktrees`): root nộp item này rồi `worktree sync` từng item đó (Practice #6).
  - **Hard gate:** trước khi commit, helper tính tree của `<folder>/` trong worktree (trừ `answers/<ID>/`) và so
    với `journal.items[ID].lastGate.tree`. Chưa có gate nào build + test pass → `GATE_REQUIRED`; nội dung khác
    → `GATE_STALE` kèm danh sách file khác. Chặn trường hợp code sửa sau gate (fixer chạy tiếp, reviewer lỡ ghi,
    root vá) lọt vào bản nộp mà không ai kiểm.
- `sync {backlogItemKey}`: worktree chưa có commit riêng → lưu thay đổi file đã track bằng `git diff --binary HEAD`
  (vào `.team-work/scratch/`), `reset --hard <HEAD chính>`, `apply --3way`, `worktreeBase` = HEAD chính. Không stash:
  file chưa track (log của app đang chạy, bị khoá trên Windows) không bị đụng tới; trùng với file main vừa thêm thì
  `WORKTREE_CONFLICT` trước khi đổi gì (Practice #6, L40). Apply xung đột hay bước nào hỏng thì trả worktree về base cũ
  và báo `WORKTREE_CONFLICT` kèm file. Dependency hoặc schema Prisma đổi thì bắt đầu lại job cài (`setupJobId`).
  Dùng khi item khác đã tích hợp bản sửa giao diện dùng chung (Practice #5, L38). **Output**:
  `{synced, baseRevision, changedFiles, setupJobId?}`.
- `remove {backlogItemKey}`: `git worktree remove --force` + xoá branch cục bộ `team/<ID>`. File bị khoá (codegraph.db,
  log của app) thì xoá `.git` của worktree, `worktree prune`, trả `leftover` và để lại thư mục. Mọi tool coi worktree là
  còn khi có file `.git`; `commit_and_push` cho sửa `answers/<ID>/` trên main dù worktree còn (Practice #6, L41).
- Branch `team/<ID>` **chỉ** tồn tại cục bộ, không bao giờ push.
- `.env` của worktree: `TEST_DATABASE_URL` có hậu tố `_<matchid>_<item>` (checkout chính `_<matchid>`), để test DB
  luôn mới theo trận (Practice #5, L34).

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
     tồn tại. **Bản đã dựng thêm** (rubric T1/T5 của harness mẫu, Practice #2 L19): mỗi kịch bản trong
     `testResults` của template có đúng một kết quả; kịch bản `PASS` phải liệt kê đủ file mà MVS ghi ở dòng
     "Required evidence" của mục `## <ID>`; `DONE` mà có kịch bản không `PASS` → lỗi; mọi kịch bản `PASS` mà
     `PARTIAL` → cảnh báo (check `answer` ở trạng thái `warn`, không chặn). Từ 29/10 thêm evidence mà **mô tả
     item** đòi ngoài MVS (`itemEvidence` trong `gate.mjs`: tên file trong câu nói tới screenshot/capture/evidence
     của `descriptionMd`, bỏ tên trong đường dẫn, file submit và file đề; ZVUYZ41V BUG-01 được 0/200 vì thiếu
     `dashboard_before_fixing.png` chỉ có ở mục Submission): file phải có trong `evidence/` và trong
     `evidenceFiles`. Thiếu file → `evidence_missing` (chữ ký `evidence_missing:<files>`, tree vẫn lưu, là một lượt
     fixer chứ không phải sửa answer, không có luật cơ hội cuối); `commit_and_push` cũng kiểm. Gate chạy từ file
     fix-result (verifier) còn đối chiếu `requirements` của fix-result với `requirements` của `start_work`
     (`requirementsCheck`): fix-result không có bảng hoặc bỏ sót id → cảnh báo (reviewer chấm thay); id `not_met` mà
     `status` là `DONE` → `answer_invalid` (sửa thành `PARTIAL` là đủ, J8 của rubric judge); `not_met` với `PARTIAL` →
     cảnh báo "requirements reported not met", verifier đề xuất `retry` nếu fixer còn làm được. Gate main của root (không
     có fix-result) bỏ qua bước này.
- **Thứ tự check của bản đã dựng** (27/10, mục 5–10 lấy từ harness mẫu; tên check trong `checks[]`):
  `diff` → `forbidden` → `tests-guard` → `test-quality` → `code-scan` → `typecheck`/`build` → `tests-added` →
  `regression` → `tests-kept` → (tính `tree`) → `fail-before` → `answer`. MVS chưa có lệnh chạy nên không có `mvs_fail`.
  - Build song song với test (29/10, sau TOKXKPBV: `next build` 31–49 s, khoảng 65% thời gian gate): khi profile có
    `parallelBuild` (stack node có script `build`, script `test` không tự build hay đọc `dist`, không có `pretest`),
    `build` chạy cùng lúc với `tests-added` + `regression` + `tests-kept`. Kết quả vẫn ráp theo thứ tự trên: build fail
    thì trả `compile` và bỏ kết quả test như thể chưa chạy, nên `failKind`, `signature` và `checks[]` giống chạy tuần
    tự. `typecheck` (vài giây) vẫn chạy trước. Stack khác (mvn/gradle cùng ghi `target/`) vẫn tuần tự.
  - `code-scan` (mục 4, rubric dev V2/V3 và `security_rules_core.py` của harness; chỉ cảnh báo, chỉ dòng thêm, tối đa
    15): `TODO`/`FIXME` viết hoa, hàm "not implemented", debug output (`console.log`, `debugger`,
    `System.out.println`; bỏ qua test và thư mục `prisma/`, `scripts/`, `seeds/`, `migrations/`…), SQL viết hoa ghép
    bằng `+`/`${}` hay `$queryRawUnsafe` (template có tag như `` $queryRaw`...` `` thì bỏ qua), credential viết cứng (trừ
    dòng đọc env hay placeholder), chuỗi trông như key thật (`sk-`, `AKIA`, `ghp_`, private key), file rác mới trong
    thư mục trận (`*.bak`, `*-backup`, `*.orig`, `capture-*.mjs`, `scratch-*.ts`…). Chạy trên diff thật của Practice
    #2: không cảnh báo gì cho ba item đã nộp, bắt đúng hai file rác ở worktree CR-01.
  - `test-quality` (rubric Q2/T4 và `validate_test_blackbox.py` của harness): trên dòng thêm của file test. Chặn
    (`weak_test`): test mới không có assertion, assertion không thể fail (`expect(x).toBe(x)`, `assertEquals(a, a)`,
    `assertTrue(true)`...). Cảnh báo: `vi.mock`/`jest.mock` đúng file sản phẩm đang sửa, `catch {}` hay
    `except: pass` trong test, assertion cụ thể bị thay bằng `toBeDefined`/`toBeTruthy`/`assertNotNull`, thêm
    retry hoặc timeout dài hơn (cả trong `vitest/jest/playwright.config`). Chạy trên 6 file test thật của Solova:
    không báo nhầm.
  - Kết quả test máy đọc (`pack/src/testreport.mjs`): vitest `--reporter=default --reporter=json
    --outputFile.json=<log>.json`, jest `--json --outputFile`, pytest `--junitxml`, phpunit `--log-junit`,
    maven/gradle đọc JUnit XML mới ghi trong `target/surefire-reports` / `build/test-results/test`. Với
    `test_all` của node chỉ thêm reporter khi script `test` kết thúc bằng chính runner (`vitest run`, `dotenv ...
    -- jest`); script ghép kiểu `vitest run && node x.js` thì đọc log như cũ. Id test =
    `<file> > <suite> > <test>` (giống dòng FAIL của vitest), pytest dùng node id, java `<pkg>/<Class>.java > <test>`.
    Baseline lúc PREPARE lưu cả trạng thái từng test (`baseline.tests`, tối đa 3000). Đã chạy thật trên Solova
    (`pnpm test` chuyển reporter tới vitest 3.2): 12 test, id đúng cả ký tự `§` mà log console làm vỡ.
  - `tests-added` và `regression`: test fail được chạy lại một lần qua `test_one` (node theo file, python theo node
    id, java `Class#method`); lần hai pass thì là flaky, check ở `warn`, không thành `original_still_failing` /
    `regression`.
  - `tests-kept` (`test_case_disappeared` của harness): test chạy ở baseline mà nay không còn hoặc bị skip →
    `forbidden_change` (chữ ký `tests-removed:<id>`), trừ khi có `allowTestChange`; không có id thì so tổng số test.
    Test đã được bỏ có lý do ở item trước nằm trong `journal.preparation.acceptedRemovals`, gate sau không tính lại.
  - `fail-before` (chỉ gate ở worktree, cần `testsAdded`): chép file test của item vào worktree **probe**
    (`.team-work/wt/_probe`, detached ở base của item, cài dependency một lần, chuẩn bị nền khi tạo worktree item đầu
    tiên, dùng tuần tự, dọn bằng `reset --hard` + `clean -fd`) và chạy `test_one` trên code chưa sửa. Test mới (có
    trong lần chạy với bản sửa, không có trong baseline) không cái nào fail → `warn`; có cái fail thì các test mới pass
    trước khi sửa là đối chứng, chỉ ghi vào `passesBefore`, check `ok`. Probe chưa sẵn sàng sau 90 s thì
    `skipped`. Không chặn: root gửi lại cho fixer (BUG), reviewer nhận trong `<gate_findings>`. Kết quả có
    `reproduced` (ít nhất một test mới fail trên code chưa sửa).
  - `reproduction` (chỉ PI, gate ở worktree, `requireReproduction`): bằng chứng nguyên nhân gốc là test mới fail trên
    code chưa sửa (cách Agentless kiểm patch). Không khai test (`not_reproduced:none`), chỉ khai test cũ
    (`not_reproduced:existing-only`) hoặc mọi test mới đều pass trên code chưa sửa (`not_reproduced:passes-before`) →
    fail `not_reproduced`, chạy trước check answer. Stack không có `test_one` hoặc probe không chạy được thì chỉ `warn`.
    Đã qua build và regression nên `tree` vẫn được lưu: hết giờ thì root vẫn publish được theo luật cơ hội cuối.
    Diff không đổi file nào ngoài `answers/<ID>/` (PI chỉ báo cáo, FMC0ZXFC PI-01) thì check này `skipped`.
  - Mọi check `warn` gom vào `findings` của kết quả để root đưa cho reviewer.
- Build và test pass (kể cả khi chỉ answer sai) thì `codePassed: true` và `tree` = SHA tree của `<folder>/` trừ
  `answers/<ID>/` (index tạm `GIT_INDEX_FILE`, `git add -A` + `git write-tree`), tính sau khi lệnh của gate chạy
  xong. Đây là nội dung mà integrate và `commit_and_push` đòi khớp.
- Hết giờ → `timeout`. Log lệnh: `.team-work/logs/<ID>-gate-<n>-<check>.log`. Check fail có `tail` là log đã rút
  gọn (`condense`, ≤ 15–20 dòng đáng chú ý thay cho đuôi log).
- **Chữ ký lỗi** (port `orchestrator/logs.py` sang `pack/src/logs.mjs`): `compile:<file>:<msg>`,
  `<Exception>@<frame dự án>` hoặc `<Exception>@test:<tên>`, không số dòng, không path worktree; regression
  dùng tên các test mới fail (`regression:<a> | <b>`), thay đổi cấm dùng `forbidden:<path>`, hết giờ
  `timeout:<check>`; `answer_invalid` không có chữ ký (sửa answer không cần lượt fixer). Helper giữ
  `gateHistory` 12 lần gần nhất trong journal và trả `repeat` = số lần item fail với đúng chữ ký đó, kèm `hint`
  khi lặp lần 2 (đổi giả thuyết) và lần 3 (bỏ item; `decide next_action` không còn `retry`).
- **Output** (bản đã dựng): `{passed, failKind, signature, repeat?, hint?, codePassed?, tree?, detail?, findings?, removedTests?, checks: [{name, status, …, source?, tail?, problems?, warnings?}], regression: {total, passed, failed, skipped}, baselineFailures, fixesBaseline?, testsAdded, where}`.
  `fixesBaseline`: test fail ở baseline mà lần chạy này pass (không phải vì bị bỏ), trừ những cái main đã có bản sửa.
  `allowTestChange {reason, source}` lấy từ `test_change` trong fix-result của fixer; `source` là câu trích đề, mã chuẩn
  công ty, hoặc `file:line` trong repo (migration, comment, seed của BTC) cho thấy test cũ trái ý định hiện tại (Practice #6:
  đề BUG-02, CR-01, TASK-02 đều ghi "If an existing test contradicts the application's intended behavior, fix the test").

### 5.11 `record_verification`

- **Input** (bản đã dựng): `{backlogItemKey, gateJobId, scenariosPassed?, scenariosFailed?, scenariosSkipped?}`.
  Số kịch bản lấy từ `testResults` của `answers/<ID>/submit.json` ở nơi gate đó chạy (worktree hoặc checkout
  chính): `PASS` = đạt, `FAIL` = fail, còn lại = chưa chạy. Ba tham số đếm chỉ dùng khi answer không có
  `testResults`; truyền mà khác số trong file thì kết quả có `note`. `required` = số kịch bản bắt buộc
  khai ở `start_work` + 1 (gate). `PASSED` chỉ khi mọi kịch bản bắt buộc pass **và** gate pass; kịch bản chưa chạy
  không bao giờ được tính là đạt (Practice #1, L4).
- Item trả lời thuần có checker giải độc lập (§5.8 `independentAnswer`): đáp án trong `submit.json` khác giá trị của
  lần giải mới nhất (`results/<ID>-solver-<n>.json`, `answer_values`, so chuỗi đã trim) → `ANSWER_DISPUTED`, trừ khi
  root truyền `disputeChecked: true` sau khi một checker `team_pi_hypothesis` bác giá trị của solver. Solver chưa xong
  thì không chặn. Gate cũng trả `answerAgreement` `{state, fields, solverFile}` khi đã có lời giải để so.
- Root **không** tự ghi `BACKLOG_TESTS` bằng `report_progress`; đây là chỗ duy nhất, để số luôn là số thật.

### 5.12 `commit_and_push`

1. Kiểm trên checkout chính: `answers/<ID>/submit.json` hợp lệ (cùng bộ kiểm answer của gate, §5.10); evidence
   tham chiếu đều có; mọi file thay đổi nằm dưới `<folder>/`; không có `<folder>/evidence/`,
   `<folder>/challenge/evidence/`; không file > 5 MB; không có file trông như secret (`.env`, `*.pem`, token).
   **Hard gate** như integrate (§5.9): tree hiện tại của checkout chính phải bằng `lastGate.tree`. Base không đổi
   thì cherry-pick cho đúng nội dung worktree đã gate; main đã có item khác thì tree khác → `GATE_STALE`, phải
   `run_gate` với `where: main`. Gọi lại khi HEAD vẫn là `publishedRevision` và không có gì mới thì bỏ qua bước này.
2. `git add -- <folder>` → `git commit -m "<ID>: <tóm tắt>"`.
3. `git push origin HEAD:refs/heads/<branch>` (không `--force`, env §8). Bị từ chối non-fast-forward thì
   `git fetch origin <branch>` + `git rebase origin/<branch>` (cục bộ) + build nhanh + push lại, tối đa 2
   lần.
4. Xác minh `git ls-remote origin refs/heads/<branch>` == `HEAD` → ghi `journal.publishedRevision` →
   (tuỳ chọn) `BACKLOG_STATUS COMPLETED`.
- **Output**: `{revision, branch, answerWarnings?}` (SHA đầy đủ). Lỗi xác thực → blocker `GIT_AUTHENTICATION_REQUIRED`.

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

- **Input**: `{timeoutMs ≤ 55000, cursor?}`. Có sự kiện chưa lấy thì trả ngay. `cursor: -1` (29/10) = chỉ sự kiện
  từ lúc gọi: vòng chờ "Nothing workable" của skill root dùng nó, thức khi có `ITEM_NEW`/`ITEM_CHANGED`/`ITEM_CLOSING`/
  `MATCH_STATUS`, khi `state.open` có item, khi trận kết thúc, hoặc sau 9 phút (TOKXKPBV: root truyền `cursor: 0`,
  nhận lại 20 sự kiện cũ và thức ngay).
- Sự kiện: `ITEM_NEW`, `ITEM_CLOSING` (còn ≤ 5 phút tới deadline mà chưa
  nộp), `ITEM_CLOSED`, `MATCH_STATUS` (`PAUSED`, `FINISHED`, `TIME_OVER`, `CANCELLED`), `JOB_DONE`,
  `RESULT_FILE` (file mới trong `.team-work/results/`, tức subagent xong), `AUTH_EXPIRED`, `LOG_BUDGET`.
- **Output**: `{cursor, events: [...], state: {status, minutesLeft, nextReleaseAt, open, working, submitted}}`. Sự kiện
  có dạng `{seq, type, at, ...dữ liệu}`; `ITEM_NEW` mang loại item ở `itemType` (trước 28/10 field `type` của item ghi
  đè loại sự kiện, nên root chưa từng thấy `type: "ITEM_NEW"`).
- Trận kết thúc thì trả ngay `MATCH_STATUS`; poller dừng.

### 5.16 `job_status`

`{jobId, waitSeconds ≤ 110}` → `{state: running|done|failed, result?}`. Root chờ cả job trong một `exec`
(pragma `yield_time_ms`, vòng `job_status`), không gọi lại từng 30 s (skill `team-orchestrator`, mục Waiting).
Có PI đã hiện mà chưa Start Work (còn ≥ 3 phút) thì `job_status` và lượt chờ của `run_gate` trả về ngay, hoặc ngay khi
PI hiện giữa lượt chờ, kèm `newPI` và `hint`: root giao PI trước rồi chờ job tiếp (HIET12OA: đề hiện → `start_work`
mất 56 s đến 1 phút 52 vì root đang chờ).

Item thường không làm lượt chờ trả sớm (vòng chờ trong `exec` sẽ quay liên tục). Thay vào đó mọi kết quả tool của
root (trừ `match_state`, `wait_for_update`, `login_match`, `refresh_match`, và không gắn cho lời gọi qua proxy) có
`notice` = `{newItems, freeSlots, hint}` khi có item không phải PI đã ra mà chưa Start Work (còn ≥ 4 phút) trong lúc
số item `started` dưới `MAX_ITEMS_IN_FLIGHT` = 4. `newItems` theo `suggestedOrder`. (ZVUYZ41V: TASK-01 ra lúc
02:49:49, root chỉ bắt đầu lúc 03:02 vì lặp `wait_agent`/`spawn_agent` mà không gọi `wait_for_update`.)

### 5.17 `detect_profile` (A)

Port `orchestrator/profile.py`: `{path}` → `{stacks: [{id, root, build, test_all, test_one, run_app, forbidden_skip}]}`.
Không trạng thái, không mạng.

### 5.18 `condense_log` (A)

Port `orchestrator/logs.py`: `{path | text, maxLines}` → `{signature, lines}`. Chữ ký không chứa số dòng
và path worktree, nên giữ nguyên qua các lần thử. Bản đã dựng: phần port nằm ở `pack/src/logs.mjs` và chỉ gate
dùng (§5.10); chưa mở thành tool riêng vì chưa agent nào cần.

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
  `config --local user.*`, `write-tree` (tree của hard gate, chỉ chạy trên index tạm `GIT_INDEX_FILE`), `clean`
  (chỉ trong worktree probe, sau khi kiểm thư mục có file `.git` riêng). Mọi lệnh khác bị từ chối.
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
  logs.mjs                      # port logs.py (chữ ký lỗi, rút log)
  codegraph.mjs                 # dựng index codegraph cho checkout chính và worktree (§5.21)
  testreport.mjs                # chạy test với reporter JSON/JUnit, id từng test, baseline, test cần chạy lại
  probe.mjs                     # worktree probe ở base cho check fail-before
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
`GATE_FAILED`, `GATE_REQUIRED`, `GATE_STALE`, `ANSWER_INVALID`, `PATH_NOT_ALLOWED`, `PUSH_REJECTED`, `REVISION_NOT_ON_REMOTE`,
`SUBMIT_REJECTED`, `ALREADY_SUBMITTED_NO_RECEIPT`, `EVENT_INVALID`, `LOG_BUDGET_EXCEEDED`,
`ENVIRONMENT_READY_CONFLICT`, `JOB_TIMEOUT`.

### 5.20 `app_data` (A, mới, mục 8)

- Mọi worktree chạy app trên cùng một database dev (chỉ `TEST_DATABASE_URL` có hậu tố riêng theo item), mà seed của
  BTC xoá rồi tạo lại dữ liệu (seed CR-01 "deletes every invoice"): hai item cùng seed hay tạo dữ liệu qua app thì
  làm hỏng evidence của nhau.
- `{action: "lock"|"unlock"|"status", backlogItemKey, minutes? (1–30, mặc định 15), waitSeconds? (≤ 50)}`. Khoá là file
  `team-sdlc-pack/local/app-data.lock.json` tạo độc quyền (subagent có thể gọi helper ở tiến trình khác), tự hết
  hạn, chủ khoá gọi lại để gia hạn. Đang có item khác giữ thì trả `{locked: false, heldBy, until, hint}`.
- `readOnlyHint` (như `decide`): chỉ ghi file khoá nội bộ; agent gọi lặp khi chờ, qua `auto_review` mỗi lần thì tốn token.
- Luật đi kèm (luật chung của subagent, skill root): giữ khoá từ lúc seed tới khi ghi xong report/evidence đọc dữ
  liệu đó; seed rồi chạy các kịch bản dữ liệu **theo thứ tự MVS trong một lượt** (BUG-02: TC-02 thanh toán cho hoá
  đơn của TC-01, report đọc hoá đơn mới nhất sau cả ba case, nên **không** seed lại trước từng kịch bản); dữ liệu
  hỏng giữa chừng (bấm nhầm, giá trị sai, bản ghi VOID) thì dừng, seed lại nếu script ghi là chạy lại an toàn, và làm
  lại từ kịch bản dữ liệu đầu tiên.

### 5.21 codegraph (MCP server ngoài, mới 28/10)

- Thay "CodeGraph + bản đồ hệ thống" của kiến trúc cũ (chỉ có khai báo `enabled = false`, chưa dựng). Practice #4–#5:
  fixer tìm chỗ sửa mất khoảng 8–13 lượt model (0,25–0,46M input) bằng `rg` + đọc nguyên file, và còn đi tìm
  "system map" không tồn tại. "System map" đã bỏ khỏi prompt.
- **Chọn `@colbymchenry/codegraph`** (MIT, ghim phiên bản trong `config/codegraph.json`) thay vì engine tự viết (đã thử
  rồi bỏ, commit 673f8f7): parser cho hơn 30 ngôn ngữ, BTC sẽ đưa repo nhiều stack. Đo 28/10: index Solova (TS, 156
  file) 4,4 s, Flask (Python, 83 file) 2,5 s, spring-petclinic (Java, 50 file) 1,8 s; mỗi truy vấn qua MCP 0,1–1 s;
  `sync` sau khi sửa một file 1,6 s. Trên Python/Java tách đúng hàm trùng tên, bỏ qua docstring, `callees` đầy đủ.
- **Giới hạn đã biết** (ghi trong luật chung của subagent): kết quả chỉ tới hàm gọi (dòng khai báo), không tới dòng
  gọi; không thấy thuộc tính trong lời gọi (procedure tRPC trong `createTRPCRouter({...})`) và lời gọi qua proxy client
  (`api.card.create.useMutation`); nối lời gọi theo tên nên có thể báo nhầm (hàm gọi `Sidebar()` mà không import vẫn
  bị tính). Những chỗ đó agent dùng `rg`.
- **Cài**: installer chạy `npm-cli.js` đi kèm Node (không qua shell): `npm install --prefix
  <TeamWorkspace>/team-sdlc-pack/codegraph --no-save <package>@<version>` (khoảng 258 MB vì kèm runtime Node riêng),
  ngoài `runtime/` (T11). Đã đúng phiên bản thì bỏ qua. Lỗi (không có mạng) hoặc `--no-codegraph` / `-NoCodegraph`
  thì chỉ cảnh báo `CODEGRAPH_NOT_INSTALLED` và bỏ khối `# BEGIN codegraph … # END codegraph` khỏi
  `.codex/config.toml`; pack vẫn chạy, agent dùng `rg`. Checker có mục `codegraph` (phiên bản, khai báo, shim chạy).
- **Khai báo** `[mcp_servers.codegraph]`: `node <shim> serve --mcp`, `CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1`,
  `CODEGRAPH_NO_DOWNLOAD=1` (shim không tự tải bundle từ GitHub giữa trận), `CODEGRAPH_MCP_TOOLS` bật
  `codegraph_explore`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`,
  `codegraph_node` (mặc định chỉ có `explore`). Mọi tool có `readOnlyHint` nên không qua auto_review. Biến bí mật
  không tới server: Codex chỉ chuyển các biến trong `env_vars`.
- **Index** (`pack/src/codegraph.mjs`): server không tự index, và gọi lên thư mục chưa index thì nó bảo agent thôi
  dùng codegraph cả phiên. Nên helper chạy `init -y` (lần sau `sync`) cho `matchRoot` song song với
  `setup_environment`, và cho `wt.matchRoot` ngay trong `worktree create` trước khi trả về (kết quả có
  `codegraph: indexed|failed|not installed`). Lỗi không bao giờ làm hỏng bước gọi nó. Index nằm ở `.codegraph/` trong
  thư mục trận; `prepare_checkout` thêm `.codegraph/` vào `.git/info/exclude` (dùng chung cho mọi worktree) nên không
  lọt vào diff, gate hay commit. Sau đó watcher của server tự `sync` khi agent sửa file (debounce 2 s).
- **Helper đọc index cho triage** (30/10, `pack/src/signals.mjs` `codeTopology`): lúc `start_work`, helper mở
  `.codegraph/codegraph.db` của checkout chính bằng `node:sqlite` (built-in, chỉ đọc, không qua MCP server) để tính
  `impact_radius_files`, `call_depth`, `callers_count`, `callees_count`, `cross_module` cho Jev và luật `difficulty`
  ([08](08-guardrails.md)). Đọc thẳng bảng `nodes`/`edges`/`files`/`project_metadata` của bản 1.6.2 (cạnh: `source`
  phụ thuộc `target`); đổi phiên bản codegraph thì kiểm lại schema. Thiếu index, `index_state` khác `complete`, DB
  khoá/hỏng hay Node không có `node:sqlite` thì `topology: null`, không lỗi. Đo trên Solova (FMC0ZXFC, 148 file): 2–12 ms.
- **Cần theo dõi ở practice**: server giữ file SQLite trong `.codegraph/` của worktree; nếu tiến trình còn sống lúc
  `worktree remove` thì Windows có thể khoá file. Câu hỏi cho BTC: thêm một MCP server thứ hai vào
  `.codex/config.toml` có được không.
- Test: `tests/pack/codegraph.test.mjs` (bản codegraph giả: khối config theo trạng thái cài, checker, `init` rồi
  `sync`, lỗi không ném ra).

### 5.22 Proxy cho subagent (mới 28/10, D4)

- **Vì sao**: ở HIET12OA root tự chạy gate cho từng lượt fixer. Mỗi lần nó ngồi trong một vòng `job_status` tới 3
  phút, không thấy được fixer khác vừa xong, và mỗi bước sau đó là một lượt model trên context 100K+. Guide §2 giao
  việc chạy regression và kiểm kết quả cho Tester, còn integrate và quyết định cuối cho Orchestrator. Subagent
  `team_verifier` làm phần Tester, nhưng tiến trình helper của subagent chưa `configure_session` (§2), và credential
  không được vào prompt của worker (guide §4), nên subagent cần đường gọi sang helper của root.
- **Phía root**: lần `configure_session` đầu tiên trong GAME mở một named pipe (`\\.\pipe\team-runtime-<hex>`; Unix
  socket trong thư mục tạm ở nơi khác), không dùng TCP. Helper ghi `{path, token, pid, playerSessionId}` vào
  `TeamWorkspace/team-sdlc-pack/local/runtime-endpoint.json` (ngoài checkout, không vào commit). Token 24 byte ngẫu
  nhiên, so bằng `timingSafeEqual`. Kết quả `configure_session` có `proxy: {ready}`; lỗi mở pipe không chặn root.
  Server `unref`, chết cùng tiến trình; lần RESUME ghi đè endpoint.
- **Phía subagent**: tool trong `PROXY_TOOLS` gọi khi helper chưa configure thì được chuyển nguyên văn qua pipe,
  một lời gọi một kết nối, chờ tối đa 118 s (dưới `tool_timeout_sec`). Không có endpoint hoặc không kết nối được
  thì trả `NOT_CONFIGURED` như trước. Tool khác vẫn chạy cục bộ (`capture_evidence`, `app_data`, `detect_profile`)
  hoặc trả `NOT_CONFIGURED`.
- **Root tự kiểm từng lời gọi** (`Runtime.proxyCall`), không tin phía gửi:
  - `read_item`: như root.
  - `run_gate`: bắt buộc `fixResultFile` = `<checkoutRoot>/.team-work/results/<ID>-fixer-<n>.json` (đúng thư mục,
    đúng item, nếu không thì `PATH_NOT_ALLOWED`). Gate chạy trên worktree, với `testsAdded`, `needsDependency`,
    `allowTestChange` lấy từ file. Mỗi file chỉ một gate: gọi lại trả job cũ với `reused: true` (journal
    `proxiedGates`). Fixer vì thế không tự chạy gate lặp lại được, và `repeat` cùng thang model chỉ đếm lượt thật.
  - `job_status`: không trả sớm vì `newPI`, vì bắt PI là việc của root.
  - `worktree`: chỉ `status`.
  - Mọi tool khác: `PROXY_DENIED`. Không bao giờ có Game Master, `integrate`, `commit_and_push`, `submit_work` hay
    `report_progress`.
- Lời gọi qua proxy không lấy `networkActivity` của root: request HTTP của poller vẫn báo trong kết quả tool kế tiếp
  của chính root. Journal và progress log vẫn chỉ có một writer.
- Root cũng gọi được `run_gate {fixResultFile}` (khi verifier trả `orchestrator_gate`); khi đó vẫn trả sớm vì PI.
- Test: `tests/pack/e2e.test.mjs` (tiến trình helper thứ hai: các lời gọi bị chặn, file sai, gate qua proxy, gọi lại
  ra cùng job, root thấy cùng job).

### 5.23 `app` (A, mới 29/10, sau TOKXKPBV)

- **Vì sao**: fixer BUG-01 của TOKXKPBV mất khoảng 6 trong 11 phút để tự chạy `pnpm dev` 4 lần, `taskkill` theo port,
  và gỡ một dev server trả CSS cũ (class Tailwind mới không có), rồi mới build bản production. Các trận trước cũng tốn
  thời gian và token cho port bận, log khoá worktree (HIET12OA), app chưa chạy khi chụp (ZVUYZ41V `chrome-error`).
- `{action: "start", backlogItemKey, matchRoot, mode? ("production" mặc định | "dev"), build? (mặc định true), waitSeconds? (≤ 50, mặc định 50)}`:
  `matchRoot` tuyệt đối trong `TeamWorkspace/matches/` (helper của subagent chưa configure nên không tự biết worktree).
  Dừng app cũ của item, chọn port trống 3100–3199 (bỏ port của app item khác đang sống), rồi chạy build và start
  trong **một tiến trình tách rời**: vỏ `node` (detached) gọi `pwsh` với `stdio: inherit`, vì `pwsh` detached trên
  Windows không có console và không ghi gì ra file log. App sống tiếp khi helper của subagent kết thúc. Log ở
  `<checkoutRoot>/.team-work/logs/<ID>-app.log`; trạng thái `{pid, port, mode, log, matchRoot}` ở
  `team-sdlc-pack/local/apps/<ID>.json`. Chờ tới khi `http://localhost:<port>/` trả lời (mã nào cũng được).
- Kết quả: `ready {url, port, pid, mode, log}`; `starting` (chưa xong trong `waitSeconds`: gọi `status`); `failed
  {tail}` (tiến trình thoát, file trạng thái bị xoá).
- Lệnh (chỉ stack node; stack khác trả `UNSUPPORTED_APP` và playbook giữ cách tự chạy): có script `start` thì build
  rồi start, `mode: production`; script là `next start` thì `<pm> exec next start -p <port>` (PORT trong `.env` của
  app có thể đè biến môi trường), còn lại `<pm> run start` với `PORT`. Không có `start` thì `dev`, không build.
  `mode: "dev"` luôn chạy script `dev` (`next dev -p <port>` hoặc `<pm> run dev`), không build; không có script `dev`
  thì `UNSUPPORTED_APP`. Dùng cho kịch bản MVS ghi "development app running" (NO5X6J0K: BUG-01-TC-01 phải `NOT_RUN`,
  mất 67 điểm).
- `status {backlogItemKey, waitSeconds?}`, `stop {backlogItemKey}` (`taskkill /T /F` theo pid trong file trạng
  thái). `worktree remove` của root gọi `stop` trước khi xoá và trả `stoppedApp`.
- Không `readOnlyHint`: chạy tiến trình nên qua `auto_review`.
- Test: `tests/pack/app.test.mjs` (start qua MCP rồi đóng helper mà app vẫn chạy, hai item hai port, start lại thì
  build lại, build fail trả `tail`, đường dẫn ngoài `matches/` bị chặn, lệnh cho Next/dev/java).

### 5.19 `decide` (R, mới, D9)

- **Input**: `{point: "triage"|"route"|"root_cause_confirmed"|"next_action", backlogItemKey, context?}`.
  Helper tự lấy dữ liệu cần thiết (đề, kết quả worker, số lần thử) rồi dựng câu hỏi
  (`noul` / `choice` / `score`) như `orchestrator/decisions.py`. `start_work` đã chạy triage + route trong một
  request (`Decider.intake`), root không gọi lại.
- **Hành vi**: gọi Jev (`src/jev.mjs`, `fetch`, timeout 5 s, không thử lại; 2 lần hỏi lỗi liên tiếp thì nghỉ 5 phút,
  trong lúc nghỉ dùng luật code ngay). Lỗi hoặc dưới ngưỡng (`config/jev.json`) thì dùng luật code.
- **Luật cứng là sàn hoặc điều kiện AND**, Jev không ghi đè được ([08 §8](08-guardrails.md#8-jev-typesafe)): PI luôn
  `critical`; PI, CR và item `hard` luôn `strong`; PI luôn có reviewer (chạy song song với gate), chỉ item `easy`
  (khi Jev nói không cần) mới bỏ reviewer; `root_cause_confirmed` cần `root_cause`, `confidence` ≥ 0.7, một verification
  pass và, khi fix-result có `hypotheses`, ít nhất một cái `confirmed`; Jev chỉ phủ quyết;
  `next_action` chỉ đưa lựa chọn hợp lệ; regex injection chạy trên toàn bộ đề và thắng câu "không" của Jev.
- Jev nhận đề cắt đầu + cuối (mô tả 1.400 + 600 ký tự, hướng dẫn Start Work 600 + 400), để câu lệnh cài ở cuối đề
  vẫn tới được Jev.
- **Output**: `{point, backlogItemKey, jev: status, decisions}`; mỗi quyết định có `value`, `source: "jev"|"rule"`,
  `confidence`, `rule` (câu trả lời của luật code, luôn tính), `jev` (câu trả lời thô của Jev, kể cả khi dưới ngưỡng),
  `reason`. Ghi vào `.team-work/decisions.ndjson` để đo tỉ lệ bất đồng và chỉnh ngưỡng sau trận.
- `enabled = false` hoặc thiếu key → luôn `source: "rule"`.
- `claims_supported` đã bỏ (27/10): gate tự chạy build, typecheck, `tests_added` và regression nên kết quả gate là
  đáp án; Jev ở đó chỉ thêm rủi ro (L17).
- Tool này làm `suggestedOrder` và `match_state` tốt hơn (độ khó, mức độ) nhưng root vẫn quyết định cuối.
