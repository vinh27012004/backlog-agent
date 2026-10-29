// Chỗ trống cho item mới (ZVUYZ41V: TASK-01 ra lúc 02:49:49, chờ tới 03:02 với 2 item đang chạy vì root không đọc
// sự kiện giữa các wait_agent): mọi kết quả tool của root mang `notice` khi có item chưa bắt đầu mà còn chỗ.
import assert from 'node:assert/strict';
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
