// E2E không LLM (10 §5, kịch bản 1 rút gọn): frame thật sinh từ hàm của Player, Game Master giả,
// repo git cục bộ. Chạy PREPARE → GAME một item → SUBMITTED, rồi đọc log bằng reducer của Player.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeGameMaster, hasPlayer, install, makeRemote, McpClient, player, sh, tempDir } from './support.mjs';

const MATCH = 'TEST1234';
const MATCH_UUID = '2292cde2-2422-4afb-afa6-d4a782c38a25';
const API_KEY = 'gm_test_key_0123456789abcdef';

test('prepare and play items in worktrees end to end', { skip: !hasPlayer, timeout: 300_000 }, async () => {
  const root = tempDir('mtm-e2e-');
  const tw = join(root, 'BUN');
  install(tw);
  const remote = makeRemote(root, MATCH);
  const repository = { url: remote.url, branch: 'main', folder: MATCH };
  const gm = await fakeGameMaster({ matchId: MATCH, matchUuid: MATCH_UUID, repository, apiKey: API_KEY });
  const env = { ...process.env, MTM_TEAM_TEST_MODE: '1', GIT_CONFIG_GLOBAL: remote.gitconfig, GIT_CONFIG_NOSYSTEM: '1' };

  const { verifyTeamRuntime } = await player('team-install.mjs');
  const { prepareNativePreparation, prepareNativeGameStart, discoverTeamRuntime } = await player('team-runtime.mjs');
  const { submissionPolicyFrame } = await player('submission-policy.mjs');
  const { modelPolicyFrame } = await player('model-policy.mjs');
  const { reduceProgressEvents, readEnvironmentReadyProgress } = await player('progress.mjs');
  const { validateEnvironmentReady } = await player('preparation.mjs');

  const packWs = join(tw, 'team-sdlc-pack');
  const session = {
    status: 'READY', sensitive: true, persistence: 'PLAYER_CONVERSATION_ONLY', playerSessionId: randomUUID(),
    teamWorkspace: tw, challengeWorkspace: join(tw, 'matches'), teamSdlcPackWorkspace: packWs,
    teamRuntime: verifyTeamRuntime({ teamWorkspace: tw, teamSdlcPackWorkspace: packWs }),
    gameMasterApiUrl: gm.origin, gameMasterPlayerSecret: 'bootstrap-secret', schemaVersion: 1, matchId: MATCH,
    teamUuid: randomUUID(), teamId: 'BUN', teamName: 'BUN', username: 'team-bun', password: 'pw-123456',
    apiKeySecret: API_KEY, apiKeyScopes: ['submission:create'], gameMasterUrl: gm.origin, matchPageUrl: `${gm.origin}/match`,
    repository, preparationComplete: null, teamInfoRequestId: 'req_team', allowedApiOrigins: [gm.origin]
  };
  const manifest = discoverTeamRuntime(tw).manifest;
  const policy = { schemaVersion: 2, orchestratorModel: 'gpt-test', orchestratorReasoningEffort: 'medium', allowedModels: ['gpt-test'],
    enforcement: 'OBSERVE_ONLY', catalogSource: 'TEST', catalogFetchedAt: new Date().toISOString() };
  const prep = modelPolicyFrame(prepareNativePreparation(session, manifest, { availableAgentTypes: ['team_orchestrator'] }, 'prepare-abc'), policy);

  const client = new McpClient(join(packWs, 'runtime', 'bin', 'runtime-server.mjs'), env);
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    // ---------------- PREPARE
    const configured = await client.call('configure_session', { frame: `Some prompt text.\n\n${prep.spawn.message}` });
    assert.equal(configured.phase, 'PREPARE');
    assert.equal(configured.models.orchestratorModel, 'gpt-test');
    const checkout = await client.call('prepare_checkout');
    assert.match(checkout.revision, /^[a-f0-9]{40}$/);
    writeFileSync(join(packWs, 'local', 'machine.json'), JSON.stringify({ databasePassword: 'db pass' }));
    let job = await client.call('setup_environment', { waitSeconds: 45 });
    while (job.state === 'running') job = await client.call('job_status', { jobId: job.jobId, waitSeconds: 45 });
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.result.build, 'PASS', JSON.stringify(job.result));
    assert.equal(job.result.baseline.counts.total, 2);
    const envFile = readFileSync(join(tw, 'matches', MATCH, MATCH, 'src', '.env'), 'utf8');
    assert.match(envFile, /postgresql:\/\/app:db%20pass@/);
    assert.doesNotMatch(envFile, /CHANGE_ME/);
    const login = await client.call('login_match');
    assert.equal(login.identityVerified, true);
    assert.equal(login.matchUuidFound, true);
    assert.ok(Array.isArray(login.networkActivity) && login.networkActivity.length >= 2);
    const ready = await client.call('report_ready');
    assert.equal(ready.written, true);
    const again = await client.call('report_ready');
    assert.equal(again.written, false);

    const envReady = readEnvironmentReadyProgress(packWs, MATCH, session.playerSessionId);
    validateEnvironmentReady(envReady, { requestId: 'prepare-abc', repository, testMode: true });

    // ---------------- GAME
    gm.state.status = 'IN_PROGRESS';
    gm.state.backlog = [{ key: 'TASK-01', type: 'TASK', title: 'Greeting says hello world', status: 'OPEN', points: 100,
      deadlineMinutes: 20, revealedElapsedSec: 0, revisionNo: 1, description: 'Change greet() to return "hello world".' },
    { key: 'TASK-02', type: 'TASK', title: 'Add a farewell helper', status: 'OPEN', points: 50,
      deadlineMinutes: null, revealedElapsedSec: 0, revisionNo: 1, description: 'Add bye().' }];
    gm.state.seq = 2;
    const receipt = { schemaVersion: 1, status: 'PREPARED', playerSessionId: session.playerSessionId, teamId: 'BUN', matchId: MATCH,
      preparationRequestId: 'prepare-abc', environmentRevision: checkout.revision, gameMasterRequestId: null };
    const start = modelPolicyFrame(submissionPolicyFrame(prepareNativeGameStart(session, manifest, receipt, 'start-abc')), policy);
    const game = await client.call('configure_session', { frame: start.followup.message });
    assert.equal(game.phase, 'GAME');
    assert.ok(game.submissionPolicy.canonicalSubmitFile.endsWith('answers/<BACKLOG-ID>/submit.json'));
    const refreshed = await client.call('refresh_match');
    assert.equal(refreshed.items.length, 2);
    assert.equal(refreshed.items.find(i => i.key === 'TASK-01').minutesLeft, 20);
    const work = await client.call('start_work', { backlogItemKey: 'TASK-01', requiredScenarios: 1 });
    assert.equal(work.submitTemplate.status, 'DRAFT');
    assert.deepEqual(work.files, ['challenge/TASK-01-submit.json', 'challenge/TASK-01-submit.schema.json']);
    await client.call('start_work', { backlogItemKey: 'TASK-02', requiredScenarios: 1 });

    // Mỗi item một worktree; chờ job chuẩn bị (.env + install) xong.
    const settle = async j => { while (j.state === 'running') j = await client.call('job_status', { jobId: j.jobId, waitSeconds: 45 }); return j; };
    const wt1 = await client.call('worktree', { action: 'create', backlogItemKey: 'TASK-01' });
    const wt2 = await client.call('worktree', { action: 'create', backlogItemKey: 'TASK-02' });
    for (const w of [wt1, wt2]) assert.equal((await settle({ jobId: w.setupJobId, state: 'running' })).result.ok, true);
    assert.equal(JSON.parse(readFileSync(wt1.answerFile, 'utf8')).status, 'DRAFT');
    const wtEnv = readFileSync(join(wt1.matchRoot, 'src', '.env'), 'utf8');
    assert.match(wtEnv, /db%20pass/);

    // "fixer" TASK-02 sửa dở trong worktree của nó (không tích hợp)
    writeFileSync(join(wt2.matchRoot, 'src', 'bye.js'), 'module.exports = () => "bye";\n');
    // "fixer" TASK-01: sửa code + điền answer + evidence trong worktree của nó
    writeFileSync(join(wt1.matchRoot, 'src', 'lib.js'), 'module.exports = { greet: () => "hello world" };\n');
    writeFileSync(join(wt1.evidenceDir, 'TASK-01-TC-01.json'), JSON.stringify({ scenario: 'greet', result: 'passed' }));
    writeFileSync(wt1.answerFile, JSON.stringify({ backlogId: 'TASK-01', status: 'SUBMITTED',
      changeSummary: 'greet() now returns hello world.', evidence: ['evidence/TASK-01-TC-01.json'] }, null, 2));

    const gate = await settle(await client.call('run_gate', { backlogItemKey: 'TASK-01', waitSeconds: 45 }));
    assert.equal(gate.result.passed, true, JSON.stringify(gate.result));
    assert.equal(gate.result.where, 'worktree');
    assert.equal(gate.result.checks.find(c => c.name === 'answer').schema, true);
    // Kịch bản chưa chạy không bao giờ được tính là PASSED (Practice #1, L4).
    const pending = await client.call('record_verification', { backlogItemKey: 'TASK-01', gateJobId: gate.jobId,
      scenariosPassed: 0, scenariosFailed: 0, scenariosSkipped: 1 });
    assert.equal(pending.status, 'RUNNING');
    assert.match(pending.hint, /Not PASSED/);
    const verification = await client.call('record_verification', { backlogItemKey: 'TASK-01', gateJobId: gate.jobId,
      scenariosPassed: 1, scenariosFailed: 0, scenariosSkipped: 0 });
    assert.equal(verification.status, 'PASSED');
    const integrated = await client.call('worktree', { action: 'integrate', backlogItemKey: 'TASK-01', message: 'return hello world' });
    assert.equal(integrated.baseChanged, false);
    const pushed = await client.call('commit_and_push', { backlogItemKey: 'TASK-01', message: 'return hello world' });
    assert.equal(sh('git', ['--git-dir', remote.bare, 'rev-parse', 'refs/heads/main'], root), pushed.revision);
    const pushedFiles = sh('git', ['--git-dir', remote.bare, 'show', '--name-only', '--format=', pushed.revision], root).split('\n');
    assert.ok(pushedFiles.includes(`${MATCH}/src/lib.js`));
    assert.ok(!pushedFiles.some(f => f.includes('bye.js')), 'work of another item leaked into the commit');
    const submitted = await client.call('submit_work', { backlogItemKey: 'TASK-01', gitRevision: pushed.revision });
    assert.equal(submitted.status, 'SUBMITTED');
    const replay = await client.call('submit_work', { backlogItemKey: 'TASK-01', gitRevision: pushed.revision });
    assert.equal(replay.receiptId, submitted.receiptId);
    const sent = [...gm.state.submissions.values()][0].parsed;
    assert.equal(sent.gitRevision, pushed.revision);
    assert.equal(sent.answer.status, 'SUBMITTED');
    assert.equal(gm.state.submissions.size, 1);

    // Secret không bao giờ lọt ra kết quả tool
    const state = await client.call('match_state');
    assert.doesNotMatch(JSON.stringify(state), new RegExp(API_KEY));

    // ---------------- log qua reducer của Player
    const lines = readFileSync(join(packWs, 'logs', `${MATCH}.progress.ndjson`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const snapshot = reduceProgressEvents(lines, { playerSessionId: session.playerSessionId, teamId: 'BUN', teamName: 'BUN' });
    for (const stage of ['GIT_AUTH', 'REPOSITORY', 'ENVIRONMENT', 'BUILD', 'MATCH_LOGIN']) assert.equal(snapshot.preparation[stage].status, 'COMPLETED', stage);
    assert.equal(snapshot.gameStart.BACKLOG_SYNC.status, 'COMPLETED');
    const task = snapshot.backlogs.find(b => b.id === 'TASK-01');
    assert.equal(task.status, 'SUBMITTED');
    assert.equal(task.receiptId, submitted.receiptId);
    assert.equal(task.tests.status, 'PASSED');
    assert.ok(Buffer.byteLength(lines.map(l => JSON.stringify(l)).join('\n')) < 30_000);
    const log = readFileSync(join(packWs, 'logs', `${MATCH}.progress.ndjson`), 'utf8');
    assert.doesNotMatch(log, /pw-123456|gm_test_key/);
    const digest = createHash('sha256').update(log).digest('hex');
    assert.ok(digest);
  } finally {
    client.close();
    gm.close();
  }
});
