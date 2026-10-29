// Tool `app` (TOKXKPBV: fixer BUG-01 mất ~6 phút tự chạy và tắt dev server): build rồi start tách rời, port riêng,
// sống tiếp khi helper của subagent đóng, stop theo file trạng thái.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { app, appCommand, appsDir, stopApp } from '../../pack/src/app.mjs';
import { install, McpClient, tempDir } from './support.mjs';

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

test('app builds and starts on its own port, survives the helper that started it, restarts and stops', { timeout: 120_000 }, async () => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  install(tw);
  const one = appFolder(tw, 'BUG-01');
  const two = appFolder(tw, 'CR-01');
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

test('a failing build returns failed with the log tail; paths outside the matches folder are refused', { timeout: 60_000 }, async () => {
  const tw = join(tempDir('mtm-app-'), 'BUN');
  const broken = appFolder(tw, 'BUG-02', { buildExit: 1 });
  const res = await app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: broken });
  assert.equal(res.state, 'failed', JSON.stringify(res));
  assert.match(res.tail, /error TS1005: build broke/);
  assert.match(readFileSync(res.log, 'utf8'), /build broke/);
  assert.equal(existsSync(join(appsDir(tw), 'BUG-02.json')), false);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: join(tw, 'elsewhere') }), /PATH_NOT_ALLOWED/);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: '../x', matchRoot: broken }), /INVALID_ARGUMENT/);
  await assert.rejects(app({ teamWorkspace: tw, action: 'start', backlogItemKey: 'BUG-02', matchRoot: broken, mode: 'staging' }), /INVALID_ARGUMENT/);
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
