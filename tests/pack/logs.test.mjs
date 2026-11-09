// Kho log production chung cho PI (match/logs.mjs). OMZJW0S0: search_logs trả tối đa 20 dòng mới nhất mỗi lời gọi,
// không phân trang; fixer PI-02/PI-03 tự chia query (168 và 320 lời gọi) sau khi helper chỉ lấy 20 dòng mỗi service.
// 85WTXFLQ: bản gom theo tiền tố ts dừng ở `unfiltered` sau 13 lời gọi, vì server khớp từ nguyên vẹn, không khớp chuỗi con.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, hourWords, matchesQuery, sortLog, words } from '../../pack/src/match/logs.mjs';

// Server giả như Company Tools của trận: mọi từ của query phải là một từ nguyên vẹn của dòng (tách ở ký tự không phải
// chữ/số), service lọc đúng tên, trả mới nhất trước, tối đa 20 dòng, kèm total.
function server(corpus, { cap = 20, order = 'newest', filter = true } = {}) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(args);
    const want = words(args.query ?? '');
    const hit = corpus.filter(e => (!args.service || e.service === args.service)
      && (!filter || want.every(w => words(JSON.stringify(e)).includes(w))));
    const sorted = [...hit].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    if (order === 'oldest') sorted.reverse();
    const entries = sorted.slice(0, cap);
    return { content: [{ type: 'text', text: JSON.stringify({ total: hit.length, returned: entries.length, entries }) }] };
  };
  return { invoke, calls };
}

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
let seq = 3100000;
// Dòng giống log thật: release 2025.10.x / 2025.11.x (từ 10, 11 xuất hiện ngoài ts), customerId, durationMs.
function corpus(n, { from = '2025-10-13T00:00:00.000Z', to = '2025-11-22T00:00:00.000Z', service = 'rule-engine' } = {}) {
  const t0 = Date.parse(from), t1 = Date.parse(to);
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(t0 + Math.floor(rnd() * (t1 - t0))).toISOString();
    return { ts, service, level: rnd() < 0.9 ? 'INFO' : 'WARN', requestId: `req-${Math.floor(rnd() * 1e9).toString(36)}`, message: 'rule.applied',
      context: { customerId: `CUST-${String(Math.floor(rnd() * 500)).padStart(4, '0')}`, durationMs: Math.floor(rnd() * 1000),
        release: `2025.${rnd() < 0.5 ? 10 : 11}.${Math.floor(rnd() * 10)}`, seq: seq++ } };
  });
}

test('query words are whole words: a full hour selects that hour, a date alone does not select its day', () => {
  const e = { ts: '2025-10-18T22:51:08.468Z', service: 'rules', context: { release: '2025.11.2' } };
  assert.deepEqual(words('2025-10-18T22'), ['2025', '10', '18t22']);
  assert.equal(matchesQuery(e, '2025-10-18T22'), true);
  assert.equal(matchesQuery(e, '18t22 51'), true);
  assert.equal(matchesQuery(e, '2025-10-18'), false, 'the day and hour form one word, 18t22');
  assert.equal(matchesQuery(e, '2025-10-1'), false);
  assert.equal(matchesQuery(e, '2025 11'), true, 'month 11 comes from the release, not from ts');
});

test('hour words cover every day and hour once, starting at the newest entry and going back', () => {
  const all = hourWords('2025-11-21T22:56:10.629Z');
  assert.equal(all.length, 744);
  assert.equal(new Set(all).size, 744);
  assert.deepEqual(all.slice(0, 3), ['21t22', '21t21', '21t20']);
  assert.equal(all.at(-1), '21t23');
  assert.equal(hourWords('')[0], '31t23');
});

test('collects every entry of a 4,000-line log in under 900 calls, splitting busy hours by service and minute', async () => {
  seq = 3100000;
  const logs = [...corpus(755), ...corpus(697, { from: '2025-11-01T00:00:00.000Z', service: 'schedules' }),
    ...corpus(13, { from: '2025-10-14T00:00:00.000Z', to: '2025-11-19T00:00:00.000Z', service: 'deploy' }),
    ...corpus(441, { service: 'import' }), ...corpus(408, { service: 'web' }), ...corpus(296, { service: 'rules' }),
    ...corpus(700, { service: 'api-gateway' }), ...corpus(700, { service: 'sync-server' }),
    // Giờ có sự cố: nhiều service trong một giờ, và một service riêng quá 20 dòng trong giờ đó.
    ...corpus(15, { from: '2025-10-15T08:00:00.000Z', to: '2025-10-15T08:59:59.000Z', service: 'deploy' }),
    ...corpus(45, { from: '2025-10-15T08:00:00.000Z', to: '2025-10-15T08:59:59.000Z', service: 'rule-engine' })];
  const s = server(logs);
  const file = join(mkdtempSync(join(tmpdir(), 'logs-')), 'logs.json');
  const store = new LogStore({ invoke: s.invoke, file });
  const snap = await store.refresh();
  assert.equal(snap.complete, true, JSON.stringify({ ...snap, entries: undefined }));
  assert.equal(snap.collected, logs.length);
  assert.equal(snap.total, logs.length);
  assert.deepEqual(snap.entries.map(e => e.context.seq), sortLog(logs).map(e => e.context.seq));
  assert.ok(s.calls.length < 900, `${s.calls.length} calls`);
  assert.ok(s.calls.some(a => a.service === 'rule-engine' && a.query === '15t08'), 'the busy hour is split by service');
  assert.ok(s.calls.some(a => a.service === 'rule-engine' && /^15t08 \d\d$/.test(a.query)), 'and the busy service by minute');

  s.calls.length = 0;
  const again = await new LogStore({ invoke: s.invoke, file }).refresh();
  assert.equal(again.complete, true);
  assert.deepEqual(s.calls, [{ query: '' }], 'the saved store is reused after a helper restart');
});

test('a short log stops as soon as every entry is in, without walking all 744 hours', async () => {
  seq = 3200000;
  const logs = corpus(60, { from: '2025-11-21T00:00:00.000Z', to: '2025-11-21T23:00:00.000Z' });
  const s = server(logs);
  const snap = await new LogStore({ invoke: s.invoke }).refresh();
  assert.equal(snap.complete, true, JSON.stringify({ ...snap, entries: undefined }));
  assert.ok(s.calls.length < 60, `${s.calls.length} calls`);
});

test('a server that does not filter by query stops the harvest at once instead of splitting forever', async () => {
  const s = server(corpus(100), { filter: false });
  const snap = await new LogStore({ invoke: s.invoke }).refresh();
  assert.equal(snap.complete, false);
  assert.equal(snap.reason, 'unfiltered');
  assert.ok(s.calls.length < 20, `${s.calls.length} calls`);
});

test('a server that returns the oldest entries first still yields the complete log', async () => {
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
