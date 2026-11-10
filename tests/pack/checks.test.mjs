// Tool run_checks (9O802QWE: fixer tự nối typecheck → build → test trong shell rồi tốn 4–10 lượt model chờ và đọc log).
// Project node nhỏ, script chỉ là lệnh node: chạy thật qua pwsh/npm như trong trận, không mạng.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChecks, runChecks, verificationRows } from '../../pack/src/env/checks.mjs';
import { app } from '../../pack/src/env/app.mjs';
import { detectProfile } from '../../pack/src/env/environment.mjs';
import { namedTestPackages, testScope } from '../../pack/src/env/test-scope.mjs';
import { localRuntime, sh, tempDir } from './support.mjs';
import { Runtime } from '../../pack/src/tools.mjs';

function project(scripts) {
  const tw = tempDir('mtm-checks-'), matchRoot = join(tw, 'matches', 'M1', 'M1'), app = join(matchRoot, 'src');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'npm@10.0.0', scripts }));
  return { tw, matchRoot, teamWork: join(tw, 'matches', 'M1', '.team-work') };
}
const ok = text => `node -e "console.log('${text}')"`;
// Một check hỏng thì run_checks trả về ngay khi các check khác còn chạy: hỏi status tới khi cả lần chạy xong.
async function finished(p, key, res) {
  for (let i = 0; i < 100 && res.state === 'running'; i++) {
    await new Promise(r => setTimeout(r, 300));
    res = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: key, matchRoot: p.matchRoot, waitSeconds: 0 });
  }
  return res;
}

// Project npm workspaces: core và web có test, docs không; một commit để run_checks thấy file item sửa.
const GRADER = 'The grader runs the core tests itself on your submitted revision.';
function workspaceProject() {
  const p = project({ test: ok('all ran') });
  const app = join(p.matchRoot, 'src');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, packageManager: 'npm@10.0.0',
    workspaces: ['packages/*'], scripts: { test: ok('all ran') } }));
  for (const [dir, scripts] of [['core', { test: ok('core ran') }], ['web', { test: ok('web ran') }], ['docs', {}]]) {
    mkdirSync(join(app, 'packages', dir), { recursive: true });
    writeFileSync(join(app, 'packages', dir, 'package.json'), JSON.stringify({ name: `@x/${dir}`, version: '1.0.0', scripts }));
    writeFileSync(join(app, 'packages', dir, 'index.js'), 'export const v = 1;\n');
  }
  const checkout = join(p.tw, 'matches', 'M1');
  sh('git', ['init', '-q'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'issued'], checkout);
  return p;
}

test('run_checks runs typecheck, build and the full suite, logs each to evidence and records the result', async () => {
  const p = project({ typecheck: ok('types fine'), build: ok('built'), test: ok('Tests  2 passed (2)') });
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-01', matchRoot: p.matchRoot });
  assert.equal(res.state, 'done', JSON.stringify(res)); assert.equal(res.ok, true);
  assert.deepEqual(res.results.map(r => [r.name, r.state, r.log]),
    [['typecheck', 'passed', 'evidence/typecheck.log'], ['build', 'passed', 'evidence/build.log'], ['test', 'passed', 'evidence/full-suite.log']]);
  assert.deepEqual(res.results[2].counts, { total: 2, passed: 2, failed: 0, skipped: 0 });
  const evidence = join(p.matchRoot, 'answers', 'BUG-01', 'evidence');
  assert.match(readFileSync(join(evidence, 'build.log'), 'utf8'), /built/);
  assert.match(readFileSync(join(evidence, 'full-suite.log'), 'utf8'), /2 passed/);
  assert.equal(existsSync(join(evidence, 'full-suite.json')), false, 'runner reports stay out of the evidence');
  assert.equal(readChecks(p.teamWork, 'BUG-01').state, 'done');
  assert.deepEqual(verificationRows(readChecks(p.teamWork, 'BUG-01')).map(v => [v.check, v.command, v.result]),
    [['typecheck', 'npm run typecheck', 'pass'], ['build', 'npm run build', 'pass'], ['full test suite', 'npm test', 'pass']]);
  const again = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'BUG-01', matchRoot: p.matchRoot });
  assert.equal(again.runId, res.runId);
});

test('run_checks reports a failing check with its tail and skips a check the profile lacks', async () => {
  const p = project({ typecheck: 'node -e "console.error(\'TS2322: bad type\'); process.exit(2)"', test: ok('ok') });
  const res = await finished(p, 'CR-01', await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-01', matchRoot: p.matchRoot, parallel: false }));
  assert.equal(res.ok, false);
  const [typecheck, build] = res.results;
  assert.equal(typecheck.state, 'failed'); assert.match(typecheck.tail, /TS2322/);
  assert.equal(build.state, 'skipped'); assert.equal(build.log, undefined);
  assert.match(res.hint, /Failed: typecheck/);
  assert.deepEqual(verificationRows(readChecks(p.teamWork, 'CR-01')).map(v => v.result), ['fail', 'not_run', 'pass']);
});

test('run_checks returns running while the checks outlast the wait, and status picks the result up', async () => {
  const p = project({ test: 'node -e "setTimeout(() => console.log(\'Tests  1 passed (1)\'), 2500)"' });
  const first = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-02', matchRoot: p.matchRoot, checks: ['test'], waitSeconds: 0 });
  assert.equal(first.state, 'running'); assert.match(first.hint, /action: "status"/);
  const same = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-02', matchRoot: p.matchRoot, checks: ['test'], waitSeconds: 0 });
  assert.equal(same.runId, first.runId, 'a second run call joins the running one');
  // RATH0OHJ: worker gọi status với waitSeconds 40–50 rồi lặp lại; chờ dương nào cũng chờ tới khi xong.
  const done = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'BUG-02', matchRoot: p.matchRoot, waitSeconds: 1 });
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.ok, true);
});

test('run_checks only accepts a matchRoot inside TeamWorkspace/matches and known check names', async () => {
  const p = project({ test: ok('x') });
  await assert.rejects(runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-01', matchRoot: p.tw }), /PATH_NOT_ALLOWED/);
  await assert.rejects(runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-01', matchRoot: p.matchRoot, checks: ['lint'] }), /INVALID_ARGUMENT/);
});

// 08OQBPW8: 3–4 lần chạy mỗi item. Source và môi trường không đổi thì trả lại lần chạy trước.
test('run_checks returns the last run for unchanged source and runs again after a change or with force', async () => {
  const p = project({ typecheck: ok('types fine'), test: ok('Tests  1 passed (1)') });
  const checkout = join(p.tw, 'matches', 'M1');
  sh('git', ['init', '-q'], checkout);
  const first = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-02', matchRoot: p.matchRoot });
  assert.equal(first.state, 'done', JSON.stringify(first));
  const again = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-02', matchRoot: p.matchRoot, checks: ['test'] });
  assert.equal(again.cached, true); assert.equal(again.runId, first.runId);
  assert.deepEqual(again.results.map(r => r.name), ['test']);
  writeFileSync(join(p.matchRoot, 'answers', 'CR-02', 'evidence', 'note.txt'), 'evidence does not count');
  assert.equal((await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-02', matchRoot: p.matchRoot })).cached, true);
  writeFileSync(join(p.matchRoot, 'src', 'lib.js'), 'export const x = 1;\n');
  const changed = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-02', matchRoot: p.matchRoot });
  assert.equal(changed.cached, undefined); assert.notEqual(changed.runId, first.runId);
  const forced = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-02', matchRoot: p.matchRoot, force: true });
  assert.notEqual(forced.runId, changed.runId);
});

// 08OQBPW8: app tự build 56 s rồi run_checks build lại. app start chờ build của run_checks đang chạy.
test('app start waits for a run_checks build of the same item instead of building over it', async () => {
  const p = project({ build: ok('built'), start: ok('started') });
  const file = join(p.teamWork, 'items', 'BUG-04', 'checks.json');
  mkdirSync(join(p.teamWork, 'items', 'BUG-04'), { recursive: true });
  writeFileSync(file, JSON.stringify({ runId: 'r-9', state: 'running', pid: process.pid, checks: ['typecheck', 'build', 'test'] }));
  const t0 = Date.now();
  const res = await app({ teamWorkspace: p.tw, action: 'start', backlogItemKey: 'BUG-04', matchRoot: p.matchRoot, waitSeconds: 1 });
  assert.equal(res.state, 'waiting_for_checks', JSON.stringify(res)); assert.equal(res.runId, 'r-9');
  assert.ok(Date.now() - t0 >= 900, 'it waited before giving up');
  assert.match(res.hint, /call app start again/);
});

// UOMNKT6Z: BUG-09 chờ full suite quá 600 s mới được start app. Build xong là ghi ngay, app start không chờ bộ test.
test('run_checks records the finished build while the suite still runs, and app start no longer waits for it', async () => {
  const p = project({ build: ok('built'), start: ok('started'), test: 'node -e "setTimeout(() => console.log(\'Tests  1 passed (1)\'), 6000)"' });
  const first = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, checks: ['build', 'test'], waitSeconds: 0 });
  assert.equal(first.state, 'running');
  let rec;
  for (let i = 0; i < 50 && !(rec = readChecks(p.teamWork, 'BUG-05'))?.build; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(rec.state, 'running', 'the suite is still running');
  assert.equal(rec.build?.state, 'passed', JSON.stringify(rec));
  const status = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, waitSeconds: 0 });
  assert.equal(status.build, 'passed'); assert.match(status.hint, /app start now/);
  const t0 = Date.now();
  const res = await app({ teamWorkspace: p.tw, action: 'start', backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, waitSeconds: 1 });
  assert.notEqual(res.state, 'waiting_for_checks', JSON.stringify(res));
  assert.ok(Date.now() - t0 < 5000, 'app start did not wait for the suite');
  await app({ teamWorkspace: p.tw, action: 'stop', backlogItemKey: 'BUG-05' });
  const done = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, waitSeconds: 30 });
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.ok, true);
});

// ME1X0FFX: typecheck chạy cùng lúc next build đọc .next/types đang bị xoá, báo TS6053 giả. typecheck xong rồi mới build.
test('run_checks never runs typecheck while the build runs; the suite still runs alongside', async () => {
  const p = project({ typecheck: 'node mark.js typecheck', build: 'node mark.js build', test: 'node mark.js test' });
  const app = join(p.matchRoot, 'src');
  writeFileSync(join(app, 'mark.js'), "const fs=require('fs');const n=process.argv[2];fs.appendFileSync('marks.log',n+' start '+Date.now()+'\\n');"
    + "setTimeout(()=>fs.appendFileSync('marks.log',n+' end '+Date.now()+'\\n'),700);");
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-02', matchRoot: p.matchRoot });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map(r => r.name), ['typecheck', 'build', 'test']);
  const at = Object.fromEntries(readFileSync(join(app, 'marks.log'), 'utf8').trim().split(/\r?\n/).map(l => { const [n, e, t] = l.split(' '); return [`${n} ${e}`, Number(t)]; }));
  assert.ok(at['build start'] >= at['typecheck end'], JSON.stringify(at));
  assert.ok(at['test start'] < at['build start'], 'the suite does not wait for typecheck and build');
});

// QDYZMY1K: full suite của PI-02/PI-03 timeout 600 s. PI chỉ typecheck khi không chỉ định checks.
test('run_checks of a PI item runs typecheck only unless checks is given', async () => {
  const p = project({ typecheck: ok('types fine'), build: 'node -e "process.exit(1)"', test: 'node -e "process.exit(1)"' });
  localRuntime(p.tw, {});
  const rt = new Runtime({ teamWorkspace: p.tw });
  const res = await rt.runChecks({ backlogItemKey: 'PI-02', matchRoot: p.matchRoot, waitSeconds: 30 });
  assert.deepEqual(res.results.map(r => [r.name, r.state]), [['typecheck', 'passed']]);
  const all = await finished(p, 'BUG-02', await rt.runChecks({ backlogItemKey: 'BUG-02', matchRoot: p.matchRoot, waitSeconds: 30 }));
  assert.deepEqual(all.results.map(r => r.name), ['typecheck', 'build', 'test']);
});

// RATH0OHJ: `yarn test` chạy mọi workspace, riêng web mất 6m08s dù đề nói "The grader runs the loot-core tests".
test('the item naming the package the grader tests narrows the suite to it plus the packages the item changed', () => {
  assert.deepEqual(namedTestPackages('The grader runs the loot-core tests itself. The grader runs the whole test suite.'), ['loot-core']);
  assert.deepEqual(namedTestPackages('the grader runs the tests itself on your submitted revision'), []);
  const p = workspaceProject();
  const profile = detectProfile(p.matchRoot);
  const scope = changed => testScope({ profile, text: GRADER, changed, appPrefix: 'M1/src' });
  assert.deepEqual(scope([]).scope.packages, ['@x/core']);
  assert.deepEqual(scope(['M1/src/packages/core/a.js', 'M1/answers/BUG-05/submit.json', 'M1/README.md']).scope.packages, ['@x/core']);
  assert.equal(scope(['M1/src/packages/web/view.js']).scope, null, 'two packages: the whole suite runs them in parallel');
  assert.deepEqual(scope(['M1/src/packages/docs/intro.js']).scope.packages, ['@x/core'], 'a package without tests adds nothing');
  assert.equal(scope(['M1/src/tsconfig.json']).scope, null, 'a change outside every workspace runs the whole suite');
  assert.equal(testScope({ profile, text: 'The grader runs the whole test suite.', changed: [], appPrefix: 'M1/src' }).scope, null);
  assert.equal(testScope({ profile, text: 'The grader runs the api tests.', changed: [], appPrefix: 'M1/src' }).scope, null, 'no such workspace');
  assert.match(scope([]).scope.command, /^npm test --workspace='@x\/core'$/);
});

test('run_checks runs only the named package and the whole suite when a second package changed or when switched off', async () => {
  const p = workspaceProject();
  const page = join(p.teamWork, 'items', 'BUG-05');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, 'page.json'), JSON.stringify({ title: 'Bug', descriptionMd: GRADER }));
  const log = () => readFileSync(join(p.matchRoot, 'answers', 'BUG-05', 'evidence', 'full-suite.log'), 'utf8');
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, checks: ['test'], waitSeconds: 60 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results[0].scope.packages, ['@x/core']);
  assert.match(log(), /core ran/); assert.doesNotMatch(log(), /web ran|all ran/);
  assert.match(verificationRows(readChecks(p.teamWork, 'BUG-05'))[0].note, /scoped to @x\/core \(the item says the grader runs the core tests\)/);
  writeFileSync(join(p.matchRoot, 'src', 'packages', 'web', 'view.js'), 'export const v = 2;\n');
  const both = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, checks: ['test'], waitSeconds: 60 });
  assert.equal(both.results[0].scope, undefined); assert.match(log(), /all ran/);
  const off = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-05', matchRoot: p.matchRoot, checks: ['test'], waitSeconds: 60, force: true, scopeTests: false });
  assert.equal(off.results[0].scope, undefined); assert.match(log(), /all ran/);
});

// LXRMBRA2 BUG-11: build hỏng ở giây 138, worker chờ bộ test tới giây 425 mới đọc được lỗi.
test('a check that fails while the suite still runs is reported at once with its tail; run after an edit cancels and restarts', async () => {
  const p = project({ build: 'node -e "console.error(\'TS2322: bad type in new test\'); process.exit(2)"',
    test: 'node -e "setTimeout(() => console.log(\'Tests  1 passed (1)\'), 20000)"' });
  sh('git', ['init', '-q'], join(p.tw, 'matches', 'M1'));
  const t0 = Date.now();
  const first = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-06', matchRoot: p.matchRoot, checks: ['build', 'test'], waitSeconds: 60 });
  assert.equal(first.state, 'running', JSON.stringify(first));
  assert.ok(Date.now() - t0 < 15000, 'did not wait for the suite');
  assert.deepEqual(first.failed.map(c => [c.name, c.state]), [['build', 'failed']]);
  assert.match(first.failed[0].tail, /TS2322/); assert.match(first.hint, /build already failed/);
  const same = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-06', matchRoot: p.matchRoot, checks: ['build', 'test'], waitSeconds: 60 });
  assert.equal(same.runId, first.runId, 'unchanged source: the same failing run');
  // Worker sửa lỗi: lần chạy cũ bị huỷ (bộ test 20 s của nó không chạy hết), lần mới chạy trên source đã sửa.
  writeFileSync(join(p.matchRoot, 'src', 'package.json'), JSON.stringify({ name: 'app', packageManager: 'npm@10.0.0',
    scripts: { build: ok('built'), test: ok('Tests  1 passed (1)') } }));
  const t1 = Date.now();
  const second = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-06', matchRoot: p.matchRoot, checks: ['build', 'test'], waitSeconds: 60 });
  assert.equal(second.state, 'done', JSON.stringify(second)); assert.equal(second.ok, true);
  assert.notEqual(second.runId, first.runId);
  assert.ok(Date.now() - t1 < 15000, 'the old suite was cancelled');
  assert.equal(readChecks(p.teamWork, 'BUG-06').runId, second.runId, 'the cancelled run does not overwrite the new record');
});
