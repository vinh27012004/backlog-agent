// Tool run_checks (9O802QWE: fixer tự nối typecheck → build → test trong shell rồi tốn 4–10 lượt model chờ và đọc log).
// Project node nhỏ, script chỉ là lệnh node: chạy thật qua pwsh/npm như trong trận, không mạng.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChecks, runChecks, verificationRows } from '../../pack/src/env/checks.mjs';
import { app } from '../../pack/src/env/app.mjs';
import { sh, tempDir } from './support.mjs';

function project(scripts) {
  const tw = tempDir('mtm-checks-'), matchRoot = join(tw, 'matches', 'M1', 'M1'), app = join(matchRoot, 'src');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'npm@10.0.0', scripts }));
  return { tw, matchRoot, teamWork: join(tw, 'matches', 'M1', '.team-work') };
}
const ok = text => `node -e "console.log('${text}')"`;

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
  const res = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'CR-01', matchRoot: p.matchRoot, parallel: false });
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
  const done = await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'BUG-02', matchRoot: p.matchRoot, waitSeconds: 30 });
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
  assert.match(res.hint, /run_checks {action: "status"/);
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
