// Kho log production dùng chung cho mọi PI của trận. OMZJW0S0 (05/11): search_logs trả tối đa 20 dòng mỗi lời gọi,
// không limit/offset; helper cũ chỉ lấy 20 dòng đầu của mỗi service đoán được tên (PI-02: 6 service đều 20/N, thiếu
// đúng rule-engine và deploy), nên fixer PI-02 tự chia query theo giờ (168 lời gọi, 93 s, sau một vòng hỏi root) và
// PI-03 theo từng schedule (320 lời gọi, 121 s). Log là kho chung: brief PI-02 lúc 05:00 đã thấy schedules 697 dòng mà
// PI-03 cần 5 phút sau.
//
// Cách gom: `query` khớp chuỗi con, kể cả trong ts (fixer dùng `2025-10-18T22`), nên chia đệ quy theo tiền tố ts
// (năm → tháng → chục ngày → ngày → chục giờ → giờ → chục phút → … → ms) tới khi returned == total. Server trả dòng mới
// nhất trước: mọi dòng của tiền tố mới hơn dòng cũ nhất vừa nhận đã có, nên con nào mới hơn mốc đó thì khỏi gọi. Mô
// phỏng trên log của trận: 3.608 dòng hết khoảng 520 lời gọi (không nhảy cóc thì 770). Company Tools giới hạn 120
// request/phút cho cả đội, nên lần gom từ lúc boot chạy ưu tiên thấp (company.mjs) và chỉ lên ưu tiên thường khi một PI
// đang chờ. Lần làm mới sau đó tái dùng nhánh có total không đổi: log không đổi thì chỉ tốn một lời gọi.
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../core/util.mjs';

const CONCURRENCY = 6;
const MAX_CALLS = 1200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const pad = n => String(n).padStart(2, '0');
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const keyOf = e => JSON.stringify(e);
const tsOf = e => String(e?.ts ?? e?.timestamp ?? '');
const seqOf = e => Number(e?.context?.seq ?? e?.seq);

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

// Các tiền tố con của một tiền tố ts ISO ("2025-" → tháng, "2025-10" → chục ngày, …); rỗng khi đã tới ms.
export function tsChildren(p) {
  switch (p.length) {
    case 5: return range(12, i => p + pad(i + 1));
    case 7: return range(4, i => `${p}-${i}`);
    case 9: return range(10, i => p + i).filter(x => !/-00$|-3[2-9]$/.test(x));
    case 10: return range(3, i => `${p}T${i}`);
    case 12: return range(10, i => p + i).filter(x => !/T2[4-9]$/.test(x));
    case 13: return range(6, i => `${p}:${i}`);
    case 15: return range(10, i => p + i);
    case 16: return range(6, i => `${p}:${i}`);
    case 18: return range(10, i => p + i);
    case 19: return range(10, i => `${p}.${i}`);
    case 21: case 22: return range(10, i => p + i);
    default: return [];
  }
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
    this.data = { at: null, total: null, complete: false, calls: 0, ms: 0, reason: null, done: {}, entries: [] };
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
    let res = await this.pass(known, prev.done ?? {}, { skip: true, budget: this.maxCalls });
    // Thiếu dòng dù mọi nhánh báo đủ: giả định "mới nhất trước" sai, đi lại không nhảy cóc.
    if (res.reason === 'short') res = await this.pass(known, {}, { skip: false, budget: this.maxCalls - res.calls, calls: res.calls });
    this.data = { at: new Date().toISOString(), total: res.total, complete: res.complete, calls: res.calls, ms: Date.now() - t0,
      reason: res.complete ? null : res.reason, done: res.done, entries: sortLog(known.values()) };
    this.known = null;
    if (this.file) { try { writeFileAtomic(this.file, `${JSON.stringify(this.data)}\n`); } catch { /* chỉ là cache */ } }
    return this.snapshot();
  }

  async pass(known, prevDone, { skip, budget, calls: used = 0 }) {
    let calls = used, stop = null;
    const done = {}, gate = limiter(CONCURRENCY);
    const ask = async q => {
      for (let attempt = 0; ; attempt++) {
        if (stop) return null;
        if (calls >= used + budget) { stop ??= 'budget'; return null; }
        calls++;
        const page = await gate(() => this.invoke('search_logs', { query: q }, { priority: this.priority })).then(logPage, () => null);
        if (!page) {
          if (attempt < 1) { await new Promise(r => setTimeout(r, 1000)); continue; }
          return null;
        }
        // Server không lọc theo query (dòng trả về không chứa chuỗi đó): chia nhỏ vô ích, dừng.
        const needle = q.toLowerCase();
        if (q && page.entries.some(e => !keyOf(e).toLowerCase().includes(needle))) { stop ??= 'unfiltered'; return null; }
        for (const e of page.entries) known.set(keyOf(e), e);
        return page;
      }
    };
    // true khi đã có mọi dòng có ts bắt đầu bằng q.
    const node = async q => {
      const page = await ask(q);
      if (!page) return { ok: false, total: null };
      if (page.total <= page.entries.length || prevDone[q] === page.total) { done[q] = page.total; return { ok: true, total: page.total }; }
      const times = page.entries.map(tsOf);
      const newestFirst = times.every((t, i) => ISO.test(t) && (i === 0 || Date.parse(times[i - 1]) >= Date.parse(t)));
      const oldest = times.at(-1);
      const kids = tsChildren(q);
      if (!kids.length) return { ok: false, total: page.total };
      const results = await Promise.all(kids.map(c => {
        const head = oldest.slice(0, c.length);
        return skip && newestFirst && head.length === c.length && c > head ? { ok: true } : node(c);
      }));
      const ok = results.every(r => r.ok);
      if (ok) done[q] = page.total;
      return { ok, total: page.total };
    };

    const root = await ask('');
    if (!root) return { complete: false, total: null, calls, done, reason: stop ?? 'error' };
    this.liveTotal = root.total;
    let ok = true;
    if (root.total <= root.entries.length || prevDone[''] === root.total) ok = true;
    else {
      // Năm mới nhất lấy từ dòng mới nhất; lùi từng năm tới năm đầu tiên không có dòng nào.
      let year = Number(tsOf(root.entries[0]).slice(0, 4));
      if (!Number.isInteger(year) || year < 1000) return { complete: false, total: root.total, calls, done, reason: 'no ts' };
      for (let n = 0; n < 30; n++, year--) {
        const r = await node(`${year}-`);
        if (!r.ok) ok = false;
        if (!r.total || stop) break;
      }
    }
    const short = ok && known.size < root.total;
    const complete = ok && !short && !stop;
    if (complete) done[''] = root.total;
    return { complete, total: root.total, calls, done, reason: stop ?? (short ? 'short' : ok ? null : 'incomplete') };
  }
}
