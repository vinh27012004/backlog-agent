# 04 · Progress log NDJSON

**Verification 31/10:** mvs, acceptance và answer_only tách riêng. answer_only đếm ba kiểm tra có tên
(schema/source, independent derivation, code gate), không nhập scenario giả. Manifest/metrics không mở rộng schema
progress của Player; xem [13](13-workflow-toi-uu.md).

Nguồn chuẩn: `validateProgressEvent()` và `reduceProgressEvents()` trong
`vendor/mtm-player-0.9.44/app/src/match/progress.mjs` (dòng 215–555), và
`vendor/team-orchestrator-pack-0.5.1/contracts/progress-event.schema.json`. Schema JSON **không** diễn đạt hết các
luật liên field; Player kiểm thêm bằng code. Helper phải kiểm **cả hai**.

## 1. File và quyền ghi

- Path: **đúng** `descriptor.progressLogFile`
  (= `TeamWorkspace\team-sdlc-pack\logs\<matchId>.progress.ndjson`).
- Lúc Init, Player **tạo mới hoặc ghi đè** file và ghi dòng 1 `ORCHESTRATOR_STARTED`. Resume giữ nguyên file.
- Đội chỉ **append**: mỗi event là một JSON gọn trên một dòng, kết thúc bằng `\n`, UTF-8, không BOM.
  Không sửa, không xoá, không ghi đè dòng cũ.
- Một dòng ≤ 16 KB. **Cả file ≤ 256 KB**; vượt mức thì Player báo `PROGRESS_LOG_TOO_LARGE` và
  dashboard ngừng đọc log (`progress.mjs:785`). Đội đặt trần riêng **230 KB** (§7).
- Chỉ **một writer**: tiến trình helper của root. Subagent không ghi log.
- Player đọc mỗi dòng độc lập: dòng sai schema hoặc sai luật chuyển trạng thái bị **bỏ qua** (hiện
  `IGNORED` trên console), các dòng khác vẫn được tính. Dòng cuối chưa có `\n` bị bỏ qua cho tới khi đủ.

## 2. Luật chung cho mọi event

- Đúng tập key của loại event. **Không** thêm key (kể cả timestamp), **không** thiếu key; field null vẫn
  phải có mặt.
- `schemaVersion: 1`; `playerSessionId` = đúng giá trị trong descriptor hiện tại.
- **id** (`backlogId`, `blockerId`, `requestId`, `operation`, `reason`, `receiptId`…): 1–128 ký tự,
  `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`.
- **summary**, **title**: 1–240 ký tự (title ≤ 160), không có `\r`, `\n`, NUL, và **không** khớp regex
  credential của Player:
  `(?:authorization\s*:\s*bearer\s+\S{8,}|\b(?:password|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*\S{8,}|\b(?:gm|gh[pousr])_[A-Za-z0-9_-]{12,})` (không phân biệt hoa thường).
  Ví dụ `"api key: verified"` bị loại. Đừng viết các từ đó kèm `:` hoặc `=`.
- **revision**: `null` hoặc hex thường 40–64 ký tự.
- Số đếm (`required`, `executed`…): số nguyên 0..100000.

## 3. Danh mục event

| Type | Key ngoài envelope | Ràng buộc chính | Ai ghi |
|---|---|---|---|
| `ORCHESTRATOR_STARTED` | `summary` | Chỉ một lần, là dòng đầu | **Player** (T1). Đội không ghi |
| `ORCHESTRATOR_RESTARTED` | `attempt`, `phase`, `reason`, `summary` | `attempt` = số lần restart trước đó trong log + 1; `phase` ∈ `PREPARATION`, `GAME`; `reason` là id | Root, đầu mỗi lượt RESUME |
| `PREPARATION_STATUS` | `stage`, `status`, `summary` | `stage` ∈ `GIT_AUTH`, `REPOSITORY`, `ENVIRONMENT`, `BUILD`, `MATCH_LOGIN` (`PREPARE_COMPLETE` dành cho Player); `status` ∈ `IN_PROGRESS`, `COMPLETED`, `BLOCKED`, `FAILED` (**không** có `PASS`) | Helper |
| `ENVIRONMENT_READY` | `requestId`, `repository{url,branch,folder}`, `revision`, `build`, `matchLogin` | **Không có summary**; `requestId` = của PREPARE; `repository` chép từ descriptor (url `https://`, không có `user@`); `build` = `matchLogin` = `"PASS"`; `revision` khác null | Helper, khi đủ điều kiện ([05](05-mcp-helper.md)) |
| `GAME_START_STATUS` | `stage`, `status`, `summary` | `stage` = `BACKLOG_SYNC` | Helper |
| `BACKLOG_STATUS` | `backlogId`, `title`, `status`, `summary`, `revision`, `receiptId` | `status` ∈ `DISCOVERED`, `IN_PROGRESS`, `COMPLETED`, `SUBMITTED`, `BLOCKED`, `FAILED`; `SUBMITTED` ⇒ `revision` và `receiptId` khác null | Helper |
| `BACKLOG_TESTS` | `backlogId`, `status`, `required`, `executed`, `passed`, `failed`, `skipped`, `summary` | §4 | Helper: `start_work` (`NOT_RUN`), `record_verification` (`RUNNING`/`PASSED`/`FAILED`). Root không ghi trực tiếp |
| `GAME_MASTER_API` | `operation`, `backlogId`, `method`, `origin`, `path`, `phase`, `httpStatus`, `requestId`, `summary` | §4 | Helper, quanh **mọi** request tới Game Master |
| `BLOCKER_OPENED` | `blockerId`, `backlogId`, `summary` | `blockerId` chưa đang mở | Root/helper |
| `BLOCKER_RESOLVED` | `blockerId`, `summary` | `blockerId` đang mở | Root/helper |
| `ORCHESTRATOR_ENDED` | `status`, `summary` | `status` ∈ `COMPLETED`, `BLOCKED`, `FAILED`; `COMPLETED` không hợp lệ khi còn blocker mở; sau `ENDED` chỉ `ORCHESTRATOR_RESTARTED` hợp lệ | Root khi hết trận (nếu kịp) |
| `MODEL_USAGE`, `TOOL_ACTIVITY`, `NETWORK_ACTIVITY` | (xem schema) | Hợp lệ nhưng **đội không dùng**: Player tự đo token; không được bịa số; tốn byte | — |

## 4. Luật liên field (Player kiểm bằng code)

**BACKLOG_TESTS**
- `executed == passed + failed + skipped`.
- `NOT_RUN` ⇒ `executed == 0`.
- `PASSED` ⇒ `executed > 0`, `failed == 0`, `executed >= required`.
- `FAILED` ⇒ `failed > 0`.
- `RUNNING`: chỉ cần nhất quán số học.
- Phải có `BACKLOG_STATUS` của cùng `backlogId` **trước** đó.
- Quy ước đếm của đội: `required` = số kịch bản MVS (TASK/PI: số tiêu chí chấp nhận, tối thiểu 1) + 1
  (bộ regression của gate). Chỉ đếm thứ **đã thật sự chạy**. Không ước lượng.

**GAME_MASTER_API**
- `method`: `null` hoặc một trong `GET POST PUT PATCH DELETE HEAD OPTIONS`.
- `origin`: `null` hoặc origin chính xác dạng `https://host[:port]`, không có `/` cuối, path, query hay
  user (schema chỉ nhận `https`; Player nhận thêm `http://127.0.0.1` khi test).
- `path`: `null` hoặc bắt đầu bằng `/`, không có `?`, `#`, `\`. **Không** ghi query.
- `REQUESTED` ⇒ `httpStatus == null`. `SUCCEEDED` ⇒ `200 ≤ httpStatus ≤ 299`. `FAILED` ⇒ `httpStatus` null
  hoặc ≥ 400. Mã 3xx không hợp lệ ở mọi phase: đăng nhập trả 302 thì helper theo redirect (cùng origin,
  có kiểm tra) và ghi mã của response **cuối**.
- `operation` dùng: `LOGIN`, `REFRESH`, `START_WORK`, `SUBMIT`. Origin phải thuộc danh sách được phép,
  nếu không Player gắn cờ `UNEXPECTED_NETWORK_ORIGIN`.

## 5. Luật chuyển trạng thái

```
DISCOVERED  → DISCOVERED | IN_PROGRESS | SUBMITTED | BLOCKED | FAILED
IN_PROGRESS → IN_PROGRESS | COMPLETED | SUBMITTED | BLOCKED | FAILED
COMPLETED   → COMPLETED | IN_PROGRESS | SUBMITTED | BLOCKED | FAILED
BLOCKED     → BLOCKED | IN_PROGRESS | SUBMITTED | FAILED
FAILED      → FAILED | IN_PROGRESS | SUBMITTED
SUBMITTED   → SUBMITTED           (kết thúc)
```

- `DISCOVERED` cho item đã biết: Player bỏ qua (idempotent). `DISCOVERED` **không** reset trạng thái.
- `SUBMITTED` tự xoá các blocker gắn với `backlogId` đó trên dashboard.
- Blocker: không mở trùng id đang mở; không resolve id không mở. Mở lại id cũ sau khi đã resolve thì hợp lệ.
- Restart: `attempt` phải liên tiếp. Nếu `restartAttempt` trong descriptor lệch với số trong log (vd một
  root trước chết trước khi kịp ghi), ghi `attempt = số trong log + 1` và đưa
  `playerAttempt=<restartAttempt>` vào summary.

Ý nghĩa đội gán cho trạng thái item:

| Status | Khi nào ghi |
|---|---|
| `DISCOVERED` | Helper thấy item mới trong lúc chơi (cả item đội sẽ không làm) |
| `IN_PROGRESS` | **Sau khi** Start Work được nhận (201/200); và khi bắt đầu lại sau `FAILED`/`BLOCKED` |
| `COMPLETED` | Đã commit + push, sắp nộp; hoặc server báo đã nộp nhưng không lấy được biên nhận |
| `SUBMITTED` | Có `submission.id` |
| `BLOCKED` | Chờ yếu tố ngoài (duyệt, xác thực, trận `PAUSED`) |
| `FAILED` | Bỏ: item đã đóng, hết lượt thử, hết giờ |

## 6. Thứ tự event theo phase

**Chuẩn bị** (sau dòng `ORCHESTRATOR_STARTED` của Player):
```
PREPARATION_STATUS GIT_AUTH IN_PROGRESS → COMPLETED
PREPARATION_STATUS REPOSITORY IN_PROGRESS → COMPLETED          (clone/checkout, đã kiểm revision)
PREPARATION_STATUS ENVIRONMENT IN_PROGRESS → COMPLETED         (toolchain + dependency)
PREPARATION_STATUS BUILD IN_PROGRESS → COMPLETED               (build + test baseline)
GAME_MASTER_API LOGIN REQUESTED → SUCCEEDED
GAME_MASTER_API REFRESH REQUESTED → SUCCEEDED                  (mở /match/<matchId>, kiểm định danh)
PREPARATION_STATUS MATCH_LOGIN IN_PROGRESS → COMPLETED
ENVIRONMENT_READY                                              (rồi root kết thúc lượt)
```
Bước nào lỗi thì ghi `FAILED`/`BLOCKED` kèm blocker, **không** ghi `ENVIRONMENT_READY`.

**Bắt đầu chơi**:
```
GAME_START_STATUS BACKLOG_SYNC IN_PROGRESS
GAME_MASTER_API REFRESH REQUESTED → SUCCEEDED
BACKLOG_STATUS <mỗi item đang hiện> DISCOVERED
GAME_START_STATUS BACKLOG_SYNC COMPLETED
```

**Mỗi item**:
```
GAME_MASTER_API START_WORK REQUESTED → SUCCEEDED
BACKLOG_STATUS IN_PROGRESS
BACKLOG_TESTS NOT_RUN (required=N)
… (subagent làm việc; blocker nếu cần)
BACKLOG_TESTS RUNNING → PASSED | FAILED                        (số thật từ gate + kết quả MVS)
BACKLOG_STATUS COMPLETED                                       (đã push; tuỳ chọn)
GAME_MASTER_API SUBMIT REQUESTED → SUCCEEDED
BACKLOG_STATUS SUBMITTED (revision=<sha>, receiptId=<submission.id>)
```

**Hết trận** (nếu còn chạy): resolve hoặc giữ blocker → `ORCHESTRATOR_ENDED`.

**Resume**: `ORCHESTRATOR_RESTARTED` → (đối chiếu) → tiếp tục các luồng trên. **Không** ghi lại
`DISCOVERED`/`SUBMITTED` đã có.

## 7. Ngân sách byte và nhịp polling

Ước lượng: một event `GAME_MASTER_API` khoảng 280–320 byte; event khác 200–350 byte.

| Phần | Số event | Byte (ước) |
|---|---|---|
| Chuẩn bị + bắt đầu | ~20 | ~6 KB |
| 15 item × ~12 event | ~180 | ~55 KB |
| Refresh nền 15 s × 40 phút × 2 event | ~320 | ~95 KB |
| **Tổng** | | **~160 KB** |

Luật của helper (theo dõi kích thước file sau mỗi lần append):

| Kích thước log | Nhịp refresh nền | Khác |
|---|---|---|
| < 150 KB | 15 s (cấu hình được 10–30 s) | Bình thường |
| 150–200 KB | 30 s | Summary rút ngắn (≤ 60 ký tự) |
| 200–230 KB | 60 s | Chỉ refresh khi root yêu cầu và cách lần trước ≥ 60 s |
| ≥ 230 KB | Dừng refresh nền | Chỉ ghi event bắt buộc của item (`START_WORK`, `IN_PROGRESS`, `TESTS`, `SUBMIT`, `SUBMITTED`, blocker, `ENDED`) |

Không bao giờ bỏ event bắt buộc của một lần nộp. Summary viết ngắn và cố định (vd `"Refresh match page."`).

## 8. Khi không ghi được

- Append lỗi (file bị khoá, ổ đầy): giữ hàng đợi trong RAM ≤ 200 event, thử lại có backoff, ghi **theo
  đúng thứ tự**.
- Sau khi ghi lại được mà đã mất event: mở blocker `PROGRESS_LOG_UNAVAILABLE` và resolve ngay khi đã đồng bộ.
- Không bao giờ ghi event để che giấu hành động, không ghi `PASSED` khi chưa chạy test, không ghi
  `SUBMITTED` khi chưa có biên nhận.

## 9. Ví dụ một trận ngắn

```ndjson
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"ORCHESTRATOR_STARTED","summary":"Team orchestrator started."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"GIT_AUTH","status":"IN_PROGRESS","summary":"Checking Git access."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"GIT_AUTH","status":"COMPLETED","summary":"Git access to the assigned repository verified."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"REPOSITORY","status":"COMPLETED","summary":"Checked out branch main, folder ABCD1234."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"ENVIRONMENT","status":"COMPLETED","summary":"Node 24 and dependencies ready."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"BUILD","status":"COMPLETED","summary":"Build passed; baseline 142 tests, 0 failing."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"GAME_MASTER_API","operation":"LOGIN","backlogId":null,"method":"POST","origin":"https://masterthemachine.tech","path":"/api/auth/login","phase":"REQUESTED","httpStatus":null,"requestId":null,"summary":"Login to match page."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"GAME_MASTER_API","operation":"LOGIN","backlogId":null,"method":"POST","origin":"https://masterthemachine.tech","path":"/api/auth/login","phase":"SUCCEEDED","httpStatus":200,"requestId":"req_a1","summary":"Logged in."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"PREPARATION_STATUS","stage":"MATCH_LOGIN","status":"COMPLETED","summary":"Match page shows the assigned team and repository."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"ENVIRONMENT_READY","requestId":"prepare-1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","repository":{"url":"https://github.com/mtm-org/team-t01.git","branch":"main","folder":"ABCD1234"},"revision":"0123456789abcdef0123456789abcdef01234567","build":"PASS","matchLogin":"PASS"}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"GAME_START_STATUS","stage":"BACKLOG_SYNC","status":"COMPLETED","summary":"Retrieved the current backlog."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"BACKLOG_STATUS","backlogId":"BUG-01","title":"Reset restores the full customer list","status":"DISCOVERED","summary":"New backlog item.","revision":null,"receiptId":null}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"GAME_MASTER_API","operation":"START_WORK","backlogId":"BUG-01","method":"POST","origin":"https://masterthemachine.tech","path":"/api/v1/matches/8c0e1b22-1111-4222-8333-444444444444/backlogs/start","phase":"SUCCEEDED","httpStatus":201,"requestId":"req_b2","summary":"Start Work accepted."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"BACKLOG_STATUS","backlogId":"BUG-01","title":"Reset restores the full customer list","status":"IN_PROGRESS","summary":"Work started.","revision":null,"receiptId":null}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"BACKLOG_TESTS","backlogId":"BUG-01","status":"NOT_RUN","required":3,"executed":0,"passed":0,"failed":0,"skipped":0,"summary":"2 MVS scenarios plus regression."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"BACKLOG_TESTS","backlogId":"BUG-01","status":"PASSED","required":3,"executed":3,"passed":3,"failed":0,"skipped":0,"summary":"MVS 2/2 and regression passed."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"GAME_MASTER_API","operation":"SUBMIT","backlogId":"BUG-01","method":"POST","origin":"https://masterthemachine.tech","path":"/api/v1/matches/8c0e1b22-1111-4222-8333-444444444444/submissions","phase":"SUCCEEDED","httpStatus":201,"requestId":"req_c3","summary":"Submission accepted."}
{"schemaVersion":1,"playerSessionId":"7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e","type":"BACKLOG_STATUS","backlogId":"BUG-01","title":"Reset restores the full customer list","status":"SUBMITTED","summary":"Receipt received.","revision":"89abcdef0123456789abcdef0123456789abcdef","receiptId":"6f1c2a40-54d8-4a46-b722-4fdc2b307f54"}
```
(Ví dụ lược bớt các dòng `REQUESTED` và một số bước để ngắn gọn.)

## 10. Validator của helper

`src/match/progress.mjs` của đội phải tái hiện:
1. Tập key chính xác theo type, `schemaVersion`, `playerSessionId`.
2. Pattern id, summary/title (độ dài, ký tự cấm, regex credential), revision, origin, path, method, số đếm.
3. Luật liên field §4.
4. Luật chuyển trạng thái §5, dựa trên trạng thái đã ghi (đọc lại file lúc khởi động để dựng trạng thái).
5. Chặn trùng: không ghi lại `DISCOVERED` cho item đã biết; không ghi `ENVIRONMENT_READY` thứ hai khác nội dung.
6. Ngân sách byte §7.

Event không qua được validator thì **không ghi**; trả lỗi cho người gọi (root) kèm lý do. Contract test so
validator của đội với chính `validateProgressEvent` / `reduceProgressEvents` / `readProgressLog` của
Player ([10 §3](10-kiem-thu.md#3-contract-test-dùng-source-player-làm-oracle)).
