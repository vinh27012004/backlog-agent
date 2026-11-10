# Bộ tài liệu dựng Team Orchestrator Pack — MTM 2026

**Workflow hiện hành 03/11/2026:** [13 · Workflow candidate](13-workflow-toi-uu.md).
Mỗi item một worker (code, test, evidence); helper nộp nguyên kết quả, không gate, reviewer hay solver.

> **Phiên bản 1.0 · 25/10/2026.** Đã đối chiếu với: MTM Player **0.9.33**, kiểm lại trên **0.9.35** ngày 27/10, **0.9.39** ngày 29/10, **0.9.41** ngày 30/10 và **0.9.44** ngày 01/11
> (source trong `vendor/mtm-player-0.9.45/app/`), [technical guide **0.5.1**](../btc/technical-guide-0.5.1.md), sample pack **0.5.1**
> (`vendor/team-orchestrator-pack-0.5.1/`), tài liệu API *Digital Cuder: Start work và Submit*, slide Kick-off
> 23/10, Game Rules, Q&A, và Codex CLI **0.163.0** trên máy dev.
>
> Bộ này **thay thế** kiến trúc cũ `docs/legacy/ARCHITECTURE.md` (đã xoá 30/10, còn ở commit `76d4807`; Python orchestrator
> gọi `codex exec`). Lý do ở [01-kien-truc.md](01-kien-truc.md).

## Tóm tắt trong 1 phút

1. Thứ đội nộp cho BTC là một **team pack** tên cố định `team-sdlc-pack`. Cài pack vào TeamWorkspace,
   rồi **MTM Player** (app của BTC) tự khởi chạy **một phiên Codex** (`codex app-server`) đóng vai
   `team_orchestrator` cho cả trận. Đội không tự chạy Codex.
2. Root agent chỉ được tạo subagent bằng **cơ chế native của Codex** trong cùng phiên. **Cấm** tự chạy
   thêm `codex exec`, `codex app-server`, Claude CLI… Vì vậy vòng `MatchRunner` Python hiện tại
   (mỗi agent một `codex exec`) **không dùng được lúc thi**.
3. Đội tự xây: **MCP helper** (Node.js, không dependency) giữ credential, gọi Game Master, ghi
   progress log, chạy git; **skills** (chiến thuật); **agent profiles**; **installer +
   checker**.
4. Player chỉ biết đội đang làm gì qua **progress log NDJSON**. Log phải đúng schema từng dòng, và
   **không được vượt 256 KB**, nếu không dashboard của Player ngừng đọc.
5. Mỗi item chỉ nộp được **1 lần**, phải gọi **Start Work** trước. `gitRevision` là SHA đầy đủ của
   commit đã push lên **branch được giao**.
6. Mọi thứ phải chịu được việc **bị kill bất cứ lúc nào**: khi tạm dừng hay hết trận, Player kill cả
   cây tiến trình mà không báo trước. Khi resume, Player tạo root mới với `RESUME_GAME_V1`.

## Thứ tự tin cậy khi các nguồn mâu thuẫn

BTC đã cảnh báo: *"Do not trust everything in this guide"*. Khi các nguồn nói khác nhau, tin theo thứ tự:

1. **Source Player 0.9.33**: đây là thứ thật sự chạy và kiểm tra pack.
2. **Tài liệu API Start work / Submit** (do Game Master công bố).
3. Slide Kick-off, Game Rules, Q&A.
4. Technical guide 0.5.1 và sample pack.

Gặp mâu thuẫn mới thì ghi vào bảng bên dưới và vào [12-rui-ro-va-cau-hoi.md](12-rui-ro-va-cau-hoi.md).
Khi BTC phát hành Player bản mới, đối chiếu lại theo [02 §12](02-hop-dong-player.md#12-khi-player-ra-bản-mới).

## Những chỗ guide khác thực tế (đã kiểm chứng)

| # | Guide nói | Thực tế (nguồn) | Hệ quả |
|---|---|---|---|
| T1 | Team PHẢI ghi `ORCHESTRATOR_STARTED` làm event đầu tiên | Player tự ghi dòng này lúc khởi tạo log, và prompt dặn *"Do not write, replace, or repeat that event"*; dòng thứ hai bị loại (`progress.mjs:193`, `cli-supervisor.mjs:42`) | Team **không** ghi `ORCHESTRATOR_STARTED` |
| T2 | Player cần đúng 4 profile `team_orchestrator`, `team_repo_scout`, `team_feature_worker`, `team_quality_checker` | Sample pack có 5 tên khác; Player 0.9.33 chỉ kiểm `.codex/agents/team-orchestrator.toml` (`team-install.mjs:18`) | Bắt buộc `team_orchestrator`; 3 tên còn lại của guide dùng cho subagent (D10) |
| T3 | Submit trả `receiptId` + `status: RECEIVED` | API trả `201 {submission:{id, status:"ACCEPTED", scoreStatus:"PENDING", ...}}` | `receiptId` = `submission.id`; chỉ coi là đã nộp khi có `submission.id` |
| T4 | Player "gửi" input MATCH_PAUSED / MATCH_ENDED cho agent | Ở chế độ app-server, STOP chỉ `turn/interrupt` rồi kill cây tiến trình; thông báo không tới agent (`local-app.mjs:267`) | Phải chịu được kill đột ngột; tự phát hiện hết trận bằng polling |
| T5 | `matchPageUrl` là trang trận | `matchPageUrl` = `<origin>/match` (trang chung); trang của trận là `/match/<matchId>` | Helper tự dựng `/match/<matchId>` |
| T6 | Ví dụ URL `ai-fest-five.vercel.app` | Kick-off dùng `masterthemachine.tech`; Player lấy origin từ team-info | Chỉ dùng origin trong descriptor (`allowedMatchOrigins`/`allowedApiOrigins`) |
| T7 | Ghi `GAME_MASTER_API` trước/sau **mọi** refresh | Player từ chối đọc log > **256 KB** (`PROGRESS_LOG_TOO_LARGE`, `progress.mjs:785`) | Có ngân sách byte và polling thưa (15 s, giãn dần) — [04 §7](04-progress-log.md#7-ngân-sách-byte-và-nhịp-polling) |
| T8 | Player chạy Codex CLI | Với provider codex, Player dùng **`codex app-server`**: `thread/start`, `sandbox: danger-full-access`, `approvalPolicy: on-request`, reviewer `auto_review` (`local-app.mjs:89`, `codex-app-server.mjs`) | **Không có sandbox**, guardrail hoàn toàn do đội tự làm |
| T9 | Installer ghi `.codex/config.toml` là đủ | Codex 0.163 **bỏ qua** `.codex/config.toml` của thư mục chưa trust (đã thử trên máy dev) | TeamWorkspace phải được trust trong Codex, nếu không MCP helper không chạy (Spike S1) |
| T10 | MTM_MODEL_POLICY_V1 có các field … | Source trả `schemaVersion: 2` và thêm `orchestratorReasoningEffort` | Parse lỏng, bỏ qua field lạ |
| T11 | (không nói) | Player gắn cờ `TEAM_RUNTIME_INTEGRITY_ACCESS` cho mọi lần **ghi** vào đường dẫn có đoạn `\.mtm\` hoặc `team-sdlc-pack\runtime` (`progress.mjs:693`) | Thư mục làm việc tạm của đội **không** đặt tên `.mtm`; dùng `.team-work/` |
| T12 | `repository.folder` là thư mục bất kỳ | Player bắt buộc `repository.folder == matchId` (`preparation.mjs:61`) | `matchRoot = checkoutRoot/<matchId>`; mọi path trong commit bắt đầu bằng `<matchId>/` |
| T13 | `apiKeyScopes` là `backlogs:start`, `submissions:create` | Player gửi `submission:create`, `submission:read` (`bootstrap.mjs:13`) | Helper nhận cả `submission:create` lẫn `submissions:create`, phòng khi Player lúc thi đổi theo guide |

## Bản đồ tài liệu

| File | Nội dung | Ai đọc trước |
|---|---|---|
| [01-kien-truc.md](01-kien-truc.md) | Kiến trúc mới, quyết định D1–D14, giữ/port/bỏ code cũ, cấu trúc repo | Cả đội |
| [02-hop-dong-player.md](02-hop-dong-player.md) | Hợp đồng với Player: cách chạy Codex, prompt, descriptor, layout, kiểm tra pack | Người làm helper, installer |
| [03-game-master.md](03-game-master.md) | Trang `/match`, API Start Work / Submit, mã lỗi, idempotency | Người làm helper |
| [04-progress-log.md](04-progress-log.md) | Schema từng event, luật chuyển trạng thái, thứ tự, ngân sách byte | Người làm helper, skill |
| [05-mcp-helper.md](05-mcp-helper.md) | Đặc tả MCP helper: tool, state, poller, HTTP, git | Người làm helper |
| [06-agents-va-skills.md](06-agents-va-skills.md) | Agent profiles, 3 skill bắt buộc, skill theo loại item, AGENTS.md, brief/result của subagent | Người viết prompt |
| [07-quy-trinh-tran.md](07-quy-trinh-tran.md) | Kịch bản chạy một trận: chuẩn bị, xếp lịch, pipeline item, PI, nộp, chờ, dừng, hồi phục | Cả đội |
| [08-guardrails.md](08-guardrails.md) | Luật an toàn và lớp thực thi (helper, execpolicy, prompt, installer) | Cả đội |
| [09-dong-goi-va-van-hanh.md](09-dong-goi-va-van-hanh.md) | Cấu trúc pack, installer, checker, đóng gói ZIP, chuẩn bị máy, chạy Player, debug | Người làm installer, người vận hành |
| [10-kiem-thu.md](10-kiem-thu.md) | Unit test, contract test với source Player, mock Game Master, spike S1–S10, Practice Match | Cả đội |
| [11-lo-trinh.md](11-lo-trinh.md) | Lộ trình 26/10 – 06/11, đầu việc, tiêu chí xong | Trưởng nhóm |
| [12-rui-ro-va-cau-hoi.md](12-rui-ro-va-cau-hoi.md) | Rủi ro, giả định, câu hỏi gửi BTC | Trưởng nhóm |

## Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **TeamWorkspace** | Thư mục gốc của đội trên máy thi, ví dụ `D:\mtm\<TEAM_ID>`. Player chạy Codex với `cwd` là thư mục này. |
| **checkoutRoot** | `TeamWorkspace\matches\<matchId>`: nơi clone repo, là Git root. |
| **matchRoot** | `checkoutRoot\<repository.folder>`; `folder == matchId`. Source, build, test, `answers/` đều nằm ở đây. |
| **matchId** | Mã 8 ký tự của trận (vd `ABCD1234`): tên folder git, id trang `/match/<matchId>` và spectator. |
| **Match UUID** | UUID dùng trong path API `/api/v1/matches/{uuid}/...`. Chỉ đọc được từ trang trận (mục *Digital Cuder APIs*), không có trong descriptor. |
| **root** | Thread Codex mà Player khởi chạy, đóng vai `team_orchestrator` (PM). |
| **subagent** | Thread con do root tạo bằng multi-agent native của Codex (`spawn_agent`). |
| **helper** | MCP server `team_runtime` của đội (Node.js), Codex khởi chạy theo `.codex/config.toml`. |
| **frame / descriptor** | Khối Player gửi trong prompt: dòng marker (vd `START_GAME_V4`) + một dòng JSON descriptor + các khối policy nối sau. |
| **progress log** | `TeamWorkspace\team-sdlc-pack\logs\<matchId>.progress.ndjson`: kênh trạng thái duy nhất tới Player. |
| **gate** | Bước kiểm tra do code chạy lại (diff, file cấm, build, test, MVS) trước khi nộp. Đã bỏ 03/11; còn trong judge của trận cũ. |
| **MVS** | Minimum Verification Scenarios: kịch bản tối thiểu cho CR/BUG, chỉ nhận được lúc Start Work. |
| **receipt** | Biên nhận nộp bài = `submission.id` server trả về. |

## Quan hệ với code hiện có

- `orchestrator/` (Python), `monitor/` và `agents/` cũ đã xoá sau khi port, còn trong lịch sử git.
  Runtime hiện hành ở `pack/src/`, profiles ở `pack/agents/`, skills ở `pack/skills/`;
  xem [kiến trúc](01-kien-truc.md), [agent/skill](06-agents-va-skills.md) và [workflow](13-workflow-toi-uu.md).
- Jev (TypeSafe): **giữ**, port sang helper Node (D9); gọi từ helper, có luật dự phòng và cờ tắt.

## Lưu ý bảo mật tài liệu

`vendor/` (MTM Player, sample pack) và `docs/btc/` là tài liệu nội bộ cuộc thi (đội đã ký NDA). Chỉ dùng
trong repo này, **không** công khai. `vendor/mtm-player-*/` đã nằm trong `.gitignore` (88 MB, có file `.exe`).
