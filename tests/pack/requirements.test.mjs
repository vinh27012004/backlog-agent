// Yêu cầu của cả đề (HIET12OA, ZVUYZ41V) và company facts lưu ra file (TOKXKPBV L54): fixer, reviewer và người chấm
// sau trận đọc được cùng một nguồn.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

function runtime(invoke) {
  const root = tempDir('mtm-req-');
  const teamWork = join(root, '.team-work');
  const rt = new Runtime({ teamWorkspace: root });
  rt.session.paths = { teamWork, checkoutRoot: root, matchRoot: join(root, 'M1') };
  rt.session.descriptor = { matchId: 'M1' };
  rt.session.require = () => {};
  rt.company = { invoke };
  mkdirSync(teamWork, { recursive: true });
  rt.journalObj = new Journal(teamWork);
  rt.writer = { written: [], write(e) { this.written.push(e); } };
  return { rt, teamWork };
}

test('item requirements come from the page description', () => {
  const { rt, teamWork } = runtime();
  assert.deepEqual(rt.itemRequirements('CR-01'), [], 'no page.json yet');
  mkdirSync(join(teamWork, 'items', 'CR-01'), { recursive: true });
  writeFileSync(join(teamWork, 'items', 'CR-01', 'page.json'), JSON.stringify({ descriptionMd:
    '## Acceptance criteria\n1. The file conforms to Solova\'s invoice export standard.\n2. `pnpm test` and `pnpm typecheck` pass.\n' }));
  assert.deepEqual(rt.itemRequirements('CR-01').map(r => r.id), ['AC-1', 'AC-2']);
});

test('answer-only item: record_verification refuses an answer the independent solver disputes until it is checked', () => {
  const { rt, teamWork } = runtime();
  const matchRoot = rt.session.paths.matchRoot;
  const item = join(teamWork, 'items', 'TASK-01');
  mkdirSync(item, { recursive: true });
  writeFileSync(join(item, 'template.json'), JSON.stringify({ schemaVersion: 1, backlogId: 'TASK-01', status: 'NOT_STARTED', evidenceFiles: [], position: '' }));
  mkdirSync(join(matchRoot, 'answers', 'TASK-01'), { recursive: true });
  writeFileSync(join(matchRoot, 'answers', 'TASK-01', 'submit.json'), JSON.stringify({ schemaVersion: 1, backlogId: 'TASK-01', status: 'DONE', evidenceFiles: [], position: '98304' }));
  assert.equal(rt.solverAgreement('TASK-01', matchRoot), null, 'no solver yet: nothing to compare');
  const results = join(teamWork, 'results');
  mkdirSync(results, { recursive: true });
  const solver = n => writeFileSync(join(results, `TASK-01-solver-${n}.json`), JSON.stringify({ hypothesis: 'independent answer', verdict: 'supported',
    evidence: [], fix_location: null, next_check: null, answer_values: [{ field: 'position', value: n === 1 ? '131072' : '98304' }] }));
  solver(1);
  const disputed = rt.solverAgreement('TASK-01', matchRoot);
  assert.equal(disputed.state, 'disagree');
  assert.match(disputed.solverFile, /TASK-01-solver-1\.json$/);
  rt.jobs.jobs.set('job-1', { kind: 'run_gate', key: 'TASK-01', state: 'done', result: { where: 'main', passed: true } });
  assert.throws(() => rt.recordVerification({ backlogItemKey: 'TASK-01', gateJobId: 'job-1' }), /ANSWER_DISPUTED.*position "98304" vs "131072"/);
  // Checker đã bác giá trị của solver: ghi được (đếm theo submit.json không có testResults, gate main pass).
  assert.equal(rt.recordVerification({ backlogItemKey: 'TASK-01', gateJobId: 'job-1', disputeChecked: true }).status, 'RUNNING');
  solver(2);
  assert.equal(rt.solverAgreement('TASK-01', matchRoot).state, 'agree', 'the latest solver run counts');
});

test('company_call with backlogItemKey saves each result next to the item materials', async () => {
  const calls = [];
  const { rt, teamWork } = runtime(async (name, args) => {
    calls.push([name, args]);
    return name === 'broken' ? { isError: true, content: [{ type: 'text', text: 'no' }] }
      : { content: [{ type: 'text', text: `standard for ${args.query}` }] };
  });
  const first = await rt.companyCall({ name: 'kb_search', arguments: { query: 'invoice export' }, backlogItemKey: 'CR-01' });
  assert.equal(first.savedTo, join(teamWork, 'items', 'CR-01', 'company', '01-kb_search.json'));
  const saved = JSON.parse(readFileSync(first.savedTo, 'utf8'));
  assert.deepEqual(saved.arguments, { query: 'invoice export' });
  assert.equal(saved.content[0].text, 'standard for invoice export');
  const second = await rt.companyCall({ name: 'qa:get_test_data', arguments: { item: 'CR-01' }, backlogItemKey: 'CR-01' });
  assert.match(second.savedTo, /02-qa_get_test_data\.json$/);
  assert.equal((await rt.companyCall({ name: 'kb_search', arguments: { query: 'x' } })).savedTo, undefined, 'no item, nothing saved');
  const failed = await rt.companyCall({ name: 'broken', backlogItemKey: 'CR-01' });
  assert.equal(failed.savedTo, undefined);
  assert.equal(existsSync(join(teamWork, 'items', 'CR-01', 'company', '03-broken.json')), false);
  await assert.rejects(rt.companyCall({ name: 'kb_search', backlogItemKey: '../x' }), /INVALID_ARGUMENT/);
  assert.equal(calls.length, 4, 'a bad key is refused before the company system is called');
});
