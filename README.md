# Backlog Agent — Master the Machine 2026

Digital Project Team tự động xử lý backlog TASK / CR / BUG / PI trong trận đấu. Lúc thi, hệ thống là một
**team pack** (`team-sdlc-pack`) chạy trong **MTM Player** của BTC: Player khởi chạy một phiên Codex
làm `team_orchestrator`, pack của đội cung cấp MCP helper, skill và agent profile.

**Đọc trước:** [`docs/team-pack/README.md`](docs/team-pack/README.md) (thiết kế hiện hành, lộ trình, rủi ro).

## Cấu trúc

```
backlog-agent/
├── pack/                team-sdlc-pack: helper MCP (src/), agent profile (agents/), skill (skills/),
│                        contract (contracts/), cấu hình (config/), installer và checker (scripts/)
├── tests/pack/          test Node của pack (không tốn $)
├── tools/judge/         chấm lại trận practice (skill /judge-practice)
├── docs/
│   ├── team-pack/       thiết kế hiện hành, practice log
│   └── btc/             tài liệu của BTC: guide, luật chơi, Q&A, API (NDA)
└── vendor/              phần mềm của BTC, chỉ đọc: mtm-player-0.9.39/ (gitignore), team-orchestrator-pack-0.5.1/
```

Bản Python orchestrator cũ (gọi `codex exec`), prompt `agents/` và fixture `samples/` đã xoá ngày 30/10 sau khi
port xong; còn ở commit `76d4807`.

## Lệnh

```bash
node --test "tests/pack/*.test.mjs"                                  # test của pack
pwsh -NoProfile -File pack/install.ps1 -TeamWorkspace D:\mtm\BUN     # cài pack cho practice (-Force khi đã có round)
```
