// Tra log production hàng loạt cho PI (company_lookup {name: "search_logs", queries, hours}).
//
// search_logs: tham số `service` (lọc đúng một service) và `query` (các từ phải có đủ trong dòng); mỗi lời gọi trả tối
// đa 20 dòng MỚI NHẤT kèm `total`, không có limit/offset/pageSize. Dòng log (cả tên trường) và query đều được viết
// thường rồi cắt thành từ ở mọi ký tự không phải chữ/số; mỗi từ của query phải trùng nguyên vẹn một từ của dòng.
// ts 2025-10-18T22:51:08.468Z cho các từ 2025, 10, 18t22, 51, 08, 468z: `2025-10-18T22` chọn một giờ (ở mọi tháng có
// ngày 18), `2025-10-18` không chọn ngày (18 khớp mọi số 18), không có wildcard. Kiểm trên các lời gọi thật của
// OMZJW0S0/QDYZMY1K (`2025-10-18` → 20 dòng rải 13–18/10, `TX-007*` → 0, `txnId` → 755 dòng có trường đó).
//
// QDYZMY1K: fixer PI-02 thử limit/pageSize/take, hỏi root schema ở giây 367, rồi tự lặp 716 truy vấn TX-xxxx; PI-03
// hỏi root ở giây 357, lặp 320 truy vấn SCH-xxxx và hết 12 phút trước khi sửa source. Tra hàng loạt: một lời gọi nhận cả
// danh sách truy vấn (và/hoặc khung giờ), helper gọi song song, chia nhỏ phần chưa đủ, gộp thành một file đã sắp xếp
// và nói rõ đủ hay thiếu.

const CONCURRENCY = 8;
const MAX_CALLS = 2500;
const pad = n => String(n).padStart(2, '0');

export const words = s => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function matchesQuery(entry, query) {
  const have = new Set(words(JSON.stringify(entry)));
  return words(query).every(w => have.has(w));
}

// {total, returned, entries} của một kết quả search_logs, null khi không đọc được.
export function logPage(result) {
  if (!result || result.isError) return null;
  const norm = v => (v && Array.isArray(v.entries)
    ? { total: Number(v.total ?? v.entries.length), returned: Number(v.returned ?? v.entries.length), entries: v.entries } : null);
  if (norm(result.structuredContent)) return norm(result.structuredContent);
  for (const c of result.content ?? []) {
    try { const v = norm(JSON.parse(c.text)); if (v) return v; } catch { /* không phải JSON */ }
  }
  return null;
}

const tsOf = e => Date.parse(e?.ts ?? e?.timestamp ?? '');
const seqOf = e => Number(e?.context?.seq ?? e?.seq ?? 0);
const keyOf = e => (seqOf(e) ? `seq:${seqOf(e)}` : JSON.stringify(e));
export const sortLog = entries => [...entries].sort((a, b) => ((tsOf(a) || 0) - (tsOf(b) || 0)) || (seqOf(a) - seqOf(b)));

// Khung giờ "2025-10-15T08" .. "2025-11-03T09" (hai đầu tính cả giờ đó) → các từ giờ DDtHH (một từ phủ cùng ngày-giờ ở
// mọi tháng, nên dòng trả về được lọc lại theo ts) và khoảng thời gian thật.
export function hourWindow(hours) {
  const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(String(s ?? '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : NaN; };
  const from = parse(hours?.from), to = parse(hours?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const list = [];
  for (let t = from; t <= to && list.length < 2000; t += 3_600_000) {
    const d = new Date(t), w = `${pad(d.getUTCDate())}t${pad(d.getUTCHours())}`;
    if (!list.includes(w)) list.push(w);
  }
  return { words: list, start: from, end: to + 3_600_000 };
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve } = queue.shift();
    fn().then(resolve, () => resolve(null)).finally(() => { active--; next(); });
  };
  return fn => new Promise(resolve => { queue.push({ fn, resolve }); next(); });
}

const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

// queries: [{service?, query?}]; hours: {from, to} (mỗi truy vấn × mỗi giờ trong khung). invoke(args) gọi search_logs.
// Trả {calls, entries (đã sắp), complete, incomplete: [{service, query, total, got}], window}.
// extend: false khi id lấy từ danh mục của test data (catalogue), không mở rộng dải id. onMain(kết quả): gọi khi mọi truy
// vấn được hỏi đã xong, trước phần mở rộng, để kết quả tới tay thợ sớm (DVVFEPXF PI-03: 322 truy vấn xong, rồi 126 id
// ngoài danh mục được tra tuần tự, kết quả chỉ có sau 262 s; item đóng khi chưa nộp).
export async function bulkSearch({ invoke, queries, hours = null, concurrency = CONCURRENCY, maxCalls = MAX_CALLS, onProgress = null, extend = true, onMain = null }) {
  const base = (Array.isArray(queries) && queries.length ? queries : [{}]).map(q => ({
    ...(typeof q?.service === 'string' && q.service ? { service: q.service } : {}),
    query: typeof q?.query === 'string' ? q.query.trim() : '' }));
  const window = hours ? hourWindow(hours) : null;
  if (hours && !window) throw Object.assign(new Error('hours must be {from: "YYYY-MM-DDTHH", to: "YYYY-MM-DDTHH"} with from <= to'), { code: 'INVALID_ARGUMENT' });
  const plan = window ? base.flatMap(q => window.words.map(w => ({ ...q, query: `${q.query} ${w}`.trim(), hour: w }))) : base;
  if (plan.length > maxCalls) throw Object.assign(new Error(`${plan.length} queries exceed ${maxCalls}: narrow the window or the list`), { code: 'INVALID_ARGUMENT' });
  const gate = limiter(concurrency);
  const found = new Map(), incomplete = [];
  let calls = 0, stopped = null;
  const inWindow = e => !window || (tsOf(e) >= window.start && tsOf(e) < window.end);
  const ask = async args => {
    // Lỗi (giới hạn tốc độ của Company Tools, mạng): thử lại tới 3 lần, lùi 1–2–4 s.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (calls >= maxCalls) { stopped ??= 'budget'; return null; }
      calls++;
      const page = await gate(() => invoke({ ...(args.service ? { service: args.service } : {}), query: args.query }).then(logPage));
      if (page) return page;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
    return null;
  };
  const keep = page => { for (const e of page.entries) if (inWindow(e)) found.set(keyOf(e), e); };
  let done = 0;
  await Promise.all(plan.map(async q => {
    const page = await ask(q);
    if (!page) { incomplete.push({ ...describe1(q), total: null, got: 0, reason: 'call failed' }); return; }
    keep(page);
    if (page.total > page.entries.length) {
      // Giờ quá 20 dòng: chia theo từ phút (từ phút có thể khớp giây/mili giây khác, nên hợp các nhánh là tập trên, rồi
      // khử trùng). Truy vấn không theo giờ thì báo thiếu để fixer thêm khung giờ hay từ lọc.
      if (!q.hour) { incomplete.push({ ...describe1(q), total: page.total, got: page.entries.length, reason: 'more than 20 matches: add hours or narrower words' }); return; }
      const subs = await Promise.all(MINUTES.map(m => ask({ ...q, query: `${q.query} ${m}` })));
      for (const s of subs) if (s) keep(s);
      // Đủ khi số dòng khác nhau đã thấy khớp truy vấn của giờ (kể cả ngoài khung, vì total đếm cả chúng) bằng total.
      // Một nhánh phút vẫn quá 20 không có nghĩa là thiếu: từ phút trùng số tháng (10, 11) khớp mọi dòng của tháng,
      // còn các dòng đó đã tới qua từ phút thật của chúng.
      const seen = new Map();
      for (const p of [page, ...subs]) for (const e of p?.entries ?? []) if ((!q.service || e.service === q.service) && matchesQuery(e, q.query)) seen.set(keyOf(e), e);
      if (seen.size < page.total) {
        const over = subs.filter(s => s && s.total > s.entries.length).length, failed = subs.filter(s => !s).length;
        incomplete.push({ ...describe1(q), total: page.total, got: seen.size,
          reason: `${page.total - seen.size} entr${page.total - seen.size === 1 ? 'y' : 'ies'} of this hour not reached by minute words (${over} minute split(s) still over 20, ${failed} failed): add a service filter, message words or ids` });
      }
    }
    done++;
    if (onProgress && done % 50 === 0) onProgress({ done, of: plan.length, calls, entries: found.size });
  }));
  // Dãy id liên tiếp (SCH-1001..SCH-1050) do thợ tự đoán điểm đầu và cuối: tra tiếp ra hai phía tới khi gặp
  // EXTEND_EMPTY id liền không có dòng nào. QDO8W480 PI-04: danh mục có 70 schedule (SCH-1001..1070), thợ tra 50 id,
  // kết quả ghi complete:true và ba trường báo cáo tính từ 189/645 dòng của tháng 12 đều sai (45 điểm).
  const extended = [];
  const runs = !window && !stopped && extend ? idRuns(base) : [];
  if (onMain) {
    try { await onMain({ calls, entries: sortLog(found.values()), complete: !incomplete.length && !stopped, incomplete: incomplete.slice(0, 50), incompleteCount: incomplete.length, extending: runs.length > 0 }); } catch { /* chỉ để báo sớm */ }
  }
  for (const run of runs) {
    const row = { ...(run.service ? { service: run.service } : {}), prefix: run.prefix, asked: [run.format(run.min), run.format(run.max)], added: [] };
    for (const step of [1, -1]) {
      // Tra theo lô song song (qua limiter), dừng khi gặp EXTEND_EMPTY id liền không có dòng nào. Lô đầu EXTEND_EMPTY id (dải
      // đã hết thì không tốn thêm lời gọi nào), cả lô có dòng thì nhân đôi tới EXTEND_BATCH.
      let empty = 0, n = (step > 0 ? run.max : run.min) + step, tried = 0, size = EXTEND_EMPTY;
      while (n >= 0 && empty < EXTEND_EMPTY && tried < EXTEND_MAX && !stopped) {
        const batch = [];
        for (let i = 0; i < size && n >= 0 && tried < EXTEND_MAX; i++, n += step, tried++) batch.push({ ...(run.service ? { service: run.service } : {}), query: run.format(n) });
        const pages = await Promise.all(batch.map(q => ask(q)));
        for (const [i, page] of pages.entries()) {
          if (empty >= EXTEND_EMPTY) break;
          const q = batch[i];
          if (!page) { incomplete.push({ ...describe1(q), total: null, got: 0, reason: 'call failed' }); empty = EXTEND_EMPTY; break; }
          if (!page.total) { empty++; continue; }
          empty = 0; keep(page); row.added.push(q.query);
          if (page.total > page.entries.length) incomplete.push({ ...describe1(q), total: page.total, got: page.entries.length, reason: 'more than 20 matches: add hours or narrower words' });
        }
        if (pages.every(p => p?.total)) size = Math.min(EXTEND_BATCH, size * 2);
      }
    }
    if (row.added.length) extended.push({ ...row, added: row.added.sort() });
  }
  // Mỗi service có dòng trong kết quả: đã lấy bao nhiêu trên tổng số dòng của service (một lời gọi mỗi service).
  const coverage = [];
  const services = [...new Set([...base.map(q => q.service), ...[...found.values()].map(e => e?.service)].filter(s => typeof s === 'string' && s))].slice(0, 12);
  for (const service of services) {
    if (stopped) break;
    const page = await ask({ service, query: '' });
    if (page) coverage.push({ service, fetched: [...found.values()].filter(e => e?.service === service).length, total: page.total });
  }
  return { calls, entries: sortLog(found.values()), complete: !incomplete.length && !stopped, incomplete: incomplete.slice(0, 50),
    ...(extended.length ? { extended } : {}), ...(coverage.length ? { coverage } : {}),
    incompleteCount: incomplete.length, ...(stopped ? { stopped } : {}), ...(window ? { window: { from: hours.from, to: hours.to, hourWords: window.words.length } } : {}) };
}
// Số lời gọi tối thiểu của một lần tra (mỗi truy vấn × mỗi giờ của khung; chưa tính phần chia theo phút).
export function planSize({ queries, hours = null }) {
  const n = Array.isArray(queries) && queries.length ? queries.length : 1;
  return n * (hours ? hourWindow(hours)?.words.length ?? 1 : 1);
}
// Các dãy id liên tiếp trong danh sách truy vấn: cùng service, cùng tiền tố, từ 5 id số liền nhau trở lên.
const EXTEND_EMPTY = 3, EXTEND_MAX = 300, EXTEND_BATCH = 16;
export function idRuns(queries) {
  const groups = new Map();
  for (const q of queries) {
    const m = /^([A-Za-z][A-Za-z0-9]*[-_])(\d{1,9})$/.exec(q.query ?? '');
    if (!m) continue;
    const key = `${q.service ?? ''}|${m[1]}|${m[2].length}`;
    const g = groups.get(key) ?? { service: q.service ?? null, prefix: m[1], width: m[2].length, nums: new Set() };
    g.nums.add(Number(m[2])); groups.set(key, g);
  }
  return [...groups.values()].filter(g => g.nums.size >= 5 && Math.max(...g.nums) - Math.min(...g.nums) + 1 === g.nums.size)
    .map(g => ({ service: g.service, prefix: g.prefix, min: Math.min(...g.nums), max: Math.max(...g.nums),
      format: n => `${g.prefix}${String(n).padStart(g.width, '0')}` }));
}
const describe1 = q => ({ ...(q.service ? { service: q.service } : {}), query: q.query });

// Đoạn hướng dẫn trong brief PI: schema thật của tool (từ company_tools) và cách tra cho đủ.
export function searchLogsHelp(inputSchema) {
  const props = inputSchema?.properties ? JSON.stringify(inputSchema.properties) : '{"service": string, "query": string}';
  return [
    `search_logs input: ${props}. There is no paging: limit, pageSize, take or maxResults are refused or ignored. Each call returns at most 20 entries, NEWEST first, with total (all matches).`,
    'Matching: the entry (field names included) and the query are lower-cased and split into words at every non-letter/digit; every query word must equal a whole word of the entry (AND, any order, no wildcard). ts 2025-10-18T22:51:08.468Z gives the words 2025, 10, 18t22, 51, 08, 468z: query 2025-10-18T22 selects that hour (in every month that has a day 18), 2025-10-18 never selects a day (18 matches any 18), 2025.10.3 matches any entry with the words 2025, 10 and 3, TX-007* matches nothing. Good filters: message words (applied, posted), ids (TX-00282, SCH-0103), hour words (18t22), seq numbers, field names (txnId).',
    'Fetch in bulk, never in your own loops: company_lookup {name: "search_logs", backlogItemKey, queries: [{service, query}, ...] (up to 2500, build the list in code, e.g. every TX-00001..TX-00716 or SCH-0001..SCH-0320), hours: {from: "2025-10-15T08", to: "2025-11-03T09"} (optional: each query once per hour in that window, entries outside it dropped)}. The helper runs them in parallel, splits an hour with more than 20 matches by minute, and saves ONE file (savedTo) with every entry once, sorted by ts then context.seq, plus complete:true or the list of incomplete queries. It answers within about 100 s or returns a jobId: job_status {jobId, waitSeconds: 110}. Company Tools allow the whole team about 100 calls a minute, so 300 calls take 3 minutes: a lookup that cannot finish before your return_by is refused at once with the number of calls that still fit. An hours window costs one call per query per hour (a full month is 744 for ONE query): use it only for a window of a few hours or days; otherwise list ids (the first 20 entries of a service show its id fields) and message words. Shorter lookups run first, and single lookups are never held up by a bulk one.',
    'Compute the answers with a script over that file (never by reading entries), and only from complete data: complete:false means the counts are lower bounds, say so and add the missing queries.',
    'complete:true only says every query you sent returned all of its matches. It says nothing about entries your queries never asked for. Take id lists from the catalogue in the test data (get_test_data), not from a guessed range: every id of the catalogue, plus the services the incident rules name (deploy, support, removals), and pass catalogue: true so the helper does not look past it (ids outside the catalogue are noise the rules do not count). Without catalogue: true the helper extends a consecutive id range past both ends while ids still have entries (extended) and reports per service how many entries you fetched out of its total (coverage): when a service the rules count is far from covered, find what is missing before you answer.',
  ].join('\n');
}
