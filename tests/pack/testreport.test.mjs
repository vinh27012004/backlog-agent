// Kết quả test máy đọc (mục 9): reporter JSON/JUnit, id ổn định, lệnh có reporter, test cần chạy lại.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { baselineOf, fillTargets, readReport, rerunTargets, scriptEndsWithRunner, testCommand } from '../../pack/src/env/testreport.mjs';
import { tempDir } from './support.mjs';

test('vitest JSON report (format of a real vitest 3.2 run) gives one id per test', () => {
  const root = tempDir('mtm-report-');
  const file = join(root, 'out.json');
  const abs = name => `${root.replaceAll('\\', '/')}/tests/${name}`;
  writeFileSync(file, JSON.stringify({ numTotalTests: 3, testResults: [
    { name: abs('a.test.ts'), status: 'failed', message: '', assertionResults: [
      { ancestorTitles: ['money §4'], title: 'adds', fullName: 'money §4 adds', status: 'passed' },
      { ancestorTitles: ['money §4'], title: 'fails', fullName: 'money §4 fails', status: 'failed' },
      { ancestorTitles: ['money §4'], title: 'skipped', fullName: 'money §4 skipped', status: 'skipped' }] },
    { name: abs('b.test.ts'), status: 'failed', message: "Cannot find module '../src/missing'", assertionResults: [] }] }));
  const r = readReport({ format: 'jest-json', file }, { root, stack: 'node' });
  assert.deepEqual([...r.tests], [['tests/a.test.ts > money §4 > adds', 'passed'], ['tests/a.test.ts > money §4 > fails', 'failed'],
    ['tests/a.test.ts > money §4 > skipped', 'skipped'], ['tests/b.test.ts > (load error)', 'failed']]);
  assert.deepEqual(r.counts, { total: 4, passed: 1, failed: 2, skipped: 1 });
  assert.equal(readReport({ format: 'jest-json', file: join(root, 'missing.json') }, { root, stack: 'node' }), null);
});

test('JUnit reports: pytest node ids and java Class.java ids', () => {
  const root = tempDir('mtm-junit-');
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'test_orders.py'), '');
  const py = join(root, 'py.xml');
  writeFileSync(py, `<?xml version="1.0"?><testsuites><testsuite name="pytest">
    <testcase classname="tests.test_orders" name="test_total" time="0.1"><failure message="x">assert 810 == 900</failure></testcase>
    <testcase classname="tests.test_orders.TestCoupon" name="test_percent" time="0.1"/>
    <testcase classname="tests.test_orders" name="test_skip"><skipped message="later"/></testcase></testsuite></testsuites>`);
  const r = readReport({ format: 'junit', file: py }, { root, stack: 'python' });
  assert.deepEqual([...r.tests], [['tests/test_orders.py::test_total', 'failed'], ['tests/test_orders.py::TestCoupon::test_percent', 'passed'],
    ['tests/test_orders.py::test_skip', 'skipped']]);
  assert.deepEqual(rerunTargets(['tests/test_orders.py::test_total'], { stack: 'python' }), ['tests/test_orders.py::test_total']);

  mkdirSync(join(root, 'target', 'surefire-reports'), { recursive: true });
  writeFileSync(join(root, 'target', 'surefire-reports', 'TEST-com.shop.OrderServiceTest.xml'),
    '<testsuite><testcase name="applyPercentCoupon" classname="com.shop.OrderServiceTest"><error type="NPE"/></testcase>' +
    '<testcase name="total" classname="com.shop.OrderServiceTest"/></testsuite>');
  const j = readReport({ format: 'junit-dir', dir: join('target', 'surefire-reports') }, { root, stack: 'java-maven', startedAt: Date.now() - 5000 });
  assert.equal(j.tests.get('com/shop/OrderServiceTest.java > applyPercentCoupon'), 'failed');
  assert.deepEqual(rerunTargets([...j.tests.keys()], { stack: 'java-maven' }), ['OrderServiceTest#applyPercentCoupon', 'OrderServiceTest#total']);
  // Báo cáo cũ (trước lần chạy này) không được tính.
  assert.equal(readReport({ format: 'junit-dir', dir: join('target', 'surefire-reports') }, { root, stack: 'java-maven', startedAt: Date.now() + 60_000 }), null);
});

test('reporter flags only where they reach the runner', () => {
  assert.equal(scriptEndsWithRunner('vitest run', 'vitest'), true);
  assert.equal(scriptEndsWithRunner('prisma generate && dotenv -e .env.test -- vitest run', 'vitest'), true);
  assert.equal(scriptEndsWithRunner('cross-env NODE_ENV=test jest --runInBand', 'jest'), true);
  assert.equal(scriptEndsWithRunner('vitest run && node check.js', 'vitest'), false);
  const node = (pm, testScript) => ({ stack: 'node', testRunner: 'vitest', packageManager: pm, testScript,
    commands: { test_all: `${pm} test`, test_one: `${pm} exec vitest run {target}` } });
  assert.equal(testCommand(node('pnpm', 'vitest run'), 'test_all', 'D:\\l\\r.json').command,
    "pnpm test --reporter=default --reporter=json --outputFile.json='D:\\l\\r.json'");
  assert.equal(testCommand(node('npm', 'vitest run'), 'test_all', 'r.json').command, "npm test -- --reporter=default --reporter=json --outputFile.json='r.json'");
  assert.deepEqual(testCommand(node('pnpm', 'vitest run && node x.js'), 'test_all', 'r.json'), { command: 'pnpm test', format: null });
  assert.equal(testCommand(node('pnpm', 'x'), 'test_one', 'r.json', ['tests/a.test.ts', 'bad name;rm']).command,
    "pnpm exec vitest run --reporter=default --reporter=json --outputFile.json='r.json' 'tests/a.test.ts'");
  const py = { stack: 'python', commands: { test_all: 'python -m pytest -q', test_one: 'python -m pytest -q {target}' } };
  assert.equal(testCommand(py, 'test_one', 'r.xml', ['tests/test_a.py::test_b']).command, "python -m pytest -q --junitxml='r.xml' 'tests/test_a.py::test_b'");
  assert.equal(testCommand({ stack: 'go', commands: { test_all: 'go test ./...' } }, 'test_all', 'r.xml').format, null);
  assert.equal(fillTargets('mvn -q test -Dtest={target}', ['A#m', 'B#n'], 'java-maven'), "mvn -q test -Dtest='A#m,B#n'");
  assert.equal(fillTargets('gradle -q test --tests {target}', ['a.B.m', 'a.C.n'], 'java-gradle'), "gradle -q test --tests 'a.B.m' --tests 'a.C.n'");
});

test('baseline keeps per-test status', () => {
  const tests = new Map([['t > a', 'passed'], ['t > b', 'failed'], ['t > c', 'skipped']]);
  const base = baselineOf({ res: { code: 1, timedOut: false }, report: { tests }, counts: { total: 3 }, failing: ['t > b'], source: 'report' });
  assert.deepEqual(base.tests, { 't > a': 'passed', 't > b': 'failed', 't > c': 'skipped' });
  assert.deepEqual(baselineOf({ res: { timedOut: true } }), { status: 'TIMEOUT' });
});
