// Đặc trưng item cho triage: đếm tiêu chí, cờ, grep code trên checkout, topology từ index codegraph, tri thức KB;
// luật difficulty dự phòng khi Jev dưới ngưỡng.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Decider } from '../../pack/src/decide/decisions.mjs';
import { JevClient, mockTransport } from '../../pack/src/decide/jev.mjs';
import { codegraphSourceSnapshot, saveCodegraphSnapshot } from '../../pack/src/env/codegraph-state.mjs';
import { answerOnlyText, codeTerms, codeTopology, countCriteria, detectDomain, difficultyFromSignals, itemSignals, kbInsights, moduleOf, moduleRoot,
  workText } from '../../pack/src/decide/signals.mjs';

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

// FMC0ZXFC: TASK-03/04 hỏi một câu ("## Question(s)"), PI-01 cấm sửa source; BUG-04 có Out of scope nhưng cũng có tiêu chí.
test('answer-only items: a question or answer format without criteria, or an out-of-scope ban on changing the source', () => {
  assert.equal(answerOnlyText('## Context\nA dispute.\n## Question\nWhich value?\n## Normalization\nOne integer.'), true);
  assert.equal(answerOnlyText('## Questions\n1. Ledger balance?\n## Submission\n- copy the template'), true);
  assert.equal(answerOnlyText('## What we need from you\n1. **rootCauseRelease**\n## Out of scope\nChanging the application source, re-sending e-mails.\n## Submission\nx'), true);
  assert.equal(answerOnlyText('## Acceptance criteria\n1. Order kept after reload\n## Out of scope\nChanging the application source of other boards.'), false);
  assert.equal(answerOnlyText('## Expected outcome\nCards keep their order.\n## Out of scope\nDatabase migration.'), false);
  assert.equal(answerOnlyText('## Question\nWhich value?\n## Acceptance criteria\n1. pnpm audit passes'), false);
});

// Index codegraph giả: chỉ những cột helper đọc (nodes, edges, files, project_metadata), cùng hướng cạnh như bản thật
// (source phụ thuộc target).
async function fakeIndex(root, { nodes, edges, state = 'complete' }) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(join(root, '.codegraph'), { recursive: true });
  const db = new DatabaseSync(join(root, '.codegraph', 'codegraph.db'));
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, target TEXT, kind TEXT);
    CREATE TABLE files (path TEXT PRIMARY KEY); CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_nodes_lower_name ON nodes(lower(name)); CREATE INDEX idx_edges_target_kind ON edges(target, kind);`);
  const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)');
  for (const [id, kind, name, file] of nodes) node.run(id, kind, name, file);
  const edge = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)');
  for (const [source, target, kind] of edges) edge.run(source, target, kind);
  const file = db.prepare('INSERT OR IGNORE INTO files VALUES (?)');
  for (const [, , , f] of nodes) file.run(f);
  db.prepare("INSERT INTO project_metadata VALUES ('index_state', ?)").run(state);
  db.close();
  const snapshot = await codegraphSourceSnapshot(root);
  assert.ok(snapshot);
  saveCodegraphSnapshot(root, snapshot);
}

// csv.ts ← invoice.ts (API) ← page.tsx, button.tsx (UI); test chỉ import. Ba module dưới gốc src/.
const GRAPH = {
  nodes: [
    ['f:csv', 'function', 'buildInvoiceCsv', 'src/lib/csv.ts'], ['f:esc', 'function', 'escapeCell', 'src/lib/csv.ts'],
    ['f:api', 'function', 'exportInvoices', 'src/server/api/invoice.ts'],
    ['f:page', 'component', 'InvoicesPage', 'src/app/(app)/invoices/page.tsx'], ['f:btn', 'component', 'ExportButton', 'src/app/(app)/invoices/button.tsx'],
    ['file:test', 'file', 'csv.test.ts', 'src/tests/csv.test.ts'], ['file:page', 'file', 'page.tsx', 'src/app/(app)/invoices/page.tsx'],
    ...Array.from({ length: 25 }, (_, i) => [`g:${i}`, 'function', 'get', `src/${['lib', 'server', 'app'][i % 3]}/g${i}.ts`])
  ],
  edges: [['f:csv', 'f:esc', 'calls'], ['f:api', 'f:csv', 'calls'], ['f:page', 'f:api', 'calls'], ['f:btn', 'f:api', 'calls'],
    ['file:test', 'f:csv', 'imports'], ['file:page', 'f:api', 'imports']]
};

const BUG = `# Export sometimes writes the same invoice twice
A double submit on **Export CSV** saves a half-written file; \`buildInvoiceCsv\` must run inside a transaction.
## Acceptance criteria
1. One file per click.`;

function repo(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

test('topology comes from the codegraph index; KB matches the stack and the risk words of the item', async () => {
  const root = repo('mtm-topo-', {
    'src/package.json': JSON.stringify({ dependencies: { next: '15.0.0', '@prisma/client': '6.0.0', '@trpc/server': '11.0.0' } }),
    'src/lib/csv.ts': 'export function buildInvoiceCsv() {}'
  });
  try {
    await fakeIndex(root, GRAPH);
    const s = await itemSignals({ title: 'Export twice', description: BUG }, { root });
    const { ms, ...topo } = s.topology;
    assert.ok(ms < 2500, `topology including freshness took ${ms} ms`);
    assert.deepEqual(topo, { freshness: 'fresh', seeds: 1, seed_from: 'symbols', symbols: ['buildInvoiceCsv'], impact_radius_files: 4, impacted_test_files: 1,
      call_depth: 2, callers_count: 1, callees_count: 1, cross_module: true, modules: 3, module_sample: ['lib', 'server/api', 'app/invoices'] });
    assert.equal(s.kb.domain, 'Next.js + tRPC + Prisma (node)');
    assert.deepEqual(s.kb.risk_factors, ['db_transaction', 'concurrency']);
    assert.match(s.kb.known_pitfalls, /^ORM \(Prisma.*transactions/);    // dòng của stack-notes/node.md
    assert.equal(s.kb.basis, 'heuristic');
    assert.equal(s.kb.known_pitfall_source.file, 'skills/stack-notes/node.md');
    const sourceLine = readFileSync(new URL(`../../pack/${s.kb.known_pitfall_source.file}`, import.meta.url), 'utf8')
      .split(/\r?\n/)[s.kb.known_pitfall_source.line - 1];
    assert.ok(sourceLine.includes(s.kb.known_pitfalls));
    // Rủi ro KB (double submit, half-written) được tính dù đề không có cờ data/tricky.
    assert.deepEqual(s.flags, ['ui']);
    assert.equal(difficultyFromSignals('BUG', s), 'medium');
    assert.equal(difficultyFromSignals('CR', { ...s, acceptance_criteria: 5 }), 'hard');
    assert.equal(difficultyFromSignals('CR', { ...s, acceptance_criteria: 5, kb: null }), 'medium');
    // Tên chung chung (25 hàm "get") không thành điểm xuất phát.
    assert.equal(await codeTopology(root, { terms: ['get'] }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without a usable codegraph index topology is null and the grep part still works', async () => {
  const root = repo('mtm-topo-', { 'src/lib/csv.ts': 'export function buildInvoiceCsv() {}' });
  try {
    const none = await itemSignals({ description: BUG }, { root });                         // chưa index
    assert.equal(none.topology, null);
    assert.equal(none.code.files, 1);
    await fakeIndex(root, { ...GRAPH, state: 'indexing' });                                  // đang index dở
    assert.deepEqual((await itemSignals({ description: BUG }, { root })).topology, { freshness: 'unknown', reason: 'index_incomplete' });
    writeFileSync(join(root, '.codegraph', 'codegraph.db'), 'not a database');               // DB hỏng
    const broken = await itemSignals({ description: BUG }, { root });
    assert.deepEqual(broken.topology, { freshness: 'unknown', reason: 'index_unreadable' });
    assert.equal(broken.code.files, 1);
    assert.equal(await codeTopology(null, { terms: ['buildInvoiceCsv'] }), null);
    // Không có checkout: KB vẫn đọc đề, stack unknown.
    const bare = kbInsights(workText(BUG));
    assert.deepEqual([bare.domain, bare.risk_factors], ['unknown', ['db_transaction', 'concurrency']]);
    assert.match(bare.known_pitfalls, /^State \/ concurrency/);                               // hàng của bug-patterns.md
    assert.equal(bare.known_pitfall_source.file, 'skills/backlog-references/bug-patterns.md');
    assert.ok(readFileSync(new URL(`../../pack/${bare.known_pitfall_source.file}`, import.meta.url), 'utf8')
      .split(/\r?\n/)[bare.known_pitfall_source.line - 1].includes('State / concurrency'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('difficulty rule uses the impact radius when topology is known', () => {
  const small = { acceptance_criteria: 2, verification_scenarios: 1, flags: [], code: { files: 2, modules: 1 } };
  assert.equal(difficultyFromSignals('BUG', small), 'easy');
  const topo = { impact_radius_files: 2, cross_module: false, modules: 1 };
  assert.equal(difficultyFromSignals('BUG', { ...small, topology: topo }), 'easy');
  assert.equal(difficultyFromSignals('BUG', { ...small, code: null, topology: topo }), 'easy');
  for (const uncertain of [{ ...topo, truncated: true }, { freshness: 'stale' }, { freshness: 'unknown' }]) {
    assert.equal(difficultyFromSignals('BUG', { ...small, topology: uncertain }), 'medium');
    assert.equal(difficultyFromSignals('TASK', { ...small, flags: ['answerOnly'], topology: uncertain }), 'easy');
  }
  // grep thấy 2 file nhưng sửa chỗ đó đụng tới 12 file ở 2 module: không còn easy.
  const wide = { impact_radius_files: 12, cross_module: true, modules: 2 };
  assert.equal(difficultyFromSignals('BUG', { ...small, topology: wide }), 'medium');
  assert.equal(difficultyFromSignals('TASK', { ...small, flags: ['data'], topology: wide, acceptance_criteria: 5 }), 'hard');
  assert.equal(difficultyFromSignals('BUG', { ...small, kb: { risk_factors: ['schema_migration'] } }), 'medium');
});

test('module root follows the dominant folder; route groups and tests do not count as modules', () => {
  const next = ['src/package.json', 'src/src/app/(app)/boards/page.tsx', 'src/src/app/(app)/accounting/page.tsx', 'src/src/lib/position.ts',
    'src/src/server/api/routers/card.ts', 'src/tests/card.test.ts'];
  assert.equal(moduleRoot(next), 'src/src/');
  assert.equal(moduleOf('src/src/app/(app)/boards/page.tsx', 'src/src/'), 'app/boards');
  assert.equal(moduleOf('src/src/lib/position.ts', 'src/src/'), 'lib');
  const java = ['pom.xml', ...['owner/Owner.java', 'owner/OwnerController.java', 'vet/Vet.java', 'visit/Visit.java']
    .map(f => `src/main/java/org/springframework/samples/petclinic/${f}`), 'src/test/java/org/springframework/samples/petclinic/owner/OwnerTests.java'];
  assert.equal(moduleRoot(java), 'src/main/java/org/springframework/samples/petclinic/');
});

test('domain comes from the manifests of the app root', () => {
  const put = files => {
    const root = mkdtempSync(join(tmpdir(), 'mtm-domain-'));
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    return root;
  };
  const roots = [
    put({ 'requirements.txt': 'Flask==3.0\nSQLAlchemy>=2\n' }),
    put({ 'pom.xml': '<artifactId>spring-petclinic</artifactId><artifactId>spring-boot-starter-data-jpa</artifactId>' }),
    put({ 'README.md': 'no manifest' })
  ];
  try {
    assert.deepEqual(detectDomain(roots[0]), { stack: 'python', frameworks: ['Flask', 'SQLAlchemy'] });
    assert.deepEqual(detectDomain(roots[1]), { stack: 'java', frameworks: ['Spring Petclinic', 'Spring Boot', 'JPA'] });
    assert.deepEqual(detectDomain(roots[2]), { stack: 'unknown', frameworks: [] });
    const kb = kbInsights('Two vets saving the same visit at the same time lose an update.', { root: roots[1] });
    assert.deepEqual(kb.risk_factors, ['concurrency']);
    assert.ok(kb.known_pitfalls);
    writeFileSync(join(roots[0], 'requirements.txt'), 'Django==5.0\n');
    assert.deepEqual(detectDomain(roots[0]), { stack: 'python', frameworks: ['Django'] }, 'manifest changes must not reuse a stale domain');
  } finally { for (const r of roots) rmSync(r, { recursive: true, force: true }); }
});

test('source changes invalidate topology even when grep still finds a single file', async () => {
  const root = repo('mtm-topo-stale-', { 'src/lib/csv.ts': 'export function buildInvoiceCsv() {}' });
  try {
    await fakeIndex(root, GRAPH);
    writeFileSync(join(root, 'src/lib/csv.ts'), 'export function buildInvoiceCsv() { return 1; }');
    const s = await itemSignals({ description: '`buildInvoiceCsv` has the wrong value.' }, { root });
    assert.deepEqual(s.topology, { freshness: 'stale', reason: 'source_changed' });
    assert.equal(s.code.files, 1);
    assert.equal(difficultyFromSignals('BUG', s), 'medium');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('depth, seed and time limits report incomplete topology instead of a small proven impact', async () => {
  for (const mode of ['depth', 'seeds', 'time']) {
    const root = repo('mtm-topo-limit-', { 'src/lib/csv.ts': 'export function buildInvoiceCsv() {}' });
    try {
      const graph = mode === 'depth' ? {
        nodes: Array.from({ length: 8 }, (_, i) => [`n${i}`, 'function', i ? `caller${i}` : 'buildInvoiceCsv', 'src/lib/csv.ts']),
        edges: Array.from({ length: 7 }, (_, i) => [`n${i + 1}`, `n${i}`, 'calls'])
      } : mode === 'seeds' ? {
        nodes: Array.from({ length: 61 }, (_, i) => [`n${i}`, 'function', `helper${i}`, 'src/lib/csv.ts']), edges: []
      } : GRAPH;
      await fakeIndex(root, graph);
      const topology = await codeTopology(root, { terms: mode === 'seeds' ? [] : ['buildInvoiceCsv'],
        grepFiles: ['src/lib/csv.ts'], ...(mode === 'time' ? { budgetMs: -1 } : {}) });
      assert.equal(topology.truncated, true, mode);
      assert.equal(difficultyFromSignals('BUG', { flags: [], topology }), 'medium', mode);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
