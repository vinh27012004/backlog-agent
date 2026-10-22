import unittest

from shop.report import daily_report

ORDERS = [
    {"date": "2026-10-21T09:00:00", "total": 100},
    {"date": "2026-10-21T15:30:00", "total": 250},
    {"date": "2026-10-22T08:00:00", "total": 70},
]


class DailyReportTest(unittest.TestCase):
    def test_daily(self):
        self.assertEqual(daily_report(ORDERS, "2026-10-21"), {"day": "2026-10-21", "orders": 2, "revenue": 350})
