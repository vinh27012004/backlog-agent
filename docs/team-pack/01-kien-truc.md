# 01 · Kiến trúc mới

## 1. Bối cảnh ngắn

Một trận dài tối đa **40 phút**, khoảng **10 item** (TASK / CR / BUG / PI) xuất hiện theo đợt mà không
báo trước. Tối đa **1.000 điểm**. PI tính điểm theo thứ tự hoàn thành giữa các đội (100/90/75/60%,
FAILED = 0). Mỗi item phải **Start Work** trước và chỉ **nộp 1 lần**. Item có deadline thì quá hạn không
nộp được. Mỗi lần người vào máy bị trừ 50 điểm. Khi bằng điểm, xét thời gian hoàn thành item cuối
và credit Codex đã dùng. Chi tiết luật: [`docs/btc/MTM_Game_Rules.md`](../btc/MTM_Game_Rules.md),
[`docs/btc/Q&A.md`](../btc/Q&A.md).

Codebase của trận không biết trước: stack bất kỳ phổ biến, mỗi vòng một repo khác, không được đổi stack
(Q&A #1, #2, #16).

## 2. Vì sao phải đổi kiến trúc

Kiến trúc cũ ([`docs/legacy/ARCHITECTURE.md`](../legacy/ARCHITECTURE.md)): một vòng `MatchRunner` Python chạy song
song với agent, mỗi vai trò (fixer, reviewer, pi_hypothesis) là **một tiến trình `codex exec`**, quyết
định nhanh hỏi Jev (TypeSafe) qua HTTP.

Các nguồn chính thức giờ đã chặn hướng này:

| Ràng buộc | Nguồn |
|---|---|
| "The Team Orchestrator may spawn subagents only through the provider's native mechanism within the active CLI session. It must not launch additional Codex CLI, Claude Code CLI, app-server, or other independent CLI processes to perform match work." | Guide §2 (MUST NOT), §4 Lifecycle |
| "The team runtime must not self-start another coding-agent CLI." | `app/docs/host-control-plane.md` |
| Player sở hữu cây tiến trình (Windows Job Object, kill-on-close), theo dõi subagent qua sự kiện `collabAgentToolCall`, ghi nhận **Suspected Violations** và có quyền dừng cả cây | `codex-app-server.mjs`, `docs/local-application.md` |
| Model ngoài `allowedModels` bị ghi `MODEL_NOT_ALLOWED`; gọi mạng tới origin ngoài danh sách bị ghi `UNEXPECTED_NETWORK_ORIGIN` | `model-policy.mjs`, `progress.mjs` |

Vì vậy: `codex exec` cho từng agent → **vi phạm**. Jev là lời gọi HTTP tới dịch vụ ngoài, không nằm trong
cây Codex, nên không bị `allowedModels` chặn, nhưng cần quản lý origin và credential (D9,
[08 §8](08-guardrails.md#8-jev-typesafe)). Python orchestrator chạy như một daemon riêng điều khiển trận → không phù hợp với
mô hình "một phiên do Player sở hữu".

Các **nguyên tắc** cũ vẫn đúng và được giữ: LLM mỏng còn việc lặp lại làm bằng code; không tin agent và
chạy lại gate trước khi nộp; nội dung item là dữ liệu untrusted; tự hồi phục; luật tự quyết bằng code
thay cho người.

## 3. Thành phần

```
 Operator ──► MTM Player (BTC, tin cậy) ── poll Game Master 5s ──► mtm-game-server
                 │  thread/start + turn/start (prompt = hướng dẫn + frame)
                 ▼
          codex app-server  (tiến trình của Player, Job Object, sandbox: danger-full-access)
                 │
                 └─ ROOT thread "team_orchestrator"  (model = orchestratorModel do operator chọn)
                       │  đọc: AGENTS.md (khối của Player + khối của đội), .agents/skills/<phase>/SKILL.md
                       │
                       ├─ MCP "team_runtime" (helper Node.js của đội, khai trong .codex/config.toml)
                       │     ├─ HTTPS → trang /match/<matchId> (cookie đăng nhập)
                       │     ├─ HTTPS → POST Start Work / Submit (bearer của đội)
                       │     ├─ append → team-sdlc-pack/logs/<matchId>.progress.ndjson ──► Player đọc
                       │     ├─ git clone / commit / push (chỉ repo + branch được giao)
                       │     └─ job nền: cài dependency, build, test, gate
                       │
                       └─ subagent native (spawn_agent): team_repo_scout · team_feature_worker · team_quality_checker
                             └─ sửa code trong worktree riêng: checkoutRoot/.team-work/wt/<ID>/
```

| Thành phần | Của ai | Chạy ở đâu | Việc |
|---|---|---|---|
| MTM Player | BTC | `mtm-player.exe`, `http://127.0.0.1:54321` | Kiểm tra pack, khởi chạy/dừng phiên Codex, gửi frame theo phase, gọi Preparation Complete, dashboard, ghi vi phạm |
| Root `team_orchestrator` | Đội (prompt) | Thread chính của `codex app-server` | PM: chọn việc, giao việc cho subagent, quyết định nộp/thử lại/bỏ, gọi tool helper |
| Subagents | Đội (prompt) | Thread con, cùng app-server | Phân tích, sửa code, test, tạo evidence; **không** cầm credential, **không** gọi Game Master |
| MCP helper `team_runtime` | Đội (code) | Tiến trình `node` do Codex khởi chạy | Giữ credential trong RAM, HTTP tới Game Master, progress log, git, gate, poller |
| Progress log | Đội ghi, Player đọc | File NDJSON | Kênh trạng thái duy nhất tới Player/dashboard |
| Git repo được giao | BTC cấp | GitHub | Source; branch được giao; SHA dùng để nộp |

## 4. Vòng đời một trận

| Bước | Player làm | Root làm | Ghi chú |
|---|---|---|---|
| Init | Kiểm pack, lấy team-info, tạo log + dòng `ORCHESTRATOR_STARTED`, ghi khối của Player vào `AGENTS.md` | — | Init luôn mở round mới; `matches/<matchId>` phải trống |
| PREPARING | `thread/start` + `turn/start` với `PREPARE_GAME_V2` | Clone, cài, build, đăng nhập trang trận, ghi `ENVIRONMENT_READY`, **kết thúc lượt** | Không có bearer ở bước này |
| PREPARED | Thấy `ENVIRONMENT_READY` trong log → tự gọi Preparation Complete → chờ `IN_PROGRESS` | Đang idle | Practice Match tự start sau ~10 s |
| IN_PROGRESS | `turn/start` (cùng thread) với `START_GAME_V4` + policy | Chạy vòng trận **cho tới hết trận**, không kết thúc lượt sớm | Lượt kết thúc sớm → Player tạo root mới với `RESUME_GAME_V1` |
| PAUSED | `turn/interrupt` + kill cả cây | (bị kill) | Thông báo không tới agent |
| Resume | Tạo root mới, `RESUME_GAME_V1` (credential mới, `restartAttempt`) | Đối chiếu log/git/server, ghi `ORCHESTRATOR_RESTARTED`, chạy tiếp | Không clone lại, không nộp trùng |
| FINISHED / CANCELLED | Kill cả cây, giữ dashboard tĩnh | Nếu kịp: ghi `ORCHESTRATOR_ENDED` | — |

Chi tiết hợp đồng: [02](02-hop-dong-player.md). Kịch bản chi tiết: [07](07-quy-trinh-tran.md).

## 5. Quyết định thiết kế

| ID | Quyết định | Lý do | Hệ quả |
|---|---|---|---|
| **D1** | Runtime lúc thi = phiên Codex do Player khởi chạy. Subagent chỉ tạo bằng multi-agent native (`spawn_agent`). Không tự chạy `codex exec`, `app-server` hay CLI khác. | MUST NOT của guide; Player giám sát cây tiến trình | Bỏ `orchestrator/agents.py`, `match.py` khỏi runtime |
| **D2** | Toàn bộ code của pack viết bằng **Node.js ≥ 20, chỉ dùng built-in**, không dependency npm: helper, installer, checker, mock Game Master, test (`node:test`). | Guide/Kick-off yêu cầu Node cho installer và helper; Player từ chối pack có `dependencies` hoặc lifecycle script; máy thi không bắt buộc có Python | Port gate/profile/log condenser từ Python; giữ test Python làm đặc tả hành vi |
| **D3** | **Root mỏng, helper dày.** Việc tất định (poll, log, kiểm tra schema, HTTP, git publish, gate, nhận diện stack) làm trong helper. LLM chỉ quyết định và viết code. Root không tự poll; chờ bằng `wait_for_update` (≤ 55 s/lần). | Tiết kiệm token (điểm phụ credit); đúng schema; không phụ thuộc trí nhớ của model | Tool helper trả JSON gọn |
| **D4** | **Chỉ root gọi tool Game Master và progress.** Subagent không thấy credential. Helper từ chối các tool đó khi chưa `configure_session`. | Guardrail credential; tránh ghi log trùng | Subagent báo kết quả qua file kết quả + message cuối |
| **D5** | Credential chỉ nằm trong RAM của helper. Root chuyển frame **một lần** qua `configure_session`; helper kiểm `apiKeyLength` + `apiKeySha256`. Không bao giờ in lại secret. | Guide §4 Credential; frame có sẵn hash để phát hiện chép sai | Không ghi `.env`, không đưa vào argv của shell |
| **D6** | Git: **một branch được giao, lịch sử tuyến tính.** Chỉ helper được `push` (không force). Worker làm trong worktree riêng; root tích hợp tuần tự (cherry-pick) vào checkout chính. | Player chỉ cho phép commit/push vào repo + branch được giao | `gitRevision` của item sau chứa cả thay đổi của item trước, nên **không bao giờ commit thứ làm hỏng build/regression** |
| **D7** | `clientSubmissionId` **tất định**: UUID dẫn xuất từ SHA-256 của `matchUuid|backlogId|gitRevision`. `answer` lấy từ `answers/<ID>/submit.json` **đã commit** ở đúng revision đó. Ghi ý định nộp vào journal trước khi POST. | Retry hoặc khởi động lại vẫn gửi cùng key + cùng body → server trả lại biên nhận cũ (`Idempotent-Replay`) | Không bao giờ nộp trùng; không mất biên nhận khi bị kill |
| **D8** | Progress log do helper sở hữu: kiểm từng event theo bản sao luật của Player trước khi append; chỉ một writer; **ngân sách byte ≤ 230 KB**; polling mặc định 15 s, giãn dần khi log lớn. | Player từ chối log > 256 KB; event sai bị bỏ qua | Root không tự viết JSON log |
| **D9** | **Giữ Jev (TypeSafe) cho các quyết định nhanh có lựa chọn cố định**, gọi từ **helper** bằng HTTP, không phải từ agent. Mỗi quyết định có luật code dự phòng (lỗi, quá hạn, dưới ngưỡng tin cậy thì dùng luật). Đội đã có API key. Không có nguồn nào của BTC cấm; chưa có xác nhận rõ ràng nên hỏi BTC (Q13) và giữ cờ `jev.enabled` để tắt ngay nếu BTC không đồng ý. | Giữ lợi thế của kiến trúc cũ: quyết định rẻ, nhanh, có xác suất, không tốn credit Codex | Port `jev.py` + `decisions.py` sang `src/jev.mjs`, `src/decisions.mjs`; guardrail ở [08 §8](08-guardrails.md#8-jev-typesafe) |
| **D10** | Agent profiles: `team_orchestrator` (bắt buộc) + `team_repo_scout`, `team_feature_worker`, `team_quality_checker` (tên theo guide). **Không** ghim model, sandbox, approval trong profile; root chọn model từ `allowedModels` khi spawn. | Guide; Player cấm profile ghi đè quyền | Xem [06](06-agents-va-skills.md) |
| **D11** | **Helper chạy lại gate** trước mỗi lần commit/nộp: diff, file cấm, build, test đã khai, test toàn bộ (so với baseline lúc chuẩn bị), MVS nếu có lệnh. `BACKLOG_TESTS` chỉ ghi số thật. | Mỗi item nộp 1 lần; không tin lời agent | Port `gate.py` |
| **D12** | **Giả định bị kill bất cứ lúc nào.** Nguồn sự thật bền: Git (commit, SHA đã push), progress log, server (Start Work replay, Submit idempotency, `ALREADY_SUBMITTED`, trạng thái trên trang), và journal nhỏ `checkoutRoot/.team-work/journal.json`. | T4: pause/end = kill; hết hạn mức Codex cũng dừng | Recovery đọc lại các nguồn này, không dựa vào RAM |
| **D13** | TeamWorkspace **phải được trust** trong Codex. Installer/checker kiểm tra điều này. | T9: Codex bỏ qua `.codex/config.toml` của thư mục chưa trust | Bước bắt buộc trong checklist máy |
| **D14** | Guardrail nhiều lớp: (1) helper chặn bằng code (origin, đích push, path commit), (2) execpolicy `.codex/rules/team.rules` (chặn `git push`, `git remote …` từ shell của model), (3) AGENTS.md + skill, (4) installer/checker kiểm path và symlink. | Không có sandbox (T8) | Xem [08](08-guardrails.md) |

## 6. Giữ / port / bỏ từ code cũ

| Hiện có | Số phận | Đích | Ghi chú |
|---|---|---|---|
| `orchestrator/gate.py`, `config/gate.toml` | **Port** | `pack/src/gate.mjs`, `pack/config/runtime.json` | Giữ thứ tự kiểm tra và `fail_kind`; thêm baseline test lúc chuẩn bị |
| `orchestrator/profile.py`, `agents/stacks/*.md` | **Port** | `pack/src/profile.mjs`, `pack/skills/*/stacks/` | Detector java/node/python/dotnet/go/php |
| `orchestrator/logs.py` | **Port** | `pack/src/log-condenser.mjs` | `signature()` để phát hiện lỗi lặp |
| `orchestrator/workspace.py` | **Port một phần** | `pack/src/git.mjs` | Worktree + commit + push không force; đổi sang một branch được giao |
| `gamemaster.py` (`safe_submit`, `with_retry`) | **Port ý tưởng** | `pack/src/game-client.mjs` | Idempotency theo API thật (D7) |
| `orchestrator/store.py` (SQLite) | **Bỏ** | journal JSON | Không cần DB; trạng thái bền nằm ở git, log, server |
| `orchestrator/match.py` | **Bỏ khỏi runtime** | Skill `team-orchestrator` + gợi ý xếp lịch của helper | Luật hàng đợi và retry chuyển thành luật trong skill/helper |
| `agents.py`, `events.py`, `prompt.py`, `config.py`, `config/agents.toml`, `config/codex-home/` | **Bỏ** | — | Chỉ phục vụ `codex exec` |
| `jev.py`, `decisions.py`, `config/jev.toml` | **Port** | `pack/src/jev.mjs`, `pack/src/decisions.mjs`, `pack/config/jev.json` | D9. Giữ ngưỡng, luật dự phòng, `mock_transport`; gọi bằng `fetch`, timeout 5 s; ghi quyết định vào `.team-work/decisions.ndjson` |
| `monitor.py`, `monitor/` | **Bỏ** | Dashboard của Player | Có thể giữ làm công cụ dev nếu cần |
| `fake_gamemaster/` | **Viết lại** | `tools/mock-gm/` (Node, có đăng nhập + trang + API thật) | Tái dùng `samples/scenarios/*.json` |
| `samples/repo-template`, `samples/items`, `samples/scenarios` | **Giữ** | Fixture cho test | — |
| `agents/rules`, `roles`, `skills`, `references` | **Port** | `pack/skills/backlog-*`, `pack/agents/*.toml` | Bỏ các tag mà orchestrator Python từng chèn (`<triage>`…), thay bằng brief của root |
| `agents/schemas/*.schema.json` | **Chỉnh** | `pack/contracts/worker-result.schema.json`, `checker-result.schema.json` | Kết quả subagent ghi ra file |
| `tests/*.py` | **Làm đặc tả** | `tests/pack/*.test.mjs` | Port từng case liên quan |

## 7. Cấu trúc repo đề xuất

```
backlog-agent/
├── pack/                          # nguồn team-sdlc-pack, đúng layout package (xem 09 §1)
│   ├── package.json  team-runtime.json  team-pack-info.json  README.md  install.ps1
│   ├── agents/      team-orchestrator.toml team-repo-scout.toml team-feature-worker.toml team-quality-checker.toml
│   ├── skills/      game-preparation/ team-orchestrator/ team-recovery/ backlog-bug/ backlog-cr/ backlog-task/ backlog-pi/
│   ├── config/      codex.toml  team.rules  runtime.json
│   ├── contracts/   progress-event.schema.json  agent-result.schema.json  worker-result.schema.json  checker-result.schema.json
│   ├── bin/         runtime-server.mjs
│   ├── src/         *.mjs (xem 05 §11)
│   ├── scripts/     install.mjs  check-distribution.mjs
│   └── docs/        README.md (hướng dẫn vận hành ngắn, đi kèm ZIP)
├── tools/
│   ├── mock-gm/                   # Game Master giả, chỉ loopback
│   ├── fake-root.mjs              # gọi tool helper theo kịch bản, không cần LLM
│   └── build-pack.mjs             # gắn identity theo đội, đóng ZIP + SHA256SUMS
├── tests/pack/                    # node:test (unit + contract với source Player)
├── docs/team-pack/                # bộ tài liệu này
├── orchestrator/ fake_gamemaster/ monitor/ tests/*.py   # legacy, chỉ tham chiếu
└── vendor/                        # của BTC, chỉ đọc: mtm-player-0.9.33/, team-orchestrator-pack-0.5.1/
```

## 8. Nguyên tắc tiết kiệm token và credit

Credit Codex là tiêu chí phụ khi bằng điểm, và tài khoản BTC chỉ có $50, không nạp thêm được (Q&A #17).

1. **Root không đọc code.** Root chỉ đọc kết quả gọn từ subagent và helper. Đọc code và sửa code là việc
   của subagent, vì context của subagent tách riêng và kết thúc cùng task.
2. **Chờ bằng tool chặn.** `wait_for_update` chặn tới 55 s và chỉ trả về khi có thay đổi. Root không tự
   hỏi trạng thái liên tục.
3. **Đầu ra tool ngắn.** Trả diff trạng thái thay vì cả bảng; log dài cắt bằng Log Condenser.
4. **Model theo việc.** Model mạnh cho PI và fix khó; model rẻ hơn (nếu có trong `allowedModels`) cho
   scout và kiểm tra. Root dùng model operator chọn.
5. **Không làm thừa.** Dừng khi điều kiện hoàn thành của skill đã đạt. Không review lại thứ gate đã
   chứng minh.
6. **Đo trên Practice Match.** Dashboard Player hiện token theo model và nominal credit; ghi lại sau mỗi
   trận ([10 §8](10-kiem-thu.md#8-quy-trình-practice-match)).
