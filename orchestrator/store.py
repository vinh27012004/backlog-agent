"""SQLite lưu mỗi lần chạy agent: token, chi phí, trace. Monitor đọc từ đây."""
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
  input_tokens  INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd      REAL,                       -- null nếu chưa có giá model
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
CREATE INDEX IF NOT EXISTS idx_runs_item ON agent_runs(item_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

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

    def finish_run(self, run_id: int, *, status, thread_id, usage, cost_usd, output, error) -> None:
        self.db.execute(
            "UPDATE agent_runs SET status=?, ended_at=?, thread_id=?, input_tokens=?, cached_tokens=?,"
            " output_tokens=?, cost_usd=?, output_json=?, error=? WHERE id=?",
            (
                status, time.time(), thread_id, usage.input_tokens, usage.cached_input_tokens,
                usage.output_tokens, cost_usd,
                json.dumps(output, ensure_ascii=False) if output is not None else None,
                error, run_id,
            ),
        )
        self.db.commit()

    def cost_summary(self) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT role, mode, COUNT(*) runs, SUM(input_tokens) input, SUM(cached_tokens) cached,"
            " SUM(output_tokens) output, SUM(cost_usd) cost, SUM(cost_usd IS NULL) unpriced"
            " FROM agent_runs GROUP BY role, mode ORDER BY role"
        ).fetchall()
