# 10 · Kiểm thử và xác minh

## 1. Kim tự tháp kiểm thử và chi phí

| Tầng | Công cụ | Tốn credit Codex? | Khi chạy |
|---|---|---|---|
| Unit | `node --test tests/pack` | Không | Mỗi lần sửa |
| Contract với source Player | `tests/pack/player-compat.test.mjs` | Không | Mỗi lần sửa; mỗi khi Player ra bản mới |
| Helper E2E với mock Game Master | `tools/fake-root.mjs` + `tools/mock-gm/` | Không | Trước mỗi bản phát hành |
| Dev root thật với mock Game Master | `tools/dev-root.mjs` (chạy Codex thật trên workspace tạm) | **Có** (ít) | Khi sửa skill; dùng tiết kiệm |
| Practice Match qua Player | Player + server thật | **Có** | Theo lộ trình [11](11-lo-trinh.md) |

Quy ước repo vẫn giữ: không chạy thứ tốn tiền khi chưa được yêu cầu. `tools/dev-root.mjs` tự khởi chạy
Codex nên **chỉ dùng lúc phát triển**, không bao giờ nằm trong pack và không chạy trong trận (D1).

## 2. Unit test (gợi ý theo module)

| Module | Case chính |
|---|---|
| `mcp.mjs` | Framing NDJSON; `initialize` / `tools/list` / `tools/call`; JSON hỏng → `-32700`; method lạ → `-32601`; không ghi gì khác ra stdout |
| `session.mjs` | Parse 4 loại frame + 2 khối policy; marker và `type` lệch → lỗi; bearer sai hash → `API_KEY_INTEGRITY_MISMATCH`; path ngoài TeamWorkspace; `folder ≠ matchId`; `NEEDS_PREPARATION_FRAME` |
| `paths.mjs` | Symlink/junction bị chặn; path có `..`; so path không phân biệt hoa thường trên Windows |
| `progress.mjs` | Từng type: key thừa/thiếu; summary có `\n` hoặc khớp regex credential; luật `BACKLOG_TESTS`; `GAME_MASTER_API` 3xx; chuyển trạng thái; blocker trùng; `ENDED` rồi event khác; ngân sách byte |
| `game-client.mjs` | Mọi dòng của bảng lỗi [03 §5](03-game-master.md#5-mã-lỗi-và-cách-helper-xử-lý); UUID tất định (vector cố định); retry giữ đúng chuỗi body |
| `http.mjs` | Redirect sang origin lạ bị chặn; cookie jar; giới hạn kích thước; header `Date` → skew; `networkActivity` không có query |
| `match-page.mjs` | Parse fixture HTML/JSON thật (sau Spike S2); trang lệch định danh; không thấy Match UUID |
| `git.mjs` | Push không có `--force`; ref đích đúng; path commit ngoài `<folder>/` bị chặn; xác minh `ls-remote` |
| `gate.mjs`, `profile.mjs`, `log-condenser.mjs` | Port case từ `tests/test_gate.py` và phần profile/logs trong `tests/test_agents.py`. Bản đã dựng: `gate.test.mjs`, `logs.test.mjs`, `testreport.test.mjs` (định dạng JSON thật của vitest 3.2, JUnit pytest/maven), `gate-runs.test.mjs` (runner giả ghi JSON kiểu vitest, repo git tạm, probe thật: test flaky, test biến mất, `weak_test`, fail-before) |
| `scheduler.mjs` | PI trước; slack của deadline; bỏ item không kịp; ngưỡng cuối trận |
| `redact.mjs` | Secret không bao giờ xuất hiện trong kết quả tool, lỗi, log |

## 3. Contract test dùng source Player làm oracle

Source Player nằm trong repo (`vendor/mtm-player-0.9.39/app/src`), chỉ dùng built-in của Node, nên
test import trực tiếp được. Đặt đường dẫn qua biến `MTM_PLAYER_SRC`; không có thì **skip** (không fail).

| Hàm của Player | Dùng để |
|---|---|
| `validateProgressEvent`, `reduceProgressEvents`, `readProgressLog` (`progress.mjs`) | Mọi event helper ghi ra phải hợp lệ; log sau một kịch bản E2E phải đọc được, đúng trạng thái backlog; kích thước < 256 KB |
| `readEnvironmentReadyProgress` (`progress.mjs`), `validateEnvironmentReady` (`preparation.mjs`) | `ENVIRONMENT_READY` của helper được chấp nhận với `requestId` + repository của descriptor |
| `prepareNativePreparation`, `prepareNativeGameStart`, `prepareNativeOrchestratorRestart` (`team-runtime.mjs`), `submissionPolicyFrame` (`submission-policy.mjs`), `modelPolicyFrame` (`model-policy.mjs`) | Sinh frame **thật** từ một session giả để test `configure_session` |
| `protocolPrompt` (`cli-supervisor.mjs`) | Dựng đúng prompt Player gửi, dùng cho `tools/dev-root.mjs` |
| `verifyTeamRuntime` (`team-install.mjs`), `discoverTeamRuntime` (`team-runtime.mjs`) | Kết quả của installer phải qua đúng bước kiểm của Player |
| `matchWorkspacePaths` (`workspace-paths.mjs`) | Công thức path của helper khớp Player |

Khi Player ra bản mới: cập nhật `MTM_PLAYER_SRC`, chạy lại bộ này, rồi đối chiếu [02 §12](02-hop-dong-player.md#12-khi-player-ra-bản-mới).

## 4. Mock Game Master (`tools/mock-gm/`)

Server Node chỉ nghe `127.0.0.1`, chạy theo kịch bản. Helper chỉ chấp nhận origin `http://127.0.0.1` khi
có `MTM_TEAM_TEST_MODE=1`.

- **Trang**: đăng nhập và `/match/<matchId>` mô phỏng đúng dạng thật (fixture từ Spike S2); cookie có hạn
  dùng; mục Digital Cuder APIs có Match UUID.
- **API**: Start Work và Submit đúng tài liệu: 201/200 replay, idempotency (cùng key + cùng body → 201
  `Idempotent-Replay`; cùng key, khác body → 409 `IDEMPOTENCY_CONFLICT`), toàn bộ mã lỗi, `X-Request-Id`, `Date`.
- **Kịch bản**: đồng hồ điều khiển được (nhanh, dừng, tua), các đợt item (chuyển từ
  `samples/scenarios/practice.json`), deadline, `PAUSED`/`FINISHED`.
- **Chèn lỗi**: cắt kết nối **sau khi** đã xử lý (mô phỏng timeout mà server đã nhận), 5xx, 429 có
  `Retry-After`, cookie hết hạn, thu hồi bearer.
- **Route điều khiển cho test** (chỉ ở mock): xem bài đã nhận, buộc trạng thái trận.

## 5. Helper E2E không cần LLM (`tools/fake-root.mjs`)

Chạy helper như Codex chạy (tiến trình con, MCP qua stdio), gọi tool theo đúng trình tự của skill. Một
"worker giả" áp patch mẫu (`samples/mock/fixer/<ITEM>.patch`) vào worktree và ghi file kết quả. Workspace
tạm có layout TeamWorkspace thật; repo là `samples/repo-template` với một bare remote cục bộ.

Kịch bản bắt buộc pass:
1. Happy path: chuẩn bị → `ENVIRONMENT_READY` → 4 item → 4 `SUBMITTED`; log qua oracle của Player.
2. PI xuất hiện giữa chừng và chiếm lane, lấy khoá publish trước.
3. Submit timeout (server đã nhận) → helper thử lại cùng key → 201 replay → một bài duy nhất.
4. Kill helper giữa lúc nộp → khởi động lại với frame RESUME → nộp lại từ journal → không trùng.
5. `ALREADY_SUBMITTED` không có journal → `COMPLETED` + summary, không ghi `SUBMITTED`.
6. Cookie hết hạn giữa trận → đăng nhập lại tự động.
7. Item đóng khi đang làm → `FAILED`; không nộp.
8. Gate fail → retry với `failKind` → pass.
9. Trận 40 phút với poll 15 s và ~15 item → log < 230 KB.
10. Ghi log thất bại tạm thời (file bị khoá) → hàng đợi → ghi đúng thứ tự.

## 6. Smoke test theo guide (trước khi giao pack)

| Mục guide | Case |
|---|---|
| login/cookies | §5.1, §5.6 |
| correct match identity | Unit `match-page`: lệch team/repo → blocker, không làm tiếp |
| empty/new backlog | Mock trả backlog rỗng → root chờ, không kết thúc lượt; đợt mới → `DISCOVERED` |
| Start Work/templates | Lưu vật liệu; template chép vào `answers/<ID>/submit.json` |
| submission receipts | `receiptId = submission.id` |
| timeout retries with the same UUID | §5.3, §5.4 |
| expired authentication | Cookie §5.6; bearer bị thu hồi → blocker `GAME_MASTER_AUTHENTICATION_REQUIRED` |
| append failures | §5.10 |
| pause/end | Mock `PAUSED` → không Start/Submit; `FINISHED` → `ORCHESTRATOR_ENDED` |
| resume | §5.4 |
| clean workspace + reinstall | [09 §6](09-dong-goi-va-van-hanh.md#6-build-và-phát-hành) bước 5 |

## 7. Spike cần làm sớm

Ghi kết quả ngay dưới mỗi spike (ngày, version, kết luận, bằng chứng), rồi cập nhật tài liệu liên quan.

| ID | Câu hỏi | Cách làm | Đạt khi | Tốn |
|---|---|---|---|---|
| **S1** | Codex (app-server do Player chạy) có nạp `.codex/config.toml`, `.codex/agents/`, `.codex/rules/` của TeamWorkspace đã trust không? | Đã thử với `codex exec` 0.163: thư mục chưa trust → bỏ qua config project; trust qua `-c projects…` → có nạp. Còn phải: chạy Practice Match với pack tối thiểu (helper chỉ có `ping`), xem tool `team_runtime` có trong transcript không | Root gọi được tool của helper | 1 Practice |
| **S2** | Đăng nhập và cấu trúc trang `/match/<matchId>` | Trình duyệt + DevTools, lưu HAR (đã xoá secret), chụp màn hình; điền [03 §2.4](03-game-master.md#24-kết-quả-spike-s2) | Parser lấy được `MatchView` từ fixture | 0 |
| **S3** | Tool MCP có bị đòi approval với `approvalPolicy: on-request` + `auto_review` không? | Practice: gọi tool đọc và tool ghi (`report_progress`), xem transcript/approval | Không có approval chặn; nếu có thì tìm cấu hình (annotation, config của MCP server) | cùng S1 |
| **S4** | Subagent: spawn được `agent_type` từ `.codex/agents/` không, có tham số `model` không, chạy song song tối đa bao nhiêu, root nhận kết quả thế nào, subagent có tiến trình helper riêng không | `tools/dev-root.mjs` với một skill thử spawn 2 worker | Biết chắc cú pháp spawn và cách chờ | ít |
| **S5** | `wait_for_update` 55 s có bị cắt bởi timeout tool mặc định không | Dev root gọi wait 55 s với `tool_timeout_sec = 120` và không đặt | Không bị cắt | ít |
| **S6** | execpolicy project có áp cho lệnh PowerShell của model không; `git -C … push` | Dev root yêu cầu chạy `git push` (repo tạm) | Bị chặn | ít |
| **S7** | Dạng thật của `submitTemplate`, MVS, `files`, evidence kỳ vọng | Start Work trong Practice (tay hoặc helper), lưu response | Có fixture thật cho mock và skill `evidence` | cùng S1 |
| **S8** | Credit tiêu hao mỗi trận | Dashboard Player (Model usage & nominal credit) sau mỗi Practice | Có số để lập ngân sách | — |
| **S9** | Git và HTTP trên mạng máy thi (proxy, GCM không hỏi) | `git ls-remote`, `node -e "fetch(...)"` tới Game Master | Không prompt, không lỗi TLS/proxy | 0 |
| **S10** | Khi tài khoản chạm hạn mức: lỗi gì, Player làm gì, resume ra sao | Đọc transcript khi xảy ra; không cố tình đốt tiền | Có quy trình đổi tài khoản và resume | — |
| **S11** | `TYPESAFE_API_KEY` tới được helper (`env_vars`) mà không lọt vào shell của model; Jev gọi được từ máy thi | Practice: helper gọi `decide`, rồi agent thử `echo $env:TYPESAFE_API_KEY` | Helper thấy key, shell của model thì không | ít |

### Kết quả spike

- **S2 (26/10, một phần):** có phần text của trang `/match/E1OOHQ5U` lúc chuẩn bị, xem
  [03 §2.4](03-game-master.md#24-kết-quả-spike-s2). Match UUID đọc được từ lúc chuẩn bị. Trang có thêm khối
  *Company Tools* (MCP server của trận, [03 §9](03-game-master.md#9-company-tools-mcp-server-của-trận)).
  Còn thiếu: HAR đăng nhập, nguồn dữ liệu của trang, field item và deadline khi backlog đã hiện.
- **S9 (26/10, một phần, máy dev):** `git ls-remote https://github.com/lqdung863/mtm-bun` chạy được, không
  hỏi gì (repo public). Chưa thử: push bằng tài khoản của đội, `fetch` tới Game Master từ Node. Máy dev
  **chưa có PostgreSQL** mà repo của trận đòi (16, cổng 5433); có Node 24.11.1, pnpm 11.5.2, Git 2.52, winget.

## 8. Quy trình Practice Match

**Trước**: ghi version Player, version pack, model và effort đã chọn; checker `READY`; xoá
`matches/<matchId>` cũ khi Init hỏi.

**Trong**: theo dõi dashboard round (Preparation, Backlog Status, Network & API, Model usage, Suspected
Violations) và `/spectator/<match-id>`. Không gửi Chat trừ khi đang thử nghiệm có chủ đích.

**Sau**: ghi vào `docs/team-pack/practice-log.md`:

| Chỉ số | Giá trị |
|---|---|
| Thời gian tới `ENVIRONMENT_READY` | |
| Item: hiện / bắt đầu / nộp / PASSED | |
| Điểm | |
| Thời gian trung bình theo loại item | |
| Credit (nominal) và token theo model | |
| Kích thước log; số dòng `IGNORED` | |
| Suspected Violations | |
| Số lần restart root | |
| Sự cố và việc cần sửa | |
| Gate / reviewer so với judge offline (false green, false red) | |

**Chấm lại offline** (mục 12, ý tưởng `judge-phase` + `quality_matrix` của harness mẫu): trong Claude Code chạy
`/judge-practice D:\mtm\BUN\matches\<matchId>` (skill `.claude/skills/judge-practice/`). Không tốn hạn mức Codex.
1. `node tools/judge/collect.mjs <checkout>` gom mỗi item đã Start Work vào `runs/judge/<matchId>/<ID>/`: đề, MVS,
   template, bài nộp, diff code (commit `<ID>:` trên checkout chính, hoặc worktree nếu chưa tích hợp), evidence,
   fix-result. Phán quyết gate / reviewer / grader để riêng ở `_verdicts/`.
2. Claude chấm từng item theo `tools/judge/rubric.md` (J1–J10, mức H/M, `pass`/`fail`/`unjudgeable`, mỗi `fail`
   có vị trí) **trước khi** đọc `_verdicts/`, ghi `judge.json`.
3. `node tools/judge/score.mjs runs/judge/<matchId>` so với gate và reviewer, ghi `report.md`: gate pass mà judge thấy
   lỗi H là false green, gate fail mà judge thấy đạt là false red. Mỗi false green là một luật gate/reviewer cần thêm.

Checkout của trận chỉ được đọc. Test: `tests/pack/judge.test.mjs`.

## 9. Kiểm thử hồi phục trên môi trường thật (giới hạn)

Chỉ làm trên Practice, mỗi loại một lần: operator **Stop** rồi **Resume** giữa trận; dừng Player rồi chạy
`restart`; tạm ngắt mạng 30 s. Xác nhận: không nộp trùng, không clone lại, log vẫn hợp lệ.
