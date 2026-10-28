// PI là cuộc đua (Game Rules §6): time box riêng có checkpoint, lượt chờ job trả về sớm khi có PI, mốc ra đề từ README.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, parseReleaseMinutes } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

const near = (iso, ms, slack = 5_000) => assert.ok(Math.abs(Date.parse(iso) - ms) < slack, `${iso} vs ${new Date(ms).toISOString()}`);

test('release minutes come from the match README', () => {
  assert.deepEqual(parseReleaseMinutes('Duration: 40 minutes. Keep exam-info.json unchanged. Answers begin empty; Game Master releases '
    + 'briefs at minutes 0, 14 and 29 and supplies submission templates when each backlog starts.'), [0, 14, 29]);
  assert.deepEqual(parseReleaseMinutes('trận 40 phút; đề mở ở phút 0, 14, 29'), [0, 14, 29]);
  assert.equal(parseReleaseMinutes('Duration: 40 minutes. Submit source changes and answers.'), null);
  assert.equal(parseReleaseMinutes(undefined), null);
});

test('a PI attempt is capped and gets a checkpoint; other items keep the match or deadline time', () => {
  const rt = new Runtime({ teamWorkspace: tempDir('mtm-pi-') });
  let left = 26;
  rt.gm = { itemMinutesLeft: () => left };
  const now = Date.now();
  const pi = rt.timeBox({ key: 'PI-01', deadlineMinutes: null });
  assert.equal(pi.workMinutes, 12);
  near(pi.returnBy, now + 12 * 60_000);
  near(pi.checkpointBy, now + 6 * 60_000);
  const task = rt.timeBox({ key: 'TASK-01', deadlineMinutes: null });
  assert.equal(task.workMinutes, 21);
  assert.equal(task.checkpointBy, undefined);
  left = 8;
  const late = rt.timeBox({ key: 'PI-02', deadlineMinutes: null });
  assert.equal(late.workMinutes, 3);
  near(late.checkpointBy, now + 3 * 60_000);
});

test('a job wait returns early when a PI is released, and at once while one waits to be started', async () => {
  const rt = new Runtime({ teamWorkspace: tempDir('mtm-pi-') });
  let pending = [];
  rt.pendingPI = () => pending;
  const job = rt.jobs.start('run_gate', () => new Promise(resolve => setTimeout(() => resolve({ passed: true }), 2_500)));
  setTimeout(() => rt.events.push('ITEM_NEW', { key: 'BUG-03', itemType: 'BUG' }), 100);   // item khác không cắt lượt chờ
  setTimeout(() => { pending = ['PI-01']; rt.events.push('ITEM_NEW', { key: 'PI-01', itemType: 'PI', type: 'PI' }); }, 300);
  const t0 = Date.now();
  const early = await rt.settleJob(job.id, 10_000);
  assert.deepEqual(early.newPI, ['PI-01']);
  assert.equal(early.state, 'running');
  assert.ok(Date.now() - t0 < 2_000, `${Date.now() - t0} ms`);
  assert.match(early.hint, /start it now/);
  const again = await rt.settleJob(job.id, 10_000);
  assert.deepEqual(again.newPI, ['PI-01'], 'still not started: the wait returns at once');
  pending = [];
  const done = await rt.settleJob(job.id, 10_000);
  assert.equal(done.state, 'done');
  assert.equal(done.newPI, undefined);
  assert.equal(await rt.settleJob('job-missing', 1_000), null);
});

test('event data never overrides the event type', () => {
  const rt = new Runtime({ teamWorkspace: tempDir('mtm-pi-') });
  const e = rt.events.push('ITEM_NEW', { key: 'PI-01', type: 'PI', seq: 99 });
  assert.equal(e.type, 'ITEM_NEW');
  assert.equal(e.seq, 1);
});
