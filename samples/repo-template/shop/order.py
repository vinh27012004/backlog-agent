"""Tính tiền đơn hàng."""


def line_total(price: int, qty: int, coupon: dict | None = None) -> float:
    total = price * qty
    if coupon and coupon.get("type") == "percent":
        total = total * (100 - coupon["value"]) / 100
    return total


def order_total(lines: list[dict], coupon: dict | None = None) -> int:
    """Tổng trước thuế. Mã "percent" giảm theo % trên tổng, mã "fixed" trừ thẳng số tiền."""
    subtotal = sum(line_total(line["price"], line["qty"], coupon) for line in lines)
    if coupon and coupon.get("type") == "percent":
        subtotal = subtotal * (100 - coupon["value"]) / 100
    elif coupon and coupon.get("type") == "fixed":
        subtotal = max(0, subtotal - coupon["value"])
    return round(subtotal)
