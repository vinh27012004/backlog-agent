// Codegraph (MCP server ngoài): installer khai [mcp_servers.codegraph] khi đã cài đúng phiên bản và bỏ khối đó khi
// chưa cài; helper dựng index bằng `init`, lần sau `sync`. Dùng một bản codegraph giả đặt sẵn, không tải npm.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEGRAPH, ensureCodegraphIndex, indexCodegraph } from '../../pack/src/env/codegraph.mjs';
import { codegraphFreshness, codegraphSourceSnapshot, codegraphStampPath } from '../../pack/src/env/codegraph-state.mjs';
import { install, sh, tempDir } from './support.mjs';

// Shim giả: ghi lại lệnh nhận được, `init`/`sync` tạo .codegraph/, `version` in phiên bản, `fail` trong path thì lỗi.
function fakeCodegraph(tw) {
  const dir = join(tw, 'team-sdlc-pack', 'codegraph', 'node_modules', ...CODEGRAPH.package.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: CODEGRAPH.package, version: CODEGRAPH.version }));
  writeFileSync(join(dir, 'npm-shim.js'), [
    "const fs = require('fs'), path = require('path');",
    "const [cmd, ...rest] = process.argv.slice(2);",
    "if (cmd === 'version') { console.log(" + JSON.stringify(CODEGRAPH.version) + "); process.exit(0); }",
    "const target = rest[rest.length - 1];",
    "if (target.includes('fail')) { console.error('boom'); process.exit(3); }",
    "fs.mkdirSync(path.join(target, '.codegraph'), { recursive: true });",
    "fs.writeFileSync(path.join(target, '.codegraph', 'codegraph.db'), 'fake index');",
    "if (fs.existsSync(path.join(target, 'mutate-during-index'))) fs.appendFileSync(path.join(target, 'lib.js'), '// concurrent edit');",
    "fs.appendFileSync(path.join(target, '.codegraph', 'calls.log'), [cmd, ...rest.slice(0, -1), process.env.CODEGRAPH_TELEMETRY, process.env.CODEGRAPH_NO_DOWNLOAD].join(' ') + '\\n');"
  ].join('\n'));
  return join(dir, 'npm-shim.js');
}

test('installer declares the codegraph MCP server only when the pinned version is installed', () => {
  const tw = join(tempDir('mtm-cg-'), 'BUN');
  const without = install(tw);
  assert.equal(without.codegraph, null);
  assert.ok(without.warnings.some(w => w.startsWith('CODEGRAPH_NOT_INSTALLED')));
  const plain = readFileSync(join(tw, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(plain, /codegraph|__CODEGRAPH/);
  assert.match(plain, /\[mcp_servers\.team_runtime\][\s\S]*\[shell_environment_policy\]/);
  // L48: giới hạn subagent đủ cho 4 item cùng lúc kèm verifier + reviewer (Codex mặc định từ chối subagent thứ tư).
  // Checkout core.autocrlf=true ghi config CRLF.
  assert.match(plain, /\[agents\]\r?\nmax_concurrent_threads_per_session = 16\r?\n/);

  const shim = fakeCodegraph(tw);
  const withIt = install(tw);
  assert.equal(withIt.codegraph, CODEGRAPH.version);
  const config = readFileSync(join(tw, '.codex', 'config.toml'), 'utf8');
  assert.ok(config.includes(`args = [${JSON.stringify(shim.replaceAll('\\', '/'))}, "serve", "--mcp"]`));
  assert.ok(config.includes(`CODEGRAPH_MCP_TOOLS = ${JSON.stringify(CODEGRAPH.tools.join(','))}`));
  assert.match(config, /CODEGRAPH_TELEMETRY = "0"[\s\S]*CODEGRAPH_NO_DOWNLOAD = "1"/);
  assert.doesNotMatch(config, /__CODEGRAPH|__TEAM_RUNTIME/);

  const checker = spawnSync(process.execPath, [join(tw, 'team-sdlc-pack', 'runtime', 'scripts', 'check-distribution.mjs'), '--team-workspace', tw], { encoding: 'utf8' });
  const row = JSON.parse(checker.stdout).checks.find(c => c.id === 'codegraph');
  assert.equal(row.ok, true, row.detail);
});

test('indexCodegraph runs init, then sync, with telemetry and downloads off; never throws', async () => {
  const tw = tempDir('mtm-cg-');
  const match = join(tw, 'matches', 'M1', 'M1');
  mkdirSync(match, { recursive: true });
  sh('git', ['init', '-q'], match);
  writeFileSync(join(match, 'lib.js'), 'export const value = 1;\n');
  assert.deepEqual(await indexCodegraph({ teamWorkspace: tw, matchRoot: match }), { name: 'codegraph', skipped: 'not installed' });

  fakeCodegraph(tw);
  const first = await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  assert.equal(first.code, 0);
  assert.equal(first.freshness, 'fresh');
  const second = await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  assert.equal(second.code, 0);
  assert.deepEqual(await codegraphFreshness(match), { freshness: 'fresh' });
  await ensureCodegraphIndex({ teamWorkspace: tw, matchRoot: match });
  const calls = readFileSync(join(match, '.codegraph', 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['init -y 0 1', 'sync 0 1']);

  const broken = join(tw, 'matches', 'fail');
  mkdirSync(broken, { recursive: true });
  const failed = await indexCodegraph({ teamWorkspace: tw, matchRoot: broken });
  assert.equal(failed.code, 3);
  assert.match(failed.tail, /boom/);
  assert.equal(existsSync(join(broken, '.codegraph')), false);
});

test('source fingerprints detect same-size edits, additions and deletions but ignore item answers', async () => {
  const tw = tempDir('mtm-cg-state-'), match = join(tw, 'match');
  mkdirSync(match); sh('git', ['init', '-q'], match); fakeCodegraph(tw);
  const file = join(match, 'lib.js'), original = 'export const value = 1;\n';
  writeFileSync(file, original); sh('git', ['add', 'lib.js'], match);
  await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  const stat = statSync(file);
  writeFileSync(file, original.replace('1', '2'));
  utimesSync(file, stat.atime, stat.mtime);
  assert.deepEqual(await codegraphFreshness(match), { freshness: 'stale', reason: 'source_changed' });
  writeFileSync(file, original);
  const fresh = await codegraphSourceSnapshot(match);
  mkdirSync(join(match, 'answers')); writeFileSync(join(match, 'answers', 'result.json'), '{}');
  assert.deepEqual(await codegraphSourceSnapshot(match), fresh);
  writeFileSync(join(match, 'caller.js'), 'import { value } from "./lib.js";');
  assert.equal((await codegraphFreshness(match)).freshness, 'stale');
  await ensureCodegraphIndex({ teamWorkspace: tw, matchRoot: match });
  assert.equal((await codegraphFreshness(match)).freshness, 'fresh');
  sh('git', ['add', 'caller.js'], match);
  rmSync(join(match, 'caller.js'));
  assert.equal((await codegraphFreshness(match)).freshness, 'stale');
  assert.equal(await codegraphSourceSnapshot(match, { budgetMs: -1 }), null);
  rmSync(codegraphStampPath(match));
  assert.deepEqual(await codegraphFreshness(match), { freshness: 'unknown', reason: 'source_stamp_missing' });
});

test('failed or concurrent indexing cannot certify the old source stamp', async () => {
  const tw = tempDir('mtm-cg-race-'), match = join(tw, 'match');
  mkdirSync(match); sh('git', ['init', '-q'], match); fakeCodegraph(tw);
  writeFileSync(join(match, 'lib.js'), 'export const value = 1;\n');
  await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  writeFileSync(join(match, 'mutate-during-index'), 'yes');
  const changed = await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  assert.equal(changed.code, 0);
  assert.equal(changed.freshness, 'unknown');
  assert.equal(existsSync(codegraphStampPath(match)), false);
  rmSync(join(match, 'mutate-during-index'));
  await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  const failed = await indexCodegraph({ teamWorkspace: tw, matchRoot: match, logFile: join(match, 'lib.js', 'impossible.log') });
  assert.equal(failed.code, -1);
  assert.equal(existsSync(codegraphStampPath(match)), false);
});
