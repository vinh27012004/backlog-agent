"""Game Master giả: chạy một trận theo kịch bản JSON để thử cả vòng run mà không cần server BTC.

    gm = FakeGameMaster.from_file("samples/scenarios/practice.json", speed=20)   # tua nhanh 20 lần
    gm = FakeGameMaster(scenario, clock=ManualClock())                           # trong test: clock.advance(60)

Chỉ code thử nghiệm dùng gói này; `orchestrator` chỉ biết interface `GameMasterClient`.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

from orchestrator.config import item_type
from orchestrator.gamemaster import (
    GameMasterClient, GameMasterUnavailable, ItemInfo, ItemNotFound, MatchState, Rejected,
)


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
         "items": [{"at_min": 0, "file": "../items/TASK-01.json"},              # không có deadline
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
                "deadline": None if spec.get("deadline_min") is None else float(spec["deadline_min"]) * 60,
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
        if not payload.get("gitRevision"):
            warnings.append("thiếu gitRevision (SHA commit đã push)")
        # điểm tạm: PI giảm theo thời gian nộp, loại khác cố định; Grader thật chấm lại
        window = it["deadline"] if it["deadline"] is not None else self.duration - it["at"]
        score = round(100 * info.minutes_left / (window / 60)) if itype == "PI" else 100
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
        left = self.duration - elapsed
        if it["deadline"] is not None:
            left = min(left, it["at"] + it["deadline"] - elapsed)
        left /= 60
        closed = it["submission"] is not None or left <= 0 or elapsed >= self.duration
        status = "CLOSED" if closed else ("OPEN" if it["started"] else "VISIBLE")
        deadline_min = None if it["deadline"] is None else it["deadline"] / 60
        return ItemInfo(item_id, item_type(item_id), it["content"].get("title", ""), status,
                        round(max(0.0, left), 2), deadline_min, it["started"], it["submission"] is not None)
