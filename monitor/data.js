// DỮ LIỆU MẪU cho monitor, sinh bằng: python -m orchestrator.cli monitor --db <state.db> --export monitor/data.js
// Mở qua `cli monitor` thì monitor đọc /api/state thay cho file này.
window.MONITOR_DATA = {
 "meta": {
  "match_id": "t",
  "status": "RUNNING",
  "minutes_left": 32.0,
  "match_updated_at": 1792651464.4272566,
  "generated_at": 1792651466.2145815,
  "db": "samples (mock match)",
  "sample": true,
  "max_attempts": 4
 },
 "items": [
  {
   "id": "BUG-07",
   "type": "BUG",
   "title": "Tổng tiền đơn hàng sai khi có mã giảm giá phần trăm",
   "state": "submitted",
   "phase": null,
   "attempts": 2,
   "tier": "small",
   "note": null,
   "updated_at": 1792651460.9544146,
   "severity": "high",
   "difficulty": "medium",
   "injection": false,
   "deadline_min": 40.0,
   "minutes_left": 32.0,
   "gm_status": "CLOSED",
   "gate": {
    "attempt": 2,
    "passed": true,
    "fail_kind": null,
    "signature": null,
    "log": "",
    "checks": [
     {
      "name": "diff",
      "status": "pass",
      "seconds": 0.0,
      "note": "2 file, 18 dòng (giới hạn 15/600)"
     },
     {
      "name": "forbidden",
      "status": "pass",
      "seconds": 0.0,
      "note": ""
     },
     {
      "name": "build",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "target_tests",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "regression",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "mvs",
      "status": "skipped",
      "seconds": 0.0,
      "note": "chưa có MVS runner"
     }
    ]
   },
   "review": {
    "verdict": "approve",
    "summary": "Sửa đúng nguyên nhân, test bao phủ trường hợp mã %.",
    "issues": []
   },
   "fix": {
    "status": "fixed",
    "summary": "Mã giảm % bị áp hai lần: một lần trong line_total cho từng dòng, một lần trên tổng. Bỏ phần giảm giá trong line_total để mã % chỉ áp một lần trên tổng trước thuế. Thêm test tái hiện đơn 1.000.000đ với mã 10%.",
    "root_cause": "line_total áp mã % cho từng dòng, order_total áp lại lần nữa trên tổng.",
    "confidence": 0.9,
    "changed_files": [
     "shop/order.py",
     "tests/test_coupon.py"
    ],
    "tests_added": [
     "tests.test_coupon"
    ],
    "risks": []
   },
   "submission": {
    "status": "accepted",
    "reason": null,
    "score": 100,
    "warnings": []
   },
   "trace": [
    {
     "ts": 1792651459.3683503,
     "step": "quyết định severity",
     "msg": "high (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.3715582,
     "step": "quyết định difficulty",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.374559,
     "step": "quyết định injection",
     "msg": "False (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.3811364,
     "step": "quyết định model",
     "msg": "small (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.3843682,
     "step": "quyết định reviewer",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.5094733,
     "step": "fixer lần 1",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651459.514766,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_coupon",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651459.5196104,
     "step": "fixer · file_change",
     "msg": "shop/order.py, tests/test_coupon.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651459.5242944,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_coupon",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651459.5282154,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Mã giảm % bị áp hai lần: một lần trong line_total cho từng dòng, một lần trên tổng. Bỏ phần giảm giá trong line_total để mã % c…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651459.5758643,
     "step": "fixer lần 1",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651460.1551418,
     "step": "gate lần 1",
     "msg": "fail (original_still_failing) · AssertionError@tests/test_coupon.py:test_percent_coupon_applied_once · 0.6s",
     "s": "fail",
     "tool": "Gate"
    },
    {
     "ts": 1792651460.159856,
     "step": "quyết định next_action",
     "msg": "retry (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651460.244003,
     "step": "fixer lần 2",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651460.2479193,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_coupon",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651460.2510948,
     "step": "fixer · file_change",
     "msg": "shop/order.py, tests/test_coupon.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651460.2552288,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_coupon",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651460.2586987,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Mã giảm % bị áp hai lần: một lần trong line_total cho từng dòng, một lần trên tổng. Bỏ phần giảm giá trong line_total để mã % c…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651460.2910798,
     "step": "fixer lần 2",
     "msg": "xong sau 0.0s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651460.7585201,
     "step": "gate lần 2",
     "msg": "pass · 0.5s",
     "s": "ok",
     "tool": "Gate"
    },
    {
     "ts": 1792651460.7626548,
     "step": "quyết định claims_supported",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651460.8187208,
     "step": "reviewer lần 2",
     "msg": "bắt đầu (mock)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651460.8226187,
     "step": "reviewer · message",
     "msg": "{\"verdict\": \"approve\", \"root_cause_addressed\": true, \"issues\": [{\"severity\": \"low\", \"file\": \"src/main/java/com/shop/order/OrderService.java\", \"line\": 97, \"prob…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651460.8262374,
     "step": "reviewer lần 2",
     "msg": "xong sau 0.0s · approve",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651460.829514,
     "step": "quyết định next_action",
     "msg": "submit (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651460.9508648,
     "step": "nộp bài",
     "msg": "accepted · điểm tạm 100",
     "s": "ok",
     "tool": "Game Master"
    }
   ]
  },
  {
   "id": "TASK-01",
   "type": "TASK",
   "title": "API xuất danh sách khách hàng ra CSV",
   "state": "dropped",
   "phase": null,
   "attempts": 3,
   "tier": "small",
   "note": "chữ ký lỗi lặp lại: ImportError@tests/test_export.py:<module>",
   "updated_at": 1792651462.865187,
   "severity": "medium",
   "difficulty": "medium",
   "injection": false,
   "deadline_min": 40.0,
   "minutes_left": 32.0,
   "gm_status": "OPEN",
   "gate": {
    "attempt": 3,
    "passed": false,
    "fail_kind": "original_still_failing",
    "signature": "ImportError@tests/test_export.py:<module>",
    "log": "ERROR: test_export (unittest.loader._FailedTest)\nImportError: Failed to import test module: test_export\nTraceback (most recent call last):\n  File \"tests\\test_export.py\", line 3, in <module>\nImportError: cannot import name 'export_csv' from 'shop.customers' (shop\\customers.py)\nFAILED (errors=1)",
    "checks": [
     {
      "name": "diff",
      "status": "pass",
      "seconds": 0.0,
      "note": "1 file, 8 dòng (giới hạn 15/600)"
     },
     {
      "name": "forbidden",
      "status": "pass",
      "seconds": 0.0,
      "note": ""
     },
     {
      "name": "build",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "target_tests",
      "status": "fail",
      "seconds": 0.1,
      "note": ""
     }
    ]
   },
   "review": null,
   "fix": {
    "status": "fixed",
    "summary": "Thêm export_csv trả CSV gồm id, họ tên, email, ngày tạo, lọc theo khoảng ngày tạo (gồm cả hai đầu). Test kiểm header, số dòng và bộ lọc.",
    "root_cause": null,
    "confidence": 0.85,
    "changed_files": [
     "shop/customers.py",
     "tests/test_export.py"
    ],
    "tests_added": [
     "tests.test_export"
    ],
    "risks": []
   },
   "submission": null,
   "trace": [
    {
     "ts": 1792651459.351224,
     "step": "quyết định severity",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.3584268,
     "step": "quyết định difficulty",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651459.3616233,
     "step": "quyết định injection",
     "msg": "False (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651460.9577234,
     "step": "quyết định model",
     "msg": "small (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651460.960646,
     "step": "quyết định reviewer",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651461.0820794,
     "step": "fixer lần 1",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651461.086358,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651461.0897846,
     "step": "fixer · file_change",
     "msg": "shop/customers.py, tests/test_export.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.0932848,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.096727,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Thêm export_csv trả CSV gồm id, họ tên, email, ngày tạo, lọc theo khoảng ngày tạo (gồm cả hai đầu). Test kiểm header, số dòng v…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.1309144,
     "step": "fixer lần 1",
     "msg": "xong sau 0.0s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651461.6445594,
     "step": "gate lần 1",
     "msg": "fail (original_still_failing) · ImportError@tests/test_export.py:<module> · 0.5s",
     "s": "fail",
     "tool": "Gate"
    },
    {
     "ts": 1792651461.6489673,
     "step": "quyết định next_action",
     "msg": "retry (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651461.7302113,
     "step": "fixer lần 2",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651461.7348187,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651461.7382529,
     "step": "fixer · file_change",
     "msg": "shop/customers.py, tests/test_export.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.74162,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.7449496,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Thêm export_csv trả CSV gồm id, họ tên, email, ngày tạo, lọc theo khoảng ngày tạo (gồm cả hai đầu). Test kiểm header, số dòng v…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651461.792372,
     "step": "fixer lần 2",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651462.3007915,
     "step": "gate lần 2",
     "msg": "fail (original_still_failing) · ImportError@tests/test_export.py:<module> · 0.5s",
     "s": "fail",
     "tool": "Gate"
    },
    {
     "ts": 1792651462.307018,
     "step": "quyết định next_action",
     "msg": "retry (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651462.403091,
     "step": "fixer lần 3",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651462.4080038,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651462.4116116,
     "step": "fixer · file_change",
     "msg": "shop/customers.py, tests/test_export.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651462.4152863,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_export",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651462.4188442,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Thêm export_csv trả CSV gồm id, họ tên, email, ngày tạo, lọc theo khoảng ngày tạo (gồm cả hai đầu). Test kiểm header, số dòng v…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651462.4561572,
     "step": "fixer lần 3",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651462.8613307,
     "step": "gate lần 3",
     "msg": "fail (original_still_failing) · ImportError@tests/test_export.py:<module> · 0.4s",
     "s": "fail",
     "tool": "Gate"
    }
   ]
  },
  {
   "id": "CR-02",
   "type": "CR",
   "title": "Thêm giới hạn 5 lần đổi mật khẩu mỗi ngày",
   "state": "submitted",
   "phase": null,
   "attempts": 2,
   "tier": "strong",
   "note": null,
   "updated_at": 1792651464.3977616,
   "severity": "medium",
   "difficulty": "medium",
   "injection": false,
   "deadline_min": 30.0,
   "minutes_left": 26.0,
   "gm_status": "CLOSED",
   "gate": {
    "attempt": 2,
    "passed": true,
    "fail_kind": null,
    "signature": null,
    "log": "",
    "checks": [
     {
      "name": "diff",
      "status": "pass",
      "seconds": 0.0,
      "note": "2 file, 27 dòng (giới hạn 15/600)"
     },
     {
      "name": "forbidden",
      "status": "pass",
      "seconds": 0.0,
      "note": ""
     },
     {
      "name": "build",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "target_tests",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "regression",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "mvs",
      "status": "skipped",
      "seconds": 0.0,
      "note": "chưa có MVS runner"
     }
    ]
   },
   "review": {
    "verdict": "approve",
    "summary": "Sửa đúng nguyên nhân, test bao phủ trường hợp mã %.",
    "issues": []
   },
   "fix": {
    "status": "fixed",
    "summary": "Giới hạn 5 lần đổi mật khẩu trong 24 giờ trượt; lần thứ 6 trả HTTP 429 với mã PASSWORD_CHANGE_LIMIT. Chỉ giữ các mốc đổi trong 24 giờ gần nhất.",
    "root_cause": null,
    "confidence": 0.85,
    "changed_files": [
     "shop/account.py",
     "tests/test_password_limit.py"
    ],
    "tests_added": [
     "tests.test_password_limit"
    ],
    "risks": []
   },
   "submission": {
    "status": "accepted",
    "reason": null,
    "score": 100,
    "warnings": []
   },
   "trace": [
    {
     "ts": 1792651462.8943667,
     "step": "quyết định severity",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651462.897777,
     "step": "quyết định difficulty",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651462.9014432,
     "step": "quyết định injection",
     "msg": "False (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651462.9078827,
     "step": "quyết định model",
     "msg": "strong (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651462.9107995,
     "step": "quyết định reviewer",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651463.028933,
     "step": "fixer lần 1",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651463.0332956,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_password_limit",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651463.0370708,
     "step": "fixer · file_change",
     "msg": "shop/account.py, tests/test_password_limit.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.0404036,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_password_limit",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.0442066,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Giới hạn 5 lần đổi mật khẩu trong 24 giờ trượt; lần thứ 6 trả HTTP 429 với mã PASSWORD_CHANGE_LIMIT. Chỉ giữ các mốc đổi trong …",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.0816734,
     "step": "fixer lần 1",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651463.514982,
     "step": "gate lần 1",
     "msg": "pass · 0.4s",
     "s": "ok",
     "tool": "Gate"
    },
    {
     "ts": 1792651463.5195115,
     "step": "quyết định claims_supported",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651463.6018877,
     "step": "reviewer lần 1",
     "msg": "bắt đầu (mock)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651463.6069384,
     "step": "reviewer · message",
     "msg": "{\"verdict\": \"request_changes\", \"root_cause_addressed\": true, \"summary\": \"Thiếu kiểm mốc đúng 24 giờ.\", \"issues\": [{\"severity\": \"high\", \"file\": \"shop/account.py…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.6136563,
     "step": "reviewer lần 1",
     "msg": "xong sau 0.0s · request_changes",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651463.6176996,
     "step": "quyết định next_action",
     "msg": "retry (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651463.7178068,
     "step": "fixer lần 2",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651463.7217262,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_password_limit",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651463.7250826,
     "step": "fixer · file_change",
     "msg": "shop/account.py, tests/test_password_limit.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.728513,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_password_limit",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.7330124,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Giới hạn 5 lần đổi mật khẩu trong 24 giờ trượt; lần thứ 6 trả HTTP 429 với mã PASSWORD_CHANGE_LIMIT. Chỉ giữ các mốc đổi trong …",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651463.7762322,
     "step": "fixer lần 2",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651464.1970422,
     "step": "gate lần 2",
     "msg": "pass · 0.4s",
     "s": "ok",
     "tool": "Gate"
    },
    {
     "ts": 1792651464.201076,
     "step": "quyết định claims_supported",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.261562,
     "step": "reviewer lần 2",
     "msg": "bắt đầu (mock)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651464.264911,
     "step": "reviewer · message",
     "msg": "{\"verdict\": \"approve\", \"root_cause_addressed\": true, \"issues\": [{\"severity\": \"low\", \"file\": \"src/main/java/com/shop/order/OrderService.java\", \"line\": 97, \"prob…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651464.2696576,
     "step": "reviewer lần 2",
     "msg": "xong sau 0.0s · approve",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651464.273196,
     "step": "quyết định next_action",
     "msg": "submit (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.3940055,
     "step": "nộp bài",
     "msg": "accepted · điểm tạm 100",
     "s": "ok",
     "tool": "Game Master"
    }
   ]
  },
  {
   "id": "PI-03",
   "type": "PI",
   "title": "Báo cáo doanh thu tháng hiển thị trang trắng",
   "state": "submitted",
   "phase": null,
   "attempts": 2,
   "tier": "strong",
   "note": null,
   "updated_at": 1792651465.9305537,
   "severity": "critical",
   "difficulty": "medium",
   "injection": false,
   "deadline_min": 18.0,
   "minutes_left": 18.0,
   "gm_status": "VISIBLE",
   "gate": {
    "attempt": 2,
    "passed": true,
    "fail_kind": null,
    "signature": null,
    "log": "",
    "checks": [
     {
      "name": "diff",
      "status": "pass",
      "seconds": 0.0,
      "note": "2 file, 12 dòng (giới hạn 15/600)"
     },
     {
      "name": "forbidden",
      "status": "pass",
      "seconds": 0.0,
      "note": ""
     },
     {
      "name": "build",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "target_tests",
      "status": "pass",
      "seconds": 0.1,
      "note": ""
     },
     {
      "name": "regression",
      "status": "pass",
      "seconds": 0.2,
      "note": ""
     }
    ]
   },
   "review": null,
   "fix": {
    "status": "fixed",
    "summary": "Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng (YYYY-MM) nên không đơn nào khớp; báo cáo ngày dùng đúng 10 ký tự nên vẫn chạy. Sửa so 7 ký tự đầu, thêm test tái hiện.",
    "root_cause": "shop/report.py monthly_report so o['date'][:10] (ngày) với chuỗi tháng YYYY-MM.",
    "confidence": 0.9,
    "changed_files": [
     "shop/report.py",
     "tests/test_monthly_report.py"
    ],
    "tests_added": [
     "tests.test_monthly_report"
    ],
    "risks": []
   },
   "submission": {
    "status": "accepted",
    "reason": null,
    "score": 100,
    "warnings": []
   },
   "trace": [
    {
     "ts": 1792651464.4309082,
     "step": "quyết định severity",
     "msg": "critical (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.4343107,
     "step": "quyết định difficulty",
     "msg": "medium (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.4371977,
     "step": "quyết định injection",
     "msg": "False (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.4440925,
     "step": "quyết định model",
     "msg": "strong (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.4475772,
     "step": "quyết định reviewer",
     "msg": "False (fallback) · PI skips review",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651464.5968883,
     "step": "fixer lần 1",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651464.600957,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_monthly_report",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651464.6039076,
     "step": "fixer · file_change",
     "msg": "shop/report.py, tests/test_monthly_report.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651464.6071987,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_monthly_report",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651464.6105924,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng (YYYY-MM) nên không đơn nào khớp; báo cáo…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651464.644386,
     "step": "fixer lần 1",
     "msg": "xong sau 0.0s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.1023557,
     "step": "gate lần 1",
     "msg": "fail (original_still_failing) · AssertionError@tests/test_monthly_report.py:test_month · 0.5s",
     "s": "fail",
     "tool": "Gate"
    },
    {
     "ts": 1792651465.1066444,
     "step": "quyết định next_action",
     "msg": "retry (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651465.1875796,
     "step": "pi_hypothesis lần 1",
     "msg": "bắt đầu (mock)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.187667,
     "step": "pi_hypothesis lần 1",
     "msg": "bắt đầu (mock)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.1933618,
     "step": "pi_hypothesis · mcp",
     "msg": "runner.app_call",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.1976118,
     "step": "pi_hypothesis · mcp",
     "msg": "runner.app_call",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.2007883,
     "step": "pi_hypothesis · message",
     "msg": "{\"hypothesis\": \"Truy vấn báo cáo tháng lọc sai múi giờ\", \"verdict\": \"supported\", \"evidence\": [\"ReportRepository.java:41 dùng LocalDate.now() theo UTC\", \"Gọi GE…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.2046235,
     "step": "pi_hypothesis · message",
     "msg": "{\"hypothesis\": \"Truy vấn báo cáo tháng lọc sai múi giờ\", \"verdict\": \"supported\", \"evidence\": [\"ReportRepository.java:41 dùng LocalDate.now() theo UTC\", \"Gọi GE…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.2085028,
     "step": "pi_hypothesis lần 1",
     "msg": "xong sau 0.0s · supported",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.2121103,
     "step": "pi_hypothesis lần 1",
     "msg": "xong sau 0.0s · supported",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.2249053,
     "step": "fixer lần 2",
     "msg": "bắt đầu (mock, gpt-6-luna)",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.229545,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_monthly_report",
     "s": "fail",
     "tool": null
    },
    {
     "ts": 1792651465.2341378,
     "step": "fixer · file_change",
     "msg": "shop/report.py, tests/test_monthly_report.py",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.2377234,
     "step": "fixer · command",
     "msg": "python -m unittest tests.test_monthly_report",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.2411785,
     "step": "fixer · message",
     "msg": "{\"status\": \"fixed\", \"summary\": \"Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng (YYYY-MM) nên không đơn nào khớp; báo cáo…",
     "s": "ok",
     "tool": null
    },
    {
     "ts": 1792651465.277458,
     "step": "fixer lần 2",
     "msg": "xong sau 0.1s · fixed",
     "s": "ok",
     "tool": "Codex"
    },
    {
     "ts": 1792651465.7720716,
     "step": "gate lần 2",
     "msg": "pass · 0.5s",
     "s": "ok",
     "tool": "Gate"
    },
    {
     "ts": 1792651465.7760746,
     "step": "quyết định claims_supported",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651465.7794936,
     "step": "quyết định root_cause_confirmed",
     "msg": "True (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651465.7829318,
     "step": "quyết định next_action",
     "msg": "submit (fallback) · Jev disabled or API key missing",
     "s": "ok",
     "tool": "Luật"
    },
    {
     "ts": 1792651465.9273562,
     "step": "nộp bài",
     "msg": "accepted · điểm tạm 100",
     "s": "ok",
     "tool": "Game Master"
    }
   ]
  }
 ],
 "events": [
  {
   "item": "PI-03",
   "ts": 1792651465.9273562,
   "step": "nộp bài",
   "msg": "accepted · điểm tạm 100",
   "s": "ok",
   "tool": "Game Master"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.7829318,
   "step": "quyết định next_action",
   "msg": "submit (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.7794936,
   "step": "quyết định root_cause_confirmed",
   "msg": "True (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.7760746,
   "step": "quyết định claims_supported",
   "msg": "True (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.7720716,
   "step": "gate lần 2",
   "msg": "pass · 0.5s",
   "s": "ok",
   "tool": "Gate"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.277458,
   "step": "fixer lần 2",
   "msg": "xong sau 0.1s · fixed",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2411785,
   "step": "fixer · message",
   "msg": "{\"status\": \"fixed\", \"summary\": \"Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng (YYYY-MM) nên không đơn nào khớp; báo cáo…",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2377234,
   "step": "fixer · command",
   "msg": "python -m unittest tests.test_monthly_report",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2341378,
   "step": "fixer · file_change",
   "msg": "shop/report.py, tests/test_monthly_report.py",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.229545,
   "step": "fixer · command",
   "msg": "python -m unittest tests.test_monthly_report",
   "s": "fail",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2249053,
   "step": "fixer lần 2",
   "msg": "bắt đầu (mock, gpt-6-luna)",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2121103,
   "step": "pi_hypothesis lần 1",
   "msg": "xong sau 0.0s · supported",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2085028,
   "step": "pi_hypothesis lần 1",
   "msg": "xong sau 0.0s · supported",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2046235,
   "step": "pi_hypothesis · message",
   "msg": "{\"hypothesis\": \"Truy vấn báo cáo tháng lọc sai múi giờ\", \"verdict\": \"supported\", \"evidence\": [\"ReportRepository.java:41 dùng LocalDate.now() theo UTC\", \"Gọi GE…",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.2007883,
   "step": "pi_hypothesis · message",
   "msg": "{\"hypothesis\": \"Truy vấn báo cáo tháng lọc sai múi giờ\", \"verdict\": \"supported\", \"evidence\": [\"ReportRepository.java:41 dùng LocalDate.now() theo UTC\", \"Gọi GE…",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.1976118,
   "step": "pi_hypothesis · mcp",
   "msg": "runner.app_call",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.1933618,
   "step": "pi_hypothesis · mcp",
   "msg": "runner.app_call",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651465.187667,
   "step": "pi_hypothesis lần 1",
   "msg": "bắt đầu (mock)",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.1875796,
   "step": "pi_hypothesis lần 1",
   "msg": "bắt đầu (mock)",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.1066444,
   "step": "quyết định next_action",
   "msg": "retry (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651465.1023557,
   "step": "gate lần 1",
   "msg": "fail (original_still_failing) · AssertionError@tests/test_monthly_report.py:test_month · 0.5s",
   "s": "fail",
   "tool": "Gate"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.644386,
   "step": "fixer lần 1",
   "msg": "xong sau 0.0s · fixed",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.6105924,
   "step": "fixer · message",
   "msg": "{\"status\": \"fixed\", \"summary\": \"Báo cáo tháng trống vì monthly_report so 10 ký tự đầu của ngày (YYYY-MM-DD) với tháng (YYYY-MM) nên không đơn nào khớp; báo cáo…",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651464.6071987,
   "step": "fixer · command",
   "msg": "python -m unittest tests.test_monthly_report",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651464.6039076,
   "step": "fixer · file_change",
   "msg": "shop/report.py, tests/test_monthly_report.py",
   "s": "ok",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651464.600957,
   "step": "fixer · command",
   "msg": "python -m unittest tests.test_monthly_report",
   "s": "fail",
   "tool": null
  },
  {
   "item": "PI-03",
   "ts": 1792651464.5968883,
   "step": "fixer lần 1",
   "msg": "bắt đầu (mock, gpt-6-luna)",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.4475772,
   "step": "quyết định reviewer",
   "msg": "False (fallback) · PI skips review",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.4440925,
   "step": "quyết định model",
   "msg": "strong (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.4371977,
   "step": "quyết định injection",
   "msg": "False (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.4343107,
   "step": "quyết định difficulty",
   "msg": "medium (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "PI-03",
   "ts": 1792651464.4309082,
   "step": "quyết định severity",
   "msg": "critical (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.3940055,
   "step": "nộp bài",
   "msg": "accepted · điểm tạm 100",
   "s": "ok",
   "tool": "Game Master"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.273196,
   "step": "quyết định next_action",
   "msg": "submit (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.2696576,
   "step": "reviewer lần 2",
   "msg": "xong sau 0.0s · approve",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.264911,
   "step": "reviewer · message",
   "msg": "{\"verdict\": \"approve\", \"root_cause_addressed\": true, \"issues\": [{\"severity\": \"low\", \"file\": \"src/main/java/com/shop/order/OrderService.java\", \"line\": 97, \"prob…",
   "s": "ok",
   "tool": null
  },
  {
   "item": "CR-02",
   "ts": 1792651464.261562,
   "step": "reviewer lần 2",
   "msg": "bắt đầu (mock)",
   "s": "ok",
   "tool": "Codex"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.201076,
   "step": "quyết định claims_supported",
   "msg": "True (fallback) · Jev disabled or API key missing",
   "s": "ok",
   "tool": "Luật"
  },
  {
   "item": "CR-02",
   "ts": 1792651464.1970422,
   "step": "gate lần 2",
   "msg": "pass · 0.4s",
   "s": "ok",
   "tool": "Gate"
  },
  {
   "item": "CR-02",
   "ts": 1792651463.7762322,
   "step": "fixer lần 2",
   "msg": "xong sau 0.1s · fixed",
   "s": "ok",
   "tool": "Codex"
  }
 ],
 "jev": [
  {
   "name": "claims_supported",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "difficulty",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "injection",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "model",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "next_action",
   "n": 8,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "reviewer",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "root_cause_confirmed",
   "n": 1,
   "by_jev": 0,
   "avg_ms": 0.0
  },
  {
   "name": "severity",
   "n": 4,
   "by_jev": 0,
   "avg_ms": 0.0
  }
 ],
 "agents": [
  {
   "role": "fixer",
   "mode": "mock",
   "runs": 9,
   "ok": 9,
   "avg_sec": 0.1
  },
  {
   "role": "pi_hypothesis",
   "mode": "mock",
   "runs": 2,
   "ok": 2,
   "avg_sec": 0.0
  },
  {
   "role": "reviewer",
   "mode": "mock",
   "runs": 3,
   "ok": 3,
   "avg_sec": 0.0
  }
 ]
};
