# 03 · Game Master: trang trận và API

Nguồn: tài liệu *Digital Cuder API: Start work và Submit* (`docs/btc/digital-cuder-api-start-submit.html`),
guide §3, Game Rules. Phần trang trận còn phải xác minh trên server thật (**Spike S2**, ngày 26/10).

## 1. Hai kênh, hai loại credential

| Kênh | Dùng cho | Credential | Có trong descriptor |
|---|---|---|---|
| Trang web `/<origin>/match/<matchId>` | Đọc trận, đội, repo, backlog, sự kiện, URL hai API | Cookie phiên sau khi đăng nhập bằng `username` + `password` | `PREPARE_GAME`, `RESUME_*` |
| API `POST /api/v1/matches/{matchUuid}/...` | Start Work, Submit | `Authorization: Bearer <apiKeySecret>`, scope `submission:create` | `START_GAME`, `RESUME_GAME` |

Đề, backlog và sự kiện **chỉ** đọc trên trang `/match` bằng phiên đăng nhập, không đọc bằng API key.
API key **không** dùng cho trang, và mật khẩu không dùng cho API.

## 2. Trang trận

### 2.1 Những gì đã biết

- Phải mở **đúng** `<origin>/match/<matchId>`. `matchPageUrl` trong descriptor là trang chung `/match`
  (T5), không xác định trận.
- Trang hiện: trận, đội, repository/branch/folder được giao, backlog (mã, loại, tiêu đề, mô tả, điểm
  tối đa, trạng thái `VISIBLE` → `OPEN` → `CLOSED`, deadline nếu có), sự kiện theo đợt (`FAULT`,
  `INCIDENT`, `PRESSURE`, `TWIST`, `FINALE`), và mục **Digital Cuder APIs** chứa URL Start work /
  Submit có **Match UUID**.
- Lúc chuẩn bị: chỉ đăng nhập, kiểm định danh và repo, **không** bắt đầu backlog, **không** ghi `DISCOVERED`.
- Hết hạn cookie: đăng nhập lại rồi refresh. Không coi đó là hết trận.

### 2.2 Cần xác minh (Spike S2), ghi kết quả vào mục 2.4

1. Request đăng nhập: method, path, kiểu body (form hay JSON), CSRF token, tên cookie, redirect.
2. Dữ liệu trang lấy từ đâu: HTML render sẵn, JSON nhúng (`__NEXT_DATA__` hoặc RSC `self.__next_f`),
   hay XHR tới endpoint JSON cùng origin.
3. Tên field của item; định dạng deadline (thời điểm tuyệt đối hay số phút còn lại); trạng thái trận
   (`PREPARING`, `IN_PROGRESS`, `PAUSED`, `FINISHED`, `TIME OVER`, `CANCELLED`); trang có hiện giờ server
   hoặc thời gian còn lại không.
4. Mục Digital Cuder APIs: định dạng URL; có hiện trạng thái item của chính đội không (Working/Submitted).
5. ~~Trang có đổi nội dung item sau khi đã hiện không~~: BTC xác nhận **không** (Q10, 26/10), không cần kiểm.

Cách làm: đăng nhập bằng trình duyệt, mở DevTools → Network, lưu HAR (**xoá cookie và mật khẩu trước khi
commit**), chụp màn hình trang. Đưa vào `tools/mock-gm/fixtures/` làm fixture cho parser.

### 2.3 Mô hình chuẩn hoá helper phải dựng ra (`MatchView`)

```jsonc
{
  "matchId": "ABCD1234",
  "matchUuid": "8c0e1b22-...",           // tách từ URL Start work/Submit trên trang
  "status": "IN_PROGRESS",                // PREPARING | IN_PROGRESS | PAUSED | FINISHED | TIME_OVER | CANCELLED | UNKNOWN
  "serverNow": "2026-10-26T09:12:30Z",    // từ trang nếu có, nếu không thì từ header Date
  "minutesLeft": 27.5,                    // nếu trang có
  "team": {"id": "T01", "name": "..."},
  "repository": {"url": "...", "branch": "main", "folder": "ABCD1234"},
  "api": {"startWork": "https://.../api/v1/matches/<uuid>/backlogs/start",
          "submit":    "https://.../api/v1/matches/<uuid>/submissions"},
  "items": [{
    "key": "PI-03", "type": "PI", "title": "...", "status": "OPEN",
    "maxPoints": 150, "revealedAt": "...", "deadlineAt": "..." /* hoặc null */,
    "description": "..."
  }],
  "events": [{"label": "INCIDENT", "title": "...", "items": ["PI-03"]}]
}
```

Kiểm tra bắt buộc mỗi lần đọc: origin của trang thuộc `allowedMatchOrigins`; `matchId`, team, repository
khớp descriptor (lệch thì báo blocker, không làm tiếp); URL API có origin thuộc `allowedApiOrigins` và
path khớp đúng `^/api/v1/matches/<UUID>/backlogs/start$` và `^/api/v1/matches/<UUID>/submissions$`, cùng
một UUID.

### 2.4 Kết quả Spike S2

**26/10** (trận tự luyện `E1OOHQ5U`, lúc chuẩn bị, backlog còn trống). Nguồn: text trang do đội chép, cộng
HTML và JS public của `masterthemachine.tech` (đọc không đăng nhập). Chưa thấy response thật khi đã đăng
nhập, nên tên field bên dưới lấy từ code UI. Khi có dữ liệu thật thì đối chiếu lại.

**Đăng nhập và nguồn dữ liệu** (Next.js trên Vercel; trang `/match/<id>` render phía client, HTML chỉ có
"Loading match…"):

| Việc | Request | Ghi chú |
|---|---|---|
| Đăng nhập | `POST /api/v1/auth/login`, `Content-Type: application/json`, body `{"username","password"}` | Không thấy CSRF token. Phiên giữ bằng cookie (`credentials: "include"`). Response JSON có `user.role` (`ADMIN`/`CUDER`); lỗi có `error.message` |
| Đọc trận | `GET /api/v1/match/<matchId>` (theo matchId 8 ký tự) | **401** = phiên hết hạn → đăng nhập lại. Lỗi có `error.message` |
| Delta | `GET <api.feedEndpoint>?afterSequence=<match.currentSequence>` | `items` khác rỗng → đọc lại trận; **409** → đọc lại trận |
| Đăng xuất | `POST /api/v1/auth/logout` | Helper không gọi |
| Rematch | `POST /api/v1/match/<matchId>/rematch` | Nút trên trang. Helper **không bao giờ** gọi |

**Field đã thấy trong code UI** (response của `GET /api/v1/match/<id>`):
- `match`: `status` ∈ `DRAFT`, `READY`, `PREPARING`, `IN_PROGRESS`, `PAUSED`, `FINISHED`, `CANCELLED` (không
  có `TIME_OVER`), `elapsedSec`, `remainingSec`, `currentSequence`.
- `api`: `startEndpoint`, `submissionEndpoint`, `feedEndpoint`, `pollActiveMs` (mặc định UI 2000),
  `pollIdleMs` (10000), `staleAfterMs`.
- `backlog[]`: `key`, `type`, `title`, `status` (`OPEN`, `CLOSED`…), `points`, `deadlineMinutes` (tính từ lúc
  hiện), `revealedElapsedSec`, `revisionNo`.
- Còn có `team`, `repository` (`url`, `branch`, `folder`), `events` (`publishedAt`…).

Hệ quả:
- Helper không cần parse HTML. Dùng `GET /api/v1/match/<id>` và feed delta. Hai endpoint đều cùng origin với
  trang, nên vẫn nằm trong phạm vi "tài nguyên cùng origin mà chính trang dùng" (§8).
- Lấy `startEndpoint`/`submissionEndpoint` từ JSON thay vì tách từ text. Vẫn kiểm path theo regex ở §2.3.
- Deadline: `deadlineMinutes` + `revealedElapsedSec` so với `match.elapsedSec`, theo đồng hồ trận (không tính
  lúc `PAUSED`).
- **`revisionNo`**: UI đánh dấu item khi số này tăng. Như vậy server có khái niệm đề đổi revision, trái với Q10
  ("đề không bao giờ bị sửa"). Helper ghi lại `revisionNo` và báo root nếu số này tăng, chưa cần quy trình
  làm lại.
- Nhịp poll: tôn trọng `pollActiveMs`/`pollIdleMs` nhưng không nhanh hơn nhịp theo ngân sách log (04 §7);
  dùng feed delta để phần lớn lần poll rẻ.

Đã thấy trên trang, theo thứ tự:

| Khối | Nội dung |
|---|---|
| **Application** | Tên app + mô tả + danh sách tính năng (văn bản tự do; ở trận này là webapp Solova) |
| **Repo** | `URL` (`https://github.com/<owner>/<repo>`), `Branch` (`main`), `Folder` (`E1OOHQ5U/`, có `/` cuối) kèm câu dặn: làm thẳng trong folder đó, không chép source sang chỗ khác |
| **Backlog** | Trống tới khi item được mở (*"Backlog items appear here after they are revealed"*) |
| **Event timeline** | Trống tới khi có sự kiện |
| **Digital Cuder APIs** | `Match ID`, path **tương đối** `Start work` = `/api/v1/matches/<UUID>/backlogs/start`, `Submit` = `/api/v1/matches/<UUID>/submissions`, cùng hai ví dụ `curl` |
| **Company Tools** | MCP server riêng của trận, xem [§9](#9-company-tools-mcp-server-của-trận) |

Hệ quả cho parser:
- Match UUID có ngay từ lúc chuẩn bị, dạng text thường trong mục Digital Cuder APIs. URL API là path tương
  đối: helper ghép với origin của trang rồi kiểm theo `allowedApiOrigins`.
- So `Folder` với `repository.folder` thì bỏ `/` ở cuối.
- Ví dụ submit trên trang cho biết `answer` tối thiểu là `{"backlogId","status":"SUBMITTED","changeSummary"}`
  (template thật đến lúc Start Work, Spike S7).

Repo của trận (`main` @ `1394523e`, commit *"Seed E1OOHQ5U/ from scenario for-player"*):

```
README.md
E1OOHQ5U/
  README.md          trận 40 phút; đề mở ở phút 0, 14, 29; nộp source + answers/<ID>/submit.json + evidence cùng một revision
  exam-info.json     MTM_EXAM_LOCK, "immutable": true, graderFingerprint → không được sửa (thêm vào file cấm của gate)
  answers/README.md  mỗi item một thư mục answers/<ID>/ chứa submit.json và evidence
  env-require/       README, setup.ps1, db-setup.sql, prepare-source.ps1, doctor.ps1, requirements.json
  src/               app: Next.js 15 + tRPC + Prisma 6 + PostgreSQL, pnpm, vitest (tests/: 4 file, 12 test)
```

- Source app nằm ở `matchRoot/src`, không phải `matchRoot`: `detect_profile` phải tìm manifest trong thư mục con.
- `env-require/` là quy trình chuẩn bị BTC đưa kèm, xong khi `doctor.ps1` in `Environment status: READY`
  (xem [09 §7](09-dong-goi-va-van-hanh.md#7-chuẩn-bị-máy-thi-làm-một-lần-trước-2610)). Phần cần quyền admin
  (cài PostgreSQL 16 cổng **5433**, chạy `db-setup.sql` bằng superuser) phải làm tay **trước** trận;
  `setup_environment` chỉ làm phần còn lại: `src/.env`, script `prepare-source.ps1` của BTC (install + build),
  generate/migrate/seed theo profile, rồi `doctor.ps1` và baseline tests. Baseline tests chạy trên checkout chính, nên
  file đã track mà test ghi lại (vd `*.snap` bị vitest ghi lại bằng LF, practice 85WTXFLQ) được `git checkout --` về bản
  phát ngay sau đó (`restoredAfterTests`); file đã bẩn trước khi chạy test giữ nguyên. Khi không có script prepare, helper dùng
  lệnh suy ra nhưng vẫn build trước doctor. Worktree cũng chạy script prepare riêng, không dùng chung `node_modules`.
  Yarn có `yarnPath` hoặc release đóng gói trong repo được gọi bằng `node <yarnPath>` ở mọi lệnh, gồm app start;
  Yarn 2+ dùng `install --immutable`, Yarn 1 giữ `--frozen-lockfile`. Lệnh không tồn tại phải trả exit khác 0.
- Test làm rỗng test DB trước mỗi case: mỗi worktree chạy test song song phải có `TEST_DATABASE_URL` riêng
  (chỉ đổi tên database, vd `.../freelanceos_test_task02`). Gate đặt biến này theo lane.
- "Bẫy" đã thấy: Prisma in thông báo nâng lên bản major pre-release, không được làm theo; `package.json`
  ghi `pnpm@11.9.0` còn `setup.ps1` kích hoạt `pnpm@10.12.3`.

## 3. Start Work

```
POST /api/v1/matches/{matchUuid}/backlogs/start
Authorization: Bearer <TEAM_API_KEY>
Content-Type: application/json
Accept: application/json

{"backlogItemKey":"TASK-01"}
```

- `backlogItemKey`: bắt buộc, 1–32 ký tự, trùng mã item trên trang. Body strict: thừa field → 422.
- Không cần `Idempotency-Key`. Gọi lại an toàn: **200** với `replay: true` và cùng payload.
- Được nhận khi: trận `IN_PROGRESS` **hoặc `PAUSED`**; item đã hiện và `OPEN`, chưa quá deadline;
  trận chưa `FINISHED`/`TIME OVER`.
- Lần đầu trả **201**; spectator chuyển đội sang *Working* cho item đó.

| Field response | Ý nghĩa |
|---|---|
| `backlogId` | = `backlogItemKey` |
| `backlogType` | `TASK` / `CR` / `BUG` / `PI` |
| `startInstruction` | Hướng dẫn kèm, có thể rỗng |
| `submitTemplate` | Object để điền và gửi lại trong `answer`; `null` nếu đề không có |
| `minimumVerificationScenarios` | MVS (thường có với CR/BUG); `null` với TASK/PI |
| `files` | Map `path → nội dung thô` của file on-start, vd `challenge/TASK-01-submit.json`. File JSON đã được parse sẵn vào hai field trên |
| `replay` | `true` khi là lần gọi lại |

Submit template và MVS **không** hiện trên trang, chỉ có trong response này. Helper lưu toàn bộ vào
`checkoutRoot/.team-work/items/<ID>/` (`start.json`, `mvs.json`, `template.json`, `files/…`), là vùng
không commit, để subagent đọc.

`challenge/<ID>-submit.json` chỉ là **nguồn** của template. Bài nộp nằm ở
`<matchRoot>/answers/<ID>/submit.json`; evidence ở `<matchRoot>/answers/<ID>/evidence/` và được tham
chiếu trong JSON dưới dạng `evidence/<filename>`. **Không** tạo `<matchRoot>/evidence/` hay
`<matchRoot>/challenge/evidence/`.

## 4. Submit

```
POST /api/v1/matches/{matchUuid}/submissions
Authorization: Bearer <TEAM_API_KEY>
Idempotency-Key: <clientSubmissionId>
Content-Type: application/json
Accept: application/json

{"clientSubmissionId":"<uuid>","backlogItemKey":"TASK-01",
 "gitRevision":"<sha 40/64 hex>","answer":{ ...nội dung submit.json đã commit... }}
```

| Field | Bắt buộc | Ràng buộc |
|---|---|---|
| `clientSubmissionId` | Có | UUID do đội tạo (D7, §6) |
| `backlogItemKey` | Có | 1–32 ký tự, trùng key đã start |
| `gitRevision` | Có | SHA **đầy đủ** của commit **đã push**, đặt ở root body; Grader clone đúng SHA này |
| `answer` | Có | Object; copy từ `submitTemplate` rồi điền. Không có schema chung cho mọi trận |
| `artifactUrls` | Không | ≤ 20 URL `https://`, mỗi URL ≤ 2048 ký tự. Đội không dùng |
| `clientCreatedAt`, `metadata` | Không | Đội **không** gửi, để body luôn tất định |

- Header `Idempotency-Key` bắt buộc, khớp `^[A-Za-z0-9._~-]{8,128}$`. Đội dùng chính `clientSubmissionId`.
- `answer` ≤ ~200.000 ký tự JSON; cả request ≤ 524.288 byte, vượt thì 413. Evidence phải là **file
  trong commit**, không nhúng vào `answer`.
- Được nhận khi: đã Start Work; trận `IN_PROGRESS` (`PAUSED` mặc định bị từ chối); chưa `TIME OVER` hay
  `FINISHED`; item còn `OPEN`; đội chưa có bài được nhận cho item đó.
- Thành công: **luôn 201**, kể cả replay (replay có thêm header `Idempotent-Replay: true` và trả biên nhận đã lưu):

```json
{"submission":{"id":"6f1c2a40-...","matchId":"<uuid>","teamId":"<uuid>","backlogItemKey":"TASK-01",
 "backlogRevisionNo":1,"attemptNo":1,"receivedAt":"2026-10-23T01:15:00.000Z",
 "status":"ACCEPTED","scoreStatus":"PENDING"}}
```

- **`receiptId` dùng trong log = `submission.id`** (T3). `receivedAt` là mốc server dùng xếp hạng PI.
  `ACCEPTED` chỉ có nghĩa là server đã nhận, chưa phải `PASSED`.
- HTTP 2xx mà **không** có `submission.id` thì **không** được coi là đã nộp.

## 5. Mã lỗi và cách helper xử lý

Mọi lỗi có dạng `{"error":{"code","message","requestId","details"}}` và header `X-Request-Id`. Đưa
`requestId` vào event `GAME_MASTER_API` nếu khớp pattern id.

| HTTP / code | Khi | Start Work | Submit | Event / blocker |
|---|---|---|---|---|
| timeout, mạng, 5xx | Chưa biết server đã xử lý chưa | Thử lại có backoff (≤ 3 lần), vì idempotent | Thử lại **đúng key + đúng body** (≤ 5 lần trong ~60 s), rồi đối chiếu | `FAILED` (httpStatus null/5xx); hết lượt thì blocker `GM_UNAVAILABLE` |
| 400 / 422 `VALIDATION_ERROR` | Body sai | Lỗi helper: không thử lại cùng body | Như bên trái; sửa body thì phải dùng key mới (tăng `n`, §6) | blocker `SUBMISSION_INVALID-<ID>` |
| 401 `INVALID_API_KEY`, `API_KEY_REVOKED` | Bearer sai hoặc bị thu hồi | Dừng mọi API call | Dừng | blocker `GAME_MASTER_AUTHENTICATION_REQUIRED` (dashboard đánh dấu cần organizer) |
| 403 `API_KEY_SCOPE_FORBIDDEN`, `TEAM_NOT_IN_MATCH`, `FORBIDDEN` | Sai scope / sai trận | Dừng | Dừng | blocker `ORGANIZER_INTERVENTION_REQUIRED` |
| 404 `MATCH_NOT_FOUND` | Sai UUID | Đọc lại trang, lấy lại UUID | Như trái | — |
| 404 `BACKLOG_ITEM_NOT_FOUND` | Sai key | Refresh trang | Như trái | — |
| 409 `MATCH_NOT_IN_PROGRESS` | Trận chưa chạy | Chờ trạng thái | — | — |
| 409 `MATCH_NOT_ACCEPTING_SUBMISSIONS` | `TIME OVER`, `FINISHED`, hoặc `PAUSED` | Dừng | Nếu `PAUSED`: giữ nguyên, nộp lại sau khi resume. Nếu hết trận: dừng | `BACKLOG_STATUS FAILED` nếu hết trận |
| 409 `BACKLOG_NOT_STARTED` | Chưa start | — | Gọi Start Work (replay) rồi nộp lại **cùng** key + body | — |
| 409 `BACKLOG_ITEM_NOT_VISIBLE` / `NOT_OPEN` | Item chưa mở | Chờ | Chờ | — |
| 409 `BACKLOG_ITEM_CLOSED` | Quá deadline | Bỏ item | Bỏ item | `BACKLOG_STATUS FAILED` "closed" |
| 409 `ALREADY_SUBMITTED` | Đã có bài khác key được nhận | — | Tra journal: có key cũ thì gửi lại bằng key cũ để lấy biên nhận. Không có thì **không** ghi `SUBMITTED` | `BACKLOG_STATUS COMPLETED` + summary "server reports already submitted; receipt unavailable" |
| 409 `IDEMPOTENCY_CONFLICT` | Cùng key, khác body | — | Gửi lại **chuỗi body đã lưu** trong journal | — |
| 413 `PAYLOAD_TOO_LARGE` | `answer` quá lớn | — | Lỗi build answer, rút gọn | blocker |
| 422 `INVALID_SUBMISSION` | `artifactUrls` sai | — | Không gửi `artifactUrls` | — |
| 429 `RATE_LIMITED` | Submit quá dày | (không áp) | Chờ `Retry-After` giây rồi gửi lại cùng key + body | — |

Luật chung: **chỉ đọc** (trang) mới được retry tự do. Submit chỉ retry với **cùng** key + body. Không bao
giờ tự sinh key mới khi chưa chắc lần trước đã thất bại hẳn.

## 6. `clientSubmissionId` tất định (D7)

```
seed  = "mtm-submit:v1|" + matchUuid + "|" + backlogItemKey + "|" + gitRevision + "|" + n
bytes = SHA-256(seed)[0..15]
bytes[6] = (bytes[6] & 0x0f) | 0x40      // version nibble 4: qua được validator chỉ nhận UUID v4
bytes[8] = (bytes[8] & 0x3f) | 0x80      // variant RFC 4122
id    = hex 8-4-4-4-12 (chữ thường)
```

- `n` bắt đầu từ 0, **chỉ** tăng khi server từ chối hẳn (400/413/422) và phải sửa body.
- Body request = `JSON.stringify({clientSubmissionId, backlogItemKey, gitRevision, answer})` với `answer =
  JSON.parse(git show <rev>:<folder>/answers/<ID>/submit.json)`. Chuỗi body được ghi vào journal
  **trước** khi POST; mọi lần thử lại dùng đúng chuỗi đã lưu.
- Sau khi bị kill và khởi động lại: journal có `submitIntent` thì gửi lại y hệt. Server trả 201 kèm
  `Idempotent-Replay` cùng biên nhận cũ.

## 7. Thời gian và deadline

- Chỉ tin đồng hồ server. Helper tính `skew = Date(header response) − giờ máy` sau mỗi request tới Game
  Master, dùng giờ đã hiệu chỉnh cho mọi phép tính deadline. Ưu tiên số liệu trang hiện nếu có.
- Deadline tính từ lúc đề hiện, bằng phút, không tính thời gian `PAUSED`.
- Không nộp khi item đã `CLOSED`. Không Start Work một item mà thời gian còn lại ít hơn ngưỡng tối thiểu
  của loại đó ([07 §4](07-quy-trinh-tran.md#1-tổng-quan-thời-gian)).

## 8. Được và không được gọi

**Được:** URL đăng nhập và trang `/match/<matchId>` trên `allowedMatchOrigins`; tài nguyên cùng origin mà
chính trang dùng (sau Spike S2); hai URL API đọc từ trang, trên `allowedApiOrigins`.

**Không được:** Admin UI/API, Grader API, route `/api/v1/game-player/*` và Preparation Complete (của
Player), trang hay dữ liệu của đội khác, đề/template/MVS chưa mở, đoán URL. Không follow redirect sang
origin lạ. Không gửi bearer tới origin nào khác Game Master.

## 9. Company Tools: MCP server của trận

Có trên trang trận từ 26/10; technical guide 0.5.1 và source Player 0.9.33 **không** nhắc tới.

- URL `https://masterthemachine.tech/api/v1/mcp/<matchId>` (theo **matchId** 8 ký tự, không phải Match UUID).
  Transport MCP Streamable HTTP (JSON-RPC 2.0, response JSON).
- Auth `Authorization: Bearer <TEAM_API_KEY>`: **cùng** key với Start Work / Submit.
- `initialize` và `tools/list` chạy được từ lúc chuẩn bị; tool chỉ trả nội dung sau khi trận bắt đầu; nội
  dung về một item chỉ có sau khi item hiện trên `/match`. Danh sách tool **đổi theo đề**.
- *"Information from these systems is authoritative and overrides assumptions. Appropriate use of company
  systems is part of process quality."* Server ghi lại mọi lần gọi theo đội và trận, nên việc dùng tool này
  nhiều khả năng được chấm.
- Lỗi: HTTP 401/403 (key sai, bị thu hồi, thiếu scope, đội không thuộc trận), 404 (Match ID lạ); lỗi nghiệp vụ
  nằm trong kết quả tool với `isError: true` và `{"error":{"code","message"}}`.
- Rate limit **120 request/phút mỗi API key**.

Hệ quả cho thiết kế (chưa đưa vào 05):
- Không khai được `[mcp_servers.company]` kiểu Codex native, vì Codex khởi động trước khi có key: bearer chỉ
  có trong frame `START_GAME`/`RESUME_GAME`, và Player mới là bên khởi chạy Codex. Hướng chọn: helper làm
  proxy, gồm `company_tools` (cache `tools/list`) và `company_call(name, arguments)`. Key vẫn chỉ nằm trong
  helper; kết quả tool là dữ liệu untrusted, được bọc lại như nội dung item.
- `hostAuthorization.apiOperations` của Player chỉ liệt kê START_WORK và SUBMIT. Cần hỏi BTC xem gọi
  `/api/v1/mcp/...` bằng bearer có bị Player gắn cờ không (Q15).
- Skill `item-analysis` phải tra Company Tools trước khi đoán (ví dụ log, ticket, tài liệu nội bộ), và ghi
  rõ đã dùng tool nào trong `evidencePlan`.
- Ngân sách gọi tool: 120/phút dùng chung cho mọi lane, nên helper cần token bucket.
