// Kiểm answer: submit.json theo schema và template của item, evidence MVS và evidence mô tả đòi, yêu cầu của đề
// (Practice #1 L2, Practice #2 L19, ZVUYZ41V, TOKXKPBV).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerCheck, itemEvidence, itemRequirements, mvsEvidence, requirementsCheck, scenarioCounts } from '../../pack/src/match/answers.mjs';
import { validateSchema } from '../../pack/src/core/jsonschema.mjs';
import { tempDir } from './support.mjs';

// Rút gọn từ BUG-02-submit.schema.json thật của Practice #1.
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'backlogId', 'status', 'evidenceFiles', 'testResults'],
  properties: {
    schemaVersion: { const: 1 }, backlogId: { const: 'BUG-09' }, status: { enum: ['DONE', 'PARTIAL', 'BLOCKED'] },
    evidenceFiles: { type: 'array', uniqueItems: true, items: { $ref: '#/$defs/evidencePath' } },
    testResults: { type: 'array', prefixItems: [{
      type: 'object', additionalProperties: false, required: ['id', 'result', 'evidence'],
      properties: { id: { const: 'BUG-09-TC-01' }, result: { $ref: '#/$defs/result' }, evidence: { type: 'array', items: { $ref: '#/$defs/evidencePath' } }, note: { type: 'string' } },
      if: { properties: { result: { const: 'PASS' } } }, then: { properties: { evidence: { minItems: 1 } } }
    }], items: false }
  },
  $defs: { evidencePath: { type: 'string', pattern: '^evidence/[A-Za-z0-9][A-Za-z0-9._-]*$' }, result: { enum: ['PASS', 'FAIL', 'NOT_RUN'] } }
};
const TEMPLATE = { schemaVersion: 1, backlogId: 'BUG-09', status: 'NOT_STARTED', evidenceFiles: [], testResults: [{ id: 'BUG-09-TC-01', result: 'NOT_RUN', evidence: [] }] };
const GOOD = { schemaVersion: 1, backlogId: 'BUG-09', status: 'DONE', evidenceFiles: ['evidence/tc-01.png'],
  testResults: [{ id: 'BUG-09-TC-01', result: 'PASS', evidence: ['evidence/tc-01.png'] }] };

test('json schema subset used by organizer submit schemas', () => {
  assert.deepEqual(validateSchema(GOOD, SCHEMA), []);
  const errors = validateSchema(TEMPLATE, SCHEMA).join('\n');
  assert.match(errors, /\.status: must be one of "DONE", "PARTIAL", "BLOCKED"/);
  const noEvidence = structuredClone(GOOD);
  noEvidence.testResults[0].evidence = [];
  assert.match(validateSchema(noEvidence, SCHEMA).join('\n'), /testResults\[0\]\.evidence: needs at least 1/);
  const extra = { ...GOOD, bonus: true, evidenceFiles: ['screens/a.png'] };
  const e = validateSchema(extra, SCHEMA).join('\n');
  assert.match(e, /unexpected property "bonus"/);
  assert.match(e, /evidenceFiles\[0\]: does not match/);
  assert.match(validateSchema({ ...GOOD, testResults: [...GOOD.testResults, GOOD.testResults[0]] }, SCHEMA).join('\n'), /testResults\[1\]: not allowed/);
});

// Thư mục trận tạm với answers/BUG-09/evidence/.
function repo() {
  const root = tempDir('mtm-answers-');
  mkdirSync(join(root, 'M1', 'answers', 'BUG-09', 'evidence'), { recursive: true });
  return { root };
}

const writeAnswer = (r, value) => {
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'evidence', 'tc-01.png'), 'png');
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), JSON.stringify(value));
};

test('answer keeps the template keys, leaves the template status and matches the item schema', () => {
  const r = repo();
  writeAnswer(r, { ...TEMPLATE });
  const stale = answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE, SCHEMA).problems.join('\n');
  assert.match(stale, /status is still the template value "NOT_STARTED"/);
  assert.match(stale, /schema \.status: must be one of/);
  writeAnswer(r, GOOD);
  assert.deepEqual(answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE, SCHEMA), { problems: [], warnings: [] });
});

// MVS thật của Practice #2 có dạng này: mỗi kịch bản một mục "## <ID>", evidence bắt buộc ghi theo tên file.
const MVS = ['# Minimum verification scenarios', '', '## BUG-09-TC-01', '', 'Expected: totals are right.', '',
  'Required evidence (screenshot): tc-01-totals.png and tc-01-detail.png', '', '## BUG-09-TC-02', '', 'Expected: export works.', '',
  'Required evidence (screenshot): tc-02-export.png', ''].join('\n');
const TEMPLATE2 = { ...TEMPLATE, testResults: [{ id: 'BUG-09-TC-01', result: 'NOT_RUN', evidence: [] }, { id: 'BUG-09-TC-02', result: 'NOT_RUN', evidence: [] }] };

test('MVS evidence per scenario, ids matched on word boundaries', () => {
  const map = mvsEvidence(MVS, ['BUG-09-TC-01', 'BUG-09-TC-02']);
  assert.deepEqual(map.get('BUG-09-TC-01'), ['tc-01-totals.png', 'tc-01-detail.png']);
  assert.deepEqual(map.get('BUG-09-TC-02'), ['tc-02-export.png']);
  assert.equal(mvsEvidence('## X-TC-10\nRequired evidence: a.png', ['X-TC-1']).size, 0);
  assert.equal(mvsEvidence({ not: 'markdown' }, ['X-TC-1']).size, 0);
});

test('answer results must cover the template, carry the MVS evidence and agree with status (L19)', () => {
  const r = repo();
  const dir = join(r.root, 'M1', 'answers', 'BUG-09');
  for (const f of ['tc-01-totals.png', 'tc-01-detail.png', 'tc-02-export.png']) writeFileSync(join(dir, 'evidence', f), 'png');
  const check = value => {
    writeFileSync(join(dir, 'submit.json'), JSON.stringify(value));
    return answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE2, null, MVS);
  };
  const tc1 = { id: 'BUG-09-TC-01', result: 'PASS', evidence: ['evidence/tc-01-totals.png', 'evidence/tc-01-detail.png'] };
  const tc2 = { id: 'BUG-09-TC-02', result: 'PASS', evidence: ['evidence/tc-02-export.png'] };

  assert.match(check({ ...TEMPLATE2, status: 'PARTIAL', testResults: [tc1] }).problems.join('\n'), /testResults lacks BUG-09-TC-02/);
  const thin = check({ ...TEMPLATE2, status: 'PARTIAL', testResults: [{ ...tc1, evidence: ['evidence/tc-01-totals.png'] }, tc2] });
  assert.match(thin.problems.join('\n'), /BUG-09-TC-01 is PASS but its evidence lacks what the MVS requires: evidence\/tc-01-detail\.png/);
  const overclaim = check({ ...TEMPLATE2, status: 'DONE', testResults: [tc1, { id: 'BUG-09-TC-02', result: 'NOT_RUN', evidence: [] }] });
  assert.match(overclaim.problems.join('\n'), /status is DONE but BUG-09-TC-02 did not PASS/);
  // BUG-01 của Practice #2: 3/3 PASS mà nộp PARTIAL. Cảnh báo, không chặn.
  const modest = check({ ...TEMPLATE2, status: 'PARTIAL', testResults: [tc1, tc2] });
  assert.deepEqual(modest.problems, []);
  assert.match(modest.warnings.join('\n'), /all 2 testResults PASS but status is PARTIAL/);
  assert.deepEqual(check({ ...TEMPLATE2, status: 'DONE', testResults: [tc1, tc2] }), { problems: [], warnings: [] });
  assert.deepEqual(check({ ...TEMPLATE2, status: 'PARTIAL', testResults: [tc1, { ...tc2, result: 'FAIL' }] }).problems, []);
  assert.deepEqual(scenarioCounts(join(dir, 'submit.json')), { passed: 1, failed: 1, skipped: 0 });
});

// Mục Submission thật của BUG-01 (ZVUYZ41V, cũng có ở HIET12OA): 0/200 vì thiếu dashboard_before_fixing.png.
const BUG01 = ['## Submission', '',
  'Create `answers/BUG-01/`, copy `challenge/BUG-01-submit.json` to `answers/BUG-01/submit.json`, and create its `evidence/` child directory. '
  + 'Capture screenshot of Dashboard before fixing as dashboard_before_fixing.png and commit to `evidence/` folder. '
  + 'Record actual test results and relative evidence paths. Every PASS result must reference an existing evidence file.', '',
  '- Before submitting, set the top-level `status` to `DONE`.'].join('\n');

test('evidence the item text requires: names in capture/evidence sentences, not paths, submit or challenge files', () => {
  assert.deepEqual(itemEvidence(BUG01), [{ file: 'dashboard_before_fixing.png', beforeFix: true }]);
  // BUG-02/CR-01 thật: tên file MVS là file đề, dòng ví dụ evidence/<file> là evidence thật.
  const bug02 = 'Follow the evidence rules and file names in `BUG-02-minimum-verification-scenarios.md`.\n'
    + '{ "id": "BUG-02-TC-01", "result": "PASS", "evidence": ["evidence/tc-01-vnd-invoice.png", "evidence/currency-report.txt"] }';
  assert.deepEqual(itemEvidence(bug02, ['challenge/BUG-02-minimum-verification-scenarios.md']).map(e => e.file),
    ['tc-01-vnd-invoice.png', 'currency-report.txt']);
  assert.deepEqual(itemEvidence('Add two screenshots: `a.png` and `b.png`. Export invoices.csv for finance.'),
    [{ file: 'a.png', beforeFix: false }, { file: 'b.png', beforeFix: false }]);
  assert.deepEqual(itemEvidence(null), []);
});

// Đề BUG-01 và TASK-01 thật (TOKXKPBV), rút gọn: BTC chấm theo cả đề nên yêu cầu ngoài MVS cũng vào danh sách.
const ITEM_BUG01 = ['# Admin sidebar overlaps content', '', '## Context', 'After login, the left sidebar overlaps content.', '',
  '## Expected outcome', 'On desktop, the main content and top bar sit beside the sidebar and remain fully readable.', '',
  '## Requirements', 'Fix the shared administration layout in both development and production. Preserve mobile navigation and existing page controls. Maximum practice score: 200 points.', '',
  'Desktop wireframe:', '', '```text', '| Sidebar | Top bar |', '```', '',
  '## Acceptance criteria', '1. The sidebar does not cover main content or the top bar at desktop widths,', '   including 1024px and 1440px.',
  '2. Existing pnpm test cases and pnpm typecheck pass.', '', '## Out of scope', 'Redesigning the navigation.', '',
  ...BUG01.split('\n'), '', '### submit.json contract', '', '- Keep exactly these rows and these field names: `id`, `result`.'].join('\n');
const ITEM_TASK01 = ['## Canonical scope', 'Use the issued source at commit 571c531. Exclude templates and imported cards.', '',
  '## Canonical algorithm', 'Determine the positions assigned by normal creation.', '',
  '## Normalization', 'The answer is one unsigned decimal integer string, without whitespace. Do not return a JSON number.'].join('\n');

test('item requirements: acceptance criteria, requirements and submission rules with ids, boilerplate left out', () => {
  assert.deepEqual(itemRequirements(ITEM_BUG01), [
    { id: 'RQ-1', text: 'On desktop, the main content and top bar sit beside the sidebar and remain fully readable.' },
    { id: 'RQ-2', text: 'Fix the shared administration layout in both development and production.' },
    { id: 'RQ-3', text: 'Preserve mobile navigation and existing page controls.' },
    { id: 'AC-1', text: 'The sidebar does not cover main content or the top bar at desktop widths, including 1024px and 1440px.' },
    { id: 'AC-2', text: 'Existing pnpm test cases and pnpm typecheck pass.' },
    { id: 'EV-1', text: 'Capture screenshot of Dashboard before fixing as dashboard_before_fixing.png and commit to `evidence/` folder.' }
  ]);
  assert.deepEqual(itemRequirements(ITEM_TASK01).map(r => r.id), ['RQ-1', 'RQ-2', 'RQ-3', 'RQ-4']);
  assert.match(itemRequirements(ITEM_TASK01)[0].text, /commit 571c531/);
  assert.deepEqual(itemRequirements('Change greet() to return "hello world".'), []);
  assert.deepEqual(itemRequirements(null), []);
});

test('requirements ledger: DONE with a not_met requirement is an answer fix, gaps are warnings', () => {
  const reqs = itemRequirements(ITEM_BUG01);
  assert.deepEqual(requirementsCheck(reqs, undefined, 'DONE'), { problems: [], warnings: [] }, 'no fix-result');
  assert.match(requirementsCheck(reqs, null, 'DONE').warnings[0], /no requirements ledger: RQ-1, RQ-2/);
  const ledger = reqs.map(r => ({ id: r.id, status: 'met', evidence: 'x' }));
  assert.deepEqual(requirementsCheck(reqs, ledger, 'DONE'), { problems: [], warnings: [] });
  const gap = requirementsCheck(reqs, ledger.slice(1), 'DONE');
  assert.match(gap.warnings[0], /does not address: RQ-1$/);
  const unmet = ledger.map(e => (e.id === 'AC-2' ? { ...e, status: 'not_met' } : e));
  assert.match(requirementsCheck(reqs, unmet, 'DONE').problems[0], /status is DONE but the fix-result reports AC-2 not met: use PARTIAL/);
  assert.match(requirementsCheck(reqs, unmet, 'PARTIAL').warnings[0], /requirements reported not met: AC-2/);
});

test('a file the item text requires must be captured and listed in evidenceFiles', () => {
  const r = repo();
  writeAnswer(r, GOOD);
  const required = itemEvidence(BUG01);
  const missing = answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE, SCHEMA, null, required);
  assert.deepEqual(missing.missingEvidence, ['dashboard_before_fixing.png']);
  assert.match(missing.problems.join('\n'), /missing evidence\/dashboard_before_fixing\.png: the item description requires it \(captured on the unfixed code\)/);
  const dir = join(r.root, 'M1', 'answers', 'BUG-09');
  writeFileSync(join(dir, 'evidence', 'dashboard_before_fixing.png'), 'png');
  const unlisted = answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE, SCHEMA, null, required);
  assert.equal(unlisted.missingEvidence, undefined);
  assert.match(unlisted.problems.join('\n'), /evidenceFiles lacks evidence\/dashboard_before_fixing\.png/);
  writeAnswer(r, { ...GOOD, evidenceFiles: [...GOOD.evidenceFiles, 'evidence/dashboard_before_fixing.png'] });
  assert.deepEqual(answerCheck(join(r.root, 'M1'), 'BUG-09', TEMPLATE, SCHEMA, null, required).problems, []);
});
