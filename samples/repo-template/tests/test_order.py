import unittest

from shop.order import order_total

LINES = [{"price": 300_000, "qty": 2}, {"price": 400_000, "qty": 1}]


class OrderTotalTest(unittest.TestCase):
    def test_no_coupon(self):
        self.assertEqual(order_total(LINES), 1_000_000)

    def test_fixed_coupon(self):
        self.assertEqual(order_total(LINES, {"type": "fixed", "value": 50_000}), 950_000)
