"""Chạy thử từng agent bằng tay, hoặc cả trận với Game Master giả.

  python -m orchestrator.cli match --mock --jev-mock        # cả trận giả trên repo mẫu, không tốn $

  python -m orchestrator.cli prompt fixer --item samples/items/BUG-07.json
  python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --mock
  python -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --workdir D:/work/BUG-07
  python -m orchestrator.cli agent reviewer --item ... --fix-result runs/BUG-07/fixer-1.last.json --diff d.patch
  python -m orchestrator.cli runs                           # thống kê số lần chạy agent
  python -m orchestrator.cli profile D:/path/to/repo        # nhận diện stack
  python -m orchestrator.cli decide triage --item samples/items/PI-03.json [--mock]   # hỏi Jev
  python -m orchestrator.cli gate --item samples/items/BUG-07.json --workdir D:/work/BUG-07 --fix-result f.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
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
    if a.triage:
        kw["triage"] = _load(a.triage)
    if a.fix_result:
        kw["fix_result"] = _load(a.fix_result)
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


def _match(a) -> int:
    from .decisions import Decider, mock_transport
    from .gamemaster import FakeGameMaster
    from .gate import Gate
    from .jev import JevClient
    from .match import MatchRunner, RunConfig
    from .workspace import Workspaces, init_sample_repo

    gm = FakeGameMaster.from_file(a.scenario, speed=a.speed)
    match_id = f"{gm.match_id}-{time.strftime('%Y%m%d-%H%M%S')}"       # mỗi trận một thư mục, một DB
    run_dir = ROOT / "runs" / match_id
    repo = Path(a.repo) if a.repo else init_sample_repo(ROOT / "samples" / "repo-template", run_dir / "repo")
    if not a.mock:
        print("Cảnh báo: chạy Codex thật, tốn $ từ ngân sách đội.")
    override = {k: v for k, v in (("workers", a.workers), ("max_attempts", a.max_attempts)) if v is not None}
    cfg = RunConfig.load(poll_sec=a.poll, stop_when_idle=a.until_idle, **override)
    print(f"Trận {match_id}: repo {repo}, tốc độ x{a.speed}, {cfg.workers} worker")
    with Store(Path(a.db) if a.db else run_dir / "state.db") as store:
        jev = JevClient.from_config(transport=mock_transport if a.jev_mock else None)
        if not jev.available:
            print("Jev chưa sẵn sàng → mọi quyết định dùng luật code.")
        profile = detect(repo)
        agents = AgentRunner(store, mode="mock" if a.mock else "live", runs_dir=run_dir)
        runner = MatchRunner(gm, agents, Decider(jev, store), store, Workspaces(repo, run_dir / "worktrees"),
                             profile, gate=Gate(profile, store=store, runs_dir=run_dir), config=cfg)
        outcomes = runner.run()
    print(f"\n{'item':<10}{'kết quả':<12}{'lần thử':>8}  ghi chú")
    for o in sorted(outcomes.values(), key=lambda o: o.item_id):
        print(f"{o.item_id:<10}{o.state:<12}{o.attempts:>8}  {o.reason}")
    print(f"Log và DB: {run_dir}")
    return 0


def main(argv=None) -> int:
    # console Windows mặc định cp1252, không in được tiếng Việt trong output agent
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="orchestrator.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("prompt", "agent"):
        p = sub.add_parser(name)
        p.add_argument("role", choices=["fixer", "reviewer", "pi_hypothesis"])
        p.add_argument("--item", required=True)
        p.add_argument("--triage", help="JSON triage (loại, deadline, mức độ, độ khó...)")
        p.add_argument("--fix-result", dest="fix_result", help="JSON kết quả fixer (cho reviewer)")
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
    sub.add_parser("runs")
    pp = sub.add_parser("profile")
    pp.add_argument("repo")
    pd = sub.add_parser("decide", help="thử một điểm quyết định của Jev")
    pd.add_argument("what", choices=["triage", "route"])
    pd.add_argument("--item", required=True)
    pd.add_argument("--triage", help="triage JSON có difficulty (cho route)")
    pd.add_argument("--modules", help="danh sách module, cách nhau bởi dấu phẩy (cho triage)")
    pd.add_argument("--mock", action="store_true", help="trả lời giả, không gọi API")
    pg = sub.add_parser("gate", help="chạy gate trên worktree (build/test thật trên máy, không tốn $)")
    pg.add_argument("--item", required=True)
    pg.add_argument("--workdir", required=True)
    pg.add_argument("--fix-result", dest="fix_result", help="JSON kết quả fixer (tests_added, needs_dependency)")
    pg.add_argument("--attempt", type=int, default=1)
    pg.add_argument("--base", default="HEAD", help="commit gốc để so diff")
    pg.add_argument("--mvs", help="lệnh chạy MVS (BUG/CR)")
    pg.add_argument("--quick", action="store_true", help="bỏ regression (test_all)")
    pg.add_argument("--json", action="store_true", help="in cả báo cáo dạng JSON")
    pm = sub.add_parser("match", help="chạy cả trận với Game Master giả (FakeGameMaster)")
    pm.add_argument("--scenario", default=str(ROOT / "samples" / "scenarios" / "practice.json"))
    pm.add_argument("--repo", help="repo để sửa (mặc định: tạo repo mới từ samples/repo-template)")
    pm.add_argument("--mock", action="store_true", help="agent phát lại mock, không gọi Codex (không tốn $)")
    pm.add_argument("--jev-mock", dest="jev_mock", action="store_true", help="Jev trả lời giả, không gọi API")
    pm.add_argument("--speed", type=float, default=60, help="tua nhanh đồng hồ trận (60 = 1 phút trận/giây)")
    pm.add_argument("--poll", type=float, default=1.0, help="số giây thật giữa 2 lần hỏi Game Master")
    pm.add_argument("--workers", type=int)
    pm.add_argument("--max-attempts", dest="max_attempts", type=int)
    pm.add_argument("--until-idle", dest="until_idle", action="store_true",
                    help="dừng khi mọi item đã thấy đều xong, không chờ hết trận")
    pm.add_argument("--db", help="file SQLite (mặc định runs/<match>/state.db)")
    a = ap.parse_args(argv)

    if a.cmd == "decide":
        from .decisions import Decider, mock_transport
        from .jev import JevClient
        jev = JevClient.from_config(transport=mock_transport if a.mock else None)
        if not jev.available:
            print("Jev chưa sẵn sàng (thiếu TYPESAFE_API_KEY hoặc enabled=false) → toàn bộ dùng luật code.")
        decider = Decider(jev, Store(DB_PATH))
        item = _load(a.item)
        if a.what == "triage":
            res = decider.triage(item, modules=a.modules.split(",") if a.modules else None)
        else:
            res = decider.route(item, _load(a.triage) if a.triage else {"difficulty": "medium"})
        print(json.dumps({k: vars(v) for k, v in res.items()}, ensure_ascii=False, indent=2))
        return 0

    if a.cmd == "match":
        return _match(a)

    if a.cmd == "gate":
        from .gate import Gate
        with Store(DB_PATH) as store:
            rep = Gate(detect(Path(a.workdir)), store=store).run(
                _load(a.item), Path(a.workdir), _load(a.fix_result), attempt=a.attempt, base=a.base,
                full_regression=not a.quick, mvs_command=a.mvs)
        print(json.dumps(rep.to_dict(), ensure_ascii=False, indent=2) if a.json else rep.to_text())
        return 0 if rep.passed else 1

    if a.cmd == "profile":
        print(json.dumps(detect(Path(a.repo)), ensure_ascii=False, indent=2))
        return 0

    if a.cmd == "runs":
        rows = Store(DB_PATH).run_summary()
        print(f"{'role':<14}{'mode':<6}{'runs':>5}{'ok':>5}{'avg s':>8}")
        for r in rows:
            print(f"{r['role']:<14}{r['mode']:<6}{r['runs']:>5}{r['ok'] or 0:>5}{r['avg_sec'] or 0:>8}")
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
        "errors": res.errors, "output": res.output,
    }, ensure_ascii=False, indent=2))
    return 0 if res.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
