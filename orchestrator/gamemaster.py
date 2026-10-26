"""Kết nối Game Master: một interface, nhiều bản cài đặt (docs/legacy/ARCHITECTURE.md mục 4.7).

    gm = FakeGameMaster.from_file("samples/scenarios/practice.json", speed=20)   # trận giả, gói fake_gamemaster/
    match = gm.get_match()                       # trạng thái trận + item (VISIBLE / OPEN / CLOSED)
    item = gm.get_item("BUG-07")                 # nội dung item
    gm.start_item("BUG-07")                      # báo "bắt đầu làm" (bắt buộc trước khi nộp)
    out = safe_submit(gm, store, "BUG-07", payload, evidence)   # nộp 1 lần, an toàn khi lỗi mạng

- `FakeGameMaster` (trận giả theo kịch bản) nằm ngoài orchestrator, ở gói `fake_gamemaster/`.
- `HttpGameMaster` (API thật) viết khi BTC công bố tài liệu ở Training Camp.
- Chỉ tin đồng hồ server: deadline lấy từ `minutes_left` server trả về, không tự tính bằng giờ máy.
- Đọc thì gọi lại có giãn cách (`with_retry`); `submit` không bao giờ tự gọi lại.

Giả định về trạng thái item (kiểm lại khi có API thật): VISIBLE = đã hiện ra, chưa start;
OPEN = đội đã start; CLOSED = đã nộp, hết deadline, hoặc trận đã kết thúc.
"""
from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable

from .store import Store


# ----------------------------------------------------------------------------- lỗi
class GameMasterError(Exception):
    """Lỗi chung khi gọi Game Master."""


class GameMasterUnavailable(GameMasterError):
    """Lỗi mạng / server tạm thời. Lệnh đọc được gọi lại; với submit thì phải hỏi lại trạng thái."""


class ItemNotFound(GameMasterError):
    """Item không tồn tại hoặc chưa hiện ra."""


class Rejected(GameMasterError):
    """Server từ chối có lý do (`code`): NOT_STARTED, ALREADY_SUBMITTED, CLOSED, MATCH_NOT_RUNNING."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code


# ----------------------------------------------------------------------------- dữ liệu
@dataclass
class ItemInfo:
    id: str
    type: str
    title: str
    status: str                     # VISIBLE | OPEN | CLOSED
    minutes_left: float             # theo đồng hồ server, không tính lúc PAUSED: min(tới deadline, tới hết trận)
    deadline_min: float | None      # tổng thời gian làm của item; None = không có deadline, nộp trước hết trận
    started: bool = False
    submitted: bool = False


@dataclass
class MatchState:
    id: str
    status: str                     # RUNNING | PAUSED | ENDED
    server_time: float
    minutes_left: float             # thời gian còn lại của trận
    items: list[ItemInfo] = field(default_factory=list)

    def item(self, item_id: str) -> ItemInfo | None:
        return next((i for i in self.items if i.id == item_id), None)


class GameMasterClient(ABC):
    @abstractmethod
    def server_time(self) -> float: ...

    @abstractmethod
    def get_match(self) -> MatchState: ...

    @abstractmethod
    def get_item(self, item_id: str) -> dict: ...

    @abstractmethod
    def start_item(self, item_id: str) -> None: ...

    @abstractmethod
    def submit(self, item_id: str, payload: dict, evidence: dict | None = None) -> dict: ...


def with_retry(fn: Callable[[], Any], *, attempts: int = 3, base_delay: float = 0.5,
               sleep: Callable[[float], None] = time.sleep) -> Any:
    """Gọi lại lệnh đọc khi gặp GameMasterUnavailable, giãn cách 0.5s, 1s, 2s... Không dùng cho submit."""
    for i in range(attempts):
        try:
            return fn()
        except GameMasterUnavailable:
            if i == attempts - 1:
                raise
            sleep(base_delay * (2 ** i))


# ----------------------------------------------------------------------------- nộp an toàn
@dataclass
class SubmitOutcome:
    status: str                     # accepted | rejected | retryable | unknown
    reason: str | None = None
    response: dict | None = None
    called_api: bool = False        # lần này có gọi submit không


RETRYABLE_CODES = {"NOT_STARTED", "MATCH_NOT_RUNNING"}     # chưa tốn lượt nộp, sửa nguyên nhân rồi nộp lại


def _remote_submitted(gm: GameMasterClient, item_id: str) -> bool | None:
    """Hỏi server item đã được nộp chưa. None = không hỏi được."""
    try:
        info = with_retry(gm.get_match).item(item_id)
    except GameMasterError:
        return None
    return None if info is None else info.submitted


def safe_submit(gm: GameMasterClient, store: Store, item_id: str, payload: dict,
                evidence: dict | None = None) -> SubmitOutcome:
    """Nộp đúng 1 lần. Ghi "submitting" vào SQLite TRƯỚC khi gọi API; lỗi mạng thì hỏi lại trạng thái item
    thay vì gọi submit lần 2. `retryable` = chắc chắn chưa nộp, bên gọi được thử lại; `unknown` = chưa xác
    nhận được, không tự nộp lại (lần gọi sau sẽ hỏi server trước)."""
    row = store.get_submission(item_id)
    if row and row["status"] in ("accepted", "rejected"):
        return SubmitOutcome(row["status"], row["reason"], json.loads(row["response_json"] or "null"))
    if row and row["status"] in ("submitting", "unknown"):
        remote = _remote_submitted(gm, item_id)
        if remote is True:
            store.set_submission(item_id, "accepted", reason="xác nhận lại từ server")
            return SubmitOutcome("accepted", "xác nhận lại từ server")
        if remote is None:
            store.set_submission(item_id, "unknown", reason="chưa hỏi được trạng thái item")
            return SubmitOutcome("unknown", "chưa hỏi được trạng thái item")

    store.set_submission(item_id, "submitting")
    try:
        resp = gm.submit(item_id, payload, evidence)
    except Rejected as e:
        if e.code == "ALREADY_SUBMITTED":
            store.set_submission(item_id, "accepted", reason=e.code)
            return SubmitOutcome("accepted", e.code, called_api=True)
        status = "pending" if e.code in RETRYABLE_CODES else "rejected"
        store.set_submission(item_id, status, reason=e.code)
        return SubmitOutcome("retryable" if status == "pending" else "rejected", e.code, called_api=True)
    except GameMasterError as e:
        remote = _remote_submitted(gm, item_id)
        if remote is True:
            store.set_submission(item_id, "accepted", reason="lỗi mạng, server đã nhận")
            return SubmitOutcome("accepted", "lỗi mạng, server đã nhận", called_api=True)
        if remote is False:
            store.set_submission(item_id, "pending", reason=str(e))
            return SubmitOutcome("retryable", str(e), called_api=True)
        store.set_submission(item_id, "unknown", reason=str(e))
        return SubmitOutcome("unknown", str(e), called_api=True)
    store.set_submission(item_id, "accepted", response=resp)
    return SubmitOutcome("accepted", None, resp, called_api=True)
