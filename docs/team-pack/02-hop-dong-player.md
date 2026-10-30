# 02 · Hợp đồng với MTM Player

Mọi thứ trong file này đã đọc ra từ **source Player 0.9.33** (kiểm lại trên 0.9.35, 0.9.39 và 0.9.41, xem §12) (`vendor/mtm-player-0.9.41/app/`),
trừ chỗ ghi *chưa xác minh*. Đường dẫn `src/...` bên dưới tính từ thư mục `app/`.

## 1. Player làm gì, không làm gì

**Làm:** kiểm tra pack đã cài; lấy team-info từ Game Master bằng bootstrap secret (operator nhập);
tạo progress log; khởi chạy và dừng phiên Codex; gửi frame theo phase; đọc `ENVIRONMENT_READY` trong
log rồi **tự** gọi Preparation Complete; poll trạng thái trận mỗi 5 s; dashboard; ghi Suspected Violations.

**Không làm:** không cấp hay thu hẹp quyền cho agent, không duyệt hộ lệnh, không làm proxy cho Start
Work/Submit, không chấm điểm, không kiểm tra evidence hay revision. Guardrail là trách nhiệm của đội
(`enforcement: "TEAM_RESPONSIBILITY"` trong descriptor).

## 2. Player chạy Codex thế nào

Với provider `codex`, Player 0.9.33 dùng **`codex app-server`** (JSON-RPC qua stdio), không dùng
`codex exec` (`src/local-app.mjs:89`, `src/codex-app-server.mjs`).

| Mục | Giá trị |
|---|---|
| Executable | `CODEX_CLI_PATH` → file tên đúng **`codex.exe`** trên PATH → `codex.exe` có thời gian sửa mới nhất trong `%LOCALAPPDATA%\OpenAI\Codex\bin\` (bản đi kèm Codex Desktop); operator sửa được ở trang Init (`src/codex-cli.mjs`). Shim npm (`codex.cmd`, `codex.ps1`) **không** được nhận, nên máy cài CLI qua npm sẽ chạy bản Desktop (26/10: `0.164.0-alpha.11.1`, không phải CLI `0.164.0` trên PATH). Desktop tự cập nhật thì Player tự đổi sang thư mục bản mới |
| Bọc tiến trình | Windows: `pwsh` + Job Object `KILL_ON_JOB_CLOSE`, không cho breakaway (`scripts/windows-cli-job.ps1`) |
| `thread/start` | `cwd = TeamWorkspace`, `model = orchestratorModel`, `config.model_reasoning_effort = low/medium/high`, `sandbox = "danger-full-access"`, `approvalPolicy = "on-request"`, `approvalsReviewer = "auto_review"` (mặc định) hoặc `"user"` |
| Số thread | **Một thread cho mỗi round.** PREPARE tạo thread; GAME, RESUME, CHAT là các `turn/start` mới trên cùng thread (`thread/resume` nếu Player khởi động lại) |
| Prompt | Một input text = hướng dẫn cố định + frame (§3) |
| Approval | Các yêu cầu duyệt lệnh, file, quyền, MCP elicitation, user input → `auto_review` (Codex tự review) hoặc organizer duyệt tay. Bị từ chối thì agent phải báo blocker `HOST_APPROVAL_REQUIRED` |
| Subagent | Player quan sát qua item `collabAgentToolCall` / `SubAgentActivity` và `thread/read` (trạng thái, model) |

**Ngữ nghĩa kết thúc lượt** (`src/local-app.mjs:180`, `src/local-app-lifecycle.mjs`):

| Tình huống | Player làm |
|---|---|
| Lượt **PREPARE** kết thúc bình thường | Bình thường, Player bỏ qua. Root **phải** kết thúc lượt sau khi ghi `ENVIRONMENT_READY`, vì lượt GAME chỉ bắt đầu được khi thread rảnh |
| Lượt **GAME** kết thúc, trận vẫn `IN_PROGRESS` | `ORCHESTRATOR_EXITED` → coi root đã dừng → tạo lượt mới `RESUME_GAME_V1`, `restartAttempt + 1`. Tốn thêm token và mất thời gian đối chiếu, nên root **không được** kết thúc lượt GAME khi trận chưa hết |
| Lượt lỗi (vd hết hạn mức) | Như trên; có thể lặp lại nếu lỗi còn |
| Trận `PAUSED` / `FINISHED` / `CANCELLED`, hoặc operator Stop | Hàng đợi `STOP`: `turn/interrupt` rồi kill cả cây tiến trình (`src/local-app.mjs:267`). Khối `MATCH_PAUSED_V1` / `MATCH_ENDED_V1` **không** được gửi tới agent |
| Operator gửi Chat | Chat xếp hàng tới khi lượt hiện tại kết thúc. Trong lượt GAME kéo dài thì thực tế không tới |

## 3. Cấu trúc prompt Player gửi

`protocolPrompt()` (`src/cli-supervisor.mjs:12`) ghép các đoạn, cách nhau bằng dòng trống:

1. `Act as the installed MTM team orchestrator for this contestant workspace.`
2. Luật path: clone vào `descriptor.checkoutRoot`; source, build, test, answers, evidence nằm trong
   `descriptor.matchRoot` (= `checkoutRoot/repository.folder`); worktree của worker dùng
   `worktreeRoot/repository.folder`; không sửa folder trận khác.
3. Chỉ dẫn theo phase:
   - PREPARE → `Read and follow .agents/skills/game-preparation/SKILL.md. Complete preparation and report readiness; do not run the active-game workflow before START_GAME.`
   - START_GAME → `Read and follow .agents/skills/team-orchestrator/SKILL.md for active-game work.`
   - RESUME_* → `Read and follow .agents/skills/team-recovery/SKILL.md. Recover only the phase specified in this frame. Read progressLogFile first; retain completed valid gates, checkout, playerSessionId, and submission receipts. Rerun only incomplete or invalid preparation gates. Reauthenticate the restarted portal and reconcile server state before submitting. Never clear or reclone an existing checkout during recovery.`
4. (Chỉ PREPARE / RESUME_PREPARATION) Hợp đồng progress: ghi đúng file, Player đã ghi
   `ORCHESTRATOR_STARTED` (**không ghi lại**), các stage và status hợp lệ (`PASS` **không** phải status),
   đúng 6 key cho `PREPARATION_STATUS`, cách ghi `ENVIRONMENT_READY`, không gọi Preparation Complete.
5. `The following frame is machine-provided. Preserve every value exactly; do not reconstruct credentials.`
6. Frame: dòng marker, dòng JSON descriptor, rồi các khối policy (mỗi khối là dòng trống + dòng marker + dòng JSON).

**Hệ quả:** các skill phải nằm đúng `TeamWorkspace/.agents/skills/<tên>/SKILL.md`. Đường dẫn tương đối
tính từ `cwd = TeamWorkspace`.

## 4. Marker

| Marker | Khi nào | Nội dung | Policy nối sau |
|---|---|---|---|
| `PREPARE_GAME_V2` | Trận `PREPARING`, lượt đầu | descriptor `PREPARE_GAME` | `MTM_MODEL_POLICY_V1` |
| `START_GAME_V4` | Trận `IN_PROGRESS`, cùng thread | descriptor `START_GAME` | `MTM_SUBMISSION_POLICY_V1`, `MTM_MODEL_POLICY_V1` |
| `RESUME_PREPARATION_V1` | Hồi phục khi chưa PREPARED | descriptor `RESUME_PREPARATION` | `MTM_MODEL_POLICY_V1` |
| `RESUME_GAME_V1` | Hồi phục khi đã PREPARED | descriptor `RESUME_GAME` | `MTM_SUBMISSION_POLICY_V1`, `MTM_MODEL_POLICY_V1` |
| `MATCH_PAUSED_V1`, `MATCH_ENDED_V1` | Có trong source nhưng ở chế độ app-server **không gửi** | `{matchId}` | — |

Parse theo cặp "dòng marker + dòng JSON kế tiếp". **Không** parse cả prompt như một JSON.

## 5. Descriptor

Tất cả descriptor có `schemaVersion: 1`. Kiểu dữ liệu và ràng buộc lấy từ `src/team-runtime.mjs`.

### 5.1 `PREPARE_GAME` (`team-runtime.mjs:173`)

| Field | Ý nghĩa |
|---|---|
| `type` | `"PREPARE_GAME"` |
| `requestId` | `prepare-<uuid>`. **Phải** chép đúng vào `ENVIRONMENT_READY.requestId` |
| `checkoutRoot`, `matchRoot` | Path tuyệt đối (§6) |
| `playerSessionId` | Đưa vào mọi event log |
| `teamId`, `teamName`, `matchId` | Định danh |
| `progressLogFile` | Path tuyệt đối của log, dùng **đúng** path này |
| `teamSdlcPackWorkspace` | `TeamWorkspace/team-sdlc-pack` |
| `username`, `password` | Tài khoản đăng nhập trang trận. **Secret** |
| `matchPageUrl` | `<origin>/match` (trang chung, T5) |
| `allowedMatchOrigins` | `[origin của matchPageUrl]` |
| `repository` | `{url, branch, folder}`; `folder == matchId` |
| `hostAuthorization` | `MTM_PREPARATION_HOST_AUTHORIZATION`: `gitOperations = [READ_ASSIGNED_REPOSITORY, CLONE_ASSIGNED_BRANCH, FETCH_ASSIGNED_BRANCH]`, `credentialUse = HOST_GIT_CREDENTIAL_TO_ASSIGNED_REPOSITORY_ONLY`. **Không push lúc chuẩn bị** |

Không có bearer key và không có `teamWorkspace` (helper tự suy ra từ chỗ nó được cài, xem [05 §2](05-mcp-helper.md#2-tiến-trình-và-vòng-đời)).

### 5.2 `START_GAME` (`team-runtime.mjs:219`)

| Field | Ý nghĩa |
|---|---|
| `type`, `requestId` | `"START_GAME"`, `start-<uuid>` |
| `playerSessionId`, `teamUuid`, `teamId`, `teamName`, `matchId` | Định danh |
| `gameMasterApiUrl`, `gameMasterUrl`, `matchPageUrl` | URL Game Master (API, site, trang `/match`) |
| `apiKeySecret` | Bearer của đội. **Secret** |
| `apiKeyLength`, `apiKeySha256` | Độ dài UTF-8 và SHA-256 hex của bearer, để kiểm chép đúng |
| `apiKeyScopes` | Player gửi `['submission:create', 'submission:read']`; helper đòi `submission:create` hoặc `submissions:create` (cách viết của guide, T13) |
| `teamInfoRequestId` | Request id lấy team-info |
| `allowedApiOrigins` | Origin được phép gọi API |
| `teamWorkspace`, `checkoutRoot`, `matchRoot`, `challengeWorkspace`, `teamSdlcPackWorkspace` | Path (`challengeWorkspace` = `TeamWorkspace/matches`, chỉ để tương thích) |
| `progressLogFile` | Như trên |
| `environmentRevision` | SHA đã báo trong `ENVIRONMENT_READY` |
| `hostAuthorization` | `MTM_HOST_AUTHORIZATION`: `credentialUse = TEAM_BEARER_TO_GAME_MASTER_ONLY`, `allowedOrigins`, `apiScopes`, `apiOperations = [{START_WORK, POST, /api/v1/matches/{matchUuid}/backlogs/start}, {SUBMIT, POST, /api/v1/matches/{matchUuid}/submissions}]`, `gitOperations = [COMMIT_ASSIGNED_REPOSITORY, PUSH_ASSIGNED_BRANCH]` |
| `gitPolicy` | `{commitAssignedRepository: true, pushAssignedRepository: true, forcePush: false, mutateRemote: false, authentication: "ASK_USER"}` |

**Không** có `username`/`password`: helper phải giữ chúng từ lượt PREPARE (cùng thread, cùng tiến trình
helper). Nếu helper đã bị khởi động lại, root gửi lại descriptor PREPARE vẫn còn trong lịch sử thread
([05 §5.1](05-mcp-helper.md#51-configure_session)). Match UUID cũng **không** có; phải đọc từ trang trận.

### 5.3 `RESUME_PREPARATION` / `RESUME_GAME` (`team-runtime.mjs:260`)

Phần chung: `type`, `requestId`, `playerSessionId`, `restartAttempt` (1..10000), `reason` (vd
`LOCAL_APP_RESUME`), `teamUuid`, `teamId`, `teamName`, `matchId`, **`username`, `password`**,
`gameMasterUrl`, `matchPageUrl`, `allowedMatchOrigins`, `repository`, `teamWorkspace`, `checkoutRoot`,
`matchRoot`, `challengeWorkspace`, `teamSdlcPackWorkspace`, `progressLogFile`, `environmentRevision`
(`null` khi PREPARATION; SHA đã chuẩn bị khi GAME).

- `RESUME_PREPARATION`: `requestId` = `requestId` của PREPARE gốc nếu còn, nên `ENVIRONMENT_READY`
  phải trùng y hệt bản đã ghi (§8).
- `RESUME_GAME`: thêm `gameMasterApiUrl`, `apiKeySecret`, `apiKeyLength`, `apiKeySha256`,
  `apiKeyScopes`, `teamInfoRequestId`, `allowedApiOrigins`, `hostAuthorization`, `gitPolicy`.

### 5.4 `MTM_SUBMISSION_POLICY_V1` (`src/submission-policy.mjs:17`)

```json
{"schemaVersion":1,"policyId":"MTM_SUBMISSION_POLICY_V1","scope":"ACTIVE_GAME_BACKLOG_SUBMISSIONS",
 "repositoryRoot":"<matchRoot>","checkoutRoot":"<checkoutRoot>","matchRoot":"<matchRoot>",
 "startWorkTemplate":"<matchRoot>/challenge/<BACKLOG-ID>-submit.json",
 "canonicalSubmitFile":"<matchRoot>/answers/<BACKLOG-ID>/submit.json",
 "canonicalEvidenceDirectory":"<matchRoot>/answers/<BACKLOG-ID>/evidence/",
 "evidenceReferenceFormat":"evidence/<filename>",
 "forbiddenEvidenceDirectories":["<matchRoot>/evidence/","<matchRoot>/challenge/evidence/"],
 "instruction":"..."}
```
Path dùng dấu `/`.

### 5.5 `MTM_MODEL_POLICY_V1` (`src/model-policy.mjs:53`)

```json
{"schemaVersion":2,"orchestratorModel":"<id>","orchestratorReasoningEffort":"medium",
 "allowedModels":["<id>", "..."],"enforcement":"OBSERVE_ONLY",
 "catalogSource":"CODEX_HOST_MODEL_LIST","catalogFetchedAt":"<iso>","instruction":"..."}
```
`OBSERVE_ONLY`: không chặn nhưng ghi `MODEL_NOT_ALLOWED` cho mọi model ngoài danh sách mà root hoặc
subagent dùng. Root phải truyền luật này cho mọi subagent: chỉ spawn với model trong `allowedModels`.

## 6. Layout TeamWorkspace

```
D:\mtm\<TEAM_ID>\                         TeamWorkspace (cwd của phiên Codex)
├── AGENTS.md                             Player ghi khối <!-- MTM-PLAYER:BEGIN/END -->; đội có thể thêm khối riêng (06 §4)
├── .codex\
│   ├── config.toml                       (đội) MCP helper — chỉ được nạp khi TeamWorkspace đã trust (T9)
│   ├── agents\team-orchestrator.toml     (Player kiểm, byte-identical với runtime) + profile subagent
│   └── rules\team.rules                  (đội) execpolicy
├── .agents\skills\<tên>\SKILL.md         skill (Player trỏ tới 3 skill bắt buộc)
├── .mtm\team-pack-info.json              (Player kiểm, byte-identical)
├── .mtm\team-runtime.json                (Player kiểm, byte-identical)
├── matches\                              matchesWorkspace = challengeWorkspace
│   └── <matchId>\                        checkoutRoot (git clone, Git root)
│       ├── <matchId>\                    matchRoot (= repository.folder)
│       │   └── answers\<ID>\submit.json, evidence\
│       └── .team-work\                   (đội) vùng tạm, bị loại khỏi git (05 §4)
└── team-sdlc-pack\
    ├── runtime\                          bản sao package (Player kiểm)
    └── logs\<matchId>.progress.ndjson    Player tạo; <matchId>.dashboard.html, .player-progress.json của Player
```

- `checkoutRoot = TeamWorkspace/matches/<matchId>`, `matchRoot = checkoutRoot/<folder>`,
  `folder == matchId` (`src/workspace-paths.mjs`, `src/preparation.mjs:61`).
- Mỗi lần Init, Player đòi `matches/<matchId>` phải trống, và hỏi operator trước khi xoá. Resume không xoá.
- Khối `AGENTS.md` của Player (`src/workspace-instructions.mjs:8`) chứa JSON assignment (teamId, matchId,
  repository, các path, `gameMasterOrigin`) và các luật: commit path bắt đầu bằng `repository.folder`;
  push thường lên branch được giao, kể cả khi đó là default branch; không force-push, không xoá branch;
  credential chỉ dùng ở origin Game Master; không lưu secret; báo `HOST_APPROVAL_REQUIRED` khi bị chặn
  duyệt. Player báo lỗi nếu `AGENTS.md` là symlink hoặc hardlink, hoặc marker bị hỏng.

## 7. Player kiểm tra pack (Load team pack / Initialize)

Nguồn: `src/team-install.mjs`, `src/team-runtime.mjs:30`. Sai bất kỳ điều nào là Init thất bại với mã
`TEAM_RUNTIME_NOT_INSTALLED`, `INSTALLED_RUNTIME_TAMPERED`, `INVALID_TEAM_PACK`, `INVALID_TEAM_PACK_INFO`,
`INCOMPATIBLE_TEAM_RUNTIME` hoặc `UNSAFE_TEAM_PACK_PATH`.

1. `TeamWorkspace/team-sdlc-pack/runtime/package.json`: `name = "team-sdlc-pack"`, `version` dạng
   `X.Y.Z`; `files` **đúng y** một trong ba danh sách, khuyên dùng danh sách đầy đủ:
   `["agents/","bin/","config/","contracts/","docs/","install.ps1","scripts/check-distribution.mjs","scripts/install.mjs","skills/","src/","README.md","team-pack-info.json","team-runtime.json"]`;
   không có `dependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies` khác rỗng;
   không có script `preinstall`, `install`, `postinstall`, `prepare`.
2. Mọi mục trong `files` phải tồn tại trong `runtime/`; chỉ file thường và thư mục, **không symlink**.
3. `team-runtime.json` đúng 7 key: `{schemaVersion:1, kind:"mtm-team-runtime", name:"team-sdlc-pack",
   version:<= package>, protocolVersion:4, provider:"codex", entrypoint:{rootAgentType:"team_orchestrator"}}`.
   Thêm key nào là bị loại.
4. `team-pack-info.json` đúng 4 key: `schemaVersion: 1`, `version` = version của package, `teamId` (khớp
   `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`), `teamName` (1–160 ký tự, không có khoảng trắng đầu/cuối,
   không xuống dòng, không NUL).
5. Ba file đăng ký phải **trùng từng ký tự** với bản trong `runtime/`:
   `agents/team-orchestrator.toml → .codex/agents/team-orchestrator.toml`,
   `team-pack-info.json → .mtm/team-pack-info.json`, `team-runtime.json → .mtm/team-runtime.json`.
6. Nếu có `team-sdlc-pack/node_modules/team-sdlc-pack`, `runtime/` phải trùng hoàn toàn với nó. Đội
   **không tạo** thư mục này.
7. Team ID operator nhập phải khớp `teamId` của pack (không phân biệt hoa thường).

## 8. `ENVIRONMENT_READY` → Preparation Complete

- Player đọc lại log (giới hạn 4 MB cho bước này), lấy dòng `ENVIRONMENT_READY` hợp lệ
  (`src/match/progress.mjs:310`). Có hai dòng `ENVIRONMENT_READY` khác nội dung → `ENVIRONMENT_READY_CONFLICT`.
  Vì vậy **không bao giờ** ghi lại với revision hoặc requestId khác.
- Player kiểm (`src/preparation.mjs:65`): `requestId` = `requestId` của PREPARE; `repository` trùng
  descriptor sau chuẩn hoá (url `https://`, không có user/pass); `revision` là hex thường 40–64 ký tự;
  `build == "PASS"`, `matchLogin == "PASS"`.
- Player tự gọi `POST /api/v1/matches/<uuid>/preparation/complete`, ghi file
  `<matchId>.player-progress.json` (`PLAYER_PREPARATION_COMPLETE`) và hiện stage `PREPARE_COMPLETE` trên
  dashboard. Team **không** ghi stage `PREPARE_COMPLETE`.

## 9. Quan sát của Player (đội cần biết để không bị gắn cờ)

| Kênh | Player thấy gì |
|---|---|
| Transcript | Text của agent (đã che secret xuất hiện trong frame), tên tool; không có tham số và output thô |
| Tool records | Lệnh shell, MCP tool call (`server/tool`), file change; cửa sổ 500 bản ghi |
| Network | **Chỉ** từ `structuredContent.networkActivity` mà MCP helper tự khai: `[{url, method, httpStatus}]` (`src/cli-activity.mjs`), cộng với event `GAME_MASTER_API`/`NETWORK_ACTIVITY` trong log |
| Model usage | Token theo model, cho root và subagent |

Suspected Violations (`src/match/progress.mjs:650-705`, `src/model-policy.mjs`): `UNEXPECTED_NETWORK_ORIGIN`
(event mạng có origin ngoài danh sách); `RISKY_GIT_OR_CREDENTIAL_OPERATION` (tên operation trong
`TOOL_ACTIVITY` khớp `FORCE_PUSH`, `REMOTE_SET/ADD/REMOVE`, `CREDENTIAL_READ/EXPORT`);
`OUTSIDE_TEAM_WORKSPACE_ACCESS`; `TEAM_RUNTIME_INTEGRITY_ACCESS` (ghi vào `…\.mtm\…` hoặc
`team-sdlc-pack\runtime\…`); `HOST_*_SIGNAL`; `HOST_TELEMETRY_GAP`; `MODEL_NOT_ALLOWED`. Đây là bằng
chứng để BTC xem sau trận, không tự động xử thua.

## 10. Bootstrap và team-info (để hiểu, đội không gọi)

Player gọi `POST /api/v1/game-player/teams` bằng bootstrap secret và nhận team-info: URL Game Master,
repository assignment, contract Preparation Complete, tài khoản đăng nhập, API key và scope. Đội **không
được** đọc kho lưu trữ của Player (`%LOCALAPPDATA%\MTM PLAYER\`), không gọi các route điều khiển của Player.
Nút *Show full details* trên dashboard dành cho organizer.

## 11. Phiên bản và chế độ

- `protocolVersion` của manifest = **4**.
- Player còn chế độ "attached host" kiểu cũ: host spawn `agent_type: team_orchestrator` với `task_name`,
  `fork_turns: none`. Khi đó `developer_instructions` trong `.codex/agents/team-orchestrator.toml` mới có
  tác dụng. Ở chế độ app-server mặc định, root là một thread thường, và hướng dẫn tới từ prompt +
  `AGENTS.md` + skill. Vì vậy profile root chỉ cần ngắn, trỏ về skill.

## 12. Khi Player ra bản mới

Diff các file sau với bản cũ, rồi chạy lại contract test ([10 §3](10-kiem-thu.md#3-contract-test-dùng-source-player-làm-oracle)):
`src/team-runtime.mjs`, `src/team-install.mjs`, `src/match/progress.mjs` (validate, transition, giới hạn kích
thước), `src/cli-supervisor.mjs` (`protocolPrompt`), `src/codex-app-server.mjs`,
`src/local-app-lifecycle.mjs`, `src/submission-policy.mjs`, `src/model-policy.mjs`,
`src/workspace-paths.mjs`, `src/workspace-instructions.mjs`, `src/preparation.mjs`, và
`contracts/progress-event.schema.json` trong sample pack mới.

### 0.9.41 (30/10/2026)

Bản `0.9.41-local` (`D:\mtm\MTM-PLAYER\0.9.41`, chép vào `vendor/mtm-player-0.9.41/` không kèm `node.exe`). Trong danh
sách trên chỉ `progress.mjs` và `codex-app-server.mjs` đổi, không đổi gì mà pack phải theo; cách duyệt quyền vẫn như
cũ (`approvalPolicy: 'on-request'`, `approvalsReviewer` mặc định `auto_review`, tức guardian của Codex); contract test
chạy lại trên source 0.9.41. Thay đổi:

- `src/codex-subagent-usage.mjs` (mới), `src/match/progress.mjs`, `src/codex-app-server.mjs`: dashboard cộng token của
  subagent, đọc từ file session Codex (cùng `session_id` với root) vài giây một lần; thread guardian bị loại vì "Codex
  does not charge for them". `tools/judge/usage.mjs` vẫn cần để xem guardian và thời gian job.
- `src/local-app.mjs`, `src/manage-web.mjs`: Shut down chờ agent dừng rồi tự đóng, không phải bấm lần hai.
- `src/cli-activity.mjs`, `src/diagnostic-journal.mjs`: che `user:password@` trong URL mọi scheme (cả chuỗi kết nối DB).

### 0.9.39 (29/10/2026)

Bản `mtm-player-0.9.39-local-windows`. Trong danh sách trên có `team-install.mjs`, `progress.mjs` và `codex-app-server.mjs`
đổi, nhưng không đổi gì mà pack phải theo; contract test chạy lại trên source 0.9.39 (77/77). Thay đổi:

- `src/team-install.mjs`: `INSTALLED_RUNTIME_TAMPERED` kèm `detail` là file đầu tiên khác bản tham chiếu (đường dẫn
  tương đối với TeamWorkspace); trang Init hiện `File: …`. Cách kiểm vẫn như cũ (so từng file của `runtime/` và các
  file đăng ký), nên vẫn phải cài lại bằng installer, không sửa tay file đã cài.
- `src/codex-price-card.mjs`: price card `codex-standard-2026-10-28` có giá **gpt-6.1-sol** (50 / 2,5 / 250 credit mỗi
  1M input / cached / output) và **gpt-6.1-terra** (25 / 1,25 / 125), cùng `serviceTierMultipliers`: Fast (`priority`)
  ×2, Ultrafast ×6. Giá khớp với ước tính trong [06 §9](06-agents-va-skills.md#9-chọn-model), nên thang model giữ nguyên.
- `src/match/progress.mjs`, `src/codex-app-server.mjs`: dashboard ghi service tier của root (`thread/settings/updated`),
  thêm cột Mode, tính credit theo hệ số tier. Các trận tập tới 28/10 đều chạy `default` (Standard), không có Fast.
- `src/dashboard-streaming.mjs`: snapshot đẩy lên Game Master tối đa 1 lần / 15 s (trước là 10 s).
- Lỗi khởi động local app và desktop kèm `detail`; form duyệt quyền (approval) không còn tự submit.
- `tools/judge/usage.mjs` dùng price card mới và nhân hệ số tier đọc từ `thread_settings_applied` trong transcript.

### 0.9.35 (27/10/2026)

Không file nào trong danh sách trên đổi; contract test chạy lại trên source 0.9.35. Thay đổi:

- `src/match-status.mjs`: `matchStatus` ký bằng **Team API Key** của đội (`session.gameMasterPlayerSecret`),
  bỏ key Game Master gắn sẵn. Với 0.9.33, từ 27/10 server trả 401/403 cho key cũ nên Player báo
  `MATCH_STATUS_POLL_FAILED: MATCH_STATUS_AUTH_REJECTED`, không bao giờ dispatch Codex (match 8TUM8N5W).
- `src/dashboard-streaming.mjs`: snapshot dashboard chỉ đẩy lên Game Master tối đa 1 lần / 10 s.
- `src/workspace-picker.mjs`, `docs/installation.md`: hỗ trợ macOS. Trên Mac, `Install Team Pack.command`
  của Player chạy thẳng `scripts/install.mjs --team-workspace <ws>` rồi `scripts/check-distribution.mjs`,
  nên `install.mjs` không được phụ thuộc PowerShell hay đường dẫn Windows.
- Không còn kèm `node.exe`: copy `node.exe` (Node 20+, khuyên 24 LTS) vào cạnh `mtm-player.exe`.
