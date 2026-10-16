"""Ghép prompt cho từng lần gọi codex exec.

Thứ tự: phần cố định trước (luật chung → vai trò → skill → tài liệu tham khảo → gói stack →
project profile), phần thay đổi sau (item, brief, diff, lần thử trước). Phần đầu giống nhau
giữa các lần gọi nên được prompt cache của API tính rẻ hơn (cached_input_tokens).

Chỉ ghép thứ cần cho việc đang làm:
  - skill theo loại item: fixer, reviewer
  - bug-patterns: fixer BUG
  - pi-triage: fixer PI, pi_hypothesis
  - retry-playbook: khi có lần thử trước
  - gói stack: theo profile (monorepo có thể nhiều gói)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import ROOT, item_type
from .profile import compact, stack_ids

AGENTS = ROOT / "agents"
SKILL_DIR = {"TASK": "task", "CR": "cr", "BUG": "bug", "PI": "pi"}
ROLES_WITH_SKILL = {"fixer", "reviewer"}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4 :].strip()
    return text


def _skill_body(itype: str) -> str:
    return _strip_frontmatter(_read(AGENTS / "skills" / SKILL_DIR[itype] / "SKILL.md"))


def _fence(tag: str, content: Any) -> str:
    """Bọc dữ liệu, chặn việc nội dung tự đóng thẻ để chèn lệnh."""
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False, indent=2)
    content = content.replace(f"</{tag}", f"<\\/{tag}")
    return f"<{tag}>\n{content}\n</{tag}>"


def references_for(role: str, itype: str, retry: bool) -> list[str]:
    refs = []
    if role == "fixer" and itype == "BUG":
        refs.append("bug-patterns")
    if (role == "fixer" and itype == "PI") or role == "pi-hypothesis":
        refs.append("pi-triage")
    if retry:
        refs.append("retry-playbook")
    return refs


def stack_packs(profile: dict | None) -> list[str]:
    if profile is None:
        return []
    ids = stack_ids(profile)
    known = [i for i in ids if (AGENTS / "stacks" / f"{i}.md").exists()]
    return known or ["unknown"]


def build_prompt(
    role: str,
    item: dict,
    *,
    profile: dict | None = None,
    deadline_min: float | None = None,
    brief: dict | None = None,
    other_items: list[dict] | None = None,
    diff: str | None = None,
    gate_report: str | None = None,
    previous_attempt: dict | None = None,
    hypothesis: str | None = None,
) -> str:
    itype = item_type(item["id"])
    parts = [_read(AGENTS / "rules" / "common.md"), _read(AGENTS / "roles" / f"{role}.md")]
    if role in ROLES_WITH_SKILL:
        parts.append(f"# Skill for {itype}\n\n{_skill_body(itype)}")

    for ref in references_for(role, itype, previous_attempt is not None):
        parts.append(_fence(ref.replace("-", "_"), _read(AGENTS / "references" / f"{ref}.md")))

    packs = stack_packs(profile)
    if packs:
        parts.append("# Stack notes\n\n" + "\n\n".join(_read(AGENTS / "stacks" / f"{p}.md") for p in packs))
        parts.append(
            "Use the commands in <project_profile> (replace {target} with the test file/class/name). "
            "If a command fails for reasons unrelated to your change, find the right one from the build "
            "files and report it in `verification`.\n\n" + _fence("project_profile", compact(profile))
        )

    meta = {"id": item["id"], "type": itype}
    if deadline_min is not None:
        meta["minutes_left"] = round(deadline_min, 1)
    parts.append("# Task data\n\n" + _fence("item_meta", meta))
    if brief is not None:
        parts.append(_fence("brief", brief))
    parts.append(_fence("item", item))
    if other_items:
        parts.append(_fence("other_items", other_items))
    if diff is not None:
        parts.append(_fence("diff", diff))
    if gate_report is not None:
        parts.append(_fence("gate_report", gate_report))
    if previous_attempt is not None:
        parts.append(_fence("previous_attempt", previous_attempt))
    if hypothesis is not None:
        parts.append(_fence("hypothesis", hypothesis))

    parts.append("Return only the final JSON object that matches the output schema.")
    return "\n\n".join(parts) + "\n"
