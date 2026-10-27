// Installer: kết quả phải qua đúng bước kiểm của Player (verifyTeamRuntime) và cài lại idempotent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, hasPlayer, install, McpClient, player, tempDir } from './support.mjs';

test('pack agents and skills are in sync with agents/', () => {
  const res = spawnSync(process.execPath, [join(REPO, 'tools', 'sync-agents.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `run node tools/sync-agents.mjs\n${res.stderr}`);
});

// Practice #5: agent chỉ mở skill/tham khảo được chỉ đích danh trong prompt của nó.
test('every subagent is told which skills and references to read', () => {
  const prompt = role => readFileSync(join(REPO, 'pack', 'agents', `team-${role}.toml`), 'utf8');
  const fixer = prompt('fixer');
  for (const f of ['backlog-references/bug-patterns.md', 'backlog-references/pi-triage.md', 'backlog-references/retry-playbook.md']) {
    assert.ok(fixer.includes(f), `fixer prompt names ${f}`);
  }
  assert.match(prompt('reviewer'), /read the skill named in the brief/);
  assert.match(prompt('pi-hypothesis'), /backlog-references\/pi-triage\.md/);
  const playbook = readFileSync(join(REPO, 'pack', 'skills', 'backlog-references', 'retry-playbook.md'), 'utf8');
  assert.doesNotMatch(playbook, /previous change is gone/, 'the pack keeps the worktree between attempts');
  assert.match(readFileSync(join(REPO, 'pack', 'skills', 'team-orchestrator', 'SKILL.md'), 'utf8'), /Every new attempt is a new `spawn_agent`/);
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
      'start_work', 'run_gate', 'record_verification', 'commit_and_push', 'submit_work', 'wait_for_update', 'company_call']) {
      assert.ok(names.includes(n), n);
    }
    for (const t of list.result.tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);
    // readOnlyHint = không qua auto_review: đúng các tool chỉ đọc, không thêm tool ghi nào.
    const readOnly = list.result.tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort();
    assert.deepEqual(readOnly, ['app_data', 'company_tools', 'decide', 'detect_profile', 'job_status', 'match_state', 'read_item', 'wait_for_update']);
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
