"""Test monitor (không tốn $): snapshot đọc SQLite của một trận mock, export data.js, HTTP chỉ phục vụ file cho phép.

    py -3.13 -m unittest discover -s tests -k MonitorTest
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from orchestrator import monitor  # noqa: E402
from test_match import WRONG_BUG_TEST, Harness  # noqa: E402


class MonitorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        h = Harness(cls.tmp, [("BUG-07", 0, 40), ("PI-03", 0, 18)], max_attempts=4,
                    patches={"fixer/BUG-07-1.patch": WRONG_BUG_TEST})
        h.runner.run()
        h.store.close()
        cls.db = cls.tmp / "state.db"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_snapshot_reflects_the_match(self):
        snap = monitor.snapshot(self.db, max_attempts=3)
        self.assertEqual(snap["meta"]["match_id"], "t")
        self.assertIn(snap["meta"]["status"], ("RUNNING", "ENDED"))
        items = {i["id"]: i for i in snap["items"]}
        bug = items["BUG-07"]
        self.assertEqual((bug["state"], bug["attempts"], bug["type"]), ("submitted", 2, "BUG"))
        self.assertTrue(bug["gate"]["passed"])
        self.assertEqual(bug["submission"]["score"], 100)
        self.assertEqual(bug["review"]["verdict"], "approve")
        self.assertIsNotNone(bug["minutes_left"])                     # từ match_state, theo giờ server
        steps = [t["step"] for t in bug["trace"]]
        self.assertIn("gate lần 1", steps)
        self.assertIn("nộp bài", steps)
        self.assertEqual(sorted(t["ts"] for t in bug["trace"]), [t["ts"] for t in bug["trace"]])
        self.assertIsNone(items["PI-03"]["review"])                   # PI không review
        self.assertTrue(snap["events"])
        self.assertEqual({r["role"] for r in snap["agents"]}, {"fixer", "reviewer"})
        self.assertNotIn("cost", json.dumps(snap))                     # không tính chi phí
        self.assertEqual(monitor.snapshot(self.db)["meta"]["max_attempts"], 4)   # giá trị trận đã chạy

    def test_export_js_is_loadable_sample(self):
        out = self.tmp / "data.js"
        monitor.export_js(self.db, out)
        text = out.read_text(encoding="utf-8")
        payload = json.loads(text[text.index("window.MONITOR_DATA = ") + len("window.MONITOR_DATA = "):].rstrip().rstrip(";"))
        self.assertTrue(payload["meta"]["sample"])
        self.assertEqual(len(payload["items"]), 2)

    def test_old_db_without_new_tables_still_renders(self):
        import sqlite3
        old = self.tmp / "old.db"
        conn = sqlite3.connect(old)
        conn.execute("CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, item_id TEXT, role TEXT)")
        conn.commit()
        conn.close()
        snap = monitor.snapshot(old, max_attempts=3)
        self.assertEqual(snap["items"], [])

    def test_http_serves_only_allowed_paths(self):
        server = monitor.make_server(self.db, port=0)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            state = json.loads(urllib.request.urlopen(base + "/api/state").read())
            self.assertEqual(len(state["items"]), 2)
            self.assertIn(b"Backlog Agent Monitor", urllib.request.urlopen(base + "/").read())
            for bad in ("/../orchestrator/monitor.py", "/state.db", "/.env"):
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(base + bad)
                self.assertEqual(e.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
