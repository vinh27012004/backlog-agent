// Hồ sơ đề (item profile): JSON do agent team_analyst viết sau khi đọc đề, MVS, template và schema của item
// (contracts/item-profile.schema.json). Helper không tự phân tích chữ trong đề nữa; ở đây nó chỉ KIỂM lời analyst rồi
// thi hành: đúng schema, mỗi trích dẫn phải có nguyên văn trong đề/MVS (analyst không bịa được luật chấm, một câu cài
// cắm không thành cờ nếu không nằm trong đề), mỗi kịch bản của template phải được khai. Từ hồ sơ sinh ra checklist mà
// worker_checkpoint candidate kiểm từng dòng (BI7A5ACV: mutants chạy trên 8 item trong khi chỉ TASK-08 chấm khả năng
// phát hiện lỗi; CR-07 thiếu ảnh trang; PI-04 sai dạng timestamp).
//
// Hai nhóm kiểm tra (CLAUDE.md, 08-guardrails): hồ sơ được TẮT kiểm tra tốn thời gian (mutants) khi mục chấm của đề
// không nói tới; kiểm tra an toàn (schema submit.json, cấu hình test, test gốc, node_modules, secret) không đọc hồ sơ.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectionHeuristic } from '../decide/decisions.mjs';
import { validateSchema } from '../core/jsonschema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let schemaCache = null;
export function profileSchema() {
  schemaCache ??= JSON.parse(readFileSync(join(here, '..', '..', 'contracts', 'item-profile.schema.json'), 'utf8'));
  return schemaCache;
}

// So trích dẫn với đề: bỏ ký hiệu markdown, gộp khoảng trắng, thường hoá nháy và gạch; không phân biệt hoa thường.
const fold = text => String(text ?? '').normalize('NFKC').replace(/[`*_>#|]/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[‐-―]/g, '-').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function quotesOf(profile) {
  const out = [];
  const add = (where, quote) => out.push({ where, quote });
  (profile.grading ?? []).forEach((g, i) => add(`grading[${i}] (${g.aspect})`, g.quote));
  (profile.deliverables?.sourceFiles ?? []).forEach((f, i) => add(`deliverables.sourceFiles[${i}]`, f.quote));
  (profile.deliverables?.answerFields ?? []).forEach((f, i) => add(`deliverables.answerFields[${i}] (${f.name})`, f.quote));
  (profile.evidence ?? []).forEach((e, i) => add(`evidence[${i}] (${e.file})`, e.quote));
  (profile.constraints ?? []).forEach((c, i) => add(`constraints[${i}]`, c.quote));
  (profile.dependsOn ?? []).forEach((d, i) => add(`dependsOn[${i}] (${d.item})`, d.quote));
  return out;
}

// texts: đề, MVS và các file challenge dạng chữ của item; scenarioIds: id trong testResults của template.
// Trả về { problems }: rỗng thì hồ sơ được nhận.
export function validateProfile(profile, { key, texts = [], scenarioIds = [] } = {}) {
  const problems = validateSchema(profile, profileSchema()).map(e => `schema ${e}`);
  if (problems.length) return { problems };
  const source = fold(texts.filter(Boolean).join('\n'));
  const missing = [], aimed = [];
  for (const { where, quote } of quotesOf(profile)) {
    if (injectionHeuristic(quote)) aimed.push(where);
    else if (!source.includes(fold(quote))) missing.push(`${where}: ${JSON.stringify(String(quote).slice(0, 80))}`);
  }
  if (missing.length) problems.push(`quotes not found word for word in the item or its MVS (copy the exact sentence or a contiguous part of it, without paraphrasing): ${missing.slice(0, 6).join('; ')}${missing.length > 6 ? `; and ${missing.length - 6} more` : ''}`);
  if (aimed.length) problems.push(`quotes that are instructions aimed at an AI agent, not a description of the work or its scoring: ${aimed.slice(0, 4).join('; ')}. Leave those entries out`);
  const declared = new Set(profile.scenarios), wanted = new Set(scenarioIds);
  const lacking = [...wanted].filter(id => !declared.has(id)), extra = [...declared].filter(id => !wanted.has(id));
  if (lacking.length || extra.length) problems.push(`scenarios must be exactly the testResults ids of the template${lacking.length ? `; missing ${lacking.join(', ')}` : ''}${extra.length ? `; not in the template: ${extra.join(', ')}` : ''}`);
  for (const e of profile.evidence) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.file)) problems.push(`evidence file ${JSON.stringify(e.file)} must be a plain file name under evidence/`);
    if (e.scenario !== null && !wanted.has(e.scenario)) problems.push(`evidence ${e.file}: scenario ${e.scenario} is not a testResults id of the template (use null for a file required outside a scenario)`);
  }
  for (const f of profile.deliverables.sourceFiles) {
    if (/^([A-Za-z]:|[\\/])|(^|[\\/])\.\.([\\/]|$)/.test(f.path)) problems.push(`sourceFiles path ${JSON.stringify(f.path)} must be relative, inside the project`);
  }
  for (const d of profile.dependsOn) if (d.item === key) problems.push(`dependsOn names ${key} itself`);
  return { problems };
}

let waveSchemaCache = null;
export function waveSchema() {
  waveSchemaCache ??= JSON.parse(readFileSync(join(here, '..', '..', 'contracts', 'wave-report.schema.json'), 'utf8'));
  return waveSchemaCache;
}

// Báo cáo đợt của analyst (contracts/wave-report.schema.json). items: các đề của đợt; known: mọi đề của backlog;
// textsOf(key): chữ của một đề (đề, MVS). Phụ thuộc phải có trích dẫn nguyên văn trong chữ của một trong hai đề;
// file dùng chung chỉ để nhắc thợ nên không cần trích dẫn. Trả về { problems }.
export function validateWave(report, { items = [], known = [], textsOf = () => [] } = {}) {
  const problems = validateSchema(report, waveSchema()).map(e => `schema ${e}`);
  if (problems.length) return { problems };
  const all = new Set([...known, ...items]), mine = new Set(items);
  const folded = new Map();
  const text = key => { if (!folded.has(key)) folded.set(key, fold(textsOf(key).filter(Boolean).join('\n'))); return folded.get(key); };
  report.dependencies.forEach((d, i) => {
    const where = `dependencies[${i}] (${d.item} needs ${d.needs})`;
    if (!all.has(d.item) || !all.has(d.needs)) problems.push(`${where}: both must be backlog items (${[d.item, d.needs].filter(k => !all.has(k)).join(', ')} is not)`);
    else if (d.item === d.needs) problems.push(`${where}: an item cannot need itself`);
    else if (injectionHeuristic(d.quote)) problems.push(`${where}: the quote is an instruction aimed at an AI agent; leave the entry out`);
    else if (!text(d.item).includes(fold(d.quote)) && !text(d.needs).includes(fold(d.quote))) {
      problems.push(`${where}: quote not found word for word in the text of ${d.item} or ${d.needs}: ${JSON.stringify(d.quote.slice(0, 80))}`);
    }
  });
  report.sharedAreas.forEach((a, i) => {
    const unknown = a.items.filter(k => !all.has(k));
    if (unknown.length) problems.push(`sharedAreas[${i}]: not backlog items: ${unknown.join(', ')}`);
    if (new Set(a.items).size !== a.items.length) problems.push(`sharedAreas[${i}]: an item is listed twice`);
    for (const f of a.files) if (/^([A-Za-z]:|[\\/])|(^|[\\/])\.\.([\\/]|$)/.test(f)) problems.push(`sharedAreas[${i}]: file ${JSON.stringify(f)} must be a relative path or a file name`);
  });
  const outside = report.landingOrder.filter(k => !mine.has(k));
  if (outside.length) problems.push(`landingOrder lists only the items of this wave (${items.join(', ')}); not in it: ${outside.join(', ')}`);
  return { problems };
}

// Cờ dùng trong helper. Chỉ `detection` được dùng để tắt một kiểm tra (mutants); các cờ khác bật hoặc mô tả.
export function profileFlags(profile) {
  const has = aspect => (profile?.grading ?? []).some(g => g.aspect === aspect);
  return { detection: has('detection'), typecheck: has('typecheck'), browserReplay: has('browser_replay'), mvsReplay: has('mvs_replay'),
    hiddenTests: has('hidden_tests'), teamTests: has('team_tests_pass'), completionOrder: has('completion_order'),
    exactFields: (profile?.deliverables?.answerFields ?? []).filter(f => f.exact).map(f => f.name),
    // Mục chấm có được khai (ít nhất một luật): chỉ khi đó sự vắng mặt của `detection` mới có nghĩa là "không chấm".
    gradingStated: (profile?.grading ?? []).length > 0 };
}

// Checklist: mỗi dòng là một điều kiểm được bằng code lúc candidate. id ổn định để ghi "đã từ chối một lần".
export function profileChecklist(profile, key) {
  const lines = [];
  for (const e of profile.evidence ?? []) {
    lines.push({ id: `evidence:${e.scenario ?? '-'}:${e.file}`, kind: 'evidence', scenario: e.scenario, file: e.file, beforeFix: e.beforeFix,
      text: `evidence/${e.file}${e.scenario ? ` for ${e.scenario} (cited in that row's evidence when you report PASS)` : ''}${e.beforeFix ? ', captured on the unfixed code' : ''}${e.kind === 'screenshot' ? ' — a real page, not a *.FAILED-step* capture' : ''}` });
  }
  for (const f of profile.deliverables?.answerFields ?? []) {
    lines.push({ id: `field:${f.name}`, kind: 'field', name: f.name, type: f.type, exact: f.exact,
      text: `submit.json ${f.name}: ${f.type}, filled${f.exact ? ', compared exactly (copy strings as found; write the file with node)' : ''}` });
  }
  for (const s of profile.deliverables?.sourceFiles ?? []) {
    lines.push({ id: `source:${s.path}`, kind: 'source', path: s.path, text: `${s.path} exists in your change` });
  }
  if (profile.deliverables?.testLocation) lines.push({ id: 'tests:location', kind: 'tests', location: profile.deliverables.testLocation, text: `new tests under ${profile.deliverables.testLocation}` });
  const flags = profileFlags(profile);
  if (flags.detection) lines.push({ id: 'detection:mutants', kind: 'mutants', text: 'run_checks {action: "mutants"} on your final source: graders run your tests against broken builds, each change needs a test that fails without it' });
  if (flags.typecheck) lines.push({ id: 'typecheck', kind: 'typecheck', text: 'the type check passes: the item grades it' });
  for (const id of profile.scenarios ?? []) lines.push({ id: `scenario:${id}`, kind: 'scenario', scenario: id, text: `${id} reported PASS, FAIL or NOT_RUN with what you observed (NOT_RUN scores nothing)` });
  return lines.map(l => ({ ...l, key }));
}

const jsonType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (v, t) => jsonType(v) === t || (t === 'number' && typeof v === 'number');
const empty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (jsonType(v) === 'object' && !Object.keys(v).length);

// Kiểm checklist trên bài đang bàn giao. answerDir: answers/<ID> của worktree; changed: đường dẫn (trong thư mục trận)
// item đã thêm/sửa; exists(path): file có trong worktree. Trả về [{ id, problem }]: chỉ những dòng chưa đạt mà code
// kiểm được chắc chắn (dòng mutants, typecheck, scenario do các gate sẵn có lo).
export function checklistProblems(profile, { answerDir, changed = [], exists = () => false } = {}) {
  const out = [];
  let submit = null;
  try { submit = JSON.parse(readFileSync(join(answerDir, 'submit.json'), 'utf8')); } catch { return out; }   // answerCheck báo lỗi này
  const rows = new Map((Array.isArray(submit?.testResults) ? submit.testResults : []).map(r => [r?.id, r]));
  const passed = id => /^pass$/i.test(String(rows.get(id)?.result ?? ''));
  for (const line of profileChecklist(profile, null)) {
    if (line.kind === 'evidence') {
      const there = existsSync(join(answerDir, 'evidence', line.file));
      if (line.scenario === null) {
        if (!there) out.push({ id: line.id, problem: `evidence/${line.file} is missing: the item requires it${line.beforeFix ? ' (captured on the unfixed code)' : ''}` });
      } else if (passed(line.scenario)) {
        const cited = (Array.isArray(rows.get(line.scenario)?.evidence) ? rows.get(line.scenario).evidence : []).some(e => String(e).split('/').pop() === line.file);
        if (!there) out.push({ id: line.id, problem: `${line.scenario} is PASS but evidence/${line.file} does not exist: capture it or report the scenario as observed` });
        else if (!cited) out.push({ id: line.id, problem: `${line.scenario} is PASS but its evidence does not cite evidence/${line.file}, which the item requires for it` });
      }
    } else if (line.kind === 'field') {
      if (!Object.hasOwn(submit ?? {}, line.name) || empty(submit[line.name])) out.push({ id: line.id, problem: `submit.json ${line.name} is empty: the item scores it${line.exact ? ' by exact comparison' : ''}` });
      else if (!typeOk(submit[line.name], line.type)) out.push({ id: line.id, problem: `submit.json ${line.name} must be ${line.type}, it is ${jsonType(submit[line.name])}` });
    } else if (line.kind === 'source') {
      const tail = line.path.replaceAll('\\', '/').replace(/^\.?\//, '');
      if (!changed.some(p => p === tail || p.endsWith(`/${tail}`)) && !exists(tail)) out.push({ id: line.id, problem: `${line.path} is not in your change: the item names this file` });
    }
  }
  return out;
}

// Khối brief: hồ sơ gọn cho worker, và checklist nó phải đạt trước candidate.
export function profileBlock(profile) {
  const f = profileFlags(profile);
  const w = profile.workload;
  return [
    `form: ${profile.form}`,
    `what to deliver: ${profile.summary}`,
    'how it is scored (each line is a rule the analyst quoted from the item):',
    ...profile.grading.map(g => `- ${g.aspect}: "${g.quote}"`),
    ...(profile.constraints.length ? ['constraints:', ...profile.constraints.map(c => `- ${c.rule}`)] : []),
    `work: investigation in ${w.investigation}; ${w.crossModule ? 'several modules' : 'one module'}; ${w.uiChange ? 'UI change' : 'no UI change'}; ${w.needsRunningApp ? 'needs the built app running' : 'no running app needed'}${w.officialData ? '; figures from the official test data replayed on your fixed source' : ''}`,
    f.gradingStated && !f.detection
      ? 'mutation check: not graded for this item (no rule says your tests are run against broken builds): do not run run_checks {action: "mutants"}.'
      : 'mutation check: run run_checks {action: "mutants"} before candidate.',
    'The analyst read the item for you; the item text below stays the source of truth when the two differ.',
  ].join('\n');
}

export function checklistBlock(lines) {
  return ['Every line must hold before worker_checkpoint candidate; candidate checks them and names the ones that fail.',
    ...lines.map((l, i) => `${i + 1}. ${l.text}`)].join('\n');
}
