// Installer: kết quả phải qua đúng bước kiểm của Player (verifyTeamRuntime) và cài lại idempotent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, hasPlayer, install, McpClient, player, tempDir } from './support.mjs';

// Practice #5: agent chỉ mở skill/tham khảo được chỉ đích danh trong prompt của nó.
test('the fixer is told which skills and references to read; it is the only subagent profile', () => {
  const fixer = readFileSync(join(REPO, 'pack', 'agents', 'team-fixer.toml'), 'utf8');
  for (const f of ['backlog-references/bug-patterns.md', 'backlog-references/pi-triage.md', 'backlog-references/evidence-playbook.md']) {
    assert.ok(fixer.includes(f), `fixer prompt names ${f}`);
  }
  assert.deepEqual(readdirSync(join(REPO, 'pack', 'agents')).sort(), ['team-fixer.toml', 'team-orchestrator.toml']);
});

test('installed pack passes Player verifyTeamRuntime', { skip: !hasPlayer }, async () => {
  const tw = join(tempDir('mtm-install-'), 'BUN');
  const result = install(tw);
  assert.equal(result.status, 'READY');
  assert.equal(result.teamId, 'BUN');
  const { verifyTeamRuntime } = await player('team-install.mjs');
  const verified = verifyTeamRuntime({ teamWorkspace: tw, teamSdlcPackWorkspace: join(tw, 'team-sdlc-pack') });
  assert.equal(verified.action, 'VERIFIED');
  assert.equal(verified.runtime.status, 'READY');
  assert.equal(verified.runtime.teamId, 'BUN');
  assert.equal(verified.runtime.rootAgentType, 'team_orchestrator');
});

test('reinstall is idempotent and keeps foreign AGENTS.md content', () => {
  const tw = join(tempDir('mtm-install-'), 'BUN');
  install(tw);
  const agents = join(tw, 'AGENTS.md');
  writeFileSync(agents, `<!-- MTM-PLAYER:BEGIN -->\nplayer block\n<!-- MTM-PLAYER:END -->\n\n${readFileSync(agents, 'utf8')}`);
  const before = ['.codex/config.toml', '.mtm/team-runtime.json', 'team-sdlc-pack/install-manifest.json', 'AGENTS.md'].map(p => readFileSync(join(tw, p), 'utf8'));
  install(tw);
  const after = ['.codex/config.toml', '.mtm/team-runtime.json', 'team-sdlc-pack/install-manifest.json', 'AGENTS.md'].map(p => readFileSync(join(tw, p), 'utf8'));
  assert.deepEqual(after, before);
  assert.match(after[3], /player block/);
  assert.equal((after[3].match(/TEAM-PACK:BEGIN/g) ?? []).length, 1);
  // FMC0ZXFC: auto-review chặn submit vì không thấy ai cho phép luật cơ hội cuối.
  assert.match(after[3], /Last-chance rule \(authorized by the team\)[\s\S]*`submit_work` \(or `publish_item`\) with `lastChance`/);
  assert.match(after[0], /runtime-server\.mjs"\]/);
});

test('installed helper answers initialize and tools/list', async () => {
  const tw = join(tempDir('mtm-install-'), 'BUN');
  install(tw);
  const client = new McpClient(join(tw, 'team-sdlc-pack', 'runtime', 'bin', 'runtime-server.mjs'), process.env);
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'team_runtime');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await client.request('tools/list');
    const names = list.result.tools.map(t => t.name);
    for (const n of ['configure_session', 'prepare_checkout', 'setup_environment', 'login_match', 'report_ready', 'refresh_match',
      'start_work', 'prepare_item', 'publish_item', 'commit_and_push', 'submit_work', 'wait_for_update', 'company_call']) {
      assert.ok(names.includes(n), n);
    }
    for (const t of list.result.tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);
    // readOnlyHint = không qua auto_review: đúng các tool chỉ đọc, không thêm tool ghi nào.
    const readOnly = list.result.tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort();
    assert.deepEqual(readOnly, ['app_data', 'company_tools', 'decide', 'detect_profile', 'job_status', 'match_state', 'next_actions', 'read_item', 'wait_for_update', 'worker_checkpoint']);
    const bad = await client.request('nope/method');
    assert.equal(bad.error.code, -32601);
    const notConfigured = await client.request('tools/call', { name: 'match_state', arguments: {} });
    assert.equal(notConfigured.result.isError, true);
    assert.equal(notConfigured.result.structuredContent.error.code, 'NOT_CONFIGURED');
  } finally {
    client.close();
  }
  const checker = spawnSync(process.execPath, [join(tw, 'team-sdlc-pack', 'runtime', 'scripts', 'check-distribution.mjs'), '--team-workspace', tw], { encoding: 'utf8' });
  const report = JSON.parse(checker.stdout);
  const failed = report.checks.filter(c => !c.ok).map(c => c.id);
  // Workspace tạm chưa trust nên Codex bỏ qua [features] của nó: hai mục codex phụ thuộc máy, không kiểm ở đây.
  // codegraph: install() của test bỏ qua bước tải (--no-codegraph), codegraph.test.mjs kiểm phần đó.
  assert.deepEqual(failed.filter(id => !['codex trust', 'codex features', 'machine config', 'codegraph'].includes(id)), []);
  assert.ok(report.checks.some(c => c.id === 'codegraph' && /not installed/.test(c.detail)));
  assert.ok(report.checks.some(c => c.id === 'codex features'));
});

// 03/11: capture_evidence chạy trên playwright-core cài cạnh runtime/. Đã có đúng phiên bản thì không gọi npm;
// --no-playwright (chỉ cho test) để lại cảnh báo. Cài lỗi thì installer dừng (không thử được mà không có mạng).
test('installer keeps playwright-core of the pinned version next to runtime/', () => {
  const tw = join(tempDir('mtm-pw-'), 'BUN');
  const skipped = install(tw);
  assert.equal(skipped.playwright, null);
  assert.ok(skipped.warnings.some(w => w.startsWith('PLAYWRIGHT_NOT_INSTALLED')));
  const cfg = JSON.parse(readFileSync(join(REPO, 'pack', 'config', 'playwright.json'), 'utf8'));
  const pkgDir = join(tw, 'team-sdlc-pack', 'playwright', 'node_modules', cfg.package);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: cfg.package, version: cfg.version }));
  const res = spawnSync(process.execPath, [join(REPO, 'pack', 'scripts', 'install.mjs'), '--team-workspace', tw, '--no-codegraph'],
    { encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' } });
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.status, 'READY', res.stdout);
  assert.equal(out.playwright, cfg.version);
  assert.ok(!out.warnings.some(w => w.startsWith('PLAYWRIGHT')));
});
