"""Mỗi item một git worktree, tách khỏi repo chính để chạy song song và để diff nộp bài chỉ có thay đổi của item.

    ws = Workspaces(repo, ROOT / "runs" / "worktrees")
    path = ws.create("BUG-07")        # worktree ở commit gốc (detached), tạo lại nếu đã có
    ws.reset(path)                    # mỗi lần thử bắt đầu từ trạng thái sạch
    ws.remove(path)

Orchestrator giữ git: agent không commit, không đổi branch (agents/rules/common.md).
`reset` dùng `git clean -fd` (không có -x) để giữ file bị ignore như target/, node_modules/: build lại nhanh hơn.
"""
from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path


def _git(cwd: Path, *args: str) -> str:
    res = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True,
                         encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {res.stderr.strip()}")
    return res.stdout.strip()


def init_sample_repo(template: Path, dest: Path) -> Path:
    """Chép repo mẫu (samples/repo-template) ra `dest` và tạo git repo có 1 commit, để chạy trận giả."""
    dest = Path(dest)
    shutil.copytree(template, dest, ignore=shutil.ignore_patterns("__pycache__"))
    for args in (["init", "-q"], ["config", "user.email", "bot@example.com"], ["config", "user.name", "bot"],
                 ["config", "core.autocrlf", "false"], ["add", "-A"], ["commit", "-q", "-m", "base"]):
        _git(dest, *args)
    return dest


class Workspaces:
    def __init__(self, repo: Path, root: Path, base: str = "HEAD"):
        self.repo = Path(repo).resolve()
        self.root = Path(root).resolve()
        self.base = _git(self.repo, "rev-parse", base)      # ghim sha: repo chính đổi cũng không ảnh hưởng
        self._lock = threading.Lock()                        # git worktree add/remove song song dễ đụng khóa .git

    def path_for(self, item_id: str) -> Path:
        return self.root / item_id

    def create(self, item_id: str) -> Path:
        with self._lock:
            return self._create(item_id)

    def _create(self, item_id: str) -> Path:
        path = self.path_for(item_id)
        if path.exists():
            if self._is_worktree(path):
                self.reset(path)
                return path
            shutil.rmtree(path, ignore_errors=True)
        _git(self.repo, "worktree", "prune")
        self.root.mkdir(parents=True, exist_ok=True)
        _git(self.repo, "worktree", "add", "--detach", "-f", str(path), self.base)
        return path

    def reset(self, path: Path) -> None:
        _git(path, "reset", "-q", "--hard", self.base)
        _git(path, "clean", "-fdq")

    def remove(self, path: Path) -> None:
        with self._lock:
            try:
                _git(self.repo, "worktree", "remove", "--force", str(path))
            except RuntimeError:
                shutil.rmtree(path, ignore_errors=True)
                _git(self.repo, "worktree", "prune")

    def _is_worktree(self, path: Path) -> bool:
        listing = _git(self.repo, "worktree", "list", "--porcelain")
        wanted = path.resolve().as_posix().lower()
        return any(line[len("worktree "):].replace("\\", "/").lower() == wanted
                   for line in listing.splitlines() if line.startswith("worktree "))
