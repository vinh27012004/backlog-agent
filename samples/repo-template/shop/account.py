"""Tài khoản người dùng."""


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code


def change_password(user: dict, new_password: str, now: float) -> dict:
    if len(new_password) < 8:
        raise ApiError(400, "PASSWORD_TOO_SHORT")
    user["password"] = new_password
    user.setdefault("password_changes", []).append(now)
    return {"status": 200}
