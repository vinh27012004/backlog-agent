"""Test Log Condenser và gate (không tốn $): chữ ký lỗi, đọc diff, luật cấm, gate chạy thật trên repo git tạm.

    py -3.13 -m unittest discover -s tests -k GateRunTest
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orchestrator.gate import (  # noqa: E402
    FileChange, Gate, GateConfig, _clean_env, diff_text, forbidden_changes, parse_diff,
)
from orchestrator.logs import compile_errors, condense, failing_tests, signature  # noqa: E402
from orchestrator.store import Store  # noqa: E402

PY = sys.executable if " " not in sys.executable else f'"{sys.executable}"'

MAVEN_FAIL = """[INFO] Scanning for projects...
[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.2 s <<< FAILURE! - in com.shop.order.OrderServiceTest
java.lang.AssertionError: expected:<900000> but was:<810000>
\tat org.junit.Assert.fail(Assert.java:89)
\tat com.shop.order.OrderServiceTest.applyPercentCoupon(OrderServiceTest.java:88)
\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
[ERROR] Failures:
[ERROR]   OrderServiceTest.applyPercentCoupon:88 expected:<900000> but was:<810000>
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.0:test
"""


class LogsTest(unittest.TestCase):
    def test_java_signature_skips_library_frames(self):
        self.assertEqual(signature(MAVEN_FAIL), "AssertionError@com.shop.order.OrderServiceTest.applyPercentCoupon")
        self.assertIn("OrderServiceTest.applyPercentCoupon", failing_tests(MAVEN_FAIL))

    def test_signature_ignores_line_numbers(self):
        moved = MAVEN_FAIL.replace("OrderServiceTest.java:88", "OrderServiceTest.java:95")
        self.assertEqual(signature(MAVEN_FAIL), signature(moved))

    def test_compile_errors_per_stack(self):
        cases = {
            "[ERROR] /w/src/main/java/OrderService.java:[42,17] cannot find symbol": "OrderService.java",
            "src/order.ts(12,5): error TS2339: Property 'rate' does not exist": "order.ts",
            "src/order.ts:12:5 - error TS2339: Property 'rate' does not exist": "order.ts",
            "/w/Order.cs(10,5): error CS0103: The name 'rate' does not exist [/w/Shop.csproj]": "Order.cs",
            "order/order.go:12:3: undefined: rate": "order.go",
            "PHP Parse error:  syntax error, unexpected '}' in /w/app/Order.php on line 12": "Order.php",
            '  File "app/x.py", line 3\n    def f(:\nSyntaxError: invalid syntax': "x.py",
        }
        for log, file in cases.items():
            with self.subTest(file=file):
                errs = compile_errors(log)
                self.assertEqual(errs[0][0], file)
                self.assertTrue(signature(log).startswith(f"compile:{file}:"))

    def test_root_is_stripped_so_signature_is_stable_across_worktrees(self):
        tpl = 'Traceback (most recent call last):\n  File "{r}/app/order.py", line 33, in total\nAssertionError: x'
        a = signature(tpl.format(r="/work/BUG-07-a1"), root="/work/BUG-07-a1")
        b = signature(tpl.format(r="/work/BUG-07-a2"), root="/work/BUG-07-a2")
        self.assertEqual(a, b)
        self.assertEqual(a, "AssertionError@app/order.py:total")

    def test_windows_stdlib_frames_are_not_project_code(self):
        # gặp ở trận mẫu: frame trong ...\Python310\lib\unittest\loader.py bị lấy làm chữ ký
        log = ('Traceback (most recent call last):\n'
               '  File "C:\\Python310\\lib\\unittest\\loader.py", line 154, in loadTestsFromName\n'
               '    module = __import__(module_name)\n'
               '  File "D:\\w\\BUG-07\\tests\\test_export.py", line 3, in <module>\n'
               "ImportError: cannot import name 'export_csv' from 'shop.customers'")
        self.assertEqual(signature(log, root="D:\\w\\BUG-07"), "ImportError@tests/test_export.py:<module>")
        self.assertEqual(signature(log), "ImportError@BUG-07/tests/test_export.py:<module>")

    def test_go_test_failure_uses_test_name(self):
        log = "--- FAIL: TestTotal (0.00s)\n    order_test.go:21: got 810 want 900\nFAIL"
        self.assertEqual(signature(log), "TestFailure@test:TestTotal")

    def test_node_frame_skips_node_modules(self):
        log = ("TypeError: Cannot read properties of undefined (reading 'id')\n"
               "    at Object.<anonymous> (/w/node_modules/jest/x.js:1:1)\n"
               "    at OrderService.total (/w/src/order/order.service.ts:40:12)")
        self.assertEqual(signature(log), "TypeError@src/order/order.service.ts:OrderService.total")

    def test_condense_keeps_failure_and_drops_noise(self):
        log = "\n".join(["[INFO] Downloading something"] * 500) + "\n" + MAVEN_FAIL
        out = condense(log)
        self.assertIn("expected:<900000> but was:<810000>", out)
        self.assertIn("OrderServiceTest.applyPercentCoupon(OrderServiceTest.java:88)", out)
        self.assertNotIn("Downloading", out)
        self.assertNotIn("org.junit.Assert.fail", out)
        self.assertLess(len(out.splitlines()), 15)

    def test_condense_falls_back_to_tail(self):
        out = condense("\n".join(f"line {i}" for i in range(100)))
        self.assertEqual(out.splitlines()[-1], "line 99")
        self.assertEqual(len(out.splitlines()), 20)


class DiffRulesTest(unittest.TestCase):
    def test_parse_diff_does_not_confuse_removed_sql_comment_with_header(self):
        diff = textwrap.dedent("""\
            diff --git a/db/schema.sql b/db/schema.sql
            index 1..2 100644
            --- a/db/schema.sql
            +++ b/db/schema.sql
            @@ -1 +1 @@
            --- old comment
            +-- new comment
            diff --git a/src/New.java b/src/New.java
            new file mode 100644
            --- /dev/null
            +++ b/src/New.java
            @@ -0,0 +1 @@
            +class New {}
            diff --git a/my file.txt b/my file.txt
            deleted file mode 100644
            --- a/my file.txt
            +++ /dev/null
            @@ -1 +0,0 @@
            -x
            """)
        files = parse_diff(diff)
        self.assertEqual([f.path for f in files], ["db/schema.sql", "src/New.java", "my file.txt"])
        self.assertEqual(files[0].removed, ["-- old comment"])
        self.assertEqual(files[0].added, ["-- new comment"])
        self.assertEqual([f.kind for f in files], ["modified", "added", "deleted"])

    def test_forbidden_rules(self):
        markers = ["@Disabled", ".skip("]
        cases = [
            (FileChange("src/test/java/OrderTest.java", added=["  @Disabled"]), True),
            (FileChange("src/repo.ts", added=["query.skip(10)"]), False),                 # code thật, không phải test
            (FileChange("src/order.test.ts", added=["it.skip('x', () => {})"]), True),
            (FileChange("tests/test_a.py", removed=["    assert x == 1"]), True),         # bớt assertion
            (FileChange("tests/test_a.py", kind="deleted"), True),
            (FileChange("pom.xml", added=["<dependency/>"]), True),
            (FileChange(".github/workflows/ci.yml", added=["x"]), True),
            (FileChange("src/main/java/Order.java", added=["x"]), False),
        ]
        for ch, is_bad in cases:
            with self.subTest(path=ch.path):
                bad, _ = forbidden_changes([ch], markers, [])
                self.assertEqual(bool(bad), is_bad, bad)

    def test_changed_assertion_is_warning_and_build_file_allowed_with_dependency(self):
        ch = FileChange("tests/test_a.py", removed=["assert x == 1"], added=["assert x == 2"])
        bad, warn = forbidden_changes([ch, FileChange("pom.xml", added=["<dependency/>"])], [], ["g:a:1"])
        self.assertEqual(bad, [])
        self.assertEqual(len(warn), 1)

    def test_secrets_removed_from_command_env(self):
        os.environ["FAKE_API_KEY"] = os.environ["GM_URL_TEST"] = os.environ["GITHUB_TOKEN_X"] = "s"
        try:
            env = _clean_env()
            self.assertFalse({"FAKE_API_KEY", "GM_URL_TEST", "GITHUB_TOKEN_X"} & set(env))
            self.assertIn("PATH", {k.upper() for k in env})
        finally:
            for k in ("FAKE_API_KEY", "GM_URL_TEST", "GITHUB_TOKEN_X"):
                os.environ.pop(k, None)


@unittest.skipUnless(shutil.which("git"), "cần git")
class GateRunTest(unittest.TestCase):
    """Repo Python nhỏ có lỗi total() trả 810 thay vì 900; gate chạy `python -m unittest` thật."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.tools = self.tmp / "tools"
        self.tools.mkdir()
        self._write({
            ".gitignore": "__pycache__/\n",
            "app.py": "def total():\n    return 810\n\n\ndef name():\n    return 'shop'\n",
            "tests/__init__.py": "",
            "tests/test_name.py": "import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n"
                                  "    def test_name(self):\n        self.assertEqual(app.name(), 'shop')\n",
        })
        for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        self.profile = {"primary": "python", "stacks": [{
            "id": "python", "root": ".", "build_tool": "pip",
            "build": f"{PY} -m py_compile app.py",
            "test_all": f"{PY} -m unittest discover -s tests -t .",
            "test_one": f"{PY} -m unittest {{target}}",
            "forbidden_skip": ["@unittest.skip"],
        }]}
        self.store = Store(self.tmp / "state.db")
        self.item = {"id": "TASK-01", "title": "t"}

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, files: dict[str, str]):
        for rel, body in files.items():
            p = self.repo / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body, encoding="utf-8")

    def _gate(self, **cfg) -> Gate:
        return Gate(self.profile, config=GateConfig(**cfg), store=self.store, runs_dir=self.tmp / "runs")

    def _fix(self, app_total="900", **fix):
        self._write({
            "app.py": f"def total():\n    return {app_total}\n\n\ndef name():\n    return 'shop'\n",
            "tests/test_total.py": "import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n"
                                   "    def test_total(self):\n        self.assertEqual(app.total(), 900)\n",
        })
        return {"tests_added": ["tests.test_total"], "needs_dependency": [], **fix}

    def test_pass(self):
        rep = self._gate().run(self.item, self.repo, self._fix())
        self.assertTrue(rep.passed, rep.to_text())
        self.assertEqual([c.name for c in rep.checks], ["diff", "forbidden", "build", "target_tests", "regression"])
        self.assertEqual(rep.files_changed, 2)
        self.assertIn("gate: PASS", rep.to_text())
        self.assertEqual(self.store.gate_history("TASK-01")[0]["passed"], 1)
        self.assertIn("+        self.assertEqual(app.total(), 900)", diff_text(self.repo))

    def test_no_change(self):
        rep = self._gate().run(self.item, self.repo, {})
        self.assertEqual((rep.passed, rep.fail_kind), (False, "no_change"))

    def test_compile_error(self):
        fix = self._fix(app_total="900 +")
        rep = self._gate().run(self.item, self.repo, fix)
        self.assertEqual(rep.fail_kind, "compile")
        self.assertTrue(rep.signature.startswith("compile:app.py:"), rep.signature)
        self.assertEqual(rep.failed_check().name, "build")

    def test_original_still_failing_then_same_signature(self):
        fix = self._fix(app_total="810")
        r1 = self._gate().run(self.item, self.repo, fix, attempt=1)
        r2 = self._gate().run(self.item, self.repo, fix, attempt=2)
        self.assertEqual(r1.fail_kind, "original_still_failing")
        self.assertIn("test_total", r1.signature)
        self.assertNotIn(str(self.repo), r1.signature)
        self.assertEqual(r1.signature, r2.signature)
        self.assertIn("810 != 900", r1.log)
        prev = r1.previous_attempt()
        self.assertEqual((prev["fail_kind"], prev["failed_check"]), ("original_still_failing", "target_tests"))
        self.assertEqual([r["signature"] for r in self.store.gate_history("TASK-01")], [r1.signature] * 2)

    def test_regression(self):
        fix = self._fix()
        self._write({"app.py": "def total():\n    return 900\n\n\ndef name():\n    return 'store'\n"})
        rep = self._gate().run(self.item, self.repo, fix)
        self.assertEqual(rep.fail_kind, "regression")
        self.assertEqual(rep.failed_check().name, "regression")
        self.assertIn("test_name", rep.signature)

    def test_quick_skips_regression(self):
        fix = self._fix()
        self._write({"app.py": "def total():\n    return 900\n\n\ndef name():\n    return 'store'\n"})
        rep = self._gate().run(self.item, self.repo, fix, full_regression=False)
        self.assertTrue(rep.passed)
        self.assertEqual(rep.checks[-1].status, "skipped")

    def test_diff_too_large(self):
        rep = self._gate(max_lines=3).run(self.item, self.repo, self._fix())
        self.assertEqual(rep.fail_kind, "diff_too_large")

    def test_forbidden_skip_marker(self):
        fix = self._fix()
        self._write({"tests/test_name.py": "import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n"
                                           "    @unittest.skip('x')\n    def test_name(self):\n"
                                           "        self.assertEqual(app.name(), 'shop')\n"})
        rep = self._gate().run(self.item, self.repo, fix)
        self.assertEqual(rep.fail_kind, "forbidden_change")

    def test_unsafe_target_is_not_run(self):
        fix = self._fix(tests_added=["tests.test_total & echo pwned > pwned.txt"])
        rep = self._gate().run(self.item, self.repo, fix)
        self.assertTrue(rep.passed, rep.to_text())
        self.assertFalse((self.repo / "pwned.txt").exists())
        self.assertEqual(next(c for c in rep.checks if c.name == "tests_declared").status, "warn")
        self.assertNotIn("target_tests", [c.name for c in rep.checks])

    def test_misformatted_target_is_warning_and_regression_still_runs(self):
        # lần chạy thật đầu tiên: fixer khai kiểu Java `Class#method` cho dự án unittest
        rep = self._gate().run(self.item, self.repo, self._fix(tests_added=["T#test_total"]))
        self.assertTrue(rep.passed, rep.to_text())
        target = next(c for c in rep.checks if c.name == "target_tests")
        self.assertEqual(target.status, "warn")
        self.assertEqual(rep.checks[-1].name, "regression")

    def test_misformatted_target_does_not_hide_a_real_failure(self):
        rep = self._gate().run(self.item, self.repo, self._fix(app_total="810", tests_added=["T#test_total"]))
        self.assertEqual(rep.fail_kind, "regression")              # test mới vẫn chạy trong test_all

    def test_import_error_inside_named_test_is_not_treated_as_missing_name(self):
        fix = self._fix()
        self._write({"tests/test_total.py": "import unittest\nimport shop_missing\n"})
        rep = self._gate().run(self.item, self.repo, fix)
        self.assertEqual(rep.fail_kind, "original_still_failing")

    def test_flaky_test_passes_on_rerun(self):
        flag = self.tools / "flag"
        (self.tools / "flaky.py").write_text(
            f"import os, sys\np = {str(flag)!r}\nok = os.path.exists(p)\nopen(p, 'w').close()\nsys.exit(0 if ok else 1)\n",
            encoding="utf-8")
        self.profile["stacks"][0]["test_all"] = f"{PY} {self.tools / 'flaky.py'}"
        rep = self._gate().run(self.item, self.repo, self._fix())
        self.assertTrue(rep.passed, rep.to_text())
        self.assertIn("flaky", rep.checks[-1].note)

    def test_timeout(self):
        self.profile["stacks"][0]["build"] = f'{PY} -c "import time; time.sleep(30)"'
        rep = self._gate(build_sec=1).run(self.item, self.repo, self._fix())
        self.assertEqual(rep.fail_kind, "timeout")
        self.assertLess(rep.seconds, 20)

    def test_mvs(self):
        bug = {"id": "BUG-07"}
        rep = self._gate().run(bug, self.repo, self._fix())
        self.assertTrue(rep.passed)
        self.assertEqual((rep.checks[-1].name, rep.checks[-1].status), ("mvs", "skipped"))
        self.assertIsNone(rep.mvs_passed)
        rep = self._gate().run(bug, self.repo, self._fix(), mvs_command=f'{PY} -c "raise SystemExit(1)"')
        self.assertEqual((rep.fail_kind, rep.mvs_passed), ("mvs_fail", False))
        rep = self._gate().run(bug, self.repo, self._fix(), mvs_command=f'{PY} -c "pass"')
        self.assertEqual((rep.passed, rep.mvs_passed), (True, True))


if __name__ == "__main__":
    unittest.main()
