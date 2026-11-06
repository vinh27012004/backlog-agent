// Chuẩn bị repo/worktree bằng bundled Yarn và quy trình BTC, không tải dependency thật.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appCommand } from '../../pack/src/env/app.mjs';
import { detectProfile, prepareWorktreeEnv, setupEnvironment } from '../../pack/src/env/environment.mjs';
import { runChecks } from '../../pack/src/env/checks.mjs';
import { runPwsh } from '../../pack/src/core/jobs.mjs';
import { tempDir } from './support.mjs';

function project({ version = '4.17.1', yarnrc = 'yarnPath: .yarn/releases/yarn-4.17.1.cjs', releases = [version], organizer = false } = {}) {
  const tw = tempDir('mtm-env-');
  const matchRoot = join(tw, 'matches', 'M1', "M1 source's copy");
  const root = join(matchRoot, 'src');
  const logDir = join(tw, 'matches', 'M1', '.team-work', 'logs');
  mkdirSync(join(root, '.yarn', 'releases'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: `yarn@${version}`,
    scripts: { build: 'build', typecheck: 'typecheck', test: 'vitest run', start: 'server', dev: 'dev' },
    devDependencies: { vitest: '1', prisma: '1' } }));
  if (yarnrc !== null) writeFileSync(join(root, '.yarnrc.yml'), yarnrc);
  for (const release of releases) writeFileSync(join(root, '.yarn', 'releases', `yarn-${release}.cjs`), `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('commands.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'install') fs.mkdirSync('node_modules/vitest', { recursive: true });
if (args[0] === 'browser-build') fs.writeFileSync('browser-built.txt', 'browser');
if (args.join(' ') === 'run build') fs.writeFileSync('generic-built.txt', 'generic');
if (args[0] === 'test') console.log('Tests  2 passed (2)');
`);
  if (organizer) {
    mkdirSync(join(matchRoot, 'env-require'));
    writeFileSync(join(matchRoot, 'env-require', 'prepare-source.ps1'), `
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../src')
try {
  & node .yarn/releases/yarn-${version}.cjs install --immutable
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & node .yarn/releases/yarn-${version}.cjs browser-build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
`);
  }
  return { tw, matchRoot, root, logDir };
}

const commands = p => readFileSync(join(p.root, 'commands.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const setup = p => setupEnvironment({ progress: [] }, { ...p, localDir: p.tw, report() {}, deadlineAt: Date.now() + 60_000 });
function doctor(p, artifact, exitCode = 0) {
  mkdirSync(join(p.matchRoot, 'env-require'), { recursive: true });
  writeFileSync(join(p.matchRoot, 'env-require', 'doctor.ps1'), `
param([string]$SourceDir, [string]$Output)
if (-not (Test-Path (Join-Path $SourceDir '${artifact}'))) { Write-Output 'Environment status: NOT_READY'; exit 1 }
Set-Content -LiteralPath $Output -Value '{}'
Write-Output 'Environment status: READY'
exit ${exitCode}
`);
}

test('profile uses the repo Yarn for every command and app start, with immutable installs for modern Yarn', () => {
  for (const yarnrc of ['yarnPath: .yarn/releases/yarn-4.17.1.cjs # bundled',
    'yarnPath: ".yarn/releases/yarn-4.17.1.cjs"', "yarnPath: '.yarn/releases/yarn-4.17.1.cjs'"]) {
    const p = project({ yarnrc });
    const profile = detectProfile(p.matchRoot);
    assert.equal(profile.packageManager, 'yarn');
    assert.equal(profile.commands.install, "node '.yarn/releases/yarn-4.17.1.cjs' install --immutable");
    for (const [name, command] of Object.entries(profile.commands)) {
      if (command) assert.ok(command.startsWith("node '.yarn/releases/yarn-4.17.1.cjs' "), `${name}: ${command}`);
    }
    assert.equal(appCommand(p.matchRoot, 3100).start, "node '.yarn/releases/yarn-4.17.1.cjs' run start");
    assert.equal(appCommand(p.matchRoot, 3100, 'dev').start, "node '.yarn/releases/yarn-4.17.1.cjs' run dev");
  }
});

test('release fallback follows the pinned version; Yarn 1 retains frozen-lockfile and global Yarn 4 uses immutable', () => {
  const p = project({ yarnrc: null, releases: ['4.17.1', '5.0.0'] });
  assert.equal(detectProfile(p.matchRoot).commands.install, "node '.yarn/releases/yarn-4.17.1.cjs' install --immutable");
  const old = project({ version: '1.22.22', yarnrc: null });
  assert.equal(detectProfile(old.matchRoot).commands.install, "node '.yarn/releases/yarn-1.22.22.cjs' install --frozen-lockfile");
  const global = project({ yarnrc: null, releases: [] });
  assert.equal(detectProfile(global.matchRoot).commands.install, 'yarn install --immutable');
  writeFileSync(join(p.root, '.yarnrc.yml'), 'yarnPath:\nnodeLinker: node-modules\n');
  assert.equal(detectProfile(p.matchRoot).commands.install, "node '.yarn/releases/yarn-4.17.1.cjs' install --immutable");
  writeFileSync(join(p.root, 'package.json'), '{}');
  assert.equal(detectProfile(p.matchRoot).packageManager, 'yarn', 'bundled releases identify Yarn without packageManager');
});

test('bundled commands really execute without a global Yarn, including closing checks', async () => {
  const p = project();
  const profile = detectProfile(p.matchRoot);
  const res = await runPwsh(profile.commands.install, { cwd: p.root });
  assert.equal(res.code, 0, res.tail);
  assert.ok(existsSync(join(p.root, 'node_modules', 'vitest')));
  const checks = await runChecks({ teamWorkspace: p.tw, backlogItemKey: 'BUG-09', matchRoot: p.matchRoot });
  assert.equal(checks.ok, true, JSON.stringify(checks));
  assert.deepEqual(commands(p)[0], ['install', '--immutable']);
  assert.ok(commands(p).some(a => a.join(' ') === 'run typecheck'));
  assert.ok(commands(p).some(a => a[0] === 'test'));
});

test('organizer preparation installs and builds before doctor, without a duplicate inferred build', { skip: process.platform !== 'win32' }, async () => {
  const p = project({ organizer: true });
  doctor(p, 'browser-built.txt');
  const res = await setup(p);
  assert.equal(res.build, 'PASS', JSON.stringify(res));
  assert.equal(res.doctor, 'READY');
  assert.equal(res.steps[1].name, 'prepare-source');
  assert.deepEqual(commands(p).slice(0, 2), [['install', '--immutable'], ['browser-build']]);
  assert.equal(existsSync(join(p.root, 'generic-built.txt')), false);
  assert.ok(existsSync(join(p.logDir, 'environment-report.json')));
  assert.equal(existsSync(join(p.matchRoot, 'env-require', 'environment-report.json')), false);
});

test('without a preparation script the inferred build also precedes doctor', { skip: process.platform !== 'win32' }, async () => {
  const p = project();
  doctor(p, 'generic-built.txt');
  const res = await setup(p);
  assert.equal(res.build, 'PASS', JSON.stringify(res));
  assert.equal(res.doctor, 'READY');
  assert.ok(res.steps.findIndex(s => s.name === 'build') < res.steps.findIndex(s => s.name === 'doctor'));
});

test('failed organizer preparation stops before doctor, tests and the inferred build', { skip: process.platform !== 'win32' }, async () => {
  const p = project({ organizer: true });
  writeFileSync(join(p.matchRoot, 'env-require', 'prepare-source.ps1'), 'exit 9');
  doctor(p, 'browser-built.txt');
  const res = await setup(p);
  assert.equal(res.build, 'FAIL');
  assert.equal(res.steps[1].code, 9);
  assert.equal(res.doctor, null);
  assert.equal(existsSync(join(p.root, 'commands.jsonl')), false);
});

test('doctor cannot report READY with a failing exit code', { skip: process.platform !== 'win32' }, async () => {
  const p = project({ organizer: true });
  doctor(p, 'browser-built.txt', 5);
  const res = await setup(p);
  assert.equal(res.doctor, 'NOT_READY');
  assert.equal(res.build, 'FAIL');
});

test('each worktree runs its own organizer preparation instead of reusing main node_modules', { skip: process.platform !== 'win32' }, async () => {
  const main = project({ organizer: true });
  const wt = project({ organizer: true });
  assert.deepEqual(detectProfile(main.matchRoot).commands, detectProfile(wt.matchRoot).commands,
    'preparation commands must not introduce absolute worktree paths into environment fingerprints');
  const res = await prepareWorktreeEnv({ progress: [] }, { wtMatchRoot: wt.matchRoot, mainMatchRoot: main.matchRoot,
    key: 'BUG-09', logDir: wt.logDir });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.steps[0].name, 'prepare_source');
  assert.ok(existsSync(join(wt.root, 'node_modules', 'vitest')));
  assert.ok(existsSync(join(wt.root, 'browser-built.txt')));
  assert.equal(existsSync(join(main.root, 'node_modules')), false);
});

test('worktree without an organizer script installs using bundled Yarn', async () => {
  const main = project();
  const wt = project();
  const res = await prepareWorktreeEnv({ progress: [] }, { wtMatchRoot: wt.matchRoot, mainMatchRoot: main.matchRoot,
    key: 'BUG-09', logDir: wt.logDir });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(commands(wt)[0], ['install', '--immutable']);
  assert.ok(existsSync(join(wt.root, 'node_modules', 'vitest')));
});
