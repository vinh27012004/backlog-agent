"""Gate: orchestrator tự kiểm bản sửa trước khi nộp, không tin lời agent (mỗi item chỉ nộp được 1 lần).

    gate = Gate(profile, store=store)
    rep = gate.run(item, worktree, fix_result=fix.output, attempt=1)
    rep.passed, rep.fail_kind, rep.signature, rep.mvs_passed
    runner.run("reviewer", item, ..., gate_report=rep.to_text())
    runner.run("fixer", item, ..., attempt=2, previous_attempt=rep.previous_attempt())

Thứ tự, rẻ trước và dừng ở bước fail đầu tiên: diff → build → test agent viết → regression → MVS.
`fail_kind` khớp bảng trong agents/references/retry-playbook.md.

Gate chạy NGOÀI sandbox Codex. Vì vậy tên test do agent khai được lọc ký tự trước khi ghép vào
lệnh shell, và biến môi trường chứa KEY/TOKEN/SECRET/PASSWORD hoặc GM_* bị bỏ khỏi lệnh.
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import time
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import ROOT, item_type
from .logs import compile_errors, condense, signature
from .store import Store

GATE_TOML = ROOT / "config" / "gate.toml"
RUNS_DIR = ROOT / "runs"

TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs|testing)/"
    r"|(Tests?|IT|Spec)\.(java|kt|scala|cs|php)$"
    r"|(^|/)test_[^/]+\.py$|_test\.(py|go)$"
    r"|\.(test|spec)\.[cm]?[jt]sx?$",
    re.IGNORECASE,
)
ASSERTION = re.compile(r"(\bassert|\bexpect\s*\(|\.should\b|\bverify\s*\(|\bt\.(errorf?|fatalf?)\s*\()", re.IGNORECASE)
BUILD_FILES = {
    "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties",
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "Pipfile.lock", "poetry.lock",
    "go.mod", "go.sum", "composer.json", "composer.lock", "Directory.Build.props", "Directory.Packages.props",
}
BUILD_SUFFIXES = (".csproj", ".sln", ".fsproj")
CI_PATHS = (".github/", ".gitlab-ci.yml", ".circleci/", "Jenkinsfile", "azure-pipelines.yml", ".mvn/",
            "mvnw", "gradlew", "gradle/wrapper/")
NO_TESTS_RAN = re.compile(
    r"(Tests run: 0,|no tests ran|No tests found|collected 0 items|no tests to run|No test files|"
    r"\b0 passing\b|No tests were executed|No test matches)", re.IGNORECASE)
SAFE_TARGET = re.compile(r"^[\w.#:/\\\-\[\]@,]{1,200}$")
SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.IGNORECASE)
# cách ghép nhiều test vào một lệnh test_one (stack không có ở đây thì chạy từng test)
TARGET_JOIN = {"maven": ",", "pip": " ", "poetry": " ", "npm": " ", "pnpm": " ", "yarn": " ", "go": "|"}


@dataclass
class GateConfig:
    max_files: int = 15
    max_lines: int = 600
    max_targets: int = 8
    build_sec: int = 600
    test_sec: int = 900
    mvs_sec: int = 600
    flaky_rerun: bool = True

    @classmethod
    def load(cls, path: Path = GATE_TOML) -> "GateConfig":
        if not path.exists():
            return cls()
        with open(path, "rb") as f:
            raw = tomllib.load(f)
        flat = {**raw.get("limits", {}), **raw.get("timeouts", {}), **raw.get("tests", {})}
        return cls(**{k: v for k, v in flat.items() if k in cls.__dataclass_fields__})


@dataclass
class FileChange:
    path: str
    kind: str = "modified"          # added | modified | deleted
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    binary: bool = False

    @property
    def is_test(self) -> bool:
        return bool(TEST_PATH.search(self.path))


@dataclass
class Check:
    name: str                       # diff | forbidden | build | target_tests | regression | mvs | tests_declared
    status: str                     # pass | fail | warn | skipped
    note: str = ""
    command: str | None = None
    seconds: float = 0.0
    log_path: str | None = None


@dataclass
class GateReport:
    item_id: str
    attempt: int
    passed: bool
    fail_kind: str | None
    signature: str | None
    checks: list[Check]
    log: str                        # log rút gọn của bước fail, rỗng khi pass
    files_changed: int
    lines_changed: int
    mvs_passed: bool | None
    seconds: float

    def failed_check(self) -> Check | None:
        return next((c for c in self.checks if c.status == "fail"), None)

    def to_dict(self) -> dict:
        return asdict(self)

    def to_text(self) -> str:
        """Bản ngắn cho prompt (reviewer, Decider.claims_supported)."""
        head = "PASS" if self.passed else f"FAIL ({self.fail_kind})"
        lines = [f"gate: {head}"]
        if self.signature:
            lines.append(f"signature: {self.signature}")
        for c in self.checks:
            s = f"- {c.name}: {c.status}"
            if c.seconds:
                s += f" ({c.seconds}s)"
            if c.command:
                s += f" `{c.command}`"
            if c.note:
                s += f" — {c.note}"
            lines.append(s)
        if self.log:
            lines += ["log:", self.log]
        return "\n".join(lines)

    def previous_attempt(self) -> dict:
        """Dữ liệu cho `<previous_attempt>` khi fixer thử lại (worktree đã reset nên chỉ còn những gì ở đây)."""
        fc = self.failed_check()
        return {
            "attempt": self.attempt,
            "fail_kind": self.fail_kind,
            "signature": self.signature,
            "failed_check": fc.name if fc else None,
            "note": fc.note if fc else "",
            "command": fc.command if fc else None,
            "log": self.log,
        }


# ----------------------------------------------------------------------------- diff
def _git(workdir: Path, *args: str) -> str:
    res = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-C", str(workdir), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {res.stderr.strip()}")
    return res.stdout


def parse_diff(text: str) -> list[FileChange]:
    """Đọc `git diff --no-renames -U0`. Dòng `--- x` trong hunk (vd. xóa comment SQL) không bị nhầm là header."""
    files: list[FileChange] = []
    cur: FileChange | None = None
    in_hunk = False
    for line in text.splitlines():
        if line.startswith("diff --git "):
            s = line[len("diff --git a/"):]
            cur = FileChange(path=s[: (len(s) - 3) // 2])   # "X b/X" vì --no-renames nên a và b trùng nhau
            files.append(cur)
            in_hunk = False
        elif cur is None:
            continue
        elif line.startswith("@@"):
            in_hunk = True
        elif not in_hunk:
            if line.startswith("new file mode"):
                cur.kind = "added"
            elif line.startswith("deleted file mode"):
                cur.kind = "deleted"
            elif line.startswith("Binary files"):
                cur.binary = True
        elif line.startswith("+"):
            cur.added.append(line[1:])
        elif line.startswith("-"):
            cur.removed.append(line[1:])
    return files


def collect_diff(workdir: Path, base: str = "HEAD") -> list[FileChange]:
    """Thay đổi so với `base`, gồm cả file mới chưa track (agent không commit)."""
    changes = parse_diff(_git(workdir, "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", base))
    for path in _git(workdir, "ls-files", "--others", "--exclude-standard", "-z").split("\0"):
        if not path:
            continue
        try:
            text = (workdir / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            changes.append(FileChange(path, "added", binary=True))
        else:
            changes.append(FileChange(path, "added", added=text.splitlines()))
    return changes


def diff_text(workdir: Path, base: str = "HEAD", max_chars: int = 60_000) -> str:
    """Unified diff để đưa cho reviewer, gồm file mới chưa track."""
    out = _git(workdir, "diff", "--no-color", "--no-ext-diff", "--no-renames", base)
    for path in _git(workdir, "ls-files", "--others", "--exclude-standard", "-z").split("\0"):
        if not path:
            continue
        try:
            body = (workdir / path).read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            out += f"diff --git a/{path} b/{path}\nnew file (binary)\n"
            continue
        out += f"diff --git a/{path} b/{path}\nnew file\n--- /dev/null\n+++ b/{path}\n"
        out += "".join(f"+{ln}\n" for ln in body)
    return out if len(out) <= max_chars else out[:max_chars] + "\n...(diff bị cắt bớt)\n"


def forbidden_changes(changes: list[FileChange], skip_markers: list[str],
                      needs_dependency: list[str]) -> tuple[list[str], list[str]]:
    """Trả về (vi phạm, cảnh báo). Vi phạm làm gate fail với fail_kind `forbidden_change`."""
    bad: list[str] = []
    warn: list[str] = []
    for ch in changes:
        name = ch.path.rsplit("/", 1)[-1]
        if ch.path.startswith(CI_PATHS) or name in ("mvnw", "gradlew", "Jenkinsfile"):
            bad.append(f"sửa CI/wrapper: {ch.path}")
        elif name in BUILD_FILES or name.endswith(BUILD_SUFFIXES):
            if not needs_dependency:
                bad.append(f"sửa file build mà không khai needs_dependency: {ch.path}")
        if not ch.is_test:
            continue
        if ch.kind == "deleted":
            bad.append(f"xóa file test: {ch.path}")
            continue
        for line in ch.added:
            hit = next((m for m in skip_markers if m in line), None)
            if hit:
                bad.append(f"thêm marker skip {hit!r} vào {ch.path}")
                break
        lost = sum(bool(ASSERTION.search(x)) for x in ch.removed)
        gained = sum(bool(ASSERTION.search(x)) for x in ch.added)
        if lost > gained:
            bad.append(f"bớt {lost - gained} assertion trong {ch.path}")
        elif lost:
            warn.append(f"đổi {lost} dòng assertion có sẵn trong {ch.path}")
    return bad, warn


# ----------------------------------------------------------------------------- chạy lệnh
def _clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k) and not k.startswith("GM_")}


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def run_command(cmd: str, cwd: Path, timeout: int, log_path: Path) -> tuple[int | None, str, float]:
    """Chạy lệnh shell, ghi stdout+stderr ra file (không dùng pipe để khỏi treo khi tiến trình con giữ pipe).
    Trả về (mã thoát hoặc None nếu quá giờ, log, số giây)."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    t0 = time.time()
    with open(log_path, "wb") as f:
        proc = subprocess.Popen(cmd, shell=True, cwd=str(cwd), stdout=f, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=_clean_env(), **group)
        try:
            rc: int | None = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            rc = None
    return rc, log_path.read_text(encoding="utf-8", errors="replace"), round(time.time() - t0, 1)


def _under(path: str, root: str) -> bool:
    return root == "." or path == root or path.startswith(root.rstrip("/") + "/")


# ----------------------------------------------------------------------------- gate
class _Fail(Exception):
    def __init__(self, kind: str, log: str = "", sig: str | None = None):
        super().__init__(kind)
        self.kind, self.log, self.sig = kind, log, sig


class Gate:
    def __init__(self, profile: dict | None, *, config: GateConfig | None = None,
                 store: Store | None = None, runs_dir: Path = RUNS_DIR):
        self.profile = profile or {"primary": "unknown", "stacks": []}
        self.config = config or GateConfig.load()
        self.store = store
        self.runs_dir = runs_dir

    def run(self, item: dict, workdir: Path, fix_result: dict | None = None, *, attempt: int = 1,
            base: str = "HEAD", full_regression: bool = True, mvs_command: str | None = None) -> GateReport:
        workdir = Path(workdir).resolve()
        itype = item_type(item["id"])
        fix_result = fix_result or {}
        log_dir = self.runs_dir / item["id"]
        checks: list[Check] = []
        t0 = time.time()
        mvs_passed: bool | None = None
        n_files = n_lines = 0

        def exec_check(name: str, cmd: str, cwd: Path, timeout: int, *, rerun: bool = False):
            safe = re.sub(r"[^\w.\-]+", "_", name)
            rc, log, sec = run_command(cmd, cwd, timeout, log_dir / f"gate-{attempt}-{safe}.log")
            if rc not in (0, None) and rerun and self.config.flaky_rerun:
                rc2, log2, sec2 = run_command(cmd, cwd, timeout, log_dir / f"gate-{attempt}-{safe}-rerun.log")
                if rc2 == 0:
                    checks.append(Check(name, "pass", "fail lần đầu, pass khi chạy lại (flaky)", cmd, sec + sec2,
                                        str(log_dir / f"gate-{attempt}-{safe}-rerun.log")))
                    return 0, log2
            check = Check(name, "pass" if rc == 0 else "fail", "" if rc is not None else f"quá {timeout}s",
                          cmd, sec, str(log_dir / f"gate-{attempt}-{safe}.log"))
            checks.append(check)
            return rc, log

        def fail_from_log(rc: int | None, log: str, default_kind: str) -> _Fail:
            if rc is None:
                return _Fail("timeout", condense(log, root=str(workdir)), None)
            kind = "compile" if compile_errors(log, limit=1) else default_kind
            return _Fail(kind, condense(log, root=str(workdir)), signature(log, root=str(workdir)))

        try:
            # 1. diff: có thay đổi, không quá lớn, không vi phạm (chạy trước build vì build có thể sinh file rác)
            changes = collect_diff(workdir, base)
            n_files = len(changes)
            n_lines = sum(len(c.added) + len(c.removed) for c in changes)
            if not changes:
                checks.append(Check("diff", "fail", "không có thay đổi nào"))
                raise _Fail("no_change")
            too_big = n_files > self.config.max_files or n_lines > self.config.max_lines
            checks.append(Check("diff", "fail" if too_big else "pass",
                                f"{n_files} file, {n_lines} dòng (giới hạn {self.config.max_files}/{self.config.max_lines})"))
            if too_big:
                raise _Fail("diff_too_large", "\n".join(c.path for c in changes[:30]))

            markers = sorted({m for s in self.profile.get("stacks", []) for m in s.get("forbidden_skip", [])})
            bad, warn = forbidden_changes(changes, markers, fix_result.get("needs_dependency") or [])
            if bad:
                checks.append(Check("forbidden", "fail", "; ".join(bad)))
                raise _Fail("forbidden_change", "\n".join(bad))
            checks.append(Check("forbidden", "warn" if warn else "pass", "; ".join(warn)))

            stacks = self._stacks_for(changes)
            if not stacks:
                checks.append(Check("build", "skipped", "không nhận diện được stack, không có lệnh build/test"))

            # 2. build
            for st in stacks:
                if not st.get("build"):
                    checks.append(Check(self._name("build", st, stacks), "skipped", "stack không có lệnh build"))
                    continue
                rc, log = exec_check(self._name("build", st, stacks), st["build"], workdir / st["root"],
                                     self.config.build_sec)
                if rc != 0:
                    raise fail_from_log(rc, log, "compile")

            # 3. test agent viết (tái hiện / theo tiêu chí)
            declared = fix_result.get("tests_added") or []
            targets = [t for t in declared if SAFE_TARGET.match(t) and not t.startswith("-")]
            rejected = [t for t in declared if t not in targets]
            if not declared:
                checks.append(Check("tests_declared", "warn", "agent không khai test nào trong tests_added"))
            elif rejected:
                checks.append(Check("tests_declared", "warn", f"bỏ {len(rejected)} tên test có ký tự không an toàn"))
            for st, cmd in self._target_commands(targets[: self.config.max_targets], stacks):
                rc, log = exec_check(self._name("target_tests", st, stacks), cmd, workdir / st["root"],
                                     self.config.test_sec, rerun=True)
                if rc != 0:
                    raise fail_from_log(rc, log, "original_still_failing")
                if NO_TESTS_RAN.search(log):
                    checks[-1].status, checks[-1].note = "warn", "lệnh chạy nhưng không thấy test nào được chạy"

            # 4. regression
            for st in stacks:
                name = self._name("regression", st, stacks)
                if not full_regression:
                    checks.append(Check(name, "skipped", "rút gọn vì sắp hết giờ"))
                elif not st.get("test_all"):
                    checks.append(Check(name, "skipped", "stack không có lệnh test_all"))
                else:
                    rc, log = exec_check(name, st["test_all"], workdir / st["root"], self.config.test_sec, rerun=True)
                    if rc != 0:
                        raise fail_from_log(rc, log, "regression")

            # 5. MVS (bắt buộc với CR/BUG)
            if mvs_command:
                rc, log = exec_check("mvs", mvs_command, workdir, self.config.mvs_sec)
                mvs_passed = rc == 0
                if rc != 0:
                    raise fail_from_log(rc, log, "mvs_fail")
            elif itype in ("CR", "BUG"):
                checks.append(Check("mvs", "skipped", "chưa có MVS runner"))
        except _Fail as f:
            report = GateReport(item["id"], attempt, False, f.kind, f.sig, checks, f.log, n_files, n_lines,
                                mvs_passed, round(time.time() - t0, 1))
        else:
            report = GateReport(item["id"], attempt, True, None, None, checks, "", n_files, n_lines,
                                mvs_passed, round(time.time() - t0, 1))
        if self.store:
            self.store.add_gate_run(report)
        return report

    # ------------------------------------------------------------------ internal
    def _stacks_for(self, changes: list[FileChange]) -> list[dict]:
        """Stack có file bị sửa (root khớp dài nhất); không khớp stack nào thì dùng stack chính."""
        stacks = self.profile.get("stacks", [])
        chosen: list[dict] = []
        for ch in changes:
            hits = [s for s in stacks if _under(ch.path, s["root"])]
            if hits:
                best = max(hits, key=lambda s: 0 if s["root"] == "." else len(s["root"]))
                if best not in chosen:
                    chosen.append(best)
        if not chosen:
            chosen = [s for s in stacks if s["id"] == self.profile.get("primary")][:1]
        primary = self.profile.get("primary")
        return sorted(chosen, key=lambda s: s["id"] != primary)

    @staticmethod
    def _name(check: str, st: dict, stacks: list[dict]) -> str:
        return check if len(stacks) <= 1 else f"{check}[{st['root']}]"

    def _target_commands(self, targets: list[str], stacks: list[dict]) -> list[tuple[dict, str]]:
        """Chia test cho stack (theo đường dẫn nếu có, không thì stack đầu tiên), đổi sang đường dẫn tính từ
        root của stack, rồi ghép vào `test_one` (một lệnh nếu stack cho ghép, không thì mỗi test một lệnh)."""
        by_stack: dict[int, list[str]] = {}
        for t in targets:
            norm = t.replace("\\", "/")
            st = next((s for s in stacks if s["root"] != "." and "/" in norm and _under(norm, s["root"])), None)
            if st is None:
                st = stacks[0] if stacks else None
            if st is None or not st.get("test_one"):
                continue
            if st["root"] != "." and _under(norm, st["root"]):
                t = norm[len(st["root"].rstrip("/")) + 1:]
            if st.get("build_tool") == "gradle":
                t = t.replace("#", ".")
            by_stack.setdefault(stacks.index(st), []).append(t)
        out: list[tuple[dict, str]] = []
        for idx, ts in by_stack.items():
            st = stacks[idx]
            sep = TARGET_JOIN.get(st.get("build_tool", ""))
            groups = [sep.join(ts)] if sep else ts
            out += [(st, st["test_one"].replace("{target}", g)) for g in groups]
        return out
