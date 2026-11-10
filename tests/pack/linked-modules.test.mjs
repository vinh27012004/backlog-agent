// node_modules liên kết cho worktree (QDYZMY1K: prepare-source cho từng worktree mất 5–13 phút khi 6–7 worktree chạy
// cùng lúc). Repo git thật, node_modules giả: gói ngoài trỏ checkout chính, gói workspace trỏ source của worktree.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLinked, linkNodeModules, unlinkNodeModules } from '../../pack/src/env/linked-modules.mjs';
import { prepareWorktreeEnv } from '../../pack/src/env/environment.mjs';
import { sh, tempDir } from './support.mjs';

const junction = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

// Checkout chính M1/src đã "cài": node_modules có gói ngoài, gói scoped, gói workspace (junction vào packages/core),
// .bin, cache .vite-temp, .yarn-state.yml; packages/core/node_modules/.vite; .yarn/install-state.gz.
function repo() {
  const root = tempDir('mtm-linked-'), checkout = join(root, 'checkout'), app = join(checkout, 'M1', 'src');
  mkdirSync(app, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], checkout);
  sh('git', ['config', 'user.name', 'test'], checkout); sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  write(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, packageManager: 'yarn@4.17.1', workspaces: ['packages/*'], scripts: { test: 'node -e 1' } }));
  write(join(app, 'yarn.lock'), '# lock\n');
  write(join(app, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@ws/core' }));
  write(join(app, 'packages', 'core', 'index.js'), 'module.exports = "main source";\n');
  write(join(checkout, '.gitignore'), 'node_modules/\n.yarn/install-state.gz\n.team-work/\n');
  sh('git', ['add', '.'], checkout); sh('git', ['commit', '-q', '-m', 'seed'], checkout);
  const issued = sh('git', ['rev-parse', 'HEAD'], checkout);
  write(join(app, 'node_modules', 'left-pad', 'index.js'), 'module.exports = "third party";\n');
  write(join(app, 'node_modules', '@scope', 'util', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(app, 'node_modules', '@ws'), { recursive: true });
  junction(join(app, 'packages', 'core'), join(app, 'node_modules', '@ws', 'core'));
  write(join(app, 'node_modules', '.bin', 'tool.cmd'), '@echo tool\n');
  write(join(app, 'node_modules', '.vite-temp', 'cache.json'), '{}');
  write(join(app, 'node_modules', '.yarn-state.yml'), '__metadata:\n');
  write(join(app, 'packages', 'core', 'node_modules', '.vite', 'deps.json'), '{}');
  write(join(app, '.yarn', 'install-state.gz'), 'state');
  return { root, checkout, app, issued };
}

function worktree(r, name = 'BUG-01') {
  const wtRoot = join(r.checkout, '.team-work', 'wt', name);
  mkdirSync(join(r.checkout, '.team-work', 'wt'), { recursive: true });
  sh('git', ['worktree', 'add', '-q', '--detach', wtRoot, 'HEAD'], r.checkout);
  const app = join(wtRoot, 'M1', 'src');
  writeFileSync(join(app, 'packages', 'core', 'index.js'), 'module.exports = "worktree source";\n');
  return { wtRoot, matchRoot: join(wtRoot, 'M1'), app };
}

test('linked node_modules share third-party packages, map workspace packages to the worktree and keep caches local', () => {
  const r = repo(), w = worktree(r);
  const res = linkNodeModules(r.app, w.app);
  assert.equal(res.linked, true, JSON.stringify(res));
  assert.equal(res.workspace, 1);
  assert.equal(realpathSync(join(w.app, 'node_modules', 'left-pad')), realpathSync(join(r.app, 'node_modules', 'left-pad')));
  assert.equal(realpathSync(join(w.app, 'node_modules', '@scope', 'util')), realpathSync(join(r.app, 'node_modules', '@scope', 'util')));
  assert.equal(realpathSync(join(w.app, 'node_modules', '@ws', 'core')), realpathSync(join(w.app, 'packages', 'core')), 'workspace package resolves to the worktree source');
  assert.match(readFileSync(join(w.app, 'node_modules', '@ws', 'core', 'index.js'), 'utf8'), /worktree source/);
  assert.ok(lstatSync(join(w.app, 'node_modules', '.bin')).isSymbolicLink(), '.bin is shared');
  assert.ok(!lstatSync(join(w.app, 'node_modules', '.vite-temp')).isSymbolicLink(), 'caches are local to the worktree');
  assert.deepEqual(readdirSync(join(w.app, 'node_modules', '.vite-temp')), []);
  assert.equal(readFileSync(join(w.app, 'node_modules', '.yarn-state.yml'), 'utf8'), '__metadata:\n');
  assert.ok(existsSync(join(w.app, 'packages', 'core', 'node_modules', '.vite')));
  assert.equal(readFileSync(join(w.app, '.yarn', 'install-state.gz'), 'utf8'), 'state');
  assert.equal(isLinked(w.app), true);

  // Gỡ liên kết rồi git worktree remove: checkout chính còn nguyên (git đi xuyên junction nếu còn).
  assert.equal(unlinkNodeModules(w.app), 2);
  assert.equal(existsSync(join(w.app, 'node_modules')), false);
  sh('git', ['worktree', 'remove', '--force', w.wtRoot], r.checkout);
  assert.match(readFileSync(join(r.app, 'node_modules', 'left-pad', 'index.js'), 'utf8'), /third party/);
  assert.ok(existsSync(join(r.app, 'node_modules', '@scope', 'util', 'index.js')));
  assert.match(readFileSync(join(r.app, 'packages', 'core', 'index.js'), 'utf8'), /main source/);
});

test('worktree setup links when dependency files match the issued revision and installs for real otherwise', async () => {
  const r = repo(), w = worktree(r);
  const job = { progress: [] };
  const logDir = join(r.checkout, '.team-work', 'logs');
  const res = await prepareWorktreeEnv(job, { wtMatchRoot: w.matchRoot, mainMatchRoot: join(r.checkout, 'M1'), key: 'BUG-01', logDir,
    linked: true, issuedRevision: r.issued });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.linkedModules, true);
  assert.ok(res.steps.some(s => s.name === 'link-modules' && s.linked), JSON.stringify(res.steps));
  assert.ok(!res.steps.some(s => ['install', 'prepare_source'].includes(s.name)), 'no install or build when linked');

  // Dependency đổi trong worktree: không liên kết (junction cũ được gỡ trước khi cài thật).
  writeFileSync(join(w.app, 'yarn.lock'), '# lock changed\n');
  const blocked = await prepareWorktreeEnv({ progress: [] }, { wtMatchRoot: w.matchRoot, mainMatchRoot: join(r.checkout, 'M1'), key: 'BUG-01', logDir,
    linked: true, issuedRevision: r.issued }).catch(e => ({ error: e }));
  const step = blocked.steps?.find(s => s.name === 'link-modules');
  assert.equal(step?.linked, false, JSON.stringify(blocked));
  assert.match(step.reason, /dependency files changed: .*yarn\.lock/);
  assert.equal(isLinked(w.app), false, 'the old links were removed before a real install');
  assert.ok(existsSync(join(r.app, 'node_modules', 'left-pad', 'index.js')), 'main checkout untouched');
});
