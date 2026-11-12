// Kiểm workflow với git/worktree thật; không gọi LLM hay mạng ngoài.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../../pack/src/tools.mjs';
import { itemDependencies, itemSkills, pageScripts } from '../../pack/src/match/workflow.mjs';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Jobs } from '../../pack/src/core/jobs.mjs';
import { digest, resultArtifact } from '../../pack/src/core/candidates.mjs';
import { recordEvidence, evidenceProblems } from '../../pack/src/env/evidence.mjs';
import { localRuntime, sh, tempDir, validFixResult } from './support.mjs';

const fix = overrides => validFixResult({ summary: 'Fixed value', criteria: ['correct'], verification: [{ check: 'TC-1', command: null, result: 'pass', note: 'observed' }],
  requirements: [{ id: 'AC-1', status: 'met', evidence: 'src/lib.js:1' }], ...overrides });

// files: thêm file (đường dẫn trong M1/) vào commit gốc, có mặt ở cả checkout chính lẫn worktree.
function fixture(key = 'BUG-01', answerOnly = false, files = {}) {
  const root = tempDir('mtm-workflow-'), bare = join(root, 'remote.git'), checkout = join(root, 'checkout');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare], root); sh('git', ['clone', '-q', bare, checkout], root);
  sh('git', ['config', 'user.name', 'test'], checkout); sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  mkdirSync(join(checkout, 'M1', 'src'), { recursive: true }); writeFileSync(join(checkout, 'M1', 'src', 'lib.js'), 'export const value=1;\n');
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(checkout, 'M1', rel)), { recursive: true }); writeFileSync(join(checkout, 'M1', rel), text); }
  writeFileSync(join(checkout, '.git', 'info', 'exclude'), '.team-work/\n.env\n');
  sh('git', ['add', 'M1'], checkout); sh('git', ['commit', '-q', '-m', 'seed'], checkout); sh('git', ['push', '-q', 'origin', 'HEAD:main'], checkout);
  localRuntime(root, {});
  const rt = new Runtime({ teamWorkspace: root }), teamWork = join(checkout, '.team-work'); mkdirSync(teamWork);
  // Các test ở đây đi đường root publish (đường dự phòng); helper tự publish mọi loại item có test riêng ở cuối file.
  const cfg0 = rt.runtimeConfig.bind(rt); rt.runtimeConfig = () => ({ ...cfg0(), autoPublishAll: false });
  rt.session.paths = { checkoutRoot: checkout, matchRoot: join(checkout, 'M1'), teamWork }; rt.session.phase = 'GAME'; rt.session.require = () => {};
  rt.session.descriptor = { matchId: 'M1', repository: { branch: 'main' } }; rt.journalObj = new Journal(teamWork);
  rt.writer = { state: { backlogs: { [key]: { status: 'IN_PROGRESS' } }, blockers: {}, bytes: 0 }, events: [], write(e) { this.events.push(e); if (e.type === 'BACKLOG_STATUS') this.state.backlogs[key].status = e.status; } };
  rt.minutesLeft = () => 30; rt.releases = () => null; rt.itemRows = () => [{ key, type: key.split('-')[0], status: 'OPEN', local: 'started', minutesLeft: 30 }];
  rt.gm.view = { status: 'IN_PROGRESS', items: [{ key, title: key, raw: { descriptionMd: answerOnly ? '## Question\nFind position.\n## Answer format\nOne string.' : '## Acceptance criteria\n1. Correct value.' } }] };
  rt.gm.itemMinutesLeft = () => 30;
  const wt = rt.wtPaths(key); mkdirSync(join(teamWork, 'wt'), { recursive: true }); sh('git', ['worktree', 'add', '-q', '--detach', wt.worktreeRoot, 'HEAD'], checkout);
  const ji = rt.journal.item(key); Object.assign(ji, { startedAt: new Date().toISOString(), worktreeBase: sh('git', ['rev-parse', 'HEAD'], checkout), verificationKind: answerOnly ? 'answer_only' : 'mvs', workerState: 'yielded' });
  const materials = join(teamWork, 'items', key), results = join(teamWork, 'results'), dir = join(wt.matchRoot, 'answers', key);
  mkdirSync(materials, { recursive: true }); mkdirSync(results); mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(materials, 'template.json'), JSON.stringify(answerOnly ? { status: 'NOT_STARTED', position: '' } : { status: 'NOT_STARTED', testResults: [{ id: 'TC-1', result: 'NOT_RUN', evidence: [] }] }));
  writeFileSync(join(materials, 'page.json'), JSON.stringify(rt.gm.view.items[0].raw));
  writeFileSync(join(dir, 'submit.json'), JSON.stringify(answerOnly ? { status: 'DONE', position: '2' } : { status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: [] }] }));
  if (!answerOnly) writeFileSync(join(wt.matchRoot, 'src', 'lib.js'), 'export const value=2;\n');
  const result = (n, value = fix(answerOnly ? { requirements: [], verification: [{ check: 'derive', command: null, result: 'pass', note: 'source' }] } : {})) => {
    const file = join(results, `${key}-fixer-${n}.json`); writeFileSync(file, JSON.stringify(value)); return file;
  };
  const preflight = file => rt.workflow.preflight({ backlogItemKey: key, fixResultFile: file });
  return { root, bare, checkout, rt, key, ji, wt, dir, results, result, preflight };
}

test('contract errors name fields and reject result sibling directories', async () => {
  const f = fixture(); await assert.rejects(f.preflight(f.result(1, { status: 'fixed' })), /RESULT_INVALID.*root_cause/);
  const dir = join(f.results, '..', 'results-other'); mkdirSync(dir); const file = join(dir, 'result.json'); writeFileSync(file, JSON.stringify(fix({})));
  assert.throws(() => resultArtifact(f.results, file, 'fix-result'), /PATH_NOT_ALLOWED/);
});

test('immutable handoffs: a handed-off result never changes and later edits make the candidate stale', async () => {
  const f = fixture(), one = f.result(1), p = await f.preflight(one);
  writeFileSync(join(f.dir, 'evidence', 'new.csv'), 'a,b\r\n1,2\r\n'); const two = f.result(2), p2 = await f.preflight(two);
  assert.notEqual(p2.candidateId, p.candidateId);
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=3;\n'); await assert.rejects(f.rt.workflow.assertCandidate(f.key), /CANDIDATE_STALE/);
  writeFileSync(two, JSON.stringify(fix({ summary: 'overwritten' }))); await assert.rejects(f.preflight(two), /RESULT_MUTATED/);
});

test('preflight only reports missing evidence/scenarios/requirements and forbids sync during worker writes', async () => {
  const f = fixture(); f.rt.itemEvidence = () => [{ file: 'export.csv', beforeFix: false }];
  const p = await f.preflight(f.result(1, fix({ status: 'partial', requirements: [{ id: 'AC-1', status: 'not_met', evidence: 'Need final screenshot' }], verification: [{ check: 'TC-1', command: null, result: 'not_run', note: 'Download CSV' }] })));
  assert.equal(f.ji.candidate.state, 'ready', 'nothing blocks the publish'); assert.ok(p.warnings.some(w => w.includes('export.csv')));
  assert.deepEqual(f.rt.workflow.actions().nextActions.map(a => a.action), ['publish_item']);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume', threadId: 'native-1' }); await assert.rejects(f.rt.worktree({ action: 'sync', backlogItemKey: f.key }), /WORKER_BUSY/);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'ready_for_evidence' }); assert.equal((await f.rt.worktree({ action: 'sync', backlogItemKey: f.key })).synced, false);
});

test('changed ignored env after the handoff makes the candidate stale', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file);
  writeFileSync(join(f.wt.matchRoot, '.env'), 'DATABASE_URL=changed\n'); await assert.rejects(f.rt.workflow.assertCandidate(f.key), /CANDIDATE_STALE/);
});

test('preflight distinguishes required scenario outcomes from diagnostic failures', async () => {
  const f = fixture();
  const file = f.result(1, fix({ verification: [
    { check: 'TC-1', command: null, result: 'pass', note: 'observed' },
    { check: 'diagnostic-before', command: null, result: 'fail', note: 'observed on original code; not a required MVS scenario' }
  ] }));
  const p = await f.preflight(file); assert.equal(f.ji.candidate.id, p.candidateId); assert.equal(f.ji.candidate.state, 'ready');
});

test('publish replays an identical intent after restart/lost response without duplicate receipt', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file);
  const bodies = [], receipt = randomUUID(); f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() });
  f.rt.gm.postSubmission = async (key, intent) => { bodies.push(intent.body); if (bodies.length === 1) throw Error('lost response'); return { kind: 'SUBMITTED', submission: { id: receipt } }; };
  const first = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(first.jobId).promise;
  assert.equal(f.rt.jobs.jobs.get(first.jobId).state, 'failed'); assert.ok(f.ji.publishedRevision);
  f.rt.journalObj = new Journal(f.rt.session.paths.teamWork); f.rt.jobs = new Jobs();
  const next = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(next.jobId).promise;
  assert.equal(f.rt.jobs.jobs.get(next.jobId).result.status, 'SUBMITTED'); assert.equal(bodies[0], bodies[1]);
  assert.equal((await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId })).result.replay, true); assert.equal(bodies.length, 2);
});

test('manifest preserves before-fix separately and detects stale final source/modified bytes', async () => {
  const f = fixture(), snapshot = await f.rt.workflow.snapshot(f.key), path = join(f.dir, 'evidence', 'shot.png'); writeFileSync(path, 'bytes');
  const entry = { path, name: 'shot.png', phase: 'before_fix', source: 'old', environment: 'old', sha256: digest(readFileSync(path)) };
  const problems = () => evidenceProblems(f.rt.session.paths.teamWork, f.key, f.wt.matchRoot, snapshot);
  recordEvidence(f.rt.session.paths.teamWork, f.key, entry); assert.deepEqual(await problems(), []);
  recordEvidence(f.rt.session.paths.teamWork, f.key, { ...entry, phase: 'final' }); assert.match((await problems())[0], /older source/);
  recordEvidence(f.rt.session.paths.teamWork, f.key, { ...entry, ...snapshot, phase: 'final' }); assert.deepEqual(await problems(), []);
  writeFileSync(path, 'changed'); assert.match((await problems())[0], /bytes changed/);
});

test('source index refresh uses the yielded worktree after sync', async () => {
  const f = fixture(), calls = [];
  f.rt.refreshCodegraph = async (key, matchRoot) => {
    calls.push({ key, matchRoot, workerState: f.ji.workerState });
    return { name: 'codegraph', freshness: 'unknown', code: 3 };
  };
  const main = f.rt.session.paths.matchRoot;
  writeFileSync(join(main, 'src', 'helper.js'), 'export const helper = true;\n');
  sh('git', ['add', 'M1/src/helper.js'], f.checkout); sh('git', ['commit', '-q', '-m', 'shared helper'], f.checkout);
  const synced = await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
  assert.equal(synced.synced, true);
  assert.equal(synced.codegraph.freshness, 'unknown', 'optional index failure must not break sync');
  assert.ok((await f.preflight(f.result(1))).candidateId);
  assert.deepEqual(calls, [{ key: f.key, matchRoot: f.wt.matchRoot, workerState: 'yielded' }]);
});

test('prepare is idempotent and returns worker brief inputs without repeating Start Work', async () => {
  const f = fixture(); let starts = 0; f.rt.startWork = async () => { starts++; return { triage: { models: {} }, materialsDir: 'materials', timeBox: {} }; };
  f.rt.worktree = async () => ({ ...f.wt, setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key }); await f.rt.jobs.jobs.get(j.jobId).promise; const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.worker, 'team_fixer'); assert.equal(done.result.worktree.matchRoot, f.wt.matchRoot);
  assert.equal((await f.rt.workflow.prepare({ backlogItemKey: f.key })).jobId, j.jobId); assert.equal(starts, 1);
});

// BTZNI69E: đề ra → Start Work 11–93 s (prepare_item của root qua guardian, lần lượt), chuẩn bị xong → spawn 56–217 s
// (root tự tra Company Tools, đọc skill, soạn brief). Helper tự prepare một lần, lấy trước dữ liệu công ty, viết brief
// và đưa sẵn đối số spawn_agent vào nextActions.
test('the helper prepares a new item itself once, prefetches company facts, writes the brief and hands root the spawn arguments', async () => {
  const f = fixture('CR-01');
  const base = f.rt.runtimeConfig.bind(f.rt);
  f.rt.runtimeConfig = () => ({ ...base(), analyst: false });   // luồng analyst có test riêng ở cuối file
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, worktreeBase: undefined });
  f.rt.itemRows = () => [{ key: f.key, type: 'CR', status: 'OPEN', local: f.ji.prepared ? 'started' : 'todo', minutesLeft: 30 }];
  f.rt.gm.view.items[0].raw = { title: 'Export the filtered invoice list as CSV', points: 140,
    descriptionMd: '## Context\nAccountants import invoice lists.\n## Requirements\nFollow the company data-exchange standard. Verify with the official QA test data.\n' };
  let starts = 0;
  f.rt.startWork = async () => { starts++; return { type: 'CR', triage: { models: { fixer: [{ model: 'gpt-6.1-sol', reasoning_effort: 'high' }] } },
    materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), files: ['challenge/CR-01-seed.ts'], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' },
    requirements: [{ id: 'AC-1', text: 'CSV' }], baselineFailures: null }; };
  f.rt.worktree = async () => ({ ...f.wt, issuedRevision: 'abc123', setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
  const called = [];
  f.rt.company.list = async () => [{ name: 'kb_search', inputSchema: {} }, { name: 'get_test_data', inputSchema: {} }, { name: 'search_logs', inputSchema: {} }];
  f.rt.company.invoke = async (name, args) => { called.push([name, args]); return { content: [{ type: 'text', text: `${name} result` }] }; };
  assert.deepEqual(f.rt.workflow.autoPrepare(), [f.key]);
  assert.deepEqual(f.rt.workflow.autoPrepare(), [], 'one automatic prepare per item');
  await f.rt.jobs.jobs.get(f.ji.prepareJobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(f.ji.prepareJobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(starts, 1);
  assert.deepEqual(called.map(c => c[0]).sort(), ['get_test_data', 'kb_search']);
  assert.match(called.find(c => c[0] === 'kb_search')[1].query, /export.*invoice/);
  const brief = readFileSync(done.result.briefFile, 'utf8');
  for (const re of [/<item_meta>[\s\S]*return_by: 2099-11-04T05:00:00.000Z/, /issuedRevision: abc123/, /results_path: .*CR-01-fixer-1\.json/,
    /<requirements>[\s\S]*AC-1/, /<company_facts>[\s\S]*kb_search: .*0[12]-kb_search\.json/, /<company_facts>[\s\S]*get_test_data: .*0[12]-get_test_data\.json/, /company_lookup/, /<item>[\s\S]*official QA test data/]) {
    assert.match(brief, re);
  }
  // 9O802QWE: 2–3 lượt đầu chỉ để mở 4–6 file skill. Brief chép sẵn chúng, sau <item> (output bị cắt thì mất skill, không mất đề).
  assert.match(brief, /fix_result_schema: .*fix-result\.schema\.json/);
  const skills = brief.slice(brief.indexOf('<skill_text>'));
  assert.ok(brief.indexOf('<skill_text>') > brief.indexOf('</item>'), 'skills come after the item');
  for (const rel of ['backlog-references/SKILL.md', 'backlog-cr/SKILL.md', 'stack-notes/unknown.md', 'backlog-references/domain-checks.md', 'backlog-references/evidence-playbook.md']) {
    assert.ok(skills.includes(`=== .agents/skills/${rel} ===`), rel);
  }
  assert.doesNotMatch(skills, /bug-patterns\.md ===|^---\nname:/m, 'no BUG reference, no front matter');
  const spawn = f.rt.workflow.actions().nextActions.find(a => a.action === 'spawn_worker')?.spawn;
  assert.deepEqual([spawn?.task_name, spawn?.agent_type, spawn?.fork_turns, spawn?.model, spawn?.reasoning_effort], ['cr01_fixer', 'team_fixer', 'none', 'gpt-6.1-sol', 'high']);
  assert.match(spawn.message, /brief\.md/);
  assert.equal(f.ji.workerThread, undefined, 'root read_item during prepare does not confirm a spawn');
  assert.ok(f.rt.workflow.actions().nextActions.some(a => a.action === 'spawn_worker'), 'a failed native spawn stays retryable');
  await f.rt.proxyCall('read_item', { backlogItemKey: f.key });
  assert.equal(f.ji.workerThread, '/root/cr01_fixer'); assert.equal(f.ji.workerState, 'writing');
  assert.equal(f.rt.workflow.blockedCheckpoint({ backlogItemKey: f.key, question: 'Need root decision' }).writesAllowed, true,
    'the worker may write without a resume after spawn');
  assert.ok(!f.rt.workflow.actions().nextActions.some(a => a.action === 'spawn_worker'));
});

function spawnWaveFixture({ delay = 120, secondWave = 0, fail = false } = {}) {
  const f = fixture(), keys = [f.key, 'BUG-02'];
  f.rt.itemRows = () => keys.map(key => ({ key, type: 'BUG', status: 'OPEN', local: 'started', minutesLeft: 30 }));
  f.rt.gm.view.items[0].raw.revealedElapsedSec = 0;
  f.rt.gm.view.items.push({ key: 'BUG-02', raw: { revealedElapsedSec: secondWave } });
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 600_000).toISOString() } };
  f.ji.spawn = { task_name: 'bug01_fixer' };
  const second = f.rt.journal.item('BUG-02');
  const job = f.rt.jobs.start('prepare_item', async () => {
    await new Promise(r => setTimeout(r, delay));
    if (fail) throw Error('prepare failed');
    second.prepared = f.ji.prepared; second.spawn = { task_name: 'bug02_fixer' };
  }, { key: 'BUG-02' });
  second.prepareJobId = job.id;
  return { ...f, second, job };
}

test('wait_for_update coalesces two prepare jobs in one wave and keeps both spawns retryable until worker activity', async () => {
  const f = spawnWaveFixture(), start = Date.now();
  const res = await f.rt.waitForUpdate({ cursor: -1, timeoutMs: 0 });
  assert.deepEqual(res.nextActions.map(a => a.key).sort(), ['BUG-01', 'BUG-02']);
  assert.ok(Date.now() - start >= 80); assert.ok(Date.now() - start < 2000);
  assert.ok(res.events.some(e => e.type === 'JOB_DONE' && e.jobId === f.job.id));
  assert.deepEqual(f.rt.workflow.actions().nextActions.map(a => a.key).sort(), ['BUG-01', 'BUG-02']);
});

test('spawn coalescing is capped at two seconds and does not wait for a different wave or urgent work', async () => {
  const slow = spawnWaveFixture({ delay: 3200 }), start = Date.now();
  const res = await slow.rt.waitForUpdate({ cursor: -1, timeoutMs: 0 });
  assert.deepEqual(res.nextActions.map(a => a.key), ['BUG-01']);
  assert.ok(Date.now() - start >= 1800); assert.ok(Date.now() - start < 3000);
  await slow.job.promise;
  const later = spawnWaveFixture({ secondWave: 480, delay: 700 }), since = Date.now();
  assert.deepEqual((await later.rt.waitForUpdate({ cursor: -1, timeoutMs: 0 })).nextActions.map(a => a.key), ['BUG-01']);
  assert.ok(Date.now() - since < 500); await later.job.promise;
  const urgent = spawnWaveFixture({ delay: 700 }); urgent.ji.question = { text: 'Root decision', at: new Date().toISOString() };
  urgent.ji.workerThread = '/root/bug01_fixer';
  const now = Date.now();
  assert.equal((await urgent.rt.waitForUpdate({ timeoutMs: 0 })).nextActions[0].action, 'answer_worker');
  assert.ok(Date.now() - now < 500); await urgent.job.promise;
});

test('coalescing exits on prepare failure or abort and a late worker call cannot reopen yielded writes', async () => {
  const failed = spawnWaveFixture({ fail: true });
  assert.equal((await failed.rt.waitForUpdate({ timeoutMs: 0 })).nextActions[0].key, 'BUG-01');
  assert.equal(failed.job.state, 'failed');
  const f = spawnWaveFixture({ delay: 500 }), controller = new AbortController();
  const wait = f.rt.waitForUpdate({ timeoutMs: 0 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const since = Date.now(); await wait; assert.ok(Date.now() - since < 400); await f.job.promise;
  f.ji.workerState = 'yielded'; f.rt.workflow.registerWorker(f.key);
  assert.equal(f.ji.workerState, 'yielded'); assert.equal(f.ji.workerThread, '/root/bug01_fixer');
});

// Item đang prepare (Start Work chưa xong, vẫn todo) giữ slot: tick sau của poller không tự prepare quá maxItemsInFlight.
test('an item being prepared holds its slot, so the next automatic prepare waits for a free one', async () => {
  const f = fixture('BUG-01');
  localRuntime(f.root, { maxItemsInFlight: 1 });
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, worktreeBase: undefined });
  f.rt.itemRows = () => ['BUG-01', 'BUG-02'].map(key => ({ key, type: 'BUG', status: 'OPEN', local: 'todo', minutesLeft: 30 }));
  f.rt.gm.view.items.push({ key: 'BUG-02', title: 'BUG-02', raw: { descriptionMd: '## Acceptance criteria\n1. Correct.' } });
  f.rt.startWork = () => new Promise(() => {});
  const first = f.rt.workflow.autoPrepare();
  assert.equal(first.length, 1);
  assert.deepEqual(f.rt.workflow.autoPrepare(), [], 'the only slot is taken by the item being prepared');
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.action === 'prepare_item'), []);
});

// Bench đo từ lúc đề ra (đồng hồ server, updatedAt của bản đầu), không từ lúc helper thấy; view đầu tiên được đối chiếu
// với "chưa có gì" nên đợt đầu cũng có ITEM_NEW dù login_match đã fetch trước.
test('discovery keeps the server release time and the first view raises ITEM_NEW', () => {
  const f = fixture('BUG-01');
  delete f.ji.discoveredAt;
  const view = { status: 'IN_PROGRESS', events: [], items: [{ key: 'BUG-01', type: 'BUG', title: 'x', status: 'OPEN', revisionNo: 1,
    raw: { updatedAt: '2026-11-04T04:08:08.298Z', revealedElapsedSec: 0 } }] };
  f.rt.gm.view = view;
  f.rt.absorb(view);
  assert.equal(f.ji.releasedAtServer, '2026-11-04T04:08:08.298Z');
  assert.equal(f.ji.revealedElapsedSec, 0);
  assert.ok(f.ji.discoveredAt);
  assert.deepEqual(f.rt.events.since(0).map(e => [e.type, e.key]), [['ITEM_NEW', 'BUG-01']]);
  f.rt.absorb(view);
  assert.equal(f.rt.events.since(0).length, 1, 'same view, no new event');
});

// D: tra cứu chỉ đọc không qua guardian, cho cả worker qua proxy; tool không phải tra cứu vẫn phải qua company_call.
test('company_lookup is a read-only lookup for root and workers and refuses tools that are not lookups', async () => {
  const f = fixture('PI-01');
  const tool = f.rt.definitions().find(t => t.name === 'company_lookup');
  assert.equal(tool.readOnly, true);
  f.rt.company.list = async () => [{ name: 'search_logs', inputSchema: {} }, { name: 'create_ticket', inputSchema: {} }];
  f.rt.company.invoke = async name => ({ content: [{ type: 'text', text: `${name} ok` }] });
  const res = await f.rt.proxyCall('company_lookup', { name: 'search_logs', arguments: { query: 'reminder', service: 'reminder-worker' }, backlogItemKey: f.key });
  assert.ok(existsSync(res.savedTo), 'saved beside the item materials');
  await assert.rejects(async () => f.rt.companyLookup({ name: 'create_ticket', backlogItemKey: f.key }), /NOT_A_LOOKUP/);
  await assert.rejects(async () => f.rt.companyLookup({ name: 'search_logs' }), /backlogItemKey/);
});

// QDO8W480: PI-02 (hạn 10 phút) tra 2 truy vấn × 507 giờ = 1015 lời gọi; job chạy 19 phút, xong sau khi item đóng.
test('a bulk log lookup that cannot finish before return_by is refused at once with what still fits', async () => {
  const f = fixture('PI-01');
  f.rt.company.list = async () => [{ name: 'search_logs', inputSchema: {} }];
  const weights = [];
  f.rt.company.invoke = async (name, args, opts) => { weights.push(opts?.weight ?? 0); return { content: [{ type: 'text', text: JSON.stringify({ total: 0, returned: 0, entries: [] }) }] }; };
  f.rt.company.ratePerMinute = () => 100;
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 4 * 60_000).toISOString() } };
  const big = { name: 'search_logs', backlogItemKey: f.key, queries: [{ service: 'rules' }, { service: 'deploy' }], hours: { from: '2025-10-14T00', to: '2025-11-03T09' } };
  await assert.rejects(async () => f.rt.companyLookup(big), e => e.code === 'LOOKUP_TOO_LARGE'
    && /needs at least 980 calls \(2 queries × 490 hours\): about 10 minutes at 100 calls a minute/.test(e.message) && /About 39\d calls fit/.test(e.message));
  assert.equal(weights.length, 0, 'nothing was sent');
  const ok = await f.rt.companyLookup({ ...big, hours: { from: '2025-10-15T08', to: '2025-10-15T12' } });
  assert.equal(ok.result.complete, true);
  assert.deepEqual([...new Set(weights)], [10], 'calls carry the size of their lookup as weight');
  // Không có hạn trả bài (chưa prepare): không chặn.
  delete f.ji.prepared;
  const free = await f.rt.companyLookup(big);
  assert.equal(free.result.calls, 982, '980 lookups and one coverage call per service');
});

test('next actions use the nearest release and offer the publish of a handed-off candidate', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file); f.rt.releases = () => ({ next: { at: new Date(Date.now() + 3000).toISOString() } });
  const next = f.rt.workflow.actions(); assert.ok(next.waitMs <= 4000);
  assert.deepEqual(next.nextActions.map(a => [a.action, a.arguments.candidateId]), [['publish_item', f.ji.candidate.id]]);
});

test('integration recognizes a commit made before a lost checkpoint and does not cherry-pick twice', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file);
  sh('git', ['add', 'M1'], f.wt.worktreeRoot); sh('git', ['commit', '-q', '-m', 'candidate'], f.wt.worktreeRoot);
  const head = sh('git', ['rev-parse', 'HEAD'], f.wt.worktreeRoot), parent = sh('git', ['rev-parse', 'HEAD'], f.checkout);
  f.ji.integratePlan = { head, mainBefore: parent, commits: [head], cursor: 0, pending: { sha: head, parent } }; f.rt.journal.save();
  sh('git', ['cherry-pick', '-x', head], f.checkout); const integrated = sh('git', ['rev-parse', 'HEAD'], f.checkout);
  await f.rt.worktree({ action: 'integrate', backlogItemKey: f.key }); assert.equal(f.ji.integratedRevision, integrated); assert.equal(f.ji.integratePlan, undefined);
});

test('answer repair after integration only integrates new commits and submits the latest handed-off version', async () => {
  const f = fixture(), one = f.result(1); await f.preflight(one); await f.rt.worktree({ action: 'integrate', backlogItemKey: f.key }); f.ji.integratedCandidateId = f.ji.candidate.id;
  const answer = JSON.parse(readFileSync(join(f.dir, 'submit.json'), 'utf8')); answer.note = 'final'; writeFileSync(join(f.dir, 'submit.json'), JSON.stringify(answer));
  const two = f.result(2, fix({ summary: 'repaired answer' })), p = await f.preflight(two);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async (key, intent) => { assert.equal(JSON.parse(intent.body).answer.note, 'final'); return { kind: 'SUBMITTED', submission: { id: randomUUID() } }; };
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise; const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

// PXWV53VC (TASK-01, TASK-02): core.autocrlf=true viết submit.json ra main bằng CRLF; nội dung vẫn là bản đã bàn giao.
test('publish accepts an integrated answer that differs from the handed-off one only by CRLF line endings', async () => {
  const f = fixture(); sh('git', ['config', 'core.autocrlf', 'true'], f.checkout);
  writeFileSync(join(f.dir, 'submit.json'), `${JSON.stringify({ status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: [] }] }, null, 2)}\n`);
  const file = f.result(1), p = await f.preflight(file);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.match(readFileSync(join(f.rt.session.paths.matchRoot, 'answers', f.key, 'submit.json'), 'utf8'), /\r\n/);
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

// QDO8W480: TASK-07 (hạn 15 phút) ra ở phút 19,2 khi 5 slot đều bận, Start Work ở phút 28,3, đóng ở phút 34,4 chưa nộp.
test('an item with its own deadline starts over the slot limit, up to deadlineOverflow; other items wait', () => {
  const f = fixture(); const keys = ['BUG-02', 'CR-01', 'CR-02', 'BUG-04'];
  const todo = (key, extra = {}) => ({ key, type: key.split('-')[0], status: 'OPEN', local: 'todo', minutesLeft: 20, ...extra });
  let waiting = [todo('CR-03'), todo('TASK-07', { deadlineMinutes: 15, minutesLeft: 15 }), todo('CR-08', { deadlineMinutes: 15, minutesLeft: 15 }), todo('CR-09', { deadlineMinutes: 15, minutesLeft: 15 })];
  f.rt.itemRows = () => [...keys.map(key => ({ key, type: key.split('-')[0], status: 'OPEN', local: 'started', minutesLeft: 20 })), ...waiting];
  f.rt.gm.view.items = f.rt.itemRows().map(r => ({ key: r.key, title: r.key, raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } }));
  f.rt.matchState = () => ({ suggestedOrder: [...waiting].sort((a, b) => a.minutesLeft - b.minutesLeft).map(r => r.key) });
  const prepares = () => f.rt.workflow.actions().nextActions.filter(a => a.action === 'prepare_item').map(a => a.key);
  localRuntime(f.root, { maxItemsInFlight: 4 });
  for (const key of keys) Object.assign(f.rt.journal.item(key), { startedAt: new Date().toISOString(), workerState: 'writing' });
  assert.deepEqual(prepares(), ['TASK-07', 'CR-08'], 'two deadline items over the limit; the third and the item without a deadline wait');
  localRuntime(f.root, { maxItemsInFlight: 4, deadlineOverflow: 0 });
  assert.deepEqual(prepares(), []);
  // Một slot thường trống: item có hạn (gần hạn hơn) lấy trước, hai item có hạn nữa vượt giới hạn.
  localRuntime(f.root, { maxItemsInFlight: 5 });
  assert.deepEqual(prepares(), ['TASK-07', 'CR-08', 'CR-09']);
  waiting = [todo('CR-03')];
  assert.deepEqual(prepares(), ['CR-03']);
});

test('a slot is held only while an item still needs its worker, so a new item starts when the others only wait', () => {
  const f = fixture(); const keys = ['BUG-02', 'CR-01', 'CR-02', 'BUG-04'];
  f.rt.itemRows = () => [...keys.map(key => ({ key, type: key.split('-')[0], status: 'OPEN', local: 'started', minutesLeft: 20 })),
    { key: 'CR-03', type: 'CR', status: 'OPEN', local: 'todo', minutesLeft: 20 }];
  f.rt.gm.view.items = f.rt.itemRows().map(r => ({ key: r.key, title: r.key, raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } }));
  const prepares = () => f.rt.workflow.actions().nextActions.filter(a => a.action === 'prepare_item').map(a => a.key);
  localRuntime(f.root, { maxItemsInFlight: 4 });
  // NBDB5U0O 17:02: bốn item đang làm (chưa bàn giao) giữ đủ 4 slot.
  for (const key of keys) Object.assign(f.rt.journal.item(key), { startedAt: new Date().toISOString(), workerState: 'writing' });
  assert.equal(f.rt.freeSlots(), 0); assert.deepEqual(prepares(), []);
  // Đã bàn giao candidate, chỉ chờ publish hay item khác: nhả slot.
  for (const key of keys.slice(1)) Object.assign(f.rt.journal.item(key), { workerState: 'yielded', checkpoint: 'candidate', candidate: { id: `c-${key}`, state: 'ready', fixResultFile: 'x' } });
  assert.equal(f.rt.freeSlots(), 3); assert.deepEqual(prepares(), ['CR-03']);
  // Dừng chờ sync trước evidence, worker chết sau restart, candidate phải làm mới: vẫn giữ slot.
  Object.assign(f.rt.journal.item('CR-01'), { checkpoint: 'ready_for_evidence', candidate: undefined });
  Object.assign(f.rt.journal.item('CR-02'), { checkpoint: 'resume', candidate: undefined });
  f.rt.journal.item('BUG-04').candidate.state = 'stale';
  assert.equal(f.rt.freeSlots(), 0); assert.deepEqual(prepares(), []);
});

test('in the last minutes the worker is stopped and the candidate published first', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file);
  const rows = minutesLeft => [{ key: f.key, type: 'BUG', status: 'OPEN', local: 'started', minutesLeft },
    { key: 'CR-09', type: 'CR', status: 'OPEN', local: 'todo', minutesLeft: 30 }];
  f.rt.gm.view.items.push({ key: 'CR-09', title: 'CR-09', raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } });
  f.rt.itemRows = () => rows(30);
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === f.key).lastCall, undefined);
  f.rt.itemRows = () => rows(5);
  const next = f.rt.workflow.actions().nextActions;
  assert.deepEqual([next[0].key, next[0].action, next[0].lastCall], [f.key, 'publish_item', true], 'publish first, ahead of the new item');
  assert.deepEqual([next[0].arguments.candidateId, next[0].arguments.lastChance], [f.ji.candidate.id, undefined]);
  f.ji.workerState = 'writing';
  const stop = f.rt.workflow.actions().nextActions[0];
  assert.equal(stop.action, 'stop_worker');
  // ME1X0FFX: BUG-02 hạ 3 kịch bản đã đạt xuống NOT_RUN khi bị dừng. Lời dừng do helper soạn, giữ PASS đã kiểm.
  assert.match(stop.followup, /Keep every scenario you already verified as PASS/);
  // QDO8W480: item helper tự publish (reserveMinutes 2) hạn 10 phút không bị dừng khi còn 4 phút, chỉ khi còn 2.
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 600_000).toISOString() } };
  const self = minutesLeft => { f.rt.itemRows = () => [{ ...rows(minutesLeft)[0], deadlineMinutes: 10, reserveMinutes: 2 }]; return f.rt.workflow.actions().nextActions.find(a => a.key === f.key); };
  assert.notEqual(self(4)?.action, 'stop_worker', 'still inside its own time');
  assert.equal(self(4)?.lastCall, undefined);
  assert.deepEqual([self(2).action, self(2).lastCall], ['stop_worker', true]);
  f.rt.itemRows = () => [{ ...rows(4)[0], deadlineMinutes: 10 }];
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === f.key).action, 'stop_worker', 'a root-published item keeps the old threshold');
});

// ME1X0FFX: candidate {result} ghi BUG-02-fixer-1.json rồi trả problems; root thấy publish_item, publish hỏng và nhắn
// worker giữa chừng. Kết quả của worker còn ghi không phải kết quả bàn giao.
test('a fix-result of a worker that is still writing is not offered for publish', async () => {
  const f = fixture(); f.result(1); f.ji.workerState = 'writing';
  assert.deepEqual(f.rt.newResults(), []);
  assert.equal(f.rt.workflow.actions().nextActions.some(a => a.action === 'publish_item'), false);
  f.ji.workerState = 'yielded';
  assert.deepEqual(f.rt.newResults().map(r => r.key), [f.key]);
});

test('publish integrates when main moved in other files and asks for a sync only when both changed a file', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  // NBDB5U0O: BUG-01 lên main (file khác) sau khi CR-01 đã chụp evidence; CR-01 không phải sync và chụp lại.
  writeFileSync(join(f.checkout, 'M1', 'src', 'layout.js'), 'export const offset=240;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout);
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
  assert.equal(readFileSync(join(f.checkout, 'M1', 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const value=2;\n');
  const g = fixture(), gfile = g.result(1), q = await g.preflight(gfile);
  writeFileSync(join(g.checkout, 'M1', 'src', 'lib.js'), 'export const value=9;\n');
  sh('git', ['add', 'M1'], g.checkout); sh('git', ['commit', '-q', '-m', 'same file'], g.checkout);
  const k = await g.rt.workflow.publish({ backlogItemKey: g.key, candidateId: q.candidateId }); await g.rt.jobs.jobs.get(k.jobId).promise;
  assert.match(JSON.stringify(g.rt.jobs.view(g.rt.jobs.jobs.get(k.jobId))), /SYNC_REQUIRED.*lib\.js/);
});

// 4D895OVI TASK-03: answer_only chỉ sửa answers/, main có BUG-03 sau khi tạo worktree. Publish đã integrate rồi dừng ở
// CANDIDATE_STALE vì không có file source nào của item để so, item đóng trước khi nộp.
test('an answer-only item publishes after main moved since its worktree was created', async () => {
  const f = fixture('TASK-01', true), file = f.result(1), p = await f.preflight(file);
  writeFileSync(join(f.checkout, 'M1', 'src', 'status.js'), 'export const status=1;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

// J56ZZWSS: BUG-02 sửa vitest.config.ts (TASK-02 nộp sau mất TC-04) và bàn giao bản 2 sai enum status (RESULT_INVALID
// qua root); mỗi worker tự viết script kiểm schema. Helper kiểm ở candidate và giữ worker lại cho tới khi sửa xong.
test('worker_checkpoint candidate keeps the worker writing until the fix-result, submit.json and test config are valid', async () => {
  const f = fixture('BUG-01', false, { 'src/vitest.config.ts': 'export default {};\n', 'src/tests/a.test.js': 'test 1\n' });
  const checkpoint = args => f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  const args = { backlogItemKey: f.key, phase: 'candidate' };
  f.ji.workerState = 'writing';
  let res = await checkpoint(args);
  assert.equal(res.handedOff, false); assert.match(res.problems[0], /BUG-01-fixer-1\.json first/); assert.equal(f.ji.workerState, 'writing');
  f.result(1, { status: 'DONE' });
  writeFileSync(join(f.wt.matchRoot, 'src', 'vitest.config.ts'), 'export default { esbuild: { jsx: "automatic" } };\n');
  writeFileSync(join(f.dir, 'submit.json'), '{"status":');
  res = await checkpoint(args);
  assert.equal(res.handedOff, false); assert.equal(f.ji.workerState, 'writing');
  for (const re of [/BUG-01-fixer-1\.json: RESULT_INVALID/, /not valid JSON/, /test configuration changed: src\/vitest\.config\.ts/]) {
    assert.ok(res.problems.some(p => re.test(p)), `${re} in ${JSON.stringify(res.problems)}`);
  }
  sh('git', ['checkout', '--', 'M1/src/vitest.config.ts'], f.wt.worktreeRoot);
  // EIOR38SI: BUG-01 viết lại assertion của cascade.test.ts; grader khôi phục test gốc nên mọi commit sau vẫn hỏng.
  writeFileSync(join(f.wt.matchRoot, 'src', 'tests', 'a.test.js'), 'test 2\n');
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: [] }] }));
  f.result(2);
  res = await checkpoint(args);
  assert.equal(res.handedOff, false); assert.equal(f.ji.workerState, 'writing');
  assert.match(res.problems.join('\n'), /issued tests changed: src\/tests\/a\.test\.js; graders restore/);
  sh('git', ['checkout', '--', 'M1/src/tests/a.test.js'], f.wt.worktreeRoot);
  writeFileSync(join(f.wt.matchRoot, 'src', 'tests', 'b.test.js'), 'test new\n');
  // RATH0OHJ: script chạy từ src/ ghi answers/<ID>/ tương đối; grader đọc mọi bài nộp sau từ src/answers/.
  const stray = join(f.wt.matchRoot, 'src', 'answers', f.key);
  mkdirSync(stray, { recursive: true }); writeFileSync(join(stray, 'submit.json'), '{}\n');
  res = await checkpoint(args);
  assert.equal(res.handedOff, false);
  assert.match(res.problems.join('\n'), /answer files outside the match folder's answers\/: M1\/src\/answers\/BUG-01\/submit\.json/);
  rmSync(join(f.wt.matchRoot, 'src', 'answers'), { recursive: true });
  res = await checkpoint(args);
  assert.equal(res.handedOff, true, JSON.stringify(res)); assert.deepEqual([f.ji.workerState, f.ji.checkpoint], ['yielded', 'candidate']);
});

// 9O802QWE: lượt cuối viết fix-result 8–11 KB mất 30–71 s. Worker chỉ gửi phần suy luận; helper thêm changed_files,
// test mới, các dòng run_checks, kiểm contract và ghi fix-result đánh số kế tiếp.
test('worker_checkpoint candidate {result} writes the fix-result from the worker part, git and run_checks', async () => {
  const f = fixture('BUG-01', false, { 'src/package.json': '{"name":"app","scripts":{"test":"vitest run","build":"next build"}}\n' });
  const checkpoint = args => f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  f.ji.workerState = 'writing';
  mkdirSync(join(f.wt.matchRoot, 'src', 'tests'), { recursive: true });
  writeFileSync(join(f.wt.matchRoot, 'src', 'tests', 'value.test.js'), 'it("value", () => {});\n');
  const checks = join(f.rt.session.paths.teamWork, 'items', f.key, 'checks.json');
  mkdirSync(dirname(checks), { recursive: true });
  writeFileSync(checks, JSON.stringify({ runId: 'r1', key: f.key, state: 'done', matchRoot: f.wt.matchRoot, results: [
    { name: 'typecheck', command: 'pnpm run typecheck', state: 'passed', exitCode: 0, log: 'evidence/typecheck.log' },
    { name: 'test', command: 'pnpm test', state: 'failed', exitCode: 1, log: 'evidence/full-suite.log', counts: { total: 3, passed: 2, failed: 1 }, failing: ['tests/old.test.js > old'] }] }));
  f.rt.journal.data.preparation.baseline = { failing: ['tests/old.test.js > old'] };
  const part = { status: 'fixed', summary: 'Value is 2', root_cause: 'value was 1', requirements: [{ id: 'AC-1', status: 'met', evidence: 'src/lib.js:1' }],
    verification: [{ check: 'TC-1', command: null, result: 'pass', note: 'observed' }] };
  let res = await checkpoint({ backlogItemKey: f.key, phase: 'candidate', result: { ...part, status: 'maybe' } });
  assert.equal(res.handedOff, false); assert.match(res.problems[0], /fix-result contract: .*status/);
  assert.equal(existsSync(join(f.results, 'BUG-01-fixer-1.json')), false, 'nothing is written for a bad result');
  res = await checkpoint({ backlogItemKey: f.key, phase: 'candidate', result: { ...part, changed_files: [] } });
  assert.match(res.problems[0], /helper fills .*changed_files/);
  res = await checkpoint({ backlogItemKey: f.key, phase: 'candidate', result: part });
  assert.equal(res.handedOff, true, JSON.stringify(res));
  assert.equal(res.fixResultFile, join(f.results, 'BUG-01-fixer-1.json'));
  const written = JSON.parse(readFileSync(res.fixResultFile, 'utf8'));
  assert.deepEqual(written.changed_files.sort(), ['answers/BUG-01/submit.json', 'src/lib.js', 'src/tests/value.test.js']);
  assert.deepEqual(written.tests_added, ['tests/value.test.js']);
  assert.deepEqual(written.verification.map(v => [v.check, v.result]), [['TC-1', 'pass'], ['typecheck', 'pass'], ['full test suite', 'fail']]);
  assert.match(written.verification[2].note, /every failing test is an issued baseline failure/);
  assert.deepEqual([written.root_cause, written.confidence, written.test_change], ['value was 1', 0.8, null]);
  assert.ok((await f.preflight(res.fixResultFile)).candidateId, 'the written result passes the publish contract');
});

// BTZNI69E: layout.test.ts của BUG-01 launch msedge; grader chạy suite ở môi trường không có trình duyệt, vitest thoát 1
// với 0 test hỏng và CR-01, CR-02, CR-03 nộp sau mất TC test tự động. Helper giữ worker lại ở candidate.
test('worker_checkpoint candidate refuses a new test that launches a browser unless the issued tests already do', async () => {
  const f = fixture('BUG-01');
  const checkpoint = args => f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  const args = { backlogItemKey: f.key, phase: 'candidate' };
  f.result(1); f.ji.workerState = 'writing';
  mkdirSync(join(f.wt.matchRoot, 'src', 'tests'), { recursive: true });
  const layout = join(f.wt.matchRoot, 'src', 'tests', 'layout.test.ts');
  writeFileSync(layout, 'import { chromium } from "playwright";\nconst b = await chromium.launch({ channel: "msedge" });\n');
  writeFileSync(join(f.dir, 'evidence', 'check.mjs'), 'import { chromium } from "playwright";\n');
  let res = await checkpoint(args);
  assert.equal(res.handedOff, false, JSON.stringify(res));
  const problem = res.problems.find(p => /test launches a browser/.test(p));
  assert.match(problem ?? '', /src\/tests\/layout\.test\.ts/); assert.doesNotMatch(problem, /check\.mjs/, 'evidence scripts are fine');
  writeFileSync(layout, 'import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(1));\n');
  f.result(2);
  res = await checkpoint(args);
  assert.equal(res.handedOff, true, JSON.stringify(res));
  // Bộ test phát ra vốn là e2e: môi trường chấm có trình duyệt, không chặn.
  const e2e = fixture('BUG-01', false, { 'src/tests/e2e.spec.ts': 'import { test } from "@playwright/test";\n' });
  e2e.result(1); e2e.ji.workerState = 'writing';
  writeFileSync(join(e2e.wt.matchRoot, 'src', 'tests', 'new.spec.ts'), 'import { test } from "@playwright/test";\n');
  res = await e2e.rt.definitions().find(t => t.name === 'worker_checkpoint').handler({ backlogItemKey: e2e.key, phase: 'candidate' });
  assert.equal(res.handedOff, true, JSON.stringify(res));
});

// BTZNI69E: fixer nhắn root 20 lần, root thức qua wait_agent rồi trả lời từng tin. Worker hỏi qua worker_checkpoint
// blocked: helper đánh thức root bằng answer_worker; root trả lời rồi resume đóng câu hỏi.
test('worker_checkpoint blocked raises answer_worker for root until root resumes the worker', async () => {
  const f = fixture('BUG-01');
  const checkpoint = args => f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  f.ji.workerState = 'writing'; f.ji.workerThread = '/root/bug01_fixer'; f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 600_000).toISOString() } };
  await assert.rejects(async () => checkpoint({ backlogItemKey: f.key, phase: 'blocked' }), /question/);
  const cursor = f.rt.events.seq;
  const res = await checkpoint({ backlogItemKey: f.key, phase: 'blocked', question: 'Which revision of KB-EXP-01 applies? I read revision 2 in the saved facts.' });
  assert.equal(res.writesAllowed, true); assert.match(res.hint, /End your turn/);
  assert.ok(f.rt.events.since(cursor).some(e => e.type === 'WORKER_BLOCKED' && e.key === f.key));
  const ask = f.rt.workflow.actions().nextActions.find(a => a.action === 'answer_worker');
  assert.equal(ask?.workerThread, '/root/bug01_fixer'); assert.match(ask.question, /KB-EXP-01/);
  await checkpoint({ backlogItemKey: f.key, phase: 'resume', threadId: '/root/bug01_fixer' });
  assert.equal(f.rt.workflow.actions().nextActions.some(a => a.action === 'answer_worker'), false, 'resume closes the question');
});

// BTZNI69E: 7/27 wait_for_update về tay không vì sự kiện không sinh việc (worker được tự sync rồi chạy tiếp, job dọn
// database, TIMELINE). Ở GAME chỉ thức khi có nextActions hoặc sự kiện root phải xử lý.
test('wait_for_update in GAME keeps waiting through events that bring no work and wakes on work or a match change', async () => {
  const f = fixture('BUG-01');
  f.ji.workerState = 'writing'; f.ji.workerThread = '/root/bug01_fixer'; f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 600_000).toISOString() } };
  assert.deepEqual(f.rt.workflow.actions().nextActions, [], 'nothing to do while the worker writes');
  const waitFor = async (timeoutMs, push) => {
    const cursor = f.rt.events.seq, since = Date.now();
    const pending = f.rt.waitForUpdate({ timeoutMs, cursor });
    setTimeout(push, 100);
    const res = await pending;
    return { res, ms: Date.now() - since };
  };
  let { res, ms } = await waitFor(900, () => { f.rt.events.push('TIMELINE', { event: 'x' }); f.rt.events.push('JOB_DONE', { kind: 'drop_databases' }); });
  assert.ok(ms >= 850, `no early wake (${ms} ms)`); assert.deepEqual(res.events.map(e => e.type), ['TIMELINE', 'JOB_DONE']);
  ({ res, ms } = await waitFor(5000, () => f.rt.events.push('MATCH_STATUS', { status: 'PAUSED' })));
  assert.ok(ms < 2000, `MATCH_STATUS wakes root (${ms} ms)`);
  ({ res, ms } = await waitFor(5000, () => f.rt.workflow.blockedCheckpoint({ backlogItemKey: f.key, question: 'Need the KB revision.' })));
  assert.ok(ms < 2000, `work wakes root (${ms} ms)`); assert.ok(res.nextActions.some(a => a.action === 'answer_worker'));
});

// Worker code + test, chụp evidence rồi nộp; helper không gate, không đòi review, không trả todo (03/11).
const submitted = f => {
  const bodies = []; f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() });
  f.rt.gm.postSubmission = async (key, intent) => { bodies.push(JSON.parse(intent.body)); return { kind: 'SUBMITTED', submission: { id: randomUUID() } }; };
  return bodies;
};
// autoPublish ghi candidate (preflight) rồi mới tạo job publish.
const publishJob = async f => {
  for (let i = 0; i < 200 && !f.rt.jobs.jobs.get(f.ji.publishJobId); i++) await new Promise(r => setTimeout(r, 25));
  await f.rt.jobs.jobs.get(f.ji.publishJobId).promise;
};
const publishDone = async (f, args) => {
  const job = await f.rt.workflow.publish(args); await f.rt.jobs.jobs.get(job.jobId).promise;
  return f.rt.jobs.view(f.rt.jobs.jobs.get(job.jobId));
};

test('after code, tests and evidence the fix-result is published as is, with no gate, review or repair loop', { timeout: 120_000 }, async () => {
  const f = fixture('BUG-01'), bodies = submitted(f);
  const checkpoint = f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler;
  f.ji.workerThread = '/root/bug01'; f.ji.workerState = 'writing';
  const res = await checkpoint({ backlogItemKey: f.key, phase: 'ready_for_evidence', testsAdded: [] });
  assert.equal(res.writesAllowed, true, JSON.stringify(res)); assert.equal(res.preGateJobId, undefined, 'no pre-gate');
  // Thiếu evidence bắt buộc: chỉ báo lại, vẫn nộp.
  f.rt.itemEvidence = () => [{ file: 'shot.png', beforeFix: false }];
  const file = f.result(1);
  assert.equal((await checkpoint({ backlogItemKey: f.key, phase: 'candidate' })).handedOff, true);
  const next = f.rt.workflow.actions().nextActions.find(a => a.key === f.key);
  assert.deepEqual([next.action, next.arguments.fixResultFile], ['publish_item', file]);
  const done = await publishDone(f, next.arguments);
  assert.equal(done.result?.status, 'SUBMITTED', JSON.stringify(done));
  assert.equal(bodies.length, 1); assert.equal(bodies[0].answer.testResults[0].result, 'PASS');
  assert.deepEqual(done.progress, ['verification', 'integrate', 'push', 'submit', 'done']);
  assert.ok(done.result.warnings.some(w => w.includes('shot.png')), 'the missing evidence is reported');
  const tests = f.rt.writer.events.filter(e => e.type === 'BACKLOG_TESTS').at(-1);
  assert.deepEqual([tests.status, tests.passed, tests.required], ['PASSED', 1, 1]); assert.match(tests.summary, /as reported by the worker/);
  assert.equal(sh('git', ['show', 'origin/main:M1/src/lib.js'], f.checkout), 'export const value=2;');
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === f.key), []);
});

test('an answer-only item is published without an independent solver (root publishes when autoPublish is off)', async () => {
  const f = fixture('TASK-01', true), bodies = submitted(f);
  localRuntime(f.root, { autoPublish: false });
  const p = await f.preflight(f.result(1));
  assert.deepEqual(f.rt.workflow.autoPublish(), []);
  const next = f.rt.workflow.actions().nextActions.find(a => a.key === f.key);
  assert.deepEqual([next.action, next.arguments.candidateId], ['publish_item', p.candidateId]);
  const done = await publishDone(f, next.arguments);
  assert.equal(done.result?.status, 'SUBMITTED', JSON.stringify(done)); assert.equal(bodies[0].answer.position, '2');
});

// CA3WKX60: fixer PI-01 viết fix-result 27 s sau khi submit.json đã xong, rồi root mất 10 s mới gọi publish_item.
test('an answer-only handoff needs no fix-result from the worker and the helper publishes it once, without root', async () => {
  const f = fixture('TASK-01', true), bodies = submitted(f);
  const checkpoint = f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler;
  f.ji.workerState = 'writing';
  const res = await checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  assert.equal(res.handedOff, true, JSON.stringify(res));
  const written = JSON.parse(readFileSync(join(f.results, 'TASK-01-fixer-1.json'), 'utf8'));
  assert.equal(written.status, 'fixed'); assert.match(written.summary, /position=2/);
  assert.deepEqual(written.changed_files, ['answers/TASK-01/submit.json']);
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === f.key), [], 'root has nothing to do');
  assert.deepEqual(f.rt.rootResults(), [], 'no "fix-result ready" notice for root');
  assert.deepEqual(f.rt.workflow.autoPublish(), [f.key]);
  assert.deepEqual(f.rt.workflow.autoPublish(), [], 'one automatic publish per handoff');
  await publishJob(f);
  assert.equal(f.rt.jobs.view(f.rt.jobs.jobs.get(f.ji.publishJobId)).result.status, 'SUBMITTED');
  assert.equal(bodies.length, 1); assert.equal(bodies[0].answer.position, '2');
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === f.key), []);
});

test('the helper waits for a writing worker\'s handoff, tries its publish once and leaves a failure to root', async () => {
  const f = fixture('PI-01', true);
  f.rt.gm.view.items[0].raw.descriptionMd = '## Context\nReminders for paid invoices.\n## Out of scope\nChanging the application source, re-sending e-mails.\n';
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() });
  let down = true;
  f.rt.gm.postSubmission = async () => { if (down) throw Object.assign(Error('Game Master unavailable'), { code: 'GM_UNAVAILABLE' }); return { kind: 'SUBMITTED', submission: { id: randomUUID() } }; };
  const own = f.result(1);   // fix-result của chính worker, viết trước khi gọi candidate
  f.ji.workerState = 'writing';
  assert.deepEqual(f.rt.workflow.autoPublish(), [], 'the worker has not handed off yet');
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === f.key), [], 'still the helper\'s publish, not root\'s');
  const res = await f.rt.workerCheckpoint({ backlogItemKey: f.key, phase: 'candidate' });
  assert.equal(res.handedOff, true, JSON.stringify(res));
  assert.equal(f.rt.workflow.latestResult(f.key), own, 'the worker\'s own fix-result is kept');
  assert.deepEqual(f.rt.workflow.autoPublish(), [f.key]);
  await publishJob(f);
  assert.equal(f.rt.jobs.jobs.get(f.ji.publishJobId).state, 'failed');
  const next = f.rt.workflow.actions().nextActions.find(a => a.key === f.key);
  assert.ok(['publish_item', 'submit_work'].includes(next?.action), JSON.stringify(next));
  assert.deepEqual(f.rt.workflow.autoPublish(), [], 'no second automatic try');
  down = false;
  const done = next.action === 'submit_work' ? await f.rt.submitWork(next.arguments) : (await publishDone(f, next.arguments)).result;
  assert.equal(done.status, 'SUBMITTED', JSON.stringify(done));
});

// CA3WKX60: PI-01 chờ install + generate + migrate + seed 43 s, fixer đọc 42K ký tự skill rồi tự gọi search_logs từng
// service trong 41 s (5 lượt) và tự chép log vào evidence.
test('a report-only PI is prepared without dependency setup, with every service log merged into a timeline and copied into evidence', async () => {
  const f = fixture('PI-01', true);
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, verificationKind: undefined });
  f.rt.gm.view.items[0].raw = { title: 'Clients receive payment reminders for invoices they already paid', points: 160,
    descriptionMd: '## Context\nSince this morning clients complain about reminders.\n## Out of scope\nChanging the application source, re-sending e-mails.\n' };
  f.rt.startWork = async () => ({ type: 'PI', triage: { models: { fixer: [{ model: 'gpt-6.1-sol', reasoning_effort: 'high' }] } },
    materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), files: [], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' }, requirements: [] });
  const logs = {
    deploy: [{ ts: '2026-10-27T06:05:40Z', service: 'deploy', requestId: 'dep-2', message: 'Release rel-2 completed' }],
    'reminder-worker': [{ ts: '2026-10-27T07:40:01Z', service: 'reminder-worker', requestId: 'rem-b', message: 'Reminder sent' },
      { ts: '2026-10-27T07:40:00Z', service: 'reminder-worker', requestId: 'rem-a', message: 'Reminder sent' }],
    web: [{ ts: '2026-10-27T05:00:00Z', service: 'web', requestId: 'web-1', message: 'GET /' }],
  };
  const calls = [];
  f.rt.company.list = async () => [{ name: 'kb_search', inputSchema: {} }, { name: 'search_logs', inputSchema: { properties: { query: {}, service: {} } } }];
  f.rt.company.invoke = async (name, args) => {
    calls.push([name, args]);
    const text = v => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
    if (name === 'kb_search') return text({ articles: [{ id: 'KB-OPS-01', body: 'Use the service name exactly as it appears in logs: web, deploy, reminder-worker.' }] });
    if (!args.service) return text({ total: 40, returned: 1, entries: logs.web });
    const entries = logs[args.service] ?? [];
    return text({ total: args.service === 'web' ? 30 : entries.length, returned: entries.length, entries });
  };
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(done.result.worktree.codegraph, 'report-only PI');
  assert.equal(f.rt.jobs.view(f.rt.jobs.jobs.get(done.result.worktree.setupJobId)).result.skipped, 'report-only PI', 'no install, generate, migrate or seed');
  const company = join(f.rt.session.paths.teamWork, 'items', f.key, 'company');
  const timeline = JSON.parse(readFileSync(join(company, 'timeline.json'), 'utf8'));
  assert.deepEqual(timeline.entries.map(e => e.requestId), ['web-1', 'dep-2', 'rem-a', 'rem-b'], 'all services merged, sorted by ts');
  assert.deepEqual(timeline.services.map(s => [s.service, s.complete]).sort(), [['deploy', true], ['reminder-worker', true], ['web', false]]);
  assert.ok(calls.some(([n, a]) => n === 'search_logs' && a.service === 're-sending'), 'hyphenated names in the item are probed');
  const saved = readdirSync(company);
  assert.equal(saved.filter(n => /search_logs/.test(n)).length, 3, `services without entries are not saved: ${saved}`);
  const evidence = readdirSync(join(f.wt.matchRoot, 'answers', f.key, 'evidence'));
  for (const n of saved) assert.ok(evidence.includes(n), `${n} copied into evidence`);
  const brief = readFileSync(done.result.briefFile, 'utf8');
  assert.match(brief, /<report_only_pi>[\s\S]*answers\/PI-01\/evidence\/derive\.mjs/);
  assert.match(brief, /search_logs \(service web: 1\/30 INCOMPLETE\)/);
  assert.match(brief, /timeline \(4 entries from 3 services, sorted by ts\)/);
  assert.doesNotMatch(brief, /<skills>|<profile>|<skill_text>/, 'the playbook replaces the skill files');
});

// EIOR38SI: helper thấy → fixer bắt đầu trung bình 1m24s, trong đó install/generate/migrate/seed 45–105 s. Fixer được
// spawn ngay khi worktree, index và brief có, rồi tự chờ job setup trước lần build/test/app đầu tiên.
test('prepare hands the item to a worker while dependency setup still runs, and the brief says to wait for that job', async () => {
  const f = fixture('CR-01');
  Object.assign(f.ji, { workerState: undefined });
  // Đề nhắc item khác (OMZJW0S0 CR-07 → BUG-11): brief có khối <depends_on>.
  const raw = { descriptionMd: '## Context\nThe audit is right only on source that also contains the `BUG-11` fixes.\n## Acceptance criteria\n1. Correct value.' };
  f.rt.gm.view.items[0].raw = raw;
  writeFileSync(join(f.rt.session.paths.teamWork, 'items', f.key, 'page.json'), JSON.stringify(raw));
  let release;
  const setup = f.rt.jobs.start('worktree_setup', () => new Promise(r => { release = r; }), { key: f.key });
  f.rt.startWork = async () => ({ type: 'CR', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), timeBox: {} });
  f.rt.worktree = async () => ({ ...f.wt, setupJobId: setup.id });
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(setup.state, 'running', 'prepare did not wait for install/generate/migrate/seed');
  assert.deepEqual(done.result.setup, { jobId: setup.id, state: 'running', skipped: null });
  assert.ok(f.ji.spawn?.task_name, 'spawn arguments are ready for root');
  const brief = readFileSync(done.result.briefFile, 'utf8');
  assert.match(brief, /<environment>\nDependency setup .* still running as job /);
  assert.ok(brief.includes(`job_status {jobId: "${setup.id}", waitSeconds: 110}`), brief);
  assert.deepEqual(f.ji.dependsOn, ['BUG-11']);
  assert.match(brief, /<depends_on>\nBUG-11 \(not on main yet\): this item's text names it/);
  release({ ok: true });
  await setup.promise;
});

test('a prepare whose prewarmed setup already failed still reports SETUP_FAILED', async () => {
  const f = fixture('CR-01');
  const setup = f.rt.jobs.start('worktree_setup', async () => ({ ok: false, failure: 'pnpm install exited 1' }), { key: f.key });
  await setup.promise;
  f.rt.startWork = async () => ({ type: 'CR', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), timeBox: {} });
  f.rt.worktree = async () => ({ ...f.wt, setupJobId: setup.id });
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'failed');
  assert.match(done.error.message, /pnpm install exited 1/);
});

// EIOR38SI: TASK-03/04 (Form A, không build/test/app) chờ setup 71–80 s mà không dùng bước nào.
test('an answer-only TASK gets a worktree without dependency setup and a brief that says not to install or build', async () => {
  const f = fixture('TASK-03', true, { 'src/package.json': '{"name":"app","scripts":{"test":"vitest run"}}\n' });
  mkdirSync(join(f.rt.session.paths.matchRoot, 'src', 'node_modules', 'typescript'), { recursive: true });   // checkout chính đã cài
  Object.assign(f.ji, { workerState: undefined, verificationKind: undefined });
  f.rt.startWork = async () => ({ type: 'TASK', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), timeBox: {} });
  assert.equal(f.rt.answerOnlyTask(f.key), true);
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(done.result.verificationKind, 'answer_only');
  assert.equal(f.rt.jobs.view(f.rt.jobs.jobs.get(done.result.worktree.setupJobId)).result.skipped, 'answer-only TASK', 'no install, generate, migrate or seed');
  assert.equal(existsSync(join(f.wt.matchRoot, 'src', '.env')), false);
  const brief = readFileSync(done.result.briefFile, 'utf8');
  assert.match(brief, /<environment>\nNo dependencies, database or app were set up in this worktree \(answer-only TASK\)/);
  assert.ok(brief.includes(`createRequire(${JSON.stringify(join(f.rt.session.paths.matchRoot, 'src', 'package.json'))})`),
    `project packages load from the installed main checkout: ${brief}`);
  assert.match(brief, /<skills>/, 'unlike a report-only PI, the TASK keeps its skill files');
  assert.match(brief, /=== \.agents\/skills\/backlog-task\/SKILL\.md ===/);
  assert.doesNotMatch(brief, /evidence-playbook\.md ===/, 'an answer-only item captures no screenshots');
});

test('a TASK that changes code or carries test results is not answer-only for setup', () => {
  const f = fixture('TASK-02');
  assert.equal(f.rt.answerOnlyTask(f.key), false);
  const g = fixture('TASK-01', true);
  writeFileSync(join(g.rt.session.paths.teamWork, 'items', g.key, 'template.json'), JSON.stringify({ status: 'NOT_STARTED', testResults: [] }));
  assert.equal(g.rt.answerOnlyTask(g.key), false, 'a template with testResults runs tests');
  assert.equal(fixture('PI-01', true).rt.answerOnlyTask('PI-01'), false);
});

test('sync waits for a setup job that is still running before it resets the worktree', async () => {
  const f = fixture();
  let release, order = [];
  const setup = f.rt.jobs.start('worktree_setup', () => new Promise(r => { release = r; }), { key: f.key });
  f.ji.worktreeSetupJob = setup.id;
  writeFileSync(join(f.rt.session.paths.matchRoot, 'src', 'helper.js'), 'export const helper = true;\n');
  sh('git', ['add', 'M1/src/helper.js'], f.checkout); sh('git', ['commit', '-q', '-m', 'shared helper'], f.checkout);
  f.rt.refreshCodegraph = async () => ({ name: 'codegraph', skipped: 'test' });
  const syncing = f.rt.worktree({ action: 'sync', backlogItemKey: f.key }).then(r => { order.push('synced'); return r; });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, [], 'sync is held while setup writes the worktree');
  order.push('setup done'); release({ ok: true });
  assert.equal((await syncing).synced, true);
  assert.deepEqual(order, ['setup done', 'synced']);
});

test('concurrent prewarm/create calls share one worktree setup job', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.rt.createWorktree(f.key), f.rt.createWorktree(f.key)]);
  assert.equal(a.job.id, b.job.id);
  await a.job.promise;
  assert.equal([...f.rt.jobs.jobs.values()].filter(j => j.kind === 'worktree_setup').length, 1);
});

test('create joins a still-running setup instead of starting another installation', async () => {
  const f = fixture();
  let release;
  const job = f.rt.jobs.start('worktree_setup', () => new Promise(r => { release = r; }), { key: f.key });
  f.ji.worktreeSetupJob = job.id;
  f.rt.refreshCodegraph = async () => ({ name: 'codegraph', skipped: 'test' });
  try {
    const result = await f.rt.createWorktree(f.key);
    assert.equal(result.job.id, job.id);
    assert.equal([...f.rt.jobs.jobs.values()].filter(j => j.kind === 'worktree_setup').length, 1);
  } finally { release({ ok: true }); await job.promise; }
});

test('claiming a prewarmed worktree consumes its setup once without running preparation again', async () => {
  const f = fixture();
  const job = f.rt.jobs.start('worktree_setup', async () => ({ ok: true }), { key: f.key });
  await job.promise;
  f.rt.prewarming.set(f.key, Promise.resolve({ jobId: job.id, codegraph: { skipped: 'test' } }));
  f.rt.createWorktree = async () => { throw new Error('prewarm must be reused'); };
  const result = await f.rt.worktree({ action: 'create', backlogItemKey: f.key });
  assert.equal(result.setupJobId, job.id);
  assert.equal(f.rt.prewarming.has(f.key), false);
});

test('answer-only prewarm cannot skip code setup once the actual template requires tests', async () => {
  const f = fixture('TASK-02');
  const warm = f.rt.jobs.start('worktree_setup', async () => ({ ok: true, skipped: 'answer-only TASK' }), { key: f.key });
  await warm.promise;
  f.rt.prewarming.set(f.key, Promise.resolve({ jobId: warm.id, codegraph: { skipped: 'test' } }));
  const code = f.rt.jobs.start('worktree_setup', async () => ({ ok: true }), { key: f.key });
  f.rt.createWorktree = async () => ({ job: code, codegraph: { skipped: 'test' } });
  const result = await f.rt.worktree({ action: 'create', backlogItemKey: f.key });
  assert.equal(result.setupJobId, code.id);
  assert.notEqual(result.setupJobId, warm.id);
});

test('dependency changes on main do not install or build answer-only worktrees during sync', async () => {
  for (const key of ['TASK-01', 'PI-01']) {
    const f = fixture(key, true);
    writeFileSync(join(f.rt.session.paths.matchRoot, 'src', 'package.json'), '{"name":"updated dependency inputs"}');
    sh('git', ['add', 'M1/src/package.json'], f.checkout);
    sh('git', ['commit', '-q', '-m', 'dependency inputs'], f.checkout);
    f.rt.refreshCodegraph = async () => ({ name: 'codegraph', skipped: 'test' });
    const result = await f.rt.worktree({ action: 'sync', backlogItemKey: key });
    assert.equal(result.synced, true);
    assert.equal(result.setupJobId, undefined);
    assert.equal([...f.rt.jobs.jobs.values()].some(j => j.kind === 'worktree_setup'), false);
    assert.equal(existsSync(join(f.wt.matchRoot, 'src', 'node_modules')), false);
  }
});

test('final evidence survives test/document-only syncs, not a later change to the item\'s own files', async () => {
  const f = fixture(), shot = join(f.dir, 'evidence', 'final.png'); writeFileSync(shot, 'png');
  const head = sh('git', ['rev-parse', 'HEAD'], f.wt.worktreeRoot), snapshot = await f.rt.workflow.snapshot(f.key);
  recordEvidence(f.rt.session.paths.teamWork, f.key, { path: shot, name: 'final.png', phase: 'final', ...snapshot, base: head, sha256: digest(readFileSync(shot)) });
  mkdirSync(join(f.checkout, 'M1', 'src', 'tests'));
  mkdirSync(join(f.checkout, 'M1', 'docs'));
  writeFileSync(join(f.checkout, 'M1', 'src', 'tests', 'baseline.test.js'), 'export const fixed=true;\n');
  writeFileSync(join(f.checkout, 'M1', 'docs', 'practice.md'), 'Test notes\n');
  writeFileSync(join(f.checkout, 'M1', 'src', 'BUILD_REPORT.md'), 'Build passed\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'tests and documentation'], f.checkout);
  assert.equal((await f.rt.worktree({ action: 'sync', backlogItemKey: f.key })).synced, true);
  const stale = p => p.warnings.filter(w => /older source/.test(w));
  assert.deepEqual(stale(await f.preflight(f.result(1))), [], 'main brought only tests and documentation');
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=5;\n');
  assert.equal(stale(await f.preflight(f.result(2))).length, 1, 'the item changed its own file after capture');
});

for (const file of ['layout.tsx', 'globals.css', 'api.js', 'unknown.js']) {
  test(`final evidence is stale after syncing another item's runtime file: ${file}`, async () => {
    const f = fixture(), shot = join(f.dir, 'evidence', 'final.png'); writeFileSync(shot, 'png');
    const snapshot = await f.rt.workflow.snapshot(f.key), base = sh('git', ['rev-parse', 'HEAD'], f.wt.worktreeRoot);
    recordEvidence(f.rt.session.paths.teamWork, f.key, { path: shot, name: 'final.png', phase: 'final', ...snapshot, base, sha256: digest(readFileSync(shot)) });
    writeFileSync(join(f.checkout, 'M1', 'src', file), 'changed by another item\n');
    sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'runtime change'], f.checkout);
    await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
    assert.ok((await f.preflight(f.result(1))).warnings.some(w => /older source/.test(w)));
  });
}

// 4D895OVI: CR-01, CR-02 dừng ở ready_for_evidence khoảng 1 phút chờ root sync rồi gửi resume.
for (const via of ['direct', 'proxy']) test(`ready_for_evidence syncs and resumes without a root round trip (${via})`, async () => {
  const checkpoint = (rt, args) => via === 'proxy' ? rt.proxyCall('worker_checkpoint', args)
    : rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  const f = fixture(); f.ji.workerThread = '/root/bug01';
  writeFileSync(join(f.checkout, 'M1', 'src', 'shared.js'), 'export const shared=1;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout);
  const res = await checkpoint(f.rt, { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  assert.equal(res.writesAllowed, true, JSON.stringify(res)); assert.equal(res.synced.synced, true);
  assert.deepEqual([f.ji.workerState, f.ji.checkpoint, f.ji.workerThread], ['writing', 'resume', '/root/bug01']);
  assert.equal(f.ji.worktreeBase, sh('git', ['rev-parse', 'HEAD'], f.checkout));
  assert.equal(readFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const value=2;\n', 'own change kept');
  // Cùng sửa một file: worktree giữ nguyên, worker vẫn yielded và báo root.
  const g = fixture();
  writeFileSync(join(g.checkout, 'M1', 'src', 'lib.js'), 'export const value=9;\n');
  sh('git', ['add', 'M1'], g.checkout); sh('git', ['commit', '-q', '-m', 'same file'], g.checkout);
  const conflict = await checkpoint(g.rt, { backlogItemKey: g.key, phase: 'ready_for_evidence' });
  assert.equal(conflict.writesAllowed, false); assert.equal(conflict.syncError.code, 'WORKTREE_CONFLICT'); assert.equal(g.ji.workerState, 'yielded');
});

// 08OQBPW8: worker chạy run_checks 3–4 lần, có lần trước sync. Helper chạy nó một lần ngay sau sync, trên source cuối.
test('ready_for_evidence starts run_checks on the synced worktree unless autoChecks is off', async () => {
  const f = fixture(); f.ji.workerThread = '/root/bug01';
  const calls = [];
  f.rt.runChecks = async args => { calls.push(args); return { state: 'running', runId: 'r-1' }; };
  const res = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  assert.equal(res.writesAllowed, true, JSON.stringify(res));
  assert.deepEqual(calls, [{ backlogItemKey: f.key, matchRoot: f.wt.matchRoot, waitSeconds: 0 }]);
  assert.deepEqual(res.checks, { state: 'running', runId: 'r-1' });
  assert.match(res.hint, /started run_checks .*run_checks {action: "status"/);
  localRuntime(f.root, { autoChecks: false });
  const off = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  assert.equal(calls.length, 1); assert.equal(off.checks, undefined); assert.match(off.hint, /Start the app again/);
});

test('proxy evidence checkpoint keeps the worker yielded while dependency setup is pending', async () => {
  const f = fixture(); f.ji.workerState = 'writing';
  f.rt.worktree = async args => {
    assert.equal(args.action, 'sync'); assert.equal(f.ji.workerState, 'yielded');
    return { synced: true, setupJobId: 'pending-setup' };
  };
  const res = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  assert.equal(res.writesAllowed, false); assert.equal(res.synced.setupJobId, 'pending-setup');
  assert.equal(f.ji.workerState, 'yielded'); assert.match(res.hint, /Dependencies changed/);
});

test('prepare names the exact backlog skill and stack-notes file', () => {
  assert.deepEqual(itemSkills('BUG', 'node'), { item: '.agents/skills/backlog-bug/SKILL.md', stackNotes: '.agents/skills/stack-notes/node.md' });
  assert.equal(itemSkills('CR', 'java-gradle').stackNotes, '.agents/skills/stack-notes/java.md');
  assert.deepEqual(itemSkills('EPIC', 'rust'), { item: null, stackNotes: '.agents/skills/stack-notes/unknown.md' });
  for (const [t, s] of [['BUG', 'node'], ['CR', 'java-maven'], ['TASK', 'python'], ['PI', 'go'], ['BUG', 'php'], ['BUG', 'dotnet'], ['BUG', 'unknown']])
    for (const p of Object.values(itemSkills(t, s))) assert.ok(existsSync(join('pack', p.replace('.agents/', ''))), p);
});

// EIOR38SI: test fail sẵn ở bản phát; BUG-01 là chủ, BUG-02 cần cả bộ test. Grader chạy suite trên commit của từng
// item, BUG-02 lên main lúc 14:20 trước bản sửa của BUG-01 (14:27) và mất 20 điểm. f là BUG-02; BUG-01 có worktree riêng.
function baselineFixture() {
  const f = fixture('BUG-02', false, { 'src/status.js': 'export const paid = (p, t) => p > t;\n', 'src/tests/status.test.js': 'expect(paid(5, 5)).toBe(true);\n' });
  const head = sh('git', ['rev-parse', 'HEAD'], f.checkout);
  f.rt.journal.data.initialRevision = head;
  f.rt.journal.data.preparation = { baseline: { status: 'FAIL', failing: ['tests/status.test.js > paid in full'] }, baselineOwner: 'BUG-01' };
  f.ji.needsSuite = true;
  const owner = f.rt.wtPaths('BUG-01');
  sh('git', ['worktree', 'add', '-q', '--detach', owner.worktreeRoot, 'HEAD'], f.checkout);
  const oi = Object.assign(f.rt.journal.item('BUG-01'), { startedAt: new Date().toISOString(), worktreeBase: head, workerState: 'writing', verificationKind: 'mvs',
    prepared: { timeBox: { returnBy: new Date(Date.now() + 600_000).toISOString() } } });
  f.rt.gm.view.items.push({ key: 'BUG-01', title: 'BUG-01', raw: { descriptionMd: '## Acceptance criteria\n1. Sidebar.' } });
  const rows = (minutesLeft = 30) => ['BUG-01', 'BUG-02'].map(key => ({ key, type: 'BUG', status: 'OPEN', local: 'started', minutesLeft }));
  f.rt.itemRows = () => rows();
  const checkpoint = args => f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler(args);
  const ownerFix = () => writeFileSync(join(owner.matchRoot, 'src', 'status.js'), 'export const paid = (p, t) => p >= t;\n');
  return { ...f, owner, oi, rows, checkpoint, ownerFix };
}
const text = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const FIXED = 'export const paid = (p, t) => p >= t;\n';

test('the baseline owner lands its fix on main first; an item that runs the suite publishes only after syncing it', async () => {
  const f = baselineFixture();
  f.result(1); f.ji.checkpoint = 'candidate';
  const actions = () => f.rt.workflow.actions().nextActions.filter(a => a.key === 'BUG-02').map(a => a.action);
  assert.deepEqual(actions(), [], 'publish waits while the owner works on the baseline');
  assert.deepEqual(f.rt.rootResults().map(u => u.key), []);
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: 'BUG-02', fixResultFile: join(f.results, 'BUG-02-fixer-1.json') }), /BASELINE_PENDING/);
  f.rt.itemRows = () => f.rows(4);
  assert.deepEqual(actions(), ['publish_item'], 'in the last minutes it publishes as is');
  f.rt.itemRows = () => f.rows();

  // Chủ sửa test gốc thì bị từ chối; sửa sản phẩm rồi báo đúng file đó.
  writeFileSync(join(f.owner.matchRoot, 'src', 'tests', 'status.test.js'), 'expect(true).toBe(true);\n');
  await assert.rejects(f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: ['src/tests/status.test.js'] }), /graders restore issued tests/);
  await assert.rejects(f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'baseline_fixed', files: ['src/status.js'] }), /NOT_BASELINE_OWNER/);
  sh('git', ['checkout', '--', 'M1/src/tests/status.test.js'], f.owner.worktreeRoot);
  f.ownerFix();
  const res = await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: ['src/status.js'] });
  assert.deepEqual([res.state, res.writesAllowed], ['pending', true]);
  assert.deepEqual(actions(), [], 'still waiting until the fix is on main');

  assert.deepEqual(await f.rt.workflow.autoBaseline(), ['BUG-02']);
  assert.match(sh('git', ['log', '-1', '--format=%s'], f.checkout), /^BUG-01: make the tests that fail in the issued code pass/);
  assert.equal(text(join(f.checkout, 'M1', 'src', 'status.js')), FIXED);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED, 'BUG-02 worktree has the fix');
  assert.equal(text(join(f.wt.matchRoot, 'src', 'lib.js')), 'export const value=2;\n', 'and keeps its own change');
  const refresh = f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02');
  assert.deepEqual([refresh.action, refresh.reason], ['refresh_candidate', 'baseline_fix']);
  assert.match(refresh.followup, /BUG-01's fix for the baseline failures/);

  // Worker chạy lại cả bộ test và bàn giao bản 2: publish được, rồi chủ publish mà không bị SYNC_REQUIRED.
  f.result(2);
  const next = f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02');
  assert.deepEqual([next.action, next.arguments.fixResultFile], ['publish_item', join(f.results, 'BUG-02-fixer-2.json')]);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  const settle = async j => { await f.rt.jobs.jobs.get(j.jobId).promise; return f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId)); };
  let done = await settle(await f.rt.workflow.publish({ backlogItemKey: 'BUG-02', fixResultFile: next.arguments.fixResultFile }));
  assert.equal(done.state, 'done', JSON.stringify(done));
  writeFileSync(join(f.owner.matchRoot, 'src', 'layout.js'), 'export const offset=240;\n');
  mkdirSync(join(f.owner.matchRoot, 'answers', 'BUG-01'), { recursive: true });
  writeFileSync(join(f.owner.matchRoot, 'answers', 'BUG-01', 'submit.json'), JSON.stringify({ status: 'DONE' }));
  writeFileSync(join(f.results, 'BUG-01-fixer-1.json'), JSON.stringify(fix()));
  f.oi.workerState = 'yielded';
  done = await settle(await f.rt.workflow.publish({ backlogItemKey: 'BUG-01', fixResultFile: join(f.results, 'BUG-01-fixer-1.json') }));
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(text(join(f.checkout, 'M1', 'src', 'layout.js')), 'export const offset=240;\n');
});

test('a writing worker that hands off after the baseline fix landed is synced and asked to rerun the suite', async () => {
  const f = baselineFixture();
  f.ji.workerState = 'writing';
  f.result(1);
  let res = await f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'candidate' });
  assert.equal(res.handedOff, true);
  assert.ok(res.warnings.some(w => /not fixed on main yet: BUG-01 lands that fix first/.test(w)), JSON.stringify(res.warnings));
  f.ji.workerState = 'writing';
  f.ownerFix();
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: ['src/status.js'] });
  await f.rt.workflow.landBaseline();
  res = await f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'candidate' });
  assert.equal(res.handedOff, false);
  assert.match(res.problems[0], /BUG-01's fix for the baseline failures just landed on main/);
  assert.equal(f.ji.workerState, 'writing');
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED);
  f.result(2);
  res = await f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'candidate' });
  assert.equal(res.handedOff, true, JSON.stringify(res));
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
});

test('the owner syncs onto main after its own baseline fix landed, the new migration file included', async () => {
  const f = baselineFixture();
  mkdirSync(join(f.owner.matchRoot, 'src', 'migrations'), { recursive: true });
  writeFileSync(join(f.owner.matchRoot, 'src', 'migrations', '002_restrict.sql'), 'ALTER TABLE invoices RESTRICT;\n');
  f.ownerFix();
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: ['src/status.js', 'src/migrations/002_restrict.sql'] });
  await f.rt.workflow.landBaseline();
  assert.equal(f.rt.journal.data.preparation.baselineFix.state, 'landed');
  assert.equal(text(join(f.checkout, 'M1', 'src', 'migrations', '002_restrict.sql')), 'ALTER TABLE invoices RESTRICT;\n');
  writeFileSync(join(f.owner.matchRoot, 'src', 'layout.js'), 'export const offset=240;\n');
  f.oi.workerState = 'yielded';
  const s = await f.rt.worktree({ action: 'sync', backlogItemKey: 'BUG-01' });
  assert.equal(s.synced, true);
  assert.equal(text(join(f.owner.matchRoot, 'src', 'layout.js')), 'export const offset=240;\n');
  assert.equal(text(join(f.owner.matchRoot, 'src', 'status.js')), FIXED);
});

test('an owner that cannot fix the baseline releases the items waiting for it', async () => {
  const f = baselineFixture();
  f.result(1); f.ji.checkpoint = 'candidate';
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner');
  const res = await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: [] });
  assert.equal(res.state, 'abandoned');
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === 'BUG-02').map(a => a.action), ['publish_item']);
});

// OMZJW0S0 CR-07: đề nói dữ liệu official chỉ đúng trên source có bản sửa BUG-11; BUG-11 lên main sau lần sync cuối của
// CR-07 và CR-07 nộp CSV/summary của source cũ (mất 25 điểm).
test('items named in the item text are dependencies; one that lands after the last sync refuses the handoff and holds the publish', async () => {
  assert.deepEqual(itemDependencies('CR-07', 'The official test data is the books of the customer of `BUG-11` ... contains the BUG-11 fixes; see CR-07 and TASK-8 and PI-02.'),
    ['BUG-11', 'TASK-8', 'PI-02']);
  const f = fixture('CR-07');
  const minutes = { left: 10 };
  f.rt.itemRows = () => [{ key: 'CR-07', type: 'CR', status: 'OPEN', local: 'started', minutesLeft: minutes.left, deadlineMinutes: 20 }];
  f.ji.dependsOn = ['BUG-11'];
  f.ji.baseAt = new Date(Date.now() - 60_000).toISOString();
  f.rt.journal.item('BUG-11').integratedAt = new Date().toISOString();
  const refused = await f.rt.workflow.candidateCheckpoint({ backlogItemKey: 'CR-07' });
  assert.equal(refused.handedOff, false);
  assert.match(refused.problems[0], /BUG-11 reached main after your worktree last took main/);
  assert.match(refused.hint, /ready_for_evidence/);

  // Đã bàn giao trước khi BUG-11 lên main: giữ publish, root gửi followup làm mới (cả trong cửa sổ cơ hội cuối).
  await f.preflight(f.result(1));
  minutes.left = 5;
  const held = f.rt.workflow.actions().nextActions;
  assert.deepEqual(held.map(a => [a.action, a.reason, a.dependency]), [['refresh_candidate', 'dependency_landed', 'BUG-11']]);
  assert.match(held[0].followup, /BUG-11 is now on main\. Call worker_checkpoint ready_for_evidence/);
  // Dưới 3 phút: không đủ thời gian làm mới, nộp như đang có.
  minutes.left = 2;
  assert.deepEqual(f.rt.workflow.actions().nextActions.map(a => a.action), ['publish_item']);

  // Sync xong (worktree lấy main sau BUG-11): hết phụ thuộc.
  minutes.left = 10;
  f.ji.baseAt = new Date(Date.now() + 1000).toISOString();
  assert.equal(f.rt.workflow.dependencyLanded('CR-07'), null);
  assert.ok(!f.rt.workflow.actions().nextActions.some(a => a.reason === 'dependency_landed'));
});

// OMZJW0S0 CR-07: cr-07-official.test.ts (test mới của đội) fail trên revision nộp, mất 4 điểm team-tests.
test('handoff refuses own new tests that fail in the last run_checks; failures of other tests do not block', async () => {
  const f = fixture('CR-07');
  writeFileSync(join(f.wt.matchRoot, 'src', 'audit.test.js'), "test('official figures', () => {});\n");
  const checks = join(f.rt.session.paths.teamWork, 'items', 'CR-07', 'checks.json');
  mkdirSync(dirname(checks), { recursive: true });
  const write = failing => writeFileSync(checks, JSON.stringify({ runId: 'r1', state: 'done', results: [{ name: 'test', state: 'failed', failing }] }));
  write(['src/audit.test.js > official figures']);
  assert.match((await f.rt.workflow.handoffCheck('CR-07')).problems.join('\n'), /your own new tests fail in the last run_checks: src\/audit\.test\.js > official figures/);
  write(['src/other.test.js > baseline']);
  assert.ok(!(await f.rt.workflow.handoffCheck('CR-07')).problems.some(p => /own new tests/.test(p)));
});

// OMZJW0S0 TASK-08: fixer chạy 22,7 phút mà journal chỉ ghi code_test 1 s, evidence 76 s: mỗi resume đặt lại đồng hồ,
// còn checkpoint mà worker vẫn làm tiếp thì chốt giai đoạn quá sớm.
test('phase metrics follow the work, not every resume: blocked waits are separate and a second ready_for_evidence keeps the clock', () => {
  const f = fixture('TASK-08');
  const wf = f.rt.workflow, ji = f.ji, min = 60_000;
  const phases = () => (ji.metrics ?? []).map(m => [m.phase, Math.round(m.ms / min)]);
  ji.metrics = [];
  ji.phaseClock = { name: 'code_test', since: Date.now() - 10 * min };
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'resume' });
  assert.equal(ji.phaseClock.name, 'code_test');
  assert.ok(Date.now() - ji.phaseClock.since >= 10 * min - 1000, 'resume keeps the running clock');
  ji.question = { text: 'run_checks cannot find yarn', at: new Date(Date.now() - 1 * min).toISOString() };
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'resume' });
  assert.deepEqual(phases(), [['blocked', 1]]);
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'ready_for_evidence' });
  assert.deepEqual(phases(), [['blocked', 1], ['code_test', 10]]);
  ji.phaseClock.since -= 8 * min;
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'resume' });
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'ready_for_evidence' });
  assert.equal(phases().length, 2, 'a second ready_for_evidence does not close evidence');
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'candidate' });
  assert.deepEqual(phases().slice(-1), [['evidence', 8]]);
  ji.phaseClock.since -= 5 * min;
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'resume' });
  assert.equal(ji.phaseClock.name, 'handoff', 'a resume after handoff opens the rework phase; the wait for root is not counted');
  ji.phaseClock.since -= 2 * min;
  wf.checkpoint({ backlogItemKey: 'TASK-08', phase: 'candidate' });
  assert.deepEqual(phases().slice(-1), [['handoff', 2]]);
});

// QDYZMY1K: node_modules worktree liên kết tới checkout chính; git worktree remove --force đi xuyên junction và xoá file
// của checkout chính nếu không gỡ liên kết trước.
test('worktree remove unlinks linked node_modules first, so the main checkout keeps its packages', async () => {
  const f = fixture('BUG-01', false, { 'src/package.json': JSON.stringify({ name: 'app', private: true, scripts: { test: 'node -e 1' } }) });
  const mainApp = join(f.rt.session.paths.matchRoot, 'src');
  mkdirSync(join(mainApp, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(mainApp, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  const { linkNodeModules } = await import('../../pack/src/env/linked-modules.mjs');
  assert.equal(linkNodeModules(mainApp, join(f.wt.matchRoot, 'src')).linked, true);
  const removed = await f.rt.worktree({ action: 'remove', backlogItemKey: f.key });
  assert.equal(removed.removed, true);
  assert.ok(existsSync(join(mainApp, 'node_modules', 'left-pad', 'index.js')), 'main checkout package survived the worktree removal');
});

// QDYZMY1K PI-03: hết giờ trước khi sửa source, bàn giao chỉ có test tái hiện (đỏ); trên main nó làm BUG-09, BUG-11 mất
// điểm team-tests. Helper chuyển test đó vào evidence khi không có thay đổi sản phẩm nào đi kèm.
test('a BUG/PI/CR handoff with new tests but no product change moves those tests to evidence; with a fix they stay', async () => {
  const f = fixture('PI-03');
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=1;\n');   // không có bản sửa
  writeFileSync(join(f.wt.matchRoot, 'src', 'amount.test.js'), "test('midpoint', () => { throw new Error('red'); });\n");
  assert.deepEqual(await f.rt.workflow.parkRedOnlyTests('PI-03'), ['src/amount.test.js']);
  assert.equal(existsSync(join(f.wt.matchRoot, 'src', 'amount.test.js')), false, 'the red test does not ship');
  assert.ok(existsSync(join(f.dir, 'evidence', 'unshipped-tests', 'src__amount.test.js')), 'it stays as reproduction evidence');
  assert.deepEqual(f.ji.unshippedTests, ['src/amount.test.js']);

  const g = fixture('BUG-01');   // fixture có sửa src/lib.js: test đi kèm bản sửa thì giữ
  writeFileSync(join(g.wt.matchRoot, 'src', 'lib.test.js'), "test('value', () => {});\n");
  assert.deepEqual(await g.rt.workflow.parkRedOnlyTests('BUG-01'), []);
  assert.ok(existsSync(join(g.wt.matchRoot, 'src', 'lib.test.js')));

  const t = fixture('TASK-08');   // bộ test của TASK là sản phẩm
  writeFileSync(join(t.wt.matchRoot, 'src', 'lib.js'), 'export const value=1;\n');
  writeFileSync(join(t.wt.matchRoot, 'src', 'suite.test.js'), "test('spec', () => {});\n");
  assert.deepEqual(await t.rt.workflow.parkRedOnlyTests('TASK-08'), []);
});

// QDYZMY1K BUG-11: TC-03/04 PASS trỏ sang transfer-resync.log, thiếu mvs-tests.log mà MVS đòi; BTC chấm 0 cả hai (−8).
test('a PASS scenario without the evidence its MVS requires blocks the handoff instead of only warning', async () => {
  const f = fixture('BUG-01');
  f.rt.itemMvs = () => '# MVS\n\n## TC-1 - the case\n\nRequired evidence: `mvs-tests.log`.\n';
  writeFileSync(join(f.dir, 'evidence', 'resync.log'), 'ok');
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: ['evidence/resync.log'] }] }));
  const { problems } = await f.rt.workflow.handoffCheck('BUG-01');
  assert.ok(problems.some(p => /^TC-1 is PASS but its evidence lacks what the MVS requires: evidence\/mvs-tests\.log/.test(p)), JSON.stringify(problems));
  writeFileSync(join(f.dir, 'evidence', 'mvs-tests.log'), 'ok');
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: ['evidence/mvs-tests.log', 'evidence/resync.log'] }] }));
  assert.ok(!(await f.rt.workflow.handoffCheck('BUG-01')).problems.some(p => /is PASS but/.test(p)));
});

// QDYZMY1K PI-02/PI-03: thử limit/pageSize/take, hỏi root schema, tự lặp hàng trăm truy vấn. company_lookup hàng loạt:
// một lời gọi, một file đã gộp và sắp xếp, nói rõ đủ hay thiếu. run_checks của PI chỉ typecheck.
test('PI: bulk company_lookup writes one sorted file and the brief explains search_logs', async () => {
  const f = fixture('PI-02', false, { 'src/package.json': JSON.stringify({ name: 'app', private: true, scripts: { typecheck: 'node -e "console.log(1)"', build: 'node -e "process.exit(1)"', test: 'node -e "process.exit(1)"' } }) });
  const logs = Array.from({ length: 12 }, (_, i) => ({ ts: `2025-10-15T08:${String(10 + i).padStart(2, '0')}:00.000Z`, service: 'rule-engine', message: 'rule.applied', context: { txnId: `TX-${String(i + 1).padStart(5, '0')}`, seq: 3100100 + i } }));
  const { matchesQuery } = await import('../../pack/src/match/logs.mjs');
  const schema = { properties: { query: { type: 'string', maxLength: 500 }, service: { type: 'string' } } };
  f.rt.company = { list: async () => [{ name: 'search_logs', readOnly: true, inputSchema: schema }],
    invoke: async (name, args) => {
      const hits = logs.filter(e => (!args.service || e.service === args.service) && matchesQuery(e, args.query ?? '')).reverse();
      return { content: [{ type: 'text', text: JSON.stringify({ total: hits.length, returned: Math.min(20, hits.length), entries: hits.slice(0, 20) }) }] };
    } };
  const res = await f.rt.companyLookup({ name: 'search_logs', backlogItemKey: 'PI-02', queries: logs.map(e => ({ service: 'rule-engine', query: e.context.txnId })) });
  assert.equal(res.state, 'done', JSON.stringify(res));
  assert.equal(res.result.entries, 12); assert.equal(res.result.complete, true);
  const saved = JSON.parse(readFileSync(res.result.savedTo, 'utf8'));
  assert.deepEqual(saved.entries.map(e => e.context.seq), logs.map(e => e.context.seq), 'sorted by ts then seq');


  const { searchLogsHelp } = await import('../../pack/src/match/logs.mjs');
  const brief = readFileSync(f.rt.workflow.writeBrief('PI-02', { item: { title: 'PI', descriptionMd: '' }, fixResultFile: 'x', searchLogs: searchLogsHelp(schema), companyFacts: [] }), 'utf8');
  assert.match(brief, /<search_logs>\nsearch_logs input: \{"query":\{"type":"string","maxLength":500\}/);
});

// LXRMBRA2 PI-03: tra log hàng loạt xong 36 s sau khi worker bàn giao, lượt làm lại không hỏi lại job, 4 trường đáp án trống.
test('candidate waits for a running bulk log lookup and refuses once until its result was read', async () => {
  const f = fixture('PI-03');
  f.rt.itemRows = () => [{ key: 'PI-03', type: 'PI', status: 'OPEN', local: 'started', minutesLeft: 12 }];
  const job = f.rt.jobs.start('log_lookup', async () => {
    await new Promise(r => setTimeout(r, 400));
    return { savedTo: 'company/10-search_logs-bulk.json', entries: 697, complete: true };
  }, { key: 'PI-03' });
  assert.match(f.rt.workflow.checkpoint({ backlogItemKey: 'PI-03', phase: 'resume' }).hint, /still running: job_status/);
  const refused = await f.rt.workflow.candidateCheckpoint({ backlogItemKey: 'PI-03' });
  assert.equal(job.state, 'done', 'candidate waited for the lookup');
  assert.equal(refused.handedOff, false);
  assert.match(refused.problems[0], /has finished and you have not read its result: company\/10-search_logs-bulk\.json \(697 entries, complete: true\)/);
  assert.equal(f.rt.workflow.unreadLookup('PI-03'), null, 'told once');
  assert.equal(await f.rt.workflow.lookupBeforeHandoff('PI-03'), null);

  // Worker đã nhận kết quả qua job_status: không chặn. Item sắp đóng: không chờ, không chặn.
  const seen = f.rt.jobs.start('log_lookup', async () => ({ savedTo: 'x.json', entries: 1, complete: true }), { key: 'PI-03' });
  await f.rt.jobStatus({ jobId: seen.id, waitSeconds: 5 }, { pi: false });
  assert.equal(f.rt.workflow.unreadLookup('PI-03'), null);
  f.rt.jobs.start('log_lookup', () => new Promise(r => setTimeout(() => r({}), 3000)), { key: 'PI-03' });
  f.rt.itemRows = () => [{ key: 'PI-03', type: 'PI', status: 'OPEN', local: 'started', minutesLeft: 2 }];
  const t0 = Date.now();
  assert.equal(await f.rt.workflow.lookupBeforeHandoff('PI-03'), null);
  assert.ok(Date.now() - t0 < 1000);
});

// LXRMBRA2: CR-07 (hạn 20 phút) cần bản sửa BUG-11 trong source nộp; BUG-11 xong code ở phút 7,5, bàn giao ở phút 25.
function dependencyFixture() {
  const f = fixture('BUG-11');
  const { rt, checkout } = f, head = sh('git', ['rev-parse', 'HEAD'], checkout);
  writeFileSync(join(f.wt.matchRoot, 'src', 'fix.js'), 'export const fixed = true;\n');
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.test.js'), 'test("red then green", () => {});\n');
  const cr = rt.wtPaths('CR-07');
  sh('git', ['worktree', 'add', '-q', '--detach', cr.worktreeRoot, 'HEAD'], checkout);
  writeFileSync(join(cr.matchRoot, 'src', 'page.js'), 'export const page = 1;\n');
  Object.assign(rt.journal.item('CR-07'), { startedAt: new Date().toISOString(), worktreeBase: head, baseAt: new Date(Date.now() - 60_000).toISOString(),
    dependsOn: ['BUG-11'], workerState: 'writing' });
  rt.gm.view.items.push({ key: 'CR-07', title: 'CR-07', raw: { descriptionMd: 'The official data is right only on source that also contains the `BUG-11` fixes.' } });
  rt.itemRows = () => [{ key: 'BUG-11', type: 'BUG', status: 'OPEN', local: 'started', minutesLeft: 30 },
    { key: 'CR-07', type: 'CR', status: 'OPEN', local: 'started', minutesLeft: 12, deadlineMinutes: 20 }];
  // git apply/checkout ghi CRLF khi core.autocrlf=true.
  const read = (rel, root = cr.matchRoot) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n') : null);
  return { ...f, cr, read, head };
}

test('the product fix of an item another item waits for is copied into the waiting worktree, without tests or answers', async () => {
  const f = dependencyFixture(), wf = f.rt.workflow;
  assert.deepEqual(wf.neededBy('BUG-11'), ['CR-07']);
  assert.deepEqual(wf.neededBy('BUG-11', { minutes: true }), [{ key: 'CR-07', minutesLeft: 30 }]);
  const shared = await wf.shareWithDependents('BUG-11');
  assert.deepEqual(shared, [{ key: 'CR-07', files: ['M1/src/lib.js', 'M1/src/fix.js'] }]);
  assert.equal(f.read('src/lib.js'), 'export const value=2;\n');
  assert.equal(f.read('src/fix.js'), 'export const fixed = true;\n');
  assert.equal(f.read('src/lib.test.js'), null, 'tests stay with BUG-11');
  assert.equal(f.read('answers/BUG-11/submit.json'), null, 'answers stay with BUG-11');
  assert.equal(f.read('src/page.js'), 'export const page = 1;\n', 'CR-07 keeps its own work');
  assert.match(wf.sharedNote(shared), /copied into the worktree of CR-07, which needs it before closing/);
  assert.deepEqual(await wf.shareWithDependents('BUG-11'), [], 'same content: nothing to copy again');

  // BUG-11 đổi product sau đó: chép lại, thay bản cũ.
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=3;\n');
  assert.deepEqual((await wf.shareWithDependents('BUG-11')).map(x => x.key), ['CR-07']);
  assert.equal(f.read('src/lib.js'), 'export const value=3;\n');

  // CR-07 đang viết: candidate từ chối một lần; resume báo trong hint.
  const refused = await wf.candidateCheckpoint({ backlogItemKey: 'CR-07' });
  assert.equal(refused.handedOff, false);
  assert.match(refused.problems[0], /BUG-11's product fix was copied into your worktree/);
  assert.match(refused.hint, /git checkout HEAD -- <file>/);
  assert.equal(wf.sharedPending('CR-07'), null, 'told once');
  f.rt.journal.item('CR-07').sharedFix.notified = false;
  assert.match(wf.checkpoint({ backlogItemKey: 'CR-07', phase: 'resume' }).hint, /BUG-11's product fix was copied into your worktree/);

  // CR-07 đã bàn giao khi bản sửa tới: giữ publish, root gửi followup.
  const cj = f.rt.journal.item('CR-07');
  Object.assign(cj, { workerState: 'yielded', candidate: { id: 'c1', state: 'ready' } });
  cj.sharedFix.notified = false;
  const action = wf.actions().nextActions.find(a => a.key === 'CR-07');
  assert.equal(action.action, 'refresh_candidate'); assert.equal(action.reason, 'dependency_ready'); assert.equal(action.dependency, 'BUG-11');
  assert.match(action.followup, /worker_checkpoint resume, rerun your replay script/);
});

// QDO8W480: CR-05 gọi ready_for_evidence ở phút 19,5, worktree của CR-08 tới phút 19,9 mới có: lần chép đó bỏ qua CR-08,
// CR-05 handoff lại ở phút 38,4 và CR-08 (hạn 15 phút) nộp không có handler của CR-05, 0/110.
test('a worktree created after the waited-for item reached ready_for_evidence takes that fix at prepare', async () => {
  const f = dependencyFixture(), wf = f.rt.workflow;
  assert.deepEqual(await wf.pullFromDependencies('CR-07'), [], 'BUG-11 is still coding: nothing to take yet');
  assert.equal(f.read('src/fix.js'), null);
  f.rt.journal.item('BUG-11').workerPhase = 'evidence';
  assert.deepEqual(await wf.pullFromDependencies('CR-07'), [{ key: 'CR-07', files: ['M1/src/lib.js', 'M1/src/fix.js'] }]);
  assert.equal(f.read('src/fix.js'), 'export const fixed = true;\n');
  assert.equal(f.read('src/lib.test.js'), null, 'tests stay with BUG-11');
  assert.equal(f.rt.journal.item('CR-07').sharedFix.from, 'BUG-11');
  const brief = readFileSync(wf.writeBrief('CR-07', { item: { title: 'CR', descriptionMd: '' }, fixResultFile: 'x', companyFacts: [] }), 'utf8');
  assert.match(brief, /BUG-11 \(not on main yet; its product fix is ALREADY copied into your worktree\)/);
  assert.match(brief, /copied BUG-11's product changes \(no tests, no answers\/\) into your worktree before you started: M1\/src\/lib\.js, M1\/src\/fix\.js/);
  assert.deepEqual(await wf.pullFromDependencies('CR-07'), [], 'same content: nothing to copy again');
  // Đã lên main: worktree dựng từ main đã có, không chép.
  delete f.rt.journal.item('CR-07').sharedFix;
  f.rt.journal.item('BUG-11').integratedAt = new Date().toISOString();
  assert.deepEqual(await wf.pullFromDependencies('CR-07'), []);
});

test('a copy equal to what reaches main needs no second refresh; a different one is removed before the sync', async () => {
  const f = dependencyFixture(), wf = f.rt.workflow;
  await wf.shareWithDependents('BUG-11');
  const land = text => {
    writeFileSync(join(f.checkout, 'M1', 'src', 'lib.js'), text);
    writeFileSync(join(f.checkout, 'M1', 'src', 'fix.js'), 'export const fixed = true;\n');
    sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'BUG-11'], f.checkout);
    f.rt.journal.item('BUG-11').integratedAt = new Date().toISOString();
  };
  land('export const value=2;\n');
  await wf.noteDependencyLanded('BUG-11');
  assert.equal(wf.dependencyLanded('CR-07'), null, 'the worktree already has that source');
  land('export const value=4;\n');
  await wf.noteDependencyLanded('BUG-11');
  assert.equal(wf.dependencyLanded('CR-07').key, 'BUG-11');
  assert.equal(f.read('src/lib.js'), 'export const value=1;\n', 'copy removed, the sync brings main');
  assert.equal(f.read('src/fix.js'), null);
});

test('nothing is copied when both items change the same file', async () => {
  const f = dependencyFixture();
  writeFileSync(join(f.cr.matchRoot, 'src', 'lib.js'), 'export const value=99;\n');
  assert.deepEqual(await f.rt.workflow.shareWithDependents('BUG-11'), [{ key: 'CR-07', skipped: 'both items change M1/src/lib.js' }]);
  assert.equal(f.read('src/lib.js'), 'export const value=99;\n');
  assert.equal(f.read('src/fix.js'), null);
});

// LXRMBRA2 BUG-11: TASK-08 đưa transactions/transfer.ts lên main lúc 08:23, BUG-11 bàn giao 08:28, biết lúc publish.
test('candidate refuses while main changed one of the files of the item with other content', async () => {
  const f = fixture('BUG-11'), wf = f.rt.workflow;
  const commit = text => { writeFileSync(join(f.checkout, 'M1', 'src', 'lib.js'), text); sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout); };
  commit('export const value=2;\n');
  assert.deepEqual(await wf.mainOverlap('BUG-11'), [], 'same content on main');
  commit('export const value=5;\n');
  assert.deepEqual(await wf.mainOverlap('BUG-11'), ['M1/src/lib.js']);
  const refused = await wf.candidateCheckpoint({ backlogItemKey: 'BUG-11' });
  assert.equal(refused.handedOff, false);
  assert.match(refused.problems[0], /main changed files you also change.*M1\/src\/lib\.js.*SYNC_REQUIRED/);
  assert.match(refused.hint, /ready_for_evidence/);
});

// QXUD1QAI BUG-11: test ghi '/bug-11-statement.qif' đạt trên Windows (gốc ổ D:) nhưng timeout trên máy chấm Linux.
test('a new test that writes to an absolute path outside the repository is refused once', async () => {
  const f = fixture('BUG-01'), wf = f.rt.workflow;
  f.result(1);
  writeFileSync(join(f.wt.matchRoot, 'src', 'replay.test.js'),
    "const filename = '/bug-11-statement.qif';\nawait fs.writeFile(filename, data);\nawait fetch('/api/accounts');\n");
  const first = await wf.handoffCheck('BUG-01');
  assert.ok(first.problems.some(p => /absolute path outside the repository: src\/replay\.test\.js \(\/bug-11-statement\.qif\)/.test(p)), JSON.stringify(first.problems));
  const second = await wf.handoffCheck('BUG-01');
  assert.ok(!second.problems.some(p => /absolute path/.test(p)), 'the same paths pass the second time');
  assert.ok(second.warnings.some(w => /in-memory file system/.test(w)));
  writeFileSync(join(f.wt.matchRoot, 'src', 'replay.test.js'), "await fs.writeFile(join(mkdtempSync(join(tmpdir(), 'b11-')), 'statement.qif'), data);\n");
  const fixed = await wf.handoffCheck('BUG-01');
  assert.ok(!fixed.problems.some(p => /absolute path/.test(p)) && !fixed.warnings.some(w => /absolute paths/.test(w)));
});

// QXUD1QAI CR-07 (hạn 20 phút): app lên 6 phút sau ready_for_evidence, trang không được chụp (−19).
test('a deadline item that needs screenshots is told to capture them first, in the brief and at ready_for_evidence', async () => {
  const f = fixture('CR-07'), wf = f.rt.workflow;
  const materials = join(f.rt.session.paths.teamWork, 'items', 'CR-07');
  writeFileSync(join(materials, 'mvs.json'), JSON.stringify('## CR-07-TC-03 - the page\n\nRequired evidence: `reconciliation.png`.\n\n## CR-07-TC-01\n\nRequired evidence: `mvs-tests.log`.'));
  assert.deepEqual(wf.screenshotFiles('CR-07'), ['reconciliation.png']);
  const returnBy = new Date(Date.now() + 10 * 60_000).toISOString();
  const brief = text => readFileSync(wf.writeBrief('CR-07', { item: { title: 'CR', descriptionMd: '' }, fixResultFile: 'x', companyFacts: [], timeBox: { deadline: text, returnBy } }), 'utf8');
  assert.match(brief(true), /<screens_first>\nThis item closes at .* and needs screenshots: reconciliation\.png\. .*before ready_for_evidence/);
  assert.doesNotMatch(brief(false), /^<screens_first>$/m, 'no deadline, no block');
  assert.match(brief(false), /^<grading>\r?\nHow this item is scored[\s\S]*screenshots required: reconciliation\.png[\s\S]*closes at: the end of the match/m);

  assert.equal(wf.missingScreens('CR-07'), null, 'not prepared with a deadline');
  f.ji.prepared = { timeBox: { deadline: true, returnBy } };
  assert.deepEqual(wf.missingScreens('CR-07'), { missing: ['reconciliation.png'], minutesLeft: 30 });
  const res = await wf.evidenceCheckpoint({ backlogItemKey: 'CR-07', phase: 'ready_for_evidence' });
  assert.match(res.hint, /Screenshots first: reconciliation\.png does not exist yet and the item closes in about 30 minutes/);
  writeFileSync(join(f.dir, 'evidence', 'reconciliation.png'), 'png');
  assert.equal(wf.missingScreens('CR-07'), null);
});

// QDO8W480 CR-05: seed BTC phát phải chạy trong trang của app; brief chỉ thẳng bước runScript của capture_evidence.
test('the brief points to capture_evidence runScript for an issued script that runs in the app page', () => {
  const f = fixture('CR-05'), dir = f.rt.itemDir('CR-05');
  mkdirSync(join(dir, 'files', 'challenge'), { recursive: true });
  writeFileSync(join(dir, 'files', 'challenge', 'CR-05-seed.js'), '// Evaluate this function in the app\'s page, for example: await page.evaluate(seed, data).\nasync data => window.$send("x", data);\n');
  writeFileSync(join(dir, 'files', 'challenge', 'CR-05-mvs.test.js'), 'await page.evaluate(() => 1);\n');
  writeFileSync(join(dir, 'files', 'challenge', 'CR-05-seed.ts'), 'export const seed = 1; // prisma seed, run with node\n');
  const files = ['challenge/CR-05-seed.js', 'challenge/CR-05-mvs.test.js', 'challenge/CR-05-seed.ts', 'challenge/missing.js'];
  assert.deepEqual(pageScripts(dir, files), ['challenge/CR-05-seed.js']);
  const brief = readFileSync(f.rt.workflow.writeBrief('CR-05', { item: { title: 'CR', descriptionMd: '' }, fixResultFile: 'x', companyFacts: [], files }), 'utf8');
  assert.match(brief, /<page_scripts>\s*challenge\/CR-05-seed\.js: issued scripts that run inside the app's page/);
  assert.match(brief, /\{action: "runScript", file: "challenge\/CR-05-seed\.js", argFile: "company\/01-get_test_data\.json", argPath: "data"\}/);
  const plain = readFileSync(f.rt.workflow.writeBrief('CR-05', { item: { title: 'CR', descriptionMd: '' }, fixResultFile: 'x', companyFacts: [], files: ['challenge/CR-05-seed.ts'] }), 'utf8');
  assert.doesNotMatch(plain, /<page_scripts>/);
});

// QDO8W480: CR-05, CR-07, CR-08 cùng thêm route, mục sidebar và handler vào ba file; CR-05 dừng ở WORKTREE_CONFLICT,
// thợ gỡ tay 3 phút, publish hỏng 3 lần.
test('sync keeps both additions when main and the item only added lines to the same place; a changed line is still a conflict', async () => {
  const f = fixture(), file = join('M1', 'src', 'routes.js');
  const registry = 'export const routes = [\n  "/reports",\n  "/settings",\n];\n';
  const land = (text, message) => { writeFileSync(join(f.checkout, file), text); sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', message], f.checkout); };
  const mine = () => readFileSync(join(f.wt.worktreeRoot, file), 'utf8').replace(/\r\n/g, '\n');
  land(registry, 'registry');
  assert.equal((await f.rt.worktree({ action: 'sync', backlogItemKey: f.key })).synced, true);
  // Cả hai thêm một dòng ngay sau "/reports".
  writeFileSync(join(f.wt.worktreeRoot, file), registry.replace('  "/settings",', '  "/month-close",\n  "/settings",'));
  land(registry.replace('  "/settings",', '  "/reconciliation-audit",\n  "/settings",'), 'CR-07');
  const synced = await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
  assert.deepEqual(synced.autoMerged, ['M1/src/routes.js']);
  assert.match(synced.hint, /the helper kept both additions/);
  assert.deepEqual(mine().split('\n').filter(l => l.includes('"/')).map(l => l.trim()).sort(), ['"/month-close",', '"/reconciliation-audit",', '"/reports",', '"/settings",']);
  assert.doesNotMatch(mine(), /<<<<<<<|>>>>>>>/);
  assert.equal(f.ji.worktreeBase, sh('git', ['rev-parse', 'HEAD'], f.checkout));
  assert.equal(readFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const value=2;\n', 'other own changes kept');
  // Item sửa một dòng có sẵn (nối thêm vào cuối dòng): xung đột thật, worktree giữ nguyên.
  const before = mine().replace('  "/reports",', '  "/reports", "/extra",');
  writeFileSync(join(f.wt.worktreeRoot, file), before);
  land(readFileSync(join(f.checkout, file), 'utf8').replace(/\r\n/g, '\n').replace('  "/reports",', '  "/reports",\n  "/budget",'), 'CR-08');
  await assert.rejects(f.rt.worktree({ action: 'sync', backlogItemKey: f.key }), /WORKTREE_CONFLICT.*routes\.js.*unchanged/);
  assert.equal(mine(), before);
});

// Checklist "Before handoff" mục 2 (EXP3I47A BUG-09: cả ba kịch bản NOT_RUN khi còn 23 phút, −65).
test('candidate refuses once while a scenario is NOT_RUN and time is left, and never near return_by', async () => {
  const f = fixture('BUG-01'), wf = f.rt.workflow;
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'PARTIAL', testResults: [{ id: 'TC-1', result: 'NOT_RUN', evidence: [] }] }));
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 20 * 60_000).toISOString() } };
  const first = wf.notRunGate('BUG-01');
  assert.match(first, /^TC-1 is NOT_RUN with \d+ minutes left before return_by.*new browserProfile name.*demo or sample mode.*call candidate again as is$/);
  assert.equal(wf.notRunGate('BUG-01'), null, 'the same NOT_RUN set is refused only once');
  const g = fixture('BUG-01');
  writeFileSync(join(g.dir, 'submit.json'), JSON.stringify({ status: 'PARTIAL', testResults: [{ id: 'TC-1', result: 'NOT_RUN', evidence: [] }] }));
  g.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 3 * 60_000).toISOString() } };
  assert.equal(g.rt.workflow.notRunGate('BUG-01'), null, 'no time for a retry: hand off as is');
});

// Checklist mục 3 (EXP3I47A TASK-08: test mới không đỏ khi bỏ chỗ sửa, grader cài lại đúng lỗi đó, −4).
test('candidate asks once for the mutation check and once more while a change survives it', async () => {
  const f = fixture('BUG-01'), wf = f.rt.workflow;   // fixture sửa src/lib.js (value=1 → 2)
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.test.js'), "test('value', () => {});\n");
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 20 * 60_000).toISOString() } };
  const ask = await wf.mutantGate('BUG-01');
  assert.match(ask.problem, /changed existing product code \(1 change\) and added tests.*run_checks \{action: "mutants"\}/);
  assert.match((await wf.mutantGate('BUG-01')).warning, /no mutation check on your final source/);
  const source = (await wf.snapshot('BUG-01')).source;
  const record = { state: 'done', source, hunks: [{ file: 'src/lib.js', line: 1, preview: 'export const value=2;', result: 'survived' }] };
  writeFileSync(join(f.rt.session.paths.teamWork, 'items', 'BUG-01', 'mutants.json'), JSON.stringify(record));
  assert.match((await wf.mutantGate('BUG-01')).problem, /no new test fails when these changes are undone: src\/lib\.js:1 \(export const value=2;\)/);
  assert.match((await wf.mutantGate('BUG-01')).warning, /accepted on the second handoff/);
  record.hunks[0].result = 'caught';
  writeFileSync(join(f.rt.session.paths.teamWork, 'items', 'BUG-01', 'mutants.json'), JSON.stringify(record));
  assert.equal(await wf.mutantGate('BUG-01'), null, 'every change caught: nothing to say');
  const pi = fixture('PI-03');
  writeFileSync(join(pi.wt.matchRoot, 'src', 'lib.test.js'), "test('value', () => {});\n");
  pi.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 20 * 60_000).toISOString() } };
  assert.equal(await pi.rt.workflow.mutantGate('PI-03'), null, 'PI races for time: no mutation check');
});

// YSKRYL4B CR-07: vitest chạy từ thư mục trận ghi cache vào <folder>/node_modules/, helper commit 32 file đó.
test('candidate refuses tool caches under node_modules/', async () => {
  const f = fixture('BUG-01');
  f.result(1);
  mkdirSync(join(f.wt.matchRoot, 'node_modules', '.vite', 'vitest'), { recursive: true });
  writeFileSync(join(f.wt.matchRoot, 'node_modules', '.vite', 'vitest', 'results.json'), '{}');
  const { problems } = await f.rt.workflow.handoffCheck('BUG-01');
  assert.ok(problems.some(p => /^files under node_modules\/ would be committed: M1\/node_modules\. They are a tool cache/.test(p)), JSON.stringify(problems));
});

// BI7A5ACV TASK-08: bàn giao khi mutants còn hoàn tác một chỗ sửa trong worktree; root cho làm lại, bản sau xong khi
// đã hết credit. Từ chối mọi lúc, kể cả sát return_by.
test('candidate refuses while the mutation check is running, whatever the time left', async () => {
  const f = fixture('BUG-01');
  f.result(1);
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() + 60_000).toISOString() } };
  const file = join(f.rt.session.paths.teamWork, 'items', 'BUG-01', 'mutants.json');
  writeFileSync(file, JSON.stringify({ state: 'running', pid: process.pid, runId: 'r-1', hunks: [] }));
  const { problems } = await f.rt.workflow.handoffCheck('BUG-01');
  assert.ok(problems.some(p => /^the mutation check is still running and has one of your changes undone/.test(p)), JSON.stringify(problems));
  writeFileSync(file, JSON.stringify({ state: 'done', pid: process.pid, runId: 'r-1', hunks: [] }));
  assert.ok(!(await f.rt.workflow.handoffCheck('BUG-01')).problems.some(p => /mutation check/.test(p)));
});

// Hồ sơ đề: team_analyst đọc đề trước, helper kiểm rồi mới spawn fixer (BI7A5ACV: mutants chạy trên 8 item trong khi
// chỉ TASK-08 chấm khả năng phát hiện lỗi; phân tích đề bằng regex không đủ tin).
function analystFixture() {
  const f = fixture('CR-01');
  f.base = f.ji.worktreeBase;
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, worktreeBase: undefined });
  f.rt.itemRows = () => [{ key: f.key, type: 'CR', status: 'OPEN', local: f.ji.prepared ? 'started' : 'todo', minutesLeft: 30 }];
  f.rt.gm.view.items[0].raw = { title: 'Export the filtered invoice list as CSV', points: 140,
    descriptionMd: '## Requirements\nAdd `src/export.js` and report the row count in `rowCount`.\n## Grading\nHidden tests check the export in many more cases. The grader runs the tests itself on your submitted revision.\n' };
  f.rt.startWork = async () => ({ type: 'CR', triage: { models: { fixer: [{ model: 'gpt-6.1-sol', reasoning_effort: 'high' }] } },
    materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key), files: [], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' }, requirements: [], baselineFailures: null });
  f.rt.worktree = async () => ({ ...f.wt, issuedRevision: 'abc123', setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
  f.rt.company.list = async () => [];
  f.rt.company.invoke = async () => ({ content: [{ type: 'text', text: 'x' }] });
  return f;
}
const PROFILE = () => ({
  form: 'feature', summary: 'Export module and the row count of the export.',
  grading: [{ aspect: 'hidden_tests', quote: 'Hidden tests check the export in many more cases' },
    { aspect: 'team_tests_pass', quote: 'The grader runs the tests itself on your submitted revision' }],
  deliverables: { sourceFiles: [{ path: 'src/export.js', quote: 'Add src/export.js' }], testLocation: null,
    answerFields: [{ name: 'rowCount', type: 'integer', exact: false, quote: 'report the row count in rowCount' }] },
  evidence: [], scenarios: ['TC-1'], constraints: [], dependsOn: [], zeroConditions: [],
  workload: { investigation: 'code', crossModule: false, uiChange: false, needsRunningApp: false, officialData: false } });

test('workers start at once; one analyst per wave profiles the items and the worker gets the checklist at ready_for_evidence', async () => {
  const f = analystFixture(), wf = f.rt.workflow;
  wf.autoPrepare();
  await f.rt.jobs.jobs.get(f.ji.prepareJobId).promise;
  assert.equal(f.ji.analysis.state, 'pending');
  const first = wf.offered(wf.actions()).nextActions;
  assert.deepEqual(first.map(a => a.action).sort(), ['spawn_analyst', 'spawn_worker'], 'the worker does not wait for the analyst');
  const analyst = first.find(a => a.action === 'spawn_analyst');
  assert.deepEqual([analyst.spawn.task_name, analyst.spawn.agent_type, analyst.items], ['wave1_analyst', 'team_analyst', ['CR-01']]);
  assert.deepEqual(wf.actions().nextActions.map(a => a.action), ['spawn_worker'], 'the analyst is offered once: root is not woken again while it reads');
  const input = readFileSync(f.rt.journal.data.waves[f.ji.analysis.wave].file, 'utf8');
  for (const re of [/<item_input id="CR-01" type="CR" points="140">[\s\S]*Hidden tests check the export/, /<profile_schema>[\s\S]*"title": "item-profile"/, /<wave_schema>[\s\S]*"title": "wave-report"/, /phase: "wave"/]) assert.match(input, re);
  // Trích dẫn bịa bị từ chối; analyst không bao giờ thành thợ của đề.
  const bad = PROFILE(); bad.grading.push({ aspect: 'detection', quote: 'Your tests are run against broken builds' });
  const refused = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'profile', profile: bad });
  assert.equal(refused.accepted, false); assert.match(refused.problems.join('\n'), /quotes not found word for word/);
  assert.equal(f.ji.workerThread, undefined);
  const ok = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'profile', profile: PROFILE() });
  assert.equal(ok.accepted, true); assert.equal(f.ji.analysis.state, 'done');
  const brief = readFileSync(join(f.rt.itemDir(f.key), 'brief.md'), 'utf8');
  assert.match(brief, /^<item_profile>$[\s\S]*form: feature[\s\S]*mutation check: not graded for this item[\s\S]*<\/item_profile>/m);
  assert.match(brief, /<checklist>[\s\S]*submit\.json rowCount: integer, filled[\s\S]*src\/export\.js exists in your change[\s\S]*<\/checklist>\n\n<item>/);
  // Thợ đang làm nhận checklist một lần, ở ready_for_evidence.
  const note = wf.analysisNote(f.key);
  assert.match(note, /Checklist:[\s\S]*submit\.json rowCount: integer, filled/);
  assert.equal(wf.analysisNote(f.key), null, 'delivered once');
  // Hồ sơ nói đề không chấm khả năng phát hiện lỗi: không đòi mutants dù item sửa code có sẵn và thêm test.
  Object.assign(f.ji, { worktreeBase: f.base, prepared: { timeBox: { returnBy: new Date(Date.now() + 20 * 60_000).toISOString() } } });
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.test.js'), "test('value', () => {});\n");
  assert.equal(await wf.mutantGate(f.key), null);
  // Checklist: trường trả lời trống và file đề nêu tên chưa có thì từ chối một lần, lần sau chỉ cảnh báo.
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'PARTIAL', rowCount: null }));
  const gate = await wf.checklistGate(f.key);
  assert.match(gate.problem, /submit\.json rowCount is empty.*src\/export\.js is not in your change/);
  assert.match((await wf.checklistGate(f.key)).warning, /accepted on the second handoff/);
  writeFileSync(join(f.wt.matchRoot, 'src', 'export.js'), 'export const rows = 1;\n');
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'DONE', rowCount: 3 }));
  assert.equal(await wf.checklistGate(f.key), null);
});

// DVVFEPXF: CR-08 cần CR-05, lên main trước và mang theo bản CR-05 cũ; CR-05 publish hỏng 3 lần.
test('the wave report adds dependencies and shared files; a waiting item holds its publish while it has time', async () => {
  const f = analystFixture(), wf = f.rt.workflow;
  f.rt.gm.view.items.push({ key: 'BUG-02', status: 'OPEN', raw: { descriptionMd: 'Fix the invoice totals the export reads.' } });
  wf.autoPrepare();
  await f.rt.jobs.jobs.get(f.ji.prepareJobId).promise;
  wf.offered(wf.actions());
  const call = wave => f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'wave', wave });
  const report = { dependencies: [{ item: 'CR-01', needs: 'BUG-02', kind: 'figures', quote: 'Fix the invoice totals the export reads' }],
    sharedAreas: [{ files: ['src/routes.js'], items: ['CR-01', 'BUG-02'], kind: 'registration', note: 'both add a route' }], landingOrder: ['CR-01'] };
  const bad = await call({ ...report, dependencies: [{ item: 'CR-01', needs: 'BUG-09', kind: 'code', quote: 'needs the fix of BUG-09' }], landingOrder: ['CR-01', 'BUG-02'] });
  assert.equal(bad.accepted, false);
  assert.match(bad.problems.join('\n'), /both must be backlog items \(BUG-09 is not\)/);
  assert.match(bad.problems.join('\n'), /landingOrder lists only the items of this wave.*BUG-02/);
  const invented = await call({ ...report, dependencies: [{ ...report.dependencies[0], quote: 'CR-01 requires the BUG-02 change first' }] });
  assert.match(invented.problems.join('\n'), /quote not found word for word in the text of CR-01 or BUG-02/);
  assert.equal(f.ji.workerThread, undefined);
  const ok = await call(report);
  assert.equal(ok.accepted, true);
  assert.deepEqual(f.ji.dependsOn, ['BUG-02']);
  assert.deepEqual(wf.neededBy('BUG-02'), ['CR-01'], 'the helper copies the fix of BUG-02 into CR-01 like a dependency named in the text');
  assert.match(wf.analysisNote(f.key), /Files other items of this wave change too: src\/routes\.js \(with BUG-02: registration, both add a route\)[\s\S]*only add new lines/);
  // BUG-02 còn đang làm và chưa lên main: CR-01 giữ publish khi còn dư thời gian, tới sát mốc cơ hội cuối thì thôi.
  const other = f.rt.journal.item('BUG-02');
  other.startedAt = new Date().toISOString();
  assert.equal(wf.dependencyHold(f.key, { minutesLeft: 30 }), 'BUG-02');
  assert.equal(wf.dependencyHold(f.key, { minutesLeft: 7 }), null, 'within two minutes of the last call: publish anyway');
  other.integratedAt = new Date().toISOString();
  assert.equal(wf.dependencyHold(f.key, { minutesLeft: 30 }), null, 'the waited-for item is on main');
});

// WQ7T6CEC: PI prepare xong sau 15 s, các đề code cùng phút sau 50 s; trần gom 20 s tách release-7 thành hai đợt.
test('items released in the same minute make one wave while one still prepares; after 90 s a late one opens a follow-up wave', async () => {
  const f = analystFixture(), wf = f.rt.workflow;
  f.rt.gm.view.items[0].revealedElapsedSec = 425;
  const add = (key, sec) => f.rt.gm.view.items.push({ key, status: 'OPEN', revealedElapsedSec: sec, raw: { descriptionMd: `Fix ${key}.` } });
  const slowPrepare = key => {
    let finish;
    const job = f.rt.jobs.start('prepare_item', () => new Promise(res => { finish = res; }), { key });
    f.rt.journal.item(key).prepareJobId = job.id;
    return () => { finish({}); return job.promise; };
  };
  add('BUG-02', 440);
  const done02 = slowPrepare('BUG-02');
  wf.autoPrepare();
  await f.rt.jobs.jobs.get(f.ji.prepareJobId).promise;
  const w = f.rt.journal.data.waves[f.ji.analysis.wave];
  assert.equal(w.id, 'release-7');
  w.firstReadyAt = new Date(Date.now() - 60_000).toISOString();
  assert.ok(!wf.actions().nextActions.some(a => a.action === 'spawn_analyst'), 'a minute after the first item the wave still waits for BUG-02');
  wf.joinWave('BUG-02');
  await done02();
  const first = wf.offered(wf.actions()).nextActions.find(a => a.action === 'spawn_analyst');
  assert.deepEqual([first.wave, first.items], ['release-7', ['CR-01', 'BUG-02']]);
  // Đợt đã đưa cho analyst: đề cùng phút prepare xong sau đó vào đợt nối; đợt nối chờ đề còn prepare tối đa 90 s.
  add('CR-03', 450); add('CR-04', 455);
  const done03 = slowPrepare('CR-03');
  const next = wf.joinWave('CR-04');
  assert.equal(next.id, 'release-7+2');
  next.firstReadyAt = new Date(Date.now() - 60_000).toISOString();
  assert.ok(!wf.actions().nextActions.some(a => a.wave === 'release-7+2'));
  next.firstReadyAt = new Date(Date.now() - 91_000).toISOString();
  const capped = wf.actions().nextActions.find(a => a.wave === 'release-7+2');
  assert.deepEqual(capped.items, ['CR-04'], 'after 90 s the wave goes without the item still preparing');
  assert.equal(wf.joinWave('CR-03').id, 'release-7+3');
  await done03();
});

// WQ7T6CEC: file dùng chung là phần dùng được của báo cáo đợt, mà helper biết chắc từ các worktree đang làm.
test('items in work that change the same file hear it at ready_for_evidence, again only when the overlap changes', async () => {
  const f = fixture('CR-01'), wf = f.rt.workflow;
  f.ji.workerThread = '/root/cr01';
  f.rt.runChecks = async () => ({ state: 'running', runId: 'r-1' });
  const other = f.rt.wtPaths('BUG-02');
  sh('git', ['worktree', 'add', '-q', '--detach', other.worktreeRoot, 'HEAD'], f.checkout);
  const bug = f.rt.journal.item('BUG-02');
  Object.assign(bug, { startedAt: new Date().toISOString(), worktreeBase: f.ji.worktreeBase });
  writeFileSync(join(other.matchRoot, 'src', 'lib.js'), 'export const value=1;\nexport const extra=1;\n');
  mkdirSync(join(other.matchRoot, 'answers', 'BUG-02'), { recursive: true });
  writeFileSync(join(other.matchRoot, 'answers', 'BUG-02', 'submit.json'), '{}');
  assert.deepEqual(await wf.inFlightOverlap(f.key), [{ file: 'src/lib.js', items: ['BUG-02'] }], 'answers/ is not a shared file');
  const ready = () => f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  const res = await ready();
  assert.match(res.analysis, /Files other items are changing right now too: src\/lib\.js \(BUG-02\); in those files only add new lines, never edit or reorder an existing line/);
  assert.equal((await ready()).analysis, undefined, 'the same overlap is not repeated');
  writeFileSync(join(f.wt.matchRoot, 'src', 'routes.js'), 'export const a = 1;\n');
  writeFileSync(join(other.matchRoot, 'src', 'routes.js'), 'export const b = 1;\n');
  assert.match((await ready()).analysis, /right now too: src\/lib\.js \(BUG-02\), src\/routes\.js \(BUG-02\);/);
  // Bàn giao: chỉ cảnh báo, không từ chối.
  f.result(1);
  const handoff = await f.rt.workflow.candidateCheckpoint({ backlogItemKey: f.key, phase: 'candidate' });
  assert.ok(handoff.warnings.some(w => /other items in work change the same files right now: src\/lib\.js \(BUG-02\), src\/routes\.js \(BUG-02\)/.test(w)), JSON.stringify(handoff));
  assert.ok(!(handoff.problems ?? []).some(p => /same files/.test(p)));
  // Bản sửa helper chép từ CR-01 sang BUG-02 không phải chỗ trùng; đề đã nộp thì không còn tính.
  bug.sharedFix = { from: 'CR-01', files: ['M1/src/routes.js'] };
  assert.deepEqual(await wf.inFlightOverlap(f.key), [{ file: 'src/lib.js', items: ['BUG-02'] }]);
  bug.receipt = { id: 'r-2' };
  assert.deepEqual(await wf.inFlightOverlap(f.key), []);
});

test('the analysis input lists the files triage points to and what earlier items in work changed so far', async () => {
  const f = analystFixture(), wf = f.rt.workflow;
  f.ji.signals = { code: { terms: ['rowCount'], files: 2, modules: 1, test_files: 0, sample: ['src/export.js', 'src/lib.js'] } };
  const other = f.rt.wtPaths('BUG-02');
  sh('git', ['worktree', 'add', '-q', '--detach', other.worktreeRoot, 'HEAD'], f.checkout);
  Object.assign(f.rt.journal.item('BUG-02'), { startedAt: new Date().toISOString(), worktreeBase: f.base });
  writeFileSync(join(other.matchRoot, 'src', 'totals.js'), 'export const total = 0;\n');
  wf.autoPrepare();
  await f.rt.jobs.jobs.get(f.ji.prepareJobId).promise;
  await wf.liveRefresh;
  wf.actions();
  const input = readFileSync(f.rt.journal.data.waves[f.ji.analysis.wave].file, 'utf8');
  assert.match(input, /<item_input id="CR-01"[\s\S]*<likely_files>\nsrc\/export\.js\nsrc\/lib\.js\n<\/likely_files>\n<\/item_input>/);
  assert.match(input, /<earlier_items>\nBUG-02: in work; changed so far src\/totals\.js\n<\/earlier_items>/);
});

test('an item whose files reached main through an item that waited for it keeps its own version at sync', async () => {
  const f = fixture('CR-05'), file = join('M1', 'src', 'lib.js'), added = join('M1', 'src', 'month-close.js');
  const land = (rel, text, message) => { writeFileSync(join(f.checkout, rel), text); sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', message], f.checkout); };
  // CR-05 tạo month-close.js và sửa lib.js; CR-08 đã lên main với bản cũ của hai file đó cộng phần của nó.
  writeFileSync(join(f.wt.worktreeRoot, added), 'export const close = "final";\n');
  land(added, 'export const close = "early";\nexport const revision3 = true;\n', 'CR-08: work');
  land(file, 'export const value=3;\n', 'CR-08: lib');
  const waiting = f.rt.journal.item('CR-08');
  Object.assign(waiting, { sharedFix: { from: 'CR-05', files: ['M1/src/lib.js', 'M1/src/month-close.js'] }, integratedAt: new Date().toISOString() });
  assert.deepEqual([...f.rt.workflow.echoedFiles('CR-05')].sort(), ['M1/src/lib.js', 'M1/src/month-close.js']);
  await assert.rejects(f.rt.worktree({ action: 'sync', backlogItemKey: f.key }), /WORKTREE_CONFLICT/);
  const synced = await f.rt.worktree({ action: 'sync', backlogItemKey: f.key, prefer: [...f.rt.workflow.echoedFiles('CR-05')] });
  assert.equal(synced.synced, true);
  assert.deepEqual([...synced.preferred].sort(), ['M1/src/lib.js', 'M1/src/month-close.js']);
  const read = rel => readFileSync(join(f.wt.worktreeRoot, rel), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read(added), 'export const close = "final";\n');
  assert.equal(read(file), 'export const value=2;\n');
  assert.equal(f.ji.worktreeBase, sh('git', ['rev-parse', 'HEAD'], f.checkout));
});

test('a failed job keeps its error code in the journal', async () => {
  const f = fixture('BUG-01');
  const job = f.rt.jobs.start('publish_item', async () => { throw Object.assign(new Error('SYNC_REQUIRED: main changed files this item also changes'), { code: 'SYNC_REQUIRED' }); }, { key: f.key });
  await job.promise.catch(() => {});
  const saved = f.ji.jobs.find(j => j.id === job.id);
  assert.equal(saved.state, 'failed');
  assert.equal(saved.error.code, 'SYNC_REQUIRED');
  assert.match(saved.error.message, /main changed files/);
});

// BI7A5ACV: root publish mất một lượt model và một lượt guardian cho mỗi item (17 lần), CR-08 chờ root 3 phút.
test('the helper publishes every item type itself; with autoPublishAll off only PI and answer-only items', async () => {
  const f = fixture('BUG-01'), wf = f.rt.workflow;
  const act = { key: 'BUG-01', action: 'publish_item', arguments: { fixResultFile: f.result(1) } };
  assert.equal(wf.helperPublishes(act), false, 'fixture default: the root path');
  const base = f.rt.runtimeConfig.bind(f.rt);
  f.rt.runtimeConfig = () => ({ ...base(), autoPublishAll: true });
  assert.equal(wf.helperPublishes(act), true, 'a BUG handoff is published by the helper');
  assert.equal(wf.helperPublishes({ ...act, action: 'spawn_worker' }), false);
  f.ji.autoPublished = wf.publishMark(act);
  assert.equal(wf.helperPublishes(act), false, 'once per handoff: a failed publish goes back to root');
});

test('publish of an item whose file reached main through an item that waited for it syncs by itself and submits', { timeout: 120_000 }, async () => {
  const f = fixture('CR-05'), bodies = submitted(f);
  const checkpoint = f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler;
  f.ji.workerThread = '/root/cr05'; f.ji.workerState = 'writing';
  await checkpoint({ backlogItemKey: f.key, phase: 'ready_for_evidence', testsAdded: [] });
  const file = f.result(1);
  assert.equal((await checkpoint({ backlogItemKey: f.key, phase: 'candidate' })).handedOff, true);
  // CR-08 đã nhận bản lib.js cũ của CR-05, sửa thêm rồi lên main trước.
  writeFileSync(join(f.checkout, 'M1', 'src', 'lib.js'), 'export const value=3;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'CR-08: work'], f.checkout);
  const other = f.rt.journal.item('CR-08');
  // Không có dấu "đề chờ đã mang file này lên main": vẫn là SYNC_REQUIRED như trước.
  const plain = await publishDone(f, { backlogItemKey: f.key, fixResultFile: file });
  assert.equal(plain.error?.code, 'SYNC_REQUIRED', JSON.stringify(plain));
  assert.equal(f.ji.jobs.at(-1).error.code, 'SYNC_REQUIRED', 'the journal keeps why the publish failed');
  Object.assign(other, { sharedFix: { from: 'CR-05', files: ['M1/src/lib.js'] }, integratedAt: new Date().toISOString() });
  const done = await publishDone(f, { backlogItemKey: f.key, fixResultFile: file });
  assert.equal(done.result?.status, 'SUBMITTED', JSON.stringify(done));
  assert.ok(done.progress.includes('sync'), JSON.stringify(done.progress));
  assert.ok(done.result.warnings.some(w => /kept this item's version of M1\/src\/lib\.js/.test(w)), JSON.stringify(done.result.warnings));
  assert.equal(bodies.length, 1);
  assert.equal(sh('git', ['show', 'origin/main:M1/src/lib.js'], f.checkout), 'export const value=2;', 'the owner\'s final version is on main');
});

// DVVFEPXF: worktree checkout cả 14 trận cũ còn trong repo (34 816 file, 6% thuộc trận), prepare giữa trận 49–168 s.
test('a new worktree checks out only the match folder; changes in it are seen as usual', async () => {
  const f = fixture('BUG-01');
  mkdirSync(join(f.checkout, 'OLDMATCH', 'src'), { recursive: true });
  writeFileSync(join(f.checkout, 'OLDMATCH', 'src', 'old.js'), 'export const old = 1;\n');
  sh('git', ['add', 'OLDMATCH'], f.checkout); sh('git', ['commit', '-q', '-m', 'an earlier match'], f.checkout);
  f.rt.refreshCodegraph = async () => ({ skipped: 'test' });
  const { job } = await f.rt.createWorktreeOnce('CR-09');
  await job.promise.catch(() => {});
  const wt = f.rt.wtPaths('CR-09');
  assert.ok(existsSync(join(wt.matchRoot, 'src', 'lib.js')), 'the match folder is there');
  assert.equal(existsSync(join(wt.worktreeRoot, 'OLDMATCH')), false, 'other matches are not checked out');
  assert.equal(existsSync(join(f.checkout, 'OLDMATCH', 'src', 'old.js')), true, 'the main checkout keeps everything');
  writeFileSync(join(wt.matchRoot, 'src', 'lib.js'), 'export const value=9;\n');
  assert.match(sh('git', ['status', '--porcelain'], wt.worktreeRoot), /M M1\/src\/lib\.js/);
  assert.doesNotMatch(sh('git', ['status', '--porcelain'], wt.worktreeRoot), /OLDMATCH/, 'files outside the cone are not reported deleted');
});

// DVVFEPXF PI-03: candidate bị từ chối 7 s trước khi item đóng vì status "DONE" và confidence là chuỗi.
test('the words of submit.json in the result part are mapped to the fix-result contract instead of refused', async () => {
  const f = fixture('PI-03');
  const ok = await f.rt.workflow.composeResult(f.key, { status: 'DONE', summary: 'Midpoint fix and incident report.', confidence: '0.85',
    verification: [{ check: 'red-green', command: null, result: 'PASS', note: 'x' }], requirements: [], hypotheses: [{ cause: 'range posts the larger bound', check: 'red test', evidence: 'evidence/red.log', verdict: 'Confirmed' }] });
  assert.equal(ok.problems, undefined, JSON.stringify(ok));
  const written = JSON.parse(readFileSync(ok.file, 'utf8'));
  assert.deepEqual([written.status, written.confidence, written.verification[0].result, written.hypotheses[0].verdict], ['fixed', 0.85, 'pass', 'confirmed']);
  const bad = await f.rt.workflow.composeResult(f.key, { status: 'maybe', summary: 'x' });
  assert.match(bad.problems[0], /\.status: must be one of "fixed", "partial", "cannot_fix"/, 'an unknown word is still refused');
});

// ---------------------------------------------------------------- WQ7T6CEC: tốc độ prepare, mutants, baseline
// (a) Index codegraph của worktree dựng nền: không giữ prepare; sync (refreshCodegraph) chờ lần đang dựng, không chạy hai lần.
test('the worktree codegraph index builds in the background and a refresh waits for it instead of indexing twice', async () => {
  const f = fixture('CR-01');
  const { CODEGRAPH } = await import('../../pack/src/env/codegraph.mjs');
  const dir = join(f.root, 'team-sdlc-pack', 'codegraph', 'node_modules', ...CODEGRAPH.package.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: CODEGRAPH.package, version: CODEGRAPH.version }));
  writeFileSync(join(dir, 'npm-shim.js'), ["const fs = require('fs'), path = require('path');",
    'const [cmd, ...rest] = process.argv.slice(2); const target = rest[rest.length - 1];',
    "fs.mkdirSync(path.join(target, '.codegraph'), { recursive: true });",
    "fs.appendFileSync(path.join(target, '.codegraph', 'calls.log'), cmd + '\\n');",
    "setTimeout(() => fs.writeFileSync(path.join(target, '.codegraph', 'codegraph.db'), 'fake index'), 1500);"].join('\n'));
  const t0 = Date.now();
  assert.deepEqual(f.rt.indexInBackground(f.key, f.wt.matchRoot), { skipped: 'indexing in the background' });
  assert.deepEqual(f.rt.indexInBackground(f.key, f.wt.matchRoot), { skipped: 'indexing in the background' }, 'joins the running index');
  assert.ok(Date.now() - t0 < 500, 'returns at once');
  const refreshed = await f.rt.refreshCodegraph(f.key, f.wt.matchRoot);
  assert.ok(Date.now() - t0 >= 1400, 'the refresh waited for the background index');
  assert.equal(refreshed.freshness, 'fresh', JSON.stringify(refreshed));
  assert.deepEqual(readFileSync(join(f.wt.matchRoot, '.codegraph', 'calls.log'), 'utf8').trim().split(/\r?\n/), ['init'], 'indexed once');
  assert.equal(f.rt.codegraphIndexing.size, 0);
});

// (b) WQ7T6CEC: CR-07 tự chạy mutants 190 s, BUG-09 114 s, đề không chấm khả năng phát hiện lỗi.
test('run_checks mutants answers at once when the accepted profile grades no detection, in the root and in a worker helper', async () => {
  const f = fixture('CR-01');
  const call = rt => rt.runChecks({ action: 'mutants', backlogItemKey: f.key, matchRoot: f.wt.matchRoot, waitSeconds: 0 }).catch(e => ({ error: e.code }));
  assert.notEqual((await call(f.rt)).skipped, 'not graded', 'no profile: the check is not skipped');
  writeFileSync(join(f.rt.itemDir(f.key), 'profile.json'), JSON.stringify(PROFILE()));
  assert.notEqual((await call(f.rt)).skipped, 'not graded', 'a profile not accepted yet does not count');
  f.ji.analysis = { state: 'done' };
  const t0 = Date.now();
  const skipped = await call(f.rt);
  assert.deepEqual([skipped.state, skipped.skipped], ['skipped', 'not graded']);
  assert.match(skipped.hint, /no rule that runs your tests against broken builds/);
  assert.ok(Date.now() - t0 < 1000);
  const detection = PROFILE(); detection.grading.push({ aspect: 'detection', quote: 'x' });
  writeFileSync(join(f.rt.itemDir(f.key), 'profile.json'), JSON.stringify(detection));
  assert.notEqual((await call(f.rt)).skipped, 'not graded', 'detection graded: the check runs');
  const none = PROFILE(); none.grading = [];
  writeFileSync(join(f.rt.itemDir(f.key), 'profile.json'), JSON.stringify(none));
  assert.notEqual((await call(f.rt)).skipped, 'not graded', 'no grading rule stated: the check runs');
  // Helper của worker (chưa configure_session): đọc profile.json cạnh trận của matchRoot.
  const tw = tempDir('mtm-worker-mutants-'), items = join(tw, 'matches', 'M1', '.team-work', 'items', 'CR-01');
  mkdirSync(items, { recursive: true });
  writeFileSync(join(items, 'profile.json'), JSON.stringify(PROFILE()));
  const worker = new Runtime({ teamWorkspace: tw });
  assert.equal(worker.session.paths, null);
  const res = await worker.runChecks({ action: 'mutants', backlogItemKey: 'CR-01', matchRoot: join(tw, 'matches', 'M1', '.team-work', 'wt', 'CR-01', 'M1') });
  assert.deepEqual([res.state, res.skipped], ['skipped', 'not graded']);
});

// (c) WQ7T6CEC BUG-09: sau khi bản sửa baseline vào worktree, worker chạy lại cả bộ test và chờ 574 s. Candidate chỉ
// đòi chạy lại file của các test fail sẵn cộng test mới của item; không tính được danh sách thì vẫn cả bộ.
test('after the baseline fix lands, candidate asks for run_checks on the baseline test files and the own new tests only', async () => {
  const landed = async withProfile => {
    const f = baselineFixture();
    if (withProfile) {
      writeFileSync(join(f.wt.matchRoot, 'src', 'package.json'), JSON.stringify({ name: 'app', packageManager: 'npm@10.0.0', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } }));
      writeFileSync(join(f.wt.matchRoot, 'src', 'tests', 'export.test.js'), 'expect(1).toBe(1);\n');
    }
    f.ji.workerState = 'writing';
    f.result(1);
    f.ownerFix();
    await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'baseline_fixed', files: ['src/status.js'] });
    await f.rt.workflow.landBaseline();
    const res = await f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'candidate' });
    assert.equal(res.handedOff, false, JSON.stringify(res));
    return res.problems[0];
  };
  const selected = await landed(true);
  assert.match(selected, /BUG-01's fix for the baseline failures just landed on main/);
  assert.ok(selected.includes('run_checks {"checks":["test"],"testFiles":["tests/status.test.js","tests/export.test.js"]}'), selected);
  assert.match(selected, /Do not run the full suite again/);
  assert.match(selected, /Scenarios and screenshots you already verified stay PASS: do not recapture them/);
  const full = await landed(false);
  assert.match(full, /run the full suite once more/, 'no project profile: the full suite as before');
  assert.doesNotMatch(full, /testFiles/);
});
