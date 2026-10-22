"""Báo cáo doanh thu."""


def daily_report(orders: list[dict], day: str) -> dict:
    """day dạng YYYY-MM-DD."""
    rows = [o for o in orders if o["date"][:10] == day]
    return {"day": day, "orders": len(rows), "revenue": sum(o["total"] for o in rows)}


def monthly_report(orders: list[dict], month: str) -> dict:
    """month dạng YYYY-MM."""
    rows = [o for o in orders if o["date"][:10] == month]
    return {"month": month, "orders": len(rows), "revenue": sum(o["total"] for o in rows)}
