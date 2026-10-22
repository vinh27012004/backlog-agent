"""Khách hàng."""
from datetime import date

CUSTOMERS = [
    {"id": 1, "name": "Nguyễn An", "email": "an@example.com", "created": date(2026, 9, 1)},
    {"id": 2, "name": "Trần Bình", "email": "binh@example.com", "created": date(2026, 10, 5)},
    {"id": 3, "name": "Lê Chi", "email": "chi@example.com", "created": date(2026, 10, 20)},
]


def list_customers() -> list[dict]:
    return list(CUSTOMERS)
