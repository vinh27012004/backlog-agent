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
| L18 | Item không có giới hạn thời gian mỗi lượt fixer, không có bước bỏ item rõ ràng | Item khó chạy tới deadline | **Một phần** (27/10): gate trả `signature` + `repeat`; cùng lỗi lần 3 thì `hint` bảo bỏ item và `decide next_action` không còn `retry`; skill root có bước 9 bỏ item (`BACKLOG_STATUS FAILED`, helper ghi `endedAt`). Giới hạn thời gian mỗi lượt fixer: xem L24 |
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

## #4 · 27/10/2026 · tự luyện `CV8WV1JM` (Player 0.9.35, dừng tay sau khi BUG-02 đóng)

`allowedModels` = `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna`; root `gpt-6-luna` medium. 15,4M input (fixer 64%,
root 21%, guardian 15%), ≈ 47,8 credit. Hạn mức Codex gói free hết lúc 06:25:22Z, sau đó 252 lượt lỗi và Player
restart hơn 240 lần.

| Item | Kết quả | Ghi chú |
|---|---|---|
| BUG-02 (150 điểm, deadline 18 phút) | CLOSED, không nộp | Fixer `gpt-5.6-terra` high sửa đúng trong 2 phút (test hồi quy fail trước/pass sau; report: VND 12345 minor, USD 12345 minor). 9 phút sau đó cho evidence: build 2 lần, `EADDRINUSE`, `capture_evidence` `ELEMENT_NOT_FOUND`/`ELEMENT_OBSCURED`, TC-02 (Payments, Select của Radix) 2 lần không xong. Chết vì hết hạn mức lúc đang ghi `submit.json`; gate chưa chạy |
| BUG-01 | Chưa nộp | Lần 1 `gpt-6-luna` medium: gate regression (test cascade hoá đơn); lần 2 `gpt-5.6-terra` high bị cắt vì hết hạn mức |

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L23 | Root spawn fixer với `fork_turns: "all"` (skill không nói gì) | Mỗi fixer bắt đầu ở ~56–60K token và đọc lại ở mọi lượt; BUG-02 51 lượt, 4,9M input | **Đã** sửa skill root: luôn `fork_turns: "none"`, brief chứa đủ; `next` của `start_work` nhắc lại |
| L24 | Fixer không biết giờ phải trả kết quả; root không canh deadline trong lúc chờ | BUG-02 sửa xong ở phút 3 nhưng không nộp được | **Đã** sửa (L18 xong phần giới hạn mỗi lượt fixer): `start_work` trả `timeBox.returnBy` (đóng − 5 phút), `match_state` lặp lại theo item; brief có `return_by`; fixer xem giờ trước mỗi kịch bản, quá hạn thì `NOT_RUN` "time box" rồi trả kết quả; root chờ tới `return_by` + 1 phút thì `send_message` bảo dừng, thêm 2 phút thì `interrupt_agent` và chạy gate trên worktree |
| L25 | Hết hạn mức Codex (lần 2, sau L13) | Dừng cả trận | Chưa sửa: cần tài khoản có hạn mức. L23 giảm token fixer |
| L26 | `capture_evidence` không bấm được Select của Radix ở màn Payments | TC-02 BUG-02 không có evidence | Chưa sửa: thêm hướng dẫn chọn option (`press`/`select`, mở trigger rồi click `role=option`) vào stack notes hoặc skill |


## #5 · 27/10/2026 · tự luyện `BC3JL6ZC` (Player 0.9.35, cùng bộ item)

| Item | Điểm | Ghi chú |
|---|---|---|
| BUG-01 | 200/200 | 3 lần fixer |
| BUG-02 (deadline 18 phút) | 30/150 | Sửa code đúng, gate xanh, nộp `PARTIAL`: TC-01..03 `NOT_RUN` vì không chụp được ảnh, chỉ TC-04 (`pnpm test`) được điểm |
| CR-01 | 300/300 | |
| TASK-02 | 250/250 | |
| TASK-01 | 100/100 | |

Tổng 880/1000. Fixer BUG-02 (`gpt-5.6-terra`) sửa xong khoảng 07:33Z, rồi tốn 5 phút cho 6 lần gọi `capture_evidence`
mà không lần nào xong, sau đó trả kết quả theo time box. Transcript: `~/.codex/sessions/2026/10/27/rollout-…-01a17c42-7050-…`.

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L27 | Fixer viết selector Playwright (`[role=tab]:has-text('Invoices')`, `button:has-text('New invoice') >> nth=0`); `querySelectorAll` ném lỗi, tool nuốt lỗi và chờ hết giờ | 2 lần gọi báo `ELEMENT_NOT_FOUND`, fixer không biết vì sao | **Đã** sửa: chặn trước khi mở trình duyệt bằng `INVALID_SELECTOR` kèm cách viết đúng; CSS sai báo ngay; `selector` + `text` dùng chung được (`{selector:"[role=tab]", text:"Invoices"}`), `index` chọn phần tử thứ n |
| L28 | `browserProfile` không giữ đăng nhập: Edge bị `taskkill /F` trước khi ghi cookie ra profile | Lần gọi bỏ bước login bị đẩy về `/login`, báo không thấy "Invoices" | **Đã** sửa: `Browser.close` qua CDP, chờ tiến trình thoát rồi mới kill. Test `browserProfile keeps the login cookie` |
| L29 | Sidebar của BUG-01 (lỗi có sẵn trong base) che tab Accounting ở worktree BUG-02; `force:true` bấm bằng sự kiện JS | `ELEMENT_OBSCURED` rồi `#invCompany` không thấy: dialog không mở | **Đã** sửa: `force` cho lớp che tạm `pointer-events:none` rồi bấm bằng chuột thật (CDP), trả style sau đó; chỉ khi không gỡ được mới dùng sự kiện JS. Skill root ghi rõ item khác cần `force` |
| L30 | Lỗi một bước chỉ trả mã lỗi, không cho biết trang đang ở đâu | Fixer đoán selector mù qua 6 lần gọi | **Đã** sửa: `error.details` có `failedStep`, `url`, `visibleText`, `candidates` (phần tử bấm được: tag, id, role, aria-label, text) và `stepsDone` |
| L31 | Agent chỉ mở skill được chỉ đích danh. Fixer nào cũng đọc `backlog-<type>` + `stack-notes/node.md` (brief ghi tên), nhưng fixer BUG-01 bỏ `bug-patterns.md`, không ai đọc `retry-playbook.md`, 4 reviewer không đọc skill nào; prompt `team_pi_hypothesis` không trỏ tới `pi-triage.md` | Retry và review chạy thiếu hướng dẫn mà runtime cũ chèn sẵn vào prompt | **Đã** sửa trong `tools/sync-agents.mjs` (`reads` theo vai): fixer đọc thêm `bug-patterns` (BUG) / `pi-triage` (PI) và `retry-playbook` khi có `<previous_attempt>`; reviewer đọc skill trong brief; pi-hypothesis đọc `pi-triage`. Brief của reviewer/pi-hypothesis có dòng `Skill:`/`Stack notes:`. Test trong `install.test.mjs` |
| L32 | `retry-playbook.md` nói worktree đã reset, thay đổi lần trước mất; pack không reset worktree | Fixer lần sau có thể làm lại từ đầu thay vì sửa tiếp | **Đã** sửa: bản trong pack nói worktree còn thay đổi của lần trước (`git diff HEAD`) |
| L33 | Root retry bằng `send_message` vào luồng fixer cũ (5 `spawn_agent` fixer cho 5 item, mọi lần thử lại đều là message) | Thang model `fixer[n]` không có tác dụng: BUG-01 cả 3 lần chạy `gpt-6-luna` medium | **Đã** sửa: skill root bắt buộc mỗi lần thử là một `spawn_agent` mới (`<id>_fix<n>`, `fixer[n-1]`), `send_message` chỉ để bảo dừng; `run_gate` fail trả `next` nhắc đúng việc đó |

L26 (Select của Radix) giờ là click trigger rồi click `{selector:"[role=option]", text}` bằng chuột thật; ghi trong skill
root. Chưa kiểm trên app Solova thật: cần chạy lại BUG-02 ở trận sau.

Token (`tools/judge/usage.mjs`, 27/10): 42,5M input (96,7% cache), 176K output. Fixer 20,1M (47%; riêng BUG-01 9,5M),
root 13,9M (33%), guardian 7,4M (17%; `capture_evidence` 44 lượt), reviewer 1,1M. Item đến theo đợt: BUG-01/02 lúc
07:26Z, CR-01/TASK-02 lúc 07:40Z, TASK-01 lúc 08:00Z; nộp xong cả 5 lúc 08:12Z.

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L34 | Test DB của worktree trùng tên giữa các trận (`freelanceos_test_bug01`…). `global-setup.ts` chỉ tạo DB khi chưa có, `migrate deploy` báo "No pending migrations" nên schema cũ (FK CASCADE từ trận trước) còn nguyên. Rất có thể đây cũng là nguyên nhân regression BUG-01 lần 1 ở trận #4 | Gate báo regression sai ở BUG-01 và TASK-01 (`deleting a company with invoices is RESTRICTED`); BUG-01 mất ~8 phút, TASK-01 ~4 phút; fixer sửa constraint DB bằng tay | **Đã** sửa: `TEST_DATABASE_URL` có hậu tố trận ở checkout chính (`_<matchid>`) và trận + item ở worktree/probe (`_<matchid>_<item>`). Luật fixer và skill root: test không liên quan fail dù baseline pass thì nghi môi trường, không sửa schema/constraint bằng tay |
| L35 | Root không lần nào dùng pragma `yield_time_ms` (0/71 `exec`): `exec` dừng ở 30 s trong khi gate chờ 45 s, nên root gọi `wait` 1 s ×3 rồi 10 s | 46 lượt `wait` = 4,4M, khoảng 1/3 token của root | **Đã** sửa skill: pragma bắt buộc cho mọi `exec` có chờ, `wait` không dưới 60 s; lúc không còn việc thì chờ trong một `exec` duy nhất (vòng `wait_for_update` tới 9 phút) |
| L36 | Skill root vừa bắt mỗi lần thử phải là một spawn mới, vừa cho `followup_task` khi "gate/reviewer result needs rework"; root gọi `followup_task` 9 lần | 3 lần thử của BUG-01 dồn vào một thread, context lên 146K | **Đã** sửa: Root budget chỉ cho `send_message` để báo dừng; làm lại luôn là spawn mới |
| L37 | Gate `answer_invalid` (TASK-02: dấu câu dính vào đường dẫn evidence) khiến root chạy lại cả gate dù build/test đã pass | Thêm ~1 phút và một lượt root | **Đã** sửa: `next` báo không cần chạy lại gate; `record_verification` kiểm lại answer khi gate chỉ hỏng answer; `answer_invalid` và gate main không còn đẩy thang model `fixer[n]` |
| L38 | Sidebar lỗi của BUG-01 che màn hình ở mọi worktree; CR-01 chờ BUG-01 nộp rồi chép tay `layout.tsx`/`topbar.tsx` từ main vào worktree | BUG-02 không có evidence UI; CR-01 25 phút, có rủi ro trộn code của item khác | **Đã** thêm `worktree sync` (đưa worktree chưa commit lên HEAD của main, giữ việc dở; xung đột thì trả về nguyên trạng; dependency đổi thì cài lại). Skill: item sửa giao diện dùng chung được ưu tiên ngay sau item có deadline, publish sớm, rồi sync các worktree khác |
| L39 | Jev `injection` = true cho BUG-02 ở 0,52 (ngưỡng 0,5), lần thứ hai báo nhầm sau L20; severity/difficulty 0/5 lần đủ ngưỡng; chỉ `model` có ích (TASK-02 `strong` 0,98 trong khi luật chọn `small`, và Jev đúng) | Fixer nhận lệnh bỏ qua phần giống chỉ dẫn trong một đề bình thường | **Đã** nâng ngưỡng `injection` lên 0,7 (regex vẫn là lưới an toàn) |

## #6 · 28/10/2026 · tự luyện `HIET12OA` (Player 0.9.35, cùng bộ item)

Fixer chạy song song đúng thiết kế (BUG-01 + BUG-02 từ 19:14Z; CR-01, TASK-02 và BUG-01 lần 2 cùng lúc từ 19:29Z;
TASK-01 vào ô trống lúc 19:42Z). Chỗ chậm là root: gate → review → integrate → gate main → push → submit đều chạy qua
root, mỗi lần một item, nên kết quả của fixer xong trước phải chờ (reviewer CR-01 xong 19:49Z, root integrate lúc 19:52Z;
`task01_fix2` xong 19:50Z, chạy gate lúc 19:53Z). Root 13,0M token, khoảng 6M trong đó là chờ hoặc gỡ lỗi khoá file.

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L40 | `worktree sync` CR-01 dùng `stash -u`: hỏng giữa chừng vì app của fixer giữ `app.log`/`app-error.log` ở gốc worktree; root tự khôi phục stash (`restore --source=stash^3` xoá luôn `.gitignore`), lần sau hỏng vì `Filename too long` trong `node_modules` | Root 17 lượt, 1,8M token, 3 phút; fixer CR-01 bị bảo dừng, poll `wait_agent` 10 s ×5 + `sleep` (0,5M) | **Đã** sửa: sync không stash, file đã track đi qua `git diff --binary HEAD` rồi `apply --3way` lên HEAD main; file chưa track giữ nguyên, trùng với file main vừa thêm thì `WORKTREE_CONFLICT` trước khi đụng vào; hỏng giữa chừng thì tự trả về base cũ. `create` bật `core.longpaths` trên Windows. Skill: log app ra `.team-work/logs/<ID>-app.log`, không sync khi fixer đang chạy |
| L41 | `worktree remove` TASK-02 trả `{removed:true}` nhưng thư mục còn (`codegraph.db` bị server codegraph giữ); `commit_and_push` thấy thư mục nên chặn sửa `answers/TASK-02/submit.json` trên main (`WORKTREE_CONFLICT`) | Root 13 lượt, 1,8M token, 3 phút; root kill server codegraph của cả đội để chuyển thư mục đi | **Đã** sửa: worktree "còn" là có file `.git` (`liveWorktree`); `remove` xoá `.git`, `worktree prune`, phần sót do khoá trả `leftover` và để lại. `commit_and_push` cho sửa `answers/<ID>/` của chính item trên main khi worktree còn |
| L42 | Root `wait_agent` 60 s thay vì 180 s như skill, và nói một câu sau mỗi lần chờ; root tự đọc `tools.mjs` của helper, chạy git tay, kill tiến trình | 11 lượt hết giờ rỗng (~2M token) | **Đã** sửa skill: 180 s, im lặng giữa các lần chờ; lỗi tool helper thì làm theo `code`/`hint`, không gỡ tay, không kill, ghi `report_progress` rồi làm item khác |

## #7 · 29/10/2026 · tự luyện `ZVUYZ41V` (Player 0.9.39, cùng bộ item)

Cả 5 item nộp trong 55 phút (02:18Z → 03:13Z), 30,3 credit theo price card (fixer 25,4, trong đó 17,8 là các lượt
6.1-sol thứ 2–3). Lúc đông nhất chỉ có 2 item chạy. BUG-01 được 0/200: BTC chấm 0 cả item vì thiếu một file evidence.

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L43 | Mô tả BUG-01 (mục Submission, không phải MVS) đòi "Capture screenshot of Dashboard before fixing as dashboard_before_fixing.png"; gate chỉ đọc "Required evidence" của MVS nên fixer, gate, verifier và reviewer đều cho qua. HIET12OA cũng có câu này | BUG-01 0/200 dù 3/3 kịch bản PASS | **Đã** sửa: `itemEvidence` (gate) lấy tên file từ câu nói tới screenshot/capture/evidence của mô tả, bỏ đường dẫn, file submit, file đề; `start_work` trả `requiredEvidence` (`beforeFix`), brief `<required_evidence>`; thiếu file thì gate fail `evidence_missing` (lượt fixer, không có luật cơ hội cuối), `commit_and_push` cũng chặn. Fixer chụp ảnh `beforeFix` trước khi sửa code; lần sau thì dùng patch + `git apply -R` (không dùng `stash`, vì stash dùng chung giữa các worktree). Chạy lại trên answer thật của trận: chỉ BUG-01 fail |
| L44 | Lần 1 luôn chạy 6-luna, cả item tier `strong` (`small_high`) | TASK-02: luna 15,6 phút fail gate, sol 3,8 phút; BUG-02: luna 7,1 phút, sol 2 phút; CR-01 luna 14 phút | **Đã** sửa: item tier `strong` chạy tier `strong` (6.1-sol) ngay lần 1; bỏ tier `small_high`. BTC xếp theo điểm, rồi thời gian, rồi credit |
| L45 | TASK-01 ra lúc 02:49:49 (đợt 3) khi chỉ 2 item chạy; root lặp `wait_agent`/`spawn_agent` mà không gọi `wait_for_update`, chỉ thấy item lúc 03:02 | Item bắt đầu trễ 12 phút | **Đã** sửa: mọi kết quả tool của root mang `notice {newItems, freeSlots}` khi có item chưa bắt đầu mà còn chỗ; giới hạn nâng từ 3 lên 4 item (`MAX_ITEMS_IN_FLIGHT`), PI vẫn không tính |
| L46 | Fixer BUG-02 sửa test fail sẵn bằng cách viết lại nó (`… is RESTRICTED` thành `… cascades invoices as specified by the financial migration`, `test_change` trỏ tới migration). `fixesBaseline` (`gate.mjs`) bỏ qua test đã đổi tên (`!gone.includes(t)`) nên `integrate` không trả `baselineFixed`/`syncWorktrees` | `baselineFixed` không bao giờ được ghi: `start_work` CR-01 (02:38, base đã có bản sửa) vẫn nhận `youFix: true`, TASK-01 (03:02) vẫn thấy test là đang fail. Lần này không mất điểm (CR-01 không đụng tới test) | **Đã** sửa: test fail sẵn không còn chạy được tính là đã sửa khi gate có `allowTestChange` hợp lệ, hoặc khi item trước đã được chấp nhận bỏ nó (`acceptedRemovals`, gate main). Test trong `gate-runs.test.mjs` |
| L47 | `exec` publish của root gọi `run_gate where:main` mà không có `allowTestChange`; tests-guard của gate main fail vì BUG-02 sửa test fail sẵn, dù gate worktree đã chấp nhận lý do | Publish dừng ở `stoppedAt: "mainGate"`; root tự chạy lại `run_gate` main với `allowTestChange` (thêm 62 s, đúng item có deadline 18 phút), rồi làm tiếp từ `commit_and_push` | **Đã** sửa: gate worktree pass có `testChangeJustification` thì ghi vào `journal.items[ID].testChange`; gate main của item đó dùng lại khi người gọi không đưa `allowTestChange` (`gateTestChange`). Test trong `baseline.test.mjs` |
| L48 | `spawn_agent bug02_review1` lúc 02:29:29 bị từ chối: `collab spawn failed: agent thread limit reached`. Lúc đó có 3 subagent đang chạy (bug01_verify1, bug01_review1, bug02_verify1) | Root bỏ luôn reviewer của BUG-02, không thử lại. Với giới hạn này, 4 item cùng lúc (L45) không đủ chỗ cho verifier và reviewer | **Đã** sửa: Player không đặt giới hạn này (không có trong `vendor/mtm-player-0.9.39`); khoá của Codex là `[agents] max_concurrent_threads_per_session` (tên cũ `max_threads`, Codex 0.165 kiểm `>= 1`, khoá lạ làm hỏng cả config). `pack/config/codex.toml` đặt 8. Skill root: gặp lỗi này thì `wait_agent` rồi spawn lại, không bỏ verifier/reviewer. Chưa biết Codex mặc định là bao nhiêu (trận #7 cho thấy 3 subagent) |

### Đối chiếu checklist (29/10)

Nguồn: transcript `~/.codex/sessions/2026/10/29/` (root `…fd7130db628b`), `.team-work/journal.json`, `decisions.ndjson`,
`runs/judge/ZVUYZ41V/_usage/usage.md`. Chưa chấm lại bằng `/judge-practice` (chưa có `judge.json`) và chưa có điểm BTC
ngoài BUG-01.

- **Cài đặt, Player**: root chạy `gpt-6-luna` medium; pack mới đã cài (`proxy.mjs`, `liveWorktree`/`proxyCall`,
  `team-verifier.toml`); Player nhận `team_verifier` (spawn 8 lần, không lỗi).
- **Worktree (L40, L41)**: không lần nào `worktree sync` (L46 làm `syncWorktrees` không xuất hiện), nên phần sync chưa
  kiểm được. `remove` trả `removed: true` cộng `leftover` ở 4/5 item, root không kill tiến trình nào, `git worktree list`
  chỉ còn main và `_probe`. Không có `Filename too long`, `GIT_FAILED`.
- **Root chờ (L42)**: 28 `wait_agent`, đều 180000 trừ một lần 120000 (BUG-02 sát deadline); 5 lần hết giờ. Một câu nói
  giữa hai lần chờ (02:51:01). Root không đọc `runtime\src`, không `git -C`, không `Stop-Process`/`taskkill`. Không fixer
  nào gọi `wait_agent`; log app nằm ở `.team-work/logs/<ID>-app*.log`. Root 7,0M input / 110 lượt (HIET12OA 13,0M / 134).
- **Test fail ở baseline**: `start_work` BUG-02 trả `baselineFailures` với `youFix: true`; fixer ghi `test_change`
  (nguồn: migration), gate worktree cho qua (tests-guard `warn`). `baselineFixed` không có (L46), publish vướng gate main
  (L47). CR-01, TASK-02 nộp `DONE`; BUG-01 nộp `DONE` trước khi có bản sửa.
- **Evidence**: `browserProfile` giữ đăng nhập (L28 đạt): BUG-02 lần 1 gọi 3–6 và CR-01 gọi 3–5 không login lại mà vẫn
  vào `/accounting`. Mọi fixer có chụp ảnh đều đọc `evidence-playbook`. Số lần gọi: BUG-02 6 cho 4 kịch bản, BUG-01 6/3,
  CR-01 7/5, TASK-02 6/5 + 3; thời gian chụp 12–24% lượt fixer. Lỗi lặp: `screenshot path must be absolute` (BUG-02, CR-01),
  `[role=option]` không thấy 2 lần nên BUG-02 TC-03 (USD) phải sang lượt 2, profile mới chưa đăng nhập (BUG-02 lần 2)
  bị đẩy về `/login`, TASK-02 lần 1 chụp 3 lần khi app chưa chạy (`chrome-error`). Brief của root mã hoá trong
  transcript nên không kiểm được việc root bỏ mẹo evidence.
- **Verifier (proxy)**: `configure_session` trả `proxy: {ready: true}`, có `runtime-endpoint.json`. Mỗi verifier gọi
  `run_gate {fixResultFile}` nhận `jobId`, vòng `job_status` nằm trong một `exec` (5/8 có pragma, 3 lần còn lại dùng
  `wait`). Root chỉ chạy `run_gate` một lần, `where: main` (L47). Verifier và reviewer spawn liền nhau trong một lượt.
  Publish là một `exec`; khi `stoppedAt` root làm tiếp đúng bước. BUG-01 `answer_invalid` + `codePassed`: verifier sửa
  `status` trong `submit.json`, `answer_fixed: true`, không chạy lại gate. Lớn nhất 3 subagent cùng lúc, một lần chạm
  giới hạn (L48). Verifier 115–188K input mỗi lượt, tổng 0,70 credit.
- **Model và credit**: lượt 1 `gpt-6-luna` medium (BUG-01, TASK-01) và high (BUG-02, CR-01, TASK-02); lượt 2–3
  `gpt-6.1-sol` high; không gọi `gpt-6-astra`. Reviewer luna high, verifier luna medium. Xong ngay lượt 1: BUG-01, CR-01;
  lên lượt 2+: BUG-02 (evidence), TASK-02 (gate `forbidden_change`), TASK-01 (3 lượt, nộp `PARTIAL` vì commit
  `571c531` không có trong repo). Tổng 30,29 credit (HIET12OA 127,29): root 2,57, fixer 25,41, reviewer 1,60, verifier
  0,70. Hạn mức gói Plus 0% → 17%. Reviewer luna cũng bỏ sót câu "dashboard_before_fixing.png" (L43), như reviewer
  6.1-sol ở HIET12OA.
- **Jev**: mọi item có `signals`; `code` chỉ khác `null` ở CR-01 (`terms: ["New invoice"]`, không có mã TC). `difficulty`
  vẫn 0/5 lần lấy theo Jev (độ tin 0,27–0,48, ngưỡng 0,7); luật cho `hard` ở CR-01, `medium` ở 4 item còn lại. Jev có
  ích ở `model` (BUG-02, CR-01, TASK-02 `strong`) và `severity` TASK-02. `start_work` mất 3,2 s (TASK-01) đến 12,2 s
  (BUG-01, Jev 3,8 s); chưa tách được phần `git grep`.

| Item | difficulty luật / Jev (độ tin) | modelTier | Lượt fixer | Kết quả |
|---|---|---|---|---|
| BUG-02 | medium / medium (0,34) | strong (Jev 0,80) | 2: luna high, sol | Nộp; TC-03 cần lượt 2 vì evidence |
| BUG-01 | medium / medium (0,27) | small (luật; Jev strong 0,02) | 1: luna medium | Nộp, 0/200 (L43) |
| CR-01 | hard / hard (0,27) | strong (Jev 0,80) | 1: luna high, 14 phút | Nộp `DONE` |
| TASK-02 | medium / hard (0,35) | strong (Jev 0,96) | 2: luna high, sol | Nộp `DONE` |
| TASK-01 | medium / medium (0,48) | small (luật) | 3: luna medium, sol, sol | Nộp `PARTIAL` |

## #8 · 29/10/2026 · tự luyện `TOKXKPBV` (Player 0.9.39, cùng bộ item)

Cả 5 item nộp, item cuối lúc 04:57:37Z, tức phút 44 kể từ START_GAME (04:13:24Z). Đề ra ở phút 0, 14 và 29 (README),
mỗi đợt 2 item (đợt 3 chỉ có TASK-01), nên lúc nào cũng chỉ có 2 item chạy và `MAX_ITEMS_IN_FLIGHT = 4` chưa lần nào
được dùng tới; trận không thể xong dưới 30 phút vì item cuối ra ở phút 29. README ghi "Duration: 40 minutes" nhưng
server báo 60 phút: với 40 phút thì TASK-01 đã trễ. ≈176,81 credit theo price card (ZVUYZ41V 30,29): root 56,35
(`gpt-6-sol` medium), fixer 81,73, reviewer 22,64, verifier 16,08; guardian (`codex-auto-review`, ngoài price card) 6,1M
input, 20% tổng input. `models.json` lúc đó đặt `gpt-6-sol` đầu tier `small` và `review`. Hạn mức gói Plus 23% → 98%.
Nguồn: `runs/judge/TOKXKPBV/_usage/usage.md`, transcript root `…791f0581b9ca`, `.team-work/journal.json`, `results/`.
Chưa chấm lại bằng `/judge-practice` và chưa có điểm BTC.

| # | Lỗi | Hệ quả | Sửa |
|---|---|---|---|
| L49 | Fixer BUG-01 lần 1 (11m07s, 77 lượt, 4,1M input) tự chạy `pnpm dev` 4 lần, tìm và `taskkill` tiến trình theo port, rồi gỡ một dev server trả CSS thiếu class mới (`md:ms-60`) trước khi build bản production. Đã thử: scanner Tailwind 4.3.2 vẫn thấy class mới trong worktree nằm dưới `.team-work/` (bị exclude), nên lỗi là dev server, không phải gitignore | Khoảng 6 phút của item 17 phút | **Đã** sửa (`f26c8c4`): tool `app` của helper build bản production rồi start tách rời trên port riêng 3100+, log ở `.team-work/logs/<ID>-app.log`, chờ tới khi trả lời HTTP; `worktree remove` dừng app. Playbook §1 cấm tự chạy `pnpm dev`/`next start`/`taskkill`. Chạy thật trên app TOKXKPBV: sẵn sàng sau 33 s |
| L50 | Fixer CR-01 lần 1 trả `partial`, 5 kịch bản `NOT_RUN`, để chờ bản sửa sidebar của BUG-01 vào main rồi mới chụp ảnh, dù playbook đã ghi "never pause to wait for a sync" | Lần 2 (3m20s) chỉ để chụp ảnh sau khi sync; CR-01 mất 17 phút | **Đã** sửa (`a10f71c`): `fixer.md` và playbook §4: chờ bản sửa của item khác không bao giờ là lý do trả `partial` hay `NOT_RUN`; chụp ngay, click xuyên qua bằng `force: true`, ghi chú trong kịch bản |
| L51 | TASK-01 (cờ `data`, `tricky`, `answerOnly`) chạy tier `small` (`gpt-6-sol` medium). Verifier `publish` với 98304; reviewer `high` cho rằng rebalance đưa C về 131072 | Root chạy cả vòng mới (fixer `gpt-6.1-sol` 4m35s, verifier, reviewer), 7,5 phút, đáp án vẫn là 98304 | **Đã** sửa (`a10f71c`): `answerOnly` + `tricky` chạy tier `strong` ngay lần 1 (`routeFrom` nhận `signals`); reviewer `high` chỉ cãi đáp án của item trả lời thuần trong khi verifier nói `publish` thì root spawn một `team_pi_hypothesis` kiểm điểm bị cãi (`refuted` → publish luôn) |
| L52 | Gate 50–76 s, trong đó `next build` 31–49 s (≈65%), `typecheck` 1–5 s, regression 14–19 s. Gate main sau `integrate` (`baseChanged`) nằm trên đường găng của publish ở CR-01, TASK-02, TASK-01 | Publish 70–82 s mỗi item | **Đã** sửa (`fad831c`): profile node có `parallelBuild` (có script `build`, không `pretest`, `test` không nhắc `build`/`dist`) thì build chạy song song với `tests-added` + `regression` + `tests-kept`; kết quả ráp theo thứ tự cũ nên `failKind`/`signature` không đổi |
| L53 | Hết việc lúc 04:57:59, root chờ bằng `wait_for_update` với `cursor: 0`: nhận lại 20 sự kiện cũ và thức ngay; lần sau tự viết vòng 210 s thay vì 540 s | Thêm lượt model trên context 121K | **Đã** sửa: `wait_for_update {cursor: -1}` chỉ lấy sự kiện từ lúc gọi; mẫu "Nothing workable" của skill thức khi có `ITEM_NEW`/`ITEM_CHANGED`/`ITEM_CLOSING`/`MATCH_STATUS`, khi `state.open` có item, khi trận kết thúc, hoặc sau 9 phút |
| L54 | Root lấy `get_test_data` của CR-01 lúc 04:27:46 nhưng chỉ đưa tóm tắt vào brief; fixer nhắn root (04:29:26), root mới ghi fixture ra file (04:29:49) và lấy `app_data` lock (04:30:02). Chấm lại sau trận: chuẩn xuất CSV (`kb_search`) cũng không được lưu ở đâu, nên không ai đối chiếu được file CSV với chuẩn | Khoảng 40 s chờ trong lượt fixer; reviewer và judge không kiểm được AC-2 của CR-01 | **Đã** sửa (29/10): `company_call {backlogItemKey}` tự lưu kết quả vào `.team-work/items/<ID>/company/` và trả `savedTo`; skill root đưa đường dẫn vào `<company_facts>`, `<materials>` của reviewer có `company/` |
| L55 | Lúc 04:41:03, ngay sau một `wait_agent`, lượt GAME của root bị ngắt (`turn_aborted: interrupted`); Player gửi `RESUME_GAME` (`restartAttempt: 2`, `LOCAL_APP_RESUME`). Nhánh này của Player chạy khi trận `IN_PROGRESS` mà orchestrator đã dừng (`local-app-lifecycle.mjs:75-81`) | Root khôi phục mất 2,5 phút; CR-01 đã qua verifier và reviewer lúc 04:41 nhưng 04:43:35 mới publish | Chưa rõ nguyên nhân (app Player khởi động lại hay kết nối tới app-server). Theo dõi ở trận sau |

Đối chiếu nhanh các sửa của #7:
- **L45, L48**: không lần nào chạm `agent thread limit reached` (giới hạn 8, đã nâng lên 16 ở `fad831c` vì nặng nhất
  cần 12); lớn nhất 4 subagent cùng lúc; root spawn 20 lần, không lỗi.
- **L46**: lần này `integrate` BUG-02 trả `syncWorktrees`; root `worktree sync` BUG-01 rồi cho một lượt fixer ngắn chạy
  lại bộ test (1m26s), đúng skill.
- **Chờ**: 23 `wait_agent`, đa số 180000; root không đọc mã helper, không kill tiến trình.
- **Giữa PREPARE và START_GAME** không có lượt model nào (PREPARE xong 04:13:09, START 04:13:24); Player ở
  `PREPARED_WAITING`.

| Item | Điểm | `start_work` → nộp | modelTier | Lượt fixer | Ghi chú |
|---|---|---|---|---|---|
| BUG-02 | 150, deadline 18' | 04:14:00 → 04:25:08 (11m07s) | strong (Jev) | 1: 6.1-sol high 7m19s | Chủ test fail sẵn; nộp đầu tiên |
| BUG-01 | 200 | 04:14:03 → 04:31:17 (17m14s) | small (luật) | 2: 6-sol medium 11m07s, 6.1-sol 1m26s | L49; lần 2 sau sync baseline |
| CR-01 | 300 | 04:27:41 → 04:44:53 (17m12s) | strong (Jev) | 2: 6.1-sol 6m38s (`partial`), 6.1-sol 3m20s | L50, L54, L55 |
| TASK-02 | 250 | 04:27:44 → 04:39:02 (11m19s) | strong (Jev) | 1: 6.1-sol 6m23s | Gate main 70 s |
| TASK-01 | 100 | 04:42:45 → 04:57:37 (14m52s) | small (luật) | 2: 6-sol medium 2m49s, 6.1-sol 4m35s | L51 |
