// Kiểm workflow với git/worktree thật; không gọi LLM hay mạng ngoài.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../../pack/src/tools.mjs';
import { itemSkills } from '../../pack/src/match/workflow.mjs';
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
  // Giữ PASS độc lập; dependency đổi dữ liệu phải replay, không giữ PASS cũ vô điều kiện (CR-07/OMZJW0S0).
  assert.match(stop.followup, /Keep independent verified scenarios PASS/);
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
  writeFileSync(checks, JSON.stringify({ runId: 'r1', key: f.key, state: 'done', matchRoot: f.wt.matchRoot, snapshot: await f.rt.workflow.snapshot(f.key), results: [
    { name: 'typecheck', command: 'pnpm run typecheck', state: 'passed', exitCode: 0, log: 'evidence/typecheck.log' },
    { name: 'test', command: 'pnpm test', state: 'failed', exitCode: 1, log: 'evidence/full-suite.log', counts: { total: 3, passed: 2, failed: 1 }, failing: ['tests/old.test.js > old'] }] }));
  f.rt.journal.data.preparation.baseline = { failing: ['tests/old.test.js > old'] };
  const part = { status: 'fixed', summary: 'Value is 2', root_cause: 'value was 1', requirements: [{ id: 'AC-1', status: 'met', evidence: 'src/lib.js:1' }],
    verification: [{ check: 'TC-1', command: null, result: 'pass', note: 'observed' }] };
  let res = await checkpoint({ backlogItemKey: f.key, phase: 'candidate', result: { ...part, status: 'done' } });
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
  // Server này không lọc theo query, nên kho chung dừng ngay và helper lùi về cách dò từng service.
  assert.match(brief, /timeline \(partial: 4 of 40 entries \(unfiltered\); search_logs returns at most 20 entries per call/);
  assert.doesNotMatch(brief, /<skills>|<profile>|<skill_text>/, 'the playbook replaces the skill files');
});

// Server giả như Company Tools của trận: mọi từ của query là một từ nguyên vẹn của dòng, mới nhất trước, tối đa 20 dòng.
function logServer(logs, calls = []) {
  const words = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return async (name, args) => {
    calls.push([name, args]);
    const text = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
    if (name === 'kb_search') return text({ articles: [{ id: 'KB-RULE-01', body: 'Rules are ranked by score.' }] });
    const want = words(args.query ?? '');
    const hit = logs.filter(e => (!args.service || e.service === args.service) && want.every(w => words(JSON.stringify(e)).includes(w)))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return text({ total: hit.length, returned: Math.min(20, hit.length), entries: hit.slice(0, 20) });
  };
}
const ruleLogs = n => Array.from({ length: n }, (_, i) => ({ ts: new Date(Date.parse('2025-10-13T00:00:00.000Z') + i * 611_000).toISOString(),
  service: i % 9 ? 'rule-engine' : 'deploy', level: 'INFO', requestId: `pi-${i}`, message: 'rule.applied', context: { seq: 3100000 + i } }));

// OMZJW0S0: brief PI-02 có 6 service, cả 6 chỉ 20/N và thiếu đúng rule-engine, deploy; fixer tự chia query theo giờ
// (168 lời gọi, 93 s) sau một vòng hỏi root.
test('a PI gets the complete production log from the shared store, every service in one timeline, no per-service probing', async () => {
  const f = fixture('PI-01', true);
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, verificationKind: undefined });
  f.rt.gm.view.items[0].raw = { title: 'Transactions land in the wrong category', points: 90,
    descriptionMd: '## Context\nFinance sees wrong categories.\n## Out of scope\nChanging the application source.\n' };
  f.rt.startWork = async () => ({ type: 'PI', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key),
    files: [], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' }, requirements: [] });
  const logs = ruleLogs(300), calls = [];
  f.rt.company.list = async () => [{ name: 'kb_search', inputSchema: {} }, { name: 'search_logs', inputSchema: { properties: { query: {}, service: {} } } }];
  f.rt.company.invoke = logServer(logs, calls);
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  const company = join(f.rt.session.paths.teamWork, 'items', f.key, 'company');
  const timeline = JSON.parse(readFileSync(join(company, 'timeline.json'), 'utf8'));
  assert.equal(timeline.complete, true);
  assert.equal(timeline.entries.length, 300);
  assert.deepEqual(timeline.services.map(s => [s.service, s.entries]), [['rule-engine', 266], ['deploy', 34]]);
  assert.equal(readFileSync(join(company, 'timeline.json'), 'utf8').split('\n').filter(l => l.startsWith('{"ts"')).length, 300, 'one entry per line');
  assert.ok(!calls.some(([, a]) => a?.service), 'no per-service probing once the store is complete');
  assert.deepEqual(readdirSync(company).filter(n => /search_logs/.test(n)), []);
  assert.ok(readdirSync(join(f.wt.matchRoot, 'answers', f.key, 'evidence')).includes('timeline.json'));
  const brief = readFileSync(done.result.briefFile, 'utf8');
  assert.match(brief, /timeline \(complete: all 300 production log entries of every service \(rule-engine 266, deploy 34\)[^)]*no need to query search_logs again\)/);
  assert.equal(f.rt.journal.data.items[f.key].logTimeline.complete, true);

  // Lần prepare PI sau: log không đổi thì làm mới kho chỉ tốn một lời gọi.
  calls.length = 0;
  const again = await f.rt.harvestJob('normal');
  await again.promise;
  assert.deepEqual(calls.map(([, a]) => a.query), ['']);
});

// OMZJW0S0: fixer PI-02 chỉ ra lỗi ở 0:49 nhưng 5:39 mới sửa (gom log trước), rồi ~4 phút cho check cuối; cả hai fixer
// PI thử limit/pageSize/maxResults cho search_logs rồi dừng hỏi root schema.
test('a code-changing PI brief puts the fix first, closing checks in the background while answers are derived, and the search_logs schema', async () => {
  const f = fixture('PI-02');
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, verificationKind: undefined });
  f.rt.gm.view.items[0].raw = { title: 'Transactions land in the wrong category', points: 90,
    descriptionMd: '## What we need\n1. rootCauseRelease\nThen fix the fault in the application source.\n## Out of scope\nCorrecting the categories of existing transactions.\n' };
  f.rt.startWork = async () => ({ type: 'PI', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key),
    files: [], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' }, requirements: [] });
  f.rt.worktree = async () => ({ ...f.wt, setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
  const tools = [{ name: 'kb_search', inputSchema: {} }, { name: 'search_logs', inputSchema: { properties: { service: { type: 'string' }, query: { type: 'string' } } } }];
  f.rt.company.list = async () => { f.rt.company.tools = tools; return tools; };
  f.rt.company.invoke = logServer(ruleLogs(60));
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(done.result.reportOnly, false);
  const brief = readFileSync(done.result.briefFile, 'utf8');
  const block = brief.slice(brief.indexOf('<pi_hotfix>'), brief.indexOf('</pi_hotfix>'));
  assert.ok(block.length > 0, 'Form B gets the hotfix block');
  assert.doesNotMatch(brief, /<report_only_pi>/);
  const order = ['answers/PI-02/evidence/red.log', 'worker_checkpoint ready_for_evidence', 'answers/PI-02/evidence/derive.mjs', 'run_checks {action: "status"', 'worker_checkpoint candidate'];
  const at = order.map(s => block.indexOf(s));
  assert.ok(at.every(i => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'fix, then checks in the background, then answers, then status and handoff');
  assert.match(brief, /<company_facts>[\s\S]*search_logs input: \{"service":\{"type":"string"\},"query":\{"type":"string"\}\}\. It returns at most 20 entries per call, newest first/);
  assert.match(brief, /<company_facts>[\s\S]*timeline \(complete: all 60 production log entries/);
  assert.match(brief, /<skill_text>/, 'Form B keeps the skill files');
});

test('a PI prepared while the store is still collecting gets a partial timeline that the harvest job rewrites, evidence copy included', async () => {
  const f = fixture('PI-01', true);
  Object.assign(f.ji, { startedAt: undefined, workerState: undefined, verificationKind: undefined });
  f.rt.gm.view.items[0].raw = { title: 'Wrong categories', points: 90, descriptionMd: '## Out of scope\nChanging the application source.\n' };
  f.rt.startWork = async () => ({ type: 'PI', triage: { models: {} }, materialsDir: join(f.rt.session.paths.teamWork, 'items', f.key),
    files: [], timeBox: { returnBy: '2099-11-04T05:00:00.000Z' }, requirements: [] });
  const base = f.rt.runtimeConfig.bind(f.rt);
  f.rt.runtimeConfig = () => ({ ...base(), logWaitMs: 20 });
  const logs = ruleLogs(120), serve = logServer(logs);
  let release;
  const gate = new Promise(r => { release = r; });
  f.rt.company.list = async () => [{ name: 'kb_search', inputSchema: {} }, { name: 'search_logs', inputSchema: { properties: { query: {} } } }];
  f.rt.company.invoke = async (name, args) => {
    if (name === 'search_logs' && args.query) await gate;   // lời gọi gốc trả ngay, phần chia nhỏ treo tới khi release
    return serve(name, args);
  };
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key, waitSeconds: 0 });
  await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done));
  const brief = readFileSync(done.result.briefFile, 'utf8');
  assert.match(brief, new RegExp(`timeline \\(partial: 20 of 120 entries; helper job ${f.rt.logJobId} still collects the rest`));
  const evidence = join(f.wt.matchRoot, 'answers', f.key, 'evidence', 'timeline.json');
  assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).complete, false);
  release();
  const harvest = await f.rt.jobs.jobs.get(f.rt.logJobId).promise;
  assert.equal(harvest.result.complete, true, JSON.stringify(harvest.result));
  assert.deepEqual(harvest.result.timelinesRewritten, [f.key]);
  for (const file of [join(f.rt.session.paths.teamWork, 'items', f.key, 'company', 'timeline.json'), evidence]) {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(t.complete, true, file);
    assert.equal(t.entries.length, 120, file);
  }
});

// EIOR38SI: helper thấy → fixer bắt đầu trung bình 1m24s, trong đó install/generate/migrate/seed 45–105 s. Fixer được
// spawn ngay khi worktree, index và brief có, rồi tự chờ job setup trước lần build/test/app đầu tiên.
test('prepare hands the item to a worker while dependency setup still runs, and the brief says to wait for that job', async () => {
  const f = fixture('CR-01');
  Object.assign(f.ji, { workerState: undefined });
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

// OMZJW0S0: prepare ghi PASS nhưng GAME mới phát hiện lỗi chung. Không sửa lịch sử baseline hay suy ra PASS.
function sharedFixture() {
  const f = baselineFixture();
  f.rt.journal.data.preparation = { baseline: { status: 'PASS', failing: [], counts: null } };
  f.oi.needsSuite = true;
  f.ji.workerThread = '/root/bug02'; f.oi.workerThread = '/root/bug01';
  for (const [key, root] of [['BUG-01', f.owner.matchRoot], ['BUG-02', f.wt.matchRoot]]) {
    const dir = join(root, 'answers', key, 'evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shared.log'), 'original assertion fails independently of this item\n');
  }
  const report = (key = 'BUG-02', failingTests = ['tests/status.test.js > paid in full']) => f.rt.proxyCall('worker_checkpoint', {
    backlogItemKey: key, phase: 'shared_failure', failure: { summary: 'Issued assertion fails before this item', failingTests, evidence: ['evidence/shared.log'] }
  });
  const manage = args => f.rt.definitions().find(t => t.name === 'shared_failure').handler(args);
  return { ...f, report, manage };
}

test('late shared reports coalesce across workers, persist across restart, and only root can assign', async () => {
  const f = sharedFixture(), original = structuredClone(f.rt.journal.data.preparation);
  const reports = await Promise.all([f.report(), f.report('BUG-01')]);
  assert.equal(reports[0].failureId, reports[1].failureId); assert.equal(reports[1].duplicate, true);
  assert.equal(f.rt.workflow.sharedFailures.records().length, 1);
  assert.equal(f.rt.workflow.sharedFailures.records()[0].reports.length, 2);
  assert.deepEqual(f.rt.journal.data.preparation, original);
  const next = f.rt.workflow.actions().nextActions.find(a => a.action === 'assign_shared_failure');
  assert.equal(next.arguments.failureId, reports[0].failureId);
  assert.deepEqual(next.candidates.sort(), ['BUG-01', 'BUG-02']);
  assert.throws(() => f.rt.proxyCall('shared_failure', { action: 'assign' }), /PROXY_DENIED/);
  f.rt.journalObj = new Journal(f.rt.session.paths.teamWork);
  assert.equal(f.rt.workflow.sharedFailures.records()[0].reports.length, 2);
  const assigned = f.manage({ action: 'assign', failureId: reports[0].failureId, owner: 'BUG-01', kind: 'product', reason: 'Reproduced on the unfixed product in both logs' });
  assert.equal(assigned.workerThread, '/root/bug01'); assert.match(assigned.followup, /shared_failure_fixed/);
  assert.throws(() => f.manage({ action: 'assign', failureId: reports[0].failureId, owner: 'BUG-02', kind: 'product', reason: 'duplicate owner' }), /SHARED_FAILURE_BUSY/);
  assert.equal(f.manage({ action: 'assign', failureId: reports[0].failureId, owner: 'BUG-01', kind: 'product', reason: 'same assignment' }).owner, 'BUG-01');
});

test('a late product owner lands only the assigned files and affected worktrees refresh before publishing', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Confirmed before item changes' });
  f.result(1); f.ji.checkpoint = 'candidate';
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, fixResultFile: join(f.results, 'BUG-02-fixer-1.json') }), /BASELINE_PENDING/);
  await assert.rejects(f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'shared_failure_fixed', failureId, files: ['src/status.js'] }), /NOT_BASELINE_OWNER/);
  f.ownerFix(); writeFileSync(join(f.owner.matchRoot, 'src', 'own-item.js'), 'not part of shared repair\n');
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId, files: ['src/status.js'] });
  assert.deepEqual(await f.rt.workflow.autoBaseline(), ['BUG-02']);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED);
  assert.equal(existsSync(join(f.checkout, 'M1', 'src', 'own-item.js')), false);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'lib.js')), 'export const value=2;\n');
  assert.equal(f.rt.journal.data.preparation.baseline.status, 'PASS');
  const issue = f.rt.workflow.sharedFailures.get(failureId);
  assert.equal(f.ji.sharedBaselineFixes[failureId], issue.baselineFix.revision);
  const refresh = f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02');
  assert.equal(refresh.action, 'refresh_candidate'); assert.match(refresh.followup, /BUG-01/);
  f.result(2);
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02').action, 'publish_item');
});

test('independent late product failures keep separate frozen fixes and one sync includes both', async () => {
  const f = sharedFixture(), first = (await f.report()).failureId;
  const second = (await f.report('BUG-02', ['another.test.js > other assertion'])).failureId;
  for (const failureId of [first, second]) f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Independent failure reproduced on issued source' });
  f.ownerFix();
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId: first, files: ['src/status.js'] });
  writeFileSync(join(f.owner.matchRoot, 'src', 'other.js'), 'another corrected behavior\n');
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId: second, files: ['src/other.js'] });
  f.result(1); f.ji.checkpoint = 'candidate';
  await f.rt.workflow.autoBaseline();
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'other.js')), 'another corrected behavior\n');
  assert.equal(Object.keys(f.ji.sharedBaselineFixes).length, 2);
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
});

test('late report evidence stays inside its item and unassigned reports do not prove a baseline', async () => {
  const f = sharedFixture();
  const bad = evidence => f.rt.proxyCall('worker_checkpoint', { backlogItemKey: 'BUG-02', phase: 'shared_failure', failure: { summary: 'suspected', failingTests: ['test A'], evidence } });
  assert.throws(() => bad(['evidence/../../submit.json']), /PATH_NOT_ALLOWED/);
  assert.throws(() => bad(['evidence/missing.log']), /missing/);
  const { failureId } = await f.report();
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
  await assert.rejects(f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'shared_failure_fixed', failureId, files: [] }), /assigned product failure/);
  f.manage({ action: 'defer', failureId, reason: 'Evidence shows a regression in this item; reporter must repair its own code' });
  assert.equal(f.manage({ action: 'status' }).failures[0].state, 'deferred');
  assert.equal(f.rt.journal.data.preparation.baseline.status, 'PASS');
});

test('an ended shared owner is reassigned explicitly, and deferral releases waits without claiming success', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Reproduced independently' });
  f.oi.endedAt = new Date().toISOString();
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner');
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.action === 'assign_shared_failure').arguments.failureId, failureId);
  assert.equal(f.manage({ action: 'assign', failureId, owner: 'BUG-02', kind: 'product', reason: 'Previous owner ended without the repair' }).owner, 'BUG-02');
  assert.throws(() => f.manage({ action: 'defer', failureId }), /reason/);
  f.manage({ action: 'defer', failureId, reason: 'Insufficient time to reproduce safely; acceptance requirement remains failed' });
  assert.match(f.manage({ action: 'status' }).failures[0].resolution, /remains failed/);
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
});

// 85WTXFLQ: PI-02, PI-03 và TASK-10 không chạy cả bộ test mà vẫn bị shared-1 giữ; TASK-08 nhận sửa lúc 03:16 và không
// xong tới hết trận, BUG-09 bàn giao 03:21 rồi chờ mãi. Không item nào được nộp.
test('a shared failure does not hold a PI or an item that changed only its answers, unless root names it', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Reproduced on the issued parser' });
  f.result(1, fix({ changed_files: ['src/lib.js', 'answers/BUG-02/submit.json'] }));
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner', 'a source change waits for the repair');
  f.result(2, fix({ changed_files: ['answers/BUG-02/submit.json', 'answers/BUG-02/evidence/derive.log'] }));
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null, 'only answers changed: the suite on its commit is the issued one');
  const issue = f.rt.workflow.sharedFailures.get(failureId);
  issue.affectedItems = ['BUG-01', 'BUG-02'];
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner', 'root named it explicitly');
  issue.affectedItems = null;
  f.result(3, fix({ changed_files: ['src/lib.js'] }));
  const pi = f.rt.journal.item('PI-01');
  Object.assign(pi, { startedAt: new Date().toISOString(), needsSuite: true });
  assert.equal(f.rt.workflow.baselineApplies('PI-01', issue), false, 'a PI is ranked by submission order and never waits');
});

test('the wait for a shared owner ends after sharedFixWaitMinutes, for waiting items and for the owner itself', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Reproduced on the issued parser' });
  f.result(1); f.ji.checkpoint = 'candidate';
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, fixResultFile: join(f.results, 'BUG-02-fixer-1.json') }), /BASELINE_PENDING/);
  f.oi.workerState = 'yielded';
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-01').action, 'refresh_candidate');
  const issue = f.rt.workflow.sharedFailures.get(failureId);
  issue.assignedAt = new Date(Date.now() - 7 * 60_000).toISOString();
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner', 'still inside the default 8 minutes');
  issue.assignedAt = new Date(Date.now() - 8 * 60_000).toISOString();
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
  assert.deepEqual(f.rt.workflow.actions().nextActions.filter(a => a.key === 'BUG-02').map(a => a.action), ['publish_item']);
  assert.notEqual(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-01')?.action, 'refresh_candidate', 'the owner is no longer held to the repair');
  assert.equal(f.rt.workflow.sharedFailures.get(failureId).state, 'assigned', 'the owner may still land the repair');
});

test('environment resolution requires a fresh full check on each affected copy and never marks it PASS', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'environment', reason: 'Standalone runtime reproduction, no product dependency' });
  f.result(1); f.ji.checkpoint = 'candidate';
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, fixResultFile: join(f.results, 'BUG-02-fixer-1.json') }), /SHARED_ENVIRONMENT_PENDING/);
  assert.throws(() => f.manage({ action: 'resolve', failureId, reason: 'runtime corrected' }), /evidence/);
  f.manage({ action: 'resolve', failureId, reason: 'Correct runtime applied to every affected helper and working copy', evidence: ['evidence/shared.log'] });
  const issue = f.rt.workflow.sharedFailures.get(failureId);
  const action = f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02');
  assert.equal(action.reason, 'shared_environment'); assert.match(action.followup, /force:true/);
  f.ji.workerState = 'writing';
  let res = await f.checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  assert.equal(res.handedOff, false); assert.match(res.problems.join(), /environment correction/);
  const snapshot = await f.rt.workflow.snapshot(f.key);
  const file = join(f.rt.session.paths.teamWork, 'items', f.key, 'checks.json');
  mkdirSync(dirname(file), { recursive: true });
  const checks = { state: 'done', matchRoot: f.wt.matchRoot, snapshot, source: snapshot.source,
    startedAt: new Date(Date.parse(issue.endedAt) + 1).toISOString(), endedAt: new Date(Date.parse(issue.endedAt) + 2).toISOString(),
    results: ['typecheck', 'build', 'test'].map(name => ({ name, state: name === 'test' ? 'failed' : 'passed', command: 'actual command' })) };
  writeFileSync(file, JSON.stringify({ ...checks, startedAt: new Date(Date.parse(issue.endedAt) - 60_000).toISOString() }));
  res = await f.checkpoint({ backlogItemKey: f.key, phase: 'candidate' }); assert.equal(res.handedOff, false, 'a check started before resolution is stale');
  writeFileSync(file, JSON.stringify({ ...checks, snapshot: { ...snapshot, environment: 'old environment' } }));
  res = await f.checkpoint({ backlogItemKey: f.key, phase: 'candidate' }); assert.equal(res.handedOff, false, 'environment fingerprint must match');
  writeFileSync(file, JSON.stringify(checks));
  res = await f.checkpoint({ backlogItemKey: f.key, phase: 'candidate' }); assert.equal(res.handedOff, true);
  assert.equal(f.ji.sharedEnvironmentSeen[failureId], issue.endedAt);
  assert.equal(f.manage({ action: 'status' }).failures[0].state, 'resolved');
  assert.equal(f.rt.journal.data.preparation.baseline.status, 'PASS');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).results[2].state, 'failed', 'resolution does not turn failed checks into PASS');
});

test('writing workers receive a late repair only at checkpoint and preserve their own edits', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Reproduced before source edits' });
  f.ji.workerState = 'writing'; f.result(1); f.ownerFix();
  await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId, files: ['src/status.js'] });
  await f.rt.workflow.autoBaseline();
  assert.notEqual(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED, 'no sync under a writing worker');
  const res = await f.checkpoint({ backlogItemKey: 'BUG-02', phase: 'candidate' });
  assert.equal(res.handedOff, false); assert.match(res.problems.join(), /BUG-01.*run the full suite/);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), FIXED);
  assert.equal(text(join(f.wt.matchRoot, 'src', 'lib.js')), 'export const value=2;\n');
  assert.equal(f.ji.workerState, 'writing');
});

test('a shared sync conflict preserves work, asks for reconciliation and does not retry every poll', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Confirmed original failure' });
  const own = 'export const paid = (p, t) => p === t;\n';
  writeFileSync(join(f.wt.matchRoot, 'src', 'status.js'), own); f.result(1); f.ji.checkpoint = 'candidate';
  f.ownerFix(); await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId, files: ['src/status.js'] });
  await f.rt.workflow.autoBaseline();
  assert.equal(text(join(f.wt.matchRoot, 'src', 'status.js')), own);
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'conflict');
  assert.deepEqual(await f.rt.workflow.autoBaseline(), []);
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02').reason, 'shared_sync_conflict');
  // Người sửa hòa giải source rồi helper sync qua đúng đường ghi nhận revision.
  writeFileSync(join(f.wt.matchRoot, 'src', 'status.js'), FIXED);
  await f.rt.worktree({ action: 'sync', backlogItemKey: 'BUG-02' });
  assert.equal(f.ji.sharedBaselineSyncErrors?.[failureId], undefined);
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
});

test('an assigned owner must finish or explicitly defer, while last-chance publication remains available', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-02', kind: 'product', reason: 'Reporter owns the verified repair' });
  f.result(1); f.ji.checkpoint = 'candidate';
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02').reason, 'shared_failure_owner');
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: 'BUG-02', fixResultFile: join(f.results, 'BUG-02-fixer-1.json') }), /SHARED_FAILURE_PENDING/);
  f.rt.itemRows = () => f.rows(4);
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02').action, 'publish_item');
  f.rt.itemRows = () => f.rows();
  f.ji.prepared = { timeBox: { returnBy: new Date(Date.now() - 1000).toISOString() } };
  assert.ok(f.rt.workflow.actions().nextActions.some(a => a.action === 'assign_shared_failure'), 'expired owner needs an explicit reassignment');
  f.manage({ action: 'defer', failureId, reason: 'Item time box expired; test requirement remains unmet' });
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === 'BUG-02').action, 'publish_item');
});

test('landing a late fix never overwrites a newer main edit to the same file', async () => {
  const f = sharedFixture(), { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Original failing assertion reproduced' });
  f.ownerFix(); await f.checkpoint({ backlogItemKey: 'BUG-01', phase: 'shared_failure_fixed', failureId, files: ['src/status.js'] });
  const latest = 'export const paid = (p, t) => p >= t && t > 0;\n';
  writeFileSync(join(f.checkout, 'M1', 'src', 'status.js'), latest);
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'another item changes the same file'], f.checkout);
  const issue = f.rt.workflow.sharedFailures.get(failureId);
  for (let i = 0; i < 3; i++) assert.equal(await f.rt.workflow.landBaseline(issue), null);
  assert.equal(text(join(f.checkout, 'M1', 'src', 'status.js')), latest);
  assert.equal(issue.baselineFix.state, 'failed'); assert.match(issue.baselineFix.error.message, /reconcile/);
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner', 'a failed landing still needs root to reassign or defer');
  assert.ok(f.rt.workflow.actions().nextActions.some(a => a.action === 'assign_shared_failure' && a.arguments.failureId === failureId));
});

test('late shared repairs do not hold answer-only items or require a prepare-time suite flag', async () => {
  const f = sharedFixture();
  f.ji.needsSuite = false;
  const { failureId } = await f.report();
  f.manage({ action: 'assign', failureId, owner: 'BUG-01', kind: 'product', reason: 'Runtime reproduction is independent of the prepare-time suite flag' });
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), 'owner');
  f.rt.answerOnlyItem = key => key === 'BUG-02';
  assert.equal(f.rt.workflow.baselineWait('BUG-02'), null);
  assert.throws(() => f.report(), /active code item/);
});

// CR-07: dependency đổi pipeline; output và summary phải thuộc cùng một replay, không chỉ cùng tên file.
function dependencyFixture() {
  const f = fixture('CR-01', false, { 'src/import-pipeline.js': 'export const sign = 1;\n' });
  const depKey = 'BUG-02', dep = f.rt.journal.item(depKey);
  dep.startedAt = new Date().toISOString(); f.ji.workerThread = '/root/cr01';
  f.rt.gm.view.items.push({ key: depKey, title: 'Import sign', raw: { descriptionMd: 'Fix import sign.' } });
  const template = { status: 'NOT_STARTED', testResults: [{ id: 'TC-1', result: 'NOT_RUN', evidence: [] }, { id: 'TC-UI', result: 'NOT_RUN', evidence: [] }] };
  writeFileSync(join(f.rt.session.paths.teamWork, 'items', f.key, 'template.json'), JSON.stringify(template));
  const answer = { status: 'PARTIAL', testResults: [{ id: 'TC-1', result: 'FAIL', evidence: ['evidence/audit.csv'] }, { id: 'TC-UI', result: 'PASS', evidence: [] }],
    auditSummary: { month: '2025-10', net: 50, rows: [{ name: 'A', value: 30 }, { name: 'B', value: 20 }] } };
  const saveAnswer = () => writeFileSync(join(f.dir, 'submit.json'), JSON.stringify(answer)); saveAnswer();
  const api = args => f.rt.proxyCall('item_dependency', { backlogItemKey: f.key, ...args });
  const declare = () => api({ action: 'declare', dependsOn: depKey, scenarios: ['TC-1'], artifacts: ['evidence/audit.csv'],
    summaries: [{ answerField: 'auditSummary', reportFile: 'evidence/report.json', reportPointer: '' }],
    csvBindings: [{ artifact: 'evidence/audit.csv', reportFile: 'evidence/report.json', reportPointer: '/csv' }],
    replayData: true, reason: 'Import correction changes the persisted fixture and exported report', refreshSeconds: 180 });
  const land = () => {
    writeFileSync(join(f.checkout, 'M1', 'src', 'import-pipeline.js'), 'export const sign = -1;\n');
    sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'BUG-02: correct import sign'], f.checkout);
    dep.integratedRevision = sh('git', ['rev-parse', 'HEAD'], f.checkout); f.rt.journal.save();
  };
  const report = { month: '2025-10', net: -50, rows: [{ id: 'a', name: 'A', value: -30 }, { id: 'b', name: 'B', value: -20 }], csv: '\uFEFFA;Value\r\nA;-30\r\nB;-20\r\n' };
  const outputs = () => {
    writeFileSync(join(f.dir, 'evidence', 'report.json'), JSON.stringify(report));
    writeFileSync(join(f.dir, 'evidence', 'audit.csv'), report.csv);
    writeFileSync(join(f.dir, 'evidence', 'replay.log'), 'Completed actual fixture replay\n');
    answer.auditSummary = { month: report.month, net: report.net, rows: report.rows.map(({name,value})=>({name,value})) };
    answer.status = 'DONE'; answer.testResults[0].result = 'PASS'; saveAnswer();
  };
  const complete = replayId => api({ action: 'complete', dependsOn: depKey, replayId, result: 'pass', evidence: ['evidence/replay.log'] });
  return { ...f, depKey, dep, api, declare, land, report, outputs, complete, answer, saveAnswer };
}

test('item dependencies are explicit, reject cycles, and do not install or sync under writing workers', async () => {
  const f = dependencyFixture(); f.ji.workerState = 'writing';
  const before = f.ji.worktreeBase;
  const a = await f.declare(), b = await f.declare();
  assert.equal(a.requiredRevision, null); assert.equal(b.duplicate, true);
  assert.equal(f.ji.worktreeBase, before); assert.equal(f.rt.jobs.jobs.size, 0);
  await assert.rejects(f.api({ action: 'begin', dependsOn: f.depKey }), /DEPENDENCY_NOT_SYNCED/);
  await assert.rejects(f.api({ action: 'declare', dependsOn: f.key, scenarios: ['TC-1'], reason: 'self' }), /another visible/);
  f.dep.itemDependencies = { [f.key]: { dependsOn: f.key } };
  await assert.rejects(f.declare(), /DEPENDENCY_CYCLE/); delete f.dep.itemDependencies;
  f.land();
  await assert.rejects(f.api({ action: 'begin', dependsOn: f.depKey }), /DEPENDENCY_NOT_SYNCED/);
  assert.equal(f.ji.worktreeBase, before);
  assert.equal(f.rt.jobs.jobs.size, 0, 'no automatic package setup or new agent');
});

test('dependency evidence checkpoint requests only build while retaining the affected replay requirement', async () => {
  const f = dependencyFixture(); await f.declare(); f.land();
  const calls = [];
  f.rt.runChecks = async args => { calls.push(args); return { state: 'running', runId: 'scoped-build' }; };
  const res = await f.rt.proxyCall('worker_checkpoint', { backlogItemKey: f.key, phase: 'ready_for_evidence' });
  assert.equal(res.writesAllowed, true, JSON.stringify(res));
  assert.deepEqual(calls, [{ backlogItemKey: f.key, matchRoot: f.wt.matchRoot, waitSeconds: 0, checks: ['build'] }]);
  assert.equal(f.ji.worktreeBase, f.dep.integratedRevision);
  assert.match(res.hint, /affected fixture checks/);
  assert.match(res.hint, /full-suite results are historical/);
  assert.equal(f.rt.workflow.dependencies.pending(f.key).length, 1, 'a build cannot certify a data replay');
  assert.equal(f.rt.jobs.jobs.size, 0, 'no package setup or additional job outside requested build');
});

test('dependency replay binds source, actual CSV bytes, ordered summary and external provenance', async () => {
  const f = dependencyFixture(); await f.declare(); f.land();
  await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
  const replay = await f.api({ action: 'begin', dependsOn: f.depKey });
  assert.equal(replay.replayData, true);
  f.outputs();
  const independent = structuredClone(f.answer.testResults[1]);
  const complete = await f.complete(replay.replayId);
  assert.equal(complete.verified, true);
  assert.equal((await f.complete(replay.replayId)).replay, true, 'lost complete responses do not force another fixture replay');
  assert.deepEqual(await f.rt.workflow.dependencies.problems(f.key), []);
  assert.deepEqual(f.answer.testResults[1], independent);
  assert.deepEqual(await evidenceProblems(f.rt.session.paths.teamWork, f.key, f.wt.matchRoot, await f.rt.workflow.snapshot(f.key)), []);
  f.answer.engineeringRecord = { analysis: 'Imported using the revision now present; other UI observations are unchanged' }; f.saveAnswer();
  assert.deepEqual(await f.rt.workflow.dependencies.problems(f.key), [], 'independent notes do not force another replay');
  const value = JSON.parse(readFileSync(join(f.rt.session.paths.teamWork, 'evidence', `${f.key}.json`), 'utf8'));
  assert.ok(value.entries.every(e => e.attemptId === replay.replayId && e.source === replay.snapshot.source));
  writeFileSync(join(f.dir, 'evidence', 'audit.csv'), 'overwritten');
  assert.match((await f.rt.workflow.dependencies.problems(f.key)).join(), /fresh artifacts\/summary/);
});

test('old fixture artifacts, stale summary, reordered rows and byte-mismatched CSV cannot complete a replay', async () => {
  const f = dependencyFixture(); await f.declare(); f.land(); await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
  const { replayId } = await f.api({ action: 'begin', dependsOn: f.depKey }); f.outputs();
  const csv = join(f.dir, 'evidence', 'audit.csv'); utimesSync(csv, new Date(0), new Date(0));
  await assert.rejects(f.complete(replayId), /DEPENDENCY_ARTIFACT_STALE/);
  f.outputs(); f.answer.auditSummary.net = 50; f.saveAnswer();
  await assert.rejects(f.complete(replayId), /DEPENDENCY_OUTPUT_MISMATCH.*auditSummary/);
  f.outputs(); f.answer.auditSummary.rows.reverse(); f.saveAnswer();
  await assert.rejects(f.complete(replayId), /DEPENDENCY_OUTPUT_MISMATCH/);
  f.outputs(); writeFileSync(csv, f.report.csv.replaceAll('\r\n', '\n'));
  await assert.rejects(f.complete(replayId), /CSV bytes/);
  f.outputs(); assert.equal((await f.complete(replayId)).verified, true);
});

test('source or environment changes during dependency replay require a new run', async () => {
  const f = dependencyFixture(); await f.declare(); f.land(); await f.rt.worktree({ action: 'sync', backlogItemKey: f.key });
  let replay = await f.api({ action: 'begin', dependsOn: f.depKey }); f.outputs();
  writeFileSync(join(f.wt.matchRoot, '.env'), 'LOCAL_REVISION=new\n');
  await assert.rejects(f.complete(replay.replayId), /DEPENDENCY_REPLAY_STALE/);
  replay = await f.api({ action: 'begin', dependsOn: f.depKey }); f.outputs();
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=3;\n');
  await assert.rejects(f.complete(replay.replayId), /DEPENDENCY_REPLAY_STALE/);
});

test('a ready dependency gets one bounded refresh before stop, with submission reserve and no polling extension', async () => {
  const f = dependencyFixture(); await f.declare(); f.land();
  f.result(1, fix({ status: 'partial' })); f.ji.checkpoint = 'candidate';
  f.rt.itemRows = () => [{ key: f.key, type: 'CR', status: 'OPEN', local: 'started', minutesLeft: 4, deadlineMinutes: 20 }];
  const first = f.rt.workflow.actions().nextActions.find(a=>a.key===f.key);
  assert.equal(first.reason, 'item_dependency'); assert.match(first.followup, /fresh fixture data/);
  const until = f.ji.dependencyRefreshUntil;
  assert.ok(Date.parse(until) <= Date.now()+180_000 && Date.parse(until) > Date.now()+170_000);
  f.rt.workflow.actions(); assert.equal(f.ji.dependencyRefreshUntil, until);
  f.ji.dependencyRefreshUntil = new Date(Date.now()-1000).toISOString();
  const expired = f.rt.workflow.actions().nextActions.find(a=>a.key===f.key);
  assert.equal(expired.action, 'publish_item');
  await f.api({ action: 'defer', dependsOn: f.depKey, reason: 'Refresh budget exhausted; data scenario remains unverified' });
  assert.deepEqual(await f.rt.workflow.dependencies.problems(f.key), []);
  f.answer.status = 'DONE'; f.answer.testResults[0].result='PASS'; f.saveAnswer();
  assert.ok((await f.rt.workflow.dependencies.problems(f.key)).length, 'deferral cannot turn old failed/unverified data into PASS');
});

test('pending dependencies hold only their consumer and reject a false current PASS at publish', async () => {
  const f = dependencyFixture(); await f.declare();
  f.result(1, fix({ status: 'partial' })); f.ji.checkpoint='candidate';
  assert.equal(f.rt.workflow.actions().nextActions.filter(a=>a.key===f.key && a.action==='publish_item').length, 0);
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey:f.key, fixResultFile:join(f.results, `${f.key}-fixer-1.json`) }), /DEPENDENCY_REPLAY_REQUIRED/);
  f.answer.status='DONE'; f.answer.testResults[0].result='PASS'; f.saveAnswer();
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey:f.key, fixResultFile:join(f.results, `${f.key}-fixer-1.json`), lastChance:{reason:'hard deadline'} }), /DEPENDENCY_REPLAY_REQUIRED/);
  assert.deepEqual(f.rt.workflow.dependencies.records(f.depKey), [], 'the source item does not wait on its consumer');
});

test('handoff waits for a known evidence writer and stale helper checks never contribute current PASS', async () => {
  const f = fixture(); f.ji.workerState='writing';
  const file = join(f.rt.session.paths.teamWork,'items',f.key,'checks.json'); mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({state:'running',matchRoot:f.wt.matchRoot}));
  f.result(1);
  let res=await f.rt.workerCheckpoint({backlogItemKey:f.key,phase:'candidate'});
  assert.equal(res.handedOff,false); assert.match(res.problems.join(),/still writing evidence/);
  const snapshot=await f.rt.workflow.snapshot(f.key);
  writeFileSync(file,JSON.stringify({state:'done',matchRoot:f.wt.matchRoot,snapshot,results:[{name:'test',state:'passed',command:'runner',log:'evidence/full-suite.log'}]}));
  writeFileSync(join(f.wt.matchRoot,'.env'),'LOCAL_REVISION=changed\n');
  const composed=await f.rt.workflow.composeResult(f.key,{status:'partial',summary:'Actual tests need a new run'});
  const value=JSON.parse(readFileSync(composed.file,'utf8'));
  assert.equal(value.verification[0].result,'not_run'); assert.match(value.verification[0].note,/historical result pass/);
});

test('dependency arrival notifies a writing worker once and starts its budget only at replay begin', async () => {
  const f=dependencyFixture(); await f.declare(); f.ji.workerState='writing';
  assert.equal(f.rt.workflow.actions().nextActions.length,0);
  f.land();
  const action=f.rt.workflow.actions().nextActions.find(a=>a.key===f.key);
  assert.equal(action.reason,'item_dependency_ready');
  assert.equal(f.ji.dependencyRefreshUntil,undefined);
  assert.equal(f.rt.workflow.actions().nextActions.length,0,'no repeated root followup on polling');
  assert.notEqual(f.ji.worktreeBase,f.dep.integratedRevision,'notification does not mutate the writing worktree');
  f.ji.workerState='yielded'; await f.rt.worktree({action:'sync',backlogItemKey:f.key});
  const replay=await f.api({action:'begin',dependsOn:f.depKey});
  assert.ok(replay.deadline); f.outputs(); await f.complete(replay.replayId);
});

test('completing one of multiple dependencies does not extend their shared refresh window', async () => {
  const f=dependencyFixture(); await f.declare(); f.land();
  f.rt.journal.item('BUG-03').integratedRevision=f.dep.integratedRevision;
  f.rt.gm.view.items.push({key:'BUG-03',title:'Other pipeline fix',raw:{}});
  await f.api({action:'declare',dependsOn:'BUG-03',scenarios:['TC-1'],artifacts:['evidence/audit.csv'],reason:'Second fix affects the same replay',replayData:true});
  await f.rt.worktree({action:'sync',backlogItemKey:f.key});
  const replay=await f.api({action:'begin',dependsOn:f.depKey}), until=replay.deadline;
  f.outputs(); await f.complete(replay.replayId);
  assert.equal(f.rt.workflow.dependencies.opportunity(f.key,f.rt.itemRows()[0]).until,until);
});

test('dependency completion refuses a managed app still serving the old build', async () => {
  const f=dependencyFixture(); await f.declare(); f.land(); await f.rt.worktree({action:'sync',backlogItemKey:f.key});
  const replay=await f.api({action:'begin',dependsOn:f.depKey}); f.outputs();
  const path=join(f.root,'team-sdlc-pack','local','apps',`${f.key}.json`); mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify({pid:process.pid,matchRoot:f.wt.matchRoot,snapshot:{...replay.snapshot,source:'old build'}}));
  await assert.rejects(f.complete(replay.replayId),/DEPENDENCY_APP_STALE/);
  writeFileSync(path,JSON.stringify({pid:process.pid,matchRoot:f.wt.matchRoot,snapshot:replay.snapshot}));
  assert.equal((await f.complete(replay.replayId)).verified,true);
});

test('overlapping fixture dependencies wait for all fixes and detect a related revision changing mid-replay', async () => {
  const f=dependencyFixture(); await f.declare(); f.land();
  const other=f.rt.journal.item('BUG-03'); f.rt.gm.view.items.push({key:'BUG-03',title:'Allocation fix',raw:{}});
  await f.api({action:'declare',dependsOn:'BUG-03',scenarios:['TC-1'],artifacts:['evidence/audit.csv'],reason:'Allocation also changes this fixture',replayData:true});
  assert.deepEqual(f.rt.workflow.dependencies.ready(f.key),[]);
  assert.equal(f.rt.workflow.dependencies.opportunity(f.key,f.rt.itemRows()[0]),null,'do not spend the replay budget waiting for another fix');
  await f.rt.worktree({action:'sync',backlogItemKey:f.key});
  await assert.rejects(f.api({action:'begin',dependsOn:f.depKey}),/DEPENDENCY_NOT_SYNCED/);
  other.integratedRevision=f.dep.integratedRevision;
  const replay=await f.api({action:'begin',dependsOn:f.depKey}); f.outputs();
  writeFileSync(join(f.checkout,'M1','src','import-pipeline.js'),'export const sign=-2;\n');
  sh('git',['add','M1'],f.checkout); sh('git',['commit','-q','-m','another dependency revision'],f.checkout);
  other.integratedRevision=sh('git',['rev-parse','HEAD'],f.checkout);
  await assert.rejects(f.complete(replay.replayId),/DEPENDENCY_REPLAY_STALE/);
});

test('dependency summary and CSV bindings cannot select different replay reports or escaped paths', async () => {
  const f=dependencyFixture();
  const fields={action:'declare',dependsOn:f.depKey,scenarios:['TC-1'],artifacts:['evidence/audit.csv'],reason:'Same report required',
    summaries:[{answerField:'auditSummary',reportFile:'evidence/current.json',reportPointer:''}]};
  await assert.rejects(f.api({...fields,csvBindings:[{artifact:'evidence/audit.csv',reportFile:'evidence/other.json',reportPointer:'/csv'}]}),/same replay report/);
  await assert.rejects(f.api({...fields,summaries:[{answerField:'auditSummary',reportFile:'evidence/../../other.json',reportPointer:''}]}),/PATH_NOT_ALLOWED/);
  assert.deepEqual(f.rt.workflow.dependencies.records(f.key),[]);
});

test('dependency replay also supports code TASK contracts without fixed testResults rows', async () => {
  const f=dependencyFixture();
  writeFileSync(join(f.rt.session.paths.teamWork,'items',f.key,'template.json'),JSON.stringify({status:'NOT_STARTED',auditSummary:{}}));
  await f.declare();
  delete f.answer.testResults; f.answer.status='PARTIAL'; f.saveAnswer();
  await f.api({action:'defer',dependsOn:f.depKey,reason:'Required code not available yet; acceptance check unverified'});
  assert.deepEqual(await f.rt.workflow.dependencies.problems(f.key),[]);
  await f.declare(); // Same declaration retains the deferral until begin on a new received revision.
  f.land(); await f.rt.worktree({action:'sync',backlogItemKey:f.key});
  const replay=await f.api({action:'begin',dependsOn:f.depKey});
  f.answer.testResults=[{id:'TC-1',result:'PASS',evidence:['evidence/audit.csv']}]; f.outputs();
  delete f.answer.testResults; f.saveAnswer();
  assert.equal((await f.complete(replay.replayId)).verified,true);
});
