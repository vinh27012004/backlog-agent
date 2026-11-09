// Kho log production dùng chung cho mọi PI của trận. OMZJW0S0 (05/11): search_logs trả tối đa 20 dòng mỗi lời gọi,
// không limit/offset; helper cũ chỉ lấy 20 dòng đầu của mỗi service đoán được tên (PI-02: 6 service đều 20/N, thiếu
// đúng rule-engine và deploy), nên fixer PI-02 tự chia query theo giờ (168 lời gọi, 93 s, sau một vòng hỏi root) và
// PI-03 theo từng schedule (320 lời gọi, 121 s). Log là kho chung: brief PI-02 lúc 05:00 đã thấy schedules 697 dòng mà
// PI-03 cần 5 phút sau.
//
// Ngữ nghĩa query (mô tả tool: "every word must appear in the entry"; kiểm trên 3.300 lời gọi của OMZJW0S0, 3GW2NNGG,
// 85WTXFLQ): query tách thành từ ở mọi ký tự không phải chữ/số, và mỗi từ phải là một từ nguyên vẹn của dòng log. ts
// `2025-10-18T22:51:08.468Z` cho các từ 2025, 10, 18t22, 51, 08, 468z: không có từ "ngày", ngày và giờ dính nhau. Bản
// trước giả định khớp chuỗi con và chia theo tiền tố ts (năm → tháng → chục ngày → …): `2025-10-1` hay `2025-10-18` không
// bao giờ khớp ts, `2025-10` kéo cả dòng tháng 11 có release 2025.10.x, nên 85WTXFLQ dừng ở `unfiltered` sau 13 lời gọi
// với 20/4.057 dòng và PI-02, PI-03 trả lời trên log thiếu.
//
// Cách gom: lời gọi không lọc cho total; rồi mỗi từ giờ `DDtHH` (31 × 24 = 744, một từ phủ cùng giờ đó ở mọi tháng) một
// lời gọi, dừng khi đã có đủ total dòng. Giờ nào quá 20 dòng thì chia theo service (mỗi dòng đúng một service, tổng các
// nhánh phải bằng total của giờ), rồi theo từ phút, rồi từ giây. Company Tools giới hạn 120 request/phút cho cả đội,
// nên lần gom từ lúc boot chạy ưu tiên thấp (company.mjs) và chỉ lên ưu tiên thường khi một PI đang chờ. Log không đổi
// (total như lần trước, lần trước đủ) thì làm mới chỉ tốn một lời gọi.
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../core/util.mjs';

const CONCURRENCY = 6;
const MAX_CALLS = 1500;

const pad = n => String(n).padStart(2, '0');
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const keyOf = e => JSON.stringify(e);
const tsOf = e => String(e?.ts ?? e?.timestamp ?? '');
const seqOf = e => Number(e?.context?.seq ?? e?.seq);

// Câu hướng dẫn cho brief PI và timeline chưa đủ. 85WTXFLQ: fixer PI-02 hỏi `2025-10-17` (brief cũ bảo query theo
// tiền tố ts) và nhận hai dòng tháng 11 có từ 17 và 10 ở chỗ khác.
export const SEARCH_LOGS_WORDS = 'Every query word must equal a whole word of the entry, words split at every non-letter/digit: ts 2025-10-18T22:51:08.468Z has the words 2025, 10, 18t22, 51, 08, 468z, so 2025-10-18T22 selects that hour but 2025-10-18 never selects that day (query each hour, or ids such as TX-00282).';

// Từ của một chuỗi theo cách server tách query: chữ thường, cắt ở mọi ký tự không phải chữ/số.
export const words = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// Dòng log chứa mọi từ của query (tìm trên cả dòng, kể cả tên trường: chỉ dùng để phát hiện server không lọc).
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

// Từ giờ `DDtHH` của mọi ngày trong tháng, bắt đầu từ giờ của dòng mới nhất rồi lùi dần (timeline tạm có phần mới trước).
export function hourWords(newestTs = '') {
  const all = [];
  for (let d = 31; d >= 1; d--) for (let h = 23; h >= 0; h--) all.push(`${pad(d)}t${pad(h)}`);
  const m = /^\d{4}-\d{2}-(\d{2})T(\d{2})/.exec(newestTs);
  const at = m ? all.indexOf(`${m[1]}t${m[2]}`) : -1;
  return at > 0 ? [...all.slice(at), ...all.slice(0, at)] : all;
}

// Thứ tự log: ts tăng dần, cùng ts thì context.seq.
export function sortLog(entries) {
  const at = e => { const t = Date.parse(tsOf(e)); return Number.isFinite(t) ? t : Infinity; };
  return [...entries].sort((a, b) => (at(a) - at(b)) || ((seqOf(a) || 0) - (seqOf(b) || 0)));
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export class LogStore {
  // invoke(name, args, {priority}) gọi Company Tools; file giữ kho qua lần khởi động lại helper.
  constructor({ invoke, file = null, maxCalls = MAX_CALLS }) {
    this.invoke = invoke;
    this.file = file;
    this.maxCalls = maxCalls;
    this.priority = 'low';
    this.run = null;
    this.data = { at: null, total: null, complete: false, calls: 0, ms: 0, reason: null, entries: [] };
    if (file) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(d.entries)) this.data = { ...this.data, ...d };
      } catch { /* chưa có kho */ }
    }
  }

  // Một lần gom/làm mới tại một thời điểm; gọi lại trong lúc chạy thì nhận chung lời hứa (và nâng ưu tiên nếu cần).
  refresh({ priority = 'low' } = {}) {
    if (priority === 'normal') this.priority = 'normal';
    this.run ??= this.walk().finally(() => { this.run = null; this.priority = 'low'; });
    return this.run;
  }

  get running() { return Boolean(this.run); }

  // Đang gom thì trả phần đã có (chưa đủ), để prepare ghi timeline tạm.
  snapshot() {
    const d = this.data, live = this.run && this.known;
    const entries = live ? sortLog(this.known.values()) : d.entries, services = new Map();
    for (const e of entries) services.set(String(e?.service ?? '?'), (services.get(String(e?.service ?? '?')) ?? 0) + 1);
    return { at: d.at, total: live ? this.liveTotal ?? d.total : d.total, collected: entries.length, complete: live ? false : d.complete,
      reason: live ? 'running' : d.reason, calls: d.calls, ms: d.ms,
      services: [...services].map(([service, n]) => ({ service, entries: n })).sort((a, b) => b.entries - a.entries), entries };
  }

  async walk() {
    const t0 = Date.now(), prev = this.data;
    const known = new Map(prev.entries.map(e => [keyOf(e), e]));
    this.known = known;
    this.liveTotal = null;
    const res = await this.pass(known, prev);
    this.data = { at: new Date().toISOString(), total: res.total, complete: res.complete, calls: res.calls, ms: Date.now() - t0,
      reason: res.complete ? null : res.reason, entries: sortLog(known.values()) };
    this.known = null;
    if (this.file) { try { writeFileAtomic(this.file, `${JSON.stringify(this.data)}\n`); } catch { /* chỉ là cache */ } }
    return this.snapshot();
  }

  async pass(known, prev) {
    let calls = 0, stop = null, target = null;
    const gate = limiter(CONCURRENCY);
    const enough = () => target !== null && known.size >= target;
    const SKIP = Symbol('skip');
    // Kiểm dừng/ngân sách/đã đủ ngay trước khi gọi (trong slot của limiter): 744 nhánh giờ xếp hàng cùng lúc.
    const ask = async args => {
      for (let attempt = 0; ; attempt++) {
        const page = await gate(async () => {
          if (stop || enough()) return SKIP;
          if (calls >= this.maxCalls) { stop ??= 'budget'; return SKIP; }
          calls++;
          return this.invoke('search_logs', args, { priority: this.priority }).then(logPage, () => null);
        });
        if (page === SKIP) return enough() && !stop ? { total: 0, entries: [], skipped: true } : null;
        if (!page) {
          if (attempt < 1) { await new Promise(r => setTimeout(r, 1000)); continue; }
          return null;
        }
        // Server không lọc theo query (dòng trả về thiếu một từ của query) thì chia nhỏ vô ích: dừng.
        if (args.query && page.entries.some(e => !matchesQuery(e, args.query))) { stop ??= 'unfiltered'; return null; }
        for (const e of page.entries) known.set(keyOf(e), e);
        return page;
      }
    };
    const root = await ask({ query: '' });
    if (!root) return { complete: false, total: null, calls, reason: stop ?? 'error' };
    this.liveTotal = root.total;
    target = root.total;
    if (root.total <= root.entries.length || (prev.complete && prev.total === root.total && enough())) {
      return { complete: true, total: root.total, calls, reason: null };
    }

    // true khi đã có mọi dòng khớp `query` (trong `service` nếu có). Quá 20 dòng: chia theo service, phút, giây.
    const node = async (query, level, service = null) => {
      if (enough()) return true;
      const page = await ask(service ? { service, query } : { query });
      if (!page) return false;
      if (page.total <= page.entries.length) return true;
      if (level === 'hour' && !service) {
        const services = [...new Set([...known.values()].map(e => e?.service).filter(s => typeof s === 'string'))];
        const counts = await Promise.all(services.map(async s => ({ s, page: await ask({ service: s, query }) })));
        if (counts.every(c => c.page) && counts.reduce((n, c) => n + c.page.total, 0) === page.total) {
          const parts = await Promise.all(counts.map(c => (c.page.total <= c.page.entries.length ? true : this.split(node, query, 'minute', c.s))));
          return parts.every(Boolean);
        }
      }
      return this.split(node, query, level === 'hour' ? 'minute' : level === 'minute' ? 'second' : null, service);
    };
    const results = await Promise.all(hourWords(tsOf(root.entries[0])).map(h => node(h, 'hour')));
    const ok = results.every(Boolean) && !stop;
    const complete = ok && enough();
    return { complete, total: root.total, calls, reason: stop ?? (complete ? null : ok ? 'short' : 'incomplete') };
  }

  // Chia một nhánh quá 20 dòng theo từ phút hoặc giây (00–59). Dòng nào cũng có cả hai từ đó trong ts, nên các nhánh con
  // phủ hết nhánh cha (có thể thừa dòng có cùng từ ở chỗ khác, vô hại).
  async split(node, query, level, service) {
    if (!level) return false;
    const parts = await Promise.all(range(60, i => node(`${query} ${pad(i)}`, level, service)));
    return parts.every(Boolean);
  }
}
