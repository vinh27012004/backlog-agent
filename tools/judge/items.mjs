#!/usr/bin/env node
// Bảng đánh giá từng item qua các trận luyện, để chỉnh pack: kết quả, judge (lỗi mức H), gate và reviewer so với judge,
// thời gian theo giai đoạn, model và lượt fixer, số lần chụp evidence hỏng, credit, kèm cột "cần xem" gợi ý chỗ chỉnh.
// Đọc mọi bundle trong runs/judge/: _usage/usage.json (usage.mjs), index.json, <ID>/item.md, <ID>/judge.json và
// _verdicts/ (collect.mjs, score.mjs), _usage/transcripts/ khi có. Ghi runs/judge/_items/items.md và items.csv.
// Chạy: node tools/judge/items.mjs [thư mục runs/judge] [--out <thư mục>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRows } from './score.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = ['BUG', 'CR', 'TASK', 'PI'];
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const dur = ms => { if (!Number.isFinite(ms)) return '—'; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// Giờ Việt Nam: trận chạy theo giờ máy của đội.
const vnTime = t => (Number.isFinite(t) ? new Date(t + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '—');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const SUBMITTED = r => r.outcome === 'SUBMITTED';

// Tên đề từ dòng đầu item.md: "# BUG-01 (BUG, 100 points): Desktop sidebar obscures the main content".
export function itemTitle(bundle, key) {
  try {
    const first = readFileSync(join(bundle, key, 'item.md'), 'utf8').split(/\r?\n/, 1)[0];
    const m = first.match(/^#\s+\S+\s+\((\w+),\s*(\d+)\s+points?\):\s*(.+)$/i);
    return m ? { type: m[1].toUpperCase(), points: Number(m[2]), title: m[3].trim() } : null;
  } catch { return null; }
}

// Pha evidence của fixer, tính từ lời gọi ready_for_evidence đầu tiên: thời gian model nghĩ giữa các lượt gọi tool, số
// lần start app, số lần chụp và số lần chụp hỏng (ước tính theo mã lỗi trong kết quả). Một lần exec của code mode là
// một lượt tool.
const CAPTURE_ERROR = /ELEMENT_[A-Z_]+|ASSERT_FAILED|EVIDENCE_STALE|BROWSER_START_FAILED|CAPTURE_TIMEOUT|INVALID_ARGUMENT|INVALID_SELECTOR|LOGIN_FAILED|INTERNAL_ERROR|DOWNLOAD_[A-Z_]+|PATH_NOT_ALLOWED/;
export function evidenceActivity(transcriptsDir, threads) {
  const out = {};
  if (!existsSync(transcriptsDir)) return out;
  for (const t of threads.filter(x => x.role === 'team_fixer' && x.item && x.file)) {
    let lines;
    try { lines = readFileSync(join(transcriptsDir, t.file), 'utf8').split(/\n/).filter(Boolean); } catch { continue; }
    const a = { modelMs: 0, appStarts: 0, captures: 0, captureFails: 0 };
    const calls = new Map();
    let evidence = false, free = null;
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload ?? {}, at = Date.parse(o.timestamp);
      if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        const input = String(p.input ?? p.arguments ?? '');
        calls.set(p.call_id, input);
        if (evidence && free !== null && Number.isFinite(at)) a.modelMs += Math.max(0, at - free);
        free = null;
        if (evidence && /team_runtime__app\(\{[^}]*action:\s*["']start/.test(input)) a.appStarts++;
        if (evidence && /capture_evidence\(/.test(input)) a.captures++;
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const input = calls.get(p.call_id) ?? '';
        free = Number.isFinite(at) ? at : free;
        if (evidence && /capture_evidence\(/.test(input) && CAPTURE_ERROR.test(JSON.stringify(p.output ?? ''))) a.captureFails++;
        if (/ready_for_evidence/.test(input)) evidence = true;
      }
    }
    // Trận trước khi có checkpoint ready_for_evidence (trước 29/10) không tách được pha evidence: để trống, không ghi 0.
    if (!evidence) continue;
    const sum = (out[t.item] ??= { modelMs: 0, appStarts: 0, captures: 0, captureFails: 0 });
    for (const k of Object.keys(sum)) sum[k] += a[k];
  }
  return out;
}

// Cờ gợi ý chỗ cần xem khi chỉnh pack: dấu hiệu, không phải kết luận.
export function itemFlags(r) {
  const out = [];
  if (!SUBMITTED(r)) out.push(r.outcome === 'NOT_STARTED' ? 'chưa bắt đầu' : 'chưa nộp');
  if (r.judge.startsWith('fail')) out.push(`judge ${r.judge.slice(5)}`);
  if (r.gateVsJudge === 'false green') out.push('gate false green');
  if (r.reviewerVsJudge === 'false green') out.push('reviewer false green');
  if (r.gateVsJudge === 'false red' || r.reviewerVsJudge === 'false red') out.push('false red');
  if (r.evidenceMs > 300_000 && r.evidenceMs > 2 * (r.codeMs ?? 0)) out.push(r.codeMs ? `evidence ${Math.round(r.evidenceMs / r.codeMs)}× code` : 'evidence dài');
  if (r.activity?.captureFails >= 3) out.push(`chụp hỏng ${r.activity.captureFails}`);
  if (r.fixerThreads >= 3) out.push(`${r.fixerThreads} thread fixer`);
  if (r.secPerCall >= 9 && r.evidenceMs > 300_000) out.push(`fixer ${Math.round(r.secPerCall)} s/lượt`);
  if (r.gates >= 3) out.push(`gate ${r.gates} lần`);
  if (r.dispatchMs > 120_000) out.push('chờ slot');
  return out;
}

export function matchSummary(bundle) {
  const usage = readJson(join(bundle, '_usage', 'usage.json'));
  if (!usage) return null;
  let judged = null;
  try { judged = existsSync(join(bundle, 'index.json')) ? scoreRows(bundle) : null; } catch { judged = null; }
  const threads = usage.threads ?? [];
  const activity = evidenceActivity(join(bundle, '_usage', 'transcripts'), threads);
  const keys = [...new Set([...Object.keys(usage.items ?? {}), ...(judged?.rows.map(r => r.key) ?? [])])].sort();
  const items = keys.map(key => {
    const u = usage.items?.[key] ?? {};
    const s = judged?.rows.find(r => r.key === key) ?? null;
    const head = itemTitle(bundle, key);
    const own = threads.filter(t => t.item === key);
    const fixers = own.filter(t => t.role === 'team_fixer');
    const calls = fixers.reduce((a, t) => a + (t.calls ?? 0), 0);
    const busy = fixers.reduce((a, t) => a + (t.busyMs ?? 0), 0);
    const phase = name => u.phases?.[name]?.ms ?? null;
    const row = { match: usage.matchId, key, type: head?.type ?? s?.type ?? key.split('-')[0].toUpperCase(), points: head?.points ?? s?.points ?? null,
      title: head?.title ?? null, outcome: u.outcome ?? (s?.submitted ? 'SUBMITTED' : 'NOT_STARTED'), ms: u.ms ?? null, dispatchMs: u.dispatchMs ?? null,
      codeMs: phase('code_test'), evidenceMs: phase('evidence'), handoffMs: phase('handoff'),
      fixerThreads: fixers.length, fixerModels: [...new Set(fixers.map(t => `${String(t.model ?? '?').replace(/^gpt-/, '')}${t.effort ? `/${t.effort}` : ''}`))],
      fixerCalls: calls, secPerCall: calls ? busy / calls / 1000 : null, reviewerThreads: u.reviewer?.threads ?? 0,
      gates: u.gates ?? 0, gateMs: u.jobs?.run_gate?.ms ?? null, credits: own.reduce((a, t) => a + (t.credits ?? 0), 0), activity: activity[key] ?? null,
      inputTokens: own.reduce((a, t) => a + (t.tokens?.input_tokens ?? 0), 0),
      endedAt: u.endedAt ? Date.parse(u.endedAt) : null,
      judge: s?.judged ? (s.judge ? 'pass' : `fail ${s.highFails.map(h => h.id).join(',')}`) : '—',
      gateVsJudge: s?.gateVsJudge ?? 'n/a', reviewerVsJudge: s?.reviewerVsJudge ?? 'n/a' };
    return { ...row, flags: itemFlags(row) };
  });
  const roleInput = Object.fromEntries(Object.entries(usage.byRole ?? {}).map(([role, v]) => [role, v.tokens?.input_tokens ?? 0]));
  return { id: usage.matchId, from: usage.window?.from ?? null, to: usage.window?.to ?? null, credits: usage.credits ?? null,
    limitAt: usage.quota?.limitAt ?? null, unpriced: usage.unpriced ?? [], rootCalls: usage.byRole?.root?.calls ?? null,
    rootWaitCalls: usage.rootTriggers ? Object.entries(usage.rootTriggers).filter(([k]) => /wait_agent|send_message/.test(k)).reduce((a, [, v]) => a + v.calls, 0) : null, input: usage.total?.input_tokens ?? null, roleInput, judged: Boolean(judged), items };
}

export function buildReport(runsDir) {
  const matches = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter(d => !d.startsWith('_') && existsSync(join(runsDir, d, '_usage', 'usage.json')))
    .map(d => matchSummary(join(runsDir, d))).filter(Boolean).sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const rows = matches.flatMap(m => m.items);
  const avg = (list, pick) => dur(mean(list.map(pick).filter(Number.isFinite)));
  const summary = matches.map(m => {
    const started = m.items.filter(r => r.outcome !== 'NOT_STARTED');
    const done = m.items.filter(SUBMITTED);
    const judged = m.items.filter(r => r.judge !== '—');
    const green = field => (judged.length ? m.items.filter(r => r[field] === 'false green').length : '—');
    return [m.id, vnTime(m.from), started.length, done.length, judged.length ? `${judged.filter(r => r.judge === 'pass').length}/${judged.length}` : '—',
      green('gateVsJudge'), green('reviewerVsJudge'),
      ...TYPES.map(t => avg(done.filter(r => r.type === t), r => r.ms)), avg(done, r => r.evidenceMs),
      m.credits === null ? '—' : m.credits.toFixed(0), m.limitAt ? vnTime(Date.parse(m.limitAt)).slice(11) : '—'];
  });
  // Cùng đề qua các trận (theo tên đề trong item.md; bộ đề đổi điểm vẫn khớp được).
  const byTitle = new Map();
  for (const r of rows.filter(x => x.title)) byTitle.set(`${r.key} · ${r.title}`, [...(byTitle.get(`${r.key} · ${r.title}`) ?? []), r]);
  const across = [...byTitle.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => [name,
    list.map(r => `${r.match}: ${SUBMITTED(r) ? dur(r.ms) : r.outcome.toLowerCase()}${r.judge === 'pass' ? ' ✓' : r.judge.startsWith('fail') ? ' ✗' : ''}`).join('; ')]);
  const detail = [...matches].reverse().flatMap(m => m.items).map(r => [r.match, r.key, r.points ?? '—', r.outcome, r.judge,
    `${r.gateVsJudge} / ${r.reviewerVsJudge}`, dur(r.ms), dur(r.codeMs), dur(r.evidenceMs),
    r.fixerThreads ? `${r.fixerModels.join(', ')} · ${r.fixerThreads} thread · ${r.fixerCalls} lượt · ${r.secPerCall?.toFixed(1) ?? '—'} s/lượt` : '—',
    r.gates ? `${r.gates} · ${dur(r.gateMs)}` : '—', r.activity ? `${r.activity.captures}/${r.activity.captureFails} · app ${r.activity.appStarts}` : '—',
    r.credits ? r.credits.toFixed(1) : '—', r.flags.join('; ') || '—']);
  const md = ['# Đánh giá từng item qua các trận', '',
    `${matches.length} trận có số liệu (\`_usage/usage.json\`), ${rows.length} dòng item. Sinh bởi \`node tools/judge/items.mjs\`; chạy lại sau mỗi `
      + '`/judge-practice`. Thời gian item: từ Start Work tới khi đóng hay nộp. Code/test, evidence: tổng thời gian các checkpoint của '
      + 'item (journal từ 31/10; trận cũ hơn không có). "Cần xem" là dấu hiệu để chỉnh pack, không phải kết luận.', '',
    '## So sánh theo trận', '',
    'TB = trung bình thời gian các item đã nộp của loại đó; Gate/Reviewer FG = false green so với judge.', '',
    table(['Trận', 'Bắt đầu (giờ VN)', 'Item làm', 'Nộp', 'Judge pass', 'Gate FG', 'Reviewer FG', ...TYPES.map(t => `TB ${t}`), 'TB evidence', 'Credit', 'Hết quota'], summary),
    '', '## Cùng item qua các trận', '', 'Theo tên đề; ✓ judge pass, ✗ judge thấy lỗi mức H.', '',
    table(['Item', 'Các lần (cũ → mới)'], across),
    '', '## Từng item (trận mới nhất trước)', '',
    'Fixer: model · số thread · số lượt gọi model · thời gian chạy chia số lượt (gồm cả thời gian tool). Chụp: số lần gọi '
      + 'capture_evidence / số lần hỏng trong pha evidence (ước tính từ transcript; trống khi trận chưa có checkpoint '
      + 'ready_for_evidence), app: số lần start app. Credit theo price card trong usage.mjs (model ngoài price card không tính).', '',
    table(['Trận', 'Item', 'Điểm', 'Kết quả', 'Judge', 'Gate / reviewer so judge', 'Thời gian', 'Code/test', 'Evidence', 'Fixer',
      'Gate', 'Chụp', 'Credit', 'Cần xem'], detail), ''].join('\n');
  const csvHead = ['match', 'key', 'type', 'points', 'title', 'outcome', 'judge', 'gate_vs_judge', 'reviewer_vs_judge', 'seconds', 'dispatch_s',
    'code_test_s', 'evidence_s', 'handoff_s', 'fixer_threads', 'fixer_models', 'fixer_calls', 'sec_per_call', 'reviewer_threads', 'gates',
    'gate_s', 'captures', 'capture_fails', 'app_starts', 'evidence_model_s', 'credits', 'flags'];
  const sec = ms => (Number.isFinite(ms) ? Math.round(ms / 1000) : '');
  const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [csvHead.join(','), ...rows.map(r => [r.match, r.key, r.type, r.points ?? '', r.title ?? '', r.outcome, r.judge, r.gateVsJudge,
    r.reviewerVsJudge, sec(r.ms), sec(r.dispatchMs), sec(r.codeMs), sec(r.evidenceMs), sec(r.handoffMs), r.fixerThreads, r.fixerModels.join(' '),
    r.fixerCalls, r.secPerCall?.toFixed(1) ?? '', r.reviewerThreads, r.gates, sec(r.gateMs), r.activity?.captures ?? '', r.activity?.captureFails ?? '',
    r.activity?.appStarts ?? '', sec(r.activity?.modelMs), r.credits ? r.credits.toFixed(2) : '', r.flags.join('; ')].map(cell).join(','))].join('\n');
  return { matches, rows, md, csv };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const outArg = i >= 0 ? args.splice(i, 2)[1] : null;
  const runsDir = resolve(args[0] ?? join(REPO, 'runs', 'judge'));
  const out = resolve(outArg ?? join(runsDir, '_items'));
  const res = buildReport(runsDir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'items.md'), res.md);
  writeFileSync(join(out, 'items.csv'), `﻿${res.csv}\n`);
  console.log(`${res.matches.length} trận, ${res.rows.length} item → ${join(out, 'items.md')} và items.csv`);
}
