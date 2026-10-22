"""Chạy một agent = một lần `codex exec`.

    runner = AgentRunner(store, mode="live")          # hoặc mode="mock"
    triage = {...}                                     # loại, deadline (code) + mức độ, độ khó (JEV)
    fix = runner.run("fixer", item, workdir=worktree, triage=triage)
    rev = runner.run("reviewer", item, workdir=worktree, fix_result=fix.output, diff=diff_text)

Mỗi lần chạy: phiên mới (--ephemeral), prompt qua stdin, đầu ra ép theo JSON schema,
trace ghi vào SQLite, log JSONL thô lưu ở runs/<item>/.
Không đọc token, không tính chi phí: plugin của BTC theo dõi việc đó.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import ROOT, AgentsConfig, RoleConfig, item_type
from .events import EventState, feed
from .prompt import build_prompt
from .store import Store

RUNS_DIR = ROOT / "runs"
MOCK_DIR = ROOT / "samples" / "mock"


@dataclass
class AgentResult:
    run_id: int
    role: str
    status: str                    # ok | failed | timeout | invalid_output
    output: dict | None
    seconds: float
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def build_command(cfg: RoleConfig, *, workdir: Path, last_msg_path: Path) -> list[str]:
    # Windows: npm cài codex thành codex.cmd, cần which() để tìm đúng file
    codex = shutil.which(cfg.codex_bin) or cfg.codex_bin
    cmd = [
        codex, "exec",
        "--json",
        "--strict-config",                 # sai khóa cấu hình thì dừng ngay, không chạy mù
        "--ephemeral",                     # mỗi lần một phiên mới, không lưu session
        "--skip-git-repo-check",
        "-s", cfg.sandbox,
        "-C", str(workdir),
        "--output-schema", str(cfg.schema_path),
        "-o", str(last_msg_path),
        "-c", f'model_reasoning_effort="{cfg.effort}"',
    ]
    if cfg.model:
        cmd += ["-m", cfg.model]
    if cfg.sandbox == "workspace-write":
        for d in cfg.add_dirs:
            cmd += ["--add-dir", str(d)]
    cmd.append("-")                        # đọc prompt từ stdin
    return cmd


def validate_output(output: Any, schema_path: Path) -> list[str]:
    """Kiểm nhẹ: đủ khóa bắt buộc ở cấp đầu và giá trị enum hợp lệ."""
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    if not isinstance(output, dict):
        return ["output không phải JSON object"]
    problems = [f"thiếu khóa {k!r}" for k in schema.get("required", []) if k not in output]
    for k, spec in schema.get("properties", {}).items():
        if k in output and "enum" in spec and output[k] not in spec["enum"]:
            problems.append(f"{k}={output[k]!r} không thuộc {spec['enum']}")
    return problems


class AgentRunner:
    def __init__(self, store: Store, *, mode: str = "live", config: AgentsConfig | None = None,
                 mock_dir: Path = MOCK_DIR, runs_dir: Path = RUNS_DIR):
        if mode not in ("live", "mock"):
            raise ValueError("mode phải là live hoặc mock")
        self.store = store
        self.mode = mode
        self.config = config or AgentsConfig()
        self.mock_dir = Path(mock_dir)
        self.runs_dir = Path(runs_dir)

    # ------------------------------------------------------------------ public
    def run(
        self,
        role_name: str,
        item: dict,
        *,
        workdir: Path,
        attempt: int = 1,
        tier: str | None = None,
        label: str | None = None,
        **prompt_kwargs: Any,
    ) -> AgentResult:
        itype = item_type(item["id"])
        cfg = self.config.role(role_name, itype, tier)
        prompt = build_prompt(cfg.role, item, **prompt_kwargs)

        run_dir = self.runs_dir / item["id"]
        run_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{role_name}-{attempt}" + (f"-{label}" if label else "")   # label: chạy song song cùng attempt
        jsonl_path = run_dir / f"{stem}.jsonl"
        last_msg_path = run_dir / f"{stem}.last.json"
        (run_dir / f"{stem}.prompt.md").write_text(prompt, encoding="utf-8")

        run_id = self.store.start_run(
            item_id=item["id"], item_type=itype, role=role_name, attempt=attempt,
            mode=self.mode, model=cfg.model, jsonl_path=jsonl_path,
        )
        t0 = time.time()
        state = EventState()

        if self.mode == "mock":
            status = self._replay_mock(role_name, item["id"], attempt, Path(workdir), state, run_id, jsonl_path)
            raw_last = state.last_message
        else:
            status = self._run_live(cfg, prompt, Path(workdir), state, run_id, jsonl_path, last_msg_path)
            raw_last = (
                last_msg_path.read_text(encoding="utf-8")
                if last_msg_path.exists() else state.last_message
            )

        output = None
        if status == "ok":
            try:
                output = json.loads(raw_last or "")
            except json.JSONDecodeError:
                status = "invalid_output"
                state.errors.append("câu trả lời cuối không phải JSON")
            else:
                problems = validate_output(output, cfg.schema_path)
                if problems:
                    status = "invalid_output"
                    state.errors.extend(problems)

        self.store.finish_run(
            run_id, status=status, thread_id=state.thread_id,
            output=output, error="; ".join(state.errors) or None,
        )
        return AgentResult(run_id, role_name, status, output, round(time.time() - t0, 1), state.errors)

    # ---------------------------------------------------------------- internal
    def _run_live(self, cfg, prompt, workdir, state, run_id, jsonl_path, last_msg_path) -> str:
        env = {**os.environ, "CODEX_HOME": str(cfg.codex_home)}
        cmd = build_command(cfg, workdir=workdir, last_msg_path=last_msg_path)
        with subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", env=env,
        ) as proc:
            return self._watch(proc, cfg, prompt, state, run_id, jsonl_path)

    def _watch(self, proc, cfg, prompt, state, run_id, jsonl_path) -> str:
        timed_out = threading.Event()

        def _kill():
            timed_out.set()
            proc.kill()

        timer = threading.Timer(cfg.timeout_sec, _kill)
        timer.start()
        stderr_lines: list[str] = []
        t_err = threading.Thread(target=lambda: stderr_lines.extend(proc.stderr), daemon=True)
        t_err.start()
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
            with open(jsonl_path, "w", encoding="utf-8") as raw:
                for line in proc.stdout:
                    raw.write(line)
                    te = feed(state, line)
                    if te:
                        self.store.add_event(run_id, te.kind, te.summary, te.status)
            proc.wait()
        finally:
            timer.cancel()
            t_err.join(timeout=2)

        if timed_out.is_set():
            state.errors.append(f"quá {cfg.timeout_sec}s")
            return "timeout"
        if proc.returncode != 0 or state.turn_failed:
            tail = "".join(stderr_lines[-5:]).strip()
            state.errors.append(f"codex thoát mã {proc.returncode}" + (f": {tail}" if tail else ""))
            return "failed"
        return "ok"

    def _replay_mock(self, role_name, item_id, attempt, workdir, state, run_id, jsonl_path) -> str:
        """Phát lại output đã lưu trong <mock_dir>/<role>/: <item>-<attempt>.jsonl, <item>.jsonl rồi default.jsonl.
        Có <item>-<attempt>.patch hoặc <item>.patch thì `git apply` vào workdir, giả việc agent sửa file."""
        folder = self.mock_dir / role_name
        names = (f"{item_id}-{attempt}", item_id)
        src = next((folder / f"{n}.jsonl" for n in (*names, "default") if (folder / f"{n}.jsonl").exists()), None)
        if src is None:
            state.errors.append(f"không có dữ liệu mock cho {role_name}/{item_id}")
            return "failed"
        with open(src, encoding="utf-8") as f, open(jsonl_path, "w", encoding="utf-8") as raw:
            for line in f:
                raw.write(line)
                te = feed(state, line)
                if te:
                    self.store.add_event(run_id, te.kind, te.summary, te.status)
        patch = next((folder / f"{n}.patch" for n in names if (folder / f"{n}.patch").exists()), None)
        if patch is not None:
            res = subprocess.run(["git", "-C", str(workdir), "apply", "--whitespace=nowarn", str(patch.resolve())],
                                 capture_output=True, text=True)
            if res.returncode != 0:
                state.errors.append(f"không áp được {patch.name}: {res.stderr.strip()}")
                return "failed"
        return "failed" if state.turn_failed else "ok"
