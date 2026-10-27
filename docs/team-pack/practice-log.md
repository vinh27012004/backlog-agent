# Nhật ký Practice Match

## #1 · 26/10/2026 · tự luyện `E1OOHQ5U` (Solova, Next.js + Prisma + PostgreSQL)

- Player 0.9.33 (`0.9.33-local`), pack `team-sdlc-pack` 0.1.0 (BUN), Codex CLI 0.164.0 (đăng nhập ChatGPT).
- Game Master thật trong descriptor: `https://ai-fest-five.vercel.app`. Trang trận nói `masterthemachine.tech`.
- Thời gian: chuẩn bị 04:13–04:22Z, trận 04:22–05:22Z (60 phút). Không có PAUSED.
- Lưu trữ: `D:\mtm\archive\E1OOHQ5U-20261026-1229\` (progress log, `.team-work`, transcript Codex, git).

### Kết quả

| Item | Kết quả | Ghi chú |
|---|---|---|
| TASK-01 | SUBMITTED | Commit `df5e0d9` gồm cả code của mọi item khác (xem L3) |
| TASK-02 | SUBMITTED (agent tự ghi "partial") | Thiếu ảnh màn hình login/dashboard |
| CR-01 | SUBMITTED ("partial") | Thiếu kịch bản UI/download (không chụp được) |
| BUG-01 | SUBMITTED ("partial") | Thiếu ảnh viewport |
| BUG-02 | FAILED (hết deadline 18 phút) | Code + unit test xong, gate pass, không có evidence UI |

Progress log cuối trận: 44 KB (ngân sách 230 KB).

### Spike

- **S1 đạt**: Codex app-server nạp `.codex/config.toml` của TeamWorkspace đã trust; root gọi được tool `team_runtime`.
- **S2 đạt**: đăng nhập `POST /api/v1/auth/login` (JSON) **bắt buộc header `Origin`** cùng origin, thiếu thì 403
  "Origin check failed". Đọc trận bằng `GET /api/v1/match/<matchId>`. Chi tiết ở [03 §2.4](03-game-master.md#24-kết-quả-spike-s2).
- **S3 đạt**: tool MCP không bị đòi approval.
- **S4 một phần**: root có `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`; đã spawn 1 worker.
  Các thread `guardian` là reviewer `auto_review` của Player.
- **S7 đạt**: Start Work trả `submitTemplate` (có `status: "NOT_STARTED"`, `testResults[]`, `engineeringRecord`
  với `aiCollaboration`), MVS dạng **markdown**, `files` gồm script BTC phải chép vào chỗ chỉ định
  (`BUG-02-seed.ts` → `src/prisma/seed-bug02.ts`...), `submit.schema.json`. Evidence: ảnh PNG từ app đang chạy,
  báo cáo/test log do script BTC sinh. Test data lấy từ Company Tool.
- **S9 đạt** trên máy dev: git push qua GCM không hỏi.
- **Company Tools**: `get_test_data` (test data QA chính thức theo item) và `kb_search` (chuẩn tài chính và trao
  đổi dữ liệu của Solova). Agent có gọi (~24 lần nhắc trong transcript root).

### Lỗi và bài học (theo mức độ)

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L1 | **Không có cách chụp evidence**: root xin quyền computer use (điều khiển Edge thật của operator); bị Reject thì kết luận "no browser". `msedge.exe` không có trên PATH | BUG-02 hết hạn; 3 item nộp thiếu evidence | **Đã** thêm tool `capture_evidence` (Edge headless qua CDP, không dependency; click bằng chuột thật, báo `ELEMENT_OBSCURED` khi bị che, `force` để đi tiếp; đã thử trên Solova thật: đăng nhập → Accounting → Invoices → chụp). **Đã** tắt `computer_use`, `browser_use*`, `in_app_browser`, `apps`, `plugins` trong `config/codex.toml` |
| L2 | **Agent sửa test fail sẵn cho khớp code** (`cascade.test.ts`: đảo assertion "company có invoice thì không xoá được" thành "xoá cascade"), lấy lý do schema cascade và TASK-02 "cho sửa test sai" | Khả năng cao là sa bẫy (test bảo vệ lịch sử tài chính; sổ cái append-only) | **Đã** sửa (gate `tests-guard`, chạy lại trên commit thật `df5e0d9` thì bị chặn). Gate: sửa file test chứa test fail ở baseline hoặc bỏ assertion `rejects/toThrow/expect` thì `forbidden_change`, trừ khi root khai `allowTestChange` kèm lý do từ đề hoặc `kb_search`. Skill: test fail sẵn là tín hiệu bug, tra `kb_search` trước khi kết luận test sai |
| L3 | **Commit của item này cuốn công việc dở của item khác**: agent làm nhiều item song song trên cùng checkout, `commit_and_push` add cả thư mục trận | `gitRevision` của TASK-01 chứa code CR-01, TASK-02, BUG-01, BUG-02 và test bị sửa; gate TASK-02 `diff_too_large` | **Đã** sửa (tool `worktree`, E2E kiểm không rò rỉ). Mỗi item một worktree (05 §5.9), hoặc `commit_and_push` chỉ add `paths` của item; gate tính diff theo item |
| L4 | `record_verification` ghi **PASSED khi 0 kịch bản pass** (đếm `skipped` vào `executed`) | Dashboard báo PASSED sai sự thật | **Đã** sửa. PASSED chỉ khi mọi kịch bản bắt buộc đã chạy và pass; còn lại RUNNING hoặc FAILED |
| L5 | `doctor.ps1` mặc định ghi `env-require/environment-report.json` vào repo | Gate `forbidden_change` (đã xoá tay giữa trận) | **Đã** sửa: `-Output` ra `.team-work/logs` |
| L6 | Header `Origin` khi đăng nhập | PREPARE bị BLOCKED, phải Stop/Resume | **Đã** sửa và có test |
| L7 | `@prisma/client` postinstall chạy trước khi CLI được link (pnpm) nên không generate | Seed và build fail | **Đã** sửa: bước `prisma generate` |
| L8 | Kho pnpm nằm theo ổ đĩa; TeamWorkspace ở D: phải tải lại (mạng chậm, ~4 phút) | Chuẩn bị chậm | Checklist máy thi: làm nóng kho pnpm/npm/maven trên ổ của TeamWorkspace |
| L9 | Agent đếm test fail sẵn vào kịch bản fail | Số liệu sai | **Đã** thêm `baselineFailures` vào kết quả gate + dặn trong skill |
| L10 | Lượt GAME bị ngắt lúc 05:10Z (không PAUSED), Player tạo lượt RESUME_GAME | Mất vài phút đối chiếu | Chưa rõ nguyên nhân (operator hay Player); xem lại dashboard round |
| L12 | Player không chạy Codex CLI 0.164.0 trên PATH (cài qua npm, chỉ có shim `codex.cmd`/`.ps1`) mà chạy `codex.exe` của Codex Desktop (`%LOCALAPPDATA%\OpenAI\Codex\bin\…`, 0.164.0-alpha.11.1). Cả hai bản đều áp `[features]` của TeamWorkspace | Desktop tự cập nhật thì hành vi có thể đổi mà không ai biết | **Đã** thêm mục `codex features` vào checker (chọn exe như Player, hoặc `--codex <exe>`), checklist ngày thi ([09 §10](09-dong-goi-va-van-hanh.md#10-checklist-ngày-thi)) |
| L11 | Template có `status: "NOT_STARTED"`, gate chỉ chặn `DRAFT` | Có thể nộp sai trạng thái | **Đã** sửa (validator JSON Schema tự viết; 4 bài đã nộp khớp schema, template gốc thì không). Gate kiểm `submit.json` theo `submit.schema.json` của item và `status` khác giá trị ban đầu của template |

## #2 · 26/10/2026 · tự luyện `DXG0OC4L` (Solova, cùng bộ item với #1)

- Player 0.9.33, pack sau #1 (worktree, `capture_evidence`, tests-guard, Jev), `codex.exe` của Codex Desktop
  0.164.0-alpha.11.1, model `gpt-6-luna` effort medium cho root và mọi subagent (TASK-01: `gpt-5.6-luna`).
- Thời gian: PREPARE 08:32–08:34Z, GAME từ 08:34Z. **09:14:56Z tài khoản Codex hết hạn mức** (gói free, cửa sổ
  30 ngày: 48% lúc vào trận, 100% sau 42 phút). Từ đó mọi lượt lỗi `usage_limit_exceeded`; Player gửi lại khung
  RESUME khoảng 5 s một lần tới 09:24Z.

### Kết quả

| Item | Kết quả | Ghi chú |
|---|---|---|
| BUG-02 | SUBMITTED 08:49Z (PARTIAL) | Gate pass; TC-01/TC-03 FAIL (bấm nhầm làm VOID hoá đơn), TC-02 NOT_RUN |
| BUG-01 | SUBMITTED 08:51Z (PARTIAL) | 3/3 kịch bản PASS nhưng vẫn ghi `status: PARTIAL` |
| TASK-02 | SUBMITTED 09:09Z (DONE) | |
| CR-01 (300 điểm) | Không nộp | Gate pass, reviewer đòi thêm test signed-out và ảnh "before"; hết hạn mức khi đang sửa |
| TASK-01 | Không nộp | Fixer xong đáp án, gate vừa chạy thì hết hạn mức |

### Token (47,3M input, 97,5% cache; 154K output)

Tính lại được bằng `node tools/judge/usage.mjs D:\mtm\BUN\matches\DXG0OC4L` (27/10): khớp bảng dưới, ≈ 14,0 credit
không kể guardian (`codex-auto-review` không có trong price card); guardian của root ra 82 lượt review.

| Nhóm | Input | Ghi chú |
|---|---|---|
| Root | 19,3M (41%) | 220 lần gọi model, context tới 151K. 42 `wait_agent` 30 s, 12 `list_agents`, ~25 lần tự đọc thư mục evidence/answers của fixer, 23 tin nhắn cho fixer, tự đọc code CR-01 và lần git TASK-01. Không dùng `wait_for_update` |
| Fixer | 19,4M (41%) | Chủ yếu là evidence: BUG-02 27 lần `capture_evidence` từng bước, CR-01 ~40 lần sửa script Playwright tự viết (tải CSV) |
| Guardian (`auto_review`) | 8,0M (17%) | 88 lượt review cho tool MCP của root (`job_status` 16, `worktree` 14, `decide` 7…), 25 cho `capture_evidence`. Tool có `readOnlyHint` không bị review |
| Reviewer | 0,6M (1%) | |

### Lỗi và bài học

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L13 | Tài khoản Codex gói free hết hạn mức giữa trận | Mất CR-01 và TASK-01 | Luyện tập cần tài khoản có đủ hạn mức; hỏi BTC hạn mức ngày thi tính theo tài khoản nào |
| L14 | Root polling: `wait_agent` 30 s, `list_agents`, tự đọc file của fixer, chỉ đạo fixer, tự kiểm lại code | 41% token | **Đã** sửa skill root: mục Root budget; `wait_agent` 180 s rồi `wait_for_update` 1 s; chờ job trong một `exec` (pragma `yield_time_ms`, `job_status` tới 110 s) |
| L15 | Tool chỉ đọc không có `readOnlyHint` nên lần nào cũng qua guardian | 17% token | **Đã** gắn `readOnly` cho `match_state`, `read_item`, `wait_for_update`, `job_status`, `decide` (test kiểm đúng tập này). Còn `capture_evidence` và `worktree status` vẫn qua review. Cấu hình `default_tools_approval_mode = "approve"` (Codex nhận `auto|prompt|writes|approve`) bỏ được hết nhưng là vượt reviewer của Player: chờ BTC trả lời |
| L16 | Evidence tốn nhiều nhất của fixer | CR-01 kéo 22 phút | **Đã** thêm ngân sách evidence vào skill root và luật chung của fixer: một `capture_evidence` mỗi kịch bản, tối đa 2 lần thử lại rồi `NOT_RUN`, tối đa một phần ba thời gian item; script riêng chỉ khi tool không làm được, đặt ở `.team-work/scratch/<ID>/`. Fixer không gửi tin nhắn tiến độ |
| L17 | Jev `claims_supported` trả "không" ~0,9 cho cả item đã pass gate và được approve (gửi cả fix-result, Jev thấy ảnh chụp/MVS không có trong gate) | 7 lượt root vô ích, root bỏ qua kết quả | **Đã** sửa: chỉ gửi kết quả build/typecheck/test (`gateComparableClaims`) + `tests_added` + check gate kèm `counts`; không có gì để so thì luật code, không gọi Jev. Skill: gọi một lần mỗi gate job. **27/10: bỏ hẳn** `claims_supported` (gate tự chạy build/typecheck/`tests_added`/regression nên kết quả gate là đáp án) |
| L18 | Item không có giới hạn thời gian mỗi lượt fixer, không có bước bỏ item rõ ràng | Item khó chạy tới deadline | **Một phần** (27/10): gate trả `signature` + `repeat`; cùng lỗi lần 3 thì `hint` bảo bỏ item và `decide next_action` không còn `retry`; skill root có bước 9 bỏ item (`BACKLOG_STATUS FAILED`, helper ghi `endedAt`). Giới hạn thời gian mỗi lượt fixer vẫn chưa có |
| L19 | BUG-01 nộp `status: PARTIAL` dù 3/3 kịch bản PASS | Có thể mất điểm | **Đã** sửa (27/10): check `answer` cảnh báo khi mọi kịch bản PASS mà `PARTIAL`, chặn `DONE` khi có kịch bản không PASS và chặn `PASS` thiếu evidence mà MVS ghi; `record_verification` đếm từ `testResults` |
| L20 | Jev: `difficulty` lần nào cũng dưới ngưỡng 0,7; `injection` TASK-01 = true ở 0,55 (ngưỡng 0,5), nhiều khả năng báo nhầm | Phần lớn triage rơi về luật code | **Một phần** (27/10): `decisions.ndjson` ghi thêm `rule` và câu trả lời thô `jev` (cả khi dưới ngưỡng) để chỉnh ngưỡng hoặc tắt điểm này sau trận tập tới; câu hỏi và ngưỡng chưa đổi |
| L21 | Reviewer xếp `high` cho việc đòi thêm test signed-out và ảnh "before" ở CR-01 (300 điểm), ngoài MVS | Thêm một lượt fixer, hết hạn mức trước khi nộp | **Đã** sửa (27/10): reviewer chấm theo checklist R1–R9; `high` chỉ khi phá một kịch bản MVS/tiêu chí cụ thể hoặc vi phạm R2/R6/R7/R8, đòi thêm test/evidence ngoài MVS tối đa `medium`; mọi issue phải có vị trí |
| L22 | BUG-02: bấm nhầm làm VOID hoá đơn, TC-01/TC-03 chạy tiếp trên dữ liệu đã hỏng; các worktree còn dùng chung một database dev nên seed của item này (CR-01 xoá mọi hoá đơn) phá được evidence của item khác | BUG-02 nộp PARTIAL | **Đã** sửa (27/10): tool `app_data` (khoá database dùng chung); luật: seed rồi chạy kịch bản dữ liệu theo thứ tự MVS trong một lượt, hỏng thì seed lại và làm lại từ đầu, không đi tiếp trên dữ liệu hỏng. Gate thêm `code-scan` (cảnh báo TODO, debug, SQL ghép chuỗi, secret, file rác như `*.cr01-backup` của CR-01) |

## #3 · 27/10/2026 · tự luyện `8TUM8N5W` (không chạy được)

Player 0.9.33 tạo round01 và round02 nhưng lần nào poll `matchStatus` cũng báo
`MATCH_STATUS_POLL_FAILED: MATCH_STATUS_AUTH_REJECTED` (server trả 401/403 cho key Game Master gắn sẵn trong
Player). Không biết trạng thái match nên Player không dispatch Codex: không có transcript, thư mục match trống,
dashboard đứng ở "Waiting for data"; Resume báo `MATCH_STATUS_UNAVAILABLE`. Pack không liên quan. BTC phát hành
0.9.35, ký `matchStatus` bằng Team API Key ([02 §12](02-hop-dong-player.md#12-khi-player-ra-bản-mới)).
Chẩn đoán lần sau: đọc `%LOCALAPPDATA%\MTM Player\applications\<id>\diagnostics.ndjson` (chỉ để debug sau trận,
không phải việc của đội trong trận).
