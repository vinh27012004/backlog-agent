# Các agent

Mỗi agent là **một lần gọi `codex exec`** với prompt ghép từ các file trong thư mục này.
Orchestrator quyết định gọi agent nào, Codex chỉ làm phần việc của agent đó rồi trả JSON.

| Agent | Khi nào | Sandbox | Đầu ra (schema) |
|---|---|---|---|
| `jev` | Có item mới | read-only | `brief` |
| `fixer` | Sau JEV, và mỗi lần re-plan | workspace-write | `fix-result` |
| `reviewer` | Gate đã pass các bước tự động (BUG, CR, TASK) | read-only | `review` |
| `pi_hypothesis` | PI bị kẹt, chạy 2–3 cái song song | read-only | `hypothesis` |

## Cấu trúc

```
agents/
├── rules/common.md        luật chung cho mọi agent (item untrusted, 4 điều cấm, không mạng, diff nhỏ)
├── roles/                 vai trò: jev, fixer, reviewer, pi-hypothesis
├── skills/                quy trình theo loại item: task, cr, bug, pi (không phụ thuộc stack)
├── references/            bug-patterns, pi-triage, retry-playbook
├── stacks/                gói kiến thức: java, node, python, dotnet, go, php, unknown
└── schemas/               JSON schema ép cấu trúc câu trả lời (--output-schema)
codex-home/config.toml     cấu hình Codex riêng của đội (CODEX_HOME)
config/agents.toml         model, effort, timeout, sandbox của từng vai trò; bảng giá
orchestrator/profile.py    nhận diện stack, tạo project profile
orchestrator/prompt.py     ghép prompt có chọn lọc
orchestrator/agents.py     AgentRunner: dựng lệnh, chạy, đọc token, ghi SQLite, mock
```

**Ghép gì cho ai**

| Agent | Skill | Tham khảo | Gói stack + profile |
|---|---|---|---|
| jev | — | — | ✔ |
| fixer BUG | bug | bug-patterns | ✔ |
| fixer CR / TASK | cr / task | — | ✔ |
| fixer PI | pi | pi-triage | ✔ |
| reviewer | theo loại item | — | ✔ |
| pi_hypothesis | — | pi-triage | ✔ |
| (khi retry) | | + retry-playbook | |

Kích thước prompt khoảng 2.500–4.500 token (repo 2 stack). Phần cố định nằm đầu prompt để
prompt cache tính rẻ hơn.

**Thứ tự prompt:** luật chung → vai trò → skill → tham khảo → gói stack → project profile →
(phần thay đổi) item_meta, brief, item, item khác, diff, lần thử trước.

**Skill được ghép thẳng vào prompt** thay vì để Codex tự tìm. Orchestrator đã biết loại item và stack,
nên chọn đúng bằng code: chắc chắn hơn và không phải ghi thư mục `.agents/` vào repo của BTC
(sẽ lẫn vào diff nộp bài).

**Thêm stack mới**: viết `agents/stacks/<id>.md` và thêm hàm nhận diện trong `orchestrator/profile.py`.

## Đầu ra

- **brief**: summary, criteria, symptoms (PI), suspects, related, difficulty, est_files_to_change, ambiguities.
  Orchestrator ghép thêm `type` và `deadline` (tính bằng code).
- **fix-result**: status (fixed / partial / cannot_fix), summary, root_cause, changed_files, tests_added,
  verification, needs_dependency, risks, confidence.
- **review**: verdict (approve / request_changes), root_cause_addressed, issues (high / medium / low), summary.
- **hypothesis**: verdict (supported / refuted / inconclusive), evidence, fix_location, next_check.

## Chạy thử

```bash
# nhận diện stack của repo
python -m orchestrator.cli profile D:\path\to\repo

# xem prompt sẽ gửi (không tốn $)
python -m orchestrator.cli prompt fixer --item samples/items/BUG-07.json --repo D:\path\to\repo

# chạy chế độ mock (phát lại output mẫu, không tốn $)
python -m orchestrator.cli agent jev --item samples/items/BUG-07.json --mock

# chạy thật (tốn $): cần codex trong PATH và đã login trong codex-home
set CODEX_HOME=D:\CODE\backlog-agent\codex-home     # Windows
codex login --with-api-key < key.txt                  # key BTC cấp
python -m orchestrator.cli agent jev --item samples/items/BUG-07.json --workdir D:\path\to\repo

# tổng token và $ đã dùng
python -m orchestrator.cli cost

# test (không tốn $)
python -m unittest discover -s tests -v
```

Mỗi lần chạy lưu `runs/<item>/<agent>-<lần>.prompt.md`, `.jsonl` (log thô) và `.last.json`,
và một dòng trong `runs/state.db`.

## Đã kiểm với codex-cli 0.162.1

- Các cờ dùng: `exec --json --strict-config --ephemeral --skip-git-repo-check -s -C --output-schema -o -c -m --add-dir -`.
- `codex-home/config.toml` qua `--strict-config` (khóa sai sẽ bị báo lỗi).
- Tắt các tính năng có thể ra mạng hoặc vượt phạm vi: browser_use, computer_use, apps, plugins, image_generation, multi_agent...
- Chưa chạy được với API thật (môi trường dựng không có key). **Lần chạy thật đầu tiên** cần kiểm:
  1. Schema có được API chấp nhận ở chế độ strict không.
  2. Maven trong sandbox ghi được vào `~/.m2` không (đã thêm `--add-dir ~/.m2` cho fixer).
  3. Sandbox trên Windows: nên chạy trên Linux/WSL hoặc VPS Linux cho chắc.
  4. Số token thật của mỗi agent → điền `[pricing]` và chọn model trong `config/agents.toml`.

## MCP tool mà prompt đang nhắc tới (chưa dựng)

| Server | Tool | Dùng bởi |
|---|---|---|
| `codegraph` | callers, callees, impact, system_map | jev, fixer, reviewer, pi_hypothesis |
| `runner` | build, test, mvs_run, app_call | fixer, pi_hypothesis |
| `web` | web_search, web_fetch (chặn Game Master/Admin/Grader) | tất cả |

Khai báo sẵn trong `codex-home/config.toml` với `enabled = false`; dựng xong cái nào thì bật cái đó.
