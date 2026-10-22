"""SQLite lưu mỗi lần chạy agent: trạng thái, thời gian, đầu ra, trace. Monitor đọc từ đây."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL,
  item_type     TEXT NOT NULL,
  role          TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  mode          TEXT NOT NULL,              -- live | mock
  model         TEXT,
  status        TEXT NOT NULL,              -- running | ok | failed | timeout | invalid_output
  started_at    REAL NOT NULL,
  ended_at      REAL,
  thread_id     TEXT,
  output_json   TEXT,
  error         TEXT,
  jsonl_path    TEXT
);
CREATE TABLE IF NOT EXISTS agent_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES agent_runs(id),
  ts       REAL NOT NULL,
  kind     TEXT NOT NULL,
  summary  TEXT NOT NULL,
  status   TEXT
);
CREATE TABLE IF NOT EXISTS jev_decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          REAL NOT NULL,
  item_id     TEXT NOT NULL,
  name        TEXT NOT NULL,                -- triage: severity/difficulty/injection/module, route, next_action...
  value       TEXT,                         -- JSON
  source      TEXT NOT NULL,                -- jev | fallback
  confidence  REAL,
  latency_ms  REAL,
  reason      TEXT                          -- vì sao dùng fallback
);
CREATE TABLE IF NOT EXISTS gate_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL NOT NULL,
  item_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  passed        INTEGER NOT NULL,
  fail_kind     TEXT,
  signature     TEXT,                         -- chữ ký lỗi, để phát hiện vòng lặp
  seconds       REAL,
  report_json   TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  item_id       TEXT PRIMARY KEY,             -- mỗi item chỉ nộp 1 lần
  status        TEXT NOT NULL,                -- submitting | accepted | rejected | pending | unknown
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  reason        TEXT,
  response_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_item ON agent_runs(item_id);
CREATE INDEX IF NOT EXISTS idx_gate_item ON gate_runs(item_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def start_run(self, *, item_id, item_type, role, attempt, mode, model, jsonl_path) -> int:
        cur = self.db.execute(
            "INSERT INTO agent_runs(item_id,item_type,role,attempt,mode,model,status,started_at,jsonl_path)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (item_id, item_type, role, attempt, mode, model or None, "running", time.time(), str(jsonl_path)),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def add_event(self, run_id: int, kind: str, summary: str, status: str = "") -> None:
        self.db.execute(
            "INSERT INTO agent_events(run_id,ts,kind,summary,status) VALUES(?,?,?,?,?)",
            (run_id, time.time(), kind, summary, status),
        )
        self.db.commit()

    def finish_run(self, run_id: int, *, status, thread_id, output, error) -> None:
        self.db.execute(
            "UPDATE agent_runs SET status=?, ended_at=?, thread_id=?, output_json=?, error=? WHERE id=?",
            (
                status, time.time(), thread_id,
                json.dumps(output, ensure_ascii=False) if output is not None else None,
                error, run_id,
            ),
        )
        self.db.commit()

    def add_decision(self, *, item_id, name, value, source, confidence, latency_ms, reason) -> None:
        self.db.execute(
            "INSERT INTO jev_decisions(ts,item_id,name,value,source,confidence,latency_ms,reason)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), item_id, name, json.dumps(value, ensure_ascii=False), source,
             confidence, round(latency_ms, 1), reason or None),
        )
        self.db.commit()

    def add_gate_run(self, report) -> None:
        self.db.execute(
            "INSERT INTO gate_runs(ts,item_id,attempt,passed,fail_kind,signature,seconds,report_json)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), report.item_id, report.attempt, int(report.passed), report.fail_kind,
             report.signature, report.seconds, json.dumps(report.to_dict(), ensure_ascii=False)),
        )
        self.db.commit()

    def gate_history(self, item_id: str) -> list[sqlite3.Row]:
        """Các lần chạy gate của một item theo thứ tự (attempt, passed, fail_kind, signature)."""
        return self.db.execute(
            "SELECT attempt, passed, fail_kind, signature, seconds FROM gate_runs WHERE item_id=? ORDER BY id",
            (item_id,),
        ).fetchall()

    def get_submission(self, item_id: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM submissions WHERE item_id=?", (item_id,)).fetchone()

    def set_submission(self, item_id: str, status: str, *, reason: str | None = None,
                       response: dict | None = None) -> None:
        """Ghi và commit ngay: "submitting" phải nằm trên đĩa trước khi gọi API nộp bài."""
        now = time.time()
        self.db.execute(
            "INSERT INTO submissions(item_id,status,created_at,updated_at,reason,response_json) VALUES(?,?,?,?,?,?)"
            " ON CONFLICT(item_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,"
            " reason=excluded.reason, response_json=COALESCE(excluded.response_json, submissions.response_json)",
            (item_id, status, now, now, reason,
             json.dumps(response, ensure_ascii=False) if response is not None else None),
        )
        self.db.commit()

    def decision_summary(self) -> list[sqlite3.Row]:
        """Tỉ lệ quyết định do Jev đưa ra (so với luật code dự phòng) theo từng loại."""
        return self.db.execute(
            "SELECT name, COUNT(*) n, SUM(source = 'jev') by_jev, ROUND(AVG(latency_ms), 0) avg_ms"
            " FROM jev_decisions GROUP BY name ORDER BY name"
        ).fetchall()

    def run_summary(self) -> list[sqlite3.Row]:
        """Số lần chạy, số lần thành công, thời gian trung bình theo vai trò."""
        return self.db.execute(
            "SELECT role, mode, COUNT(*) runs, SUM(status = 'ok') ok,"
            " ROUND(AVG(ended_at - started_at), 1) avg_sec"
            " FROM agent_runs GROUP BY role, mode ORDER BY role"
        ).fetchall()
