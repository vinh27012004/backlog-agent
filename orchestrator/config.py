"""Đọc config/agents.toml và gộp cấu hình theo vai trò + loại item."""
from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITEM_ID_RE = re.compile(r"^(TASK|CR|BUG|PI)-\d+$", re.IGNORECASE)
ITEM_TYPES = ("TASK", "CR", "BUG", "PI")


def item_type(item_id: str) -> str:
    """Loại item lấy từ tiền tố mã (TASK-01 → TASK). Không cần LLM."""
    m = ITEM_ID_RE.match(item_id.strip())
    if not m:
        raise ValueError(f"Mã item không đúng dạng TYPE-NN: {item_id!r}")
    return m.group(1).upper()


@dataclass
class RoleConfig:
    name: str            # khóa trong [roles.*], vd. "fixer"
    role: str            # tên file prompt trong agents/roles/, vd. "fixer"
    schema: str          # tên schema trong agents/schemas/, vd. "fix-result"
    sandbox: str
    model: str
    effort: str
    timeout_sec: int
    codex_bin: str
    codex_home: Path | None    # None: không đặt CODEX_HOME, dùng môi trường Codex của máy thi
    add_dirs: list[Path] = field(default_factory=list)

    @property
    def schema_path(self) -> Path:
        return ROOT / "agents" / "schemas" / f"{self.schema}.schema.json"


def _resolve(p: str) -> Path:
    path = Path(os.path.expanduser(p))
    return path if path.is_absolute() else (ROOT / path)


class AgentsConfig:
    def __init__(self, path: Path | None = None):
        self.path = path or (ROOT / "config" / "agents.toml")
        with open(self.path, "rb") as f:
            self.raw = tomllib.load(f)
        self.defaults = self.raw.get("defaults", {})
        self.roles = self.raw.get("roles", {})
        self.tiers = self.raw.get("tiers", {})

    def role(self, name: str, itype: str | None = None, tier: str | None = None) -> RoleConfig:
        if name not in self.roles:
            raise KeyError(f"Không có vai trò {name!r} trong {self.path}")
        merged = {**self.defaults}
        base = {k: v for k, v in self.roles[name].items() if k != "by_type"}
        merged.update(base)
        if itype:
            merged.update(self.roles[name].get("by_type", {}).get(itype, {}))
        if tier:
            if tier not in self.tiers:
                raise KeyError(f"Không có tier {tier!r} trong {self.path} (có: {sorted(self.tiers)})")
            merged.update(self.tiers[tier])
        return RoleConfig(
            name=name,
            role=merged.get("role", name),
            schema=merged["schema"],
            sandbox=merged.get("sandbox", "read-only"),
            model=merged.get("model", ""),
            effort=merged.get("effort", "medium"),
            timeout_sec=int(merged.get("timeout_sec", 900)),
            codex_bin=merged.get("codex_bin", "codex"),
            codex_home=_resolve(merged["codex_home"]) if merged.get("codex_home") else None,
            add_dirs=[_resolve(d) for d in merged.get("add_dirs", [])],
        )
