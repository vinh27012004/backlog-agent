// Gate: kiểm submit.json theo schema của item, chặn sửa test fail sẵn / bớt assertion (Practice #1, L2, L11).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerCheck, baselineTestFiles, changedFiles, codeScan, mvsEvidence, runGate, scenarioCounts } from '../../pack/src/gate.mjs';
import { contentTree, treeChanges } from '../../pack/src/git.mjs';
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
  writeFileSync(join(app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(vnd(1)).toBe(100); });\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  sh('git', ['init', '-q', '-b', 'main'], root, env);
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.logs/\n');   // như .team-work/ trong checkout thật
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
  writeFileSync(join(r.app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(vnd(1)).toBe(100); expect(vnd(2)).toBe(200); });\n');
  writeAnswer(r, { ...TEMPLATE });
  const stale = await gate(r);
  assert.equal(stale.failKind, 'answer_invalid');
  assert.equal(stale.signature, null, 'fixing submit.json needs no new fixer attempt');
  assert.equal(stale.codePassed, true);
  const answer = stale.checks.find(c => c.name === 'answer').problems.join('\n');
  assert.match(answer, /status is still the template value "NOT_STARTED"/);
  assert.match(answer, /schema \.status: must be one of/);
  writeAnswer(r, GOOD);
  const ok = await gate(r);
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks.find(c => c.name === 'tests-guard').status, 'ok');
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

test('gate records the tree of what it checked; answers do not change it, code does', async () => {
  const r = repo();
  writeFileSync(join(r.app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(vnd(1)).toBe(100); expect(vnd(2)).toBe(200); });\n');
  writeAnswer(r, { ...GOOD, status: 'PARTIAL' });
  const ok = await gate(r, { mvs: '## BUG-09-TC-01\nRequired evidence: tc-01.png\n' });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks.find(c => c.name === 'answer').status, 'warn');
  assert.match(ok.tree, /^[a-f0-9]{40}$/);
  const now = () => contentTree(r.root, 'M1', ['M1/answers/BUG-09']);
  assert.equal(await now(), ok.tree);
  writeAnswer(r, GOOD);
  assert.equal(await now(), ok.tree, 'answers/<ID>/ may change after the gate');
  writeFileSync(join(r.app, 'tests', 'money.test.ts'), 'it("vnd", () => { expect(vnd(1)).toBe(100); expect(vnd(2)).toBe(300); });\n');
  const changed = await now();
  assert.notEqual(changed, ok.tree);
  assert.deepEqual(await treeChanges(r.root, ok.tree, changed), ['M1/src/tests/money.test.ts']);
});

test('gate failures carry a stable signature', async () => {
  const r = repo();
  sh('git', ['rm', '-q', join('M1', 'src', 'tests', 'money.test.ts')], r.root);
  writeAnswer(r, GOOD);
  const deleted = await gate(r);
  assert.equal(deleted.failKind, 'forbidden_change');
  assert.equal(deleted.signature, 'forbidden:M1/src/tests/money.test.ts');

  const s = repo();
  writeFileSync(join(s.app, 'order.ts'), 'export const rate = 1;\n');
  // Build fail kiểu tsc, số dòng đổi giữa hai lần: chữ ký không đổi.
  const build = line => writeFileSync(join(s.app, 'build.js'),
    `console.error("src/order.ts(${line},5): error TS2339: Property 'rate' does not exist on type 'Order'."); process.exit(1);\n`);
  const compile = () => gate(s, { profile: { root: s.app, commands: { build: 'node build.js' }, forbiddenSkip: [] } });
  writeAnswer(s, GOOD);
  build(12);
  const first = await compile();
  assert.equal(first.failKind, 'compile');
  assert.equal(first.signature, "compile:order.ts:TSN: Property 'rate' does not exist on type 'Order'.");
  assert.match(first.checks.find(c => c.name === 'build').tail, /error TS2339/);
  assert.equal(first.codePassed, undefined);
  build(40);
  assert.equal((await compile()).signature, first.signature);
});

test('code scan warns about leftovers, unsafe SQL, credentials and junk files in the added lines only', async () => {
  const r = repo();
  const src = join(r.app, 'lib');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'orders.ts'), [
    '// TODO: handle refunds',
    'export function total() { throw new Error("not implemented"); }',
    'console.log("debug", total);',
    'const rows = await db.$queryRawUnsafe(`SELECT * FROM orders WHERE id = ${id}`);',
    'const safe = await db.$queryRaw`SELECT * FROM orders WHERE id = ${id}`;',
    'const q = "SELECT * FROM users WHERE name = \'" + name + "\'";',
    'const label = `Select ${name}`;',
    'const apiKey = "s3cr3t-value-123";',
    'const fromEnv = { password: process.env.DB_PASSWORD };',
    'const link = "#todo-list";', ''].join('\n'));
  mkdirSync(join(r.app, 'prisma'), { recursive: true });
  writeFileSync(join(r.app, 'prisma', 'seed-x.ts'), 'console.log("seeded");\n');
  writeFileSync(join(r.app, 'tests', 'money.test.ts'), 'it("vnd", () => { console.log("x"); expect(vnd(1)).toBe(100); });\n');
  writeFileSync(join(r.app, 'invoices-tab.tsx.cr01-backup'), 'old\n');
  writeFileSync(join(r.app, 'capture-before-cr01.mjs'), 'run()\n');
  const files = (await changedFiles(r.root, r.base));
  const warnings = (await codeScan(r.root, r.base, files, 'M1')).join('\n');
  assert.match(warnings, /lib\/orders\.ts:1: leaves a TODO/);
  assert.match(warnings, /orders\.ts:2: leaves an unimplemented stub/);
  assert.match(warnings, /orders\.ts:3: leaves debug output/);
  assert.match(warnings, /orders\.ts:4: builds SQL from strings/);
  assert.match(warnings, /orders\.ts:6: builds SQL from strings/);
  assert.match(warnings, /orders\.ts:8: hard-codes a credential/);
  assert.doesNotMatch(warnings, /orders\.ts:(5|7|9|10):/, 'tagged $queryRaw, UI text, env reads and "#todo" are fine');
  assert.doesNotMatch(warnings, /seed-x\.ts|money\.test\.ts/, 'CLI scripts and tests may print');
  assert.match(warnings, /invoices-tab\.tsx\.cr01-backup: looks like a backup/);
  assert.match(warnings, /capture-before-cr01\.mjs: looks like a backup or helper script/);
  writeAnswer(r, GOOD);
  const result = await gate(r);
  assert.equal(result.passed, true, 'code-scan only warns');
  assert.equal(result.checks.find(c => c.name === 'code-scan').status, 'warn');
  assert.ok(result.findings.some(f => f.startsWith('code-scan: ')));
});
