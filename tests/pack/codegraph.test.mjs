// Tool code_graph: engine lexical (Python qua tiến trình con thật, Java trực tiếp), chặn path, và engine TypeScript
// khi có sẵn một bản typescript (MTM_TEST_TYPESCRIPT = thư mục mà require('typescript') tìm được, vd. app của một
// trận practice: D:\mtm\BUN\matches\BC3JL6ZC\BC3JL6ZC\src).
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openEngine, runQuery } from '../../pack/src/codegraph.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

function project(files) {
  const tw = tempDir('mtm-cg-');
  const base = join(tw, 'matches', 'M1', 'M1');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
  return { tw, base, runtime: new Runtime({ teamWorkspace: tw }) };
}

const names = rows => rows.map(r => r.name);

test('code_graph lexical engine on a Python app, through the worker process', async () => {
  const { tw, base, runtime } = project({
    'app/requirements.txt': 'pytest\n',
    'app/shop/orders.py': ['from shop.pricing import total_price', '', '',
      'class OrderService:', '    def __init__(self, repo):', '        self.repo = repo', '',
      '    def place(self, items):', '        price = total_price(items)', '        return self.repo.save(items, price)', '', '',
      'def checkout(service, items):', '    return service.place(items)', ''].join('\n'),
    'app/shop/pricing.py': ['def total_price(items):', '    return sum(apply_discount(i) for i in items)', '', '',
      'def apply_discount(item):', '    if item.get("vip"):', '        return item["price"] * 0.9', '    return item["price"]', ''].join('\n'),
    'app/tests/test_pricing.py': ['from shop.pricing import total_price', '', '',
      'def test_total():', '    assert total_price([{"price": 10}]) == 10', ''].join('\n')
  });
  const call = a => runtime.codeGraph({ path: base, ...a });
  try {
    const found = await call({ action: 'find', query: 'price' });
    assert.equal(found.engine, 'lexical');
    assert.equal(found.app, 'app');
    assert.deepEqual(names(found.results), ['total_price']);

    const outline = await call({ action: 'outline', file: 'app/shop/orders.py' });
    assert.deepEqual(outline.results.map(r => [r.depth, r.name, r.line, r.end]),
      [[0, 'OrderService', 4, 10], [1, '__init__', 5, 6], [1, 'place', 8, 10], [0, 'checkout', 13, 14]]);

    const callers = await call({ action: 'callers', symbol: 'total_price' });
    assert.deepEqual(callers.target, { name: 'total_price', kind: 'function', file: 'app/shop/pricing.py', line: 1 });
    assert.deepEqual(callers.results.map(r => [r.file, r.line, r.in]),
      [['app/shop/orders.py', 9, 'place'], ['app/tests/test_pricing.py', 5, 'test_total']]);
    assert.match(callers.note, /lexical/);

    const callees = await call({ action: 'callees', symbol: 'OrderService.place' });
    assert.deepEqual(callees.results.map(r => [r.name, r.file, r.line, r.calledAt]), [['total_price', 'app/shop/pricing.py', 1, [9]]]);

    const impact = await call({ action: 'impact', symbol: 'apply_discount', depth: 3 });
    assert.deepEqual(impact.results.map(r => [r.level, r.in]),
      [[1, 'total_price'], [2, 'place'], [2, 'test_total'], [3, 'checkout']]);
    assert.deepEqual(impact.tests, ['app/tests/test_pricing.py']);

    const refs = await call({ action: 'references', symbol: 'total_price' });
    assert.deepEqual(refs.importedBy.sort(), ['app/shop/orders.py', 'app/tests/test_pricing.py']);
    assert.equal(refs.results.length, 2);

    assert.equal((await call({ action: 'callers', symbol: 'nope' })).notFound, 'nope');
    await assert.rejects(call({ action: 'outline', file: 'app/missing.py' }), /FILE_NOT_FOUND/);
    await assert.rejects(call({ action: 'explode' }), /INVALID_ARGUMENT/);
    await assert.rejects(runtime.codeGraph({ action: 'find', query: 'x', path: 'matches/M1' }), /INVALID_ARGUMENT/);
    await assert.rejects(runtime.codeGraph({ action: 'find', query: 'x', path: tw }), /PATH_NOT_ALLOWED/);
    await assert.rejects(runtime.codeGraph({ action: 'find', query: 'x', path: join(tw, 'matches') }), /PATH_NOT_ALLOWED/);
  } finally {
    runtime.codeGraphObj?.stop();
  }
});

test('code_graph lexical engine on Java: method bodies by braces, statements are not declarations', () => {
  const { base } = project({
    'svc/pom.xml': '<project/>\n',
    'svc/src/main/java/demo/InvoiceService.java': ['package demo;', '', 'public class InvoiceService {',
      '    private final Repo repo;', '', '    public Invoice issue(Order order) {', '        if (order == null) {',
      '            throw new IllegalArgumentException("order {");', '        }', '        Invoice inv = build(order);',
      '        return repo.save(inv);', '    }', '', '    private Invoice build(Order order) {',
      '        return new Invoice(order.total());', '    }', '}', ''].join('\n')
  });
  const engine = openEngine(join(base, 'svc'));
  const q = a => runQuery(engine, base, a);
  assert.deepEqual(q({ action: 'outline', file: 'svc/src/main/java/demo/InvoiceService.java' }).results.map(r => [r.depth, r.name, r.line, r.end]),
    [[0, 'InvoiceService', 3, 17], [1, 'issue', 6, 12], [1, 'build', 14, 16]]);
  assert.deepEqual(q({ action: 'callers', symbol: 'InvoiceService.build' }).results.map(r => [r.line, r.in]), [[10, 'issue']]);
  assert.deepEqual(q({ action: 'callees', symbol: 'issue' }).results.map(r => [r.name, r.line]), [['build', 14]]);
});

function typescriptDir() {
  const from = process.env.MTM_TEST_TYPESCRIPT;
  if (!from) return null;
  try { return dirname(createRequire(join(from, 'package.json')).resolve('typescript/package.json')); } catch { return null; }
}

test('code_graph TypeScript engine: call hierarchy, tRPC-style members, JSX, edits', { skip: typescriptDir() ? false : 'set MTM_TEST_TYPESCRIPT to a folder with node_modules/typescript' }, async () => {
  const { base, runtime } = project({
    'src/package.json': '{"name":"fx","private":true}\n',
    'src/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler', target: 'es2022', skipLibCheck: true, noEmit: true },
      include: ['src/**/*', 'tests/**/*'] }),
    'src/src/service.ts': ['export function computeTotal(items: number[]): number {', '  return items.reduce((a, b) => a + b, 0);', '}', '',
      'export class Ledger {', '  post(amount: number) {', '    return computeTotal([amount]);', '  }', '}', '',
      'export class Journal {', '  post() {', '    return 0;', '  }', '}', ''].join('\n'),
    'src/src/router.ts': ["import { computeTotal } from './service';", '',
      'const procedure = { mutation: <T>(fn: () => T) => fn };', 'const createRouter = <T extends object>(routes: T) => routes;', '',
      'export const invoiceRouter = createRouter({', '  create: procedure.mutation(() => computeTotal([1, 2])),',
      '  list: procedure.mutation(() => [] as number[]),', '});', ''].join('\n'),
    'src/src/view.tsx': ["import { computeTotal } from './service';", '', 'export function Total() {', '  return computeTotal([3]);', '}', '',
      'export function Page() {', '  return <Total />;', '}', ''].join('\n'),
    'src/tests/service.test.ts': ["import { computeTotal } from '../src/service';", '', 'function check() {',
      "  if (computeTotal([1]) !== 1) throw new Error('bad');", '}', 'check();', ''].join('\n')
  });
  mkdirSync(join(base, 'src', 'node_modules'));
  symlinkSync(typescriptDir(), join(base, 'src', 'node_modules', 'typescript'), 'junction');
  const call = a => runtime.codeGraph({ path: base, ...a });
  try {
    const callers = await call({ action: 'callers', symbol: 'computeTotal' });
    assert.equal(callers.engine, 'typescript');
    assert.deepEqual(callers.target, { name: 'computeTotal', kind: 'function', file: 'src/src/service.ts', line: 1 });
    assert.deepEqual(callers.results.map(r => [r.file, r.line]).sort(), [['src/src/router.ts', 7], ['src/src/service.ts', 7],
      ['src/src/view.tsx', 4], ['src/tests/service.test.ts', 4]]);
    assert.equal(callers.results.find(r => r.file === 'src/src/service.ts').in, 'Ledger > post');
    assert.match(callers.results.find(r => r.file === 'src/src/router.ts').in, /^invoiceRouter > create/);

    // Thuộc tính của object truyền vào hàm (procedure tRPC): navigateTo không thấy, navigation tree thì có.
    assert.ok((await call({ action: 'find', query: 'create' })).results.some(r => r.name === 'create' && r.container === 'invoiceRouter'));
    const callees = await call({ action: 'callees', symbol: 'invoiceRouter.create' });
    assert.ok(callees.results.some(r => r.name === 'computeTotal' && r.file === 'src/src/service.ts' && r.calledAt[0] === 7));
    assert.deepEqual((await call({ action: 'callees', symbol: 'Page' })).results.map(r => r.name), ['Total']);

    const ambiguous = await call({ action: 'callers', symbol: 'post' });
    assert.equal(ambiguous.ambiguous, true);
    assert.deepEqual(ambiguous.candidates.map(c => c.container).sort(), ['Journal', 'Ledger']);
    assert.equal((await call({ action: 'callers', symbol: 'Ledger.post' })).target.container, 'Ledger');
    assert.equal((await call({ action: 'callers', file: 'src/src/service.ts', line: 12 })).target.name, 'post');

    const refs = await call({ action: 'references', symbol: 'computeTotal' });
    assert.deepEqual(refs.importedBy.sort(), ['src/src/router.ts', 'src/src/view.tsx', 'src/tests/service.test.ts']);

    const impact = await call({ action: 'impact', symbol: 'computeTotal', depth: 2 });
    assert.ok(impact.results.some(r => r.level === 2 && r.in === 'Page'), 'JSX use counts as a call');
    assert.deepEqual(impact.tests, ['src/tests/service.test.ts']);

    // Agent sửa file: lời gọi mới thấy ngay ở lần sau (version theo mtime + size).
    writeFileSync(join(base, 'src', 'src', 'view.tsx'), ["import { computeTotal } from './service';", '', 'export function Total() {',
      '  return computeTotal([3]) + computeTotal([4]);', '}', ''].join('\n'));
    assert.equal((await call({ action: 'callers', symbol: 'computeTotal' })).results.length, 5);
    const outline = await call({ action: 'outline', file: 'src/src/router.ts' });
    assert.deepEqual(outline.results.filter(r => r.depth <= 1).map(r => r.name), ['procedure', 'mutation', 'createRouter', 'invoiceRouter', 'create', 'list']);
  } finally {
    runtime.codeGraphObj?.stop();
  }
});
