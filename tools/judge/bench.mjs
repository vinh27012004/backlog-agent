#!/usr/bin/env node
// Benchmark theo bộ đề: nhóm các trận cùng bộ item (vd bộ 10 item BUG-01…TASK-04), so trận mới nhất với trận liền
// trước cùng bộ và với mốc tốt nhất trước đó, theo trận và theo từng item, để thấy lần chỉnh pack vừa rồi tốt lên hay
// tệ đi. Đọc mọi bundle trong runs/judge/ qua matchSummary (items.mjs). Ghi runs/judge/_items/bench.md.
// Chạy: node tools/judge/bench.mjs [thư mục runs/judge] [--match <ID mới>] [--vs <ID so sánh>] [--out <thư mục>]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSummary } from './items.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBMITTED = r => r?.outcome === 'SUBMITTED';
const fin = v => Number.isFinite(v);
const sum = xs => xs.filter(fin).reduce((a, b) => a + b, 0);
const mean = xs => { const ok = xs.filter(fin); return ok.length ? sum(ok) / ok.length : null; };
const dur = ms => { if (!fin(ms)) return '—'; const s = Math.round(Math.abs(ms) / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
const mtok = n => (fin(n) ? `${(n / 1e6).toFixed(1)}M` : '—');
const num = d => n => (fin(n) ? n.toFixed(d) : '—');
const vnTime = t => (fin(t) ? new Date(t + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '—');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const ORDER = ['BUG', 'CR', 'TASK', 'PI'];
const byKey = (a, b) => (ORDER.indexOf(a.split('-')[0]) - ORDER.indexOf(b.split('-')[0])) || a.localeCompare(b, 'en', { numeric: true });

// Nhóm trận theo bộ đề: trùng ≥ 60% mã item (Jaccard) với hợp các trận đã có trong nhóm. Trận dừng sớm (chưa thấy hết
// item) vẫn vào đúng bộ; bộ 5 item và bộ 10 item chỉ chung BUG-01, BUG-02, CR-01 nên tách được.
export function groupBySet(matches, threshold = 0.6) {
  const groups = [];
  for (const m of [...matches].sort((a, b) => (a.from ?? 0) - (b.from ?? 0))) {
    const keys = new Set(m.items.map(r => r.key));
    const jac = g => { const inter = [...keys].filter(k => g.keys.has(k)).length; return inter / new Set([...keys, ...g.keys]).size; };
    const best = groups.map(g => [g, jac(g)]).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= threshold) { best[0].matches.push(m); for (const k of keys) best[0].keys.add(k); } else groups.push({ keys, matches: [m] });
  }
  for (const g of groups) g.name = `Bộ ${g.keys.size} item`;
  return groups;
}

// Chỉ số cấp trận; better: 'low' là càng thấp càng tốt, 'high' ngược lại.
// Credit chỉ đáng tin khi mọi model đều có trong price card (guardian codex-auto-review không bao giờ có giá, bỏ qua).
const priced = m => (m.unpriced ?? []).every(x => x === 'codex-auto-review');
const credits = m => (priced(m) && fin(m.credits) ? m.credits : null);
const submittedCount = m => m.items.filter(SUBMITTED).length;
const submittedPoints = m => { const done = m.items.filter(SUBMITTED); return done.every(r => fin(r.points)) ? sum(done.map(r => r.points)) : null; };
const judgedCount = m => m.items.filter(r => r.judge !== '—').length;
const MATCH_METRICS = [
  { label: 'Item nộp', get: m => m.items.filter(SUBMITTED).length, fmt: n => String(n), better: 'high', total: g => g.keys.size },
  { label: 'Điểm đã nộp', get: submittedPoints, fmt: num(0), better: 'high' },
  { label: 'Judge pass', get: m => (judgedCount(m) ? m.items.filter(r => r.judge === 'pass').length : null), fmt: num(0), better: 'high',
    suffix: m => (judgedCount(m) ? `/${judgedCount(m)}` : '') },
  { label: 'Thời lượng trận', get: m => (fin(m.to) && fin(m.from) ? m.to - m.from : null), fmt: dur, better: 'low', time: true },
  { label: 'Nộp xong item cuối (từ đầu trận)', get: m => { const ends = m.items.filter(SUBMITTED).map(r => r.endedAt).filter(fin);
    return ends.length && fin(m.from) ? Math.max(...ends) - m.from : null; }, fmt: dur, better: 'low', time: true },
  { label: 'TB thời gian item đã nộp', get: m => mean(m.items.filter(SUBMITTED).map(r => r.ms)), fmt: dur, better: 'low', time: true },
  { label: 'TB code/test', get: m => mean(m.items.filter(SUBMITTED).map(r => r.codeMs)), fmt: dur, better: 'low', time: true },
  { label: 'TB evidence', get: m => mean(m.items.filter(SUBMITTED).map(r => r.evidenceMs)), fmt: dur, better: 'low', time: true },
  { label: 'Credit', get: credits, fmt: num(0), better: 'low' },
  { label: 'Credit / item nộp', get: m => { const n = submittedCount(m); return n && fin(credits(m)) ? credits(m) / n : null; }, fmt: num(1), better: 'low' },
  { label: 'Input token', get: m => m.input, fmt: mtok, better: 'low' },
  { label: '· root', get: m => m.roleInput?.root ?? null, fmt: mtok, better: 'low' },
  { label: '· team_fixer', get: m => m.roleInput?.team_fixer ?? null, fmt: mtok, better: 'low' },
  { label: '· guardian', get: m => m.roleInput?.guardian ?? null, fmt: mtok, better: 'low' },
  { label: 'Lượt fixer', get: m => sum(m.items.map(r => r.fixerCalls)), fmt: num(0), better: 'low' },
  { label: 'Chụp evidence hỏng', get: m => (m.items.some(r => r.activity) ? sum(m.items.map(r => r.activity?.captureFails)) : null), fmt: num(0), better: 'low' },
  { label: 'Item có cờ "cần xem"', get: m => m.items.filter(r => r.flags.length).length, fmt: num(0), better: 'low' },
];

// Δ mới so với cũ: giá trị, phần trăm, ✓ khi tốt hơn quá 5%, ✗ khi tệ hơn quá 5%.
function delta(now, then, { fmt, better, time }) {
  if (!fin(now) || !fin(then)) return '—';
  const d = now - then;
  if (d === 0) return '=';
  const pct = then ? (d / Math.abs(then)) * 100 : null;
  const sign = d > 0 ? '+' : '−';
  const mark = pct !== null && Math.abs(pct) < 5 ? '' : (better === 'low' ? d < 0 : d > 0) ? ' ✓' : ' ✗';
  const value = time ? dur(d) : fmt(Math.abs(d));
  return `${sign}${value}${pct === null ? '' : ` (${sign}${Math.abs(pct).toFixed(0)}%)`}${mark}`;
}

function bestOf(list, get, better) {
  let best = null;
  for (const m of list) {
    const v = get(m);
    if (fin(v) && (best === null || (better === 'low' ? v < best.v : v > best.v))) best = { v, id: m.id };
  }
  return best;
}

const outcomeShort = r => (!r ? '·' : SUBMITTED(r) ? 'nộp' : r.outcome === 'NOT_STARTED' ? 'chưa làm' : r.outcome === 'CLOSED' ? 'đóng' : 'chưa nộp');
const judgeShort = r => (!r || r.judge === '—' ? '—' : r.judge === 'pass' ? '✓' : `✗ ${r.judge.slice(5)}`);
const arrow = (a, b) => `${a} → ${b}`;

function itemDelta(prev, cur) {
  if (SUBMITTED(cur) && !SUBMITTED(prev)) return 'mới nộp ✓';
  if (!SUBMITTED(cur) && SUBMITTED(prev)) return 'không nộp ✗';
  if (!SUBMITTED(cur)) return '—';
  return delta(cur.ms, prev.ms, { better: 'low', time: true });
}

export function compareMatches(group, cur, prev) {
  const before = group.matches.filter(m => (m.from ?? 0) < (cur.from ?? 0));
  // Mốc "càng thấp càng tốt" (thời gian, credit, token) chỉ lấy từ trận nộp ít nhất bằng trận mới: trận dừng sớm vì hết
  // quota hay nộp ít item thì tốn ít hơn nhưng không so được.
  const comparable = before.filter(m => submittedCount(m) >= submittedCount(cur));
  const metricRows = MATCH_METRICS.map(x => {
    const v = m => (m ? x.get(m) : null);
    const show = m => (m && fin(v(m)) ? `${x.fmt(v(m))}${x.suffix ? x.suffix(m) : x.total ? `/${x.total(group)}` : ''}` : '—');
    const best = bestOf(x.better === 'low' ? comparable : before, x.get, x.better);
    return [x.label, show(cur), show(prev), delta(v(cur), v(prev), x), best ? `${x.fmt(best.v)} (${best.id})` : '—'];
  });
  const keys = [...group.keys].sort(byKey);
  const itemRows = keys.map(key => {
    const c = cur.items.find(r => r.key === key), p = prev?.items.find(r => r.key === key);
    const best = bestOf(before.filter(m => SUBMITTED(m.items.find(r => r.key === key))), m => m.items.find(r => r.key === key).ms, 'low');
    const cell = (pick, fmt) => arrow(p && SUBMITTED(p) ? fmt(pick(p)) : '—', c && SUBMITTED(c) ? fmt(pick(c)) : '—');
    const title = (c ?? p)?.title;
    return [title ? `${key} · ${title.length > 38 ? `${title.slice(0, 37)}…` : title}` : key, (c ?? p)?.points ?? '—',
      arrow(outcomeShort(p), outcomeShort(c)), arrow(judgeShort(p), judgeShort(c)),
      cell(r => r.ms, dur), itemDelta(p, c), cell(r => r.codeMs, dur), cell(r => r.evidenceMs, dur),
      arrow(p?.fixerModels.join(', ') || '—', c?.fixerModels.join(', ') || '—'),
      cell(r => r.fixerCalls, num(0)), cell(r => r.inputTokens, mtok), cell(r => r.credits, num(1)),
      best ? `${dur(best.v)} (${best.id})` : '—', c?.flags.join('; ') || '—'];
  });
  return { metricRows, itemRows };
}

function historyTable(group) {
  const ms = group.matches;
  const keys = [...group.keys].sort(byKey);
  const rows = keys.map(key => [key, ...ms.map(m => {
    const r = m.items.find(x => x.key === key);
    if (!r) return '·';
    const j = r.judge === 'pass' ? ' ✓' : r.judge.startsWith('fail') ? ' ✗' : '';
    return SUBMITTED(r) ? `${dur(r.ms)}${j}` : `${outcomeShort(r)}${j}`;
  })]);
  const foot = MATCH_METRICS.filter(x => ['Item nộp', 'Judge pass', 'Thời lượng trận', 'Credit', 'Input token'].includes(x.label))
    .map(x => [`**${x.label}**`, ...ms.map(m => (fin(x.get(m)) ? `${x.fmt(x.get(m))}${x.suffix ? x.suffix(m) : x.total ? `/${group.keys.size}` : ''}` : '—'))]);
  return table(['Item', ...ms.map(m => `${m.id}<br>${vnTime(m.from).slice(5)}`)], [...rows, ...foot]);
}

export function buildBench(runsDir, { match = null, vs = null } = {}) {
  const matches = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter(d => !d.startsWith('_') && existsSync(join(runsDir, d, '_usage', 'usage.json')))
    .map(d => matchSummary(join(runsDir, d))).filter(Boolean);
  const groups = groupBySet(matches).sort((a, b) => (b.matches.at(-1).from ?? 0) - (a.matches.at(-1).from ?? 0));
  const sections = [], pairs = [];
  for (const g of groups) {
    const cur = (match && g.matches.find(m => m.id === match)) || (match ? null : g.matches.at(-1));
    if (!cur) continue;
    const prev = vs ? matches.find(m => m.id === vs) ?? null : g.matches.filter(m => (m.from ?? 0) < (cur.from ?? 0)).at(-1) ?? null;
    const { metricRows, itemRows } = compareMatches(g, cur, prev);
    pairs.push({ group: g.name, cur: cur.id, prev: prev?.id ?? null, metricRows, itemRows });
    sections.push(`## ${g.name}: ${cur.id} so với ${prev?.id ?? '(chưa có trận trước)'}`, '',
      `${g.matches.length} trận trong bộ: ${g.matches.map(m => m.id).join(', ')}. Mới: ${cur.id} (${vnTime(cur.from)}), trước: `
        + `${prev ? `${prev.id} (${vnTime(prev.from)})` : '—'}.${cur.judged ? '' : ' **Trận mới chưa chấm judge** (chạy `/judge-practice`).'}`, '',
      '### Theo trận', '',
      table(['Chỉ số', cur.id, prev?.id ?? 'trước', 'Δ', 'Tốt nhất trước đó'], metricRows), '',
      '### Theo item (trước → mới)', '',
      table(['Item', 'Điểm', 'Kết quả', 'Judge', 'Thời gian', 'Δ thời gian', 'Code/test', 'Evidence', 'Model fixer', 'Lượt fixer', 'Input', 'Credit',
        'Nhanh nhất trước đó', 'Cần xem (mới)'], itemRows), '',
      '### Lịch sử trong bộ (cũ → mới)', '', historyTable(g), '');
  }
  const md = ['# Benchmark theo bộ đề', '',
    'Sinh bởi `node tools/judge/bench.mjs`; chạy lại sau mỗi `/judge-practice` (hoặc ngay sau `collect.mjs` + `usage.mjs` khi chưa chấm). '
      + 'Trận được nhóm theo bộ item (trùng ≥ 60% mã item). Mỗi bộ so trận mới nhất với trận liền trước cùng bộ (`--match`, `--vs` để chọn khác) '
      + 'và với mốc tốt nhất của các trận trước (thời gian, credit, token: chỉ trận nộp ít nhất bằng trận mới). Δ: ✓ tốt hơn, ✗ tệ hơn (bỏ qua chênh dưới 5%). Thời gian item từ Start Work tới khi nộp '
      + 'hay đóng; code/test, evidence là tổng thời gian checkpoint (journal từ 31/10). Input, credit: các thread của item (fixer); '
      + 'credit trận gồm cả root, để trống khi có model ngoài price card. Lịch sử: ✓/✗ là judge, "·" là item không xuất hiện trong trận.', '',
    ...sections].join('\n');
  return { groups, pairs, md };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const out = opt('--out'), match = opt('--match'), vs = opt('--vs');
  const runsDir = resolve(args[0] ?? join(REPO, 'runs', 'judge'));
  const target = resolve(out ?? join(runsDir, '_items'));
  const res = buildBench(runsDir, { match, vs });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'bench.md'), res.md);
  for (const p of res.pairs) {
    const row = label => p.metricRows.find(r => r[0] === label);
    console.log(`${p.group}: ${p.cur} vs ${p.prev ?? '—'} · nộp ${row('Item nộp')[2]} → ${row('Item nộp')[1]} · thời lượng ${row('Thời lượng trận')[3]} · credit ${row('Credit')[3]}`);
  }
  console.log(`→ ${join(target, 'bench.md')}`);
}
