# Tài liệu

| Thư mục | Nội dung | Trạng thái |
|---|---|---|
| [`team-pack/`](team-pack/README.md) | **Thiết kế hiện hành**: team pack chạy trong MTM Player (kiến trúc, hợp đồng Player, Game Master, progress log, MCP helper, agent/skill, quy trình trận, guardrails, đóng gói, kiểm thử, lộ trình, rủi ro) | Đang dùng. Bắt đầu đọc từ đây |
| [`btc/`](btc/) | Tài liệu của BTC: technical guide 0.5.1, luật chơi, Q&A, API Start work/Submit | Nguồn gốc, chỉ đọc. NDA, không công khai |
| [`legacy/`](legacy/ARCHITECTURE.md) | Kiến trúc cũ (Python orchestrator gọi `codex exec`) và bản vẽ của nó | Đã thay thế; giữ để tham chiếu khi port code |

## Tài liệu của BTC

| File | Là gì |
|---|---|
| [`btc/technical-guide-0.5.1.md`](btc/technical-guide-0.5.1.md) | Guide dựng Team Orchestrator (bản text). BTC cảnh báo có thể cố tình gây nhiễu; các chỗ sai đã đối chiếu ở [`team-pack/README.md`](team-pack/README.md#những-chỗ-guide-khác-thực-tế-đã-kiểm-chứng) |
| [`btc/MTM_Game_Rules.md`](btc/MTM_Game_Rules.md) | Luật chơi vòng thực chiến (chuyển từ slide [`MTM_Game_Rules.html`](btc/MTM_Game_Rules.html)) |
| [`btc/Q&A.md`](btc/Q&A.md) | Hỏi đáp với BTC, gom theo chủ đề, số `#n` theo bảng gốc |
| [`btc/digital-cuder-api-start-submit.html`](btc/digital-cuder-api-start-submit.html) | Đặc tả API Start Work và Submit. Bản tóm tắt tiếng Việt: [`team-pack/03-game-master.md`](team-pack/03-game-master.md) |

Phần mềm của BTC (MTM Player 0.9.39, sample pack 0.5.1) nằm ở [`../vendor/`](../vendor/).
