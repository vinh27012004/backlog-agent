"""Test vòng `run` (không tốn $): Game Master giả + agent mock + gate thật trên repo mẫu.

Mỗi test tạo repo mới từ samples/repo-template, chép samples/mock rồi thay vài file mock để đi vào
nhánh cần kiểm (thử lại, chữ ký lặp, reviewer yêu cầu sửa, PI kẹt...). Jev không có key → luật code.

    py -3.13 -m unittest discover -s tests -k MatchRunnerTest
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orchestrator.agents import AgentResult, AgentRunner  # noqa: E402
from orchestrator.decisions import Decider  # noqa: E402
from fake_gamemaster import FakeGameMaster, ManualClock  # noqa: E402
from orchestrator.gate import Gate  # noqa: E402
from orchestrator.jev import JevClient, JevConfig  # noqa: E402
from orchestrator.match import MatchRunner, RunConfig  # noqa: E402
from orchestrator.profile import detect  # noqa: E402
from orchestrator.store import Store  # noqa: E402
from orchestrator.workspace import Workspaces, init_sample_repo  # noqa: E402

TEMPLATE = ROOT / "samples" / "repo-template"
MOCK = ROOT / "samples" / "mock"
ITEMS = ROOT / "samples" / "items"

WRONG_BUG_TEST = {"tests/test_coupon.py": (
    "import unittest\n\nfrom shop.order import order_total\n\n\nclass PercentCouponTest(unittest.TestCase):\n"
    "    def test_percent_coupon_applied_once(self):\n"
    "        lines = [{'price': 300_000, 'qty': 2}, {'price': 400_000, 'qty': 1}]\n"
    "        self.assertEqual(order_total(lines, {'type': 'percent', 'value': 10}), 900_000)\n")}
WRONG_PI_TEST = {"tests/test_monthly_report.py": (
    "import unittest\n\nfrom shop.report import monthly_report\n\n\nclass MonthlyReportTest(unittest.TestCase):\n"
    "    def test_month(self):\n"
    "        self.assertEqual(monthly_report([{'date': '2026-10-01T09:00:00', 'total': 1}], '2026-10')['orders'], 1)\n")}


def item(name: str) -> dict:
    return json.loads((ITEMS / f"{name}.json").read_text(encoding="utf-8"))


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def jsonl(final: dict, thread: str = "t") -> str:
    events = [{"type": "thread.started", "thread_id": thread},
              {"type": "item.completed", "item": {"id": "f", "type": "agent_message",
                                                  "text": json.dumps(final, ensure_ascii=False)}},
              {"type": "turn.completed", "usage": {}}]
    return "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events)


class Harness:
    def __init__(self, tmp: Path, items: list[tuple[str, float, float]], *, mocks: dict[str, str] | None = None,
                 patches: dict[str, dict[str, str]] | None = None, workers: int = 0, poll: float = 30, **cfg):
        self.tmp = tmp
        self.remote = tmp / "remote.git"
        self.repo = init_sample_repo(TEMPLATE, tmp / "repo", bare_remote=self.remote)
        self.mock_dir = tmp / "mock"
        shutil.copytree(MOCK, self.mock_dir)
        for rel, body in (mocks or {}).items():
            (self.mock_dir / rel).write_text(body, encoding="utf-8")
        for rel, files in (patches or {}).items():
            (self.mock_dir / rel).write_bytes(self._make_patch(files))
        self.clock = ManualClock()
        self.gm = FakeGameMaster({"match_id": "t", "duration_min": 40, "items": [
            {"at_min": at, "deadline_min": dl, "item": item(name)} for name, at, dl in items]}, clock=self.clock)
        self.store = Store(tmp / "state.db")
        self.agents = AgentRunner(self.store, mode="mock", mock_dir=self.mock_dir, runs_dir=tmp / "runs")
        profile = detect(self.repo)
        self.logs: list[str] = []
        sleep = self.clock.advance if workers == 0 else (lambda s: (time.sleep(0.05), self.clock.advance(s)))
        self.runner = MatchRunner(
            self.gm, self.agents, Decider(JevClient(JevConfig(), None), self.store), self.store,
            Workspaces(self.repo, tmp / "wt"), profile,
            gate=Gate(profile, store=self.store, runs_dir=tmp / "runs"),
            config=RunConfig(workers=workers, poll_sec=poll, stop_when_idle=True, **cfg),
            sleep=sleep, log=self.logs.append)

    def _make_patch(self, files: dict[str, str]) -> bytes:
        repo = self.tmp / "patchrepo"
        if not repo.exists():
            init_sample_repo(TEMPLATE, repo)
        for rel, body in files.items():
            (repo / rel).write_bytes(body.encode("utf-8"))
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        out = subprocess.run(["git", "-C", str(repo), "diff", "--cached"], check=True, capture_output=True).stdout
        subprocess.run(["git", "-C", str(repo), "reset", "-q", "--hard"], check=True)
        return out

    def prompt(self, item_id: str, stem: str) -> str:
        return (self.tmp / "runs" / item_id / f"{stem}.prompt.md").read_text(encoding="utf-8")

    def calls(self, method: str) -> list[str]:
        return [i for m, i in self.gm.calls if m == method]

    def runs(self, role: str) -> int:
        return self.store._read("SELECT COUNT(*) n FROM agent_runs WHERE role=?", (role,))[0]["n"]


class MatchRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        if hasattr(self, "h"):
            self.h.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_match(self, items, **kw):
        self.h = Harness(self.tmp, items, **kw)
        return self.h.runner.run()

    def test_full_scenario_submits_every_item(self):
        out = self.run_match([("TASK-01", 0, 40), ("BUG-07", 0, 40), ("CR-02", 4, 30), ("PI-03", 8, 18)])
        self.assertEqual({k: o.state for k, o in out.items()},
                         {"TASK-01": "submitted", "BUG-07": "submitted", "CR-02": "submitted", "PI-03": "submitted"})
        self.assertTrue(all(o.attempts == 1 for o in out.values()))
        self.assertEqual(self.h.runs("reviewer"), 3)                  # PI không review
        sub = json.loads(self.h.store.get_submission("BUG-07")["response_json"])
        self.assertEqual(sub["warnings"], [])                          # BUG có evidence
        state = {r["item_id"]: r["state"] for r in self.h.store.items()}
        self.assertEqual(set(state.values()), {"submitted"})

    def test_parallel_workers(self):
        out = self.run_match([("TASK-01", 0, 40), ("BUG-07", 0, 40), ("CR-02", 0, 40)], workers=2, poll=5)
        self.assertEqual({o.state for o in out.values()}, {"submitted"})
        self.assertEqual(len(self.h.calls("submit")), 3)

    def test_pi_goes_first(self):
        self.run_match([("BUG-07", 0, 40), ("PI-03", 0, 18)])
        self.assertEqual(self.h.calls("start_item"), ["PI-03", "BUG-07"])

    def test_retry_after_gate_fail_gets_previous_attempt(self):
        out = self.run_match([("BUG-07", 0, 40)], patches={"fixer/BUG-07-1.patch": WRONG_BUG_TEST})
        self.assertEqual((out["BUG-07"].state, out["BUG-07"].attempts), ("submitted", 2))
        p2 = self.h.prompt("BUG-07", "fixer-2")
        self.assertIn("<previous_attempt>", p2)
        self.assertIn("original_still_failing", p2)
        self.assertIn("# Retry playbook", p2)
        self.assertEqual(len(self.h.calls("submit")), 1)

    def test_same_signature_three_times_drops_without_submitting(self):
        out = self.run_match([("BUG-07", 0, 40)], max_attempts=5, patches={"fixer/BUG-07.patch": WRONG_BUG_TEST})
        self.assertEqual((out["BUG-07"].state, out["BUG-07"].attempts), ("dropped", 3))
        self.assertIn("chữ ký lỗi lặp lại", out["BUG-07"].reason)
        self.assertIn("same_signature_as_before", self.h.prompt("BUG-07", "fixer-3"))
        self.assertEqual(self.h.calls("submit"), [])

    def test_never_submits_when_gate_keeps_failing(self):
        out = self.run_match([("BUG-07", 0, 40)], max_attempts=2, patches={"fixer/BUG-07.patch": WRONG_BUG_TEST})
        self.assertEqual((out["BUG-07"].state, out["BUG-07"].attempts), ("dropped", 2))
        self.assertEqual(self.h.calls("submit"), [])

    def test_reviewer_high_issue_triggers_retry(self):
        review = {"verdict": "request_changes", "root_cause_addressed": False, "summary": "x",
                  "issues": [{"severity": "high", "file": "shop/order.py", "line": 1, "problem": "p", "suggestion": "s"}]}
        out = self.run_match([("BUG-07", 0, 40)], mocks={"reviewer/BUG-07-1.jsonl": jsonl(review)})
        self.assertEqual((out["BUG-07"].state, out["BUG-07"].attempts), ("submitted", 2))
        self.assertIn("review_high", self.h.prompt("BUG-07", "fixer-2"))

    def test_reviewer_high_issue_on_last_attempt_still_submits(self):
        review = {"verdict": "request_changes", "root_cause_addressed": False, "summary": "x",
                  "issues": [{"severity": "high", "file": "a", "line": 1, "problem": "p", "suggestion": "s"}]}
        out = self.run_match([("BUG-07", 0, 40)], max_attempts=1, mocks={"reviewer/BUG-07.jsonl": jsonl(review)})
        self.assertEqual(out["BUG-07"].state, "submitted")

    def test_stuck_pi_checks_hypotheses_in_parallel(self):
        out = self.run_match([("PI-03", 0, 18)], patches={"fixer/PI-03-1.patch": WRONG_PI_TEST})
        self.assertEqual((out["PI-03"].state, out["PI-03"].attempts), ("submitted", 2))
        self.assertEqual(self.h.runs("pi_hypothesis"), 2)
        self.assertTrue((self.tmp / "runs" / "PI-03" / "pi_hypothesis-1-h2.jsonl").exists())
        p2 = self.h.prompt("PI-03", "fixer-2")
        self.assertIn("<hypothesis>", p2)
        self.assertIn("[supported]", p2)

    def test_resume_skips_items_already_submitted(self):
        self.h = Harness(self.tmp, [("TASK-01", 0, 40), ("BUG-07", 0, 40)])
        self.h.store.set_item("BUG-07", item_type="BUG", state="submitted", attempts=1)
        out = self.h.runner.run()
        self.assertEqual(out["BUG-07"].reason, "đã xử lý trước đó")
        self.assertEqual(self.h.calls("start_item"), ["TASK-01"])

    def test_slow_fixer_past_deadline_is_dropped_not_submitted(self):
        self.h = Harness(self.tmp, [("BUG-07", 0, 20)])
        real_run = self.h.agents.run

        def slow(role, *a, **kw):
            if role == "fixer":
                self.h.clock.advance(25 * 60)
            return real_run(role, *a, **kw)
        self.h.agents.run = slow
        out = self.h.runner.run()
        self.assertEqual(out["BUG-07"].state, "dropped")
        self.assertEqual(self.h.calls("submit"), [])

    def test_submission_carries_pushed_git_revision(self):
        self.run_match([("BUG-07", 0, 40)])
        payload = self.h.gm.items["BUG-07"]["submission"]["payload"]
        sha = payload["gitRevision"]
        self.assertEqual(git(self.h.remote, "rev-parse", "mtm/BUG-07"), sha)
        self.assertEqual(git(self.h.remote, "rev-parse", f"{sha}^"), self.h.runner.workspaces.base)
        changed = git(self.h.remote, "diff", "--name-only", f"{sha}^", sha).splitlines()
        self.assertEqual(sorted(changed), sorted(payload["changed_files"]))

    def test_rerun_never_overwrites_a_pushed_branch(self):
        self.h = Harness(self.tmp, [("BUG-07", 0, 40)])
        wss = self.h.runner.workspaces
        path = wss.create("BUG-07")
        (path / "a.txt").write_text("1", encoding="utf-8")
        first = wss.commit(path, "BUG-07: 1")
        self.assertEqual(wss.push(first, "origin", "mtm/BUG-07"), "mtm/BUG-07")
        self.assertEqual(wss.push(first, "origin", "mtm/BUG-07"), "mtm/BUG-07")     # push lại cùng sha
        wss.reset(path)
        (path / "a.txt").write_text("2", encoding="utf-8")
        second = wss.commit(path, "BUG-07: 2")
        self.assertEqual(wss.push(second, "origin", "mtm/BUG-07"), f"mtm/BUG-07-{second[:8]}")
        self.assertEqual(git(self.h.remote, "rev-parse", "mtm/BUG-07"), first)

    def test_push_failure_means_no_submission(self):
        out = self.run_match([("BUG-07", 0, 40)], push_remote="nowhere")
        self.assertEqual(out["BUG-07"].state, "failed")
        self.assertIn("không push được", out["BUG-07"].reason)
        self.assertEqual(self.h.calls("submit"), [])

    def test_push_branch_must_be_per_item(self):
        with self.assertRaises(ValueError):
            RunConfig(push_branch="main")

    def test_item_without_deadline_is_worked_and_submitted(self):
        out = self.run_match([("TASK-01", 0, None), ("BUG-07", 0, 40)])
        self.assertEqual({k: o.state for k, o in out.items()}, {"TASK-01": "submitted", "BUG-07": "submitted"})
        row = self.h.store._read("SELECT items_json FROM match_state WHERE id=1")[0]
        self.assertIsNone(json.loads(row["items_json"])["TASK-01"]["deadline_min"])

    def test_codex_quota_waits_without_spending_an_attempt(self):
        self.h = Harness(self.tmp, [("BUG-07", 0, 40), ("TASK-01", 0, 40)])
        real_run = self.h.agents.run
        seen = []

        def quota_once(role, it, *a, **kw):
            seen.append((role, it["id"], self.h.runner.codex_limit))
            if len(seen) == 1:
                return AgentResult(0, role, "limited", None, 0.0, ["You've hit your usage limit."], "quota")
            return real_run(role, it, *a, **kw)
        self.h.agents.run = quota_once
        out = self.h.runner.run()
        first = seen[0][1]
        self.assertEqual(seen[1], ("fixer", first, "quota"))           # cùng item chạy lại, vẫn đang chờ
        self.assertEqual({o.state for o in out.values()}, {"submitted"})
        self.assertEqual(out[first].attempts, 1)
        self.assertIsNone(self.h.runner.codex_limit)
        self.assertIsNone(self.h.store._read("SELECT codex_limit FROM match_state WHERE id=1")[0]["codex_limit"])
        self.assertTrue(any("hết quota" in line for line in self.h.logs))

    def test_one_item_crashing_does_not_stop_the_match(self):
        self.h = Harness(self.tmp, [("TASK-01", 0, 40), ("BUG-07", 0, 40)])
        real_run = self.h.agents.run

        def boom(role, it, *a, **kw):
            if it["id"] == "TASK-01":
                raise RuntimeError("boom")
            return real_run(role, it, *a, **kw)
        self.h.agents.run = boom
        out = self.h.runner.run()
        self.assertEqual((out["TASK-01"].state, out["BUG-07"].state), ("failed", "submitted"))
        self.assertIn("boom", out["TASK-01"].reason)


if __name__ == "__main__":
    unittest.main()
