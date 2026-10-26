# Backlog Agent — Master the Machine 2026

Digital Project Team tự động xử lý backlog TASK / CR / BUG / PI trong trận đấu. Lúc thi, hệ thống là một
**team pack** (`team-sdlc-pack`) chạy trong **MTM Player** của BTC: Player khởi chạy một phiên Codex
làm `team_orchestrator`, pack của đội cung cấp MCP helper, skill và agent profile.

**Đọc trước:** [`docs/team-pack/README.md`](docs/team-pack/README.md) (thiết kế hiện hành, lộ trình, rủi ro).

## Cấu trúc

```
backlog-agent/
├── docs/
│   ├── team-pack/       thiết kế hiện hành (13 file)
│   ├── btc/             tài liệu của BTC: guide, luật chơi, Q&A, API (NDA)
│   └── legacy/          kiến trúc cũ, đã thay thế
├── vendor/              phần mềm của BTC, chỉ đọc: mtm-player-0.9.33/ (gitignore), team-orchestrator-pack-0.5.1/
├── agents/              prompt tiếng Anh (luật, vai trò, skill theo loại item, stack): nguồn để port sang skill của pack
├── samples/             repo mẫu, item mẫu, kịch bản, mock: fixture cho test
│
│   — legacy: Python orchestrator gọi `codex exec`; giữ để port gate / nhận diện stack / log condenser / Jev —
├── orchestrator/        code Python
├── fake_gamemaster/     Game Master giả (Python)
├── monitor/             trang monitor cũ (thay bằng dashboard của Player)
├── config/              cấu hình agent, gate, Jev, Codex của bản cũ
└── tests/               test Python (không tốn $)
```

Sắp thêm theo lộ trình: `pack/` (nguồn team pack), `tools/` (mock Game Master, fake root, build ZIP),
`tests/pack/` (test Node).

## Lệnh

```bash
py -3.13 -m unittest discover -s tests -v      # test của bản Python cũ (Python 3.11+)
```

## Trạng thái

| Phần | Trạng thái |
|---|---|
| Bộ tài liệu thiết kế `docs/team-pack/` | Xong v1.0 (25/10) |
| Spike với server thật (đăng nhập trang trận, Practice #1) | Chưa làm (server mở 26/10) |
| Team pack (`pack/`): khung, installer, checker | Chưa dựng |
| MCP helper (Node) | Chưa dựng |
| Skill và agent profile | Chưa dựng (port từ `agents/`) |
| Python orchestrator | Legacy; gate, profile, logs, Jev sẽ được port |
