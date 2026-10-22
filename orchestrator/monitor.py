"""Monitor: đọc SQLite của một trận và phục vụ monitor/index.html qua HTTP cục bộ.

    python -m orchestrator.cli monitor                       # trận mới nhất trong runs/, http://127.0.0.1:8765
    python -m orchestrator.cli monitor --db runs/<match>/state.db --port 8800
    python -m orchestrator.cli monitor --db ... --export monitor/data.js   # ghi dữ liệu mẫu (mở file:// được)

- Chỉ đọc: mở SQLite ở chế độ read-only, không khóa DB của vòng run đang ghi.
- Chỉ bind 127.0.0.1, chỉ phục vụ index.html, data.js và /api/state (không duyệt thư mục).
- Không có token hay chi phí: plugin của BTC theo dõi việc đó.
"""
from __future__ import annotations

import json
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import ROOT, item_type

MONITOR_DIR = ROOT / "monitor"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/data.js": ("data.js", "text/javascript; charset=utf-8")}
TRACE_LIMIT = 80
EVENTS_LIMIT = 40


def latest_db(runs_dir: Path = ROOT / "runs") -> Path | None:
    """state.db của trận chạy gần nhất (runs/<match>/state.db), không có thì runs/state.db."""
    dbs = sorted(runs_dir.glob("*/state.db"), key=lambda p: p.stat().st_mtime)
    if dbs:
        return dbs[-1]
    legacy = runs_dir / "state.db"
    return legacy if legacy.exists() else None


def _connect(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{Path(db).resolve().as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    except sqlite3.OperationalError:          # DB của bản cũ thiếu bảng: hiển thị phần có được
        return []


def _json(text: str | None):
    try:
        return json.loads(text) if text else None
    except json.JSONDecodeError:
        return None


def _status(raw: str | None) -> str:
    """Đổi trạng thái các nguồn về 4 màu của monitor: ok | fail | warn | run."""
    raw = (raw or "").lower()
    if raw in ("fail", "failed", "timeout", "invalid_output", "rejected"):
        return "fail"
    if raw in ("run", "running", "in_progress", "submitting"):
        return "run"
    if raw in ("warn", "unknown", "pending"):
        return "warn"
    return "ok"


def snapshot(db: Path, *, max_attempts: int | None = None, sample: bool = False) -> dict:
    """Toàn bộ trạng thái trận dưới dạng JSON cho monitor."""
    conn = _connect(db)
    try:
        return _snapshot(conn, Path(db), max_attempts, sample)
    finally:
        conn.close()


def _snapshot(conn: sqlite3.Connection, db: Path, max_attempts: int | None, sample: bool) -> dict:
    match = (_rows(conn, "SELECT * FROM match_state WHERE id=1") or [{}])[0]
    clock = _json(match.get("items_json")) or {}
    items = _rows(conn, "SELECT * FROM items ORDER BY updated_at")
    runs = _rows(conn, "SELECT * FROM agent_runs ORDER BY id")
    events = _rows(conn, "SELECT e.*, r.item_id, r.role, r.attempt FROM agent_events e "
                         "JOIN agent_runs r ON r.id = e.run_id ORDER BY e.id")
    gates = _rows(conn, "SELECT * FROM gate_runs ORDER BY id")
    decisions = _rows(conn, "SELECT * FROM jev_decisions ORDER BY id")
    subs = {r["item_id"]: r for r in _rows(conn, "SELECT * FROM submissions")}

    trace: dict[str, list[dict]] = {}

    def add(item_id: str, ts: float, label: str, msg: str, s: str, tool: str | None = None) -> None:
        trace.setdefault(item_id, []).append({"ts": ts, "step": label, "msg": msg, "s": s, "tool": tool})

    for r in runs:
        who = f"{r['role']} lần {r['attempt']}"
        add(r["item_id"], r["started_at"], who, f"bắt đầu ({r['mode']}{', ' + r['model'] if r['model'] else ''})",
            "run" if r["status"] == "running" else "ok", "Codex")
        if r["ended_at"]:
            out = _json(r["output_json"]) or {}
            msg = out.get("status") or out.get("verdict") or r["status"]
            if r["error"]:
                msg += f": {r['error']}"
            add(r["item_id"], r["ended_at"], who, f"xong sau {round(r['ended_at'] - r['started_at'], 1)}s · {msg}",
                _status(r["status"]), "Codex")
    for e in events:
        add(e["item_id"], e["ts"], f"{e['role']} · {e['kind']}", e["summary"], _status(e["status"]))
    for g in gates:
        rep = _json(g["report_json"]) or {}
        msg = "pass" if g["passed"] else f"fail ({g['fail_kind']})"
        if g["signature"]:
            msg += f" · {g['signature']}"
        add(g["item_id"], g["ts"], f"gate lần {g['attempt']}", f"{msg} · {rep.get('seconds', g['seconds'])}s",
            "ok" if g["passed"] else "fail", "Gate")
    for d in decisions:
        val = _json(d["value"])
        conf = f" · {d['confidence']:.2f}" if d["confidence"] is not None else ""
        add(d["item_id"], d["ts"], f"quyết định {d['name']}", f"{val} ({d['source']}{conf})"
            + (f" · {d['reason']}" if d["reason"] else ""), "ok", "Jev" if d["source"] == "jev" else "Luật")
    for item_id, s in subs.items():
        resp = _json(s["response_json"]) or {}
        msg = s["status"] + (f" · {s['reason']}" if s["reason"] else "")
        if "provisional_score" in resp:
            msg += f" · điểm tạm {resp['provisional_score']}"
        add(item_id, s["updated_at"], "nộp bài", msg, _status(s["status"]), "Game Master")

    out_items = []
    for it in items:
        iid = it["item_id"]
        mine = [r for r in runs if r["item_id"] == iid]
        running = next((r for r in reversed(mine) if r["status"] == "running"), None)
        last_fix = next((_json(r["output_json"]) for r in reversed(mine) if r["role"] == "fixer" and r["output_json"]), None)
        last_rev = next((r for r in reversed(mine) if r["role"] == "reviewer"), None)
        last_gate = next((g for g in reversed(gates) if g["item_id"] == iid), None)
        rep = _json(last_gate["report_json"]) if last_gate else None
        triage = _json(it["triage_json"]) or {}
        sub = subs.get(iid)
        resp = _json(sub["response_json"]) if sub else None
        rev_out = _json(last_rev["output_json"]) if last_rev else None
        phase = None
        if it["state"] == "working":
            phase = f"{running['role']} lần {running['attempt']}" if running else "gate / quyết định"
        t = sorted(trace.get(iid, []), key=lambda x: x["ts"])[-TRACE_LIMIT:]
        out_items.append({
            "id": iid, "type": it["item_type"] or item_type(iid), "title": it["title"] or "",
            "state": it["state"], "phase": phase, "attempts": it["attempts"], "tier": it["tier"],
            "note": it["note"], "updated_at": it["updated_at"],
            "severity": triage.get("severity"), "difficulty": triage.get("difficulty"),
            "injection": bool(triage.get("injection_suspected")),
            "deadline_min": (clock.get(iid) or {}).get("deadline_min", triage.get("deadline_min")),
            "minutes_left": (clock.get(iid) or {}).get("minutes_left"),
            "gm_status": (clock.get(iid) or {}).get("status"),
            "gate": None if not rep else {
                "attempt": rep.get("attempt"), "passed": rep.get("passed"), "fail_kind": rep.get("fail_kind"),
                "signature": rep.get("signature"), "log": rep.get("log"),
                "checks": [{k: c.get(k) for k in ("name", "status", "seconds", "note")} for c in rep.get("checks", [])],
            },
            "review": None if not rev_out else {
                "verdict": rev_out.get("verdict"), "summary": rev_out.get("summary"),
                "issues": [i for i in rev_out.get("issues", []) if i.get("severity") in ("high", "medium")],
            },
            "fix": None if not last_fix else {k: last_fix.get(k) for k in (
                "status", "summary", "root_cause", "confidence", "changed_files", "tests_added", "risks")},
            "submission": None if not sub else {
                "status": sub["status"], "reason": sub["reason"],
                "score": (resp or {}).get("provisional_score"), "warnings": (resp or {}).get("warnings", []),
            },
            "trace": t,
        })

    recent = sorted(((iid, x) for iid, xs in trace.items() for x in xs), key=lambda p: -p[1]["ts"])[:EVENTS_LIMIT]
    jev = _rows(conn, "SELECT name, COUNT(*) n, SUM(source = 'jev') by_jev, ROUND(AVG(latency_ms), 0) avg_ms"
                      " FROM jev_decisions GROUP BY name ORDER BY name")
    agents = _rows(conn, "SELECT role, mode, COUNT(*) runs, SUM(status = 'ok') ok,"
                         " ROUND(AVG(ended_at - started_at), 1) avg_sec FROM agent_runs GROUP BY role, mode ORDER BY role")
    if max_attempts is None:
        max_attempts = match.get("max_attempts")              # giá trị trận đã chạy, không phải run.toml hiện tại
    if max_attempts is None:
        from .match import RunConfig
        max_attempts = RunConfig.load().max_attempts
    return {
        "meta": {
            "match_id": match.get("match_id") or db.parent.name, "status": match.get("status"),
            "minutes_left": match.get("minutes_left"), "match_updated_at": match.get("updated_at"),
            "generated_at": time.time(), "db": db.as_posix(), "sample": sample, "max_attempts": max_attempts,
        },
        "items": out_items,
        "events": [{"item": iid, **x} for iid, x in recent],
        "jev": jev,
        "agents": agents,
    }


def export_js(db: Path, dest: Path) -> None:
    """Ghi snapshot thành data.js (window.MONITOR_DATA) để mở index.html bằng file:// vẫn có dữ liệu mẫu."""
    data = snapshot(db, sample=True)
    data["meta"]["db"] = "samples (mock match)"
    body = json.dumps(data, ensure_ascii=False, indent=1)
    dest.write_text("// DỮ LIỆU MẪU cho monitor, sinh bằng: python -m orchestrator.cli monitor --db <state.db> "
                    "--export monitor/data.js\n// Mở qua `cli monitor` thì monitor đọc /api/state thay cho file này.\n"
                    f"window.MONITOR_DATA = {body};\n", encoding="utf-8")


def make_server(db: Path, *, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                try:
                    body, ctype, code = json.dumps(snapshot(db), ensure_ascii=False).encode(), "application/json", 200
                except sqlite3.Error as e:
                    body, ctype, code = json.dumps({"error": str(e)}).encode(), "application/json", 503
            elif path in STATIC:
                name, ctype = STATIC[path]
                body, code = (MONITOR_DIR / name).read_bytes(), 200
            else:
                body, ctype, code = b"not found", "text/plain", 404
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):        # không in mỗi request ra console
            pass

    return ThreadingHTTPServer((host, port), Handler)


def serve(db: Path, *, host: str = "127.0.0.1", port: int = 8765) -> None:
    server = make_server(db, host=host, port=port)
    print(f"Monitor: http://{host}:{port}  (DB: {db})  Ctrl+C để dừng")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
