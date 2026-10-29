// Đặc trưng khách quan của item cho triage: Jev chỉ đọc chữ của đề nên hay đoán độ khó dưới ngưỡng (practice-log L39:
// difficulty 0/5 lần đủ ngưỡng). Helper đếm từ đề, MVS và `git grep` trên checkout chính, gửi kèm state cho Jev, và
// dùng làm luật dự phòng cho difficulty. Không dependency, chỉ đọc matchRoot; lỗi thì bỏ phần code, không chặn start_work.
import { git } from './git.mjs';

const MAX_TERMS = 12;
// Từ khoá khớp quá nhiều file là từ chung chung (Dashboard, invoice…), không cho biết vùng code cần sửa.
const GENERIC_FILES = 40;
const SKIP_PATHS = [':(exclude)answers/**', ':(exclude)challenge/**', ':(exclude).team-work/**', ':(exclude).codegraph/**'];

const FLAGS = {
  externalSpec: /\bstandards?\b|internal systems?|\bauthoritative\b|company polic/i,
  dependencies: /package\.json|lock(?:file|\.ya?ml|\.json)|pom\.xml|requirements\.txt|\baudit\b|vulnerab|dependenc|\bupgrade/i,
  data: /migration|\bschema\b|database|persist|stored data|backfill|\bconstraint\b/i,
  tricky: /concurren|race condition|time ?zone|deadlock|\bcach(?:e|ing)\b|rounding|locale/i,
  security: /authenticat|signed[- ]out|unauthori[sz]ed|permission|access control|\bcsrf\b|\bxss\b/i,
  ui: /\b(?:screen|button|viewport|click|sidebar|dialog|modal|layout|wireframe|desktop|mobile)\b|→/i
};

// Phần nộp bài (mẫu submit.json, mã TC, PASS/FAIL, đường dẫn evidence) và Out of scope không nói gì về độ khó của code.
export function workText(text) {
  const out = [];
  let skip = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const h = line.match(/^\s*(#{1,6})\s+(.*)/);
    if (h && skip && h[1].length <= skip) skip = 0;
    if (h && !skip && /^(?:submission|out of scope)\b/i.test(h[2].trim())) skip = h[1].length;
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

// Đếm mục đánh số / gạch đầu dòng dưới heading "Acceptance criteria" (không có thì "Requirements").
export function countCriteria(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const name of [/acceptance criteria/i, /requirements/i]) {
    const at = lines.findIndex(l => /^\s*#{1,6}\s/.test(l) && name.test(l));
    if (at < 0) continue;
    let n = 0;
    for (const l of lines.slice(at + 1)) {
      if (/^\s*#{1,6}\s/.test(l)) break;
      if (/^\s*(?:\d+[.)]|[-*])\s+\S/.test(l)) n++;
    }
    if (n) return n;
  }
  return 0;
}

const CODE_LIKE = /[a-z][A-Z]|[a-z]_[a-z]|\/[\w.-]|\.(?:tsx?|jsx?|mjs|py|java|kt|cs|go|php|rb|sql|vue|svelte|ya?ml|toml|prisma)$/;

// Từ khoá có dáng code: **nhãn UI**, rồi `backtick`/camelCase/PascalCase/snake_case/đường dẫn/tên file mã nguồn. Bỏ mã TC,
// chữ hoa toàn phần (PASS, DONE), từ đơn (`result`) và đường dẫn nộp bài/evidence.
export function codeTerms(text) {
  const s = String(text ?? '');
  const found = [
    ...[...s.matchAll(/\*\*([^*\n]{3,40})\*\*/g)].map(m => m[1].trim()),
    ...[...s.matchAll(/`([^`\s]{3,60})`/g)].map(m => m[1]).filter(t => CODE_LIKE.test(t.replace(/[.,:;]+$/, ''))),
    ...(s.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []),
    ...(s.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? []),
    ...(s.match(/\b[\w-]+\.(?:tsx?|jsx?|mjs|py|java|kt|cs|go|php|rb|sql|vue|svelte)\b/g) ?? [])
  ];
  const out = [];
  for (const t of found) {
    const term = t.replace(/[.,:;]+$/, '');
    if (term.length < 3 || /^[A-Z0-9_-]+$/.test(term) || /^(?:answers|challenge|evidence)\b|submit(?:\.schema)?\.json|^https?:|\/$/i.test(term)) continue;
    if (!out.some(x => x.toLowerCase() === term.toLowerCase())) out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

async function grepFiles(root, term) {
  const res = await git(['grep', '-l', '-I', '-F', '-e', term, '--', '.', ...SKIP_PATHS], { cwd: root, timeoutMs: 5000, allowFail: true });
  return res.code === 0 ? res.out.split(/\r?\n/).filter(Boolean) : [];
}

export async function codeMatches(root, terms) {
  if (!root || !terms.length) return null;
  const hits = await Promise.all(terms.map(t => grepFiles(root, t).catch(() => [])));
  const used = [];
  const files = new Set();
  hits.forEach((list, i) => {
    if (!list.length || list.length > GENERIC_FILES) return;
    used.push(terms[i]);
    for (const f of list) files.add(f.replaceAll('\\', '/'));
  });
  const all = [...files];
  const modules = new Set(all.map(f => f.split('/').slice(0, 2).join('/')));
  return { terms: used, files: all.length, modules: modules.size, test_files: all.filter(f => /(?:^|[/._-])(?:tests?|spec|__tests__)(?:[/._-]|$)/i.test(f)).length,
    sample: all.slice(0, 5) };
}

// item: {title, description, startInstruction, points, deadlineMinutes}; root: checkout chính (null thì bỏ phần code).
export async function itemSignals(item, { root = null, scenarios = 0 } = {}) {
  const text = workText([item?.title, item?.description, item?.startInstruction].filter(Boolean).join('\n'));
  let code = null;
  try { code = await codeMatches(root, codeTerms(text)); } catch { code = null; }
  const criteria = countCriteria(item?.description);
  const flags = Object.entries(FLAGS).filter(([, re]) => re.test(text)).map(([k]) => k);
  // Chỉ cần nộp một câu trả lời (TASK-01 HIET12OA); TASK-02 cũng có "Answer format" nhưng có tiêu chí phải sửa code.
  if (!criteria && /^\s*#{1,6}\s+answer format\b/im.test(text)) flags.push('answerOnly');
  return {
    acceptance_criteria: criteria,
    verification_scenarios: scenarios,
    words: text.split(/\s+/).filter(Boolean).length,
    flags,
    points: item?.points ?? null,
    deadline_minutes: item?.deadlineMinutes ?? null,
    code
  };
}

// Luật dự phòng khi Jev dưới ngưỡng (trước đây luôn "medium"). easy chỉ khi chắc: câu trả lời thuần, hoặc grep thấy
// vùng code nhỏ. Chỉnh lại sau mỗi trận tập theo decisions.ndjson (rule vs jev).
export function difficultyFromSignals(type, s) {
  if (!s) return 'medium';
  const flags = new Set(s.flags ?? []);
  let score = type === 'CR' || type === 'PI' ? 1 : 0;
  if (s.acceptance_criteria >= 5) score++;
  if (s.verification_scenarios >= 6) score++;                  // HIET12OA: BUG 4–8, CR 10

  for (const f of ['externalSpec', 'dependencies', 'data', 'tricky']) if (flags.has(f)) score++;
  if (s.code && (s.code.files > 8 || s.code.modules > 3)) score++;
  if (flags.has('answerOnly')) score--;
  if (score >= 3) return 'hard';
  if (score <= 0 && (flags.has('answerOnly') || (s.code && s.code.files > 0 && s.code.files <= 3))) return 'easy';
  return 'medium';
}
