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

> *(điền sau ngày 26/10: request đăng nhập, cookie, nguồn dữ liệu, field, ví dụ đã che secret)*

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
  của loại đó ([07 §4](07-quy-trinh-tran.md#4-xếp-lịch)).

## 8. Được và không được gọi

**Được:** URL đăng nhập và trang `/match/<matchId>` trên `allowedMatchOrigins`; tài nguyên cùng origin mà
chính trang dùng (sau Spike S2); hai URL API đọc từ trang, trên `allowedApiOrigins`.

**Không được:** Admin UI/API, Grader API, route `/api/v1/game-player/*` và Preparation Complete (của
Player), trang hay dữ liệu của đội khác, đề/template/MVS chưa mở, đoán URL. Không follow redirect sang
origin lạ. Không gửi bearer tới origin nào khác Game Master.
