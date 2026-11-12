// Tool `app` (TOKXKPBV: fixer BUG-01 mất ~6 phút tự chạy và tắt dev server): build rồi start tách rời, port riêng,
// sống tiếp khi helper của subagent đóng, stop theo file trạng thái.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { app, appCommand, appsDir, authUrlEnv, stopApp } from '../../pack/src/env/app.mjs';
import { install, McpClient, sh, tempDir } from './support.mjs';

// App node nhỏ trong matches/M1/<wt>/src: build ghi built.txt, server trả nội dung đó trên PORT.
function appFolder(tw, key, { buildExit = 0 } = {}) {
  const matchRoot = join(tw, 'matches', 'M1', '.team-work', 'wt', key, 'M1');
  const src = join(matchRoot, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'a', private: true, scripts: { build: 'node build.cjs', start: 'node server.cjs' } }));
  writeFileSync(join(src, 'build.cjs'), buildExit
    ? `console.error('src/page.tsx(3,1): error TS1005: build broke'); process.exit(${buildExit});\n`
    : `require('fs').writeFileSync('built.txt', '${key} built');\n`);
  writeFileSync(join(src, 'server.cjs'), [
    "const fs = require('fs');",
    "require('http').createServer((req, res) => res.end(fs.readFileSync('built.txt', 'utf8'))).listen(Number(process.env.PORT));", ''].join('\n'));
  return matchRoot;
}

const body = async url => (await fetch(url)).text();
const closed = async url => { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; } };

test('app builds and starts on its own port, survives the helper that started it, restarts and stops', { timeout: 120_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  install(tw);
  const one = appFolder(tw, 'BUG-01');
  const two = appFolder(tw, 'CR-01');
  t.after(() => { stopApp(tw, 'BUG-01'); stopApp(tw, 'CR-01'); });
  const client = new McpClient(join(tw, 'team-sdlc-pack', 'runtime', 'bin', 'runtime-server.mjs'), process.env);
  let first;
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    first = await client.call('app', { action: 'start', backlogItemKey: 'BUG-01', matchRoot: one });
    assert.equal(first.state, 'ready', JSON.stringify(first));
    assert.ok(first.port >= 3100 && first.port <= 3199);
    assert.equal(first.mode, 'production');
    assert.equal(first.log, join(tw, 'matches', 'M1', '.team-work', 'logs', 'BUG-01-app.log'));
  } finally {
    client.close();
  }
  // Helper của subagent đã đóng: app vẫn chạy.
  assert.equal(await body(first.url), 'BUG-01 built');

  const second = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'CR-01', matchRoot: two });
  assert.equal(second.state, 'ready', JSON.stringify(second));
  assert.notEqual(second.port, first.port);
  assert.equal(await body(second.url), 'CR-01 built');

  // Start lại cùng item: app cũ dừng trước, bản mới build lại.
  writeFileSync(join(one, 'src', 'build.cjs'), "require('fs').writeFileSync('built.txt', 'BUG-01 rebuilt');\n");
  const again = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-01', matchRoot: one });
  assert.equal(again.state, 'ready', JSON.stringify(again));
  assert.equal(await body(again.url), 'BUG-01 rebuilt');
  if (again.port !== first.port) assert.ok(await closed(first.url), 'the old app was stopped');

  assert.equal((await app({ teamWorkspace: tw, action: 'status', backlogItemKey: 'CR-01', waitSeconds: 0 })).state, 'ready');
  assert.equal(stopApp(tw, 'BUG-01').stopped, true);
  assert.equal((await app({ teamWorkspace: tw, action: 'stop', backlogItemKey: 'CR-01' })).stopped, true);
  assert.ok(await closed(again.url));
  assert.ok(await closed(second.url));
  assert.equal(existsSync(join(appsDir(tw), 'BUG-01.json')), false);
  assert.equal((await app({ teamWorkspace: tw, action: 'status', backlogItemKey: 'BUG-01' })).state, 'stopped');
});

test('a failing build returns failed with the log tail; paths outside the matches folder are refused', { timeout: 60_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const broken = appFolder(tw, 'BUG-02', { buildExit: 1 });
  t.after(() => stopApp(tw, 'BUG-02'));
  const res = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: broken });
  assert.equal(res.state, 'failed', JSON.stringify(res));
  assert.match(res.tail, /error TS1005: build broke/);
  assert.match(readFileSync(res.log, 'utf8'), /build broke/);
  assert.equal(existsSync(join(appsDir(tw), 'BUG-02.json')), false);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: join(tw, 'elsewhere') }), /PATH_NOT_ALLOWED/);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: '../x', matchRoot: broken }), /INVALID_ARGUMENT/);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: broken, mode: 'staging' }), /INVALID_ARGUMENT/);
});

// L7TZXHII: một server bỏ lại giữ :::3100; helper dò 127.0.0.1 thấy trống, chọn 3100, rồi báo `ready` vì server lạ trả lời.
test('a port held on :: is skipped and a stranger answering on the port is never reported ready', { timeout: 60_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const stranger = createServer((req, res) => res.end('stranger'));
  let held;
  for (held = 3100; held <= 3199; held++) {
    if (await new Promise(ok => { stranger.once('error', () => ok(false)); stranger.listen({ port: held, host: '::' }, () => ok(true)); })) break;
  }
  t.after(() => { stopApp(tw, 'BUG-03'); stranger.close(); });
  const res = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-03', matchRoot: appFolder(tw, 'BUG-03') });
  assert.equal(res.state, 'ready', JSON.stringify(res));
  assert.notEqual(res.port, held);
  assert.equal(await body(res.url), 'BUG-03 built');
});

test('an app that dies on EADDRINUSE restarts on another port without building again', { timeout: 60_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const root = appFolder(tw, 'CR-02');
  const src = join(root, 'src');
  writeFileSync(join(src, 'build.cjs'), "const fs = require('fs'); fs.appendFileSync('builds.txt', 'x'); fs.writeFileSync('built.txt', 'CR-02 built');\n");
  writeFileSync(join(src, 'server.cjs'), [
    "const fs = require('fs');",
    "if (!fs.existsSync('tried.txt')) { fs.writeFileSync('tried.txt', process.env.PORT); console.error('Error: listen EADDRINUSE: address already in use :::' + process.env.PORT); process.exit(1); }",
    "require('http').createServer((req, res) => res.end(fs.readFileSync('built.txt', 'utf8'))).listen(Number(process.env.PORT));", ''].join('\n'));
  t.after(() => stopApp(tw, 'CR-02'));
  const res = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'CR-02', matchRoot: root });
  assert.equal(res.state, 'ready', JSON.stringify(res));
  assert.equal(await body(res.url), 'CR-02 built');
  assert.equal(readFileSync(join(src, 'builds.txt'), 'utf8'), 'x', 'the retry does not build again');
  const log = readFileSync(res.log, 'utf8');
  assert.match(log, /EADDRINUSE/, 'the log keeps the first failure');
  assert.equal(JSON.parse(readFileSync(join(appsDir(tw), 'CR-02.json'), 'utf8')).retries, 1);
});

// NBDB5U0O: BUG-02 dừng app rồi start lại trên đúng source, build production lần hai (~35 s). Worktree là repo git nên
// có snapshot source/môi trường; build tay hay dev server đè lên thư mục build, hoặc bản dùng lại không chạy được, thì build lại.
test('start on unchanged source reuses the build; a change, dev mode, an overwritten or broken build builds again', { timeout: 180_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const root = appFolder(tw, 'BUG-05');
  const src = join(root, 'src');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'a', private: true,
    scripts: { build: 'node build.cjs', start: 'node server.cjs', dev: 'node server.cjs' } }));
  writeFileSync(join(src, 'build.cjs'), ["const fs = require('fs'); fs.appendFileSync('builds.txt', 'x');",
    "fs.mkdirSync('.next', { recursive: true }); fs.writeFileSync('.next/BUILD_ID', String(Math.random()));",
    "fs.writeFileSync('built.txt', 'BUG-05 built');", ''].join('\n'));
  writeFileSync(join(src, 'server.cjs'), ["const fs = require('fs'); if (!fs.existsSync('built.txt')) process.exit(3);",
    "require('http').createServer((req, res) => res.end(fs.readFileSync('built.txt', 'utf8'))).listen(Number(process.env.PORT));", ''].join('\n'));
  writeFileSync(join(src, '.gitignore'), 'builds.txt\nbuilt.txt\n.next/\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'seed']]) sh('git', args, dirname(root), gitEnv);
  t.after(() => stopApp(tw, 'BUG-05'));
  const start = (mode = 'production') => app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-05', matchRoot: root, mode });
  const builds = () => readFileSync(join(src, 'builds.txt'), 'utf8').length;

  const first = await start();
  assert.equal(first.state, 'ready', JSON.stringify(first));
  assert.equal(builds(), 1);
  assert.equal(first.reusedBuild, undefined);
  const again = await start();
  assert.equal(again.state, 'ready', JSON.stringify(again));
  assert.equal(builds(), 1, 'unchanged source: no second build');
  assert.equal(again.reusedBuild.by, 'app');
  assert.equal(await body(again.url), 'BUG-05 built');

  writeFileSync(join(src, 'page.js'), 'module.exports = 1;\n');
  assert.equal((await start()).state, 'ready');
  assert.equal(builds(), 2, 'a source change builds again');
  assert.equal((await start('dev')).state, 'ready');
  assert.equal((await start()).state, 'ready');
  assert.equal(builds(), 3, 'the dev server wrote over the build folder');
  writeFileSync(join(src, '.next', 'BUILD_ID'), 'built by hand');
  assert.equal((await start()).state, 'ready');
  assert.equal(builds(), 4, 'a build made outside the helper is not reused');

  rmSync(join(src, 'built.txt'));
  const broken = await start();
  assert.equal(broken.state, 'failed', JSON.stringify(broken));
  assert.match(broken.hint, /builds afresh/);
  assert.equal(builds(), 4);
  assert.equal((await start()).state, 'ready');
  assert.equal(builds(), 5, 'a reused build that did not start is built again');
});

test('a localhost AUTH_URL in .env follows the chosen port for the app process only; .env stays as it is', { timeout: 60_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const root = appFolder(tw, 'TASK-02');
  const src = join(root, 'src');
  const envText = 'AUTH_URL="http://localhost:3000"\nNEXTAUTH_URL=https://auth.example.com/api/auth\n';
  writeFileSync(join(src, '.env'), envText);
  writeFileSync(join(src, 'server.cjs'),
    "require('http').createServer((req, res) => res.end(`${process.env.AUTH_URL}|${process.env.NEXTAUTH_URL}`)).listen(Number(process.env.PORT));\n");
  t.after(() => stopApp(tw, 'TASK-02'));
  const res = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'TASK-02', matchRoot: root });
  assert.equal(res.state, 'ready', JSON.stringify(res));
  assert.equal(await body(res.url), `http://localhost:${res.port}|undefined`, 'a non-local NEXTAUTH_URL is left alone');
  assert.deepEqual(res.authEnv, { AUTH_URL: `http://localhost:${res.port}` });
  assert.equal(readFileSync(join(src, '.env'), 'utf8'), envText);
});

test('authUrlEnv keeps the auth path and ignores apps without a local auth URL', () => {
  const dir = tempDir('mtm-app-auth-');
  assert.deepEqual(authUrlEnv(dir, 3101), {});
  writeFileSync(join(dir, '.env'), 'NEXTAUTH_URL=http://127.0.0.1:3000/api/auth\nDATABASE_URL=postgres://localhost:5432/x\n');
  writeFileSync(join(dir, '.env.local'), 'AUTH_URL=http://localhost:4000/\n');
  assert.deepEqual(authUrlEnv(dir, 3101), { NEXTAUTH_URL: 'http://127.0.0.1:3101/api/auth', AUTH_URL: 'http://localhost:3101/' });
});

test('next apps get -p for the port; mode dev and no start script run dev; other stacks are unsupported', () => {
  const dir = tempDir('mtm-app-cmd-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'next build', start: 'next start', dev: 'next dev' } }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(['build', 'start', 'mode'].map(k => appCommand(dir, 3105)[k]), ['pnpm run build', 'pnpm exec next start -p 3105', 'production']);
  assert.deepEqual(['build', 'start', 'mode'].map(k => appCommand(dir, 3105, 'dev')[k]), [null, 'pnpm exec next dev -p 3105', 'dev']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.deepEqual(['build', 'start', 'mode'].map(k => appCommand(dir, 3105)[k]), [null, 'pnpm run dev', 'dev']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'next build', start: 'next start' } }));
  assert.match(appCommand(dir, 3105, 'dev').error, /no dev script/);
  const java = tempDir('mtm-app-java-');
  writeFileSync(join(java, 'pom.xml'), '<project/>');
  assert.match(appCommand(java, 3105).error, /start the app by hand/);
});

// OMZJW0S0/UOMNKT6Z BUG-09: README của project build web app rồi chạy một server riêng phục vụ nó, với biến môi trường
// trỏ tới thư mục dữ liệu; lệnh start chung chạy sai app và fixer mất 2,5–3 phút tự khởi động server bằng tay.
test('custom commands from the README build in their folder, serve with {port}/{data}/{matchRoot} env and are kept for restarts', { timeout: 120_000 }, async t => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const matchRoot = appFolder(tw, 'BUG-09');
  const web = join(matchRoot, 'src', 'packages', 'web'), server = join(matchRoot, 'src', 'packages', 'server');
  mkdirSync(web, { recursive: true }); mkdirSync(server, { recursive: true });
  writeFileSync(join(web, 'build.cjs'), "require('fs').mkdirSync('build', { recursive: true }); require('fs').writeFileSync('build/index.html', 'web build');\n");
  writeFileSync(join(server, 'app.cjs'), [
    "const fs = require('fs'), path = require('path');",
    "if (!fs.existsSync(process.env.APP_FILES)) { console.error('missing ' + process.env.APP_FILES); process.exit(1); }",
    "require('http').createServer((req, res) => res.end(fs.readFileSync(path.join(process.env.WEB_ROOT, 'index.html'), 'utf8') + ' on ' + process.env.APP_PORT))",
    "  .listen(Number(process.env.APP_PORT), '127.0.0.1');", ''].join('\n'));
  t.after(() => stopApp(tw, 'BUG-09'));
  const custom = {
    build: [{ command: 'node build.cjs', cwd: 'src/packages/web' }],
    start: { command: 'node app.cjs', cwd: 'src/packages/server' },
    env: { APP_PORT: '{port}', APP_FILES: '{data}/server-files', WEB_ROOT: '{matchRoot}/src/packages/web/build' },
  };
  const first = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-09', matchRoot, custom });
  assert.equal(first.state, 'ready', JSON.stringify(first));
  assert.equal(first.mode, 'custom');
  assert.equal(await body(first.url), `web build on ${first.port}`);
  assert.ok(existsSync(join(tw, 'matches', 'M1', '.team-work', 'app-data', 'BUG-09', 'server-files')), 'the data folder an env value names is created outside the worktree');

  // 33R91I3Q: đề khác trên cùng app (cùng package.json) start không gửi custom thì dùng lệnh BUG-09 đã chạy được, với
  // thư mục và {matchRoot} của worktree mình; bốn đề từng tự tìm lại lệnh này, mỗi lần thử 83–121 s.
  const other = appFolder(tw, 'CR-07');
  for (const dir of ['web', 'server']) mkdirSync(join(other, 'src', 'packages', dir), { recursive: true });
  writeFileSync(join(other, 'src', 'packages', 'web', 'build.cjs'), "require('fs').mkdirSync('build', { recursive: true }); require('fs').writeFileSync('build/index.html', 'CR-07 web');\n");
  writeFileSync(join(other, 'src', 'packages', 'server', 'app.cjs'), readFileSync(join(server, 'app.cjs'), 'utf8'));
  t.after(() => stopApp(tw, 'CR-07'));
  const shared = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'CR-07', matchRoot: other });
  assert.equal(shared.state, 'ready', JSON.stringify(shared));
  assert.equal(shared.mode, 'custom');
  assert.equal(shared.commandsFrom, 'BUG-09');
  assert.match(shared.hint, /project commands BUG-09 already ran successfully/);
  assert.equal(await body(shared.url), `CR-07 web on ${shared.port}`);
  stopApp(tw, 'CR-07');

  // Start lại không gửi custom: dùng lệnh đã nhớ; build:false bỏ bước build.
  writeFileSync(join(web, 'build', 'index.html'), 'kept build');
  const again = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-09', matchRoot, build: false });
  assert.equal(again.state, 'ready', JSON.stringify(again));
  assert.equal(await body(again.url), `kept build on ${again.port}`);

  // {} quên lệnh riêng: quay về lệnh chung của project (script start).
  const plain = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-09', matchRoot, custom: {} });
  assert.equal(plain.state, 'ready', JSON.stringify(plain));
  assert.equal(await body(plain.url), 'BUG-09 built');

  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-09', matchRoot, custom: { start: { command: 'node x.cjs', cwd: '../..' } } }),
    e => e.code === 'PATH_NOT_ALLOWED');
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-09', matchRoot, custom: { build: ['node b.cjs'] } }),
    e => e.code === 'INVALID_ARGUMENT' && /custom\.start\.command/.test(e.message));
});
