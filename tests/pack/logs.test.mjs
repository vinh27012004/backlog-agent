// Kho log production chung cho PI (match/logs.mjs). OMZJW0S0: search_logs trả tối đa 20 dòng mới nhất mỗi lời gọi,
// không phân trang; fixer PI-02/PI-03 tự chia query (168 và 320 lời gọi) sau khi helper chỉ lấy 20 dòng mỗi service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, sortLog, tsChildren } from '../../pack/src/match/logs.mjs';

// Server giả như Company Tools của trận: query khớp chuỗi con trên cả dòng, trả mới nhất trước, tối đa 20 dòng.
function server(corpus, { cap = 20, order = 'newest', filter = true } = {}) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(args.query);
    const q = String(args.query ?? '').toLowerCase();
    const hit = corpus.filter(e => !filter || JSON.stringify(e).toLowerCase().includes(q));
    const sorted = [...hit].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    if (order === 'oldest') sorted.reverse();
    const entries = sorted.slice(0, cap);
    return { content: [{ type: 'text', text: JSON.stringify({ total: hit.length, returned: entries.length, entries }) }] };
  };
  return { invoke, calls };
}

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function corpus(n, { from = '2025-10-13T00:00:00.000Z', to = '2025-10-19T00:00:00.000Z', service = 'rule-engine', seq0 = 3100000 } = {}) {
  const t0 = Date.parse(from), t1 = Date.parse(to);
  return Array.from({ length: n }, (_, i) => ({ ts: new Date(t0 + Math.floor(rnd() * (t1 - t0))).toISOString(), service, level: 'INFO',
    requestId: `pi-${service}-${i}`, message: 'rule.applied', context: { seq: seq0 + i, txnId: `TX-${String(i % 700).padStart(5, '0')}`, scheduledFor: '2025-11-03' } }));
}

test('ts prefixes split month, ten days, day, ten hours, hour and so on down to milliseconds', () => {
  assert.equal(tsChildren('2025-').length, 12);
  assert.deepEqual(tsChildren('2025-10'), ['2025-10-0', '2025-10-1', '2025-10-2', '2025-10-3']);
  assert.deepEqual(tsChildren('2025-10-3'), ['2025-10-30', '2025-10-31']);
  assert.ok(!tsChildren('2025-10-0').includes('2025-10-00'));
  assert.deepEqual(tsChildren('2025-10-18'), ['2025-10-18T0', '2025-10-18T1', '2025-10-18T2']);
  assert.deepEqual(tsChildren('2025-10-18T2'), ['2025-10-18T20', '2025-10-18T21', '2025-10-18T22', '2025-10-18T23']);
  assert.equal(tsChildren('2025-10-18T22:51:08.46').length, 10);
  assert.deepEqual(tsChildren('2025-10-18T22:51:08.468'), []);
});

test('collects every entry of a log far above the 20-entry cap, sorted by ts then seq, and a refresh of an unchanged log costs one call', async () => {
  const logs = [...corpus(755), ...corpus(697, { from: '2025-11-01T00:00:00.000Z', to: '2025-11-22T00:00:00.000Z', service: 'schedules', seq0: 3101000 }),
    ...corpus(13, { from: '2025-10-14T00:00:00.000Z', to: '2025-11-19T00:00:00.000Z', service: 'deploy', seq0: 3102000 })];
  const s = server(logs);
  const file = join(mkdtempSync(join(tmpdir(), 'logs-')), 'logs.json');
  const store = new LogStore({ invoke: s.invoke, file });
  const snap = await store.refresh();
  assert.equal(snap.complete, true, JSON.stringify({ ...snap, entries: undefined }));
  assert.equal(snap.collected, logs.length);
  assert.equal(snap.total, logs.length);
  assert.deepEqual(snap.services.map(x => [x.service, x.entries]), [['rule-engine', 755], ['schedules', 697], ['deploy', 13]]);
  assert.deepEqual(snap.entries.map(e => e.requestId), sortLog(logs).map(e => e.requestId));
  // Mô phỏng log OMZJW0S0 ~520 lời gọi cho 3.608 dòng; ở đây 1.465 dòng phải dưới 4 lần mức tối thiểu (total/20).
  assert.ok(s.calls.length < 4 * logs.length / 20, `${s.calls.length} calls`);

  s.calls.length = 0;
  const again = await new LogStore({ invoke: s.invoke, file }).refresh();
  assert.equal(again.complete, true);
  assert.deepEqual(s.calls, [''], 'the saved store is reused after a helper restart');

  // Log mới chỉ ở một giờ: làm mới chỉ đi lại nhánh có total đổi.
  logs.push(...corpus(30, { from: '2025-11-21T10:00:00.000Z', to: '2025-11-21T10:59:00.000Z', service: 'web', seq0: 3103000 }));
  s.calls.length = 0;
  const grown = await store.refresh({ priority: 'normal' });
  assert.equal(grown.complete, true);
  assert.equal(grown.collected, logs.length);
  assert.ok(s.calls.length < 60, `incremental refresh took ${s.calls.length} calls`);
});

test('a server that does not filter by query stops the harvest at once instead of splitting forever', async () => {
  const s = server(corpus(100), { filter: false });
  const snap = await new LogStore({ invoke: s.invoke }).refresh();
  assert.equal(snap.complete, false);
  assert.equal(snap.reason, 'unfiltered');
  assert.ok(s.calls.length < 20, `${s.calls.length} calls`);
});

test('a server that returns the oldest entries first still yields the complete log (no skipping on that order)', async () => {
  const logs = corpus(150);
  const s = server(logs, { order: 'oldest' });
  const snap = await new LogStore({ invoke: s.invoke }).refresh();
  assert.equal(snap.complete, true, JSON.stringify({ ...snap, entries: undefined }));
  assert.equal(snap.collected, 150);
});

test('the call budget ends a harvest as incomplete', async () => {
  const s = server(corpus(400));
  const snap = await new LogStore({ invoke: s.invoke, maxCalls: 10 }).refresh();
  assert.equal(snap.complete, false);
  assert.equal(snap.reason, 'budget');
  assert.ok(s.calls.length <= 10);
});
