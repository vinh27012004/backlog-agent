# Backlog Agent — Master the Machine 2026

Digital Development Team tự động xử lý backlog TASK / CR / BUG / PI trong trận đấu.
Hệ thống được dựng bằng Claude, lúc thi chạy bằng **Codex CLI** (`codex exec`).

## Cấu trúc

```
backlog-agent/
├── docs/
│   ├── ARCHITECTURE.md    kiến trúc, gate, PI, log, ngân sách $50, hạ tầng, rủi ro
│   └── diagrams.html      2 bản vẽ: Architecture và Infrastructure
├── agents/                prompt các agent: luật chung, vai trò, skill, schema (xem agents/README.md)
├── config/                cấu hình agent, JEV và Codex (CODEX_HOME)
├── orchestrator/          code Python: chạy agent, nhận diện stack, SQLite, CLI
├── samples/               item mẫu và output mock
├── tests/                 test không tốn $
└── monitor/               trang monitor (đang dùng dữ liệu mẫu v0.2)
```

## Bắt đầu

```bash
python -m unittest discover -s tests -v                                   # Python 3.11+
python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --mock
python -m orchestrator.cli decide triage --item samples/items/PI-03.json --mock   # JEV (TypeSafe)
python -m orchestrator.cli runs
```

`config/codex-home/config.toml` là cấu hình Codex được quản lý trong repo; session và thông tin đăng nhập Codex phát sinh tại đây sẽ không được commit.

Monitor: mở `monitor/index.html` bằng trình duyệt.

## Trạng thái

| Phần | Trạng thái |
|---|---|
| Agent Codex: fixer (tự phân tích + 4 skill), reviewer, PI hypothesis | Đã dựng, test bằng mock và codex giả |
| JEV (TypeSafe): client + 6 điểm quyết định có luật dự phòng | Đã dựng, test bằng server giả; cần `TYPESAFE_API_KEY` để chạy thật |
| Cấu hình Codex | Đã kiểm với codex-cli 0.162.1 |
| Gate | Chưa dựng |
| MCP tool: codegraph, runner, web | Chưa dựng (đã khai báo, đang tắt) |
| Orchestrator: theo dõi /match, hàng đợi, worktree, nộp bài | Chưa dựng |
| Game Master giả | Chưa dựng |
| Monitor đọc SQLite | Chưa nối |
