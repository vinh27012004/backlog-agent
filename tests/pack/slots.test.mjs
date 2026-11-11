// Chỗ trống cho item mới (ZVUYZ41V: TASK-01 ra lúc 02:49:49, chờ tới 03:02 với 2 item đang chạy vì root không đọc
// sự kiện giữa các wait_agent): mọi kết quả tool của root mang `notice` khi có item chưa bắt đầu mà còn chỗ.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime, callTool, loadRuntimeConfig } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

const row = (key, local, extra = {}) => ({ key, type: key.split('-')[0], status: 'OPEN', local, minutesLeft: 20, ...extra });

// Các test dưới giữ 4 slot qua file local (cùng cơ chế operator dùng để đổi số slot giữa trận).
function runtime(rows, maxItemsInFlight = 4) {
  const tw = tempDir('mtm-slots-');
  mkdirSync(join(tw, 'team-sdlc-pack', 'local'), { recursive: true });
  writeFileSync(join(tw, 'team-sdlc-pack', 'local', 'runtime.json'), JSON.stringify({ maxItemsInFlight }));
  const rt = new Runtime({ teamWorkspace: tw });
  rt.session.phase = 'GAME';
  rt.gm = { view: { items: [] } };
  rt.itemRows = () => rows;
  rt.matchState = () => ({ suggestedOrder: rows.filter(r => r.status !== 'CLOSED' && !['submitted', 'failed'].includes(r.local)).map(r => r.key) });
  return rt;
}

test('notice lists items not started while fewer than 4 items run; a PI needs no slot; closed and late items are left out', () => {
  const rows = [row('CR-01', 'started'), row('TASK-02', 'started'), row('BUG-01', 'submitted'), row('TASK-01', 'todo'),
    row('PI-01', 'todo'), row('BUG-03', 'todo', { status: 'CLOSED' }), row('CR-02', 'todo', { minutesLeft: 3 }), row('BUG-04', 'todo', { minutesLeft: null })];
  const notice = runtime(rows).itemNotice();
  assert.deepEqual(notice.newItems, ['TASK-01', 'PI-01', 'BUG-04']);
  assert.deepEqual(notice.answerOnly, ['PI-01']);
  assert.match(notice.hint, /Needs no slot \(PI \/ answer-only\): start PI-01 now/);
  assert.equal(notice.freeSlots, 2);
  assert.match(notice.hint, /start TASK-01, BUG-04 now/);
  const full = [row('BUG-01', 'started'), row('BUG-02', 'started'), row('CR-01', 'started'), row('TASK-02', 'started'), row('TASK-01', 'todo')];
  assert.equal(runtime(full).itemNotice(), null, 'no free slot');
  assert.equal(runtime([row('CR-01', 'started'), row('BUG-01', 'published')]).itemNotice(), null, 'nothing waiting');
  const prepare = runtime(rows);
  prepare.session.phase = 'PREPARE';
  assert.equal(prepare.itemNotice(), null);
});

// 11/11 (sau QDO8W480): mặc định không giới hạn số item làm cùng lúc; máy được giữ bằng hàng chờ lệnh nặng (heavy.mjs).
test('items in flight are unlimited by default; a local runtime.json may set a limit, bad values mean no limit', () => {
  assert.equal(loadRuntimeConfig().maxItemsInFlight, Infinity);
  const local = tempDir('mtm-runtime-cfg-');
  for (const [value, expected] of [[3, 3], [8, 8], ['6', 6], [32, 32], [0, Infinity], [33, Infinity], ['many', Infinity], [2.5, Infinity]]) {
    writeFileSync(join(local, 'runtime.json'), JSON.stringify({ maxItemsInFlight: value }));
    assert.equal(loadRuntimeConfig(local).maxItemsInFlight, expected, String(value));
  }
  writeFileSync(join(local, 'runtime.json'), 'not json');
  assert.equal(loadRuntimeConfig(local).maxItemsInFlight, Infinity, 'unreadable local file: pack default');
  const full = [row('BUG-01', 'started'), row('BUG-02', 'started'), row('CR-01', 'started'), row('TASK-02', 'started'), row('TASK-01', 'todo')];
  assert.deepEqual(runtime(full, 5).itemNotice().newItems, ['TASK-01'], 'a fifth slot starts the waiting item');
  const open = runtime(full, 0).itemNotice();
  assert.deepEqual(open.newItems, ['TASK-01']);
  assert.equal(open.freeSlots, undefined, 'no number to report without a limit');
  assert.match(open.hint, /Not started yet: start TASK-01 now/);
  assert.equal(runtime(full, 0).freeSlots(full), Infinity);
});

test('root tool results carry the notice; match_state, proxied calls and errors do not', async () => {
  const rt = runtime([row('CR-01', 'started'), row('TASK-01', 'todo')]);
  rt.session.descriptor = { matchId: 'M1' };
  const tool = name => ({ name, handler: () => ({ state: 'done' }) });
  const root = await callTool(rt, tool('job_status'), {}, {});
  assert.deepEqual(root.structuredContent.notice.newItems, ['TASK-01']);
  assert.equal(JSON.parse(root.content[0].text).state, 'done');
  assert.equal((await callTool(rt, tool('match_state'), {}, {})).structuredContent.notice, undefined);
  assert.equal((await callTool(rt, tool('read_item'), {}, {}, { activity: false })).structuredContent.notice, undefined);
  rt.itemNotice = () => { throw new Error('boom'); };
  assert.equal((await callTool(rt, tool('job_status'), {}, {})).isError, false, 'a broken notice never breaks the tool');
});

// 803P85ZA: cr01_fix2 ghi CR-01-fixer-2.json lúc root đang submit item khác; CR-01 không nộp.
test('the newest fix-result not yet a candidate is reported once as FIX_RESULT and in every notice', async () => {
  const rt = runtime([row('CR-01', 'started'), row('BUG-01', 'started'), row('TASK-02', 'started'), row('BUG-02', 'submitted')]);
  const teamWork = tempDir('mtm-results-');
  rt.session.paths = { teamWork };
  rt.session.descriptor = { matchId: 'M1' };
  const results = join(teamWork, 'results');
  mkdirSync(results);
  for (const f of ['CR-01-fixer-1.json', 'CR-01-fixer-2.json', 'BUG-01-fixer-1.json', 'TASK-02-fixer-1.json', 'BUG-02-fixer-1.json']) {
    writeFileSync(join(results, f), '{}');
  }
  rt.journalObj = { data: { items: {
    'CR-01': { startedAt: 'x', candidate: { fixResultFile: join(results, 'CR-01-fixer-1.json') } },
    'BUG-01': { startedAt: 'x', candidate: { fixResultFile: join(results, 'BUG-01-fixer-1.json') } },
    'TASK-02': { startedAt: 'x', candidate: { fixResultFile: join(results, 'TASK-02-fixer-1.json') } },
    'BUG-02': { startedAt: 'x', endedAt: 'y' } } } };
  const fileOf = key => join(results, `${key}-fixer-2.json`);
  assert.deepEqual(rt.newResults(), [{ key: 'CR-01', fixResultFile: fileOf('CR-01') }]);
  const notice = rt.itemNotice();
  assert.deepEqual(notice.newResults, [{ key: 'CR-01', fixResultFile: fileOf('CR-01') }]);
  assert.equal(notice.newItems, undefined, 'no item waiting to start');
  const tool = { name: 'submit_work', handler: () => ({ status: 'SUBMITTED' }) };
  assert.deepEqual((await callTool(rt, tool, {}, {})).structuredContent.notice.newResults.map(r => r.key), ['CR-01']);
  rt.warnNewResults();
  rt.warnNewResults();
  assert.deepEqual(rt.events.since(0).filter(e => e.type === 'FIX_RESULT').map(e => e.key), ['CR-01']);
  rt.journalObj.data.items['CR-01'].candidate = { fixResultFile: fileOf('CR-01') };
  assert.deepEqual(rt.newResults(), []);
  assert.equal(rt.itemNotice(), null);
});

// FMC0ZXFC: TASK-03 (hạn 8 phút) và TASK-04 chỉ hỏi một giá trị, chờ slot sau 4 item sửa code rồi không bao giờ bắt đầu.
test('answer-only items need no slot, are always offered and go before code items of the same deadline class', () => {
  const desc = { 'TASK-03': '## Question\nWhich value?\n## Normalization\nOne integer.', 'TASK-04': '## Questions\n1. Balance?',
    'CR-03': '## Acceptance criteria\n1. Links work' };
  const rows = [row('BUG-01', 'started'), row('BUG-03', 'started'), row('CR-01', 'started'), row('CR-02', 'started'),
    row('CR-03', 'todo', { points: 100 }), row('TASK-03', 'todo', { points: 50 }), row('TASK-04', 'todo', { points: 70 })];
  const rt = runtime(rows);
  rt.gm.view.items = Object.entries(desc).map(([key, descriptionMd]) => ({ key, raw: { descriptionMd } }));
  const full = rt.itemNotice();
  assert.deepEqual(full.newItems, ['TASK-03', 'TASK-04'], 'no free slot: only the answer-only items');
  assert.deepEqual(full.answerOnly, ['TASK-03', 'TASK-04']);
  assert.equal(full.freeSlots, undefined);
  assert.match(full.hint, /Needs no slot \(PI \/ answer-only\): start TASK-03, TASK-04 now/);
  assert.doesNotMatch(full.hint, /CR-03/);

  // A running answer-only item does not take one of the 4 slots either.
  const running = runtime([row('BUG-01', 'started'), row('BUG-03', 'started'), row('CR-01', 'started'), row('TASK-03', 'started'), row('CR-03', 'todo')]);
  running.gm.view.items = rt.gm.view.items;
  assert.deepEqual(running.itemNotice().newItems, ['CR-03']);

  // Real order: PI, then deadline, then answer-only, then points.
  const ordered = runtime(rows);
  ordered.gm.view.items = rt.gm.view.items;
  delete ordered.matchState;
  ordered.session.descriptor = { matchId: 'M1' };
  ordered.minutesLeft = () => 20;
  ordered.releases = () => [];
  ordered.writer = { state: { bytes: 0, blockers: {} } };
  assert.deepEqual(ordered.matchState().suggestedOrder.filter(k => ['CR-03', 'TASK-03', 'TASK-04'].includes(k)), ['TASK-04', 'TASK-03', 'CR-03']);
});
