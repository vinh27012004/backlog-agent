# Backlog Agent — Master the Machine 2026

Digital Development Team tự động xử lý backlog TASK / CR / BUG / PI trong trận đấu.
Hệ thống được dựng bằng Claude, lúc thi chạy bằng **Codex CLI** (`codex exec`).

## Cấu trúc

```
backlog-agent/
├── docs/
│   ├── ARCHITECTURE.md    kiến trúc v0.3, gate, PI, log, ngân sách $50, hạ tầng, rủi ro
│   └── diagrams.html      2 bản vẽ: Architecture và Infrastructure
├── agents/                prompt các agent: luật chung, vai trò, skill, schema (xem agents/README.md)
├── codex-home/            cấu hình Codex của đội (CODEX_HOME)
├── config/agents.toml     model, effort, timeout, sandbox từng vai trò; bảng giá
├── orchestrator/          code Python: chạy agent, đọc token, SQLite, CLI
├── samples/               item mẫu và output mock
├── tests/                 test không tốn $
└── monitor/               trang monitor (đang dùng dữ liệu mẫu v0.2)
```

## Bắt đầu

```bash
python -m unittest discover -s tests -v                                   # Python 3.11+
python -m orchestrator.cli agent jev --item samples/items/BUG-07.json --mock
python -m orchestrator.cli cost
```

Monitor: mở `monitor/index.html` bằng trình duyệt.

## Trạng thái

| Phần | Trạng thái |
|---|---|
| Agent: JEV, fixer (4 skill), reviewer, PI hypothesis | Đã dựng, test bằng mock và codex giả |
| Cấu hình Codex | Đã kiểm với codex-cli 0.162.1 |
| Gate | Chưa dựng |
| MCP tool: codegraph, runner, web | Chưa dựng (đã khai báo, đang tắt) |
| Orchestrator: theo dõi /match, hàng đợi, worktree, nộp bài | Chưa dựng |
| Game Master giả | Chưa dựng |
| Monitor đọc SQLite | Chưa nối |
