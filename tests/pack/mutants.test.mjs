// run_checks {action: "mutants"} (EXP3I47A TASK-08: test mới không đỏ khi bỏ chỗ sửa `reportedPayee`, grader cài lại
// đúng lỗi đó và case vẫn xanh, -4). Runner giả: node_modules/vitest/vitest.mjs import từng file test, test ném lỗi
// khi sai; chạy thật như trong trận, không mạng.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseHunks, readMutants, restorePending, revertHunk, runMutants } from '../../pack/src/env/mutants.mjs';
import { runChecks } from '../../pack/src/env/checks.mjs';
import { sh, tempDir } from './support.mjs';

test('parseHunks reads a -U0 diff and revertHunk puts the old lines back, keeping CRLF', () => {
  const diff = [
    'diff --git a/M1/src/lib.js b/M1/src/lib.js', '--- a/M1/src/lib.js', '+++ b/M1/src/lib.js',
    '@@ -2 +2 @@', '-  return d < w;', '+  return d <= w;',
    '@@ -5,0 +6,2 @@', '+const extra = 1;', '+const more = 2;',
    '@@ -9,2 +11,0 @@', '-old1', '-old2',
    'diff --git a/M1/src/new.js b/M1/src/new.js', '--- /dev/null', '+++ b/M1/src/new.js', '@@ -0,0 +1 @@', '+x'].join('\n');
  const hunks = parseHunks(diff);
  assert.deepEqual(hunks.map(h => [h.file, h.oldStart, h.oldCount, h.newStart, h.newCount]),
    [['M1/src/lib.js', 2, 1, 2, 1], ['M1/src/lib.js', 5, 0, 6, 2], ['M1/src/lib.js', 9, 2, 11, 0], ['M1/src/new.js', 0, 0, 1, 1]]);
  const text = 'a\r\n  return d <= w;\r\nc\r\n';
  assert.equal(revertHunk(text, hunks[0]), 'a\r\n  return d < w;\r\nc\r\n');
  assert.equal(revertHunk('a\nchanged\nc\n', hunks[0]), null, 'a file that no longer matches the diff is left alone');
  const added = '1\n2\n3\n4\n5\nconst extra = 1;\nconst more = 2;\n8\n';
  assert.equal(revertHunk(added, hunks[1]), '1\n2\n3\n4\n5\n8\n');
  const removed = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  assert.equal(revertHunk(removed, hunks[2]), removed.replace('L11\n', 'L11\nold1\nold2\n'));
});

// Project node: lib.js có hai chỗ sửa, test mới chỉ kiểm chỗ thứ nhất.
function project() {
  const tw = tempDir('mtm-mutants-'), checkout = join(tw, 'matches', 'M1'), matchRoot = join(checkout, 'M1'), app = join(matchRoot, 'src');
  mkdirSync(join(app, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, packageManager: 'npm@10.0.0', type: 'module',
    scripts: { test: 'vitest --run' }, devDependencies: { vitest: '1.0.0' } }));
  writeFileSync(join(app, '.gitignore'), 'node_modules\n');
  writeFileSync(join(app, 'node_modules', 'vitest', 'vitest.mjs'),
    "import { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\n"
    + "for (const f of process.argv.slice(3)) await import(pathToFileURL(resolve(f)).href);\nconsole.log('passed');\n");
  writeFileSync(join(app, 'lib.js'), 'export const inside = (d, w) => d < w;\nexport const label = x => x;\n');
  sh('git', ['init', '-q'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], checkout);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'issued'], checkout);
  // Bản sửa của item (chưa commit) và test mới của nó.
  writeFileSync(join(app, 'lib.js'), 'export const inside = (d, w) => d <= w;\nexport const label = x => String(x).trim();\n');
  writeFileSync(join(app, 'lib.test.js'), "import { inside } from './lib.js';\nif (inside(7, 7) !== true) throw new Error('day 7 is inside');\n");
  return { tw, checkout, matchRoot, app, teamWork: join(checkout, '.team-work') };
}
async function done(p, res) {
  for (let i = 0; i < 200 && res.state === 'running'; i++) {
    await new Promise(r => setTimeout(r, 200));
    res = await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot, waitSeconds: 0 });
  }
  return res;
}

test('mutants undoes each product change in turn, lists the one no new test catches and restores every file', async () => {
  const p = project();
  const before = readFileSync(join(p.app, 'lib.js'), 'utf8');
  const res = await done(p, await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot }));
  assert.equal(res.state, 'done', JSON.stringify(res));
  assert.equal(res.hunks, 2);
  assert.equal(res.caught, 1);
  assert.deepEqual(res.survived.map(s => [s.file, s.line]), [['src/lib.js', 2]]);
  assert.match(res.hint, /survived/);
  assert.equal(readFileSync(join(p.app, 'lib.js'), 'utf8'), before, 'the product file is back as the item wrote it');
  assert.match(readFileSync(join(p.matchRoot, 'answers', 'TASK-08', 'evidence', 'mutants.log'), 'utf8'), /survived +src\/lib\.js:2/);
  assert.ok(readMutants(p.teamWork, 'TASK-08').source, 'the record names the source it ran on');
  const again = await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot });
  assert.equal(again.cached, true, 'unchanged source returns the last run');

  // Thêm case cho chỗ sửa thứ hai: không còn chỗ nào sống sót.
  writeFileSync(join(p.app, 'lib.test.js'), "import { inside, label } from './lib.js';\nif (inside(7, 7) !== true) throw new Error('day 7');\nif (label(' a ') !== 'a') throw new Error('trim');\n");
  const fixed = await done(p, await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot }));
  assert.equal(fixed.caught, 2);
  assert.deepEqual(fixed.survived, []);
});

test('mutants reports nothing to check without a change to existing code, and refuses when the new tests are red', async () => {
  const p = project();
  writeFileSync(join(p.app, 'lib.js'), 'export const inside = (d, w) => d < w;\nexport const label = x => x;\n');
  const none = await done(p, await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot }));
  assert.match(none.skipped, /no change to an existing code file/);
  writeFileSync(join(p.app, 'lib.js'), 'export const inside = (d, w) => d > w + 100;\nexport const label = x => x;\n');
  const red = await done(p, await runMutants({ teamWorkspace: p.tw, backlogItemKey: 'TASK-08', matchRoot: p.matchRoot, force: true }));
  assert.ok(red.baseline, JSON.stringify(red));
  assert.match(red.hint, /do not pass on your own source/);
});

test('a mutant left behind by a dead helper is restored before run_checks does anything', async () => {
  const p = project();
  const target = join(p.app, 'lib.js'), copy = join(p.teamWork, 'scratch', 'original');
  mkdirSync(join(p.teamWork, 'items', 'TASK-08'), { recursive: true }); mkdirSync(join(p.teamWork, 'scratch'), { recursive: true });
  const good = readFileSync(target, 'utf8');
  writeFileSync(copy, good);
  writeFileSync(target, 'mutated\n');
  writeFileSync(join(p.teamWork, 'items', 'TASK-08', 'mutants.restore.json'), JSON.stringify({ pid: 999999, target, copy }));
  await runChecks({ teamWorkspace: p.tw, action: 'status', backlogItemKey: 'TASK-08', matchRoot: p.matchRoot });
  assert.equal(readFileSync(target, 'utf8'), good);
  assert.equal(existsSync(join(p.teamWork, 'items', 'TASK-08', 'mutants.restore.json')), false);
  assert.equal(restorePending(p.teamWork, 'TASK-08'), null);
});
