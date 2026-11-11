// Company Tools: server giới hạn mỗi API key 120 request/phút và burst 20 request/10 giây (LXRMBRA2: helper chỉ giữ
// cửa sổ 60 s nên job tra log hàng loạt bắn liền tới 100 request). HTTP giả, cửa sổ rút ngắn để test chạy nhanh.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANY_LIMITS, CompanyTools, companyLimits } from '../../pack/src/match/company.mjs';

function fakeCompany({ limits, statuses = [] } = {}) {
  const sent = [];
  const http = {
    async request(url, { body }) {
      const msg = JSON.parse(body);
      sent.push({ at: Date.now(), method: msg.method, query: msg.params?.arguments?.query ?? null });
      const status = msg.method === 'tools/call' && statuses.length ? statuses.shift() : 200;
      const headers = new Headers(status === 429 ? { 'retry-after': '0.1' } : {});
      if (status === 429) return { status, headers, json: null, text: '' };
      return { status, headers, json: { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [] } } };
    }
  };
  const session = { secrets: { apiKey: 'k' }, gameMasterOrigin: 'https://gm.test', descriptor: { matchId: 'M1' } };
  return { company: new CompanyTools({ session, http, ...(limits ? { limits } : {}) }), sent };
}

test('the default limits stay under 20 requests per 10 s and 120 per minute; runtime.json may override them', () => {
  assert.deepEqual(COMPANY_LIMITS, [[10_000, 18], [60_000, 110]]);
  assert.deepEqual(companyLimits(undefined), COMPANY_LIMITS);
  assert.deepEqual(companyLimits([[10_000, 55], [60_000, 110]]), [[10_000, 55], [60_000, 110]]);
  for (const bad of [[], [[10, 5]], [[10_000, 0]], [[10_000, 2.5]], 'fast', [[10_000, 55, 1]]]) assert.deepEqual(companyLimits(bad), COMPANY_LIMITS, JSON.stringify(bad));
});

test('every window holds: a burst waits for the short window, then the long one', async () => {
  const { company, sent } = fakeCompany({ limits: [[300, 3], [1500, 5]] });
  await company.ensureInitialized();          // 2 request (initialize + notify)
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => company.invoke('search_logs', { query: `q${i}` })));
  const at = sent.filter(s => s.method === 'tools/call').map(s => s.at - t0);
  const all = sent.map(s => s.at);
  for (let i = 0; i < all.length; i++) {
    assert.ok(all.filter(t => t >= all[i] && t < all[i] + 300).length <= 3, `short window at ${i}`);
    assert.ok(all.filter(t => t >= all[i] && t < all[i] + 1500).length <= 5, `long window at ${i}`);
  }
  assert.ok(at[5] >= 1400, `the sixth call waited for the long window (${at})`);
  assert.equal(company.stats.requests, 8);
  assert.ok(company.stats.throttledMs > 0);
});

// QDO8W480: 341 lời gọi của PI-03 chia băng thông với 1015 lời gọi của PI-02 (588 s thay vì khoảng 200 s).
test('a waiting call of a smaller lookup goes before the calls of a larger one; single calls go first', async () => {
  const { company, sent } = fakeCompany({ limits: [[300, 2]] });
  await company.ensureInitialized();
  const big = Array.from({ length: 4 }, (_, i) => company.invoke('search_logs', { query: `big${i}` }, { weight: 1000 }));
  const small = Array.from({ length: 2 }, (_, i) => company.invoke('search_logs', { query: `small${i}` }, { weight: 300 }));
  const single = company.invoke('kb_search', { query: 'single' });
  await Promise.all([...big, ...small, single]);
  const order = sent.filter(s => s.method === 'tools/call').map(s => s.query.replace(/\d+$/, ''));
  assert.deepEqual(order, ['single', 'small', 'small', 'big', 'big', 'big', 'big']);
  assert.equal(company.waiting.length, 0);
  assert.equal(company.ratePerMinute(), 400);
  assert.equal(new CompanyTools({ session: {}, http: {} }).ratePerMinute(), 108);
});

test('HTTP 429 waits for Retry-After and sends again; a third refusal is an error', async () => {
  const ok = fakeCompany({ statuses: [429, 200] });
  const t0 = Date.now();
  assert.deepEqual(await ok.company.invoke('search_logs', { query: 'x' }), { content: [] });
  assert.ok(Date.now() - t0 >= 100);
  assert.equal(ok.company.stats.rejected429, 1);
  const bad = fakeCompany({ statuses: [429, 429, 429] });
  await assert.rejects(bad.company.invoke('search_logs', { query: 'x' }), /COMPANY_RATE_LIMITED/);
});
