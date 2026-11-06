// Chạy install/build thật bằng package manager fixture, kiểm tra proof và cache tải dùng chung.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectProfile, prepareWorktreeEnv, setupEnvironment } from '../../pack/src/env/environment.mjs';
import { packageCache } from '../../pack/src/env/setup-cache.mjs';
import { sh, tempDir } from './support.mjs';

function fixture(tw = tempDir('mtm-setup-cache-'), key = 'main', organizer = false) {
  const matchRoot = join(tw, key, 'M1'), root = join(matchRoot, 'src');
  const logDir = join(tw, 'logs'), trace = join(tw, `${key}-trace.jsonl`), cacheDir = join(tw, 'package-cache');
  mkdirSync(join(root, '.yarn', 'releases'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.yarn/cache/\nbuild/\n.env\n');
  writeFileSync(join(root, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.17.1.cjs\nenableGlobalCache: false\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.17.1',
    devDependencies: { vitest: '1' }, scripts: { build: 'build', test: 'test' } }));
  writeFileSync(join(root, 'yarn.lock'), '# fixture lock\n');
  writeFileSync(join(root, 'app.js'), 'module.exports = 1;\n');
  writeFileSync(join(root, '.yarn', 'releases', 'yarn-4.17.1.cjs'), `
const fs = require('fs'), path = require('path');
const trace = ${JSON.stringify(trace)};
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(trace, JSON.stringify(value) + '\\n');
log(args);
if (args[0] === 'install') {
  if (fs.existsSync('fail-install')) { console.error('fixture install failure'); process.exit(8); }
  const archive = path.join(process.env.YARN_GLOBAL_FOLDER || process.env.YARN_CACHE_FOLDER, 'package.zip');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (fs.existsSync(archive)) {
    if (fs.readFileSync(archive, 'utf8') !== 'valid') { console.error('cache checksum mismatch'); process.exit(9); }
    log(['cache-hit']);
  } else { fs.writeFileSync(archive, 'valid'); log(['download']); }
  const pkg = JSON.parse(fs.readFileSync('package.json'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const dir = path.join('node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
}
if (args.join(' ') === 'run build') {
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync('build/index.html', fs.readFileSync('app.js'));
}
if (args[0] === 'test') console.log('Tests  1 passed (1)');
`);
  sh('git', ['init', '-q'], matchRoot);
  if (organizer) {
    mkdirSync(join(matchRoot, 'env-require'));
    writeFileSync(join(matchRoot, 'env-require', 'prepare-source.ps1'), `
Push-Location (Join-Path $PSScriptRoot '../src')
try {
  node .yarn/releases/yarn-4.17.1.cjs install --immutable
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  node .yarn/releases/yarn-4.17.1.cjs run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
`);
  }
  return { tw, matchRoot, root, trace, logDir, cacheDir };
}
const entries = f => existsSync(f.trace) ? readFileSync(f.trace, 'utf8').trim().split(/\r?\n/).map(JSON.parse) : [];
const count = (f, name) => entries(f).filter(a => a[0] === name).length;
const options = (f, main = f) => ({ wtMatchRoot: f.matchRoot, mainMatchRoot: main.matchRoot, key: 'BUG-09', logDir: f.logDir, cacheDir: f.cacheDir });
const prepare = (f, main) => prepareWorktreeEnv({ progress: [] }, options(f, main));

test('worktrees share downloaded packages while keeping independent node_modules', async () => {
  const main = fixture(), wt = fixture(main.tw, 'BUG-09');
  const a = await prepare(main), b = await prepare(wt, main);
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.packageCache, b.packageCache);
  assert.equal(count(main, 'download'), 1); assert.equal(count(wt, 'download'), 0);
  assert.equal(count(wt, 'cache-hit'), 1);
  assert.notEqual(realpathSync(join(main.root, 'node_modules')), realpathSync(join(wt.root, 'node_modules')));
});

test('unchanged worktree and source-only edits reuse installation; lockfile/config/workspace changes rerun it', async () => {
  const f = fixture();
  assert.equal((await prepare(f)).ok, true);
  const again = await prepare(f);
  assert.equal(again.steps[0].cached, true); assert.equal(count(f, 'install'), 1);
  writeFileSync(join(f.root, 'app.js'), 'module.exports = 2;\n');
  assert.equal((await prepare(f)).steps[0].cached, true);
  writeFileSync(join(f.root, 'yarn.lock'), '# changed lock\n');
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 2);
  writeFileSync(join(f.root, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.17.1.cjs\nnodeLinker: node-modules\n');
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 3);
  mkdirSync(join(f.root, 'packages', 'child'), { recursive: true });
  writeFileSync(join(f.root, 'packages', 'child', 'package.json'), '{"name":"child"}');
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 4);
});

test('missing dependencies invalidate the proof and a failed reinstall cannot leave a cached success', async () => {
  const f = fixture();
  await prepare(f);
  rmSync(join(f.root, 'node_modules', 'vitest', 'package.json'));
  writeFileSync(join(f.root, 'fail-install'), 'fail');
  const failed = await prepare(f);
  assert.equal(failed.ok, false); assert.equal(failed.steps[0].code, 8);
  rmSync(join(f.root, 'fail-install'));
  const fixed = await prepare(f);
  assert.equal(fixed.ok, true); assert.equal(fixed.steps[0].cached, undefined);
  assert.equal(count(f, 'install'), 3);
});

test('an installed transitive package disappearing invalidates the installation proof', async () => {
  const f = fixture();
  await prepare(f);
  mkdirSync(join(f.root, 'node_modules', 'transitive'));
  writeFileSync(join(f.root, 'node_modules', 'transitive', 'package.json'), '{"name":"transitive"}');
  await prepare(f); // chụp lại trạng thái mới sau install thật
  rmSync(join(f.root, 'node_modules', 'transitive'), { recursive: true });
  assert.equal((await prepare(f)).steps[0].cached, undefined);
  assert.equal(count(f, 'install'), 3);
});

test('install hooks and local file dependencies make source edits invalidate installation', async () => {
  for (const kind of ['hook', 'local']) {
    const f = fixture();
    const file = join(f.root, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'hook') pkg.scripts.postinstall = 'node hook.js';
    else pkg.dependencies = { local: 'file:./local-package' };
    writeFileSync(file, JSON.stringify(pkg));
    writeFileSync(join(f.root, 'hook.js'), '// input one\n');
    await prepare(f);
    assert.equal((await prepare(f)).steps[0].cached, true);
    writeFileSync(join(f.root, 'hook.js'), '// input two\n');
    assert.equal((await prepare(f)).steps[0].cached, undefined);
    assert.equal(count(f, 'install'), 2);
  }
});

test('a corrupt downloaded package fails a new worktree instead of inheriting main success', async () => {
  const main = fixture(), wt = fixture(main.tw, 'BUG-09');
  const a = await prepare(main);
  writeFileSync(join(a.packageCache, 'package.zip'), 'corrupt');
  const b = await prepare(wt, main);
  assert.equal(b.ok, false); assert.equal(b.steps[0].code, 9);
  assert.match(b.failure, /cache checksum mismatch/);
});

test('concurrent setup calls for one worktree join the same install', async () => {
  const f = fixture();
  const results = await Promise.all([prepare(f), prepare(f)]);
  assert.ok(results.every(r => r.ok)); assert.equal(count(f, 'install'), 1);
});

test('malformed setup metadata is discarded and rebuilt rather than trusted or blocking preparation', async () => {
  const f = fixture();
  await prepare(f);
  const dir = join(f.logDir, 'setup-cache'), file = join(dir, readdirSync(dir)[0]);
  writeFileSync(file, '{"version":1,"steps":"broken"}');
  const repaired = await prepare(f);
  assert.equal(repaired.ok, true); assert.equal(repaired.steps[0].cached, undefined);
  assert.equal((await prepare(f)).steps[0].cached, true);
  assert.equal(count(f, 'install'), 2);
});

test('organizer prepare/build reuse requires unchanged source and intact build outputs', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(undefined, 'main', true);
  await prepare(f);
  assert.equal((await prepare(f)).steps[0].cached, true); assert.equal(count(f, 'install'), 1);
  writeFileSync(join(f.root, 'build', 'index.html'), 'corrupted artifact');
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 2);
  writeFileSync(join(f.root, 'app.js'), 'module.exports = 3;\n');
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 3);
  assert.equal(readFileSync(join(f.root, 'build', 'index.html'), 'utf8'), 'module.exports = 3;\n');
  rmSync(join(f.root, 'build'), { recursive: true });
  assert.equal((await prepare(f)).steps[0].cached, undefined); assert.equal(count(f, 'install'), 4);
});

test('repeated main prepare reuses install/build but still runs doctor and baseline', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(undefined, 'main', true);
  writeFileSync(join(f.matchRoot, 'env-require', 'doctor.ps1'), `
param([string]$SourceDir, [string]$Output)
if (-not (Test-Path (Join-Path $SourceDir 'build/index.html'))) { exit 1 }
Add-Content -LiteralPath '${f.trace.replaceAll("'", "''")}' -Value '["doctor"]'
Write-Output 'Environment status: READY'
`);
  const run = () => setupEnvironment({ progress: [] }, { ...f, localDir: f.tw, deadlineAt: Date.now() + 60_000, report() {} });
  assert.equal((await run()).build, 'PASS');
  const again = await run();
  assert.equal(again.build, 'PASS'); assert.equal(again.steps[1].cached, true);
  assert.equal(count(f, 'install'), 1); assert.equal(count(f, 'doctor'), 2); assert.equal(count(f, 'test'), 2);
});

test('ordinary source edits rerun the inferred build while preserving the valid install', async () => {
  const f = fixture();
  const run = () => setupEnvironment({ progress: [] }, { ...f, localDir: f.tw, deadlineAt: Date.now() + 60_000, report() {} });
  assert.equal((await run()).build, 'PASS');
  const again = await run();
  assert.equal(again.steps.find(s => s.name === 'install').cached, true);
  assert.equal(again.steps.find(s => s.name === 'build').cached, true);
  assert.equal(count(f, 'install'), 1); assert.equal(count(f, 'run'), 1);
  writeFileSync(join(f.root, 'app.js'), 'module.exports = 4;\n');
  const changed = await run();
  assert.equal(changed.steps.find(s => s.name === 'install').cached, true);
  assert.equal(changed.steps.find(s => s.name === 'build').cached, undefined);
  assert.equal(count(f, 'install'), 1); assert.equal(count(f, 'run'), 2);
});

test('package manager cache settings use one external store and retain version-specific env names', () => {
  const f = fixture();
  const profile = detectProfile(f.matchRoot);
  const yarn = packageCache(profile, f.cacheDir);
  assert.equal(yarn.env.YARN_ENABLE_MIRROR, 'true');
  assert.equal(yarn.env.YARN_GLOBAL_FOLDER, join(f.cacheDir, 'yarn-4'));
  for (const version of [10, 11]) {
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ packageManager: `pnpm@${version}.0.0` }));
    const cfg = packageCache(detectProfile(f.matchRoot), f.cacheDir);
    assert.equal(cfg.env[version >= 11 ? 'pnpm_config_store_dir' : 'npm_config_store_dir'], join(f.cacheDir, `pnpm-${version}`));
  }
  writeFileSync(join(f.root, 'package.json'), '{"packageManager":"npm@10.0.0"}');
  assert.equal(packageCache(detectProfile(f.matchRoot), f.cacheDir).env.npm_config_cache, join(f.cacheDir, 'npm-10'));
});
