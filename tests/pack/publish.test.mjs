// Publish nhiều item với một gate main (Practice FMC0ZXFC: publish nối tiếp, mỗi item một gate main 45–75 s, CR-03 đã
// qua review mà hết giờ trước khi tới lượt). Gate main của item cuối phủ các item đã integrate mà chưa push;
// commit_and_push của item đã lên remote cùng lần push trước chỉ ghi revision.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentTree } from '../../pack/src/core/git.mjs';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { sh, tempDir } from './support.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

function setup() {
  const root = tempDir('mtm-publish-');
  const bare = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare], root, env);
  sh('git', ['clone', '-q', bare, checkout], root, env);
  mkdirSync(join(checkout, 'M1', 'src'), { recursive: true });
  writeFileSync(join(checkout, 'M1', 'src', 'lib.js'), 'module.exports = 1;\n');
  sh('git', ['add', '-A'], checkout, env);
  sh('git', ['commit', '-q', '-m', 'seed'], checkout, env);
  sh('git', ['push', '-q', 'origin', 'HEAD:main'], checkout, env);
  const teamWork = join(root, '.team-work');
  mkdirSync(teamWork, { recursive: true });
  const rt = new Runtime({ teamWorkspace: root });
  rt.session.paths = { teamWork, checkoutRoot: checkout, matchRoot: join(checkout, 'M1') };
  rt.session.descriptor = { matchId: 'M1', repository: { branch: 'main' } };
  rt.session.phase = 'GAME';
  rt.journalObj = new Journal(teamWork);
  rt.writer = { state: { backlogs: {} } };
  // Một item đã integrate: commit code + answers/<ID>/ trên main, worktree gate đã pass.
  const integrate = (key, file) => {
    mkdirSync(join(checkout, 'M1', 'answers', key), { recursive: true });
    writeFileSync(join(checkout, 'M1', 'answers', key, 'submit.json'), JSON.stringify({ status: 'DONE' }));
    writeFileSync(join(checkout, 'M1', 'src', file), `module.exports = "${key}";\n`);
    sh('git', ['add', '-A'], checkout, env);
    sh('git', ['commit', '-q', '-m', `${key}: work`], checkout, env);
    const ji = rt.journalObj.item(key);
    ji.startedAt = new Date().toISOString();
    ji.integratedRevision = sh('git', ['rev-parse', 'HEAD'], checkout, env);
    ji.lastGate = { jobId: `job-wt-${key}`, where: 'worktree', passed: true, tree: 'worktree-tree' };
  };
  return { rt, checkout, bare, integrate };
}

test('one main gate covers every integrated item; the second push records the revision already on the remote', async () => {
  const { rt, checkout, bare, integrate } = setup();
  integrate('CR-02', 'aging.js');
  integrate('CR-03', 'links.js');
  // Gate main chạy cho CR-03 (item cuối) và pass: ghi tree của nó, phủ CR-02.
  rt.journalObj.item('CR-03').lastGate = { jobId: 'job-main', where: 'main', passed: true,
    tree: await contentTree(checkout, 'M1', ['M1/answers/CR-03']) };
  assert.deepEqual(await rt.coverIntegrated('CR-03', 'job-main'), ['CR-02']);
  assert.equal(rt.journalObj.item('CR-02').lastGate.coveredBy, 'CR-03');

  const first = await rt.commitAndPush({ backlogItemKey: 'CR-02', message: 'aging' });
  const head = sh('git', ['rev-parse', 'HEAD'], checkout, env);
  assert.equal(first.revision, head, 'pushes main, which holds both items');
  assert.equal(first.alreadyOnRemote, undefined);
  const second = await rt.commitAndPush({ backlogItemKey: 'CR-03', message: 'links' });
  assert.equal(second.revision, head);
  assert.equal(second.alreadyOnRemote, true);
  assert.equal(sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], checkout, env), head);
  assert.equal(rt.journalObj.item('CR-03').publishedRevision, head);

  // Đã push rồi thì không còn gì để phủ; item chưa integrate thì không bao giờ được phủ.
  assert.deepEqual(await rt.coverIntegrated('CR-03', 'job-main-2'), []);
});

test('without a covering gate the second item still needs its own main gate', async () => {
  const { rt, integrate } = setup();
  integrate('BUG-01', 'layout.js');
  integrate('BUG-04', 'position.js');
  await assert.rejects(rt.commitAndPush({ backlogItemKey: 'BUG-01', message: 'layout' }), /GATE_STALE/);
});

// FMC0ZXFC: BUG-02 sửa đúng file của BUG-03 trên main; gate của BUG-03 phải chỉ ra điều đó.
test('a worktree gate names the files main changed after the worktree was created, with the commits', async () => {
  const { rt, checkout, integrate } = setup();
  const base = sh('git', ['rev-parse', 'HEAD'], checkout, env);
  integrate('BUG-02', 'invoice-status.js');
  const overlap = await rt.mainOverlap(base, ['M1/src/invoice-status.js', 'M1/src/untouched.js']);
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].file, 'M1/src/invoice-status.js');
  assert.match(overlap[0].commits[0], /^[0-9a-f]{7,} BUG-02: work$/);
  assert.deepEqual(await rt.mainOverlap(null, ['M1/src/invoice-status.js']), []);
});
