"""Chạy thử từng agent bằng tay.

  python -m orchestrator.cli prompt jev --item samples/items/BUG-07.json
  python -m orchestrator.cli agent jev --item samples/items/BUG-07.json --mock
  python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json \
        --brief runs/BUG-07/brief.json --workdir D:/work/BUG-07
  python -m orchestrator.cli cost
  python -m orchestrator.cli profile D:/path/to/repo        # nhận diện stack
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .agents import AgentRunner
from .config import ROOT, AgentsConfig, item_type
from .profile import detect
from .prompt import build_prompt
from .store import Store

DB_PATH = ROOT / "runs" / "state.db"


def _load(path: str | None):
    if not path:
        return None
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    return json.loads(text) if p.suffix == ".json" else text


def _prompt_kwargs(a) -> dict:
    kw = {}
    if a.brief:
        kw["brief"] = _load(a.brief)
    if a.diff:
        kw["diff"] = _load(a.diff)
    if a.previous:
        kw["previous_attempt"] = _load(a.previous)
    if a.hypothesis:
        kw["hypothesis"] = a.hypothesis
    if a.others:
        kw["other_items"] = _load(a.others)
    if a.deadline is not None:
        kw["deadline_min"] = a.deadline
    return kw


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="orchestrator.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("prompt", "agent"):
        p = sub.add_parser(name)
        p.add_argument("role", choices=["jev", "fixer", "reviewer", "pi_hypothesis"])
        p.add_argument("--item", required=True)
        p.add_argument("--brief")
        p.add_argument("--diff")
        p.add_argument("--previous", help="JSON lần thử trước: fail_kind, signature, log rút gọn")
        p.add_argument("--hypothesis")
        p.add_argument("--others", help="JSON danh sách item khác (id, title)")
        p.add_argument("--deadline", type=float)
        p.add_argument("--repo", help="repo để nhận diện stack (mặc định: --workdir với agent)")
        p.add_argument("--no-profile", action="store_true", help="không ghép profile/gói stack")
        if name == "agent":
            p.add_argument("--workdir", default=".")
            p.add_argument("--attempt", type=int, default=1)
            p.add_argument("--mock", action="store_true")
    sub.add_parser("cost")
    pp = sub.add_parser("profile")
    pp.add_argument("repo")
    a = ap.parse_args(argv)

    if a.cmd == "profile":
        print(json.dumps(detect(Path(a.repo)), ensure_ascii=False, indent=2))
        return 0

    if a.cmd == "cost":
        rows = Store(DB_PATH).cost_summary()
        print(f"{'role':<14}{'mode':<6}{'runs':>5}{'input':>10}{'cached':>10}{'output':>9}{'$':>10}")
        for r in rows:
            cost = "?" if r["cost"] is None else f"{r['cost']:.4f}"
            print(f"{r['role']:<14}{r['mode']:<6}{r['runs']:>5}{r['input'] or 0:>10}"
                  f"{r['cached'] or 0:>10}{r['output'] or 0:>9}{cost:>10}"
                  + (f"  ({r['unpriced']} lần chưa có giá)" if r["unpriced"] else ""))
        return 0

    item = _load(a.item)
    item_type(item["id"])  # kiểm mã item sớm
    kw = _prompt_kwargs(a)
    repo = a.repo or (a.workdir if a.cmd == "agent" else None)
    if repo and not a.no_profile:
        kw["profile"] = detect(Path(repo))
    role_file = AgentsConfig().role(a.role).role

    if a.cmd == "prompt":
        sys.stdout.write(build_prompt(role_file, item, **kw))
        return 0

    runner = AgentRunner(Store(DB_PATH), mode="mock" if a.mock else "live")
    res = runner.run(a.role, item, workdir=Path(a.workdir), attempt=a.attempt, **kw)
    print(json.dumps({
        "status": res.status, "seconds": res.seconds,
        "tokens": vars(res.usage), "cost_usd": res.cost_usd,
        "errors": res.errors, "output": res.output,
    }, ensure_ascii=False, indent=2))
    return 0 if res.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
