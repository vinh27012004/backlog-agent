"""Mỗi item một git worktree, tách khỏi repo chính để chạy song song và để diff nộp bài chỉ có thay đổi của item.

    ws = Workspaces(repo, ROOT / "runs" / "worktrees")
    path = ws.create("BUG-07")        # worktree ở commit gốc (detached), tạo lại nếu đã có
    ws.reset(path)                    # mỗi lần thử bắt đầu từ trạng thái sạch
    sha = ws.commit(path, "BUG-07: sửa coupon")     # lúc nộp: commit thay đổi của item
    ws.push(sha, "origin", "mtm/BUG-07")            # gitRevision = sha
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


def init_sample_repo(template: Path, dest: Path, *, bare_remote: Path | None = None) -> Path:
    """Chép repo mẫu (samples/repo-template) ra `dest` và tạo git repo có 1 commit, để chạy trận giả.
    `bare_remote`: tạo thêm một bare repo làm `origin`, để trận giả push thật như repo GitHub của đội."""
    dest = Path(dest)
    shutil.copytree(template, dest, ignore=shutil.ignore_patterns("__pycache__"))
    for args in (["init", "-q"], ["config", "user.email", "bot@example.com"], ["config", "user.name", "bot"],
                 ["config", "core.autocrlf", "false"], ["add", "-A"], ["commit", "-q", "-m", "base"]):
        _git(dest, *args)
    if bare_remote is not None:
        bare_remote = Path(bare_remote).resolve()
        bare_remote.parent.mkdir(parents=True, exist_ok=True)
        _git(dest, "init", "-q", "--bare", str(bare_remote))
        _git(dest, "remote", "add", "origin", str(bare_remote))
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

    def commit(self, path: Path, message: str, *, author: tuple[str, str] = ("mtm-bot", "mtm-bot@example.com")) -> str:
        """Commit mọi thay đổi trong worktree (gồm file mới, trừ file bị ignore), trả về sha.
        Không có gì để commit thì trả về sha hiện tại."""
        _git(path, "add", "-A")
        if _git(path, "status", "--porcelain"):
            name, email = author
            _git(path, "-c", f"user.name={name}", "-c", f"user.email={email}", "commit", "-q", "--no-verify",
                 "-m", message)
        return _git(path, "rev-parse", "HEAD")

    def push(self, sha: str, remote: str, branch: str) -> str:
        """Push `sha` lên nhánh riêng của item, trả về nhánh đã dùng. Không bao giờ ghi đè: nhánh đã trỏ
        commit khác (chạy lại sau crash, có thể commit cũ đã được nộp) thì push sang `<branch>-<sha8>`.
        Push lại cùng sha vẫn an toàn."""
        try:
            _git(self.repo, "push", "-q", "--no-verify", remote, f"{sha}:refs/heads/{branch}")
            return branch
        except RuntimeError as e:
            if "rejected" not in str(e):                 # lỗi mạng / quyền: để bên gọi thử lại
                raise
        alt = f"{branch}-{sha[:8]}"
        _git(self.repo, "push", "-q", "--no-verify", remote, f"{sha}:refs/heads/{alt}")
        return alt

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
