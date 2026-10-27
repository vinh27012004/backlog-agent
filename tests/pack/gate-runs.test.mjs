// Gate chạy test thật (mục 5, 7, 9, 10): runner giả nhỏ ghi báo cáo cùng dạng JSON với vitest, repo git tạm, probe thật.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGate } from '../../pack/src/gate.mjs';
import { Probe } from '../../pack/src/probe.mjs';
import { sh, tempDir } from './support.mjs';

// Runner giả: nạp tests/*.test.js (CommonJS), chạy từng it(), ghi JSON như `vitest --reporter=json --outputFile.json=`.
const RUNNER = `const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const flag = args.find(a => a.startsWith('--outputFile.json='));
const out = flag ? flag.slice('--outputFile.json='.length).replace(/^'|'$/g, '') : null;
const targets = args.filter(a => !a.startsWith('--')).map(a => a.replace(/^'|'$/g, ''));
const all = fs.readdirSync('tests').filter(f => f.endsWith('.test.js')).map(f => 'tests/' + f);
const results = []; let failed = 0, total = 0;
for (const file of all.filter(f => !targets.length || targets.includes(f))) {
  const cases = [], stack = [];
  global.describe = (name, fn) => { stack.push(name); fn(); stack.pop(); };
  global.it = (title, fn) => cases.push({ ancestorTitles: [...stack], title, fn });
  global.expect = actual => ({ toBe: exp => { if (actual !== exp) throw new Error('expected ' + actual + ' to be ' + exp); } });
  const abs = path.resolve(file);
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  let loadError = null;
  try { require(abs); } catch (e) { loadError = e; }
  const assertionResults = loadError ? [] : cases.map(c => {
    try { c.fn(); return { ancestorTitles: c.ancestorTitles, title: c.title, status: 'passed' }; }
    catch (e) { console.log(' FAIL  ' + file + ' > ' + c.title + ' ' + e.message); return { ancestorTitles: c.ancestorTitles, title: c.title, status: 'failed' }; }
  });
  failed += assertionResults.filter(a => a.status === 'failed').length + (loadError ? 1 : 0);
  total += assertionResults.length;
  results.push({ name: abs.replace(/\\\\/g, '/'), status: loadError || assertionResults.some(a => a.status === 'failed') ? 'failed' : 'passed', assertionResults });
}
if (out) fs.writeFileSync(out, JSON.stringify({ numTotalTests: total, testResults: results }));
console.log(' Tests  ' + failed + ' failed | ' + (total - failed) + ' passed (' + total + ')');
process.exit(failed ? 1 : 0);
`;

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

// App node nhỏ: lib.js có bug (vnd ×10000 thay vì ×100), một test sẵn có pass, một test flaky (fail lần chạy đầu).
function appRepo() {
  const root = tempDir('mtm-gate-run-');
  const app = join(root, 'M1', 'src');
  mkdirSync(join(app, 'tests'), { recursive: true });
  mkdirSync(join(root, 'M1', 'answers', 'BUG-09'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'app', version: '1.0.0' } } }));
  writeFileSync(join(app, 'runner.cjs'), RUNNER);
  writeFileSync(join(app, 'lib.js'), 'exports.vnd = n => n * 10000;\n');
  writeFileSync(join(app, 'tests', 'money.test.js'), [
    "const { vnd } = require('../lib.js');",
    "it('zero', () => { expect(vnd(0)).toBe(0); });",
    "it('old name', () => { expect(typeof vnd).toBe('function'); });", ''].join('\n'));
  writeFileSync(join(app, 'tests', 'flaky.test.js'), [
    "const fs = require('fs');",
    "it('sometimes', () => { const n = Number(fs.existsSync('.runs') ? fs.readFileSync('.runs', 'utf8') : 0) + 1;",
    "  fs.writeFileSync('.runs', String(n)); expect(n > 1).toBe(true); });", ''].join('\n'));
  sh('git', ['init', '-q', '-b', 'main'], root, env);
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.logs/\n.team-work/\n.runs\n');
  sh('git', ['add', '-A'], root, env);
  sh('git', ['commit', '-q', '-m', 'seed'], root, env);
  const profile = { root: app, stack: 'node', testRunner: 'vitest', testScript: 'vitest run', packageManager: 'pnpm', forbiddenSkip: [],
    commands: { test_all: 'node runner.cjs', test_one: 'node runner.cjs {target}' } };
  return { root, app, base: sh('git', ['rev-parse', 'HEAD'], root), profile };
}

const BASELINE = { status: 'PASS', counts: { total: 3, passed: 3, failed: 0, skipped: 0 }, failing: [], source: 'report',
  tests: { 'tests/money.test.js > zero': 'passed', 'tests/money.test.js > old name': 'passed', 'tests/flaky.test.js > sometimes': 'passed' } };

const gate = (r, extra = {}) => runGate({ id: 'job-r', progress: [] }, {
  key: 'BUG-09', checkoutRoot: r.root, matchRoot: join(r.root, 'M1'), folder: 'M1', profile: r.profile, base: r.base,
  baseline: BASELINE, template: null, logDir: join(r.root, '.logs'), limits: { maxFiles: 25, buildMs: 60_000, testMs: 60_000 }, ...extra });

test('regression by test id: a flaky failure is rerun once, a test that no longer runs is a forbidden change', async () => {
  const r = appRepo();
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  // Đổi tên test cũ: assertion giữ nguyên nên tests-guard không thấy, nhưng id baseline "old name" không còn chạy.
  writeFileSync(join(r.app, 'tests', 'money.test.js'), readFileSync(join(r.app, 'tests', 'money.test.js'), 'utf8').replace('old name', 'new name'));
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');
  const blocked = await gate(r);
  assert.equal(blocked.failKind, 'forbidden_change', JSON.stringify(blocked.checks));
  assert.equal(blocked.signature, 'tests-removed:tests/money.test.js > old name');
  const regression = blocked.checks.find(c => c.name === 'regression');
  assert.equal(regression.source, 'report');
  assert.equal(regression.status, 'warn', 'flaky test failed on the first run and passed on the rerun');
  assert.match(regression.warnings[0], /flaky\): tests\/flaky\.test\.js > sometimes/);
  assert.deepEqual(blocked.checks.find(c => c.name === 'tests-kept').problems, ['tests/money.test.js > old name']);

  const ok = await gate(r, { allowTestChange: { reason: 'Item asks to rename the check', source: 'BUG-09 text' } });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.deepEqual(ok.removedTests, ['tests/money.test.js > old name']);
  assert.ok(ok.findings.some(f => f.startsWith('tests-kept: ')));
  assert.deepEqual(ok.regression, { total: 3, passed: 3, failed: 0, skipped: 0 });
});

test('test quality blocks a new test without an assertion or with one that cannot fail', async () => {
  const r = appRepo();
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  const add = lines => writeFileSync(join(r.app, 'tests', 'money.test.js'), `${readFileSync(join(r.app, 'tests', 'money.test.js'), 'utf8')}${lines.join('\n')}\n`);
  add(["it('vnd one', () => { vnd(1); });"]);
  const empty = await gate(r);
  assert.equal(empty.failKind, 'weak_test');
  assert.match(empty.detail, /new test "vnd one" has no assertion/);
  sh('git', ['checkout', '--', '.'], r.root);
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  add(["it('vnd one', () => { const v = vnd(1); expect(v).toBe(v); });", "it('swallows', () => { try { vnd(); } catch (e) {} expect(vnd(2)).toBe(200); });"]);
  const taut = await gate(r);
  assert.equal(taut.failKind, 'weak_test');
  assert.match(taut.detail, /assertion can never fail: .*expect\(v\)\.toBe\(v\)/);
  assert.match(taut.checks.find(c => c.name === 'test-quality').warnings.join('\n'), /swallows an error/);
});

test('fail-before runs the new tests on the unfixed code in the probe worktree', { timeout: 120_000 }, async () => {
  const r = appRepo();
  writeFileSync(join(r.root, '.runs'), '5');   // flaky test đã "ấm", không làm nhiễu
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  writeFileSync(join(r.app, 'tests', 'money.test.js'), `${readFileSync(join(r.app, 'tests', 'money.test.js'), 'utf8')}${[
    "it('one dong is 100 xu', () => { expect(vnd(1)).toBe(100); });",
    "it('zero again', () => { expect(vnd(0)).toBe(0); });"].join('\n')}\n`);
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');
  const probe = new Probe({ checkoutRoot: r.root, teamWork: join(r.root, '.team-work'), folder: 'M1', mainMatchRoot: join(r.root, 'M1'),
    logDir: join(r.root, '.logs') });
  assert.equal(await probe.prepare(), true, probe.error);
  const result = await gate(r, { probe, testsAdded: ['tests/money.test.js'] });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  const check = result.checks.find(c => c.name === 'fail-before');
  assert.equal(check.status, 'warn', JSON.stringify(check));
  assert.equal(check.newTests, 2);
  assert.match(check.warnings[0], /does not reproduce the problem: tests\/money\.test\.js > zero again$/);
  assert.ok(result.findings.some(f => f.startsWith('fail-before: ')));
  // Probe được dọn về base sau khi chạy.
  assert.equal(readFileSync(join(probe.matchRoot, 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'exports.vnd = n => n * 10000;\n');
  assert.doesNotMatch(readFileSync(join(probe.matchRoot, 'src', 'tests', 'money.test.js'), 'utf8'), /zero again/);
});
