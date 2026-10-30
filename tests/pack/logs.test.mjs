// Log Condenser (port tests/test_gate.py LogsTest): chữ ký lỗi ổn định qua các lần thử, rút gọn log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileErrors, condense, failingTestNames, signature } from '../../pack/src/gate/logs.mjs';

const MAVEN_FAIL = `[INFO] Scanning for projects...
[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.2 s <<< FAILURE! - in com.shop.order.OrderServiceTest
java.lang.AssertionError: expected:<900000> but was:<810000>
\tat org.junit.Assert.fail(Assert.java:89)
\tat com.shop.order.OrderServiceTest.applyPercentCoupon(OrderServiceTest.java:88)
\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
[ERROR] Failures:
[ERROR]   OrderServiceTest.applyPercentCoupon:88 expected:<900000> but was:<810000>
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.0:test
`;

test('java signature skips library frames and ignores line numbers', () => {
  assert.equal(signature(MAVEN_FAIL), 'AssertionError@com.shop.order.OrderServiceTest.applyPercentCoupon');
  assert.ok(failingTestNames(MAVEN_FAIL).includes('OrderServiceTest.applyPercentCoupon'));
  assert.equal(signature(MAVEN_FAIL.replace('OrderServiceTest.java:88', 'OrderServiceTest.java:95')), signature(MAVEN_FAIL));
});

test('compile errors per stack', () => {
  const cases = {
    '[ERROR] /w/src/main/java/OrderService.java:[42,17] cannot find symbol': 'OrderService.java',
    "src/order.ts(12,5): error TS2339: Property 'rate' does not exist": 'order.ts',
    "src/order.ts:12:5 - error TS2339: Property 'rate' does not exist": 'order.ts',
    "/w/Order.cs(10,5): error CS0103: The name 'rate' does not exist [/w/Shop.csproj]": 'Order.cs',
    'order/order.go:12:3: undefined: rate': 'order.go',
    "PHP Parse error:  syntax error, unexpected '}' in /w/app/Order.php on line 12": 'Order.php',
    '  File "app/x.py", line 3\n    def f(:\nSyntaxError: invalid syntax': 'x.py'
  };
  for (const [log, file] of Object.entries(cases)) {
    assert.equal(compileErrors(log)[0][0], file, log);
    assert.ok(signature(log).startsWith(`compile:${file}:`), log);
  }
  // Số trong thông báo bị thay bằng N: cùng lỗi ở dòng khác vẫn cùng chữ ký.
  assert.equal(signature('src/a.ts(3,1): error TS2554: Expected 2 arguments, but got 1.'), 'compile:a.ts:TSN: Expected N arguments, but got N.');
});

test('root is stripped so the signature is stable across worktrees', () => {
  const log = r => `Traceback (most recent call last):\n  File "${r}/app/order.py", line 33, in total\nAssertionError: x`;
  const a = signature(log('/work/BUG-07-a1'), { root: '/work/BUG-07-a1' });
  assert.equal(a, signature(log('/work/BUG-07-a2'), { root: '/work/BUG-07-a2' }));
  assert.equal(a, 'AssertionError@app/order.py:total');
});

test('windows stdlib frames are not project code', () => {
  const log = 'Traceback (most recent call last):\n' +
    '  File "C:\\Python310\\lib\\unittest\\loader.py", line 154, in loadTestsFromName\n' +
    '    module = __import__(module_name)\n' +
    '  File "D:\\w\\BUG-07\\tests\\test_export.py", line 3, in <module>\n' +
    "ImportError: cannot import name 'export_csv' from 'shop.customers'";
  assert.equal(signature(log, { root: 'D:\\w\\BUG-07' }), 'ImportError@tests/test_export.py:<module>');
  assert.equal(signature(log), 'ImportError@BUG-07/tests/test_export.py:<module>');
});

test('go, node and vitest failures', () => {
  assert.equal(signature('--- FAIL: TestTotal (0.00s)\n    order_test.go:21: got 810 want 900\nFAIL'), 'TestFailure@test:TestTotal');
  assert.equal(signature("TypeError: Cannot read properties of undefined (reading 'id')\n" +
    '    at Object.<anonymous> (/w/node_modules/jest/x.js:1:1)\n' +
    '    at OrderService.total (/w/src/order/order.service.ts:40:12)'), 'TypeError@src/order/order.service.ts:OrderService.total');
  const vitest = n => ` FAIL  tests/money.test.ts > money > rounds VND\nAssertionError: expected ${n} to be 100\n ❯ tests/money.test.ts:${n}:15\n`;
  assert.equal(signature(vitest(12)), 'AssertionError@tests/money.test.ts');
  assert.equal(signature(vitest(12)), signature(vitest(30)));
  assert.equal(signature('nothing recognisable here'), null);
});

test('condense keeps the failure, drops noise, falls back to the tail', () => {
  const out = condense(`${Array(500).fill('[INFO] Downloading something').join('\n')}\n${MAVEN_FAIL}`);
  assert.match(out, /expected:<900000> but was:<810000>/);
  assert.match(out, /OrderServiceTest\.applyPercentCoupon\(OrderServiceTest\.java:88\)/);
  assert.doesNotMatch(out, /Downloading|org\.junit\.Assert\.fail/);
  assert.ok(out.split('\n').length < 15);
  const tail = condense(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')).split('\n');
  assert.equal(tail.at(-1), 'line 99');
  assert.equal(tail.length, 20);
});
