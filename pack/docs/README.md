# Vận hành team-sdlc-pack

1. Cài: `pwsh -NoProfile -File install.ps1 -TeamWorkspace D:\mtm\<TEAM_ID>`.
2. Trust TeamWorkspace trong Codex (`%USERPROFILE%\.codex\config.toml`):
   `[projects.'d:\mtm\<team_id>']` + `trust_level = "trusted"`.
3. Cấu hình máy (ngoài pack, không commit): `D:\mtm\<TEAM_ID>\team-sdlc-pack\local\machine.json`
   ```json
   {"databasePassword": "<mật khẩu role ứng dụng của PostgreSQL cục bộ>", "env": {}}
   ```
   `databasePassword` thay `CHANGE_ME` trong các biến `*_URL` của `.env.example`; `env` ghi đè từng biến.
4. Kiểm: `node scripts/check-distribution.mjs --team-workspace D:\mtm\<TEAM_ID>` phải ra `READY`.
5. Player: `/manage` → Load team pack → Initialize Match.

Log lệnh của helper: `matches/<matchId>/.team-work/logs/`. Journal: `.team-work/journal.json`.
