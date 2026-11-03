// Publish nhiều item (Practice FMC0ZXFC: publish nối tiếp, CR-03 hết giờ trước khi tới lượt): một lần push mang mọi item
// đã integrate; commit_and_push của item đã lên remote cùng lần push trước chỉ ghi revision. Remote đổi mà rebase sạch
// thì push tiếp.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { localRuntime, sh, tempDir } from './support.mjs';

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
  localRuntime(root, {});
  const rt = new Runtime({ teamWorkspace: root });
  rt.session.paths = { teamWork, checkoutRoot: checkout, matchRoot: join(checkout, 'M1') };
  rt.session.descriptor = { matchId: 'M1', repository: { branch: 'main' } };
  rt.session.phase = 'GAME';
  rt.journalObj = new Journal(teamWork);
  rt.writer = { state: { backlogs: {} } };
  // Một item đã integrate: commit code + answers/<ID>/ trên main.
  const integrate = (key, file) => {
    mkdirSync(join(checkout, 'M1', 'answers', key), { recursive: true });
    writeFileSync(join(checkout, 'M1', 'answers', key, 'submit.json'), JSON.stringify({ status: 'DONE' }));
    writeFileSync(join(checkout, 'M1', 'src', file), `module.exports = "${key}";\n`);
    sh('git', ['add', '-A'], checkout, env);
    sh('git', ['commit', '-q', '-m', `${key}: work`], checkout, env);
    const ji = rt.journalObj.item(key);
    ji.startedAt = new Date().toISOString();
    ji.integratedRevision = sh('git', ['rev-parse', 'HEAD'], checkout, env);
  };
  return { rt, checkout, bare, integrate };
}

test('one push carries every integrated item; the second push records the revision already on the remote', async () => {
  const { rt, checkout, bare, integrate } = setup();
  integrate('CR-02', 'aging.js');
  integrate('CR-03', 'links.js');
  const first = await rt.commitAndPush({ backlogItemKey: 'CR-02', message: 'aging' });
  const head = sh('git', ['rev-parse', 'HEAD'], checkout, env);
  assert.equal(first.revision, head, 'pushes main, which holds both items');
  assert.equal(first.alreadyOnRemote, undefined);
  const second = await rt.commitAndPush({ backlogItemKey: 'CR-03', message: 'links' });
  assert.equal(second.revision, head);
  assert.equal(second.alreadyOnRemote, true);
  assert.equal(sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], checkout, env), head);
  assert.equal(rt.journalObj.item('CR-03').publishedRevision, head);
});

test('a remote that moved is rebased onto and the push goes on when the rebase is clean', async () => {
  const { rt, checkout, bare, integrate } = setup(); integrate('BUG-01', 'fix.js'); const ji = rt.journalObj.item('BUG-01');
  const peer = join(checkout, '..', 'peer'); sh('git', ['clone', '-q', bare, peer], checkout, env);
  writeFileSync(join(peer, 'M1', 'src', 'remote.js'), 'invalid JavaScript !!!\n'); sh('git', ['add', '-A'], peer, env); sh('git', ['commit', '-q', '-m', 'remote'], peer, env); sh('git', ['push', '-q', 'origin', 'HEAD:main'], peer, env);
  const remote = sh('git', ['rev-parse', 'HEAD'], peer, env);
  const pushed = await rt.commitAndPush({ backlogItemKey: 'BUG-01', message: 'fix' });
  assert.equal(sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], checkout, env), pushed.revision);
  assert.equal(sh('git', ['rev-parse', `${pushed.revision}~1`], checkout, env), remote, 'the item commit sits on top of the remote one');
  assert.equal(ji.publishedRevision, pushed.revision);
});
