# 05 · Đặc tả MCP helper `team_runtime`

**Cập nhật 03/11:** [13](13-workflow-toi-uu.md) mô tả luồng duy nhất còn lại: prepare_item, worker_checkpoint,
next_actions, publish_item. Gate, reviewer, solver và các tool của chúng đã bỏ (§5, ghi chú 03/11).

Helper là phần **code** quan trọng nhất của pack: giữ credential, nói chuyện với Game Master, ghi progress
log, điều khiển git. Root gọi helper qua MCP; LLM không tự gọi HTTP, không tự viết JSON log,
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
  khác trả `NOT_CONFIGURED`. Đây là lựa chọn cài đặt, không phải luật BTC ([01 D4](01-kien-truc.md#quyết-định-thiết-kế)).
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
  `wait_for_update`, `job_status`, `detect_profile`, `decide` (chỉ ghi sổ nội bộ), `company_tools`, và các tool chỉ
  ghi journal: `worker_checkpoint`, `candidate_preflight`, `result_handoff`, `app_data` (NBDB5U0O: guardian duyệt ba
  tool đầu 101 lượt, 8,2M/24,2M token guardian; hạn mức gói hết sau 30 phút). `worker_checkpoint ready_for_evidence`
  còn tự sync worktree của chính item (4D895OVI) mà vẫn giữ `readOnlyHint`: chỉ đụng worktree đó, xung đột thì giữ
  nguyên, không đụng main, remote hay Game Master.
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
      "jobs": [{"id": "job-4-publish_item", "kind": "publish_item", "state": "done", "startedAt": "...", "ms": 55000}],
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

> **03/11 (bỏ verified mode):** pack chỉ còn một luồng: một `team_fixer` code, chạy test, chụp evidence rồi
> `publish_item {fixResultFile}` ghi candidate, integrate, push và nộp nguyên kết quả đó. Đã bỏ `run_gate`,
> `record_verification`, `candidate_preflight`, `result_handoff`, pre-gate, gate main, hard gate (`GATE_REQUIRED` /
> `GATE_STALE`), `run_gate` qua proxy, điểm `next_action` của `decide`, cùng `pack/src/gate/{gate,probe,logs}.mjs` và
> ba agent `team_reviewer`, `team_pi_hypothesis`, `team_verifier`. Kiểm answer, evidence và yêu cầu của đề
> (`pack/src/match/answers.mjs`) chỉ ra cảnh báo (`warnings` của `publish_item`, `answerWarnings` của
> `commit_and_push`). Regression và fail-before giờ là việc của fixer (`pack/agents/team-fixer.toml`, bước 3). Các
> ghi chú theo ngày bên dưới giữ lại làm lịch sử; mô tả đầy đủ của phần đã bỏ nằm trong git trước ngày này.
>
> **Bản đã dựng (pack 0.1.0, 26/10):** `configure_session`, `prepare_checkout`, `setup_environment`, `login_match`,
> `report_ready`, `refresh_match`, `match_state`, `read_item` (mới), `start_work`, `worktree`, `run_gate` (thêm
> `tests-guard`, kiểm `submit.json` theo `submit.schema.json`, `baselineFailures`, `allowTestChange`), `record_verification`,
> `commit_and_push`, `submit_work`, `report_progress`, `wait_for_update`, `job_status`, `detect_profile` (A),
> `capture_evidence` (A, mới: Edge headless qua CDP; từ 03/11 qua Playwright, §5.25), `company_tools`/`company_call` (mới: proxy Company Tools, 03 §9;
> từ 29/10 `company_call {backlogItemKey}` tự lưu kết quả vào `.team-work/items/<ID>/company/<nn>-<tool>.json` và trả
> `savedTo`, vì ở TOKXKPBV chuẩn xuất CSV của CR-01 chỉ nằm trong brief, reviewer và người chấm không đối chiếu được).
> `decide` (Jev, mới: `pack/src/decide/jev.mjs`, `decisions.mjs`). **Chưa dựng:** `condense_log` (chữ ký lỗi và rút log đã có
> bên trong gate, `pack/src/gate/logs.mjs`). Code: `pack/src/tools.mjs`.
>
> **27/10 (ý tưởng từ harness mẫu, mục 1–3):** hard gate (integrate và `commit_and_push` chỉ nhận đúng nội dung gate
> đã kiểm, §5.9, §5.12), gate kiểm `testResults` theo template/MVS/status (§5.10), `record_verification` đếm từ
> `submit.json` (§5.11), gate trả `signature` + `repeat`, lần 3 thì `next_action` thôi đề xuất retry.
> **Cùng ngày, mục 5–7, 9, 10:** check `test-quality` (`weak_test`), kết quả test máy đọc theo id, chạy lại test
> flaky, `tests-kept`, `fail-before` trên worktree probe (§5.10).
> **Mục 13:** `capture_evidence` có bước `route` / `unroute` (CDP `Fetch`, từ 03/11 `context.route` của Playwright): trình duyệt tự trả lời request khớp `url`
> (chuỗi con hoặc mẫu `*`, lọc `method`) bằng `status` + `body`, `abort` (`TimedOut`, `Failed`, `InternetDisconnected`…)
> hoặc làm chậm `delayMs` rồi cho đi tiếp; `times` giới hạn số lần, luật mới nhất thắng. Dùng cho MVS kiểu "khi API lỗi
> / quá hạn thì hiện…" mà không phải sửa code (hard gate sẽ chặn) hay tắt server/database dùng chung. Kết quả có
> `routed` và `note` nhắc ghi vào answer rằng lỗi được giả lập. Test: `browser.test.mjs` (500, TimedOut, mạng chậm).
> **29/10 (Practice 9KNXREJ5, L60):** bước `login {url, matchRoot}` đăng nhập bằng tài khoản mà seed của app tạo
> (`pack/src/env/applogin.mjs`: biến `process.env.X ?? "mặc định"` trong file seed, giá trị trong `.env` nếu có, không thì
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
| 5.10 | ~~`run_gate`~~ | | | Đã bỏ 03/11 |
| 5.11 | ~~`record_verification`~~ | | | Đã bỏ 03/11; `publish_item` tự ghi `BACKLOG_TESTS` |
| 5.12 | `commit_and_push` | R | GAME | Kiểm answer + path, commit, push, xác minh SHA |
| 5.13 | `submit_work` | R | GAME | Nộp idempotent, ghi biên nhận |
| 5.14 | `report_progress` | R | mọi | Event do root quyết định (blocker, BLOCKED/FAILED, RESTARTED, ENDED) |
| 5.15 | `wait_for_update` | R | mọi | Chặn ≤ 55 s tới khi có thay đổi |
| 5.16 | `job_status` | R | mọi | Kết quả job |
| 5.17 | `detect_profile` | A | mọi | Nhận diện stack và lệnh build/test cho một path |
| 5.20 | `app_data` | A | mọi | Khoá database dùng chung của app khi seed / tạo dữ liệu kịch bản (mục 8) |
| 5.21 | (codegraph) | A | mọi | Không phải tool của helper: MCP server thứ hai, helper chỉ dựng index |
| 5.22 | (proxy) | subagent | GAME | Không phải tool mới: helper của subagent chuyển `read_item`, `job_status`, `worktree status`, `worker_checkpoint` sang helper của root |
| 5.18 | ~~`condense_log`~~ | | | Chưa từng dựng; bỏ cùng gate 03/11 |
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
và `suggestedOrder` theo luật xếp lịch ([07 §4](07-quy-trinh-tran.md#1-tổng-quan-thời-gian)), cùng `lanes` đang bận.
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
  `triage.models` = `{fixer: [lần 1, lần 2, …], evidence}`, mỗi phần tử
  `{model, reasoning_effort, tier}` hoặc `null` ([06 §9](06-agents-va-skills.md#9-chọn-model)).
- PI: trước triage, `git fetch` nhánh được giao (helper vốn chỉ fetch khi push bị từ chối) rồi trả `remote` =
  `{fetched, newCommits: [{sha, author, date, subject, files}], merged, recentChanges, note?}`. Có commit mới, main không
  có commit chưa push và không có thay đổi chưa commit thì `merge --ff-only` để worktree của PI có commit đó; không thì
  `note` nói lý do (fixer đọc bằng `git show`). Root đưa `remote` vào brief làm `<recent_changes>` ("cái gì vừa thay đổi"
  là nghi phạm số một, SRE / PagerDuty).
- **Test fail ở baseline** (Practice #6 HIET12OA: một test cũ trái ý định của app, `cascade.test.ts`, làm CR-01, TASK-02,
  BUG-02 mất 80 điểm "existing tests"): `baselineFailures` = `{failing, owner, youFix}` hoặc `null`. `failing` là
  test fail ở baseline. Chỉ **một** item chủ (`baselineOwner` trong journal) được giao xử lý:
  item đầu tiên có `start.json`/`page.json` đòi chạy cả bộ test (`pnpm test`, "existing tests", `mvn test`…); hai fixer
  cùng sửa một test thì item integrate sau bị `WORKTREE_CONFLICT`. Chủ đã nộp, bỏ hoặc integrate mà test vẫn fail thì
  item kế tiếp có MVS như vậy nhận việc. Root đưa nguyên khối vào brief (`<baseline_failures>`).
- `requiredEvidence` = `[{file, beforeFix}]` (bỏ khi rỗng): evidence mà mô tả item đòi ngoài MVS (`itemEvidence`).
  `beforeFix` = câu chứa "before" (vd "before fixing"): fixer chụp trước khi sửa code. Root đưa vào brief
  (`<required_evidence>`).
- `requirements` = `[{id, text}]` (bỏ khi rỗng), cũng ghi ra `.team-work/items/<ID>/requirements.json`: yêu cầu của **cả
  đề**, vì BTC chấm theo cả đề chứ không chỉ MVS (HIET12OA: "pnpm test passes" chỉ ở Acceptance criteria, gate và
  reviewer cho qua 3 item hỏng; ZVUYZ41V: ảnh "before fixing" chỉ ở mục Submission). `itemRequirements` trong `answers.mjs`,
  thuần code: mục Acceptance criteria → `AC-n` (mỗi dòng danh sách), Expected outcome / Requirements / Canonical scope /
  Normalization / Answer format → `RQ-n` (danh sách thì mỗi dòng, đoạn văn thì mỗi câu), Submission / Evidence →
  `EV-n` (bỏ câu khuôn mẫu `answerCheck` đã kiểm: chép template, `gitRevision`, `testResults`, schema). Bỏ bảng, khối code, câu
  điểm và hạn; tối đa 24. Root đưa đường dẫn vào brief fixer (`<requirements>`); fixer khai từng id trong
  `requirements` của fix-result (`met`/`not_met`/`not_applicable` + bằng chứng). `publish_item` đối chiếu bảng này và
  chỉ báo lại chỗ thiếu.

### 5.9 `worktree`

- `create {backlogItemKey}`: `git worktree add -b team/<ID> <checkoutRoot>/.team-work/wt/<ID> <HEAD chính>`;
  chép template thành `<wt>/<folder>/answers/<ID>/submit.json` (nếu chưa có), tạo `evidence/`. Nếu stack
  cần cài lại dependency cho worktree (vd `node_modules`), bắt đầu job cài; từ 02/11 job cài chạy cùng lúc với index
  codegraph của worktree (như `setup_environment` của checkout chính), index vẫn xong trước khi trả về. Xoá bản ghi
  build cũ của thư mục app (§5.23). **Output**: `{worktreeRoot, matchRoot, baseRevision, setupJobId?}`.
- `integrate {backlogItemKey}`: trong worktree `git add -- <folder>` + commit cục bộ; ở checkout chính
  `git cherry-pick <sha>`. Xung đột thì `--abort` và trả danh sách file xung đột. **Output**:
  `{integrated, headRevision, baseChanged, hint}`. Không còn hard gate (bỏ 03/11): `publish_item` vẫn kiểm main chứa
  đúng nội dung đã bàn giao ở các file của item (`CANDIDATE_STALE`).
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
  luôn mới theo trận (Practice #5, L34). Stack có lệnh `migrate` (Prisma) thì `DATABASE_URL` cũng có hậu tố
  `_<matchid>_<item>`: job setup chạy `migrate` (tạo database nếu chưa có) và, khi `.env` vừa tạo, `seed`; database dev
  của checkout chính giữ nguyên. Output job có `database {name, dedicated}`. Sync chạy lại job thì chỉ migrate, không
  seed lại.
- Push xong (`commit_and_push`, cả bước push của `publish_item`): helper dừng app của item và chạy job nền
  `drop_databases` xoá database dev riêng và test DB của worktree (`DROP DATABASE IF EXISTS ... WITH (FORCE)` qua Prisma
  CLI của checkout chính, trên database quản trị `postgres`); không chặn submit, một lần mỗi item (`databasesDropped`
  trong journal), log ở `logs/<ID>-drop-databases.log`. Chỉ xoá tên khác database của checkout chính. Output push có
  `databaseCleanupJobId`. Worktree dùng lại sau đó: `migrate` tạo lại database và `seed` chạy vì migrate báo vừa tạo.

### 5.10 `run_gate` (đã bỏ 03/11)

Gate (diff, thay đổi cấm, chất lượng test, quét code, typecheck/build, test khai báo, regression so baseline,
fail-before, kiểm answer), pre-gate và gate main đã bỏ cùng verified mode. Fixer tự chạy typecheck, build và cả bộ
test một lần trước `ready_for_evidence`; test mới của BUG/PI phải fail trên code chưa sửa (`team-fixer.toml`).
Phần kiểm answer còn lại ở `pack/src/match/answers.mjs` (`answerCheck`, `itemEvidence`, `itemRequirements`,
`requirementsCheck`, `scenarioCounts`).

### 5.11 `record_verification` (đã bỏ 03/11)

`publish_item` ghi `BACKLOG_TESTS` ở bước `verification`: đếm `testResults` của `submit.json` (không có thì
`requirements` của fix-result; item answer-only thì kết quả `answerCheck`). Kịch bản bắt buộc chưa ghi tính là chưa
chạy, không bao giờ là đạt. Root **không** tự ghi `BACKLOG_TESTS` bằng `report_progress`.

### 5.12 `commit_and_push`

1. Kiểm trên checkout chính: mọi file thay đổi nằm dưới `<folder>/`; không có `<folder>/evidence/`,
   `<folder>/challenge/evidence/`; không file > 5 MB; không có file trông như secret (`.env`, `*.pem`, token).
   `answers/<ID>/submit.json` được kiểm như §5.10 nhưng lỗi chỉ thành `answerWarnings`, không chặn.
2. `git add -- <folder>` → `git commit -m "<ID>: <tóm tắt>"`.
3. `git push origin HEAD:refs/heads/<branch>` (không `--force`, env §8). Bị từ chối non-fast-forward thì
   `git fetch origin <branch>` + `git rebase origin/<branch>` (cục bộ) + push lại, tối đa 2 lần; rebase xung đột thì
   `PUSH_REJECTED`.
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
Có PI đã hiện mà chưa Start Work (còn ≥ 3 phút) thì `job_status` và lượt chờ của `publish_item` trả về ngay, hoặc ngay khi
PI hiện giữa lượt chờ, kèm `newPI` và `hint`: root giao PI trước rồi chờ job tiếp (HIET12OA: đề hiện → `start_work`
mất 56 s đến 1 phút 52 vì root đang chờ).

Item thường không làm lượt chờ trả sớm (vòng chờ trong `exec` sẽ quay liên tục). Thay vào đó mọi kết quả tool của
root (trừ `match_state`, `wait_for_update`, `login_match`, `refresh_match`, và không gắn cho lời gọi qua proxy) có
`notice` = `{newItems, freeSlots, hint}` khi có item không phải PI đã ra mà chưa Start Work (còn ≥ 4 phút) trong lúc
số item giữ slot dưới `maxItemsInFlight` (`config/runtime.json`, 5 từ 02/11; `team-sdlc-pack/local/runtime.json` ghi đè,
đọc lại mỗi lần nên đổi file là có tác dụng ngay; giá trị ngoài 1–8 thành 4). `newItems` theo `suggestedOrder`. (ZVUYZ41V: TASK-01 ra lúc
02:49:49, root chỉ bắt đầu lúc 03:02 vì lặp `wait_agent`/`spawn_agent` mà không gọi `wait_for_update`.)

Giữ slot (`holdsSlot`, dùng chung cho `notice` và `next_actions`): item code (không PI, không answer_only) đã Start
Work, chưa kết thúc, và còn cần worker: chưa bàn giao candidate (đang chuẩn bị, đang ghi, dừng chờ sync trước evidence,
worker mất sau restart), worker đang ghi lại, hoặc candidate `stale`. Item đã bàn giao chỉ chờ worker evidence,
publish hay item khác thì nhả slot (NBDB5U0O: CR-03 ra 17:02 khi CR-01, CR-02, BUG-04 chỉ chờ BUG-01, không được bắt
đầu tới hết trận).

Publish khi main đã đổi: item và main (tính từ base của item) sửa file khác nhau thì integrate luôn, evidence giữ
nguyên; sau integrate main phải trùng candidate ở mọi file của item (không thì
`CANDIDATE_STALE`). Chỉ khi cùng sửa một file mới báo `SYNC_REQUIRED` kèm tên file (NBDB5U0O: CR-01, CR-02, BUG-04
chụp lại toàn bộ sau khi BUG-01 lên main, mỗi item ~15 phút).

Cuối giờ (`next_actions`): còn ≤ 6 phút (`LAST_CALL_MINUTES`, theo hạn item hoặc hết trận) thì việc của item lên đầu,
item ít phút nhất trước, gắn `lastCall`: worker đang ghi → `stop_worker`; có candidate → `publish_item`, kèm `lastChance.reason` khi đó
mới là bàn giao chỉ có code (evidence chưa chụp). `waitMs` thức root đúng lúc item bước vào 6 phút cuối. (NBDB5U0O: BUG-04 có candidate PARTIAL lúc
17:16 nhưng không được nộp, item đóng 17:22.)

### 5.17 `detect_profile` (A)

Port `orchestrator/profile.py`: `{path}` → `{stacks: [{id, root, build, test_all, test_one, run_app, forbidden_skip}]}`.
Không trạng thái, không mạng.

### 5.18 `condense_log` (bỏ 03/11)

Chưa từng mở thành tool; phần port `pack/src/gate/logs.mjs` bỏ cùng gate.

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
  tools.mjs                     # danh mục tool (schema + handler), gọi xuống các thư mục dưới
  core/                         # nền tảng của helper
    mcp.mjs                     # framing JSON-RPC, tools/list, tools/call, giới hạn
    session.mjs                 # configure_session, parse frame + policy, secret store
    paths.mjs                   # TeamWorkspace tin cậy, kiểm path, chặn symlink/junction
    util.mjs redact.mjs         # hàm chung; che secret trong mọi chuỗi trả ra
    journal.mjs events.mjs      # journal bền (ghi atomically); hàng đợi sự kiện cho wait_for_update
    jobs.mjs                    # lệnh con và job nền (spawn, timeout, kill cây tiến trình con)
    http.mjs git.mjs            # fetch có allowlist; wrapper git an toàn (worktree, commit, push)
    jsonschema.mjs              # kiểm submit.schema.json
    proxy.mjs                   # named pipe từ helper của subagent tới helper root (§5.22)
  match/                        # trận đấu
    game.mjs                    # Game Master: đăng nhập, đọc trận, Start Work, Submit
    company.mjs                 # proxy Company Tools
    progress.mjs                # validator (bản sao luật Player) + writer + ngân sách byte
    workflow.mjs                # prepare_item, worker_checkpoint, publish_item, next_actions
    answers.mjs                 # kiểm submit.json, evidence bắt buộc, yêu cầu của đề (chỉ cảnh báo)
  env/                          # môi trường và app
    environment.mjs             # nhận diện stack, chuẩn bị môi trường (§5.3)
    app.mjs applogin.mjs        # chạy app của worktree; tài khoản seed cho bước login
    datalock.mjs                # khoá dữ liệu app (§5.20)
    browser.mjs                 # capture_evidence qua Playwright (playwright-core, §5.25)
    codegraph.mjs               # dựng index codegraph cho checkout chính và worktree (§5.21)
    testreport.mjs              # chạy test baseline với reporter JSON/JUnit, id từng test
  decide/                       # ra quyết định
    decisions.mjs jev.mjs       # điểm quyết định: Jev trước, luật code dự phòng (D9)
    signals.mjs                 # đặc trưng item cho triage: grep, topology codegraph, KB
    models.mjs                  # model cho từng lần spawn (06 §9)
pack/config/                    # jev.json, models.json, codegraph.json, codex.toml
pack/contracts/*.schema.json    # progress-event (của BTC), worker-result, checker-result, agent-result
```

## 12. Mã lỗi ổn định

`NOT_CONFIGURED`, `INVALID_FRAME`, `NEEDS_PREPARATION_FRAME`, `SESSION_MISMATCH`, `PATH_OUTSIDE_WORKSPACE`,
`API_KEY_INTEGRITY_MISMATCH`, `ORIGIN_NOT_ALLOWED`, `MATCH_IDENTITY_MISMATCH`, `MATCH_UUID_NOT_FOUND`,
`LOGIN_FAILED`, `GIT_AUTH_FAILED`, `CHECKOUT_MISMATCH`, `ITEM_NOT_OPEN`, `TOO_LATE`, `WORKTREE_CONFLICT`,
`ANSWER_INVALID`, `CANDIDATE_STALE`, `SYNC_REQUIRED`, `PATH_NOT_ALLOWED`, `PUSH_REJECTED`, `REVISION_NOT_ON_REMOTE`,
`SUBMIT_REJECTED`, `ALREADY_SUBMITTED_NO_RECEIPT`, `EVENT_INVALID`, `LOG_BUDGET_EXCEEDED`,
`ENVIRONMENT_READY_CONFLICT`, `JOB_TIMEOUT`.

### 5.20 `app_data` (A, mới, mục 8)

- Seed của BTC xoá rồi tạo lại dữ liệu (seed CR-01 "deletes every invoice"): hai item cùng seed hay tạo dữ liệu qua
  app trên một database thì làm hỏng evidence của nhau. Worktree item có database dev riêng (§5.9) thì `lock`/`unlock`
  trả ngay `{locked|unlocked: true, dedicated: true, database}` và không đụng file khoá; khoá chỉ còn cho database dùng
  chung (checkout chính, worktree tạo trước bản này, stack không có `migrate`).
- `{action: "lock"|"unlock"|"status", backlogItemKey, matchRoot?, minutes? (1–30, mặc định 15), waitSeconds? (≤ 50)}`.
  Helper của subagent không có session nên nhận ra database riêng từ `matchRoot` (worktree) hoặc từ app đang chạy của
  item (4D895OVI: thiếu cái này, CR-02 chờ khoá chung 4 phút dù có database riêng). Khoá là file
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
- **Index** (`pack/src/env/codegraph.mjs`): server không tự index, và gọi lên thư mục chưa index thì nó bảo agent thôi
  dùng codegraph cả phiên. Nên helper chạy `init -y` (lần sau `sync`) cho `matchRoot` song song với
  `setup_environment`, và cho `wt.matchRoot` ngay trong `worktree create` trước khi trả về (kết quả có
  `codegraph: indexed|failed|not installed`). Lỗi không bao giờ làm hỏng bước gọi nó. Index nằm ở `.codegraph/` trong
  thư mục trận; `prepare_checkout` thêm `.codegraph/` vào `.git/info/exclude` (dùng chung cho mọi worktree) nên không
  lọt vào diff, gate hay commit. Sau đó watcher của server tự `sync` khi agent sửa file (debounce 2 s).
- **Helper đọc index cho triage** (30/10, `pack/src/decide/signals.mjs` `codeTopology`): lúc `start_work`, helper mở
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
  việc chạy regression và kiểm kết quả cho Tester, còn integrate và quyết định cuối cho Orchestrator. Tiến trình
  helper của subagent chưa `configure_session` (§2), và credential không được vào prompt của worker (guide §4), nên
  subagent cần đường gọi sang helper của root. Từ 03/11 chỉ còn fixer dùng proxy (đọc item, checkpoint, chờ job).
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
  - `worker_checkpoint`: như root.
  - `job_status`: không trả sớm vì `newPI`, vì bắt PI là việc của root.
  - `worktree`: chỉ `status`.
  - Mọi tool khác: `PROXY_DENIED`. Không bao giờ có Game Master, `integrate`, `commit_and_push`, `submit_work` hay
    `report_progress`.
- Lời gọi qua proxy không lấy `networkActivity` của root: request HTTP của poller vẫn báo trong kết quả tool kế tiếp
  của chính root. Journal và progress log vẫn chỉ có một writer.
- Test: `tests/pack/e2e.test.mjs` (tiến trình helper thứ hai: các lời gọi bị chặn, đọc item, worktree status, job
  của root qua proxy).

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
- Kết quả: `ready {url, port, pid, mode, log, reusedBuild?}`; `starting` (chưa xong trong `waitSeconds`: gọi
  `status`); `failed {tail}` (tiến trình thoát, file trạng thái bị xoá).
- Dùng lại bản build (02/11, sau NBDB5U0O: BUG-02 dừng app rồi start lại đúng source, build lần hai ~35 s): `start`
  production so snapshot source/môi trường hiện tại với bản ghi build của thư mục app (§5.10). Trùng, và dấu
  `.next/BUILD_ID` không đổi (không ai build tay hay chạy dev đè lên), thì chỉ start; kết quả có `reusedBuild {by, at}`.
  Build mới hay `mode: "dev"` xoá bản ghi trước khi chạy; build xong, app trả lời mà source không đổi từ lúc start thì
  ghi bản ghi (`by: "app"`). Bản dùng lại không start được thì xoá bản ghi và trả `failed` với hint start lại để build
  mới. Lần thử lại vì `EADDRINUSE` giữ snapshot và bản build của lần đầu. `worktree create` xoá bản ghi của worktree mới.
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
  build lại, build fail trả `tail`, đường dẫn ngoài `matches/` bị chặn, lệnh cho Next/dev/java; worktree là repo git:
  start lại trên source không đổi thì dùng lại bản build, đổi source, chạy dev, build tay hay bản dùng lại hỏng thì
  build lại). Gate dùng lại bản build: `gate-runs.test.mjs`, `workflow.test.mjs`.

### 5.24 `capture_evidence`: bước hỏng (02/11, sau NBDB5U0O)

- Bước thao tác (click, fill, select, press, drag, waitFor, assertText, screenshot, download) đứng trước mọi `goto`/`login`
  bị từ chối ngay (`INVALID_ARGUMENT`), không mở trình duyệt: mỗi lần gọi mở một trang trắng (BUG-02 click "New
  invoice" trên `about:blank`, chờ hết giờ mới báo `ELEMENT_NOT_FOUND`).
- Bước hỏng: `candidates` xếp phần tử gần bước đó lên đầu (chữ trùng, khớp selector của bước, nằm trong
  dialog/listbox/main), link điều hướng xuống cuối, tối đa 40 (trước đây 50 phần tử đầu DOM, toàn link sidebar).
  `error.details.hint`: trang trắng → mở đầu bằng `goto`; `[role=option]` mà chưa có option nào mở → click combobox trước;
  có đúng chữ của bước dưới selector khác → dùng selector đó.

### 5.25 `capture_evidence` chạy trên Playwright (03/11, sau 3OCNFC54)

- Engine tự viết trên CDP (lớp `Cdp`, tìm phần tử, click/gõ phím, download, `Fetch`) được thay bằng `playwright-core`
  (ghim ở `config/playwright.json`), vì phải vá sau mỗi trận: 31/167 lần chụp lỗi qua 6 trận (PXWV53VC → 3OCNFC54).
  Interface `steps`, kiểm tra trước khi mở trình duyệt, URL loopback, đường dẫn `answers/<ID>/evidence/`, provenance,
  `EVIDENCE_STALE_APP`, login bằng tài khoản seed, `route`, `drag`, chờ trang yên trước khi chụp, ảnh dự phòng khi
  bước lỗi và `error.details` (`candidates`, `hint`, `preGateFailed`) giữ nguyên.
- Không tải trình duyệt: `executablePath` là Edge/Chrome đã cài (`findBrowser`). Installer cài `playwright-core` vào
  `team-sdlc-pack/playwright/` (cạnh `runtime/`, như codegraph) trước khi thay `runtime/`; cài lỗi thì dừng
  (`PLAYWRIGHT_NOT_INSTALLED`), không có bản dự phòng CDP. `--no-playwright` chỉ dùng cho test của pack.
  `check-distribution` mở thử trình duyệt (mục `playwright`) để phát hiện trước trận khi Edge tự cập nhật lên bản mà
  phiên bản đã ghim chưa điều khiển được.
- `launchServer` + `kill` thay cho `launch` + `close`: Edge đóng êm mất khoảng 2 s mỗi lần gọi, kill khoảng 0,4 s.
  `browserProfile` là một file `storageState` (`local/browser/<profile>.json`, cookie và localStorage) thay cho thư mục
  profile của Edge: các lần gọi song song cùng profile không khoá nhau (CR-01 của 3OCNFC54 chụp bốn kịch bản song song),
  hết lỗi profile bị Edge mồ côi giữ (`BROWSER_START_FAILED`, 4D895OVI).
- Selector: CSS hoặc cú pháp Playwright (`text=`, `:has-text()`, `role=`, `>> nth=`), bỏ chặn `INVALID_SELECTOR` của
  Practice #5; sai cú pháp vẫn báo ngay. `{selector, text}` lọc theo chữ hiển thị hoặc `aria-label`, khớp đúng trước,
  chứa chữ sau. Bước cần đích mà không có selector lẫn text bị từ chối trước khi mở trình duyệt.
- Click: Playwright chờ phần tử hiện, ổn định, bật và nhận được sự kiện. Bị che (lần thử đầu tối đa 1,5 s báo
  `intercepts pointer events`) thì bấm xuyên lớp che bằng chuột thật như trước (lớp che tạm `pointer-events:none`) và
  bước ghi `obscuredBy`; từ 428c517 (02/11) việc này không cần `force`. Phần tử hiện mà không bấm được báo
  `ELEMENT_NOT_ACTIONABLE` kèm lý do (`element is not enabled`). `goto` tới cổng không có app báo `NAVIGATION_FAILED`
  ngay thay vì để bước sau chờ hết giờ. Lỗi khác của Playwright tới agent là `BROWSER_STEP_FAILED`/`STEP_TIMEOUT`
  kèm `error.details` như mọi bước hỏng.
- Test: `tests/pack/browser.test.mjs` (16 test, dùng `playwright-core` ở `<repo>/playwright`, `support.mjs` tự cài lần
  đầu và trỏ helper đã cài tới đó qua `MTM_PLAYWRIGHT_DIR`).

### 5.19 `decide` (R, mới, D9)

- **Input**: `{point: "triage"|"route"|"root_cause_confirmed", backlogItemKey, context?}`.
  Helper tự lấy dữ liệu cần thiết (đề, kết quả worker, số lần thử) rồi dựng câu hỏi
  (`noul` / `choice` / `score`) như `orchestrator/decisions.py`. `start_work` đã chạy triage + route trong một
  request (`Decider.intake`), root không gọi lại.
- **Hành vi**: gọi Jev (`src/decide/jev.mjs`, `fetch`, timeout 5 s, không thử lại; 2 lần hỏi lỗi liên tiếp thì nghỉ 5 phút,
  trong lúc nghỉ dùng luật code ngay). Lỗi hoặc dưới ngưỡng (`config/jev.json`) thì dùng luật code.
- **Luật cứng là sàn hoặc điều kiện AND**, Jev không ghi đè được ([08 §8](08-guardrails.md#8-jev-typesafe)): PI luôn
  `critical`; PI, CR và item `hard` luôn `strong`; `root_cause_confirmed` cần `root_cause`, `confidence` ≥ 0.7, một verification
  pass và, khi fix-result có `hypotheses`, ít nhất một cái `confirmed`; Jev chỉ phủ quyết;
  regex injection chạy trên toàn bộ đề và thắng câu "không" của Jev.
- Jev nhận đề cắt đầu + cuối (mô tả 1.400 + 600 ký tự, hướng dẫn Start Work 600 + 400), để câu lệnh cài ở cuối đề
  vẫn tới được Jev.
- **Output**: `{point, backlogItemKey, jev: status, decisions}`; mỗi quyết định có `value`, `source: "jev"|"rule"`,
  `confidence`, `rule` (câu trả lời của luật code, luôn tính), `jev` (câu trả lời thô của Jev, kể cả khi dưới ngưỡng),
  `reason`. Ghi vào `.team-work/decisions.ndjson` để đo tỉ lệ bất đồng và chỉnh ngưỡng sau trận.
- `enabled = false` hoặc thiếu key → luôn `source: "rule"`.
- `claims_supported` đã bỏ (27/10, L17); `next_action` (submit/retry/drop theo kết quả gate) bỏ 03/11 cùng gate.
- Tool này làm `suggestedOrder` và `match_state` tốt hơn (độ khó, mức độ) nhưng root vẫn quyết định cuối.
