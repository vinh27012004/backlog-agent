// Đặc trưng item cho triage: đếm tiêu chí, cờ, grep code trên checkout; luật difficulty dự phòng khi Jev dưới ngưỡng.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Decider } from '../../pack/src/decisions.mjs';
import { JevClient, mockTransport } from '../../pack/src/jev.mjs';
import { codeTerms, countCriteria, difficultyFromSignals, itemSignals, workText } from '../../pack/src/signals.mjs';

// Rút gọn từ CR-01 của Practice HIET12OA.
const CR = `# Export the filtered invoice list as CSV
## Requirements
1. Place a button labelled **Export CSV** beside **New invoice**.
2. Export every invoice returned by the current company filter.
3. Layout and dates must follow Solova's accounting data-exchange standards exactly; the internal systems are authoritative.
4. Data stays restricted to signed-in staff.
5. Add automated tests for \`buildInvoiceCsv\`, including the signed-out case.
## Submission
Create \`answers/CR-01/\` and copy \`challenge/CR-01-submit.json\`.`;

test('criteria are counted under Acceptance criteria, else Requirements', () => {
  assert.equal(countCriteria(CR), 5);
  assert.equal(countCriteria('## Acceptance criteria\n1. a\n2. b\n## Out of scope\n- c'), 2);
  assert.equal(countCriteria('no headings here'), 0);
});

test('submission and out-of-scope sections are ignored; answerOnly needs an answer format and no criteria', async () => {
  const task = '## Canonical algorithm\nReport the persisted position.\n## Answer format\nOne string.\n## Out of scope\nDatabase migration.\n'
    + '## Submission\nRecord `testResults` as PASS.\n### submit.json contract\n`BUG-01-TC-01`';
  const s = await itemSignals({ description: task });
  assert.deepEqual(s.flags, ['data', 'answerOnly']);       // "persisted"; không lấy "migration" của Out of scope
  assert.deepEqual(codeTerms(workText(task)), []);         // không lấy testResults, mã TC ở phần nộp bài
  const withCriteria = await itemSignals({ description: `${task}\n## Acceptance criteria\n1. pnpm audit passes` });
  assert.ok(!withCriteria.flags.includes('answerOnly'));
});

test('code terms keep labels and identifiers, drop submission paths', () => {
  const terms = codeTerms(CR);
  assert.ok(terms.includes('Export CSV'));
  assert.ok(terms.includes('buildInvoiceCsv'));
  assert.ok(!terms.some(t => /answers|challenge/.test(t)));
});

test('signals grep the checkout, skip generic terms and answers/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mtm-signals-'));
  try {
    const put = (rel, body) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); };
    put('src/invoices/csv.ts', 'export function buildInvoiceCsv() {}');
    put('src/invoices/page.tsx', '<Button>New invoice</Button>');
    put('src/invoices/csv.test.ts', 'buildInvoiceCsv()');
    put('answers/CR-01/notes.md', 'buildInvoiceCsv');
    for (let i = 0; i < 45; i++) put(`src/gen/f${i}.ts`, 'Export CSV');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    const s = await itemSignals({ title: 'Export CSV', description: CR, points: 300 }, { root, scenarios: 4 });
    assert.equal(s.acceptance_criteria, 5);
    assert.deepEqual(s.flags.filter(f => ['externalSpec', 'security', 'ui'].includes(f)).sort(), ['externalSpec', 'security', 'ui']);
    assert.ok(!s.code.terms.includes('Export CSV'));          // khớp 45 file: quá chung chung
    assert.equal(s.code.files, 3);                            // csv.ts, csv.test.ts, page.tsx; không tính answers/
    assert.equal(s.code.test_files, 1);
    assert.equal(difficultyFromSignals('CR', s), 'hard');
    // Không có checkout: vẫn có phần chữ, code = null.
    assert.equal((await itemSignals({ description: CR }, { root: null })).code, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('difficulty rule: easy only with evidence, hard when several signals add up', () => {
  assert.equal(difficultyFromSignals('BUG', null), 'medium');
  const small = { acceptance_criteria: 3, verification_scenarios: 1, flags: ['ui'], code: { files: 2, modules: 1 } };
  assert.equal(difficultyFromSignals('BUG', small), 'easy');
  assert.equal(difficultyFromSignals('BUG', { ...small, code: null }), 'medium');   // không biết vùng code: không nói easy
  assert.equal(difficultyFromSignals('TASK', { ...small, flags: ['answerOnly'], code: null }), 'easy');
  assert.equal(difficultyFromSignals('TASK', { ...small, flags: ['dependencies', 'data'], acceptance_criteria: 5 }), 'hard');
});

test('Jev below threshold falls back to the signal rule, and signals reach Jev before the item', async () => {
  const bodies = [];
  const unsure = body => {
    bodies.push(body);
    const res = mockTransport(body);
    res.answers.difficulty = { type: 'choice', choice: 'easy', confidence: 0.4 };
    return res;
  };
  const cfg = { enabled: true, baseUrl: 'http://127.0.0.1:9', model: 'jev-test', apiKeyEnv: 'MTM_TEST_NO_SUCH_KEY', apiKeyFile: null,
    timeoutMs: 2000, retries: 0, maxStateChars: 4000, thresholds: { choice: 0.7, noulYes: 0.8, noulNo: 0.2, injection: 0.7 } };
  const signals = { acceptance_criteria: 5, verification_scenarios: 6, flags: ['dependencies'], code: null };
  const { triage, route } = await new Decider(new JevClient(cfg, { transport: unsure })).intake('TASK-02', { title: 'x', description: 'y' }, { signals });
  assert.deepEqual([triage.difficulty.value, triage.difficulty.source, triage.difficulty.jev], ['hard', 'rule', 'easy']);
  assert.equal(route.model.value, 'strong');                  // item hard luôn tier strong
  const at = h => bodies[0].state.indexOf(`## ${h}\n`);
  assert.ok(at('signals') > 0 && at('signals') < at('item'));
});
