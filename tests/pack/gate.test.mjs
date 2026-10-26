// Gate: kiểm submit.json theo schema của item, chặn sửa test fail sẵn / bớt assertion (Practice #1, L2, L11).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { baselineTestFiles, runGate } from '../../pack/src/gate.mjs';
import { validateSchema } from '../../pack/src/jsonschema.mjs';
import { sh, tempDir } from './support.mjs';

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

test('baseline failing names map to test files', () => {
  assert.deepEqual(baselineTestFiles([
    'deletion cascades (spec §4) > deleting a company with invoices is RESTRICTED',
    'tests/cascade.test.ts > deletion cascades (spec §4) > deleting a company with invoices is RESTRICTED',
    'tests/test_orders.py::test_total'
  ]), ['tests/cascade.test.ts', 'tests/test_orders.py']);
});

// Repo tạm: một test fail sẵn (giống cascade.test.ts của Solova), một test khác bình thường.
function repo() {
  const root = tempDir('mtm-gate-');
  const app = join(root, 'M1', 'src');
  mkdirSync(join(app, 'tests'), { recursive: true });
  mkdirSync(join(root, 'M1', 'answers', 'BUG-09', 'evidence'), { recursive: true });
  writeFileSync(join(app, 'tests', 'cascade.test.ts'), [
    'it("deleting a company with invoices is RESTRICTED", async () => {',
    '  await expect(db.company.delete({ where: { id } })).rejects.toThrow();',
    '});', ''].join('\n'));
  writeFileSync(join(app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(1).toBe(1); });\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  sh('git', ['init', '-q', '-b', 'main'], root, env);
  sh('git', ['add', '-A'], root, env);
  sh('git', ['commit', '-q', '-m', 'seed'], root, env);
  const base = sh('git', ['rev-parse', 'HEAD'], root);
  return { root, app, base };
}

const gate = (r, extra = {}) => runGate({ id: 'job-t', progress: [] }, {
  key: 'BUG-09', checkoutRoot: r.root, matchRoot: join(r.root, 'M1'), folder: 'M1',
  profile: { root: r.app, commands: {}, forbiddenSkip: ['.skip('] }, base: r.base,
  baseline: { failing: ['tests/cascade.test.ts > deleting a company with invoices is RESTRICTED'] },
  template: TEMPLATE, schema: SCHEMA, logDir: join(r.root, '.logs'), limits: { maxFiles: 25, buildMs: 60_000, testMs: 60_000 }, ...extra });

const writeAnswer = (r, value) => {
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'evidence', 'tc-01.png'), 'png');
  writeFileSync(join(r.root, 'M1', 'answers', 'BUG-09', 'submit.json'), JSON.stringify(value));
};

test('gate blocks inverting a baseline-failing test unless justified', async () => {
  const r = repo();
  writeFileSync(join(r.app, 'tests', 'cascade.test.ts'), [
    'it("deleting a company cascades its invoices", async () => {',
    '  await db.company.delete({ where: { id } });',
    '  expect(await db.invoice.count()).toBe(0);',
    '});', ''].join('\n'));
  writeAnswer(r, GOOD);
  const blocked = await gate(r);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.failKind, 'forbidden_change');
  const problems = blocked.checks.find(c => c.name === 'tests-guard').problems.join('\n');
  assert.match(problems, /already failed at baseline/);
  assert.match(problems, /removes 1 assertion\(s\)/);   // .rejects + .toThrow + expect( → expect( + .toBe
  const justified = await gate(r, { allowTestChange: { reason: 'Policy says invoices cascade', source: 'kb_search FIN-STD-7' } });
  assert.equal(justified.passed, true, JSON.stringify(justified.checks));
  assert.equal(justified.checks.find(c => c.name === 'tests-guard').status, 'warn');
  assert.equal(justified.testChangeJustification.source, 'kb_search FIN-STD-7');
});

test('gate allows adding assertions to an existing test and validates the answer', async () => {
  const r = repo();
  writeFileSync(join(r.app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(1).toBe(1); expect(2).toBe(2); });\n');
  writeAnswer(r, { ...TEMPLATE });
  const stale = await gate(r);
  assert.equal(stale.failKind, 'answer_invalid');
  const answer = stale.checks.find(c => c.name === 'answer').problems.join('\n');
  assert.match(answer, /status is still the template value "NOT_STARTED"/);
  assert.match(answer, /schema \.status: must be one of/);
  writeAnswer(r, GOOD);
  const ok = await gate(r);
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks.find(c => c.name === 'tests-guard').status, 'ok');
});
