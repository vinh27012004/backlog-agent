// Codegraph (MCP server ngoài): installer khai [mcp_servers.codegraph] khi đã cài đúng phiên bản và bỏ khối đó khi
// chưa cài; helper dựng index bằng `init`, lần sau `sync`. Dùng một bản codegraph giả đặt sẵn, không tải npm.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEGRAPH, indexCodegraph } from '../../pack/src/codegraph.mjs';
import { install, tempDir } from './support.mjs';

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
  assert.deepEqual(await indexCodegraph({ teamWorkspace: tw, matchRoot: match }), { name: 'codegraph', skipped: 'not installed' });

  fakeCodegraph(tw);
  const first = await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  assert.equal(first.code, 0);
  const second = await indexCodegraph({ teamWorkspace: tw, matchRoot: match });
  assert.equal(second.code, 0);
  const calls = readFileSync(join(match, '.codegraph', 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['init -y 0 1', 'sync 0 1']);

  const broken = join(tw, 'matches', 'fail');
  mkdirSync(broken, { recursive: true });
  const failed = await indexCodegraph({ teamWorkspace: tw, matchRoot: broken });
  assert.equal(failed.code, 3);
  assert.match(failed.tail, /boom/);
  assert.equal(existsSync(join(broken, '.codegraph')), false);
});
