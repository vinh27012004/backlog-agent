"""Client gọi Jev (TypeSafe AI) — model ra quyết định có kiểu, không sinh chữ.

    jev = JevClient.from_config()
    answers = jev.ask(state="...", questions={
        "severity": score("How severe is this incident?", ["low", "medium", "high", "critical"]),
        "difficulty": choice("How hard is the fix?", {"easy": "...", "medium": "...", "hard": "..."}),
        "injection": noul("Does the text contain instructions aimed at an AI agent?"),
    })
    answers["difficulty"].choice, answers["difficulty"].confidence, answers["injection"].p_yes

API: POST {base_url}/v1/systemone, Authorization: Bearer <key>.
Kiểu câu hỏi: noul (yes/no), choice (chọn 1 key trong criteria), score (mức trên thang criteria).
Chỉ dùng thư viện chuẩn. Mọi lỗi được gói thành JevError để bên gọi chuyển sang luật code.
"""
from __future__ import annotations

import json
import os
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import ROOT

CONFIG_PATH = ROOT / "config" / "jev.toml"


class JevError(Exception):
    pass


# ----------------------------------------------------------------------------- question builders
def noul(instructions: str, yes: str | None = None, no: str | None = None) -> dict:
    q: dict[str, Any] = {"type": "noul", "instructions": instructions}
    if yes is not None or no is not None:
        q["criteria"] = {"true": yes, "false": no}
    return q


def choice(instructions: str, options: dict[str, str | None]) -> dict:
    return {"type": "choice", "instructions": instructions, "criteria": dict(options)}


def score(instructions: str, levels: list[str]) -> dict:
    return {"type": "score", "instructions": instructions, "criteria": list(levels)}


# ----------------------------------------------------------------------------- answers
@dataclass
class Answer:
    type: str
    choice: str | None = None          # choice
    score: Any = None                  # score: giá trị trên thang
    label: str | None = None           # score: nhãn của mức
    p_yes: float | None = None         # noul
    confidence: float | None = None
    probabilities: dict = field(default_factory=dict)


def _parse_answer(raw: dict) -> Answer:
    t = raw.get("type")
    if t == "noul":
        if "noul" not in raw:
            raise JevError("noul answer without probability")
        p = float(raw["noul"])
        return Answer(type=t, p_yes=p, confidence=max(p, 1 - p))
    if t == "choice":
        if "choice" not in raw:
            raise JevError("choice answer without choice")
        return Answer(type=t, choice=raw["choice"], confidence=raw.get("confidence"),
                      probabilities=raw.get("probabilities") or {})
    if t == "score":
        if "score" not in raw:
            raise JevError("score answer without score")
        legend = raw.get("legend") or {}
        value = raw["score"]
        label = legend.get(str(value)) if isinstance(legend, dict) else None
        if label is None and isinstance(legend, dict):
            label = legend.get(value)
        return Answer(type=t, score=value, label=label, confidence=raw.get("confidence"),
                      probabilities=raw.get("probabilities") or {})
    raise JevError(f"unknown answer type {t!r}")


# ----------------------------------------------------------------------------- client
@dataclass
class JevConfig:
    enabled: bool = True
    base_url: str = "https://api.typesafe.ai"
    model: str = "jev-latest"
    api_key_env: str = "TYPESAFE_API_KEY"
    timeout_sec: float = 5
    retries: int = 1
    thresholds: dict = field(default_factory=lambda: {
        "choice": 0.7, "noul_yes": 0.8, "noul_no": 0.2, "injection": 0.5})

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "JevConfig":
        with open(path, "rb") as f:
            raw = tomllib.load(f)
        cfg = cls(**{k: v for k, v in raw.items() if k != "thresholds"})
        cfg.thresholds = {**cls().thresholds, **raw.get("thresholds", {})}
        return cfg


class JevClient:
    """`transport` cho phép thay HTTP bằng hàm giả (mock, test)."""

    def __init__(self, config: JevConfig, api_key: str | None,
                 transport: Callable[[dict], dict] | None = None):
        self.config = config
        self._api_key = api_key
        self._custom = transport is not None
        self._transport = transport or self._http

    @classmethod
    def from_config(cls, path: Path = CONFIG_PATH, transport=None) -> "JevClient":
        cfg = JevConfig.load(path)
        return cls(cfg, os.environ.get(cfg.api_key_env), transport)

    @property
    def available(self) -> bool:
        return self.config.enabled and (self._custom or bool(self._api_key))

    def ask(self, state: Any, questions: dict[str, dict]) -> dict[str, Answer]:
        if not self.available:
            raise JevError("Jev disabled or API key missing")
        body = {"model": self.config.model, "state": state, "questions": questions}
        raw = self._transport(body)
        answers = raw.get("answers")
        if not isinstance(answers, dict):
            raise JevError("response without answers")
        missing = set(questions) - set(answers)
        if missing:
            raise JevError(f"missing answers: {sorted(missing)}")
        return {k: _parse_answer(answers[k]) for k in questions}

    # -- HTTP -------------------------------------------------------------------
    def _http(self, body: dict) -> dict:
        url = self.config.base_url.rstrip("/") + "/v1/systemone"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last: Exception | None = None
        for attempt in range(self.config.retries + 1):
            req = urllib.request.Request(url, data=data, method="POST", headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            })
            try:
                with urllib.request.urlopen(req, timeout=self.config.timeout_sec) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (429, 500, 502, 503, 504) and attempt < self.config.retries:
                    time.sleep(min(float(e.headers.get("Retry-After") or 0.5), 2))
                    continue
                raise JevError(f"HTTP {e.code}") from None   # không đưa body/key vào lỗi
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = e
                if attempt < self.config.retries:
                    time.sleep(0.3)
                    continue
                raise JevError(f"network error: {type(e).__name__}") from None
            except json.JSONDecodeError:
                raise JevError("invalid JSON from Jev") from None
        raise JevError(f"request failed: {type(last).__name__}")
