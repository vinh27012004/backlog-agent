// Chỗ trống cho item mới (ZVUYZ41V: TASK-01 ra lúc 02:49:49, chờ tới 03:02 với 2 item đang chạy vì root không đọc
// sự kiện giữa các wait_agent): mọi kết quả tool của root mang `notice` khi có item chưa bắt đầu mà còn chỗ.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime, callTool } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

const row = (key, local, extra = {}) => ({ key, type: key.split('-')[0], status: 'OPEN', local, minutesLeft: 20, ...extra });

function runtime(rows) {
  const rt = new Runtime({ teamWorkspace: tempDir('mtm-slots-') });
  rt.session.phase = 'GAME';
  rt.gm = { view: { items: [] } };
  rt.itemRows = () => rows;
  rt.matchState = () => ({ suggestedOrder: rows.filter(r => r.status !== 'CLOSED' && !['submitted', 'failed'].includes(r.local)).map(r => r.key) });
  return rt;
}

test('notice lists items not started while fewer than 4 items run; PI, closed and late items are left out', () => {
  const rows = [row('CR-01', 'started'), row('TASK-02', 'started'), row('BUG-01', 'submitted'), row('TASK-01', 'todo'),
    row('PI-01', 'todo'), row('BUG-03', 'todo', { status: 'CLOSED' }), row('CR-02', 'todo', { minutesLeft: 3 }), row('BUG-04', 'todo', { minutesLeft: null })];
  const notice = runtime(rows).itemNotice();
  assert.deepEqual(notice.newItems, ['TASK-01', 'BUG-04']);
  assert.equal(notice.freeSlots, 2);
  assert.match(notice.hint, /start TASK-01, BUG-04 now/);
  const full = [row('BUG-01', 'started'), row('BUG-02', 'started'), row('CR-01', 'started'), row('TASK-02', 'started'), row('TASK-01', 'todo')];
  assert.equal(runtime(full).itemNotice(), null, 'no free slot');
  assert.equal(runtime([row('CR-01', 'started'), row('BUG-01', 'published')]).itemNotice(), null, 'nothing waiting');
  const prepare = runtime(rows);
  prepare.session.phase = 'PREPARE';
  assert.equal(prepare.itemNotice(), null);
});

test('root tool results carry the notice; match_state, proxied calls and errors do not', async () => {
  const rt = runtime([row('CR-01', 'started'), row('TASK-01', 'todo')]);
  rt.session.descriptor = { matchId: 'M1' };
  const tool = name => ({ name, handler: () => ({ state: 'done' }) });
  const root = await callTool(rt, tool('job_status'), {}, {});
  assert.deepEqual(root.structuredContent.notice.newItems, ['TASK-01']);
  assert.equal(JSON.parse(root.content[0].text).state, 'done');
  assert.equal((await callTool(rt, tool('match_state'), {}, {})).structuredContent.notice, undefined);
  assert.equal((await callTool(rt, tool('run_gate'), {}, {}, { activity: false })).structuredContent.notice, undefined);
  rt.itemNotice = () => { throw new Error('boom'); };
  assert.equal((await callTool(rt, tool('job_status'), {}, {})).isError, false, 'a broken notice never breaks the tool');
});

// 803P85ZA: cr01_fix2 ghi CR-01-fixer-2.json lúc root đang submit item khác; root không spawn verifier, CR-01 không nộp.
test('the newest fix-result with no gate after it is reported once as FIX_RESULT and in every notice', async () => {
  const rt = runtime([row('CR-01', 'started'), row('BUG-01', 'started'), row('TASK-02', 'started'), row('BUG-02', 'submitted')]);
  const teamWork = tempDir('mtm-ungated-');
  rt.session.paths = { teamWork };
  rt.session.descriptor = { matchId: 'M1' };
  const results = join(teamWork, 'results');
  mkdirSync(results);
  for (const f of ['CR-01-fixer-1.json', 'CR-01-fixer-2.json', 'CR-01-verifier-1.json', 'BUG-01-fixer-1.json', 'TASK-02-fixer-1.json', 'BUG-02-fixer-1.json']) {
    writeFileSync(join(results, f), '{}');
  }
  const later = new Date(Date.now() + 60_000).toISOString();
  rt.journalObj = { data: { items: {
    'CR-01': { startedAt: 'x', proxiedGates: { 'CR-01-fixer-1.json': 'job-9-run_gate' } },
    'BUG-01': { startedAt: 'x', proxiedGates: { 'BUG-01-fixer-1.json': 'job-3-run_gate' } },
    'TASK-02': { startedAt: 'x', jobs: [{ id: 'job-5-run_gate', kind: 'run_gate', startedAt: later }] },   // root gated it itself
    'BUG-02': { startedAt: 'x', endedAt: 'y' } } } };
  const fileOf = key => join(results, `${key}-fixer-2.json`);
  assert.deepEqual(rt.ungatedResults(), [{ key: 'CR-01', fixResultFile: fileOf('CR-01') }]);
  const notice = rt.itemNotice();
  assert.deepEqual(notice.ungated, [{ key: 'CR-01', fixResultFile: fileOf('CR-01') }]);
  assert.equal(notice.newItems, undefined, 'no item waiting to start');
  const tool = { name: 'submit_work', handler: () => ({ status: 'SUBMITTED' }) };
  assert.deepEqual((await callTool(rt, tool, {}, {})).structuredContent.notice.ungated.map(r => r.key), ['CR-01']);
  rt.warnUngated();
  rt.warnUngated();
  assert.deepEqual(rt.events.since(0).filter(e => e.type === 'FIX_RESULT').map(e => e.key), ['CR-01']);
  rt.journalObj.data.items['CR-01'].proxiedGates['CR-01-fixer-2.json'] = 'job-12-run_gate';
  assert.deepEqual(rt.ungatedResults(), []);
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
  assert.match(full.hint, /Answer-only, needs no slot: start TASK-03, TASK-04 now/);
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
