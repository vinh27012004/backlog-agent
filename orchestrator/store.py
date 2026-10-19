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
CREATE INDEX IF NOT EXISTS idx_runs_item ON agent_runs(item_id);
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
