// Kiểm workflow với git/worktree thật; không gọi LLM hay mạng ngoài.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../../pack/src/tools.mjs';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Jobs } from '../../pack/src/core/jobs.mjs';
import { digest, resultArtifact } from '../../pack/src/core/candidates.mjs';
import { recordEvidence, evidenceProblems } from '../../pack/src/env/evidence.mjs';
import { sh, tempDir, validFixResult } from './support.mjs';

const fix = overrides => validFixResult({ summary: 'Fixed value', criteria: ['correct'], verification: [{ check: 'TC-1', command: null, result: 'pass', note: 'observed' }],
  requirements: [{ id: 'AC-1', status: 'met', evidence: 'src/lib.js:1' }], ...overrides });
const review = { verdict: 'approve', root_cause_addressed: true, issues: [], requirements: [{ id: 'AC-1', verdict: 'met', note: 'inspected' }], summary: 'Correct' };
const solver = value => ({ hypothesis: 'independent answer', verdict: 'supported', evidence: ['src/lib.js:1 derives value'], fix_location: null, next_check: null, answer_values: [{ field: 'position', value }] });

function fixture(key = 'BUG-01', answerOnly = false) {
  const root = tempDir('mtm-workflow-'), bare = join(root, 'remote.git'), checkout = join(root, 'checkout');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare], root); sh('git', ['clone', '-q', bare, checkout], root);
  sh('git', ['config', 'user.name', 'test'], checkout); sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  mkdirSync(join(checkout, 'M1', 'src'), { recursive: true }); writeFileSync(join(checkout, 'M1', 'src', 'lib.js'), 'export const value=1;\n');
  writeFileSync(join(checkout, '.git', 'info', 'exclude'), '.team-work/\n.env\n');
  sh('git', ['add', 'M1'], checkout); sh('git', ['commit', '-q', '-m', 'seed'], checkout); sh('git', ['push', '-q', 'origin', 'HEAD:main'], checkout);
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
  const result = (n, value = fix(answerOnly ? { requirements: [], verification: [{ check: 'derive', command: null, result: 'pass', note: 'source' }] } : {}), role = 'fixer') => {
    const file = join(results, `${key}-${role}-${n}.json`); writeFileSync(file, JSON.stringify(value)); return file;
  };
  const preflight = file => rt.workflow.preflight({ backlogItemKey: key, fixResultFile: file });
  const gate = async file => { const job = await rt.gateFromFixResult({ backlogItemKey: key, fixResultFile: file, waitSeconds: 0 });
    await rt.jobs.jobs.get(job.jobId).promise; const done = rt.jobs.view(rt.jobs.jobs.get(job.jobId)); assert.equal(done.state, 'done', JSON.stringify(done)); return done; };
  const approve = async (p, n = 1) => rt.workflow.handoff({ backlogItemKey: key, kind: 'review', resultFile: result(n, review, 'reviewer'), candidateId: p.candidateId });
  return { root, bare, checkout, rt, key, ji, wt, dir, results, result, preflight, gate, approve };
}

test('contract errors name fields and reject result sibling directories', async () => {
  const f = fixture(); await assert.rejects(f.preflight(f.result(1, { status: 'fixed' })), /RESULT_INVALID.*root_cause/);
  const dir = join(f.results, '..', 'results-other'); mkdirSync(dir); const file = join(dir, 'result.json'); writeFileSync(file, JSON.stringify(fix({})));
  assert.throws(() => resultArtifact(f.results, file, 'fix-result'), /PATH_NOT_ALLOWED/);
});

test('immutable handoffs prevent stale replay and evidence-only versions reuse valid code checks', async () => {
  const f = fixture(), one = f.result(1), p = await f.preflight(one), first = await f.gate(one); await f.approve(p);
  assert.equal((await f.rt.gateFromFixResult({ backlogItemKey: f.key, fixResultFile: one, waitSeconds: 0 })).jobId, first.jobId);
  writeFileSync(join(f.dir, 'evidence', 'new.csv'), 'a,b\r\n1,2\r\n'); const two = f.result(2), p2 = await f.preflight(two);
  assert.notEqual(p2.candidateId, p.candidateId); assert.equal(p2.reviewScope, 'evidence_answer'); assert.equal((await f.gate(two)).result.reusedCode, true);
  writeFileSync(two, JSON.stringify(fix({ summary: 'overwritten' }))); await assert.rejects(f.gate(two), /RESULT_MUTATED/);
  writeFileSync(join(f.wt.matchRoot, 'src', 'lib.js'), 'export const value=3;\n'); await assert.rejects(f.rt.requireGate(f.key, f.wt.worktreeRoot), /GATE_STALE/);
});

test('preflight merges missing evidence/scenarios/requirements and forbids sync during worker writes', async () => {
  const f = fixture(); f.rt.itemEvidence = () => [{ file: 'export.csv', beforeFix: false }];
  const p = await f.preflight(f.result(1, fix({ status: 'partial', requirements: [{ id: 'AC-1', status: 'not_met', evidence: 'Need final screenshot' }], verification: [{ check: 'TC-1', command: null, result: 'not_run', note: 'Download CSV' }] })));
  assert.equal(p.ready, false); assert.equal(p.repair.keepImplementation, true);
  for (const id of ['AC-1', 'TC-1']) assert.ok(p.repair.todo.some(t => t.id === id)); assert.ok(p.repair.todo.some(t => t.action.includes('export.csv')));
  assert.ok(!f.rt.workflow.actions().nextActions.some(a => a.action === 'review_candidate'));
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume', threadId: 'native-1' }); await assert.rejects(f.rt.worktree({ action: 'sync', backlogItemKey: f.key }), /WORKER_BUSY/);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'ready_for_evidence' }); assert.equal((await f.rt.worktree({ action: 'sync', backlogItemKey: f.key })).synced, false);
});

test('answer-only requires independent derivation; last chance never turns uncertainty into PASS', async () => {
  const f = fixture('TASK-01', true), file = f.result(1), p = await f.preflight(file), g = await f.gate(file);
  const verify = args => f.rt.recordVerification({ backlogItemKey: f.key, gateJobId: g.jobId, ...args });
  assert.throws(() => verify(), /ANSWER_UNVERIFIED/);
  await f.rt.workflow.handoff({ backlogItemKey: f.key, kind: 'hypothesis', resultFile: f.result(1, solver('3'), 'solver'), candidateId: p.candidateId });
  assert.throws(() => verify(), /ANSWER_DISPUTED/); assert.equal(verify({ lastChance: true }).status, 'FAILED');
  await f.rt.workflow.handoff({ backlogItemKey: f.key, kind: 'hypothesis', resultFile: f.result(2, solver('2'), 'solver'), candidateId: p.candidateId });
  assert.equal(verify().status, 'PASSED'); assert.doesNotMatch(f.rt.writer.events.at(-1).summary, /scenario/i);
});

test('changed ignored env invalidates a passing gate', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file); await f.gate(file);
  writeFileSync(join(f.wt.matchRoot, '.env'), 'DATABASE_URL=changed\n'); await assert.rejects(f.rt.requireGate(f.key, f.wt.worktreeRoot), /GATE_STALE.*environment/);
});

test('preflight distinguishes required scenario outcomes from diagnostic failures', async () => {
  const f = fixture();
  const file = f.result(1, fix({ verification: [
    { check: 'TC-1', command: null, result: 'pass', note: 'observed' },
    { check: 'diagnostic-before', command: null, result: 'fail', note: 'observed on original code; not a required MVS scenario' }
  ] }));
  const p = await f.preflight(file); assert.equal(p.ready, true);
  assert.ok(p.repair.todo.some(t => t.id === 'diagnostic-before'), 'retain observation for independent review');
});

test('publish replays an identical intent after restart/lost response without duplicate receipt', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file); await f.gate(file); await f.approve(p);
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
  recordEvidence(f.rt.session.paths.teamWork, f.key, entry); assert.deepEqual(problems(), []);
  recordEvidence(f.rt.session.paths.teamWork, f.key, { ...entry, phase: 'final' }); assert.match(problems()[0], /older source/);
  recordEvidence(f.rt.session.paths.teamWork, f.key, { ...entry, ...snapshot, phase: 'final' }); assert.deepEqual(problems(), []);
  writeFileSync(path, 'changed'); assert.match(problems()[0], /bytes changed/);
});

test('source index refresh uses the yielded worktree after sync and before full review', async () => {
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
  const ready = await f.preflight(f.result(1));
  assert.equal(ready.ready, true, 'optional index failure must not block review/gate');
  assert.equal(ready.codegraph.code, 3);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ key: f.key, matchRoot: f.wt.matchRoot, workerState: 'yielded' })));
});

test('prepare is idempotent and returns worker brief inputs without repeating Start Work', async () => {
  const f = fixture(); let starts = 0; f.rt.startWork = async () => { starts++; return { triage: { models: {} }, materialsDir: 'materials', timeBox: {} }; };
  f.rt.worktree = async () => ({ ...f.wt, setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
  const j = await f.rt.workflow.prepare({ backlogItemKey: f.key }); await f.rt.jobs.jobs.get(j.jobId).promise; const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.checker, 'team_reviewer'); assert.equal(done.result.worktree.matchRoot, f.wt.matchRoot);
  assert.equal((await f.rt.workflow.prepare({ backlogItemKey: f.key })).jobId, j.jobId); assert.equal(starts, 1);
});

test('next actions use the nearest release, not a default verifier', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file); f.rt.releases = () => ({ next: { at: new Date(Date.now() + 3000).toISOString() } });
  const next = f.rt.workflow.actions(); assert.ok(next.waitMs <= 4000); assert.ok(next.nextActions.some(a => a.action === 'run_gate'));
  assert.ok(next.nextActions.some(a => a.action === 'review_candidate')); assert.ok(!JSON.stringify(next).includes('team_verifier'));
});

test('integration recognizes a commit made before a lost checkpoint and does not cherry-pick twice', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file); await f.gate(file);
  sh('git', ['add', 'M1'], f.wt.worktreeRoot); sh('git', ['commit', '-q', '-m', 'candidate'], f.wt.worktreeRoot);
  const head = sh('git', ['rev-parse', 'HEAD'], f.wt.worktreeRoot), parent = sh('git', ['rev-parse', 'HEAD'], f.checkout);
  f.ji.integratePlan = { head, mainBefore: parent, commits: [head], cursor: 0, pending: { sha: head, parent } }; f.rt.journal.save();
  sh('git', ['cherry-pick', '-x', head], f.checkout); const integrated = sh('git', ['rev-parse', 'HEAD'], f.checkout);
  await f.rt.worktree({ action: 'integrate', backlogItemKey: f.key }); assert.equal(f.ji.integratedRevision, integrated); assert.equal(f.ji.integratePlan, undefined);
});

test('answer repair after integration only integrates new commits and submits the reviewed version', async () => {
  const f = fixture(), one = f.result(1); await f.preflight(one); await f.gate(one); await f.rt.worktree({ action: 'integrate', backlogItemKey: f.key }); f.ji.integratedCandidateId = f.ji.candidate.id;
  const answer = JSON.parse(readFileSync(join(f.dir, 'submit.json'), 'utf8')); answer.note = 'final'; writeFileSync(join(f.dir, 'submit.json'), JSON.stringify(answer));
  const two = f.result(2, fix({ summary: 'repaired answer' })), p = await f.preflight(two); await f.gate(two); await f.approve(p, 2);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async (key, intent) => { assert.equal(JSON.parse(intent.body).answer.note, 'final'); return { kind: 'SUBMITTED', submission: { id: randomUUID() } }; };
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise; const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

test('a slot is held only while an item still needs its worker, so a new item starts when the others only wait', () => {
  const f = fixture(); const keys = ['BUG-02', 'CR-01', 'CR-02', 'BUG-04'];
  f.rt.itemRows = () => [...keys.map(key => ({ key, type: key.split('-')[0], status: 'OPEN', local: 'started', minutesLeft: 20 })),
    { key: 'CR-03', type: 'CR', status: 'OPEN', local: 'todo', minutesLeft: 20 }];
  f.rt.gm.view.items = f.rt.itemRows().map(r => ({ key: r.key, title: r.key, raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } }));
  const prepares = () => f.rt.workflow.actions().nextActions.filter(a => a.action === 'prepare_item').map(a => a.key);
  // NBDB5U0O 17:02: bốn item đang làm (chưa bàn giao) giữ đủ 4 slot.
  for (const key of keys) Object.assign(f.rt.journal.item(key), { startedAt: new Date().toISOString(), workerState: 'writing' });
  assert.equal(f.rt.freeSlots(), 0); assert.deepEqual(prepares(), []);
  // Đã bàn giao candidate, chỉ chờ gate / review / item khác: nhả slot.
  for (const key of keys.slice(1)) Object.assign(f.rt.journal.item(key), { workerState: 'yielded', checkpoint: 'candidate', candidate: { id: `c-${key}`, state: 'ready', fixResultFile: 'x' } });
  assert.equal(f.rt.freeSlots(), 3); assert.deepEqual(prepares(), ['CR-03']);
  // Dừng chờ sync trước evidence, worker chết sau restart, candidate phải sửa: vẫn giữ slot.
  Object.assign(f.rt.journal.item('CR-01'), { checkpoint: 'ready_for_evidence', candidate: undefined });
  Object.assign(f.rt.journal.item('CR-02'), { checkpoint: 'resume', candidate: undefined });
  f.rt.journal.item('BUG-04').candidate.state = 'repair';
  assert.equal(f.rt.freeSlots(), 0); assert.deepEqual(prepares(), []);
});

test('in the last minutes a candidate is stopped, gated and published under the last-chance rule first', async () => {
  const f = fixture(), file = f.result(1); await f.preflight(file);
  const rows = minutesLeft => [{ key: f.key, type: 'BUG', status: 'OPEN', local: 'started', minutesLeft },
    { key: 'CR-09', type: 'CR', status: 'OPEN', local: 'todo', minutesLeft: 30 }];
  f.rt.gm.view.items.push({ key: 'CR-09', title: 'CR-09', raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } });
  f.rt.itemRows = () => rows(30);
  assert.ok(f.rt.workflow.actions().nextActions.some(a => a.key === f.key && a.action === 'review_candidate'), 'normal flow waits for review');
  f.rt.itemRows = () => rows(5);
  let next = f.rt.workflow.actions().nextActions;
  assert.deepEqual([next[0].key, next[0].action, next[0].lastCall], [f.key, 'run_gate', true], 'gate first, ahead of the new item');
  await f.gate(file);
  next = f.rt.workflow.actions().nextActions;
  assert.deepEqual([next[0].action, next[0].arguments.candidateId], ['publish_item', f.ji.candidate.id]);
  assert.match(next[0].arguments.lastChance.reason, /5 min left/);
  assert.ok(!next.some(a => a.key === f.key && a.action === 'review_candidate'), 'no review at the last call');
  f.ji.workerState = 'writing';
  assert.equal(f.rt.workflow.actions().nextActions[0].action, 'stop_worker');
  f.ji.workerState = 'yielded'; f.ji.lastGate = { ...f.ji.lastGate, tree: null };
  assert.ok(!f.rt.workflow.actions().nextActions.some(a => a.action === 'publish_item'), 'a broken build/regression is never published');
});
