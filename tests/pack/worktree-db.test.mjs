// Database dev riêng cho worktree item (05 §5.9): item không seed đè dữ liệu của nhau, nên không phải chờ khoá app_data.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appDataLock } from '../../pack/src/env/datalock.mjs';
import { dbNameOf, dedicatedAppDatabase, detectProfile, dropWorktreeDatabases, worktreeEnvText } from '../../pack/src/env/environment.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { environmentFingerprint, pnpmModulesText } from '../../pack/src/core/candidates.mjs';
import { tempDir } from './support.mjs';

const MAIN = [
  'DATABASE_URL="postgresql://app:pw@127.0.0.1:5433/freelanceos"',
  'TEST_DATABASE_URL="postgresql://app:pw@127.0.0.1:5433/freelanceos_test_nbdb5u0o"',
  'AUTH_SECRET="x"'
].join('\n');

test('worktree .env gets its own app and test database per match and item, once', () => {
  const text = worktreeEnvText(MAIN, { matchName: 'NBDB5U0O', key: 'BUG-01', appDatabase: true });
  assert.equal(dbNameOf(text), 'freelanceos_nbdb5u0o_bug01');
  assert.equal(dbNameOf(text, 'TEST_DATABASE_URL'), 'freelanceos_test_nbdb5u0o_bug01');
  assert.match(text, /AUTH_SECRET="x"/);
  assert.equal(worktreeEnvText(text, { matchName: 'NBDB5U0O', key: 'BUG-01', appDatabase: true }), text, 'no second suffix');
  // Stack không tự migrate được: app vẫn dùng database chung, chỉ test DB riêng.
  const shared = worktreeEnvText(MAIN, { matchName: 'NBDB5U0O', key: 'BUG-01', appDatabase: false });
  assert.equal(dbNameOf(shared), 'freelanceos');
  assert.equal(dbNameOf(shared, 'TEST_DATABASE_URL'), 'freelanceos_test_nbdb5u0o_bug01');
});

test('dedicatedAppDatabase compares the worktree app database with the main checkout', () => {
  const dir = tempDir('mtm-wtdb-');
  const main = join(dir, 'main', 'M1'), wt = join(dir, 'wt', 'BUG-01', 'M1');
  for (const root of [main, wt]) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'package.json'), '{}');
  }
  assert.equal(dedicatedAppDatabase(wt, main), null, 'no .env yet');
  writeFileSync(join(main, 'src', '.env'), MAIN);
  writeFileSync(join(wt, 'src', '.env'), MAIN);
  assert.equal(dedicatedAppDatabase(wt, main), null, 'worktree created before this change shares the database');
  writeFileSync(join(wt, 'src', '.env'), worktreeEnvText(MAIN, { matchName: 'M1', key: 'BUG-01', appDatabase: true }));
  assert.equal(dedicatedAppDatabase(wt, main), 'freelanceos_m1_bug01');
});

test('after push only the worktree databases are dropped, through the admin database', async () => {
  const dir = tempDir('mtm-wtdrop-');
  const main = join(dir, 'main', 'M1'), wt = join(dir, 'wt', 'BUG-01', 'M1');
  for (const root of [main, wt]) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'package.json'), '{}');
  }
  writeFileSync(join(main, 'src', '.env'), MAIN);
  const missing = await dropWorktreeDatabases({ wtMatchRoot: wt, mainMatchRoot: main });
  assert.deepEqual(missing.dropped, [], 'no worktree .env, no Prisma CLI: nothing to drop');
  // Prisma CLI giả: ghi lại argv và câu lệnh SQL từ stdin.
  const cli = join(main, 'src', 'node_modules', 'prisma', 'build');
  mkdirSync(cli, { recursive: true });
  const calls = join(dir, 'calls.ndjson');
  writeFileSync(join(cli, 'index.js'), `const fs = require('fs'); let sql = ''; process.stdin.on('data', d => { sql += d; });
process.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), sql }) + '\\n'));`);
  writeFileSync(join(wt, 'src', '.env'), MAIN);
  assert.deepEqual((await dropWorktreeDatabases({ wtMatchRoot: wt, mainMatchRoot: main })).dropped, [],
    'a worktree sharing the main databases drops nothing');
  writeFileSync(join(wt, 'src', '.env'), worktreeEnvText(MAIN, { matchName: 'M1', key: 'BUG-01', appDatabase: true }));
  const res = await dropWorktreeDatabases({ wtMatchRoot: wt, mainMatchRoot: main });
  assert.deepEqual(res.dropped, ['freelanceos_m1_bug01', 'freelanceos_test_nbdb5u0o_m1_bug01']);
  const sent = readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(sent.map(c => c.sql), ['DROP DATABASE IF EXISTS "freelanceos_m1_bug01" WITH (FORCE);',
    'DROP DATABASE IF EXISTS "freelanceos_test_nbdb5u0o_m1_bug01" WITH (FORCE);']);
  assert.deepEqual(sent[0].argv, ['db', 'execute', '--url', 'postgresql://app:pw@127.0.0.1:5433/postgres', '--stdin']);
});

test('app_data lock returns at once for an item with its own database and leaves the shared lock alone', async () => {
  const tw = tempDir('mtm-lock-');
  const call = a => appDataLock({ teamWorkspace: tw, ...a });
  assert.equal((await call({ action: 'lock', backlogItemKey: 'BUG-02' })).locked, true, 'BUG-02 holds the shared lock');
  const own = await call({ action: 'lock', backlogItemKey: 'CR-01', database: 'freelanceos_m1_cr01' });
  assert.deepEqual([own.locked, own.dedicated, own.database], [true, true, 'freelanceos_m1_cr01']);
  assert.equal((await call({ action: 'unlock', backlogItemKey: 'CR-01', database: 'freelanceos_m1_cr01' })).unlocked, true);
  assert.equal((await call({ action: 'status' })).heldBy, 'BUG-02', 'shared lock untouched');
  assert.equal((await call({ action: 'lock', backlogItemKey: 'CR-01' })).locked, false, 'shared database still queues');
});

test('subagent helper without a session still sees the worktree database from matchRoot or the running app', async () => {
  const tw = tempDir('mtm-subdb-');
  const main = join(tw, 'matches', 'M1', 'M1'), wt = join(tw, 'matches', 'M1', '.team-work', 'wt', 'CR-02', 'M1');
  for (const root of [main, wt]) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'package.json'), '{}');
  }
  writeFileSync(join(main, 'src', '.env'), MAIN);
  writeFileSync(join(wt, 'src', '.env'), worktreeEnvText(MAIN, { matchName: 'M1', key: 'CR-02', appDatabase: true }));
  const rt = new Runtime({ teamWorkspace: tw });
  assert.equal(rt.itemDatabase('CR-02'), null, 'nothing to go on');
  assert.equal(rt.itemDatabase('CR-02', wt), 'freelanceos_m1_cr02');
  assert.equal(rt.itemDatabase('CR-01', wt), null, 'matchRoot of another item');
  // 4D895OVI: CR-02 gọi lock không có matchRoot; app của nó đang chạy trong worktree.
  mkdirSync(join(tw, 'team-sdlc-pack', 'local', 'apps'), { recursive: true });
  writeFileSync(join(tw, 'team-sdlc-pack', 'local', 'apps', 'CR-02.json'), JSON.stringify({ matchRoot: wt, mode: 'production' }));
  assert.equal(rt.itemDatabase('CR-02'), 'freelanceos_m1_cr02');
  const lock = await rt.definitions().find(t => t.name === 'app_data').handler({ action: 'lock', backlogItemKey: 'CR-02' });
  assert.deepEqual([lock.locked, lock.dedicated], [true, true]);
});

test('pnpm rewriting its modules file does not change the environment fingerprint', () => {
  const json = { layoutVersion: 5, nodeLinker: 'isolated', prunedAt: 'Mon, 02 Nov 2026 03:19:05 GMT', ignoredBuilds: [], pendingBuilds: [], skipped: ['a'] };
  const rewritten = { ...json, prunedAt: 'Mon, 02 Nov 2026 03:30:51 GMT' }; delete rewritten.ignoredBuilds;
  assert.equal(pnpmModulesText(JSON.stringify(json)), pnpmModulesText(JSON.stringify(rewritten)));
  assert.notEqual(pnpmModulesText(JSON.stringify(json)), pnpmModulesText(JSON.stringify({ ...json, skipped: ['b'] })), 'real dependency change');
  const yaml = 'layoutVersion: 5\nprunedAt: Mon, 02 Nov 2026 03:19:05 GMT\nignoredBuilds:\n  - esbuild\nskipped: []\n';
  assert.equal(pnpmModulesText(yaml), pnpmModulesText('layoutVersion: 5\nprunedAt: Tue, 03 Nov 2026 01:00:00 GMT\nskipped: []\n'));
});

// NBDB5U0O: PI-01, TASK-03, TASK-04 cùng source tree mà mỗi item một gate đầy đủ (52–69 s): .env của worktree có tên
// database riêng theo trận/item, .modules.yaml ghi virtualStoreDir tuyệt đối, nên proof của checkout khác không khớp.
test('main and worktree share an environment fingerprint when only helper database names and virtualStoreDir differ', () => {
  const dir = tempDir('mtm-envfp-');
  const main = join(dir, 'main', 'NBDB5U0O'), wt = join(dir, 'wt', 'TASK-03', 'NBDB5U0O');
  for (const root of [main, wt]) {
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'package.json'), '{}');
    writeFileSync(join(root, 'src', 'node_modules', '.modules.yaml'), JSON.stringify({ layoutVersion: 5, nodeLinker: 'isolated',
      virtualStoreDir: join(root, 'src', 'node_modules', '.pnpm'), skipped: [] }));
  }
  const fp = root => environmentFingerprint(root, detectProfile(root));
  const scoped = text => worktreeEnvText(text, { matchName: 'NBDB5U0O', key: 'TASK-03', appDatabase: true });
  writeFileSync(join(main, 'src', '.env'), MAIN);
  writeFileSync(join(wt, 'src', '.env'), scoped(MAIN));
  assert.equal(fp(wt), fp(main));
  writeFileSync(join(wt, 'src', '.env'), scoped(MAIN.replace('5433/freelanceos"', '5433/billing"')));
  assert.notEqual(fp(wt), fp(main), 'another base database still counts');
  writeFileSync(join(wt, 'src', '.env'), `${scoped(MAIN)}\nFEATURE_FLAG="1"\n`);
  assert.notEqual(fp(wt), fp(main), 'any other .env change still counts');
});
