// Tool run_checks (9O802QWE: fixer tự nối typecheck → build → test trong shell rồi tốn 4–10 lượt model chờ và đọc log).
// Project node nhỏ, script chỉ là lệnh node: chạy thật qua pwsh/npm như trong trận, không mạng.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { baselineRerunFiles, cancelChecks, readChecks, readTestRuns, runChecks, typecheckGraded, typeErrorFiles, verificationRows } from '../../pack/src/env/checks.mjs';
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
  const res = await app({ teamWorkspace: p.tw, action: 'start', backlogItemKey: 'BUG-04', matchRoot: p.matchRoot, waitSeconds: 0 });
  assert.equal(res.state, 'waiting_for_checks', JSON.stringify(res)); assert.equal(res.runId, 'r-9');
  assert.match(res.hint, /call app start again with waitSeconds 110/);
  // QXUD1QAI CR-07: chờ dương nào cũng chờ tới 110 s và đi tiếp ngay khi build của run_checks xong.
  setTimeout(() => writeFileSync(file, JSON.stringify({ runId: 'r-9', state: 'running', pid: process.pid, checks: ['typecheck', 'build', 'test'],
    build: { state: 'passed' } })), 1500);
  const t0 = Date.now();
  const started = await app({ teamWorkspace: p.tw, action: 'start', backlogItemKey: 'BUG-04', matchRoot: p.matchRoot, waitSeconds: 1 });
  assert.notEqual(started.state, 'waiting_for_checks', JSON.stringify(started));
  assert.ok(Date.now() - t0 >= 1400 && Date.now() - t0 < 60_000, `went on once the build was recorded (${Date.now() - t0} ms)`);
  await app({ teamWorkspace: p.tw, action: 'stop', backlogItemKey: 'BUG-04' });
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
function marked(nextjs) {
  const p = project({ typecheck: 'node mark.js typecheck', build: 'node mark.js build', test: 'node mark.js test' });
  const app = join(p.matchRoot, 'src');
  writeFileSync(join(app, 'mark.js'), "const fs=require('fs');const n=process.argv[2];fs.appendFileSync('marks.log',n+' start '+Date.now()+'\\n');"
    + "setTimeout(()=>fs.appendFileSync('marks.log',n+' end '+Date.now()+'\\n'),700);");
  if (nextjs) writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ include: ['next-env.d.ts', '**/*.ts', '.next/types/**/*.ts'] }));
  const marks = () => Object.fromEntries(readFileSync(join(app, 'marks.log'), 'utf8').trim().split(/\r?\n/).map(l => { const [n, e, t] = l.split(' '); return [`${n} ${e}`, Number(t)]; }));
  return { p, marks };
}

test('run_checks of a Next.js project never runs typecheck while the build runs; the suite still runs alongside', async () => {
  const { p, marks } = marked(true);
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-02', matchRoot: p.matchRoot });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map(r => r.name), ['typecheck', 'build', 'test']);
  const at = marks();
  assert.ok(at['build start'] >= at['typecheck end'], JSON.stringify(at));
  assert.ok(at['test start'] < at['build start'], 'the suite does not wait for typecheck and build');
});

// QXUD1QAI CR-07: typecheck 113 s rồi mới build 78 s, app start chờ build; app lên muộn, không kịp chụp trang.
test('run_checks of other projects runs typecheck, build and the suite at once', async () => {
  const { p, marks } = marked(false);
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-02', matchRoot: p.matchRoot });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map(r => r.name), ['typecheck', 'build', 'test']);
  const at = marks();
  assert.ok(at['build start'] < at['typecheck end'], `build does not wait for typecheck: ${JSON.stringify(at)}`);
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

// QXUD1QAI CR-07: 3 lỗi strict trong test mới; worker sửa và chạy lại check, build làm lại, trang không kịp chụp (−19).
// Grader của đề đó không chạy type check.
function typecheckProject(text) {
  const p = project({ typecheck: 'node -e "console.log(\'src/replay.test.ts(49,87): error TS7006: Parameter c implicitly has an any type.\'); process.exit(2)"',
    test: ok('Tests  1 passed (1)') });
  const checkout = join(p.tw, 'matches', 'M1');
  sh('git', ['init', '-q'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'issued'], checkout);
  writeFileSync(join(p.matchRoot, 'src', 'replay.test.ts'), 'it("replays", () => {});\n');
  mkdirSync(join(p.teamWork, 'items', 'CR-07'), { recursive: true });
  writeFileSync(join(p.teamWork, 'items', 'CR-07', 'page.json'), JSON.stringify({ title: 'CR', descriptionMd: text }));
  return p;
}

test('type errors only in the item\'s new tests do not block when the item does not grade the type check', async () => {
  assert.deepEqual(typeErrorFiles('src/a.test.ts(1,2): error TS7006: x\nlib/b.ts:3:4 - error TS2322: y'), ['src/a.test.ts', 'lib/b.ts']);
  assert.equal(typecheckGraded('The grader runs the whole test suite and the type check itself.'), true);
  assert.equal(typecheckGraded('The grader runs the loot-core tests itself.'), false);
  const p = typecheckProject('The grader runs the loot-core tests itself on your submitted revision.');
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-07', matchRoot: p.matchRoot, checks: ['typecheck', 'test'], waitSeconds: 60 });
  assert.equal(res.state, 'done', JSON.stringify(res));
  assert.equal(res.ok, true, 'nothing blocking');
  assert.deepEqual(res.advisory, ['typecheck']);
  assert.deepEqual(res.results[0].advisory.files, ['src/replay.test.ts']);
  assert.match(res.hint, /cost no points\. Capture your evidence first and do not rerun run_checks/);
  assert.match(verificationRows(readChecks(p.teamWork, 'CR-07'))[0].note, /not graded: type errors only in the item's own new test files/);
});

test('type errors block when the item grades the type check', async () => {
  const p = typecheckProject('The grader runs the whole test suite and the type check itself on your submitted revision.');
  const res = await finished(p, 'CR-07', await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-07', matchRoot: p.matchRoot, checks: ['typecheck', 'test'], waitSeconds: 60 }));
  assert.equal(res.ok, false);
  assert.equal(res.advisory, undefined);
  assert.match(res.hint, /Failed: typecheck/);
});

// BI7A5ACV CR-08: run_checks do ready_for_evidence khởi động ghi build.log, typecheck.log vào evidence tới 13:40:01, sau
// handoff 13:37:17; cây answer đổi, 5 lần publish CANDIDATE_STALE. Handoff và preflight huỷ lần chạy còn dở.
test('cancelChecks asks the running run to stop and waits for it; nothing running is a no-op', async () => {
  const teamWork = tempDir('mtm-cancel-');
  mkdirSync(join(teamWork, 'items', 'CR-08'), { recursive: true });
  const file = join(teamWork, 'items', 'CR-08', 'checks.json');
  assert.equal(await cancelChecks(teamWork, 'CR-08', 100), null, 'no checks.json');
  writeFileSync(file, JSON.stringify({ runId: 'r-1', state: 'done', pid: process.pid }));
  assert.equal(await cancelChecks(teamWork, 'CR-08', 100), null, 'finished run');
  writeFileSync(file, JSON.stringify({ runId: 'r-2', state: 'running', pid: process.pid }));
  // Tiến trình đang chạy lần đó thấy file huỷ thì ghi cancelled.
  const watcher = setInterval(() => {
    const cancel = join(teamWork, 'items', 'CR-08', 'checks.cancel');
    if (existsSync(cancel) && readFileSync(cancel, 'utf8').trim() === 'r-2') writeFileSync(file, JSON.stringify({ runId: 'r-2', state: 'cancelled', pid: process.pid }));
  }, 50);
  const t0 = Date.now();
  assert.equal(await cancelChecks(teamWork, 'CR-08', 5000), 'r-2');
  clearInterval(watcher);
  assert.ok(Date.now() - t0 < 2000, 'returns once the run stopped');
  assert.equal(readChecks(teamWork, 'CR-08').state, 'cancelled');
});

// DVVFEPXF PI-03: worker tự chạy mutants (3 chỗ sửa), lệnh chặn 121 s ngay trước return_by.
test('a PI never runs the mutation check: run_checks answers at once', async () => {
  const tw = tempDir('mtm-pi-mutants-');
  const t0 = Date.now();
  const res = await runChecks({ teamWorkspace: tw, backlogItemKey: 'PI-03', matchRoot: join(tw, 'matches', 'M1', 'M1'), action: 'mutants', waitSeconds: 110 });
  assert.deepEqual([res.state, res.skipped], ['skipped', 'PI']);
  assert.match(res.hint, /not run for a PI/);
  assert.ok(Date.now() - t0 < 2000, 'no wait');
});

// WQ7T6CEC BUG-09: sau khi bản sửa baseline vào worktree, chạy lại cả bộ test chờ 574 s dù chỉ vài file đổi.
// testFiles chạy đúng các file đó bằng test_one của profile. Project yarn với release giả trong .yarn/releases: nó vừa là
// `yarn test` (mọi file *.test.cjs) vừa là `yarn exec vitest run …` (chỉ các file được truyền, ghi báo cáo JSON).
const FAKE_YARN = String.raw`const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.name === '.yarn' || e.name === 'node_modules' ? []
  : e.isDirectory() ? walk(path.join(d, e.name)) : /\.test\.cjs$/.test(e.name) ? [path.relative('.', path.join(d, e.name)).split(path.sep).join('/')] : []));
const unq = s => s.replace(/^'|'$/g, '');
let files, out = null;
if (args[0] === 'test') files = walk('.');
else {
  const rest = args.slice(3);
  out = rest.find(a => a.startsWith('--outputFile.json='));
  out = out && unq(out.split('=').slice(1).join('='));
  files = rest.filter(a => !a.startsWith('--')).map(unq);
}
const results = files.map(f => { try { require(path.resolve(f)); return [f, 'passed']; } catch { return [f, 'failed']; } });
for (const [f, s] of results) console.log((s === 'passed' ? 'ok ' : 'FAIL ') + f);
const failed = results.filter(r => r[1] === 'failed').length;
console.log('Tests  ' + (results.length - failed) + ' passed | ' + failed + ' failed (' + results.length + ')');
if (out) fs.writeFileSync(out, JSON.stringify({ testResults: results.map(([f, s]) => ({ name: path.resolve(f), status: s,
  assertionResults: [{ ancestorTitles: ['suite'], title: 'case', status: s }] })) }));
process.exit(failed ? 1 : 0);
`;
function selectedProject() {
  const tw = tempDir('mtm-selected-'), checkout = join(tw, 'matches', 'M1'), matchRoot = join(checkout, 'M1'), app = join(matchRoot, 'src');
  mkdirSync(join(app, '.yarn', 'releases'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, packageManager: 'yarn@4.0.0',
    workspaces: ['packages/*'], scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } }));
  writeFileSync(join(app, '.yarn', 'releases', 'yarn-4.0.0.cjs'), FAKE_YARN);
  const pkg = join(app, 'packages', 'core');
  mkdirSync(join(pkg, 'src', 'import'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@x/core', version: '1.0.0', scripts: { test: 'vitest run' } }));
  writeFileSync(join(pkg, 'src', 'import', 'parse.test.cjs'), 'module.exports = 0;\n');
  writeFileSync(join(pkg, 'src', 'slow.test.cjs'), 'module.exports = 1;\n');
  writeFileSync(join(app, 'own.test.cjs'), 'module.exports = 2;\n');
  sh('git', ['init', '-q'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'issued'], checkout);
  return { tw, checkout, matchRoot, app, teamWork: join(checkout, '.team-work') };
}

test('baselineRerunFiles finds the baseline failures in their workspace and adds the item\'s own new tests', () => {
  const p = selectedProject();
  const ids = ['handles windows-1252 charset', 'src/import/parse.test.cjs > suite > handles windows-1252 charset'];
  assert.deepEqual(baselineRerunFiles(p.matchRoot, ids, [join(p.app, 'own.test.cjs'), join(p.tw, 'elsewhere.test.cjs')]),
    ['packages/core/src/import/parse.test.cjs', 'own.test.cjs']);
  assert.equal(baselineRerunFiles(p.matchRoot, ['handles windows-1252 charset']), null, 'no id names a file');
  assert.equal(baselineRerunFiles(p.matchRoot, ['src/missing.test.cjs > x']), null, 'a file nowhere to be found');
  assert.equal(baselineRerunFiles(p.matchRoot, ['../out.test.cjs > x']), null);
});

test('run_checks with testFiles runs only those files, records the partial run and never passes for the full suite', async () => {
  const p = selectedProject();
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot,
    testFiles: ['packages/core/src/import/parse.test.cjs', './own.test.cjs'] });
  assert.equal(res.state, 'done', JSON.stringify(res)); assert.equal(res.ok, true);
  assert.deepEqual(res.results.map(r => [r.name, r.state, r.log]), [['test', 'passed', 'evidence/selected-tests.log']]);
  assert.deepEqual(res.results[0].testFiles, ['packages/core/src/import/parse.test.cjs', 'own.test.cjs']);
  assert.deepEqual(res.results[0].counts, { total: 2, passed: 2, failed: 0, skipped: 0 });
  const log = readFileSync(join(p.matchRoot, 'answers', 'BUG-09', 'evidence', 'selected-tests.log'), 'utf8');
  assert.match(log, /ok packages\/core\/src\/import\/parse\.test\.cjs/);
  assert.doesNotMatch(log, /slow\.test/, 'a file not listed does not run');
  const record = readChecks(p.teamWork, 'BUG-09');
  assert.deepEqual(record.testFiles, ['packages/core/src/import/parse.test.cjs', 'own.test.cjs']);
  const [row] = verificationRows(record);
  assert.equal(row.check, 'tests (selected files only, not the full suite)');
  assert.match(row.note, /not the full suite: ran only packages\/core\/src\/import\/parse\.test\.cjs, own\.test\.cjs/);
  assert.match(row.command, /exec vitest run 'packages\/core\/src\/import\/parse\.test\.cjs' 'own\.test\.cjs'$/);
  // Cùng source: lần chạy vài file không thay được cả bộ; cả bộ chạy thật và thay được lần chạy vài file sau đó.
  const again = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, testFiles: ['own.test.cjs', 'packages/core/src/import/parse.test.cjs'] });
  assert.equal(again.cached, true);
  const full = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, checks: ['test'] });
  assert.equal(full.cached, undefined, JSON.stringify(full));
  assert.equal(full.results[0].testFiles, undefined);
  assert.equal(full.results[0].counts.total, 3);
  assert.equal(verificationRows(readChecks(p.teamWork, 'BUG-09'))[0].check, 'full test suite');
  const partial = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, testFiles: ['own.test.cjs'] });
  assert.equal(partial.cached, true, 'the full run already covers it');
  // BQCK4MQX CR-07: checks.json giữ lần chạy cuối; lịch sử bước test theo source còn lại cho cổng test mới ở candidate.
  const runs = readTestRuns(p.teamWork, 'BUG-09');
  assert.deepEqual(runs.map(r => [r.state, r.testFiles]), [['passed', ['packages/core/src/import/parse.test.cjs', 'own.test.cjs']], ['passed', null]]);
  assert.equal(runs[1].source, readChecks(p.teamWork, 'BUG-09').snapshot.source);
  await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, checks: ['typecheck'] });
  assert.equal(readTestRuns(p.teamWork, 'BUG-09').length, 2, 'a typecheck-only run keeps the test history');
});

test('run_checks refuses testFiles that are absolute, leave the app, look like flags or do not exist', async () => {
  const p = selectedProject();
  const call = testFiles => runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, testFiles });
  for (const bad of [[join(p.app, 'own.test.cjs')], ['../M1/src/own.test.cjs'], ['--config=evil.js'], ['missing.test.cjs'], [], ['a;b.test.cjs']]) {
    await assert.rejects(call(bad), /INVALID_ARGUMENT/, JSON.stringify(bad));
  }
  await assert.rejects(runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot, checks: ['typecheck'], testFiles: ['own.test.cjs'] }), /needs the test check/);
});
