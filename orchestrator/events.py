"""Đọc luồng JSONL của `codex exec --json`.

Đã đối chiếu với codex-cli 0.162.1: thread.started, turn.started, item.started,
item.updated, item.completed, turn.completed, turn.failed, error.
Số token/chi phí do plugin của BTC theo dõi, orchestrator không đọc.
Chấp nhận cả tên cũ (trước 0.44: item_type, assistant_message) cho chắc.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

# Lỗi do tài khoản Codex, không do bản fix: vòng run tạm dừng thay vì tính lần thử (ARCHITECTURE mục 4.6).
# Thông báo thật của Codex cần kiểm lại trong Training Camp; quota xét trước rate limit.
QUOTA_RE = re.compile(r"usage limit|quota|insufficient_quota|billing|out of credits|purchase more credits", re.I)
RATE_LIMIT_RE = re.compile(r"rate.?limit|too many requests|\b429\b", re.I)


def limit_kind(text: str) -> str | None:
    """"quota" (hết tiền, cần đổi tài khoản), "rate_limit" (chờ là hết) hoặc None."""
    if QUOTA_RE.search(text):
        return "quota"
    if RATE_LIMIT_RE.search(text):
        return "rate_limit"
    return None


@dataclass
class TraceEvent:
    kind: str      # message | command | file_change | mcp | web_search | reasoning | error | other
    summary: str
    status: str = ""   # ok | fail | run | ""


@dataclass
class EventState:
    thread_id: str | None = None
    last_message: str | None = None
    errors: list[str] = field(default_factory=list)
    trace: list[TraceEvent] = field(default_factory=list)
    turn_failed: bool = False
    limit: str | None = None       # quota | rate_limit: có lỗi tài khoản Codex trong luồng (kể cả lỗi đã tự nối lại)

    def note_error(self, msg: str) -> None:
        self.errors.append(msg)
        if self.limit != "quota":
            self.limit = limit_kind(msg) or self.limit


def _short(text: str, n: int = 160) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _item_event(item: dict) -> TraceEvent | None:
    itype = item.get("type") or item.get("item_type") or ""
    if itype in ("agent_message", "assistant_message"):
        return TraceEvent("message", _short(item.get("text", "")), "ok")
    if itype == "command_execution":
        code = item.get("exit_code")
        status = "ok" if code == 0 else ("fail" if code is not None else "")
        return TraceEvent("command", _short(item.get("command", "")), status)
    if itype == "file_change":
        changes = item.get("changes") or []
        paths = ", ".join(c.get("path", "?") for c in changes if isinstance(c, dict)) or "file change"
        return TraceEvent("file_change", _short(paths), "ok")
    if itype == "mcp_tool_call":
        name = f"{item.get('server', '?')}.{item.get('tool', '?')}"
        st = item.get("status", "")
        return TraceEvent("mcp", name, "fail" if st == "failed" else "ok")
    if itype == "web_search":
        return TraceEvent("web_search", _short(item.get("query", "")), "ok")
    if itype == "reasoning":
        return None  # không lưu suy luận vào trace để gọn
    if itype == "error":
        return TraceEvent("error", _short(item.get("message", "")), "fail")
    return TraceEvent("other", _short(itype), "")


def feed(state: EventState, line: str) -> TraceEvent | None:
    """Xử lý một dòng JSONL. Trả về sự kiện trace mới (nếu có)."""
    line = line.strip()
    if not line or not line.startswith("{"):
        return None
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return None
    t = ev.get("type", "")
    if t == "thread.started":
        state.thread_id = ev.get("thread_id")
    elif t == "turn.failed":
        state.turn_failed = True
        msg = (ev.get("error") or {}).get("message", "turn failed")
        state.note_error(msg)
        te = TraceEvent("error", _short(msg), "fail")
        state.trace.append(te)
        return te
    elif t == "error":
        msg = ev.get("message", "error")
        state.note_error(msg)
        # "Reconnecting..." là lỗi tạm, không đưa vào trace
        if not msg.startswith("Reconnecting"):
            te = TraceEvent("error", _short(msg), "fail")
            state.trace.append(te)
            return te
    elif t == "item.completed":
        item = ev.get("item") or {}
        if (item.get("type") or item.get("item_type")) in ("agent_message", "assistant_message"):
            state.last_message = item.get("text")
        te = _item_event(item)
        if te:
            state.trace.append(te)
        return te
    return None
