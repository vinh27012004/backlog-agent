// Tra log hàng loạt cho PI (QDYZMY1K: fixer PI-02/PI-03 thử limit/pageSize/take, hỏi root schema, tự lặp hàng trăm
// truy vấn). Server giả theo đúng ngữ nghĩa search_logs: từ nguyên vẹn, mới nhất trước, tối đa 20 dòng, kèm total.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkSearch, hourWindow, idRuns, matchesQuery, searchLogsHelp, words } from '../../pack/src/match/logs.mjs';

const pad = n => String(n).padStart(2, '0');
let seq = 3100000;
const entry = (ts, service, message, context = {}) => ({ ts, service, level: 'INFO', message, context: { ...context, seq: ++seq } });
// 30 schedule.posted cho SCH-0001..0030 rải nhiều ngày; giờ 2025-10-15T08 có 45 dòng rule-engine (quá 20).
const data = [
  ...Array.from({ length: 30 }, (_, i) => entry(`2025-11-${pad(1 + (i % 20))}T${pad(i % 24)}:0${i % 10}:00.000Z`, 'schedules', 'schedule.posted', { scheduleId: `SCH-${String(i + 1).padStart(4, '0')}` })),
  // Phút 12..56: không phút nào trùng số tháng (10), nên chia theo từ phút tách được.
  ...Array.from({ length: 45 }, (_, i) => entry(`2025-10-15T08:${pad(i + 12)}:${pad((i * 7) % 60)}.000Z`, 'rule-engine', 'rule.applied', { txnId: `TX-${String(i + 1).padStart(5, '0')}` })),
  ...Array.from({ length: 5 }, (_, i) => entry(`2025-10-16T0${i}:10:00.000Z`, 'rule-engine', 'rule.applied', { txnId: `TX-${String(100 + i).padStart(5, '0')}` })),
];
function server({ failFirst = 0 } = {}) {
  let calls = 0, failures = failFirst;
  const invoke = async args => {
    calls++;
    if (failures > 0) { failures--; return { isError: true, content: [{ type: 'text', text: 'rate limited' }] }; }
    const hits = data.filter(e => (!args.service || e.service === args.service) && matchesQuery(e, args.query ?? '')).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return { content: [{ type: 'text', text: JSON.stringify({ total: hits.length, returned: Math.min(20, hits.length), entries: hits.slice(0, 20) }) }] };
  };
  return { invoke, count: () => calls };
}

test('search_logs words: lower case, split at every non-letter/digit, field names included', () => {
  assert.deepEqual(words('2025-10-18T22:51:08.468Z'), ['2025', '10', '18t22', '51', '08', '468z']);
  assert.ok(matchesQuery(data[0], 'SCH-0001'));
  assert.ok(matchesQuery(data[0], 'scheduleId'));
  assert.ok(!matchesQuery(data[0], 'SCH-000*'.replace('*', '9999')));
  assert.deepEqual(hourWindow({ from: '2025-10-15T08', to: '2025-10-15T10' }).words, ['15t08', '15t09', '15t10']);
  assert.equal(hourWindow({ from: '2025-10-15T10', to: '2025-10-15T08' }), null);
});

test('bulk ids return every entry once, sorted by ts then seq, and say the data is complete', async () => {
  const s = server();
  const queries = Array.from({ length: 30 }, (_, i) => ({ service: 'schedules', query: `SCH-${String(i + 1).padStart(4, '0')}` }));
  const r = await bulkSearch({ invoke: s.invoke, queries });
  assert.equal(r.entries.length, 30);
  assert.equal(r.complete, true);
  assert.equal(r.calls, 35, '30 ids, 3 empty ids above, SCH-0000 below, one coverage call');
  assert.equal(r.extended, undefined, 'the range was already whole');
  assert.deepEqual(r.coverage, [{ service: 'schedules', fetched: 30, total: 30 }]);
  assert.deepEqual(r.entries.map(e => e.ts), [...r.entries.map(e => e.ts)].sort());
});

test('an hours window splits a busy hour by minute and drops entries outside the window; an unwindowed query over 20 is reported incomplete', async () => {
  const s = server();
  const r = await bulkSearch({ invoke: s.invoke, queries: [{ service: 'rule-engine' }], hours: { from: '2025-10-15T08', to: '2025-10-15T08' } });
  assert.equal(r.entries.length, 45, 'every entry of the busy hour');
  assert.ok(r.entries.every(e => e.ts.startsWith('2025-10-15T08')));
  assert.equal(r.complete, true);
  const wide = await bulkSearch({ invoke: s.invoke, queries: [{ service: 'rule-engine', query: 'applied' }] });
  assert.equal(wide.complete, false);
  assert.equal(wide.entries.length, 20);
  assert.match(wide.incomplete[0].reason, /more than 20 matches/);
  assert.equal(wide.incomplete[0].total, 50);
});

// Phút và giây trùng số tháng (09:10:10 tháng 10): từ 10 có trong mọi dòng của tháng nên không tách được bằng ts. Tool
// phải báo thiếu (để fixer thêm id hay từ lọc), không được im lặng coi là đủ.
test('a minute word that equals the month number cannot split the hour, and the lookup says so', async () => {
  // Cùng 09:10:10, chỉ khác mili giây: mọi từ thời gian ngắn đều là 10 (trùng tháng), không nhánh nào tách được.
  const busy = Array.from({ length: 25 }, (_, i) => entry(`2025-10-20T09:10:10.${String(100 + i)}Z`, 'rule-engine', 'rule.applied'));
  const invoke = async args => {
    const hits = busy.filter(e => matchesQuery(e, args.query ?? '')).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return { content: [{ type: 'text', text: JSON.stringify({ total: hits.length, returned: Math.min(20, hits.length), entries: hits.slice(0, 20) }) }] };
  };
  const r = await bulkSearch({ invoke, queries: [{ service: 'rule-engine' }], hours: { from: '2025-10-20T09', to: '2025-10-20T09' } });
  assert.equal(r.complete, false);
  assert.match(r.incomplete[0].reason, /not reached by minute words/);
});

test('a failed call is retried with backoff before the query counts as incomplete', async () => {
  const s = server({ failFirst: 1 });
  const r = await bulkSearch({ invoke: s.invoke, queries: [{ service: 'schedules', query: 'SCH-0001' }] });
  assert.equal(r.entries.length, 1);
  assert.equal(r.complete, true);
  assert.equal(s.count(), 3, 'failed call, retry, coverage');
});

test('the PI brief text carries the real input schema, the matching rule and the bulk call', () => {
  const text = searchLogsHelp({ properties: { query: { type: 'string', maxLength: 500 }, service: { type: 'string' } } });
  assert.match(text, /"maxLength":500/);
  assert.match(text, /2025-10-18 never selects a day/);
  assert.match(text, /company_lookup \{name: "search_logs", backlogItemKey, queries:/);
  assert.match(text, /limit, pageSize, take or maxResults are refused/);
});

// QDO8W480 PI-04: danh mục có 70 schedule, thợ tra SCH-1001..SCH-1050; complete:true, ba trường báo cáo sai.
test('a guessed consecutive id range is extended past both ends while ids still have entries, and coverage shows what is missing', async () => {
  const s = server();
  const queries = Array.from({ length: 12 }, (_, i) => ({ query: `SCH-${String(i + 8).padStart(4, '0')}` }));   // SCH-0008..0019 trong 0001..0030
  const r = await bulkSearch({ invoke: s.invoke, queries });
  assert.equal(r.complete, true);
  assert.equal(r.entries.length, 30, 'every schedule, not only the 12 asked for');
  assert.deepEqual(r.extended.map(x => [x.prefix, x.asked, x.added.length, x.added[0], x.added.at(-1)]), [['SCH-', ['SCH-0008', 'SCH-0019'], 18, 'SCH-0001', 'SCH-0030']]);
  assert.deepEqual(r.coverage, [{ service: 'schedules', fetched: 30, total: 30 }]);
  // Dãy không liền hay dưới 5 id: không đoán thêm; coverage vẫn cho thấy phần thiếu.
  const few = await bulkSearch({ invoke: s.invoke, queries: [{ query: 'SCH-0001' }, { query: 'SCH-0005' }, { query: 'TX-00001' }] });
  assert.equal(few.extended, undefined);
  assert.deepEqual(few.coverage, [{ service: 'schedules', fetched: 2, total: 30 }, { service: 'rule-engine', fetched: 1, total: 50 }]);
  assert.deepEqual(idRuns([{ query: 'A-1' }, { query: 'A-2' }, { query: 'A-3' }, { query: 'A-4' }, { query: 'A-6' }]), []);
  const hours = await bulkSearch({ invoke: s.invoke, queries: [{ service: 'rule-engine' }], hours: { from: '2025-10-16T00', to: '2025-10-16T04' } });
  assert.equal(hours.extended, undefined);
  assert.deepEqual(hours.coverage, [{ service: 'rule-engine', fetched: 5, total: 50 }]);
  assert.match(searchLogsHelp(null), /complete:true only says every query you sent returned all of its matches/);
});
