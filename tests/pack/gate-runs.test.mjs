// Gate chạy test thật (mục 5, 7, 9, 10): runner giả nhỏ ghi báo cáo cùng dạng JSON với vitest, repo git tạm, probe thật.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectProfile } from '../../pack/src/env/environment.mjs';
import { changedFiles, runGate, testQuality } from '../../pack/src/gate/gate.mjs';
import { Probe } from '../../pack/src/gate/probe.mjs';
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

// TOKXKPBV: `next build` chiếm ~65% thời gian gate; stack node cho build chạy song song với test (profile.parallelBuild).
test('build runs in parallel with the tests only when the profile allows it, and a failing build still wins', { timeout: 120_000 }, async () => {
  const r = appRepo();
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');
  // Build giả nằm ngoài diff (.logs/ bị exclude): pass khi log regression xuất hiện lúc nó còn chạy, tức test chạy cùng lúc.
  const logs = join(r.root, '.logs');
  mkdirSync(logs, { recursive: true });
  const buildScript = (jobId, waitMs) => {
    const file = join(logs, `build-${jobId}.cjs`);
    const regressionLog = join(logs, `BUG-09-gate-${jobId}-regression.log`);
    writeFileSync(file, `const fs = require('fs'); const end = Date.now() + ${waitMs};
const tick = () => { if (fs.existsSync(${JSON.stringify(regressionLog)})) process.exit(0);
  if (Date.now() > end) { console.error('regression did not start while the build ran'); process.exit(2); } setTimeout(tick, 50); };
tick();\n`);
    return `node "${file}"`;
  };
  const run = (jobId, parallelBuild, build) => runGate({ id: jobId, progress: [] }, {
    key: 'BUG-09', checkoutRoot: r.root, matchRoot: join(r.root, 'M1'), folder: 'M1', base: r.base, baseline: BASELINE, template: null,
    profile: { ...r.profile, parallelBuild, commands: { ...r.profile.commands, build } }, logDir: logs,
    limits: { maxFiles: 25, buildMs: 60_000, testMs: 60_000 } });

  const sequential = await run('job-seq', false, buildScript('job-seq', 1500));
  assert.equal(sequential.failKind, 'compile', 'without parallelBuild the tests wait for the build');
  assert.equal(sequential.checks.some(c => c.name === 'regression'), false);

  const parallel = await run('job-par', true, buildScript('job-par', 30_000));
  assert.equal(parallel.passed, true, JSON.stringify(parallel.checks));
  const names = parallel.checks.map(c => c.name);
  assert.ok(names.indexOf('build') < names.indexOf('regression'), 'checks keep the sequential order');
  assert.equal(parallel.regression.total, 3, 'test results of a passing build are kept');

  writeFileSync(join(logs, 'broken.cjs'), "console.error('src/lib.ts(3,1): error TS1005: expected'); process.exit(1);\n");
  const broken = await run('job-broken', true, `node "${join(logs, 'broken.cjs')}"`);
  assert.equal(broken.failKind, 'compile');
  assert.equal(broken.detail, 'build failed');
  assert.equal(broken.regression, null, 'test results of a failed build are dropped, as if they never ran');
  assert.equal(broken.checks.some(c => c.name === 'regression'), false);
});

// NBDB5U0O: gate nào cũng build lại 30–57 s đúng source mà app evidence vừa build xong.
test('a gate given a prebuilt build of the same source runs the tests without building', { timeout: 60_000 }, async () => {
  const r = appRepo();
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');
  const logs = join(r.root, '.logs'), counter = join(logs, 'builds.txt');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'build.cjs'), `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\n`);
  const profile = { ...r.profile, parallelBuild: true, commands: { ...r.profile.commands, build: `node "${join(logs, 'build.cjs')}"` } };
  const reused = await gate(r, { profile, prebuilt: { by: 'app', at: '2026-11-02T10:00:00.000Z' } });
  assert.equal(reused.passed, true, JSON.stringify(reused.checks));
  assert.deepEqual(reused.checks.find(c => c.name === 'build'), { name: 'build', status: 'ok', seconds: 0, reused: 'app' });
  assert.equal(existsSync(counter), false, 'no build ran');
  assert.equal(reused.regression.total, 3, 'the tests still ran');
  const built = await gate(r, { profile });
  assert.equal(built.passed, true, JSON.stringify(built.checks));
  assert.equal(readFileSync(counter, 'utf8'), 'x');
});

test('parallelBuild only for a node build that the test script does not depend on', () => {
  const cases = [[{ build: 'next build', test: 'vitest run' }, true], [{ build: 'tsc', pretest: 'npm run build', test: 'jest' }, false],
    [{ build: 'tsc', test: 'node --test dist/' }, false], [{ build: 'tsc', test: 'npm run build && jest' }, false], [{ test: 'vitest run' }, false]];
  for (const [scripts, expected] of cases) {
    const dir = tempDir('mtm-profile-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    assert.equal(detectProfile(dir).parallelBuild, expected, JSON.stringify(scripts));
  }
});

// Practice #6 (HIET12OA): một test fail sẵn trái ý định hiện tại của app làm mọi item có "pnpm test exits 0" mất điểm.
test('a baseline-failing test that now passes is reported in fixesBaseline', async () => {
  const r = appRepo();
  writeFileSync(join(r.root, '.runs'), '5');   // flaky test đã "ấm"
  writeFileSync(join(r.app, 'lib.js'), "exports.vnd = n => n * 10000;\nexports.deleteMode = 'cascade';\n");
  writeFileSync(join(r.app, 'tests', 'stale.test.js'), "const lib = require('../lib.js');\nit('company delete', () => { expect(lib.deleteMode).toBe('restrict'); });\n");
  sh('git', ['add', '-A'], r.root, env);
  sh('git', ['commit', '-q', '-m', 'stale test'], r.root, env);
  const at = { ...r, base: sh('git', ['rev-parse', 'HEAD'], r.root) };
  const id = 'tests/stale.test.js > company delete';
  const baseline = { ...BASELINE, failing: [id], tests: { ...BASELINE.tests, [id]: 'failed' } };
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');

  // Bản sửa khác không đụng test đó: vẫn fail như baseline, không tính là đã sửa.
  writeFileSync(join(r.app, 'lib.js'), "exports.vnd = n => n * 100;\nexports.deleteMode = 'cascade';\n");
  const other = await gate(at, { baseline });
  assert.equal(other.passed, true, JSON.stringify(other.checks));
  assert.deepEqual(other.baselineFailures, [id]);
  assert.deepEqual(other.fixesBaseline, []);

  // Test cũ trái ý định hiện tại: sửa nó (cùng tên, chặt như cũ) cần allowTestChange; khi đó gate báo đã sửa.
  writeFileSync(join(r.app, 'tests', 'stale.test.js'), "const lib = require('../lib.js');\nit('company delete', () => { expect(lib.deleteMode).toBe('cascade'); });\n");
  const blocked = await gate(at, { baseline });
  assert.equal(blocked.failKind, 'forbidden_change');
  assert.match(blocked.detail, /contradicts the intended behaviour/);
  const fixed = await gate(at, { baseline, allowTestChange: { reason: 'owner asked for cascade', source: 'prisma/migrations/x/migration.sql:11' } });
  assert.equal(fixed.passed, true, JSON.stringify(fixed.checks));
  assert.deepEqual(fixed.fixesBaseline, [id]);
  assert.deepEqual(fixed.baselineFailures, []);

  // ZVUYZ41V BUG-02: test cũ được viết lại dưới tên mới. Có allowTestChange thì tên cũ biến mất cũng là đã sửa.
  writeFileSync(join(r.app, 'tests', 'stale.test.js'), "const lib = require('../lib.js');\nit('company delete cascades', () => { expect(lib.deleteMode).toBe('cascade'); });\n");
  const renamed = await gate(at, { baseline, allowTestChange: { reason: 'owner asked for cascade', source: 'prisma/migrations/x/migration.sql:11' } });
  assert.equal(renamed.passed, true, JSON.stringify(renamed.checks));
  assert.deepEqual(renamed.removedTests, [id]);
  assert.deepEqual(renamed.fixesBaseline, [id]);
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
  // Một test mới fail trước khi sửa: test còn lại là đối chứng, không thành finding.
  assert.equal(check.status, 'ok', JSON.stringify(check));
  assert.equal(check.reproduced, true);
  assert.equal(check.newTests, 2);
  assert.deepEqual(check.passesBefore, ['tests/money.test.js > zero again']);
  assert.equal(result.findings.some(f => f.startsWith('fail-before: ')), false);
  // Probe được dọn về base sau khi chạy.
  assert.equal(readFileSync(join(probe.matchRoot, 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'exports.vnd = n => n * 10000;\n');
  assert.doesNotMatch(readFileSync(join(probe.matchRoot, 'src', 'tests', 'money.test.js'), 'utf8'), /zero again/);
});

test('BUG/PI reproduction requires a new failing test and fails closed when the probe is unavailable', { timeout: 180_000 }, async () => {
  const r = appRepo();
  writeFileSync(join(r.root, '.runs'), '5');   // flaky test đã "ấm", không làm nhiễu
  writeFileSync(join(r.app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), '{"status":"DONE"}');
  const probe = new Probe({ checkoutRoot: r.root, teamWork: join(r.root, '.team-work'), folder: 'M1', mainMatchRoot: join(r.root, 'M1'),
    logDir: join(r.root, '.logs') });
  assert.equal(await probe.prepare(), true, probe.error);
  const pi = extra => gate(r, { probe, requireReproduction: true, ...extra });

  const none = await pi({});
  assert.equal(none.failKind, 'not_reproduced', JSON.stringify(none.checks));
  assert.equal(none.signature, 'not_reproduced:none');
  assert.equal(none.codePassed, true);
  assert.ok(none.tree, 'build and regression passed: integrate may still take this content');

  const testFile = join(r.app, 'tests', 'money.test.js');
  const original = readFileSync(testFile, 'utf8');
  writeFileSync(testFile, `${original}it('zero again', () => { expect(vnd(0)).toBe(0); });\n`);
  const weak = await pi({ testsAdded: ['tests/money.test.js'] });
  assert.equal(weak.failKind, 'not_reproduced', JSON.stringify(weak.checks));
  assert.equal(weak.signature, 'not_reproduced:passes-before');
  assert.match(weak.detail, /zero again/);
  assert.equal(weak.checks.find(c => c.name === 'fail-before').status, 'warn');

  writeFileSync(testFile, `${original}it('zero again', () => { expect(vnd(0)).toBe(0); });\nit('one dong is 100 xu', () => { expect(vnd(1)).toBe(100); });\n`);
  const ok = await pi({ testsAdded: ['tests/money.test.js'] });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks.find(c => c.name === 'reproduction').status, 'ok');
  assert.equal(ok.checks.find(c => c.name === 'fail-before').status, 'ok', 'the edge-case test that also passes before is a control, not a warning');

  const unavailable = await gate(r, { testsAdded: ['tests/money.test.js'], requireReproduction: true });
  assert.equal(unavailable.failKind, 'not_reproduced');
  assert.equal(unavailable.signature, 'not_reproduced:unverified');

  // CR/TASK do not request the mandatory reproduction policy.
  const optional = await gate(r, { probe, testsAdded: ['tests/money.test.js'] });
  assert.equal(optional.checks.some(c => c.name === 'reproduction'), false);
});

// FMC0ZXFC PI-01: đề cấm sửa source, chỉ nộp báo cáo; gate cũ fail not_reproduced, guardian chặn submit (160 điểm).
// Cùng trận: tham chiếu evidence trong câu văn dính dấu chấm/phẩy, gate báo thiếu file dù file có.
test('a PI that only changes its answers needs no reproduction test; evidence references ignore trailing punctuation', { timeout: 120_000 }, async () => {
  const r = appRepo();
  writeFileSync(join(r.root, '.runs'), '5');
  const answers = join(r.root, 'M1', 'answers', 'BUG-09');
  mkdirSync(join(answers, 'evidence'), { recursive: true });
  writeFileSync(join(answers, 'evidence', 'derivation.json'), '{}');
  writeFileSync(join(answers, 'submit.json'), JSON.stringify({ status: 'DONE',
    engineeringRecord: 'Joined the logs (evidence/derivation.json). See evidence/derivation.json, then the summary.' }));
  const report = await gate(r, { requireReproduction: true });
  assert.equal(report.passed, true, JSON.stringify(report.checks));
  assert.equal(report.checks.find(c => c.name === 'reproduction').status, 'skipped');
  assert.deepEqual(report.changed, []);
});

// NBDB5U0O: BUG-01 so regex trên globals.css, BUG-02 vi.mock("react") thay useState; gate và reviewer đều cho qua.
test('test quality warns about a test that reads source text or mocks the UI framework', async () => {
  const r = appRepo();
  writeFileSync(join(r.app, 'tests', 'money.test.js'), `${readFileSync(join(r.app, 'tests', 'money.test.js'), 'utf8')}${[
    "vi.mock('react', () => ({ useState: () => ['vnd', () => {}] }));",
    "const src = require('fs').readFileSync('lib.js', 'utf8');",
    "it('vnd text', () => { expect(src).toContain('10000'); });"].join('\n')}\n`);
  const q = await testQuality(r.root, 'HEAD', await changedFiles(r.root, 'HEAD'), 'M1/src');
  assert.deepEqual(q.problems, []);
  assert.match(q.warnings.join('\n'), /mocks the UI framework react/);
  assert.match(q.warnings.join('\n'), /reads source lib\.js and checks its text/);
});
