"""Nhận diện stack của repo BTC đưa và tạo "project profile".

Chạy ở bước chuẩn bị, bằng code (không tốn $). Profile được ghép vào prompt của mọi agent
để agent biết lệnh build/test đúng thay vì tự đoán, và để gate biết marker skip test nào bị cấm.

    python -m orchestrator.cli profile D:/path/to/repo
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

SKIP_DIRS = {
    ".git", "node_modules", "target", "build", "dist", "out", "bin", "obj", "vendor",
    ".venv", "venv", "env", "__pycache__", ".gradle", ".idea", ".vscode", ".next", "coverage",
}
MAX_DEPTH = 3          # tìm manifest (pom.xml, package.json...) tới độ sâu này
COUNT_DEPTH = 12       # đếm file nguồn theo ngôn ngữ
MAX_FILES = 50_000


@dataclass
class Stack:
    id: str                     # java | node | python | dotnet | go | php
    root: str                   # thư mục con tính từ gốc repo ("." = gốc)
    build_tool: str             # maven | gradle | npm | pnpm | yarn | pip | poetry | dotnet | go | composer
    frameworks: list[str] = field(default_factory=list)
    test_framework: str = ""
    build: str = ""             # lệnh build/compile
    test_all: str = ""          # chạy toàn bộ test
    test_one: str = ""          # chạy 1 test, có {target} để thay
    run_app: str = ""           # chạy app (để tái hiện PI)
    forbidden_skip: list[str] = field(default_factory=list)  # marker skip test bị cấm (gate dùng)


# ----------------------------------------------------------------------------- helpers
def _read(p: Path, limit: int = 200_000) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")[:limit]
    except OSError:
        return ""


def _walk(repo: Path):
    """Duyệt thư mục tới độ sâu COUNT_DEPTH, bỏ thư mục build/thư viện. Trả về (thư mục, độ sâu, file)."""
    base_depth = len(repo.parts)
    for dirpath, dirnames, filenames in os.walk(repo):
        depth = len(Path(dirpath).parts) - base_depth
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        if depth >= COUNT_DEPTH:
            dirnames[:] = []
        yield Path(dirpath), depth, filenames


def _rel(repo: Path, d: Path) -> str:
    r = d.relative_to(repo).as_posix()
    return r or "."


# ----------------------------------------------------------------------------- detectors
def _java(repo: Path, d: Path, files: list[str]) -> Stack | None:
    if "pom.xml" in files:
        pom = _read(d / "pom.xml")
        mvn = "./mvnw" if "mvnw" in files else "mvn"
        fw = ["spring-boot"] if "spring-boot" in pom else (["quarkus"] if "quarkus" in pom else [])
        return Stack(
            "java", _rel(repo, d), "maven", fw, "junit" if ("junit" in pom or "spring-boot-starter-test" in pom) else "",
            build=f"{mvn} -q -B -DskipTests compile",
            test_all=f"{mvn} -q -B test",
            test_one=f"{mvn} -q -B test -Dtest={{target}} -Dsurefire.failIfNoSpecifiedTests=false",
            run_app=f"{mvn} -q -B spring-boot:run" if fw == ["spring-boot"] else "",
            forbidden_skip=["@Disabled", "@Ignore", "assumeTrue(false"],
        )
    gradle = next((f for f in files if f in ("build.gradle", "build.gradle.kts")), None)
    if gradle:
        text = _read(d / gradle)
        gw = "./gradlew" if "gradlew" in files else "gradle"
        fw = ["spring-boot"] if "spring" in text else []
        return Stack(
            "java", _rel(repo, d), "gradle", fw, "junit",
            build=f"{gw} -q compileJava",
            test_all=f"{gw} -q test",
            test_one=f"{gw} -q test --tests '{{target}}'",
            run_app=f"{gw} -q bootRun" if fw else "",
            forbidden_skip=["@Disabled", "@Ignore", "assumeTrue(false"],
        )
    return None


def _node(repo: Path, d: Path, files: list[str]) -> Stack | None:
    if "package.json" not in files:
        return None
    try:
        pkg = json.loads(_read(d / "package.json") or "{}")
    except json.JSONDecodeError:
        pkg = {}
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    scripts = pkg.get("scripts", {})
    pm = "pnpm" if "pnpm-lock.yaml" in files else "yarn" if "yarn.lock" in files else "npm"
    run = "npm run" if pm == "npm" else pm
    fw = [name for key, name in (
        ("@nestjs/core", "nestjs"), ("next", "nextjs"), ("express", "express"), ("fastify", "fastify"),
        ("react", "react"), ("vue", "vue"), ("@angular/core", "angular"),
    ) if key in deps]
    tf = next((t for t in ("vitest", "jest", "mocha") if t in deps), "")
    test_one = {
        "vitest": "npx vitest run {target}",
        "jest": "npx jest {target}",
        "mocha": "npx mocha {target}",
    }.get(tf, f"{run} test -- {{target}}")
    return Stack(
        "node", _rel(repo, d), pm, fw, tf,
        build=f"{run} build" if "build" in scripts else ("npx tsc --noEmit" if "typescript" in deps else ""),
        test_all=f"{run} test" if "test" in scripts else "",
        test_one=test_one,
        run_app=f"{run} start" if "start" in scripts else (f"{run} dev" if "dev" in scripts else ""),
        forbidden_skip=[".skip(", "xit(", "xdescribe(", "it.only(", "describe.only(", "test.only("],
    )


def _python(repo: Path, d: Path, files: list[str]) -> Stack | None:
    markers = {"pyproject.toml", "requirements.txt", "setup.py", "Pipfile"}
    if not markers & set(files):
        return None
    text = " ".join(_read(d / f) for f in markers & set(files)).lower()
    fw = [name for key, name in (("django", "django"), ("fastapi", "fastapi"), ("flask", "flask")) if key in text]
    tool = "poetry" if "[tool.poetry]" in text else "pip"
    if "manage.py" in files and "pytest" not in text:
        return Stack(
            "python", _rel(repo, d), tool, fw or ["django"], "django-test",
            build="python -m compileall -q .",
            test_all="python manage.py test",
            test_one="python manage.py test {target}",
            run_app="python manage.py runserver",
            forbidden_skip=["@skip", "@unittest.skip", "skipTest("],
        )
    run_app = "uvicorn main:app" if "fastapi" in fw else ("flask run" if "flask" in fw else "")
    if "pytest" not in text and not {"pytest.ini", "conftest.py"} & set(files):
        # không khai pytest: dùng unittest có sẵn (máy chạy có thể không cài pytest)
        return Stack(
            "python", _rel(repo, d), tool, fw, "unittest",
            build="python -m compileall -q .",
            test_all="python -m unittest discover -t .",
            test_one="python -m unittest {target}",
            run_app=run_app,
            forbidden_skip=["@unittest.skip", "skipTest(", "@unittest.expectedFailure"],
        )
    return Stack(
        "python", _rel(repo, d), tool, fw, "pytest",
        build="python -m compileall -q .",
        test_all="python -m pytest -q",
        test_one="python -m pytest -q {target}",
        run_app=run_app,
        forbidden_skip=["@pytest.mark.skip", "@pytest.mark.xfail", "pytest.skip(", "@unittest.skip"],
    )


def _dotnet(repo: Path, d: Path, files: list[str]) -> Stack | None:
    if not any(f.endswith((".sln", ".csproj")) for f in files):
        return None
    proj = " ".join(_read(d / f) for f in files if f.endswith(".csproj"))
    fw = ["aspnetcore"] if "Microsoft.NET.Sdk.Web" in proj or "AspNetCore" in proj else []
    tf = "xunit" if "xunit" in proj.lower() else "nunit" if "nunit" in proj.lower() else "mstest" if "mstest" in proj.lower() else ""
    return Stack(
        "dotnet", _rel(repo, d), "dotnet", fw, tf,
        build="dotnet build -nologo -v q",
        test_all="dotnet test -nologo -v q",
        test_one='dotnet test -nologo -v q --filter "FullyQualifiedName~{target}"',
        run_app="dotnet run",
        forbidden_skip=['[Fact(Skip', '[Theory(Skip', "[Ignore", "[Ignore("],
    )


def _go(repo: Path, d: Path, files: list[str]) -> Stack | None:
    if "go.mod" not in files:
        return None
    mod = _read(d / "go.mod")
    fw = [name for key, name in (("gin-gonic", "gin"), ("labstack/echo", "echo"), ("gofiber", "fiber")) if key in mod]
    return Stack(
        "go", _rel(repo, d), "go", fw, "go-test",
        build="go build ./...",
        test_all="go test ./...",
        test_one="go test ./... -run '{target}'",
        run_app="go run .",
        forbidden_skip=["t.Skip("],
    )


def _php(repo: Path, d: Path, files: list[str]) -> Stack | None:
    if "composer.json" not in files:
        return None
    comp = _read(d / "composer.json")
    laravel = "artisan" in files or "laravel/framework" in comp
    return Stack(
        "php", _rel(repo, d), "composer", ["laravel"] if laravel else (["symfony"] if "symfony" in comp else []),
        "phpunit",
        build="composer dump-autoload -q",
        test_all="php artisan test" if laravel else "vendor/bin/phpunit",
        test_one="php artisan test --filter {target}" if laravel else "vendor/bin/phpunit --filter {target}",
        run_app="php artisan serve" if laravel else "",
        forbidden_skip=["markTestSkipped(", "markTestIncomplete(", "@group skip"],
    )


DETECTORS = (_java, _node, _python, _dotnet, _go, _php)


# ----------------------------------------------------------------------------- public
def detect(repo: Path) -> dict:
    """Trả về profile: danh sách stack (monorepo có thể nhiều), stack chính, số file theo ngôn ngữ."""
    repo = Path(repo).resolve()
    stacks: list[Stack] = []
    seen_roots: dict[str, set[str]] = {}
    ext_count: dict[str, int] = {}
    n_files = 0
    for d, depth, files in _walk(repo):
        for f in files:
            ext = Path(f).suffix.lower()
            if ext:
                ext_count[ext] = ext_count.get(ext, 0) + 1
        n_files += len(files)
        if n_files > MAX_FILES:
            break
        if depth > MAX_DEPTH:
            continue
        for det in DETECTORS:
            st = det(repo, d, files)
            if not st:
                continue
            # bỏ module con trùng stack nằm dưới một root đã có (vd. module Maven con)
            parents = seen_roots.setdefault(st.id, set())
            if any(st.root == r or st.root.startswith(r.rstrip("/") + "/") or r == "." for r in parents):
                continue
            parents.add(st.root)
            stacks.append(st)

    lang_ext = {".java": "java", ".kt": "kotlin", ".ts": "typescript", ".tsx": "typescript",
                ".js": "javascript", ".jsx": "javascript", ".py": "python", ".cs": "csharp",
                ".go": "go", ".php": "php", ".vue": "vue", ".sql": "sql"}
    languages: dict[str, int] = {}
    for ext, n in ext_count.items():
        if ext in lang_ext:
            languages[lang_ext[ext]] = languages.get(lang_ext[ext], 0) + n

    # stack chính: stack backend có nhiều file nguồn nhất (ưu tiên không phải frontend thuần)
    def weight(s: Stack) -> int:
        lang = {"java": "java", "node": "typescript", "python": "python", "dotnet": "csharp",
                "go": "go", "php": "php"}[s.id]
        w = languages.get(lang, 0) + (languages.get("javascript", 0) if s.id == "node" else 0)
        frontend_only = s.id == "node" and set(s.frameworks) <= {"react", "vue", "angular", "nextjs"} and s.frameworks
        return w // 2 if frontend_only else w

    primary = max(stacks, key=weight).id if stacks else "unknown"
    return {
        "repo": repo.name,
        "primary": primary,
        "stacks": [asdict(s) for s in stacks],
        "languages": dict(sorted(languages.items(), key=lambda kv: -kv[1])),
    }


def stack_ids(profile: dict | None) -> list[str]:
    if not profile:
        return []
    out: list[str] = []
    for s in profile.get("stacks", []):
        if s["id"] not in out:
            out.append(s["id"])
    return out


def compact(profile: dict) -> dict:
    """Bản rút gọn để đưa vào prompt (bỏ trường rỗng)."""
    return {
        "primary": profile.get("primary"),
        "stacks": [{k: v for k, v in s.items() if v} for s in profile.get("stacks", [])],
    }


if __name__ == "__main__":
    import sys
    print(json.dumps(detect(Path(sys.argv[1] if len(sys.argv) > 1 else ".")), indent=2, ensure_ascii=False))
