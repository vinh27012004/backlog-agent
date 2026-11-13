// Checklist của đề do luật code lập (pack/src/match/checklist.mjs) và luật chấm đọc bằng regex (decide/signals.mjs
// gradingRules). Từ sau CUZ7KL95 không còn team_analyst.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checklistBlock, checklistProblems, ruleChecklist } from '../../pack/src/match/checklist.mjs';
import { gradingRules } from '../../pack/src/decide/signals.mjs';
import { tempDir } from './support.mjs';

// Trích đề CR-07 và TASK-08 của bộ 14 item (BI7A5ACV, EXP3I47A).
const CR07 = `## Grading
TC-01 is replayed with \`CR-07-mvs.test.ts\`; TC-03 is replayed by the organizer in a browser on your built source. The grader runs the loot-core tests itself on your submitted revision after restoring the original test files. Hidden tests check the server audit in many more cases.`;
const TASK08 = `## Grading
Your suite is run against your submission, against a correct build and against builds that each break one part of the specification: it earns the pass points when it passes on your submission and on the correct build, and a detection share for each broken build it fails on.`;

test('grading rules: only an item graded on broken builds asks for the mutation check', () => {
  assert.equal(gradingRules(TASK08).detection, true);
  assert.equal(gradingRules(CR07).detection, false);
  assert.equal(gradingRules('').detection, false);
  assert.equal(gradingRules('Hidden tests run against seeded mutants of the module.').detection, true);
  assert.equal(gradingRules('The build must pass. Fix the broken link on the page.').detection, false);
});

// Dòng của CR-07 như luật code lập (MVS: evidence từng kịch bản), cộng các dòng mà một luật sau này có thể thêm.
const IDS = ['CR-07-TC-01', 'CR-07-TC-02', 'CR-07-TC-03', 'CR-07-TC-04'];
const cr07Lines = () => [
  ...ruleChecklist({ key: 'CR-07', scenarioIds: IDS,
    mvsEvidence: new Map([['CR-07-TC-02', ['reconciliation-2025-10.csv']], ['CR-07-TC-03', ['reconciliation.png']]]) }),
  { id: 'field:auditSummary', kind: 'field', name: 'auditSummary', type: 'object', exact: false, text: 'submit.json auditSummary: object, filled' },
  { id: 'source:x', kind: 'source', path: 'packages/loot-core/src/server/budget/reconciliation-audit.ts', text: 'reconciliation-audit.ts exists' },
];

test('the rule checklist comes from the MVS, the item text and the template, each id once, scenarios last', () => {
  const rule = ruleChecklist({ key: 'CR-07', scenarioIds: ['CR-07-TC-01', 'CR-07-TC-03'],
    mvsEvidence: new Map([['CR-07-TC-03', ['reconciliation.png', 'reconciliation.png']]]), required: [{ file: 'before.png', beforeFix: true }] });
  assert.deepEqual(rule.map(l => l.id), ['evidence:CR-07-TC-03:reconciliation.png', 'evidence:-:before.png', 'scenario:CR-07-TC-01', 'scenario:CR-07-TC-03']);
  assert.match(rule[1].text, /evidence\/before\.png, captured on the unfixed code — a real page/);
  assert.match(checklistBlock(rule), /1\. evidence\/reconciliation\.png for CR-07-TC-03/);
  // Đề chấm phát hiện lỗi: thêm dòng mutants.
  assert.ok(ruleChecklist({ detection: true }).some(l => l.kind === 'mutants'));
  assert.ok(!ruleChecklist({ detection: false }).some(l => l.kind === 'mutants'));
  // Đề chỉ trả lời: trường của template ngoài các trường khung; mảng và boolean không đoán (rỗng có thể là đáp án).
  const fields = ruleChecklist({ answerOnly: true, template: { status: 'NOT_STARTED', backlogId: 'TASK-10', total: '', count: 0, rows: [], ok: false },
    schema: { properties: { count: { type: 'integer' } } } });
  assert.deepEqual(fields.map(l => [l.id, l.type]), [['field:total', 'string'], ['field:count', 'integer']]);
  assert.deepEqual(ruleChecklist({ answerOnly: false, template: { total: '' } }), []);
  const dir = tempDir('mtm-checklist-');
  writeFileSync(join(dir, 'submit.json'), JSON.stringify({ status: 'DONE', total: '', count: 3 }));
  assert.deepEqual(checklistProblems(fields, { answerDir: dir }).map(p => p.problem), ['submit.json total is empty: the item scores it']);
});

test('checklist at handoff: required evidence of a PASS scenario, answer fields and named source files', () => {
  const dir = join(tempDir('mtm-checklist-'), 'answers', 'CR-07');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = submit => writeFileSync(join(dir, 'submit.json'), JSON.stringify(submit));
  const row = (n, result, evidence = []) => ({ id: `CR-07-TC-0${n}`, result, evidence });
  write({ status: 'PARTIAL', auditSummary: {}, testResults: [row(1, 'PASS', ['evidence/mvs.log']), row(2, 'PASS', ['evidence/replay.log']), row(3, 'PASS', ['evidence/reconciliation.png']), row(4, 'NOT_RUN')] });
  writeFileSync(join(dir, 'evidence', 'reconciliation-2025-10.csv'), 'x');
  const first = checklistProblems(cr07Lines(), { answerDir: dir, changed: [] }).map(p => p.problem).join('\n');
  assert.match(first, /CR-07-TC-02 is PASS but its evidence does not cite evidence\/reconciliation-2025-10\.csv/);
  assert.match(first, /CR-07-TC-03 is PASS but evidence\/reconciliation\.png does not exist/);
  assert.match(first, /submit\.json auditSummary is empty/);
  assert.match(first, /reconciliation-audit\.ts does not exist: the item names this file/);
  writeFileSync(join(dir, 'evidence', 'reconciliation.png'), 'png');
  write({ status: 'PARTIAL', auditSummary: { month: '2025-10' }, testResults: [row(1, 'PASS', ['evidence/mvs.log']), row(2, 'PASS', ['evidence/reconciliation-2025-10.csv']), row(3, 'PASS', ['evidence/reconciliation.png']), row(4, 'NOT_RUN')] });
  assert.deepEqual(checklistProblems(cr07Lines(), { answerDir: dir, changed: ['src/packages/loot-core/src/server/budget/reconciliation-audit.ts'] }), []);
  write({ status: 'PARTIAL', auditSummary: 'text', testResults: [row(1, 'PASS'), row(2, 'NOT_RUN'), row(3, 'NOT_RUN'), row(4, 'NOT_RUN')] });
  assert.deepEqual(checklistProblems(cr07Lines(), { answerDir: dir, exists: () => true }).map(p => p.problem), ['submit.json auditSummary must be object, it is string']);
});

// PNG tối thiểu: chữ ký + chunk IHDR (chỉ phần đầu được đọc).
const png = (width, height) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'ascii'); ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
};

test('a PASS screenshot smaller than a minViewport line is refused; a big enough one passes', () => {
  const dir = join(tempDir('mtm-checklist-'), 'answers', 'CR-07');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const lines = [{ id: 'evidence:CR-07-TC-03:reconciliation.png', kind: 'evidence', scenario: 'CR-07-TC-03', file: 'reconciliation.png', minViewport: '1280x720' }];
  writeFileSync(join(dir, 'submit.json'), JSON.stringify({ status: 'DONE', testResults: [{ id: 'CR-07-TC-03', result: 'PASS', evidence: ['evidence/reconciliation.png'] }] }));
  writeFileSync(join(dir, 'evidence', 'reconciliation.png'), png(800, 600));
  assert.deepEqual(checklistProblems(lines, { answerDir: dir }).map(p => p.id), ['viewport:CR-07-TC-03:reconciliation.png']);
  writeFileSync(join(dir, 'evidence', 'reconciliation.png'), png(1366, 768));
  assert.deepEqual(checklistProblems(lines, { answerDir: dir }), []);
});

test('zero-condition lines: a required file must exist and a size limit must hold, checked only with the match folder', () => {
  const lines = [
    { id: 'zero:required_file:m', kind: 'zero_condition', zeroKind: 'required_file', path: 'answers/TASK-07/bundle/manifest.json' },
    { id: 'zero:max_size:b', kind: 'zero_condition', zeroKind: 'max_size', path: 'answers/TASK-07/bundle/', maxBytes: 1000 }];
  const matchRoot = tempDir('mtm-checklist-'), dir = join(matchRoot, 'answers', 'TASK-07');
  mkdirSync(join(dir, 'bundle', 'parts'), { recursive: true });
  writeFileSync(join(dir, 'submit.json'), JSON.stringify({ status: 'DONE' }));
  assert.deepEqual(checklistProblems(lines, { answerDir: dir }), [], 'without matchRoot nothing is guessed');
  assert.match(checklistProblems(lines, { answerDir: dir, matchRoot }).map(p => p.problem).join('\n'), /manifest\.json does not exist/);
  writeFileSync(join(dir, 'bundle', 'manifest.json'), '{}');
  writeFileSync(join(dir, 'bundle', 'parts', 'a.bin'), Buffer.alloc(1200));
  assert.deepEqual(checklistProblems(lines, { answerDir: dir, matchRoot }).map(p => p.id), ['zero:max_size:b']);
});
