"""Test Game Master giả và nộp an toàn (không tốn $, không gọi mạng).

    py -3.13 -m unittest discover -s tests -k FakeGameMasterTest
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orchestrator.gamemaster import (  # noqa: E402
    FakeGameMaster, GameMasterUnavailable, ItemNotFound, ManualClock, Rejected, safe_submit, with_retry,
)
from orchestrator.store import Store  # noqa: E402

SCENARIO = ROOT / "samples" / "scenarios" / "practice.json"


def scenario(**extra) -> dict:
    return {
        "match_id": "t", "duration_min": 40,
        "items": [
            {"at_min": 0, "deadline_min": 20, "item": {"id": "BUG-07", "title": "bug"}},
            {"at_min": 5, "deadline_min": 10, "item": {"id": "PI-03", "title": "pi"}},
        ],
        **extra,
    }


class FakeGameMasterTest(unittest.TestCase):
    def setUp(self):
        self.clock = ManualClock()
        self.gm = FakeGameMaster(scenario(), clock=self.clock)

    def minutes(self, m: float) -> None:
        self.clock.advance(m * 60)

    def test_items_appear_on_schedule_and_unreleased_items_are_hidden(self):
        self.assertEqual([i.id for i in self.gm.get_match().items], ["BUG-07"])
        with self.assertRaises(ItemNotFound):
            self.gm.get_item("PI-03")
        self.minutes(5)
        self.assertEqual([i.id for i in self.gm.get_match().items], ["BUG-07", "PI-03"])
        self.assertEqual(self.gm.get_item("PI-03")["title"], "pi")

    def test_status_flow_visible_open_closed(self):
        self.assertEqual(self.gm.get_match().item("BUG-07").status, "VISIBLE")
        self.gm.start_item("BUG-07")
        self.gm.start_item("BUG-07")                    # gọi lại không lỗi
        self.assertEqual(self.gm.get_match().item("BUG-07").status, "OPEN")
        self.gm.submit("BUG-07", {"summary": "x"}, {"mvs": "ok"})
        info = self.gm.get_match().item("BUG-07")
        self.assertEqual((info.status, info.submitted), ("CLOSED", True))

    def test_submit_rules(self):
        with self.assertRaises(Rejected) as e:
            self.gm.submit("BUG-07", {})
        self.assertEqual(e.exception.code, "NOT_STARTED")
        self.gm.start_item("BUG-07")
        res = self.gm.submit("BUG-07", {})
        self.assertEqual(res["status"], "ACCEPTED")
        self.assertTrue(res["warnings"])                # BUG thiếu evidence
        with self.assertRaises(Rejected) as e:
            self.gm.submit("BUG-07", {})
        self.assertEqual(e.exception.code, "ALREADY_SUBMITTED")

    def test_deadline_closes_item(self):
        self.gm.start_item("BUG-07")
        self.minutes(19.5)
        self.assertAlmostEqual(self.gm.get_match().item("BUG-07").minutes_left, 0.5)
        self.minutes(1)
        self.assertEqual(self.gm.get_match().item("BUG-07").status, "CLOSED")
        with self.assertRaises(Rejected) as e:
            self.gm.submit("BUG-07", {})
        self.assertEqual(e.exception.code, "CLOSED")

    def test_pause_freezes_deadline_and_blocks_submit(self):
        self.gm.start_item("BUG-07")
        self.minutes(5)
        self.gm.pause()
        self.minutes(10)
        m = self.gm.get_match()
        self.assertEqual(m.status, "PAUSED")
        self.assertEqual(m.item("BUG-07").minutes_left, 15)
        with self.assertRaises(Rejected) as e:
            self.gm.submit("BUG-07", {})
        self.assertEqual(e.exception.code, "MATCH_NOT_RUNNING")
        self.gm.resume()
        self.minutes(1)
        self.assertEqual(self.gm.get_match().item("BUG-07").minutes_left, 14)

    def test_scripted_pause_starts_at_match_minute(self):
        gm = FakeGameMaster(scenario(pauses=[{"at_min": 3, "for_min": 2}]), clock=self.clock)
        self.minutes(4)                                 # 3 phút chạy + 1 phút pause
        m = gm.get_match()
        self.assertEqual(m.status, "PAUSED")
        self.assertEqual(m.item("BUG-07").minutes_left, 17)
        self.minutes(2)                                 # hết pause từ 1 phút trước
        m = gm.get_match()
        self.assertEqual(m.status, "RUNNING")
        self.assertEqual(m.item("BUG-07").minutes_left, 16)

    def test_match_ends(self):
        self.minutes(41)
        m = self.gm.get_match()
        self.assertEqual((m.status, m.minutes_left), ("ENDED", 0))
        self.assertTrue(all(i.status == "CLOSED" for i in m.items))

    def test_pi_score_drops_with_time(self):
        self.minutes(5)
        self.gm.start_item("PI-03")
        self.minutes(5)
        self.assertEqual(self.gm.submit("PI-03", {})["provisional_score"], 50)

    def test_with_retry_only_retries_unavailable(self):
        self.gm.fail_next("get_match", times=2)
        delays: list[float] = []
        self.assertEqual(with_retry(self.gm.get_match, sleep=delays.append).id, "t")
        self.assertEqual(delays, [0.5, 1.0])
        self.gm.fail_next("get_match", times=3)
        with self.assertRaises(GameMasterUnavailable):
            with_retry(self.gm.get_match, sleep=lambda _: None)

    def test_from_file_loads_sample_scenario(self):
        gm = FakeGameMaster.from_file(SCENARIO, clock=ManualClock())
        self.assertEqual([i.id for i in gm.get_match().items], ["TASK-01", "BUG-07"])
        self.assertIn("mã giảm giá", gm.get_item("BUG-07")["title"])


class SafeSubmitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = Store(self.tmp / "state.db")
        self.clock = ManualClock()
        self.gm = FakeGameMaster(scenario(), clock=self.clock)
        self.gm.start_item("BUG-07")

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def submits(self) -> int:
        return sum(1 for m, _ in self.gm.calls if m == "submit")

    def test_accepted_once_then_never_calls_again(self):
        out = safe_submit(self.gm, self.store, "BUG-07", {"s": 1}, {"mvs": "ok"})
        self.assertEqual((out.status, out.called_api), ("accepted", True))
        self.assertEqual(out.response["status"], "ACCEPTED")
        again = safe_submit(self.gm, self.store, "BUG-07", {"s": 2})
        self.assertEqual((again.status, again.called_api), ("accepted", False))
        self.assertEqual(self.submits(), 1)

    def test_network_error_after_server_accepted_is_confirmed_without_resubmit(self):
        self.gm.fail_next("submit", applied=True)
        out = safe_submit(self.gm, self.store, "BUG-07", {"s": 1})
        self.assertEqual(out.status, "accepted")
        self.assertEqual(self.submits(), 1)
        self.assertEqual(self.store.get_submission("BUG-07")["status"], "accepted")

    def test_network_error_before_server_is_retryable(self):
        self.gm.fail_next("submit", applied=False)
        out = safe_submit(self.gm, self.store, "BUG-07", {"s": 1})
        self.assertEqual(out.status, "retryable")
        self.assertEqual(safe_submit(self.gm, self.store, "BUG-07", {"s": 1}).status, "accepted")
        self.assertEqual(self.submits(), 2)
        self.assertTrue(self.gm.get_match().item("BUG-07").submitted)

    def test_unknown_when_status_cannot_be_checked_then_reconciles(self):
        self.gm.fail_next("submit", applied=True)
        self.gm.fail_next("get_match", times=3)          # with_retry hết lượt
        with unittest.mock.patch("orchestrator.gamemaster.time.sleep"):
            out = safe_submit(self.gm, self.store, "BUG-07", {"s": 1})
            self.assertEqual(out.status, "unknown")
            # lần sau: hỏi server trước, thấy đã nộp → không gọi submit nữa
            again = safe_submit(self.gm, self.store, "BUG-07", {"s": 1})
        self.assertEqual((again.status, again.called_api), ("accepted", False))
        self.assertEqual(self.submits(), 1)

    def test_crash_while_submitting_reconciles_on_restart(self):
        self.store.set_submission("BUG-07", "submitting")   # tiến trình chết giữa chừng, chưa biết kết quả
        out = safe_submit(self.gm, self.store, "BUG-07", {"s": 1})
        self.assertEqual(out.status, "accepted")         # server chưa nhận → nộp bình thường
        self.assertEqual(self.submits(), 1)

    def test_not_started_is_retryable_closed_is_final(self):
        self.clock.advance(5 * 60)
        out = safe_submit(self.gm, self.store, "PI-03", {})
        self.assertEqual((out.status, out.reason), ("retryable", "NOT_STARTED"))
        self.gm.start_item("PI-03")
        self.assertEqual(safe_submit(self.gm, self.store, "PI-03", {}).status, "accepted")
        self.clock.advance(30 * 60)
        out = safe_submit(self.gm, self.store, "BUG-07", {})
        self.assertEqual((out.status, out.reason), ("rejected", "CLOSED"))


if __name__ == "__main__":
    unittest.main()
