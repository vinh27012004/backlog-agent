"""Sinh dữ liệu mock cho fixer từ repo mẫu: samples/mock/fixer/<ITEM>.patch + <ITEM>.jsonl.

Mỗi item: ghi nội dung file đã sửa vào bản sao của samples/repo-template, lấy `git diff` làm patch,
và ghi luồng sự kiện codex giả có câu trả lời cuối theo schema fix-result. Chạy lại khi sửa repo mẫu:

    py -3.13 samples/build_mocks.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orchestrator.workspace import init_sample_repo  # noqa: E402

TEMPLATE = ROOT / "samples" / "repo-template"
OUT = ROOT / "samples" / "mock" / "fixer"

FIXES: dict[str, dict] = {
    "BUG-07": {
        "files": {
            "shop/order.py": '''"""Tính tiền đơn hàng."""


def line_total(price: int, qty: int) -> int:
    return price * qty


def order_total(lines: list[dict], coupon: dict | None = None) -> int:
    """Tổng trước thuế. Mã "percent" giảm theo % trên tổng, mã "fixed" trừ thẳng số tiền."""
    subtotal = sum(line_total(line["price"], line["qty"]) for line in lines)
    if coupon and coupon.get("type") == "percent":
        subtotal = subtotal * (100 - coupon["value"]) / 100
    elif coupon and coupon.get("type") == "fixed":
        subtotal = max(0, subtotal - coupon["value"])
    return round(subtotal)
''',
            "tests/test_coupon.py": '''import unittest

from shop.order import order_total


class PercentCouponTest(unittest.TestCase):
    def test_percent_coupon_applied_once(self):
        lines = [{"price": 300_000, "qty": 2}, {"price": 400_000, "qty": 1}]
        self.assertEqual(order_total(lines, {"type": "percent", "value": 10}), 900_000)
''',
        },
        "result": {
            "status": "fixed",
            "summary": "Mã giảm % bị áp hai lần: một lần trong line_total cho từng dòng, một lần trên tổng. "
                       "Bỏ phần giảm giá trong line_total để mã % chỉ áp một lần trên tổng trước thuế. "
                       "Thêm test tái hiện đơn 1.000.000đ với mã 10%.",
            "criteria": ["Đơn 1.000.000đ với mã 10% có tổng trước thuế 900.000đ", "Mã giảm cố định không đổi"],
            "suspects": [{"symbol": "line_total", "file": "shop/order.py", "reason": "áp mã % trên từng dòng"}],
            "root_cause": "line_total áp mã % cho từng dòng, order_total áp lại lần nữa trên tổng.",
            "changed_files": ["shop/order.py", "tests/test_coupon.py"],
            "tests_added": ["tests.test_coupon"],
            "verification": [{"check": "test tái hiện", "command": "python -m unittest tests.test_coupon",
                              "result": "pass", "note": None}],
            "needs_dependency": [], "risks": [], "confidence": 0.9,
        },
    },
    "TASK-01": {
        "files": {
            "shop/customers.py": '''"""Khách hàng."""
import csv
import io
from datetime import date

CUSTOMERS = [
    {"id": 1, "name": "Nguyễn An", "email": "an@example.com", "created": date(2026, 9, 1)},
    {"id": 2, "name": "Trần Bình", "email": "binh@example.com", "created": date(2026, 10, 5)},
    {"id": 3, "name": "Lê Chi", "email": "chi@example.com", "created": date(2026, 10, 20)},
]


def list_customers() -> list[dict]:
    return list(CUSTOMERS)


def export_csv(start: date | None = None, end: date | None = None) -> str:
    """GET /api/customers/export: CSV gồm id, họ tên, email, ngày tạo; lọc theo khoảng ngày tạo (gồm 2 đầu)."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\\n")
    writer.writerow(["id", "name", "email", "created"])
    for c in CUSTOMERS:
        if (start and c["created"] < start) or (end and c["created"] > end):
            continue
        writer.writerow([c["id"], c["name"], c["email"], c["created"].isoformat()])
    return out.getvalue()
''',
            "tests/test_export.py": '''import unittest
from datetime import date

from shop.customers import export_csv


class ExportCsvTest(unittest.TestCase):
    def test_header_and_all_rows(self):
        lines = export_csv().splitlines()
        self.assertEqual(lines[0], "id,name,email,created")
        self.assertEqual(len(lines), 4)

    def test_filter_by_created_range(self):
        lines = export_csv(date(2026, 10, 1), date(2026, 10, 10)).splitlines()
        self.assertEqual(lines[1:], ["2,Trần Bình,binh@example.com,2026-10-05"])
''',
        },
        "result": {
            "status": "fixed",
            "summary": "Thêm export_csv trả CSV gồm id, họ tên, email, ngày tạo, lọc theo khoảng ngày tạo "
                       "(gồm cả hai đầu). Test kiểm header, số dòng và bộ lọc.",
            "criteria": ["CSV có cột id, name, email, created", "Lọc theo khoảng ngày tạo"],
            "suspects": [{"symbol": "shop.customers", "file": "shop/customers.py", "reason": "nơi đặt hàm export"}],
            "root_cause": None,
            "changed_files": ["shop/customers.py", "tests/test_export.py"],
            "tests_added": ["tests.test_export"],
            "verification": [{"check": "test tiêu chí", "command": "python -m unittest tests.test_export",
                              "result": "pass", "note": None}],
            "needs_dependency": [], "risks": [], "confidence": 0.85,
        },
    },
    "CR-02": {
        "files": {
            "shop/account.py": '''"""Tài khoản người dùng."""

MAX_CHANGES_PER_DAY = 5
DAY_SECONDS = 24 * 3600


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code


def change_password(user: dict, new_password: str, now: float) -> dict:
    if len(new_password) < 8:
        raise ApiError(400, "PASSWORD_TOO_SHORT")
    recent = [t for t in user.get("password_changes", []) if now - t < DAY_SECONDS]
    if len(recent) >= MAX_CHANGES_PER_DAY:
        raise ApiError(429, "PASSWORD_CHANGE_LIMIT")
    user["password"] = new_password
    user["password_changes"] = recent + [now]
    return {"status": 200}
''',
            "tests/test_password_limit.py": '''import unittest

from shop.account import ApiError, change_password


class PasswordLimitTest(unittest.TestCase):
    def test_sixth_change_in_24h_is_rejected(self):
        user = {}
        for i in range(5):
            change_password(user, f"password{i}", now=1000 + i)
        with self.assertRaises(ApiError) as e:
            change_password(user, "password6", now=2000)
        self.assertEqual((e.exception.status, e.exception.code), (429, "PASSWORD_CHANGE_LIMIT"))

    def test_window_slides_after_24h(self):
        user = {}
        for i in range(5):
            change_password(user, f"password{i}", now=1000 + i)
        self.assertEqual(change_password(user, "password6", now=1000 + 24 * 3600)["status"], 200)
''',
        },
        "result": {
            "status": "fixed",
            "summary": "Giới hạn 5 lần đổi mật khẩu trong 24 giờ trượt; lần thứ 6 trả HTTP 429 với mã "
                       "PASSWORD_CHANGE_LIMIT. Chỉ giữ các mốc đổi trong 24 giờ gần nhất.",
            "criteria": ["Lần thứ 6 trong 24 giờ trả 429 PASSWORD_CHANGE_LIMIT", "Sau 24 giờ đổi lại được"],
            "suspects": [{"symbol": "change_password", "file": "shop/account.py", "reason": "chưa có giới hạn"}],
            "root_cause": None,
            "changed_files": ["shop/account.py", "tests/test_password_limit.py"],
            "tests_added": ["tests.test_password_limit"],
            "verification": [{"check": "test theo spec", "command": "python -m unittest tests.test_password_limit",
                              "result": "pass", "note": None}],
            "needs_dependency": [], "risks": [], "confidence": 0.85,
        },
    },
    "PI-03": {
        "files": {
            "shop/report.py": '''"""Báo cáo doanh thu."""


def daily_report(orders: list[dict], day: str) -> dict:
    """day dạng YYYY-MM-DD."""
    rows = [o for o in orders if o["date"][:10] == day]
    return {"day": day, "orders": len(rows), "revenue": sum(o["total"] for o in rows)}


def monthly_report(orders: list[dict], month: str) -> dict:
    """month dạng YYYY-MM."""
    rows = [o for o in orders if o["date"][:7] == month]
    return {"month": month, "orders": len(rows), "revenue": sum(o["total"] for o in rows)}
''',
            "tests/test_monthly_report.py": '''import unittest

from shop.report import monthly_report


class MonthlyReportTest(unittest.TestCase):
    def test_month_includes_all_days(self):
        orders = [{"date": "2026-10-01T09:00:00", "total": 100}, {"date": "2026-10-21T15:30:00", "total": 250},
                  {"date": "2026-09-30T23:00:00", "total": 70}]
        self.assertEqual(monthly_report(orders, "2026-10"), {"month": "2026-10", "orders": 2, "revenue": 350})
''',
        },
        "result": {
            "status": "fixed",
            "summary": "Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng "
                       "(YYYY-MM) nên không đơn nào khớp; báo cáo ngày dùng đúng 10 ký tự nên vẫn chạy. "
                       "Sửa so 7 ký tự đầu, thêm test tái hiện.",
            "criteria": ["Trang báo cáo tháng trống", "Báo cáo ngày vẫn đúng"],
            "suspects": [{"symbol": "monthly_report", "file": "shop/report.py",
                          "reason": "lọc theo ngày thay vì tháng"}],
            "root_cause": "shop/report.py monthly_report so o['date'][:10] (ngày) với chuỗi tháng YYYY-MM.",
            "changed_files": ["shop/report.py", "tests/test_monthly_report.py"],
            "tests_added": ["tests.test_monthly_report"],
            "verification": [{"check": "test tái hiện", "command": "python -m unittest tests.test_monthly_report",
                              "result": "pass", "note": None}],
            "needs_dependency": [], "risks": [], "confidence": 0.9,
        },
    },
}


def events(item_id: str, result: dict) -> list[dict]:
    """Giống một lần chạy thật: chạy test (fail) → sửa file → chạy lại test (pass) → trả lời JSON."""
    test_cmd = f"python -m unittest {' '.join(result['tests_added'])}"
    return [
        {"type": "thread.started", "thread_id": f"mock-fix-{item_id}"},
        {"type": "turn.started"},
        {"type": "item.completed", "item": {"id": "item_0", "type": "command_execution", "command": test_cmd,
                                            "exit_code": 1, "status": "completed"}},
        {"type": "item.completed", "item": {"id": "item_1", "type": "file_change", "status": "completed",
                                            "changes": [{"path": p, "kind": "update"} for p in result["changed_files"]]}},
        {"type": "item.completed", "item": {"id": "item_2", "type": "command_execution", "command": test_cmd,
                                            "exit_code": 0, "status": "completed"}},
        {"type": "item.completed", "item": {"id": "item_final", "type": "agent_message",
                                            "text": json.dumps(result, ensure_ascii=False)}},
        {"type": "turn.completed", "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}},
    ]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        repo = init_sample_repo(TEMPLATE, Path(tmp) / "repo")
        for item_id, spec in FIXES.items():
            for rel, body in spec["files"].items():
                (repo / rel).write_bytes(body.encode("utf-8"))
            subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
            patch = subprocess.run(["git", "-C", str(repo), "diff", "--cached", "--no-color"],
                                   check=True, capture_output=True).stdout
            (OUT / f"{item_id}.patch").write_bytes(patch)
            subprocess.run(["git", "-C", str(repo), "reset", "-q", "--hard"], check=True)
            with open(OUT / f"{item_id}.jsonl", "w", encoding="utf-8", newline="\n") as f:
                for ev in events(item_id, spec["result"]):
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
            print(f"{item_id}: {len(patch)} byte patch")


if __name__ == "__main__":
    main()
