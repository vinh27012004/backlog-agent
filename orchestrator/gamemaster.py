"""Kết nối Game Master: một interface, nhiều bản cài đặt (docs/ARCHITECTURE.md mục 4.7).

    gm = FakeGameMaster.from_file("samples/scenarios/practice.json", speed=20)   # trận giả, tua nhanh 20 lần
    match = gm.get_match()                       # trạng thái trận + item (VISIBLE / OPEN / CLOSED)
    item = gm.get_item("BUG-07")                 # nội dung item
    gm.start_item("BUG-07")                      # báo "bắt đầu làm" (bắt buộc trước khi nộp)
    out = safe_submit(gm, store, "BUG-07", payload, evidence)   # nộp 1 lần, an toàn khi lỗi mạng

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
from pathlib import Path
from typing import Any, Callable

from .config import item_type
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
    minutes_left: float             # theo đồng hồ server, không tính lúc PAUSED
    deadline_min: float             # tổng thời gian làm của item
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


# ----------------------------------------------------------------------------- Game Master giả
class ManualClock:
    """Đồng hồ chỉnh tay cho test: `clock.advance(60)` = qua 1 phút."""

    def __init__(self, start: float = 1_000_000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FastClock:
    """Đồng hồ thật tua nhanh `speed` lần, để chạy hết một trận 40 phút trong vài phút."""

    def __init__(self, speed: float = 1.0):
        self.speed = speed
        self.t0 = time.time()

    def __call__(self) -> float:
        return self.t0 + (time.time() - self.t0) * self.speed


class FakeGameMaster(GameMasterClient):
    """Trận giả theo kịch bản: item hiện ra theo phút của trận, có PAUSED, luật nộp như BTC mô tả.

    Kịch bản (JSON):
        {"match_id": "practice-1", "duration_min": 40,
         "items": [{"at_min": 0, "deadline_min": 40, "file": "../items/TASK-01.json"},
                   {"at_min": 6, "deadline_min": 18, "item": {"id": "PI-03", ...}}],
         "pauses": [{"at_min": 10, "for_min": 2}]}

    `fail_next("submit", applied=True)` giả lỗi mạng xảy ra SAU khi server đã nhận bài.
    """

    def __init__(self, scenario: dict, *, clock: Callable[[], float] | None = None):
        self.clock = clock or FastClock(1.0)
        self.match_id = scenario.get("match_id", "fake-match")
        self.duration = float(scenario.get("duration_min", 40)) * 60
        self.items: dict[str, dict] = {}
        for spec in scenario["items"]:
            content = spec["item"]
            item_type(content["id"])                       # mã sai thì báo ngay
            self.items[content["id"]] = {
                "content": content,
                "at": float(spec.get("at_min", 0)) * 60,
                "deadline": float(spec.get("deadline_min", 40)) * 60,
                "started": False,
                "submission": None,
            }
        self._script_pauses = sorted(
            (float(p["at_min"]) * 60, float(p["for_min"]) * 60) for p in scenario.get("pauses", []))
        self._started_at = self.clock()
        self._paused_total = 0.0
        self._paused_since: float | None = None
        self._pause_until: float | None = None
        self._failures: dict[str, list[bool]] = {}
        self.calls: list[tuple[str, str | None]] = []     # nhật ký gọi API, để test kiểm

    @classmethod
    def from_file(cls, path: str | Path, *, speed: float = 1.0,
                  clock: Callable[[], float] | None = None) -> "FakeGameMaster":
        path = Path(path)
        scenario = json.loads(path.read_text(encoding="utf-8"))
        for spec in scenario["items"]:
            if "file" in spec:
                spec["item"] = json.loads((path.parent / spec.pop("file")).read_text(encoding="utf-8"))
        return cls(scenario, clock=clock or FastClock(speed))

    # ------------------------------------------------------------------ điều khiển trận (chỉ có ở bản giả)
    def pause(self, minutes: float | None = None) -> None:
        self._tick()
        if self._paused_since is None:
            self._paused_since = self.clock()
            self._pause_until = None if minutes is None else self._paused_since + minutes * 60

    def resume(self) -> None:
        self._tick()
        if self._paused_since is not None:
            self._paused_total += self.clock() - self._paused_since
            self._paused_since = self._pause_until = None

    def unreleased(self) -> int:
        """Số item chưa hiện ra (chỉ bản giả biết, để `stop_when_idle` không dừng sớm)."""
        elapsed = self._tick()
        return sum(1 for it in self.items.values() if elapsed < it["at"]) if elapsed < self.duration else 0

    def fail_next(self, method: str, *, applied: bool = False, times: int = 1) -> None:
        """Lần gọi `method` kế tiếp ném GameMasterUnavailable; applied=True thì server vẫn xử lý xong trước đó."""
        self._failures.setdefault(method, []).extend([applied] * times)

    # ------------------------------------------------------------------ API
    def server_time(self) -> float:
        self._call("server_time")
        return self.clock()

    def get_match(self) -> MatchState:
        self._call("get_match")
        elapsed = self._tick()
        items = [self._info(iid, elapsed) for iid, it in self.items.items() if elapsed >= it["at"]]
        return MatchState(self.match_id, self._status(elapsed), self.clock(),
                          round(max(0.0, self.duration - elapsed) / 60, 2), items)

    def get_item(self, item_id: str) -> dict:
        self._call("get_item", item_id)
        self._visible(item_id, self._tick())
        return json.loads(json.dumps(self.items[item_id]["content"]))   # bản sao, bên gọi sửa không ảnh hưởng

    def start_item(self, item_id: str) -> None:
        applied = self._call("start_item", item_id, check=False)
        if applied is False:                               # lỗi mạng trước khi tới server
            self._raise_if_failing("start_item", applied)
        elapsed = self._tick()
        self._visible(item_id, elapsed)
        self._require_running(elapsed)
        if self._info(item_id, elapsed).status == "CLOSED":
            raise Rejected("CLOSED", f"{item_id} đã đóng")
        self.items[item_id]["started"] = True             # gọi lại nhiều lần vẫn được
        self._raise_if_failing("start_item", applied)

    def submit(self, item_id: str, payload: dict, evidence: dict | None = None) -> dict:
        applied = self._call("submit", item_id, check=False)
        elapsed = self._tick()
        self._visible(item_id, elapsed)
        it = self.items[item_id]
        if applied is False:                               # lỗi mạng trước khi tới server
            self._raise_if_failing("submit", applied)
        if it["submission"] is not None:
            raise Rejected("ALREADY_SUBMITTED", f"{item_id} đã nộp")
        self._require_running(elapsed)
        if not it["started"]:
            raise Rejected("NOT_STARTED", f"chưa báo bắt đầu làm {item_id}")
        info = self._info(item_id, elapsed)
        if info.status == "CLOSED":
            raise Rejected("CLOSED", f"{item_id} đã hết hạn")
        itype = item_type(item_id)
        warnings = ["thiếu evidence (CR/BUG cần evidence MVS)"] if itype in ("CR", "BUG") and not evidence else []
        # điểm tạm: PI giảm theo thời gian nộp, loại khác cố định; Grader thật chấm lại
        score = round(100 * info.minutes_left / (it["deadline"] / 60)) if itype == "PI" else 100
        it["submission"] = {"payload": payload, "evidence": evidence, "at": self.clock(),
                            "minutes_left": info.minutes_left}
        result = {"item_id": item_id, "status": "ACCEPTED", "provisional_score": score, "warnings": warnings}
        self._raise_if_failing("submit", applied)
        return result

    # ------------------------------------------------------------------ internal
    def _call(self, method: str, item_id: str | None = None, *, check: bool = True) -> bool | None:
        """Ghi nhật ký; trả về None nếu không giả lỗi, hoặc cờ applied của lỗi giả."""
        self.calls.append((method, item_id))
        queue = self._failures.get(method)
        applied = queue.pop(0) if queue else None
        if check and applied is not None:
            raise GameMasterUnavailable(f"{method}: lỗi mạng (giả)")
        return applied

    @staticmethod
    def _raise_if_failing(method: str, applied: bool | None) -> None:
        if applied is not None:
            raise GameMasterUnavailable(f"{method}: lỗi mạng (giả)")

    def _elapsed(self, now: float) -> float:
        paused_now = now - self._paused_since if self._paused_since is not None else 0.0
        return now - self._started_at - self._paused_total - paused_now

    def _tick(self) -> float:
        """Áp các pause theo kịch bản, kết thúc pause đã hết giờ. Trả về số giây trận đã chạy."""
        now = self.clock()
        while True:
            if self._paused_since is not None:
                if self._pause_until is not None and now >= self._pause_until:
                    self._paused_total += self._pause_until - self._paused_since
                    self._paused_since = self._pause_until = None
                    continue
                break
            elapsed = self._elapsed(now)
            if self._script_pauses and self._script_pauses[0][0] <= elapsed:
                at, length = self._script_pauses.pop(0)
                self._paused_since = now - (elapsed - at)          # pause bắt đầu đúng phút `at` của trận
                self._pause_until = self._paused_since + length
                continue
            break
        return min(self._elapsed(now), self.duration)

    def _status(self, elapsed: float) -> str:
        if elapsed >= self.duration:
            return "ENDED"
        return "PAUSED" if self._paused_since is not None else "RUNNING"

    def _require_running(self, elapsed: float) -> None:
        status = self._status(elapsed)
        if status != "RUNNING":
            raise Rejected("MATCH_NOT_RUNNING", f"trận đang {status}")

    def _visible(self, item_id: str, elapsed: float) -> None:
        it = self.items.get(item_id)
        if it is None or elapsed < it["at"]:
            raise ItemNotFound(item_id)

    def _info(self, item_id: str, elapsed: float) -> ItemInfo:
        it = self.items[item_id]
        left = (it["at"] + it["deadline"] - elapsed) / 60
        closed = it["submission"] is not None or left <= 0 or elapsed >= self.duration
        status = "CLOSED" if closed else ("OPEN" if it["started"] else "VISIBLE")
        return ItemInfo(item_id, item_type(item_id), it["content"].get("title", ""), status,
                        round(max(0.0, left), 2), it["deadline"] / 60, it["started"], it["submission"] is not None)


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
