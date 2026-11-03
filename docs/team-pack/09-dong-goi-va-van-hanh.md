# 09 · Đóng gói, cài đặt và vận hành

## 1. Cấu trúc nguồn của pack (`pack/`)

Thư mục này **chính là** package `team-sdlc-pack`. Mọi mục trong `files` phải tồn tại, không có symlink.

```
pack/
├── package.json                 name/version/files cố định (§2)
├── team-runtime.json            đúng 7 key (§2)
├── team-pack-info.json          đúng 4 key; build-pack.mjs điền teamId/teamName theo đội
├── README.md                    giới thiệu ngắn
├── install.ps1                  wrapper PowerShell (§4)
├── agents/                      team-orchestrator.toml (bắt buộc) + team-repo-scout/feature-worker/quality-checker.toml
├── skills/                      game-preparation/ team-orchestrator/ team-recovery/ backlog-*/ retry-playbook/ stack-notes/ evidence/
├── config/                      codex.toml (mẫu, §3), team.rules (execpolicy), runtime.json (giới hạn, nhịp poll)
├── contracts/                   progress-event.schema.json (của BTC), agent-result.schema.json (của BTC),
│                                worker-result / checker-result / scout-result .schema.json
├── bin/runtime-server.mjs       điểm vào MCP helper
├── src/                         module helper: tools.mjs + core/ match/ env/ decide/ (05 §11)
├── scripts/install.mjs          installer (§4)
├── scripts/check-distribution.mjs   checker chỉ đọc (§5)
└── docs/                        README.md (hướng dẫn vận hành đi kèm ZIP), CHECKSUMS.json (do build sinh)
```

Không đưa vào pack: `logs/` của sample pack, `node_modules/`, credential, log trận thật, cache, file ẩn
của hệ thống thi.

## 2. File định danh

```json
// package.json — giữ đúng thứ tự mảng files
{
  "name": "team-sdlc-pack",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "files": ["agents/","bin/","config/","contracts/","docs/","install.ps1",
            "scripts/check-distribution.mjs","scripts/install.mjs","skills/","src/",
            "README.md","team-pack-info.json","team-runtime.json"]
}
```
Không có `dependencies*`; không có script `preinstall`/`install`/`postinstall`/`prepare` (Player từ chối).

```json
// team-runtime.json — thêm hay bớt key là Player từ chối
{"schemaVersion":1,"kind":"mtm-team-runtime","name":"team-sdlc-pack","version":"1.0.0",
 "protocolVersion":4,"provider":"codex","entrypoint":{"rootAgentType":"team_orchestrator"}}
```

```json
// team-pack-info.json — đúng 4 key
{"schemaVersion":1,"version":"1.0.0","teamId":"<MÃ ĐỘI BTC CẤP>","teamName":"<Tên đội thật>"}
```

- `version` giống nhau ở cả 3 file. Mỗi lần phát hành tăng version.
- `teamId` là **mã đội** đăng ký trên Game Server (BTC gửi ngày 26/10), không phải UUID.
- `name` luôn là `team-sdlc-pack`. Tên đội chỉ nằm ở `teamId`/`teamName`, tên ZIP và đường dẫn workspace.

## 3. `config/codex.toml` và file đăng ký

Mẫu trong pack (installer thay `__TEAM_RUNTIME_SERVER__` bằng path tuyệt đối, dấu `/`, đặt trong chuỗi
JSON):

```toml
# Managed by team-sdlc-pack. Installed to <TeamWorkspace>/.codex/config.toml.
[mcp_servers.team_runtime]
command = "node"
args = [__TEAM_RUNTIME_SERVER__]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Sau khi cài: `args = ["D:/mtm/T01/team-sdlc-pack/runtime/bin/runtime-server.mjs"]`.

- **Không** đặt `model`, `model_reasoning_effort`, `sandbox_mode`, `approval_policy`: Player đặt các giá trị
  này cho thread.
- `[agents] max_concurrent_threads_per_session = 16` (tên cũ `max_threads`): mặc định của Codex chỉ cho 3
  subagent chạy cùng lúc (ZVUYZ41V, L48). Từ 03/11 mỗi item chỉ một fixer (tier strong thêm một worker evidence);
  BTC không giới hạn, khoá không nhận "không giới hạn" nên đặt 16 (29/10, sau TOKXKPBV). Còn cân nhắc: cấu hình approval cho tool MCP (Spike S3). **Giữ web search bật** (Q11, 26/10); nếu Spike S1 cho thấy nó đang tắt mặc định thì
  bật trong `config/codex.toml`.
- `command = "node"` cần Node ≥ 20 trên PATH của tiến trình Codex. Checker kiểm điều này.

| Nguồn trong `runtime/` | Đích trong TeamWorkspace | Player kiểm byte? |
|---|---|---|
| `agents/team-orchestrator.toml` | `.codex/agents/team-orchestrator.toml` | **Có** |
| `agents/team-*.toml` khác | `.codex/agents/` | Không |
| `team-pack-info.json` | `.mtm/team-pack-info.json` | **Có** |
| `team-runtime.json` | `.mtm/team-runtime.json` | **Có** |
| `config/codex.toml` (đã thay path) | `.codex/config.toml` | Không (guide nói bản sau có thể kiểm, nên chỉ thay đúng placeholder) |
| `config/team.rules` | `.codex/rules/team.rules` | Không |
| `skills/<tên>/` | `.agents/skills/<tên>/` | Không (Player trỏ tới 3 skill bắt buộc) |
| khối TEAM-PACK | `AGENTS.md` | Không (Player ghi khối riêng của nó) |

## 4. Installer

**`install.ps1`**: tham số bắt buộc `-TeamWorkspace`; `$ErrorActionPreference = 'Stop'`; kiểm `node` ≥ 20;
chạy `node "$PSScriptRoot/scripts/install.mjs" --team-workspace "$TeamWorkspace"`; trả lại exit code. Gọi:

```powershell
pwsh -NoProfile -File .\install.ps1 -TeamWorkspace "D:\mtm\<TEAM_ID>"
```

**`scripts/install.mjs`**, theo thứ tự:
1. `--team-workspace` phải tuyệt đối. Resolve, rồi `lstat` từng đoạn path: có symlink hoặc junction là từ
   chối. Không nhận ổ gốc. Tạo thư mục nếu chưa có.
2. Kiểm package nguồn: `files` đúng danh sách, mọi mục tồn tại, không symlink; version khớp ở 3 file;
   `teamId` khác placeholder `YOUR_TEAM_ID`; khớp `docs/CHECKSUMS.json` (SHA-256 mọi file payload trừ
   chính nó).
3. Chặn cài đè khi trận đang chạy: có `team-sdlc-pack/logs/*.progress.ndjson` sửa trong 2 phút gần đây
   thì dừng (trừ khi có `--force`).
4. Tạo `matches/`, `team-sdlc-pack/`, `team-sdlc-pack/logs/` nếu chưa có.
5. Chép payload (`package.json` + các mục `files`) vào `team-sdlc-pack/runtime.new/`, rồi đổi tên
   `runtime` → `runtime.old`, `runtime.new` → `runtime`, xoá `runtime.old`.
6. Chép file đăng ký, skill, rules (bảng §3) **từ `runtime/`**, đúng từng byte.
7. Sinh `.codex/config.toml` từ mẫu, chỉ thay `__TEAM_RUNTIME_SERVER__`.
8. Ghi hoặc thay khối `TEAM-PACK` trong `AGENTS.md`, giữ nguyên khối `MTM-PLAYER` và mọi nội dung khác.
   `AGENTS.md` là symlink hoặc hardlink thì từ chối (Player cũng từ chối).
9. Ghi `team-sdlc-pack/install-manifest.json`: danh sách file pack sở hữu + SHA-256. Xoá file của bản cũ
   không còn trong bản mới (theo manifest cũ). **Không** đụng `matches/`, `logs/`, file không thuộc pack.
10. Kiểm trust của Codex (đọc `%CODEX_HOME%\config.toml` hoặc `%USERPROFILE%\.codex\config.toml`, tìm
    `[projects.'<TeamWorkspace>'] trust_level = "trusted"`, so path không phân biệt hoa thường và cả hai
    kiểu dấu gạch). Chưa trust thì in **WARNING** kèm hướng dẫn §7.2. Installer **không** sửa config của user.
11. In JSON `{"status":"READY","version","teamId","teamName","teamWorkspace"}`, exit 0. Lỗi: in
    `{"status":"FAILED","code","detail"}`, exit ≠ 0.

Cài lại cùng version phải cho ra đúng các byte cũ (idempotent).

## 5. Checker `scripts/check-distribution.mjs` (chỉ đọc)

```powershell
node .\scripts\check-distribution.mjs --team-workspace "D:\mtm\<TEAM_ID>"
```

| Kiểm | Lỗi |
|---|---|
| `runtime/package.json`: name, version, `files`, không dependency, không lifecycle script | `INVALID_TEAM_PACK` |
| Mọi mục `files` có trong `runtime/`, không symlink | `INVALID_TEAM_PACK` |
| `team-runtime.json` đúng 7 key và giá trị | `INCOMPATIBLE_TEAM_RUNTIME` |
| `team-pack-info.json` đúng 4 key, version khớp | `INVALID_TEAM_PACK_INFO` |
| 3 file đăng ký trùng từng byte với `runtime/` | `INSTALLED_RUNTIME_TAMPERED` |
| Không có `team-sdlc-pack/node_modules/team-sdlc-pack` (hoặc nếu có thì trùng) | `INSTALLED_RUNTIME_TAMPERED` |
| `.codex/config.toml` đúng dạng mở rộng; path helper tồn tại; `node` ≥ 20 có trên PATH | `MCP_CONFIG_INVALID` |
| 3 skill bắt buộc có trong `.agents/skills/` | `SKILL_MISSING` |
| `install-manifest.json` khớp file trên đĩa | `PACK_FILES_CHANGED` |
| TeamWorkspace đã trust trong Codex | `CODEX_WORKSPACE_NOT_TRUSTED` |
| `codex features`: chọn exe như Player (`CODEX_CLI_PATH` → `codex.exe` trên PATH → Codex Desktop mới nhất) hoặc `--codex <exe>`, chạy `features list` trong TeamWorkspace: `computer_use`, `browser_use`, `in_app_browser`, `plugins`, `apps` tắt, `multi_agent` bật | `codex features` (ghi rõ exe, version và feature còn bật) |
| Helper khởi động được: chạy `runtime-server.mjs`, gửi `initialize` + `tools/list`, nhận đủ 19 tool, rồi tắt | `MCP_HELPER_BROKEN` |

Kết quả: `{"status":"READY"|"NOT_READY","checks":[{"id","ok","detail"}]}`; exit 0 chỉ khi `READY`.

Trên máy dev, chạy thêm kiểm tra bằng chính code của Player: test
`tests/pack/player-compat.test.mjs` gọi `verifyTeamRuntime()` của `src/team-install.mjs`
([10 §3](10-kiem-thu.md#3-contract-test-dùng-source-player-làm-oracle)). Lệnh có sẵn
`node <player-app>\app\scripts\player.mjs inspect-runtime --workspace <TW>` chỉ kiểm manifest.

## 6. Build và phát hành

`tools/build-pack.mjs --team-id <ID> --team-name "<Tên>" --version X.Y.Z`:
1. Chép `pack/` → `dist/team-sdlc-pack-<ID>-<ver>/`, ghi identity và version vào 3 file.
2. Sinh `docs/CHECKSUMS.json`.
3. Chạy `node --test tests/pack` và checker trên một TeamWorkspace tạm (cài vào thư mục tạm).
4. Nén ZIP `dist/team-sdlc-pack-<ID>-<ver>.zip` (`tar.exe -a -c -f` có sẵn trên Windows 10+) + file
   `.sha256` bên cạnh.
5. Thử trên **workspace sạch**: giải nén → `install.ps1` → checker → cài lại lần 2 (phải idempotent) →
   Player *Load team pack*.

## 7. Chuẩn bị máy thi (làm một lần, trước 26/10)

### 7.1 Phần mềm

| Thứ | Kiểm | Ghi chú |
|---|---|---|
| Windows + PowerShell 7 | `pwsh --version` | Player cần pwsh 7 để bọc Job Object |
| Codex đã đăng nhập tài khoản thi | `<exe> --version`, `<exe> login status` với **đúng exe trang Init hiển thị** | Player không dùng shim npm trên PATH; trên máy cài CLI qua npm, Player chạy `codex.exe` của Codex Desktop trong `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\` ([02 §2](02-hop-dong-player.md#2-player-chạy-codex-thế-nào)). Muốn ghim một bản: nhập đường dẫn tuyệt đối ở trang Init hoặc đặt `CODEX_CLI_PATH` |
| Node.js ≥ 20 (khuyên 24.12) trên PATH | `node --version` | Cho installer và helper. Player có `node.exe` riêng trong thư mục của nó |
| Git + Git Credential Manager, đã đăng nhập tài khoản GitHub có quyền vào repo của đội | `git ls-remote <repo>` không hỏi mật khẩu | Lúc thi helper chặn mọi prompt tương tác |
| Toolchain phổ biến (stack chưa biết trước): JDK 17/21, Maven, Gradle, Python 3.11+, .NET SDK 8, Go, PHP + Composer | `java -version`… | Cài sẵn để khỏi tải lúc thi |
| Microsoft Edge | `msedge --version` | Chụp ảnh evidence headless |
| Quyền chạy exe và script PowerShell | `Get-ExecutionPolicy` | |

### 7.2 Trust TeamWorkspace trong Codex (bắt buộc, D13)

Không trust thì Codex bỏ qua `.codex/config.toml`, và helper không chạy. Cách làm:
1. Mở terminal tại `D:\mtm\<TEAM_ID>`, chạy `codex`, chọn tin cậy thư mục khi được hỏi, rồi thoát. Hoặc
2. Thêm thủ công vào `%USERPROFILE%\.codex\config.toml`:
   ```toml
   [projects.'D:\mtm\<TEAM_ID>']
   trust_level = "trusted"
   ```
Chạy lại checker để xác nhận `CODEX_WORKSPACE_NOT_TRUSTED` đã hết.

### 7.3 MTM Player

Giải nén `mtm-player-<version>.zip`, chép **nguyên** thư mục player-app (gồm `mtm-player.exe`, `app/`)
vào thư mục riêng theo version, đặt `node.exe` (v24.12.0 win-x64) vào cùng thư mục, chạy
`mtm-player.exe` **không tham số** → `http://127.0.0.1:54321/manage`. Mỗi version một thư mục; không trộn
`app/` hay `node.exe` giữa các bản. Dừng Player từ giao diện, không kill tiến trình.

## 8. Chạy một Practice Match

1. `/manage` → nhập TeamWorkspace → **Load team pack** → kiểm Team ID, Team name, version.
2. **Initialize Match**: tài khoản đội, Match ID của Practice, Game Master URL, bootstrap secret; chọn
   *Allowed models*, *Orchestrator model*, *Reasoning effort*; *Approval mode* = **Approve for me**.
3. Theo dõi Preparation trên dashboard của round. `PREPARED` → trận Practice tự start sau ~10 s.
4. Xem backlog ở `https://masterthemachine.tech/match/<match-id>`, Battle Dashboard ở `/spectator/<match-id>`.
5. Hết trận: **Re-match** trên trang match để tạo trận luyện tập mới. Init luôn mở round mới; tiếp tục round
   đang dừng thì dùng **Resume**.

Không cài lại pack vào workspace đang có trận chạy.

## 9. Debug

**Bốn chỗ cần xem** (Kick-off): (1) dashboard của round: tab Transcript, Tool, Progress events, Chat;
(2) file `.ndjson` của trận: event nào có, event nào thiếu, có đúng thứ tự không; (3) session của Codex
`%USERPROFILE%\.codex\sessions`; (4) các round đã lưu để so giữa các lần chạy.

| Triệu chứng | Kiểm |
|---|---|
| Load team pack báo lỗi | Chạy checker; so bảng mã lỗi §5 và [02 §7](02-hop-dong-player.md#7-player-kiểm-tra-pack-load-team-pack--initialize) |
| Preparation đứng mãi | Log có `ENVIRONMENT_READY` chưa; có đúng `requestId`/`repository` không; lượt PREPARE đã kết thúc chưa |
| Agent không thấy tool `team_runtime` | Workspace chưa trust (§7.2); `node` không có trên PATH; path trong `.codex/config.toml` sai (workspace bị chuyển chỗ thì cài lại) |
| Dashboard không cập nhật backlog | Event sai schema (console hiện `IGNORED`); log > 256 KB |
| Agent kết thúc khi chưa có backlog mới | Skill phải chờ bằng `wait_for_update`, không kết thúc lượt |
| Submit timeout | Helper phải thử lại **cùng** `clientSubmissionId` + body; xem journal |
| Phiên đăng nhập hết hạn | Helper đăng nhập lại rồi refresh; xem event `LOGIN` |
| Agent chạy mà không tiến triển | Tài khoản Codex chạm hạn mức? Tìm lỗi limit trong transcript |
| Workspace bị chuyển chỗ | Cài lại pack, mở session mới |

## 10. Checklist ngày thi

- [ ] Player đúng version BTC phát; pack version cuối đã qua checker trên chính máy thi.
- [ ] `git ls-remote` tới repo đội chạy được, không hỏi mật khẩu.
- [ ] Codex đăng nhập đúng tài khoản, còn hạn mức; có sẵn tài khoản dự phòng (đổi không bị phạt, Q&A #13).
- [ ] TeamWorkspace đã trust; checker `READY`.
- [ ] **Trước mỗi trận**, kiểm `[features]` bằng đúng file exe mà trang Init của Player hiển thị (Codex Desktop có thể
      đã tự cập nhật): `node team-sdlc-pack\runtime\scripts\check-distribution.mjs --team-workspace <TW> --codex "<exe ở trang Init>"`.
      Mục `codex features` phải `ok`: `computer_use`, `browser_use`, `in_app_browser`, `plugins`, `apps` = false và
      `multi_agent` = true. Không truyền `--codex` thì checker tự chọn exe theo đúng thứ tự của Player. Tay:
      chạy `<exe> features list` với thư mục hiện tại là TeamWorkspace.
- [ ] `matches/<matchId>` trống (Init sẽ hỏi xoá).
- [ ] Nguồn điện, mạng, chế độ ngủ của máy đã tắt.
- [ ] Từ lúc Start Match: **không ai chạm máy**. Mỗi lần vào máy −50 điểm.
