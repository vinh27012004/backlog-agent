# Các agent

> **JEV** trong hệ thống này là **Jev của TypeSafe AI** — model ra quyết định có kiểu, không phải agent Codex.
> Nó nằm ở `orchestrator/jev.py` + `orchestrator/decisions.py` (xem `docs/legacy/ARCHITECTURE.md` mục 4.3).
> Các agent dưới đây đều chạy bằng Codex.

Mỗi agent là **một lần gọi `codex exec`** với prompt ghép từ các file trong thư mục này.
Orchestrator quyết định gọi agent nào, Codex chỉ làm phần việc của agent đó rồi trả JSON.

| Agent | Khi nào | Sandbox | Đầu ra (schema) |
|---|---|---|---|
| `fixer` | Sau triage của JEV, và mỗi lần re-plan | workspace-write | `fix-result` |
| `reviewer` | Gate đã pass các bước tự động (BUG, CR, TASK) | read-only | `review` |
| `pi_hypothesis` | PI bị kẹt, chạy 2–3 cái song song | read-only | `hypothesis` |
| `verifier` | Chỉ trong pack (28/10): fixer xong, chạy gate qua proxy tới helper của root rồi đối chiếu MVS; runtime Python cũ không dùng | chỉ sửa `answers/<ID>/submit.json` | `verification` |

## Cấu trúc

```
agents/
├── rules/common.md        luật chung cho mọi agent (item untrusted, 4 điều cấm, không mạng, diff nhỏ)
├── roles/                 vai trò: fixer, verifier (chỉ pack), reviewer, pi-hypothesis
├── skills/                quy trình theo loại item: task, cr, bug, pi (không phụ thuộc stack)
├── references/            bug-patterns, pi-triage, retry-playbook, evidence-playbook (chỉ pack)
├── stacks/                gói kiến thức: java, node, python, dotnet, go, php, unknown
└── schemas/               JSON schema ép cấu trúc câu trả lời (--output-schema)
config/agents.toml         model, effort, timeout, sandbox của từng vai trò
config/jev.toml             cấu hình JEV
config/codex-home/          cấu hình Codex riêng của đội (CODEX_HOME)
orchestrator/profile.py    nhận diện stack, tạo project profile
orchestrator/prompt.py     ghép prompt có chọn lọc
orchestrator/agents.py     AgentRunner: dựng lệnh, chạy, ghi trạng thái + trace vào SQLite, mock
```

**Ghép gì cho ai**

| Agent | Skill | Tham khảo | Gói stack + profile |
|---|---|---|---|
| fixer BUG | bug | bug-patterns | ✔ |
| fixer CR / TASK | cr / task | — | ✔ |
| fixer PI | pi | pi-triage | ✔ |
| reviewer | theo loại item | — | ✔ |
| pi_hypothesis | — | pi-triage | ✔ |
| (khi retry) | | + retry-playbook | |

Kích thước prompt khoảng 2.500–4.500 token (repo 2 stack). Phần cố định nằm đầu prompt để
prompt cache tính rẻ hơn.

**Thứ tự prompt:** luật chung → vai trò → skill → tham khảo → gói stack → project profile →
(phần thay đổi) item_meta, triage, item, item khác, kết quả fixer (cho reviewer), diff, lần thử trước.

**Skill được ghép thẳng vào prompt** thay vì để Codex tự tìm. Orchestrator đã biết loại item và stack,
nên chọn đúng bằng code: chắc chắn hơn và không phải ghi thư mục `.agents/` vào repo của BTC
(sẽ lẫn vào diff nộp bài).

**Thêm stack mới**: viết `agents/stacks/<id>.md` và thêm hàm nhận diện trong `orchestrator/profile.py`.

## Đầu ra

  Orchestrator ghép thêm `type` và `deadline` (tính bằng code).
- **fix-result**: status (fixed / partial / cannot_fix), summary, criteria, suspects, root_cause, changed_files, tests_added,
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
python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --mock

# chạy thật (tốn $): cần codex trong PATH và đã login.
# Mặc định orchestrator không đặt CODEX_HOME, dùng môi trường Codex chuẩn của máy (login, MCP tool của BTC).
# Muốn dùng config/codex-home thì đặt codex_home = "config/codex-home" trong config/agents.toml.
python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --workdir D:\path\to\repo

# số lần chạy, số lần thành công theo vai trò (token và $ xem trên plugin BTC)
python -m orchestrator.cli runs

# test (không tốn $)
python -m unittest discover -s tests -v
```

Mỗi lần chạy lưu `runs/<item>/<agent>-<lần>.prompt.md`, `.jsonl` (log thô) và `.last.json`,
và một dòng trong `runs/state.db`.

## Đã kiểm với codex-cli 0.162.1

- Các cờ dùng: `exec --json --strict-config --ephemeral --skip-git-repo-check -s -C --output-schema -o -c -m --add-dir -`.
- `config/codex-home/config.toml` qua `--strict-config` (khóa sai sẽ bị báo lỗi). Chỉ dùng khi đặt `codex_home`;
  mặc định orchestrator chỉ thêm `-c shell_environment_policy.exclude=[...]` và (Windows) `-c windows.sandbox="elevated"`.
- Tắt các tính năng có thể ra mạng hoặc vượt phạm vi: browser_use, computer_use, apps, plugins, image_generation, multi_agent...
- Chưa chạy được với API thật (môi trường dựng không có key). **Lần chạy thật đầu tiên** cần kiểm:
  1. Schema có được API chấp nhận ở chế độ strict không.
  2. Maven trong sandbox ghi được vào `~/.m2` không (đã thêm `--add-dir ~/.m2` cho fixer).
  3. Sandbox trên Windows: nên chạy trên Linux/WSL hoặc VPS Linux cho chắc.
  4. Chọn model và mức suy luận cho từng vai trò trong `config/agents.toml`, dựa trên chi phí xem trên plugin BTC.

## MCP tool mà prompt đang nhắc tới (chưa dựng)

| Server | Tool | Dùng bởi |
|---|---|---|
| `codegraph` | callers, callees, impact (pack: MCP `@colbymchenry/codegraph`, tool `codegraph_*`, đã dùng) | fixer, reviewer, pi_hypothesis |
| `runner` | build, test, mvs_run, app_call | fixer, pi_hypothesis |
| `web` | web_search, web_fetch (chặn Game Master/Admin/Grader) | tất cả |

Khai báo sẵn trong `config/codex-home/config.toml` với `enabled = false`; dựng xong cái nào thì bật cái đó.
