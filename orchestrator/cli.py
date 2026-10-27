"""Chạy thử từng agent bằng tay.

  python -m orchestrator.cli monitor                        # xem trận mới nhất: http://127.0.0.1:8765

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
    pw = sub.add_parser("monitor", help="mở monitor (http://127.0.0.1:8765) đọc SQLite của một trận")
    pw.add_argument("--db", help="state.db của trận (mặc định: trận mới nhất trong runs/)")
    pw.add_argument("--port", type=int, default=8765)
    pw.add_argument("--export", help="ghi snapshot ra file .js (vd. monitor/data.js) rồi thoát")
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

    if a.cmd == "monitor":
        from .monitor import export_js, latest_db, serve
        db = Path(a.db) if a.db else latest_db()
        if db is None or not db.exists():
            print("Không tìm thấy state.db trong runs/: truyền --db.")
            return 1
        if a.export:
            export_js(db, Path(a.export))
            print(f"Đã ghi {a.export} từ {db}")
            return 0
        serve(db, port=a.port)
        return 0

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
