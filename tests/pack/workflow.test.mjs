// Kiểm workflow với git/worktree thật; không gọi LLM hay mạng ngoài.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../../pack/src/tools.mjs';
import { itemSkills } from '../../pack/src/match/workflow.mjs';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Jobs } from '../../pack/src/core/jobs.mjs';
import { digest, resultArtifact, sourceSnapshot } from '../../pack/src/core/candidates.mjs';
import { recordEvidence, evidenceProblems } from '../../pack/src/env/evidence.mjs';
import { detectProfile, worktreeEnvText } from '../../pack/src/env/environment.mjs';
import { rememberBuild, reusableBuild } from '../../pack/src/env/app.mjs';
import { preGateNotice } from '../../pack/src/env/browser.mjs';
import { sh, tempDir, validFixResult } from './support.mjs';

const fix = overrides => validFixResult({ summary: 'Fixed value', criteria: ['correct'], verification: [{ check: 'TC-1', command: null, result: 'pass', note: 'observed' }],
  requirements: [{ id: 'AC-1', status: 'met', evidence: 'src/lib.js:1' }], ...overrides });
const review = { verdict: 'approve', root_cause_addressed: true, issues: [], requirements: [{ id: 'AC-1', verdict: 'met', note: 'inspected' }], summary: 'Correct' };
const solver = value => ({ hypothesis: 'independent answer', verdict: 'supported', evidence: ['src/lib.js:1 derives value'], fix_location: null, next_check: null, answer_values: [{ field: 'position', value }] });

// files: thêm file (đường dẫn trong M1/) vào commit gốc, có mặt ở cả checkout chính lẫn worktree.
function fixture(key = 'BUG-01', answerOnly = false, files = {}) {
  const root = tempDir('mtm-workflow-'), bare = join(root, 'remote.git'), checkout = join(root, 'checkout');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare], root); sh('git', ['clone', '-q', bare, checkout], root);
  sh('git', ['config', 'user.name', 'test'], checkout); sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  mkdirSync(join(checkout, 'M1', 'src'), { recursive: true }); writeFileSync(join(checkout, 'M1', 'src', 'lib.js'), 'export const value=1;\n');
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(checkout, 'M1', rel)), { recursive: true }); writeFileSync(join(checkout, 'M1', rel), text); }
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

// DVDPJAIB PI-01: root chép sai candidateId một ký tự, ba lần CANDIDATE_STALE không kèm id đúng.
test('candidateId errors tell a copy error from an older candidate and publish defaults to the current one', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file); await f.gate(file); await f.approve(p);
  const two = f.result(2, fix({ summary: 'Fixed value, restated' })), p2 = await f.preflight(two); await f.gate(two);
  assert.notEqual(p2.candidateId, p.candidateId);
  const typo = `${p2.candidateId.slice(0, 20)}6${p2.candidateId.slice(20)}`;
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: typo }), e => e.code === 'CANDIDATE_UNKNOWN' && e.message.includes(p2.candidateId));
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }), e => e.code === 'CANDIDATE_STALE' && e.message.includes(p2.candidateId));
  await assert.rejects(f.approve(p, 2), e => e.code === 'CANDIDATE_STALE' && e.message.includes(p2.candidateId));
  await f.approve(p2, 3);
  // Bỏ trống candidateId: qua bước chọn candidate, job publish chạy trên candidate hiện tại.
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const view = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(f.ji.publishJobId, j.jobId); assert.equal(view.progress[0], 'verification'); assert.doesNotMatch(view.error?.code ?? '', /CANDIDATE/);
});

// DVDPJAIB: TASK-03 đã đóng vẫn được integrate, push rồi POST (409 BACKLOG_ITEM_CLOSED); BUG-02 gate 97 s sau khi đóng.
test('a closed item is not preflighted, gated or published', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file); await f.gate(file); await f.approve(p);
  const head = sh('git', ['rev-parse', 'HEAD'], f.checkout), bodies = [];
  f.rt.gm.postSubmission = async (key, intent) => { bodies.push(intent.body); return { kind: 'SUBMITTED', submission: { id: randomUUID() } }; };
  f.rt.endItem(f.key, 'CLOSED');
  await assert.rejects(f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }), /ITEM_NOT_OPEN/);
  await assert.rejects(f.rt.gateFromFixResult({ backlogItemKey: f.key, fixResultFile: f.result(2), waitSeconds: 0 }), /ITEM_NOT_OPEN/);
  await assert.rejects(f.preflight(f.result(3)), /ITEM_NOT_OPEN/);
  assert.equal(sh('git', ['rev-parse', 'HEAD'], f.checkout), head); assert.equal(bodies.length, 0);
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

// PXWV53VC (TASK-01, TASK-02): core.autocrlf=true viết submit.json ra main bằng CRLF; nội dung vẫn là bản đã review.
test('publish accepts an integrated answer that differs from the reviewed one only by CRLF line endings', async () => {
  const f = fixture(); sh('git', ['config', 'core.autocrlf', 'true'], f.checkout);
  writeFileSync(join(f.dir, 'submit.json'), `${JSON.stringify({ status: 'DONE', testResults: [{ id: 'TC-1', result: 'PASS', evidence: [] }] }, null, 2)}\n`);
  const file = f.result(1), p = await f.preflight(file); await f.gate(file); await f.approve(p);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.match(readFileSync(join(f.rt.session.paths.matchRoot, 'answers', f.key, 'submit.json'), 'utf8'), /\r\n/);
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

// PXWV53VC (CR-01): root mở ghi cho worker khi review chưa handoff, review đầu mất vì CANDIDATE_STALE.
test('resume waits for the review of the current candidate unless the review is abandoned', async () => {
  const f = fixture(), p = await f.preflight(f.result(1)); assert.equal(p.ready, true);
  assert.throws(() => f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume' }), /REVIEW_PENDING/);
  assert.equal(f.ji.workerState, 'yielded');
  await f.approve(p); assert.equal(f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume' }).writesAllowed, true);
  const g = fixture(), q = await g.preflight(g.result(1));
  g.rt.workflow.checkpoint({ backlogItemKey: g.key, phase: 'resume', abandonReview: true });
  assert.equal(g.ji.candidate.id, q.candidateId); assert.equal(g.ji.candidate.state, 'stale');
});

test('a slot is held only while an item still needs its worker, so a new item starts when the others only wait', () => {
  const f = fixture(); const keys = ['BUG-02', 'CR-01', 'CR-02', 'BUG-04'];
  f.rt.itemRows = () => [...keys.map(key => ({ key, type: key.split('-')[0], status: 'OPEN', local: 'started', minutesLeft: 20 })),
    { key: 'CR-03', type: 'CR', status: 'OPEN', local: 'todo', minutesLeft: 20 }];
  f.rt.gm.view.items = f.rt.itemRows().map(r => ({ key: r.key, title: r.key, raw: { descriptionMd: '## Acceptance criteria\n1. Works.' } }));
  const prepares = () => f.rt.workflow.actions().nextActions.filter(a => a.action === 'prepare_item').map(a => a.key);
  mkdirSync(join(f.root, 'team-sdlc-pack', 'local'), { recursive: true });
  writeFileSync(join(f.root, 'team-sdlc-pack', 'local', 'runtime.json'), JSON.stringify({ maxItemsInFlight: 4 }));
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

test('publish integrates when main moved in other files and asks for a sync only when both changed a file', async () => {
  const f = fixture(), file = f.result(1), p = await f.preflight(file); await f.gate(file); await f.approve(p);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  // NBDB5U0O: BUG-01 lên main (file khác) sau khi CR-01 đã chụp evidence; CR-01 không phải sync và chụp lại.
  writeFileSync(join(f.checkout, 'M1', 'src', 'layout.js'), 'export const offset=240;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout);
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
  assert.equal(readFileSync(join(f.checkout, 'M1', 'src', 'lib.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const value=2;\n');
  const g = fixture(), gfile = g.result(1), q = await g.preflight(gfile); await g.gate(gfile); await g.approve(q);
  writeFileSync(join(g.checkout, 'M1', 'src', 'lib.js'), 'export const value=9;\n');
  sh('git', ['add', 'M1'], g.checkout); sh('git', ['commit', '-q', '-m', 'same file'], g.checkout);
  const k = await g.rt.workflow.publish({ backlogItemKey: g.key, candidateId: q.candidateId }); await g.rt.jobs.jobs.get(k.jobId).promise;
  assert.match(JSON.stringify(g.rt.jobs.view(g.rt.jobs.jobs.get(k.jobId))), /SYNC_REQUIRED.*lib\.js/);
});

// 4D895OVI TASK-03: answer_only chỉ sửa answers/, main có BUG-03 sau khi tạo worktree. Publish đã integrate rồi dừng ở
// CANDIDATE_STALE vì không có file source nào của item để so, item đóng trước khi nộp.
test('an answer-only item publishes after main moved since its worktree was created', async () => {
  const f = fixture('TASK-01', true), file = f.result(1), p = await f.preflight(file); await f.gate(file);
  await f.rt.workflow.handoff({ backlogItemKey: f.key, kind: 'hypothesis', resultFile: f.result(1, solver('2'), 'solver'), candidateId: p.candidateId });
  writeFileSync(join(f.checkout, 'M1', 'src', 'status.js'), 'export const status=1;\n');
  sh('git', ['add', 'M1'], f.checkout); sh('git', ['commit', '-q', '-m', 'other item'], f.checkout);
  f.rt.gm.endpoint = () => ({ matchUuid: randomUUID() }); f.rt.gm.postSubmission = async () => ({ kind: 'SUBMITTED', submission: { id: randomUUID() } });
  const j = await f.rt.workflow.publish({ backlogItemKey: f.key, candidateId: p.candidateId }); await f.rt.jobs.jobs.get(j.jobId).promise;
  const done = f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId));
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.result.status, 'SUBMITTED');
});

// NBDB5U0O: PI-01, TASK-03, TASK-04 cùng source tree với checkout chính mà mỗi item vẫn chạy gate đầy đủ (52–69 s): .env
// của worktree mang tên database riêng theo trận/item nên proof của checkout khác không bao giờ khớp.
test('an answer-only gate reuses the code proof of the same source from another checkout', async () => {
  const f = fixture('TASK-01', true), main = f.rt.session.paths.matchRoot;
  const env = 'TEST_DATABASE_URL="postgresql://app:pw@127.0.0.1:5433/app_test_m1"\n';
  writeFileSync(join(main, '.env'), env);
  writeFileSync(join(f.wt.matchRoot, '.env'), worktreeEnvText(env, { matchName: 'M1', key: f.key, appDatabase: true }));
  f.rt.journal.data.preparation.codeProofs = [{ snapshot: await sourceSnapshot(f.checkout, 'M1', detectProfile(main)), result: { codePassed: true,
    checks: [{ name: 'build', status: 'ok' }, { name: 'regression', status: 'ok' }], regression: null, baselineFailures: [], testsAdded: null } }];
  const file = f.result(1); await f.preflight(file);
  const g = await f.gate(file);
  assert.equal(g.result.reusedCode, true, JSON.stringify(g.result.checks));
});

// NBDB5U0O: gate nào cũng build lại 30–57 s đúng source mà app evidence vừa build; gate tự build thì ghi lại cho app start sau.
test('the gate reuses a recorded build of the same source and records its own build for the app', { timeout: 120_000 }, async () => {
  const f = fixture('CR-01', false, { 'src/package.json': JSON.stringify({ name: 'app', private: true, scripts: { build: 'node build.cjs' } }),
    'src/build.cjs': "const fs = require('fs'); fs.mkdirSync('out', { recursive: true }); fs.appendFileSync('out/builds.txt', 'x');\n",
    'src/.gitignore': 'out/\n' });
  const app = join(f.wt.matchRoot, 'src'), counter = join(app, 'out', 'builds.txt');
  const builds = () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0);
  rememberBuild(f.rt.teamWorkspace, app, await f.rt.workflow.snapshot(f.key), 'app');
  const one = f.result(1); await f.preflight(one);
  const reused = await f.gate(one);
  assert.deepEqual(reused.result.checks.find(c => c.name === 'build'), { name: 'build', status: 'ok', seconds: 0, reused: 'app' });
  assert.equal(builds(), 0);
  writeFileSync(join(app, 'lib.js'), 'export const value=3;\n');
  const two = f.result(2); await f.preflight(two);
  const built = await f.gate(two);
  assert.equal(built.result.checks.find(c => c.name === 'build').status, 'ok', JSON.stringify(built.result.checks));
  assert.equal(builds(), 1);
  assert.equal(reusableBuild(f.rt.teamWorkspace, app, await f.rt.workflow.snapshot(f.key))?.by, 'gate');
});

// Pre-gate: test của item chạy trong lúc worker chụp evidence; gate của candidate dùng lại kết quả, hỏng thì báo sớm.
const testApp = failing => ({ 'src/package.json': JSON.stringify({ name: 'app', private: true, scripts: { test: 'node test.cjs' } }),
  'src/test.cjs': ["const fs = require('fs'); fs.mkdirSync('out', { recursive: true }); fs.appendFileSync('out/runs.txt', 'x');",
    `const ok = ${failing ? "!fs.readFileSync('lib.js', 'utf8').includes('value=2')" : 'true'};`,
    "console.log(ok ? ' Tests  1 passed (1)' : ' Tests  1 failed (1)'); process.exit(ok ? 0 : 1);", ''].join('\n'),
  'src/.gitignore': 'out/\n' });

test('ready_for_evidence runs the item tests meanwhile and the candidate gate reuses them', { timeout: 120_000 }, async () => {
  const f = fixture('CR-01', false, testApp(false)), runs = () => readFileSync(join(f.wt.matchRoot, 'src', 'out', 'runs.txt'), 'utf8').length;
  const checkpoint = f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler;
  f.ji.workerThread = '/root/cr01'; f.ji.workerState = 'writing';
  const res = await checkpoint({ backlogItemKey: f.key, phase: 'ready_for_evidence', testsAdded: [] });
  assert.ok(res.preGateJobId, JSON.stringify(res)); assert.match(res.hint, /preGateFailed/);
  await f.rt.jobs.jobs.get(res.preGateJobId).promise;
  assert.equal(f.ji.preGate.state, 'passed', JSON.stringify(f.ji.preGate)); assert.equal(runs(), 1);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  const one = f.result(1); await f.preflight(one);
  const g = await f.gate(one);
  assert.equal(g.result.passed, true, JSON.stringify(g.result.checks)); assert.equal(g.result.reusedTests, true);
  assert.equal(runs(), 1, 'the candidate gate does not run the tests again');
});

test('a failing pre-gate is reported to root and in capture results while the worker is still writing', { timeout: 120_000 }, async () => {
  const f = fixture('CR-02', false, testApp(true));
  f.ji.workerThread = '/root/cr02'; f.ji.workerState = 'writing';
  const res = await f.rt.definitions().find(t => t.name === 'worker_checkpoint').handler({ backlogItemKey: f.key, phase: 'ready_for_evidence', testsAdded: [] });
  await f.rt.jobs.jobs.get(res.preGateJobId).promise;
  assert.deepEqual([f.ji.preGate.state, f.ji.preGate.failKind], ['failed', 'regression'], JSON.stringify(f.ji.preGate));
  assert.equal(f.ji.testProof, undefined);
  const action = f.rt.workflow.actions().nextActions.find(a => a.key === f.key);
  assert.deepEqual([action.action, action.preGateJobId, action.failKind, action.workerThread], ['pre_gate_failed', res.preGateJobId, 'regression', '/root/cr02']);
  assert.equal(preGateNotice(f.rt.session.paths.teamWork, f.key).failKind, 'regression');
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  assert.ok(!f.rt.workflow.actions().nextActions.some(a => a.action === 'pre_gate_failed'), 'only while the worker writes');
});

// CR/hard chạy tier strong (sol chậm ~2,5 lần mỗi lượt): worker strong làm code + test, evidence giao worker model nhanh.
test('a strong-tier item hands its evidence to a fast worker after a code-and-tests candidate', async () => {
  const plan = tier => ({ fixer: [{ model: tier === 'strong' ? 'gpt-6.1-sol' : 'gpt-6.1-terra', reasoning_effort: 'medium', tier }],
    evidence: { model: 'gpt-6.1-terra', reasoning_effort: 'medium', tier: 'small' } });
  const prepared = async (f, tier) => {
    f.rt.startWork = async () => ({ triage: { models: plan(tier) }, materialsDir: 'materials', timeBox: {} });
    f.rt.worktree = async () => ({ ...f.wt, setupJobId: f.rt.jobs.start('worktree_setup', async () => ({ ok: true })).id });
    f.rt.itemMvs = () => '## TC-1\nThe value is correct.';
    const j = await f.rt.workflow.prepare({ backlogItemKey: f.key }); await f.rt.jobs.jobs.get(j.jobId).promise;
    return f.rt.jobs.view(f.rt.jobs.jobs.get(j.jobId)).result;
  };
  const f = fixture('CR-01');
  assert.deepEqual((await prepared(f, 'strong')).evidenceHandoff?.model, 'gpt-6.1-terra');
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume', threadId: '/root/cr01' });
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  writeFileSync(join(f.dir, 'submit.json'), JSON.stringify({ status: 'PARTIAL', testResults: [{ id: 'TC-1', result: 'NOT_RUN', evidence: [] }] }));
  const notRun = [{ check: 'TC-1', command: null, result: 'not_run', note: 'final evidence: evidence worker' }];
  const coder = f.result(1, fix({ status: 'partial', verification: notRun, requirements: [{ id: 'AC-1', status: 'not_met', evidence: 'needs final evidence' }] }));
  const p = await f.preflight(coder);
  assert.equal(p.ready, false); assert.equal(p.repair.keepImplementation, true);
  const next = f.rt.workflow.actions().nextActions.find(a => a.key === f.key);
  assert.deepEqual([next.action, next.model, next.priorFixResultFile], ['spawn_evidence_worker', 'gpt-6.1-terra', coder]);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'resume', threadId: '/root/cr01_evidence' });
  assert.deepEqual([f.ji.evidenceHandoff.state, f.ji.evidenceHandoff.thread], ['done', '/root/cr01_evidence']);
  f.rt.workflow.checkpoint({ backlogItemKey: f.key, phase: 'candidate' });
  await f.preflight(f.result(2, fix({ status: 'partial', verification: notRun })));
  assert.equal(f.rt.workflow.actions().nextActions.find(a => a.key === f.key).action, 'repair_worker', 'later repairs follow up the evidence worker');
  const g = fixture('CR-02');
  assert.equal((await prepared(g, 'small')).evidenceHandoff, null, 'a small-tier worker captures its own evidence');
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
  const stale = p => p.repair.todo.filter(t => /older source/.test(t.action));
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
    assert.ok((await f.preflight(f.result(1))).repair.todo.some(t => /older source/.test(t.action)));
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
