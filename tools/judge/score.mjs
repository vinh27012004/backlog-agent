#!/usr/bin/env node
// So phán quyết của judge (judge.json mỗi item) với gate, reviewer và grader (_verdicts/), như quality_matrix của
// harness mẫu: gate pass mà judge thấy lỗi mức H là "false green", gate fail mà judge thấy đạt là "false red".
// Ghi report.md cạnh bundle. Chạy: node tools/judge/score.mjs <thư mục do collect.mjs tạo>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

const classify = (verdict, judge) => (verdict === null || judge === null ? 'n/a'
  : verdict && !judge ? 'false green' : !verdict && judge ? 'false red' : 'agree');

const show = v => (v === null ? '–' : v ? 'pass' : 'fail');

// Phán quyết từng item, không ghi gì (items.mjs dùng lại cho bảng qua các trận).
export function scoreRows(out) {
  const index = readJson(join(out, 'index.json'));
  if (!index) throw new Error(`không có index.json trong ${out}; chạy collect.mjs trước`);
  const rows = index.items.map(item => {
    const judge = readJson(join(out, item.key, 'judge.json'));
    const v = readJson(join(out, '_verdicts', `${item.key}.json`)) ?? {};
    const criteria = Array.isArray(judge?.criteria) ? judge.criteria : [];
    const highFails = criteria.filter(c => c.verdict === 'fail' && String(c.severity).toUpperCase().startsWith('H'));
    const judgeOk = judge ? highFails.length === 0 : null;
    const gateOk = v.gate ? Boolean(v.gate.passed) : null;
    const reviewerOk = v.reviewer?.verdict ? v.reviewer.verdict === 'approve' : null;
    return {
      key: item.key, type: item.type, points: item.points, judged: Boolean(judge), judge: judgeOk, gate: gateOk, reviewer: reviewerOk,
      submitted: Boolean(v.submitted), grader: v.grader?.scoreVerdict ?? v.grader?.scoreStatus ?? null,
      highFails: highFails.map(c => ({ id: c.id, where: c.where ?? null, evidence: c.evidence ?? '' })),
      unjudgeable: criteria.filter(c => c.verdict === 'unjudgeable').length,
      selfInconsistent: Boolean(judge?.verdict) && (judge.verdict === 'pass') !== judgeOk,
      gateVsJudge: classify(gateOk, judgeOk), reviewerVsJudge: classify(reviewerOk, judgeOk)
    };
  });
  const tally = field => Object.fromEntries(['agree', 'false green', 'false red', 'n/a'].map(k => [k, rows.filter(r => r[field] === k).length]));
  const totals = { gate: tally('gateVsJudge'), reviewer: tally('reviewerVsJudge'), judged: rows.filter(r => r.judged).length };
  return { index, rows, totals };
}

export function scoreMatch(out) {
  const { index, rows, totals } = scoreRows(out);

  const lines = [`# Chấm lại trận ${index.matchId}`, '', `Gom lúc ${index.collectedAt}; judge chấm ${totals.judged}/${rows.length} item.`, '',
    '| Item | Loại | Điểm | Judge | Lỗi H | Gate | Reviewer | Nộp | Grader | Gate so với judge | Reviewer so với judge |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.key} | ${r.type ?? ''} | ${r.points ?? ''} | ${show(r.judge)} | ${r.highFails.map(h => h.id).join(', ') || '–'} | ${show(r.gate)} | ${show(r.reviewer)} | ${r.submitted ? 'có' : 'không'} | ${r.grader ?? '–'} | ${r.gateVsJudge} | ${r.reviewerVsJudge} |`),
    '', '## Tổng', '',
    `- Gate: ${totals.gate.agree} khớp, **${totals.gate['false green']} false green**, ${totals.gate['false red']} false red, ${totals.gate['n/a']} không so được.`,
    `- Reviewer: ${totals.reviewer.agree} khớp, **${totals.reviewer['false green']} false green**, ${totals.reviewer['false red']} false red, ${totals.reviewer['n/a']} không so được.`,
    '', '## Lỗi mức H judge tìm thấy', ''];
  for (const r of rows.filter(x => x.highFails.length)) {
    for (const h of r.highFails) lines.push(`- **${r.key} ${h.id}**${h.where ? ` (\`${h.where}\`)` : ''}: ${h.evidence}`);
  }
  if (!rows.some(r => r.highFails.length)) lines.push('- Không có.');
  const odd = rows.filter(r => r.selfInconsistent).map(r => r.key);
  if (odd.length) lines.push('', `Judge ghi "verdict" trái với tiêu chí của chính nó ở: ${odd.join(', ')} (bảng trên tính theo tiêu chí).`);
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`);
  return { rows, totals, report: join(out, 'report.md') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out || !existsSync(out)) {
    console.error('dùng: node tools/judge/score.mjs <thư mục do collect.mjs tạo>');
    process.exit(2);
  }
  const res = scoreMatch(resolve(out));
  console.log(`gate: ${JSON.stringify(res.totals.gate)}\nreviewer: ${JSON.stringify(res.totals.reviewer)}\n→ ${res.report}`);
}
