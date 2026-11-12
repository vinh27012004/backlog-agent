// Yêu cầu của cả đề (HIET12OA, ZVUYZ41V) và company facts lưu ra file (TOKXKPBV L54): fixer và người chấm sau trận đọc
// được cùng một nguồn.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { digest } from '../../pack/src/core/candidates.mjs';
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
  assert.equal(saved.untrusted, true);
  assert.deepEqual(saved.source, first.source);
  assert.equal(saved.source.kind, 'company_tool');
  assert.equal(saved.source.backlogItemKey, 'CR-01');
  assert.ok(Number.isFinite(Date.parse(saved.source.retrievedAt)));
  const { source, untrusted, ...payload } = saved;
  assert.equal(source.sha256, digest(payload));
  const second = await rt.companyCall({ name: 'qa:get_test_data', arguments: { item: 'CR-01' }, backlogItemKey: 'CR-01' });
  assert.match(second.savedTo, /02-qa_get_test_data\.json$/);
  assert.equal((await rt.companyCall({ name: 'kb_search', arguments: { query: 'x' } })).savedTo, undefined, 'no item, nothing saved');
  const failed = await rt.companyCall({ name: 'broken', backlogItemKey: 'CR-01' });
  assert.equal(failed.savedTo, undefined);
  assert.equal(existsSync(join(teamWork, 'items', 'CR-01', 'company', '03-broken.json')), false);
  await assert.rejects(rt.companyCall({ name: 'kb_search', backlogItemKey: '../x' }), /INVALID_ARGUMENT/);
  assert.equal(calls.length, 4, 'a bad key is refused before the company system is called');
});

// WQ7T6CEC: 42% ký tự của kết quả Company Tools là dãy một ký tự lặp ("complianceAnnexPadding … XXXX…").
test('filler runs in a Company Tools result are shortened for the model and the saved file; the raw result stays in company/raw', async () => {
  const pad = 'X'.repeat(120);
  const body = JSON.stringify({ articles: [{ id: 'KB-1', body: `rule A. ANNEX pad=${pad} checksum=0`, quote: '"'.repeat(45) }] });
  const { rt, teamWork } = runtime(async () => ({ content: [{ type: 'text', text: body }] }));
  const res = await rt.companyCall({ name: 'kb_search', arguments: { query: 'rules' }, backlogItemKey: 'CR-01' });
  assert.equal(res.fillerCollapsed, 1);
  const shown = JSON.parse(res.content[0].text);
  assert.equal(shown.articles[0].body, 'rule A. ANNEX pad=XXXXXXXX…(120 chars) checksum=0');
  assert.equal(shown.articles[0].quote, '"'.repeat(45), 'quote characters are never shortened: the JSON stays valid');
  const saved = JSON.parse(readFileSync(res.savedTo, 'utf8'));
  assert.equal(saved.fillerCollapsed, true);
  assert.equal(saved.content[0].text, res.content[0].text);
  assert.equal(res.rawFile, join(teamWork, 'items', 'CR-01', 'company', 'raw', '01-kb_search.json'));
  const raw = JSON.parse(readFileSync(res.rawFile, 'utf8'));
  assert.equal(raw.content[0].text, body, "the raw file keeps Company Tools' result as it came");
  assert.equal(raw.source.sha256, saved.source.sha256);
  const next = await rt.companyCall({ name: 'kb_search', arguments: { query: 'more' }, backlogItemKey: 'CR-01' });
  assert.equal(next.savedTo, join(teamWork, 'items', 'CR-01', 'company', '02-kb_search.json'), 'the raw folder does not shift the numbering');
});

