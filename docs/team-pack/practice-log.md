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
| L11 | Template có `status: "NOT_STARTED"`, gate chỉ chặn `DRAFT` | Có thể nộp sai trạng thái | **Đã** sửa (validator JSON Schema tự viết; 4 bài đã nộp khớp schema, template gốc thì không). Gate kiểm `submit.json` theo `submit.schema.json` của item và `status` khác giá trị ban đầu của template |
