# Vận hành team-sdlc-pack

Workflow 03/11: dùng prepare_item để lấy đủ brief; mỗi item một team_fixer code, chạy test, chụp evidence và ghi
fix-result. publish_item {fixResultFile} ghi candidate, kiểm answer/evidence (chỉ cảnh báo), integrate, push, submit
có checkpoint. Không gate, reviewer, solver hay vòng sửa. next_actions trả hàng đợi và thời gian chờ.

Mỗi bàn giao dùng results JSON mới, không ghi đè.
Yield worker_checkpoint trước sync/final evidence. capture_evidence có download trong cùng login/profile,
giữ bytes và trả hash; context scenario/worktree/appMode/before_fix hoặc final ghi vào manifest.
Source/environment đổi sau bàn giao thì candidate stale. Push bị từ chối thì rebase, sạch thì push tiếp.

1. Cài: `pwsh -NoProfile -File install.ps1 -TeamWorkspace D:\mtm\<TEAM_ID>`.
2. Trust TeamWorkspace trong Codex (`%USERPROFILE%\.codex\config.toml`):
   `[projects.'d:\mtm\<team_id>']` + `trust_level = "trusted"`.
3. Cấu hình máy (ngoài pack, không commit): `D:\mtm\<TEAM_ID>\team-sdlc-pack\local\machine.json`
   ```json
   {"databasePassword": "<mật khẩu role ứng dụng của PostgreSQL cục bộ>", "env": {}}
   ```
   `databasePassword` thay `CHANGE_ME` trong các biến `*_URL` của `.env.example`; `env` ghi đè từng biến.
4. Kiểm: `node scripts/check-distribution.mjs --team-workspace D:\mtm\<TEAM_ID> [--codex "<exe ở trang Init>"]` phải ra
   `READY`. Mục `codex features` chạy `features list` bằng đúng exe mà Player sẽ dùng (Player bỏ qua shim npm,
   thường rơi vào `codex.exe` của Codex Desktop, bản này tự cập nhật): làm lại trước **mỗi** trận.
5. Player: `/manage` → Load team pack → Initialize Match.

Log lệnh của helper: `matches/<matchId>/.team-work/logs/`. Journal: `.team-work/journal.json`.

KB và source: `knowledgeHints` là gợi ý theo stack/regex, kèm `skills/<path>:line`, không phải nguyên nhân đã chứng minh.
Company Tools được gọi với `backlogItemKey` sẽ lưu kết quả, tham số, thời điểm tra và SHA-256 cạnh vật liệu item;
fixer trích file kết quả và ID/section, đối chiếu source `file:line` rồi ghi kiểm chứng thực tế.

Helper lưu dấu vân tay source tại `.codegraph/team-source.json` sau khi index thành công trên source không đổi.
Nó kiểm cả file chưa commit/mới/xoá, làm mới graph trước triage, và sau sync worktree.
Index cũ thiếu dấu này được sync lại; lỗi hoặc kiểm tra vượt ngân sách trả độ mới `unknown`, không chặn publish.
Source đổi hoặc graph bị cắt không được dùng để xếp code item `easy`; đọc source/`rg` khi graph không đủ tin cậy.
