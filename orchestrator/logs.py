"""Log Condenser: rút log build/test dài còn vài dòng, tạo chữ ký lỗi, nhận ra lỗi compile.

Code thuần, không tốn $. Gate dùng để viết gate report và `previous_attempt` cho lần thử sau.

- **Chữ ký lỗi** = loại exception + frame đầu tiên thuộc code dự án (bỏ số dòng để ổn định giữa
  các lần sửa). Dùng để xác nhận tái hiện đúng lỗi và phát hiện vòng lặp (cùng chữ ký lặp lại).
- Lỗi compile có chữ ký riêng: `compile:<file>:<thông báo>`.
"""
from __future__ import annotations

import re

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
DIGITS = re.compile(r"\d+")

# frame thuộc thư viện / runtime, không phải code dự án
LIB_JAVA = (
    "java.", "javax.", "jakarta.", "jdk.", "sun.", "com.sun.", "kotlin.", "scala.", "groovy.",
    "org.junit.", "junit.", "org.testng.", "org.springframework.", "org.apache.", "org.mockito.",
    "org.hibernate.", "org.assertj.", "org.hamcrest.", "net.bytebuddy.", "com.fasterxml.",
    "io.netty.", "reactor.", "org.gradle.", "worker.org.gradle.", "com.intellij.",
)
LIB_PATH = ("node_modules", "node:internal", "site-packages", "dist-packages", "/lib/python",
            "\\lib\\python", "<frozen", "/usr/lib/", "/usr/local/go/", "/go/pkg/mod/", "vendor/")

# ---------------------------------------------------------------- lỗi compile (file, thông báo)
_DIR = r"(?:\S*[/\\])?"   # phần thư mục trước tên file, bỏ qua
COMPILE_PATTERNS = [re.compile(p) for p in (
    r"\[ERROR\]\s+" + _DIR + r"(?P<file>[\w$-]+\.(?:java|kt|scala)):\[\d+(?:,\d+)?\]\s+(?P<msg>.+)",   # maven
    _DIR + r"(?P<file>[\w$-]+\.(?:java|kt)):\d+:\s+error:\s+(?P<msg>.+)",                               # javac, gradle
    r"^e:\s+(?:file://)?" + _DIR + r"(?P<file>[\w$-]+\.kt):\d+:\d+\s+(?P<msg>.+)",                      # kotlinc
    _DIR + r"(?P<file>[\w.-]+\.tsx?)[(:]\d+[,:]\d+\)?:?\s*-?\s*error\s+(?P<msg>TS\d+:\s+.+)",           # tsc
    _DIR + r"(?P<file>[\w.-]+\.cs)\(\d+,\d+\):\s+error\s+(?P<msg>CS\d+:\s+.+?)(?:\s+\[.*\])?$",         # dotnet
    r"^" + _DIR + r"(?P<file>[\w.-]+\.go):\d+:\d+:\s+(?P<msg>.+)",                                      # go build/vet
    r"PHP Parse error:\s+(?P<msg>.+?) in " + _DIR + r"(?P<file>[\w.-]+\.php)",                          # php
)]
PY_SYNTAX = re.compile(r"^\s*(SyntaxError|IndentationError|TabError):\s*(.+)")
PY_FILE = re.compile(r'File "([^"]+)", line \d+')

# ---------------------------------------------------------------- exception, frame, test fail
JAVA_FRAME = re.compile(r"^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^)]*)\)")
NODE_FRAME = re.compile(r"^\s*at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$")
PY_FRAME = re.compile(r'^\s*File "([^"]+)", line \d+, in (\S+)')
DOTNET_FRAME = re.compile(r"^\s*at\s+([\w.`<>+]+)\(.*?\)\s+in\s+(.+?):line\s+\d+")
GO_FRAME = re.compile(r"^\t(\S+\.go):\d+(?:\s+\+0x[0-9a-f]+)?\s*$")   # frame của panic (thụt bằng tab)

EXC_QUALIFIED = re.compile(r"\b((?:[a-z_][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Failure))\b")
EXC_BARE = re.compile(r"(?:^|[\s(\[])(?:E\s+)?([A-Z][\w$]*(?:Exception|Error|Failure))(?::|\s*$)")
GO_PANIC = re.compile(r"^panic:\s+(.+)")

TEST_FAIL = [
    re.compile(r"^\[ERROR\]\s+([\w$.]+\.[\w$]+):\d+"),                           # maven surefire summary
    re.compile(r"^\[ERROR\]\s+([\w$.]+)\s+Time elapsed.*<<<\s*(?:FAILURE|ERROR)"),
    re.compile(r"^FAILED\s+(\S+::\S+)"),                                         # pytest
    re.compile(r"^(?:ERROR|FAIL):\s+(\w+)\s+\(([\w.]+)\)"),                      # unittest / django
    re.compile(r"^\s*●\s+(.+?)\s*$"),                                            # jest
    re.compile(r"^\s*(?:×|✗|FAIL)\s+(\S+\.(?:test|spec)\.[jt]sx?)"),            # vitest / jest file
    re.compile(r"^--- FAIL:\s+(\S+)"),                                           # go
    re.compile(r"^\s*Failed\s+([\w.]+)\s+\["),                                   # dotnet
    re.compile(r"^\s*\d+\)\s+([\w\\]+::\w+)"),                                   # phpunit
    re.compile(r"^\s*(\w+)\s+>\s+(\w+).*FAILED"),                                # gradle
]

INTERESTING = re.compile(
    r"(error|exception|fail|failed|failure|assert|expected|but was|panic|traceback|"
    r"tests run:.*(failures|errors): [1-9]|build failure|cannot find symbol|undefined|not defined|"
    r"✗|×|●)",
    re.IGNORECASE,
)
NOISE = re.compile(
    r"(^\[INFO\]|^\[WARNING\]|^Downloading|^Downloaded|^Progress|^\s*$|"
    r"Tests run: \d+, Failures: 0, Errors: 0|^\[ERROR\]\s*$|^\[ERROR\] -> \[Help|"
    r"^\[ERROR\] (To see the full|Re-run Maven|For more information|Please refer to)|"
    r"^\[ERROR\] \[Help \d\]|Failed to execute goal)",
    re.IGNORECASE,
)


def strip_ansi(text: str, root: str | None = None) -> str:
    """Bỏ mã màu, chuẩn hóa xuống dòng; có `root` thì bỏ đường dẫn worktree để log giống nhau giữa các lần chạy."""
    out = ANSI.sub("", text or "").replace("\r\n", "\n").replace("\r", "\n")
    if root:
        r = str(root).rstrip("/\\")
        for form in {r, r.replace("\\", "/"), r.replace("/", "\\")}:
            out = out.replace(form + "/", "").replace(form + "\\", "")
    return out


def _is_project_java(cls: str, project_prefixes: tuple[str, ...]) -> bool:
    if project_prefixes:
        return cls.startswith(project_prefixes)
    return not cls.startswith(LIB_JAVA)


def _is_project_path(path: str) -> bool:
    p = path.replace("\\", "/")
    return not any(x.replace("\\", "/") in p for x in LIB_PATH)


def _short_path(path: str) -> str:
    """Bỏ phần tuyệt đối của máy chạy, giữ tối đa 3 thành phần cuối để chữ ký giống nhau giữa các worktree."""
    parts = [p for p in re.split(r"[/\\]", path) if p and p not in (".", "..")]
    return "/".join(parts[-3:])


def compile_errors(text: str, limit: int = 10) -> list[tuple[str, str]]:
    """Danh sách (file, thông báo) của lỗi compile/type-check, theo thứ tự xuất hiện."""
    out: list[tuple[str, str]] = []
    lines = strip_ansi(text).split("\n")
    for i, line in enumerate(lines):
        for pat in COMPILE_PATTERNS:
            m = pat.search(line)
            if m:
                out.append((m.group("file"), m.group("msg").strip()))
                break
        else:
            m = PY_SYNTAX.match(line)
            if m:
                file = next((PY_FILE.search(lines[j]).group(1) for j in range(i - 1, max(i - 6, -1), -1)
                             if PY_FILE.search(lines[j])), "?")
                out.append((_short_path(file).split("/")[-1], f"{m.group(1)}: {m.group(2).strip()}"))
        if len(out) >= limit:
            break
    return out


def _exception(lines: list[str]) -> str | None:
    for line in lines:
        m = GO_PANIC.match(line)
        if m:
            return "panic"
        m = EXC_QUALIFIED.search(line) or EXC_BARE.search(line)
        if m:
            return m.group(1).split(".")[-1]
    return None


def _project_frame(lines: list[str], project_prefixes: tuple[str, ...]) -> str | None:
    for line in lines:
        m = JAVA_FRAME.match(line)
        if m:
            cls, method = m.group(1), m.group(2)
            if _is_project_java(cls, project_prefixes):
                return f"{cls}.{method}"
            continue
        m = DOTNET_FRAME.match(line)
        if m:
            if _is_project_path(m.group(2)) and not m.group(1).startswith(("System.", "Microsoft.", "Xunit.", "NUnit.")):
                return m.group(1)
            continue
        m = PY_FRAME.match(line)
        if m:
            if _is_project_path(m.group(1)):
                return f"{_short_path(m.group(1))}:{m.group(2)}"
            continue
        m = NODE_FRAME.match(line)
        if m and ("/" in m.group(2) or "\\" in m.group(2)):
            if _is_project_path(m.group(2)):
                fn = (m.group(1) or "").split(" ")[-1]
                return f"{_short_path(m.group(2))}" + (f":{fn}" if fn else "")
            continue
        m = GO_FRAME.match(line)
        if m and _is_project_path(m.group(1)):
            return _short_path(m.group(1))
    return None


def failing_tests(text: str, limit: int = 10) -> list[str]:
    out: list[str] = []
    for line in strip_ansi(text).split("\n"):
        for pat in TEST_FAIL:
            m = pat.search(line)
            if m:
                name = ".".join(g for g in m.groups() if g)
                if name not in out:
                    out.append(name)
                break
        if len(out) >= limit:
            break
    return out


def signature(text: str, project_prefixes: tuple[str, ...] = (), root: str | None = None) -> str | None:
    """Chữ ký lỗi ổn định: `compile:<file>:<msg>`, `<Exception>@<frame>`, hoặc `<Exception>@test:<tên test>`."""
    text = strip_ansi(text, root)
    lines = text.split("\n")
    comp = compile_errors(text, limit=1)
    if comp:
        file, msg = comp[0]
        return f"compile:{file}:{DIGITS.sub('N', msg)[:120]}"
    exc = _exception(lines)
    frame = _project_frame(lines, project_prefixes)
    if frame:
        return f"{exc or 'Error'}@{frame}"
    tests = failing_tests(text, limit=1)
    if tests:
        return f"{exc or 'TestFailure'}@test:{tests[0]}"
    return exc


def condense(text: str, max_lines: int = 40, max_chars: int = 4000, root: str | None = None) -> str:
    """Giữ dòng quan trọng (lỗi compile, test fail, assertion, exception + 2 frame dự án); không có thì lấy đuôi log."""
    lines = strip_ansi(text, root).split("\n")
    keep: list[str] = []
    seen: set[str] = set()
    frames_left = 0

    def add(line: str) -> None:
        s = line.rstrip()[:300]
        if s and s not in seen:
            seen.add(s)
            keep.append(s)

    for line in lines:
        if JAVA_FRAME.match(line) or PY_FRAME.match(line) or DOTNET_FRAME.match(line) or \
                (NODE_FRAME.match(line) and line.lstrip().startswith("at ")):
            if frames_left > 0 and (_project_frame([line], ()) is not None):
                add(line)
                frames_left -= 1
            continue
        if NOISE.search(line):
            continue
        if INTERESTING.search(line) or any(p.search(line) for p in COMPILE_PATTERNS):
            add(line)
            if EXC_QUALIFIED.search(line) or EXC_BARE.search(line) or "Traceback" in line:
                frames_left = 2
        if len(keep) >= max_lines:
            break

    if not keep:
        keep = [ln.rstrip()[:300] for ln in lines if ln.strip()][-20:]
    out = "\n".join(keep[:max_lines])
    return out if len(out) <= max_chars else out[: max_chars - 15] + "\n...(cắt bớt)"
