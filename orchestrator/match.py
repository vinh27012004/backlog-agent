"""Vòng `run`: theo dõi trận, triage item mới, xếp hàng, xử lý từng item tới khi nộp hoặc bỏ.

    runner = MatchRunner(gm, AgentRunner(store, mode="mock"), Decider(jev, store), store,
                         Workspaces(repo, ROOT / "runs" / "worktrees"), detect(repo))
    outcomes = runner.run()            # chạy tới khi trận ENDED (hoặc hết việc nếu stop_when_idle)

Một item: start → route (tier, có reviewer) → [fixer → gate → reviewer → next_action]* → nộp hoặc bỏ.
- Hàng đợi: PI trước, rồi deadline gần nhất, rồi mức nghiêm trọng, rồi việc dễ.
- Cùng chữ ký lỗi lần 2 → báo fixer đổi giả thuyết; lần 3 → bỏ item (ARCHITECTURE mục 4.6).
- PI fail gate → kiểm 2–3 giả thuyết song song bằng pi_hypothesis trước lần thử sau (mục 6).
- Ràng buộc cứng nằm ở đây và trong Decider: không nộp khi gate fail (trừ MVS pass lúc sắp hết giờ),
  PI không review, nộp qua safe_submit.
"""
from __future__ import annotations

import threading
import time
import tomllib
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .agents import AgentRunner
from .config import ROOT, item_type
from .decisions import SEVERITY, Decider
from .gamemaster import GameMasterClient, GameMasterError, MatchState, safe_submit, with_retry
from .gate import Gate, GateReport, collect_diff, diff_text
from .store import Store
from .workspace import Workspaces

RUN_TOML = ROOT / "config" / "run.toml"
DIFFICULTY_RANK = {"easy": 0, "medium": 1, "hard": 2}
MIN_RETRY_LEFT = 5          # khớp Decider.next_action: còn dưới 5 phút thì không thử lại


@dataclass
class RunConfig:
    max_attempts: int = 3
    workers: int = 2
    poll_sec: float = 5.0
    review_min_left: float = 8.0
    regression_min_left: float = 4.0
    pi_hypotheses: int = 2
    submit_retries: int = 5
    stop_when_idle: bool = False    # dừng khi mọi item đã thấy đều xong (kịch bản giả, test)

    @classmethod
    def load(cls, path: Path = RUN_TOML, **override) -> "RunConfig":
        raw = {}
        if path.exists():
            with open(path, "rb") as f:
                raw = tomllib.load(f)
        raw.update(override)
        return cls(**{k: v for k, v in raw.items() if k in cls.__dataclass_fields__})


@dataclass
class ItemOutcome:
    item_id: str
    state: str                      # submitted | dropped | failed | unknown
    attempts: int
    reason: str = ""
    response: dict | None = None


@dataclass
class _Entry:
    item: dict
    triage: dict
    title: str = ""


def build_submission(item: dict, fix: dict, rep: GateReport, workdir: Path, base: str) -> tuple[dict, dict | None]:
    """Payload + evidence. Định dạng thật BTC công bố ở Training Camp; danh sách file lấy từ diff thật,
    không lấy từ lời agent."""
    changed = [c.path for c in collect_diff(workdir, base)]
    payload = {
        "item_id": item["id"],
        "summary": fix.get("summary", ""),
        "root_cause": fix.get("root_cause"),
        "changed_files": changed,
        "tests_added": fix.get("tests_added", []),
        "diff": diff_text(workdir, base),
    }
    evidence = None
    if item_type(item["id"]) in ("CR", "BUG"):
        mvs = next((c for c in rep.checks if c.name == "mvs"), None)
        evidence = {"mvs": {"status": mvs.status if mvs else "not_run", "log_path": mvs.log_path if mvs else None},
                    "gate": rep.to_text()}
    return payload, evidence


class MatchRunner:
    def __init__(self, gm: GameMasterClient, agents: AgentRunner, decider: Decider, store: Store,
                 workspaces: Workspaces, profile: dict | None, *, gate: Gate | None = None,
                 config: RunConfig | None = None,
                 mvs_command: Callable[[dict, Path], str | None] | None = None,
                 sleep: Callable[[float], None] = time.sleep, log: Callable[[str], None] | None = None):
        self.gm = gm
        self.agents = agents
        self.decider = decider
        self.store = store
        self.workspaces = workspaces
        self.profile = profile
        self.gate = gate or Gate(profile, store=store)
        self.config = config or RunConfig.load()
        self.mvs_command = mvs_command
        self.sleep = sleep
        self.log = log or (lambda msg: print(msg, flush=True))
        self.entries: dict[str, _Entry] = {}
        self.queue: list[str] = []
        self.active: dict[str, Future] = {}
        self.outcomes: dict[str, ItemOutcome] = {}
        self.match: MatchState | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ vòng chính
    def run(self) -> dict[str, ItemOutcome]:
        pool = ThreadPoolExecutor(self.config.workers, thread_name_prefix="item") if self.config.workers else None
        try:
            while True:
                try:
                    self.match = with_retry(self.gm.get_match, sleep=self.sleep)
                except GameMasterError as e:
                    self.log(f"[match] không hỏi được Game Master: {e}")
                    self.sleep(self.config.poll_sec)
                    continue
                self.store.set_match(self.match, max_attempts=self.config.max_attempts)
                if self.match.status == "ENDED":
                    self.log("[match] trận đã kết thúc")
                    break
                self._discover(self.match)
                self._collect_done()
                if self.match.status == "RUNNING":
                    self._dispatch(pool)
                if self.config.stop_when_idle and self._idle():
                    break
                self.sleep(self.config.poll_sec)
        finally:
            if pool:
                pool.shutdown(wait=True, cancel_futures=True)
            self._collect_done()
        return self.outcomes

    def _idle(self) -> bool:
        with self._lock:
            busy = bool(self.queue or self.active)
        future = getattr(self.gm, "unreleased", lambda: 0)()       # API thật không báo trước item sắp ra
        return not busy and not future and all(i.id in self.outcomes or i.status == "CLOSED"
                                               for i in self.match.items)

    def _discover(self, match: MatchState) -> None:
        for info in match.items:
            if info.id in self.entries or info.id in self.outcomes or info.status == "CLOSED":
                continue
            prev = self.store.get_item(info.id)
            if prev and prev["state"] in ("submitted", "dropped"):      # chạy lại sau khi crash
                self.outcomes[info.id] = ItemOutcome(info.id, prev["state"], prev["attempts"], "đã xử lý trước đó")
                continue
            try:
                item = with_retry(lambda: self.gm.get_item(info.id), sleep=self.sleep)
            except GameMasterError as e:
                self.log(f"[{info.id}] chưa lấy được nội dung: {e}")
                continue
            t = self.decider.triage(item)
            triage = {
                "id": item["id"], "type": info.type, "deadline_min": info.deadline_min,
                "severity": t["severity"].value, "difficulty": t["difficulty"].value,
                "injection_suspected": bool(t["injection"].value),
            }
            if triage["injection_suspected"]:
                self.log(f"[{info.id}] nội dung có dấu hiệu nhắm vào AI: xử lý như dữ liệu, báo fixer")
            self.entries[info.id] = _Entry(item, triage, info.title)
            with self._lock:
                self.queue.append(info.id)
            self.store.set_item(info.id, item_type=info.type, state="queued", title=info.title, triage=triage)
            self.log(f"[{info.id}] mới: {triage['severity']}/{triage['difficulty']}, còn {info.minutes_left} phút")

    def _priority(self, item_id: str) -> tuple:
        info = self.match.item(item_id) if self.match else None
        tr = self.entries[item_id].triage
        sev = SEVERITY.index(tr["severity"]) if tr["severity"] in SEVERITY else 1
        return (0 if tr["type"] == "PI" else 1, info.minutes_left if info else 1e9, -sev,
                DIFFICULTY_RANK.get(tr["difficulty"], 1))

    def _dispatch(self, pool: ThreadPoolExecutor | None) -> None:
        while True:
            with self._lock:
                if not self.queue or len(self.active) >= max(self.config.workers, 1):
                    return
                item_id = min(self.queue, key=self._priority)
                self.queue.remove(item_id)
            info = self.match.item(item_id)
            if info is None or info.status == "CLOSED":
                self._finish(item_id, "dropped", 0, "đóng trước khi kịp làm")
                continue
            if pool is None:
                self._safe_process(item_id)
            else:
                with self._lock:
                    self.active[item_id] = pool.submit(self._safe_process, item_id)

    def _collect_done(self) -> None:
        with self._lock:
            done = [k for k, f in self.active.items() if f.done()]
            for k in done:
                del self.active[k]

    def _pending(self) -> int:
        with self._lock:
            return len(self.queue) + len(self.active)

    # ------------------------------------------------------------------ một item
    def _safe_process(self, item_id: str) -> ItemOutcome:
        try:
            return self._process(item_id)
        except Exception as e:                       # một item lỗi không được làm dừng cả trận
            self.log(f"[{item_id}] lỗi không mong đợi: {type(e).__name__}: {e}")
            return self._finish(item_id, "failed", 0, f"{type(e).__name__}: {e}")

    def _minutes_left(self, item_id: str) -> float:
        try:
            info = with_retry(self.gm.get_match, sleep=self.sleep).item(item_id)
        except GameMasterError:
            info = self.match.item(item_id) if self.match else None
        return 0.0 if info is None or info.status == "CLOSED" else info.minutes_left

    def _start(self, item_id: str) -> None:
        with_retry(lambda: self.gm.start_item(item_id), sleep=self.sleep)   # start gọi lại nhiều lần vẫn an toàn

    def _process(self, item_id: str) -> ItemOutcome:
        entry = self.entries[item_id]
        item, triage = entry.item, dict(entry.triage)
        itype = triage["type"]
        self._start(item_id)
        left = self._minutes_left(item_id)
        route = self.decider.route(item, triage, pending_items=self._pending(), minutes_left=left)
        tier, want_review = route["model"].value, bool(route["reviewer"].value)
        triage["fixer_tier"] = tier
        self.store.set_item(item_id, item_type=itype, state="working", tier=tier)
        self.log(f"[{item_id}] bắt đầu: fixer {tier}, reviewer {'có' if want_review else 'không'}")
        ws = self.workspaces.create(item_id)
        others = [{"id": e.item["id"], "title": e.title} for k, e in self.entries.items() if k != item_id]
        prev: dict | None = None
        hypothesis: str | None = None

        for attempt in range(1, self.config.max_attempts + 1):
            left = self._minutes_left(item_id)
            if left <= 0:
                return self._finish(item_id, "dropped", attempt - 1, "hết hạn")
            self.store.set_item(item_id, item_type=itype, state="working", attempts=attempt)
            fix = self.agents.run("fixer", item, workdir=ws, attempt=attempt, tier=tier, profile=self.profile,
                                  deadline_min=left, triage=triage, other_items=others or None,
                                  previous_attempt=prev, hypothesis=hypothesis)
            rep: GateReport | None = None
            review_issues: list[dict] = []
            if fix.ok:
                rep = self.gate.run(item, ws, fix.output, attempt=attempt, base=self.workspaces.base,
                                    full_regression=left >= self.config.regression_min_left,
                                    mvs_command=self.mvs_command(item, ws) if self.mvs_command else None)
                fail_kind = rep.fail_kind
                if rep.passed:
                    # ghi lại để xem trên monitor; gate mới là nguồn sự thật
                    self.decider.claims_supported(item_id, fix.output, rep.to_text(), True)
                    if itype == "PI":
                        self.decider.root_cause_confirmed(item_id, fix.output)
            else:
                fail_kind = "timeout" if fix.status == "timeout" else "agent_failed"
            passed = bool(rep and rep.passed)
            self.log(f"[{item_id}] lần {attempt}: fixer {fix.status}, gate "
                     + ("pass" if passed else f"fail ({fail_kind})"))
            left = self._minutes_left(item_id)          # fixer + gate có thể đã tốn nhiều phút
            if left <= 0:
                return self._finish(item_id, "dropped", attempt, "hết hạn trước khi kịp nộp")

            if passed and want_review and itype != "PI" and left >= self.config.review_min_left:
                rev = self.agents.run("reviewer", item, workdir=ws, attempt=attempt, profile=self.profile,
                                      triage=triage, fix_result=fix.output,
                                      diff=diff_text(ws, self.workspaces.base), gate_report=rep.to_text())
                if rev.ok and rev.output.get("verdict") == "request_changes":
                    review_issues = [i for i in rev.output.get("issues", []) if i.get("severity") == "high"]
                    self.log(f"[{item_id}] reviewer yêu cầu sửa: {len(review_issues)} lỗi high")

            can_retry = attempt < self.config.max_attempts and left >= MIN_RETRY_LEFT
            ready = passed and not (review_issues and can_retry)
            if passed and review_issues and can_retry:
                fail_kind = "review_high"

            sig = rep.signature if rep else None
            repeats = sum(1 for r in self.store.gate_history(item_id) if sig and r["signature"] == sig) - 1
            if sig and repeats >= 2 and not ready:
                self.log(f"[{item_id}] chữ ký lỗi lặp lần 3: {sig}")
                return self._finish(item_id, "dropped", attempt, f"chữ ký lỗi lặp lại: {sig}")

            action = self.decider.next_action(
                item, gate_passed=ready, mvs_passed=rep.mvs_passed if rep else None, attempts=attempt,
                max_attempts=self.config.max_attempts, minutes_left=left, pending_items=self._pending(),
                last_fail=fail_kind).value
            if action == "submit":
                return self._submit(item, fix.output, rep, ws, attempt)
            if action == "drop" or attempt == self.config.max_attempts:
                return self._finish(item_id, "dropped", attempt, f"bỏ sau {attempt} lần thử ({fail_kind})")

            prev = rep.previous_attempt() if rep else {
                "attempt": attempt, "fail_kind": fail_kind, "signature": None, "failed_check": "fixer",
                "note": "; ".join(fix.errors)[:1000], "command": None, "log": ""}
            if fail_kind == "review_high":
                prev.update(fail_kind="review_high", failed_check="reviewer", review_issues=review_issues)
            if sig and repeats >= 1:
                prev["same_signature_as_before"] = True
            self.workspaces.reset(ws)
            hypothesis = None
            if itype == "PI" and fix.ok and not passed:
                hypothesis = self._check_hypotheses(item, ws, fix.output, triage, attempt)
        return self._finish(item_id, "dropped", self.config.max_attempts, "hết số lần thử")

    def _check_hypotheses(self, item: dict, ws: Path, fix: dict, triage: dict, attempt: int) -> str | None:
        """PI kẹt: lấy giả thuyết từ root_cause + suspects của fixer, kiểm song song (read-only, code gốc)."""
        ideas: list[str] = []
        for text in [fix.get("root_cause")] + [f"{s.get('symbol')}: {s.get('reason')}" for s in fix.get("suspects", [])]:
            if text and text not in ideas:
                ideas.append(text)
        ideas = ideas[: self.config.pi_hypotheses]
        if not ideas:
            return None
        self.log(f"[{item['id']}] kiểm {len(ideas)} giả thuyết song song")
        with ThreadPoolExecutor(len(ideas), thread_name_prefix="hyp") as pool:
            futures = [pool.submit(self.agents.run, "pi_hypothesis", item, workdir=ws, attempt=attempt,
                                   label=f"h{i + 1}", profile=self.profile, triage=triage, hypothesis=h)
                       for i, h in enumerate(ideas)]
            results = [f.result() for f in futures]
        lines = []
        for h, r in zip(ideas, results):
            if r.ok:
                o = r.output
                lines.append(f"- [{o['verdict']}] {o['hypothesis'] or h}\n  evidence: {'; '.join(o['evidence'])}"
                             + (f"\n  fix_location: {o['fix_location']}" if o.get("fix_location") else ""))
        return "\n".join(lines) or None

    def _submit(self, item: dict, fix: dict, rep: GateReport, ws: Path, attempt: int) -> ItemOutcome:
        item_id = item["id"]
        payload, evidence = build_submission(item, fix, rep, ws, self.workspaces.base)
        out = None
        for _ in range(self.config.submit_retries):
            out = safe_submit(self.gm, self.store, item_id, payload, evidence)
            if out.status in ("accepted", "rejected"):
                break
            if out.reason == "NOT_STARTED":
                self._start(item_id)
                continue
            self.log(f"[{item_id}] nộp chưa xong ({out.status}: {out.reason}), chờ rồi thử lại")
            self.sleep(self.config.poll_sec)
        state = {"accepted": "submitted", "rejected": "failed"}.get(out.status, "unknown")
        return self._finish(item_id, state, attempt, out.reason or "", out.response)

    def _finish(self, item_id: str, state: str, attempts: int, reason: str,
                response: dict | None = None) -> ItemOutcome:
        out = ItemOutcome(item_id, state, attempts, reason, response)
        self.outcomes[item_id] = out
        itype = item_type(item_id)
        self.store.set_item(item_id, item_type=itype, state=state, attempts=attempts, note=reason or None)
        score = f", điểm tạm {response['provisional_score']}" if response and "provisional_score" in response else ""
        self.log(f"[{item_id}] {state} sau {attempts} lần thử{score}" + (f": {reason}" if reason else ""))
        return out
