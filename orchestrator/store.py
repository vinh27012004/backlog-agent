"""SQLite lưu trạng thái trận: item, lần chạy agent, trace, quyết định Jev, gate, nộp bài. Monitor đọc từ đây.

Một kết nối dùng chung cho mọi thread của vòng `run`, có khóa; mỗi lần ghi commit ngay."""
from __future__ import annotations

import json
import sqlite3
import threading
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
CREATE TABLE IF NOT EXISTS items (
  item_id       TEXT PRIMARY KEY,
  item_type     TEXT NOT NULL,
  title         TEXT,
  state         TEXT NOT NULL,                -- queued | working | submitted | dropped | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  tier          TEXT,                         -- small | strong
  triage_json   TEXT,
  note          TEXT,
  updated_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_item ON agent_runs(item_id);
CREATE INDEX IF NOT EXISTS idx_gate_item ON gate_runs(item_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _write(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self.lock:
            cur = self.db.execute(sql, params)
            self.db.commit()
            return cur

    def _read(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, params).fetchall()

    # ------------------------------------------------------------------ agent
    def start_run(self, *, item_id, item_type, role, attempt, mode, model, jsonl_path) -> int:
        cur = self._write(
            "INSERT INTO agent_runs(item_id,item_type,role,attempt,mode,model,status,started_at,jsonl_path)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (item_id, item_type, role, attempt, mode, model or None, "running", time.time(), str(jsonl_path)),
        )
        return int(cur.lastrowid)

    def add_event(self, run_id: int, kind: str, summary: str, status: str = "") -> None:
        self._write(
            "INSERT INTO agent_events(run_id,ts,kind,summary,status) VALUES(?,?,?,?,?)",
            (run_id, time.time(), kind, summary, status),
        )

    def finish_run(self, run_id: int, *, status, thread_id, output, error) -> None:
        self._write(
            "UPDATE agent_runs SET status=?, ended_at=?, thread_id=?, output_json=?, error=? WHERE id=?",
            (
                status, time.time(), thread_id,
                json.dumps(output, ensure_ascii=False) if output is not None else None,
                error, run_id,
            ),
        )

    # ------------------------------------------------------------------ Jev
    def add_decision(self, *, item_id, name, value, source, confidence, latency_ms, reason) -> None:
        self._write(
            "INSERT INTO jev_decisions(ts,item_id,name,value,source,confidence,latency_ms,reason)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), item_id, name, json.dumps(value, ensure_ascii=False), source,
             confidence, round(latency_ms, 1), reason or None),
        )

    # ------------------------------------------------------------------ gate
    def add_gate_run(self, report) -> None:
        self._write(
            "INSERT INTO gate_runs(ts,item_id,attempt,passed,fail_kind,signature,seconds,report_json)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), report.item_id, report.attempt, int(report.passed), report.fail_kind,
             report.signature, report.seconds, json.dumps(report.to_dict(), ensure_ascii=False)),
        )

    def gate_history(self, item_id: str) -> list[sqlite3.Row]:
        """Các lần chạy gate của một item theo thứ tự (attempt, passed, fail_kind, signature)."""
        return self._read(
            "SELECT attempt, passed, fail_kind, signature, seconds FROM gate_runs WHERE item_id=? ORDER BY id",
            (item_id,),
        )

    # ------------------------------------------------------------------ nộp bài
    def get_submission(self, item_id: str) -> sqlite3.Row | None:
        rows = self._read("SELECT * FROM submissions WHERE item_id=?", (item_id,))
        return rows[0] if rows else None

    def set_submission(self, item_id: str, status: str, *, reason: str | None = None,
                       response: dict | None = None) -> None:
        """Ghi và commit ngay: "submitting" phải nằm trên đĩa trước khi gọi API nộp bài."""
        now = time.time()
        self._write(
            "INSERT INTO submissions(item_id,status,created_at,updated_at,reason,response_json) VALUES(?,?,?,?,?,?)"
            " ON CONFLICT(item_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,"
            " reason=excluded.reason, response_json=COALESCE(excluded.response_json, submissions.response_json)",
            (item_id, status, now, now, reason,
             json.dumps(response, ensure_ascii=False) if response is not None else None),
        )

    # ------------------------------------------------------------------ item
    def set_item(self, item_id: str, *, item_type: str, state: str, title: str | None = None,
                 attempts: int | None = None, tier: str | None = None, triage: dict | None = None,
                 note: str | None = None) -> None:
        """Ghi trạng thái item; trường để None thì giữ giá trị cũ."""
        self._write(
            "INSERT INTO items(item_id,item_type,title,state,attempts,tier,triage_json,note,updated_at)"
            " VALUES(?,?,?,?,COALESCE(?,0),?,?,?,?)"
            " ON CONFLICT(item_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at,"
            " title=COALESCE(excluded.title, items.title), attempts=COALESCE(?, items.attempts),"
            " tier=COALESCE(excluded.tier, items.tier),"
            " triage_json=COALESCE(excluded.triage_json, items.triage_json),"
            " note=COALESCE(excluded.note, items.note)",
            (item_id, item_type, title, state, attempts, tier,
             json.dumps(triage, ensure_ascii=False) if triage is not None else None, note, time.time(), attempts),
        )

    def get_item(self, item_id: str) -> sqlite3.Row | None:
        rows = self._read("SELECT * FROM items WHERE item_id=?", (item_id,))
        return rows[0] if rows else None

    def items(self) -> list[sqlite3.Row]:
        return self._read("SELECT * FROM items ORDER BY updated_at")

    # ------------------------------------------------------------------ thống kê
    def decision_summary(self) -> list[sqlite3.Row]:
        """Tỉ lệ quyết định do Jev đưa ra (so với luật code dự phòng) theo từng loại."""
        return self._read(
            "SELECT name, COUNT(*) n, SUM(source = 'jev') by_jev, ROUND(AVG(latency_ms), 0) avg_ms"
            " FROM jev_decisions GROUP BY name ORDER BY name"
        )

    def run_summary(self) -> list[sqlite3.Row]:
        """Số lần chạy, số lần thành công, thời gian trung bình theo vai trò."""
        return self._read(
            "SELECT role, mode, COUNT(*) runs, SUM(status = 'ok') ok,"
            " ROUND(AVG(ended_at - started_at), 1) avg_sec"
            " FROM agent_runs GROUP BY role, mode ORDER BY role"
        )
