// Kiểm tất định answers/<ID>/submit.json, evidence bắt buộc và yêu cầu của đề (tách từ gate cũ). Kết quả chỉ báo lại
// (warnings của publish_item), không chặn nộp.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../core/git.mjs';
import { validateSchema } from '../core/jsonschema.mjs';

// Danh sách file đổi so với base (tracked + untracked, không tính file bị ignore).
export async function changedFiles(checkoutRoot, base) {
  const diff = await git(['diff', '--name-status', base, '--'], { cwd: checkoutRoot });
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], { cwd: checkoutRoot });
  const files = [];
  for (const line of diff.out.split(/\r?\n/).filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    files.push({ status: status[0], path: rest[rest.length - 1] });
  }
  for (const p of untracked.out.split(/\r?\n/).filter(Boolean)) {
    if (!p.startsWith('.team-work/')) files.push({ status: 'A', path: p });
  }
  return files;
}

// File mới nằm trong một answers/<ID>/ không ở gốc thư mục trận (vd <folder>/src/answers/TASK-06/). RATH0OHJ: TASK-06
// chạy script từ src/ ghi `answers/TASK-06/submit.json` tương đối, helper commit cả bản lạc đó lên main; từ đó mọi
// revision nộp có src/answers/ và grader đọc submit.json ở src/answers/<ID>/ (ENOENT), 7 item sau đều 0 điểm.
const STRAY_ANSWERS = /^.+\/answers\/[A-Z]+-\d+\//;
export function strayAnswers(files, folder) {
  return files.filter(f => f.status === 'A' && f.path.startsWith(`${folder}/`) && STRAY_ANSWERS.test(f.path.slice(folder.length + 1)))
    .map(f => f.path);
}

// Test ghi file vào đường dẫn tuyệt đối ngoài repo. QXUD1QAI BUG-11: `fs.writeFile('/bug-11-statement.qif')` chạy được
// trên Windows (thành D:\bug-11-statement.qif, 0,4 s) nhưng máy chấm Linux không cho ghi vào `/`; atomicWriteFile của
// Actual thử lại 20 lần, quá 5 s, team-tests 0/2. Chuỗi bị bắt: file ngay dưới gốc ('/x.qif') hay đường dẫn có ổ đĩa
// ('C:\\...', 'D:/...'), trong file test có lệnh ghi. Đường dẫn URL kiểu '/api/x' (không có đuôi file) không tính.
const WRITE_CALL = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|outputFile|mkdir|mkdirSync)\s*\(/;
const ABSOLUTE_LITERAL = /(['"`])(\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z]:[\\/][^'"`\r\n]*)\1/g;
export function absoluteTestWrites(text) {
  const source = String(text ?? '');
  if (!WRITE_CALL.test(source)) return [];
  return [...new Set([...source.matchAll(ABSOLUTE_LITERAL)].map(m => m[2]))];
}

const PASS = /^pass(ed)?$/i;
const FAIL = /^fail(ed)?$/i;
const EVIDENCE_FILE = /[A-Za-z0-9][\w.-]*\.(?:png|jpe?g|webp|gif|json|txt|log|md|csv|pdf|html?|xml|zip|webm|mp4)\b/gi;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, id) => new RegExp(`(^|[^\\w-])${escapeRe(id)}($|[^\\w-])`).test(text);

// Evidence bắt buộc của từng kịch bản trong MVS markdown của Start Work: mục có tiêu đề chứa id ("## BUG-01-TC-01"),
// dòng "Required evidence (screenshot): tc-01-desktop-dashboard.png and tc-01-mobile.png".
export function mvsEvidence(mvs, ids) {
  const out = new Map();
  if (typeof mvs !== 'string' || !ids.length) return out;
  let current = null;
  for (const line of mvs.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { current = ids.find(id => mentions(heading[1], id)) ?? null; continue; }
    const at = line.search(/required evidence/i);
    if (current && at >= 0) out.set(current, [...new Set([...(out.get(current) ?? []), ...(line.slice(at).match(EVIDENCE_FILE) ?? [])])]);
  }
  return out;
}

// Evidence mà mô tả item đòi ngoài MVS (ZVUYZ41V BUG-01: "Capture screenshot of Dashboard before fixing as
// dashboard_before_fixing.png" chỉ có ở mục Submission; thiếu file đó BTC chấm 0 cả item dù 3/3 kịch bản PASS).
// Lấy tên file trong câu nói tới chụp / evidence; bỏ tên nằm trong đường dẫn (challenge/BUG-01-submit.json,
// answers/BUG-01/submit.json) trừ evidence/<file>, bỏ file submit và file đề của BTC (`challengeFiles`, vd
// "Follow the evidence rules in `BUG-02-minimum-verification-scenarios.md`"). `beforeFix`: câu có "before" (không
// phải "before submitting") nên phải chụp trên code chưa sửa.
export function itemEvidence(description, challengeFiles = []) {
  if (typeof description !== 'string') return [];
  const own = new Set(challengeFiles.map(f => String(f).split(/[\\/]/).pop().toLowerCase()));
  const out = new Map();
  for (const sentence of description.split(/(?<=[.!?])\s+|\r?\n/)) {
    if (!/screenshot|capture|evidence/i.test(sentence)) continue;
    const beforeFix = /\bbefore\b(?!\s+submit)/i.test(sentence);
    for (const m of sentence.matchAll(EVIDENCE_FILE)) {
      const name = m[0];
      const inPath = /[\\/]$/.test(sentence.slice(0, m.index)) && !/evidence\/$/i.test(sentence.slice(0, m.index));
      if (inPath || own.has(name.toLowerCase()) || /submit(\.schema)?\.json$|minimum-verification-scenarios\.md$/i.test(name)) continue;
      out.set(name, { file: name, beforeFix: beforeFix || Boolean(out.get(name)?.beforeFix) });
    }
  }
  return [...out.values()];
}

// Yêu cầu của đề ngoài MVS (HIET12OA: "pnpm test passes" chỉ có ở Acceptance criteria, 3 item false green; ZVUYZ41V:
// ảnh "before fixing" chỉ có ở mục Submission, 0/200). BTC chấm theo cả đề, nên fixer khai từng yêu cầu.
// Lấy theo mục: Acceptance criteria → AC-n (mỗi dòng danh sách), Expected outcome / Requirements / Canonical scope /
// Normalization / Answer format → RQ-n, Submission / Evidence → EV-n (bỏ câu khuôn mẫu mà answerCheck đã kiểm: copy template,
// gitRevision, testResults, schema). Danh sách thì mỗi mục một yêu cầu, đoạn văn thì mỗi câu; bỏ bảng, code, điểm, hạn.
const REQ_SECTIONS = [
  [/^acceptance criteria$/i, 'AC'],
  [/^(expected outcome|requirements?|canonical scope|normali[sz]ation|answer format)$/i, 'RQ'],
  [/^(submission|evidence)$/i, 'EV']
];
const REQ_SKIP = /practice score|\bdeadline\b|\bpoints?\b\s*[.)]?$|^\s*(example row|desktop wireframe|screen flow)\b/i;
const EV_BOILERPLATE = /^create\s+`?answers\/|copy\s+`?challenge\/|gitRevision|testResults|submit\.schema|every pass result|commit source|upper case|start from the template|top-level `?status|example row|evidence paths are|engineering record|record actual test results|follow the evidence rules/i;
const REQ_MAX = 24;

export function itemRequirements(description) {
  if (typeof description !== 'string') return [];
  const out = [];
  const seen = new Set();
  const count = {};
  let prefix = null;
  let fence = false;
  let item = null;      // dòng danh sách đang gom (có thể kéo dài nhiều dòng)
  const push = (text, p = prefix) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!p || t.length < 12 || REQ_SKIP.test(t) || (p === 'EV' && EV_BOILERPLATE.test(t)) || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    count[p] = (count[p] ?? 0) + 1;
    out.push({ id: `${p}-${count[p]}`, text: t.length > 480 ? `${t.slice(0, 477)}...` : t });
  };
  const flush = () => { if (item !== null) push(item); item = null; };
  const sentences = line => line.split(/(?<=[.!?])\s+(?=[A-Z`"(])/);
  for (const raw of description.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    const heading = raw.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const title = heading[1].replace(/[`*_]/g, '').trim();
      // Tiêu đề con (### submit.json contract) thuộc mục cha trừ khi chính nó là một mục được lấy.
      const match = REQ_SECTIONS.find(([re]) => re.test(title));
      prefix = match ? match[1] : /^#{3,}/.test(raw) && prefix === 'EV' && !/submit\.json|contract/i.test(title) ? 'EV' : null;
      continue;
    }
    if (!prefix) continue;
    if (/^\s*\|/.test(raw) || !raw.trim()) { flush(); continue; }
    const li = raw.match(/^\s*(?:\d+[.)]|[-*+])\s+(.*)$/);
    if (li) { flush(); item = li[1]; continue; }
    if (item !== null && /^\s+\S/.test(raw)) { item += ` ${raw.trim()}`; continue; }
    flush();
    for (const s of sentences(raw.trim())) push(s);
  }
  flush();
  return out.slice(0, REQ_MAX);
}

// Đối chiếu bảng yêu cầu của fix-result (`requirements: [{id, status, evidence}]`) với yêu cầu của đề. Yêu cầu bị bỏ sót
// chỉ cảnh báo; status DONE trong khi fixer tự khai `not_met` là nói sai (J8), sửa submit.json
// thành PARTIAL là đủ nên đó là lỗi answer.
export function requirementsCheck(requirements = [], ledger = undefined, status = null) {
  const problems = [];
  const warnings = [];
  if (!requirements.length || ledger === undefined) return { problems, warnings };
  if (!Array.isArray(ledger)) {
    warnings.push(`fix-result has no requirements ledger: ${requirements.map(r => r.id).join(', ')} not checked`);
    return { problems, warnings };
  }
  const byId = new Map(ledger.filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
  const missing = requirements.filter(r => !byId.has(r.id)).map(r => r.id);
  if (missing.length) warnings.push(`requirements the fix-result does not address: ${missing.join(', ')}`);
  const notMet = requirements.filter(r => byId.get(r.id)?.status === 'not_met').map(r => r.id);
  if (notMet.length && status === 'DONE') {
    problems.push(`status is DONE but the fix-result reports ${notMet.join(', ')} not met: use PARTIAL and name them in engineeringRecord`);
  } else if (notMet.length) warnings.push(`requirements reported not met: ${notMet.join(', ')}`);
  return { problems, warnings };
}

// Kiểm answers/<ID>/submit.json: JSON hợp lệ, giữ key của template, khớp submit.schema.json của item (nếu có),
// status đã đổi khỏi giá trị ban đầu của template, mọi evidence/<file> tham chiếu đều tồn tại. Thêm (theo T1/T5 của
// harness tham chiếu, Practice #2 L19): mỗi kịch bản của template có đúng một kết quả, kịch bản PASS tham chiếu đủ
// evidence mà MVS đòi, và status khớp kết quả. `required` (itemEvidence của mô tả): file phải có trong evidence/ và
// trong evidenceFiles; thiếu file thì `missingEvidence` liệt kê.
export function answerCheck(matchRoot, key, template, schema = null, mvs = null, required = []) {
  const file = join(matchRoot, 'answers', key, 'submit.json');
  if (!existsSync(file)) return { problems: [`missing answers/${key}/submit.json`], warnings: [] };
  let answer;
  try { answer = JSON.parse(readFileSync(file, 'utf8')); } catch { return { problems: ['submit.json is not valid JSON'], warnings: [] }; }
  const problems = [];
  const warnings = [];
  if (template && typeof template === 'object') {
    for (const k of Object.keys(template)) if (!Object.hasOwn(answer, k)) problems.push(`submit.json lacks template key ${k}`);
    if (Object.hasOwn(template, 'status') && answer.status === template.status) {
      problems.push(`submit.json status is still the template value ${JSON.stringify(template.status)}`);
    }
  }
  if (schema) for (const e of validateSchema(answer, schema)) problems.push(`schema ${e}`);
  // Tham chiếu nằm trong câu văn: bỏ dấu câu dính cuối ("…/mvs-tests.log." FMC0ZXFC: answer_invalid sai 3 lần).
  for (const raw of JSON.stringify(answer).match(/evidence\/[^"\\\s]+/g) ?? []) {
    const ref = raw.replace(/[.,;:)\]}'`]+$/, '');
    const evidenceFile = join(matchRoot, 'answers', key, ref);
    if (!existsSync(evidenceFile)) problems.push(`missing ${ref}`);
  }
  if (/DRAFT/.test(JSON.stringify(answer.status ?? ''))) problems.push('submit.json status is still DRAFT');
  const missingEvidence = [];
  for (const { file: name, beforeFix } of required) {
    if (!existsSync(join(matchRoot, 'answers', key, 'evidence', name))) {
      missingEvidence.push(name);
      problems.push(`missing evidence/${name}: the item description requires it${beforeFix ? ' (captured on the unfixed code)' : ''}`);
    } else if (Array.isArray(answer.evidenceFiles) && !answer.evidenceFiles.some(e => String(e).split('/').pop() === name)) {
      problems.push(`evidenceFiles lacks evidence/${name}, which the item description requires`);
    }
  }

  const results = Array.isArray(answer.testResults) ? answer.testResults.filter(r => r && typeof r === 'object') : null;
  if (results) {
    const ids = (Array.isArray(template?.testResults) ? template.testResults : results).map(r => r?.id).filter(id => typeof id === 'string');
    for (const id of new Set(ids)) {
      const n = results.filter(r => r.id === id).length;
      if (n === 0) problems.push(`testResults lacks ${id}`);
      else if (n > 1) problems.push(`testResults has ${id} ${n} times`);
    }
    const required = mvsEvidence(mvs, [...new Set(ids)]);
    for (const r of results.filter(x => PASS.test(String(x.result ?? '')))) {
      const refs = new Set((Array.isArray(r.evidence) ? r.evidence : []).map(e => String(e).split('/').pop()));
      const missing = (required.get(r.id) ?? []).filter(name => !refs.has(name));
      if (missing.length) {
        problems.push(`${r.id} is PASS but its evidence lacks what the MVS requires: ${missing.map(m => `evidence/${m}`).join(', ')} (graders score the scenario 0 without it: cite that file when it already holds the passing run, rerun the scenario to it when it is stale, or report the scenario NOT_RUN; extra logs may stay next to it)`);
      }
      // capture_evidence đặt tên ảnh màn hình lúc bước hỏng là *.FAILED-step<N>.png: chẩn đoán, không phải evidence đạt.
      const diagnostics = [...refs].filter(name => /\.FAILED-step\d+\.png$/i.test(name));
      if (diagnostics.length) {
        problems.push(`${r.id} is PASS but cites ${diagnostics.map(d => `evidence/${d}`).join(', ')}, a screen captured at a failed step: capture the scenario again or report it FAIL/NOT_RUN`);
      }
    }
    const notPassed = results.filter(r => !PASS.test(String(r.result ?? ''))).map(r => r.id ?? '?');
    if (answer.status === 'DONE' && notPassed.length) {
      problems.push(`status is DONE but ${notPassed.join(', ')} did not PASS: use PARTIAL (or BLOCKED) and explain in engineeringRecord`);
    }
    if (answer.status === 'PARTIAL' && results.length && !notPassed.length) {
      warnings.push(`all ${results.length} testResults PASS but status is PARTIAL: use DONE unless a requirement outside the scenarios is unmet, and name it in engineeringRecord`);
    }
  }
  return { problems, warnings, ...(missingEvidence.length ? { missingEvidence } : {}) };
}

// Số kịch bản theo testResults của submit.json (PASS / FAIL / còn lại là chưa chạy); null khi không có testResults.
export function scenarioCounts(file) {
  try {
    const results = JSON.parse(readFileSync(file, 'utf8'))?.testResults;
    if (!Array.isArray(results) || !results.length) return null;
    const passed = results.filter(r => PASS.test(String(r?.result ?? ''))).length;
    const failed = results.filter(r => FAIL.test(String(r?.result ?? ''))).length;
    return { passed, failed, skipped: results.length - passed - failed };
  } catch {
    return null;
  }
}
