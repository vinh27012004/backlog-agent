// Gate rút gọn (05 §5.10, port một phần orchestrator/gate.py): diff → thay đổi cấm → build → test
// (so baseline) → answer. Dừng ở lỗi đầu tiên; số test là số thật đã chạy.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { contentTree, git } from './git.mjs';
import { runPwsh } from './jobs.mjs';
import { validateSchema } from './jsonschema.mjs';
import { condense, signature } from './logs.mjs';
import { SAFE_TARGET, rerunTargets, runTests } from './testreport.mjs';

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|Test\.java$/i;
const BUILD_FILES = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|go\.(mod|sum)|composer\.(json|lock)|[^/]+\.csproj)$/i;
const ALWAYS_FORBIDDEN = /(^|\/)(exam-info\.json|env-require\/.*|\.github\/.*|\.gitlab-ci\.yml)$/i;

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

// Kiểm answers/<ID>/submit.json: JSON hợp lệ, giữ key của template, khớp submit.schema.json của item (nếu có),
// status đã đổi khỏi giá trị ban đầu của template, mọi evidence/<file> tham chiếu đều tồn tại. Thêm (theo T1/T5 của
// harness tham chiếu, Practice #2 L19): mỗi kịch bản của template có đúng một kết quả, kịch bản PASS tham chiếu đủ
// evidence mà MVS đòi, và status khớp kết quả. `warnings` không chặn.
export function answerCheck(matchRoot, key, template, schema = null, mvs = null) {
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
  for (const ref of JSON.stringify(answer).match(/evidence\/[^"\\\s]+/g) ?? []) {
    if (!existsSync(join(matchRoot, 'answers', key, ref))) problems.push(`missing ${ref}`);
  }
  if (/DRAFT/.test(JSON.stringify(answer.status ?? ''))) problems.push('submit.json status is still DRAFT');

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
        problems.push(`${r.id} is PASS but its evidence lacks what the MVS requires: ${missing.map(m => `evidence/${m}`).join(', ')} (capture it or report the scenario as FAIL/NOT_RUN)`);
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
  return { problems, warnings };
}

export const answerProblems = (...args) => answerCheck(...args).problems;

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

// Đếm assertion trong một dòng code test (JS/TS, Java, Python, C#, Go, PHP).
const ASSERTION = /\b(?:expect|assert\w*|verify)\s*\(|\.(?:toBe|toEqual|toStrictEqual|toThrow\w*|rejects|resolves|toHaveBeenCalled\w*|toMatch\w*|toContain\w*|toHaveLength|toHaveProperty|toBeNull|toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeGreaterThan\w*|toBeLessThan\w*|should)\b|\bAssert\.\w+|\bassertThat\s*\(|^\s*assert\s|\bt\.(?:Error|Fatal)f?\s*\(|\$this->assert\w*\s*\(|\bpytest\.raises\b|\b(?:assert|require)\.\w+\s*\(/g;
const countAssertions = line => (line.match(ASSERTION) ?? []).length;

// File test chứa test fail sẵn ở baseline: lấy phần đường dẫn trước " > " (vitest/jest) hoặc "::" (pytest).
export function baselineTestFiles(failing = []) {
  const files = new Set();
  for (const name of failing) {
    const head = String(name).split(/ > |::/)[0].trim();
    if (TEST_FILE.test(head) || /\.(test|spec)\.|(^|\/)test_[^/]+\.py$/.test(head)) files.add(head.replaceAll('\\', '/'));
  }
  return [...files];
}

// Diff một file so với base (-U0): dòng thêm (số dòng mới → nội dung) và dòng bỏ. File mới chưa track thì cả file
// là dòng thêm. Dòng header chỉ có trước hunk đầu, nên dòng bỏ bắt đầu bằng "--" (comment SQL) không bị nhầm.
async function fileDiff(checkoutRoot, base, f) {
  const res = await git(['diff', '-U0', base, '--', f.path], { cwd: checkoutRoot, allowFail: true });
  const added = new Map();
  const removed = [];
  let n = 0;
  let inHunk = false;
  for (const line of res.out.split(/\r?\n/)) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = Number(h[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.set(n++, line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  if (!res.out && f.status === 'A') {
    try { readFileSync(join(checkoutRoot, f.path), 'utf8').split(/\r?\n/).forEach((l, i) => added.set(i + 1, l)); } catch { /* đã xoá */ }
  }
  return { added, removed };
}

// Bảo vệ test hiện có (Practice #1, L2): sửa file test chứa test fail sẵn, hoặc làm giảm số assertion
// trong file test đã có, là thay đổi cấm trừ khi root khai allowTestChange kèm lý do từ đề/chuẩn công ty.
async function testGuard(checkoutRoot, base, files, baseline) {
  const problems = [];
  const failingFiles = baselineTestFiles(baseline?.failing);
  for (const f of files.filter(x => x.status === 'M' && TEST_FILE.test(x.path))) {
    const hit = failingFiles.find(t => f.path === t || f.path.endsWith(`/${t}`));
    if (hit) problems.push(`${f.path}: modifies a test file whose test already failed at baseline (${hit}); fix the product instead`);
    const { added, removed } = await fileDiff(checkoutRoot, base, f);
    const before = removed.reduce((n, l) => n + countAssertions(l), 0);
    const after = [...added.values()].reduce((n, l) => n + countAssertions(l), 0);
    if (before > after) problems.push(`${f.path}: removes ${before - after} assertion(s)`);
  }
  return problems;
}

// ---------------------------------------------------------------- chất lượng test mới (mục 6)
// Theo rubric Q2/T4 và validate_test_blackbox.py của harness mẫu. Chặn: test mới không có assertion, assertion không
// thể fail. Cảnh báo: mock chính file đang sửa, nuốt lỗi trong test, assertion bị làm yếu, thêm retry/timeout.
const JS_TEST = /^\s*(?:it|test)(?:\.(?:concurrent|sequential|fails|skipIf\([^)]*\)|runIf\([^)]*\)))*\s*\(\s*(['"`])(.*?)\1/;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/;
const GO_TEST = /^func\s+(Test\w+)\s*\(/;
const PHP_TEST = /^\s*(?:public\s+)?function\s+(test\w*)\s*\(/;
const ANNOTATED = /^\s*(?:@(?:Test|ParameterizedTest|RepeatedTest)\b|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b)/;
const TAUTOLOGY = [
  /expect\s*\(\s*([^()]{1,80}?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /expect\s*\(\s*(?:true|1)\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/,
  /\bassert(?:Equals?|Same)\s*\(\s*([^,()]{1,80}?)\s*,\s*\1\s*\)/,
  /\bassertTrue\s*\(\s*(?:true|True|1)\s*\)/,
  /\bassertFalse\s*\(\s*(?:false|False|0)\s*\)/,
  /^\s*assert\s+(?:True|1)\s*(?:#.*)?$/
];
const SWALLOW = [
  /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|console\.\w+\([^)]*\);?)\s*)*\}/,
  /except\b[^:\n]*:\s*\n\s*(?:pass|\.\.\.)\s*$/m,
  /\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/
];
const RETRY = /\b(?:retry|retries|retryTimes)\s*[:(=]|@RepeatedTest|@Retry\b|@flaky\b|pytest\.mark\.flaky|\b(?:jest|vi)\.setTimeout\s*\(|\b(?:testTimeout|hookTimeout)\s*[:=]|,\s*\{\s*timeout\s*:\s*\d|this\.timeout\s*\(\s*\d/;
const RUNNER_CONFIG = /(^|\/)((vitest|jest|playwright)\.config\.[cm]?[jt]s|pytest\.ini|conftest\.py)$/;
const MOCK = /(?:vi|jest)\.(?:mock|doMock)\s*\(\s*['"]([^'"]+)['"]/g;
const STRONG = /\.(?:toBe|toEqual|toStrictEqual|toThrow\w*|toHaveBeenCalledWith|toMatchObject|toHaveLength|toContain\w*)\s*\(|\.rejects\b|\bassert(?:Equals?|Same|Throws|Raises|That|In)\s*\(|pytest\.raises/g;
const WEAK = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined)\s*\(\s*\)|\.not\.toBeNull\s*\(\s*\)|\bassert(?:NotNull|IsNotNone|True)\s*\(|^\s*assert\s+\w+\s*(?:is not None)?\s*$/gm;
const stripExt = p => p.replace(/\.[cm]?[jt]sx?$/, '');

// Các test khai báo trong file: [{line (từ 1), name, end}]. Thân test = từ dòng khai báo tới trước khai báo kế tiếp.
function testCases(lines, path) {
  const ext = path.split('.').pop().toLowerCase();
  const out = [];
  lines.forEach((line, i) => {
    let name = null;
    if (/^[cm]?[jt]sx?$/.test(ext)) name = line.match(JS_TEST)?.[2] ?? null;
    else if (ext === 'py') name = line.match(PY_TEST)?.[1] ?? null;
    else if (ext === 'go') name = line.match(GO_TEST)?.[1] ?? null;
    else if (ext === 'php') name = line.match(PHP_TEST)?.[1] ?? null;
    else if (ANNOTATED.test(line)) {
      const sig = lines.slice(i + 1, i + 6).find(l => /\w+\s*\(/.test(l) && !/^\s*[@[]/.test(l));
      name = sig?.match(/(\w+)\s*\(/)?.[1] ?? '?';
    }
    if (name !== null) out.push({ line: i + 1, name });
  });
  return out.map((t, i) => ({ ...t, end: out[i + 1]?.line ?? lines.length + 1 }));
}

// Đường dẫn module trong vi.mock/jest.mock, tương đối checkoutRoot, không đuôi. Alias "~/" và "@/" = <app>/src/.
function resolveSpec(spec, testPath, appRel) {
  if (spec.startsWith('.')) return stripExt(posix.join(posix.dirname(testPath), spec));
  if (/^[~@]\//.test(spec)) return stripExt(posix.join(appRel, 'src', spec.slice(2)));
  return null;
}

export async function testQuality(checkoutRoot, base, files, appRel) {
  const problems = [];
  const warnings = [];
  const product = files.filter(f => f.status !== 'D' && !TEST_FILE.test(f.path) && /\.[cm]?[jt]sx?$/.test(f.path)).map(f => stripExt(f.path));
  for (const f of files.filter(x => x.status !== 'D' && (TEST_FILE.test(x.path) || RUNNER_CONFIG.test(x.path)))) {
    const { added, removed } = await fileDiff(checkoutRoot, base, f);
    if (!added.size) continue;
    const plus = [...added.values()];
    const addedText = plus.join('\n');
    if (RETRY.test(addedText)) warnings.push(`${f.path}: adds a retry or a longer timeout instead of fixing the cause`);
    if (!TEST_FILE.test(f.path)) continue;
    let lines;
    try { lines = readFileSync(join(checkoutRoot, f.path), 'utf8').split(/\r?\n/); } catch { continue; }
    const fresh = testCases(lines, f.path).filter(t => added.has(t.line))
      .map(t => ({ ...t, body: lines.slice(t.line - 1, t.end - 1).join('\n') }));
    for (const t of fresh) {
      if (!new RegExp(ASSERTION.source, 'm').test(t.body)) problems.push(`${f.path}: new test "${t.name}" has no assertion`);
    }
    for (const line of plus) {
      if (TAUTOLOGY.some(re => re.test(line))) problems.push(`${f.path}: assertion can never fail: ${line.trim().slice(0, 100)}`);
    }
    if (SWALLOW.some(re => re.test(addedText) || fresh.some(t => re.test(t.body)))) {
      warnings.push(`${f.path}: a test swallows an error (empty catch / except: pass), so it cannot fail`);
    }
    for (const m of addedText.matchAll(MOCK)) {
      const target = resolveSpec(m[1], f.path, appRel);
      if (target && product.some(p => p === target || p === `${target}/index`)) warnings.push(`${f.path}: mocks ${m[1]}, the code this change fixes`);
    }
    const count = (re, xs) => xs.reduce((n, l) => n + (l.match(re) ?? []).length, 0);
    if (f.status === 'M' && count(STRONG, removed) > count(STRONG, plus) && count(WEAK, plus) > count(WEAK, removed)) {
      warnings.push(`${f.path}: replaces specific assertions with weaker ones (toBeDefined/toBeTruthy/assertNotNull)`);
    }
  }
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------- quét dòng code thêm vào (mục 4)
// Thứ test pass vẫn lọt mà người chấm thấy ngay (rubric dev V2/V3 và security_rules_core.py của harness mẫu): TODO,
// hàm chưa làm, debug, SQL ghép chuỗi, secret viết cứng, file rác trong thư mục trận. Chỉ cảnh báo, vào `findings`
// cho reviewer; chỉ xét dòng thêm, không quét cả repo.
const CODE_FILE = /\.([cm]?[jt]sx?|java|kt|cs|go|py|php|rb|sql|vue|svelte)$/i;
const SCAN = [
  { re: /(\/\/|\/\*|#|<!--|--)\s*(TODO|FIXME|HACK|XXX)\b/, msg: 'leaves a TODO/FIXME', product: true },
  { re: /throw\s+new\s+(Error|UnsupportedOperationException|NotImplementedException)\s*\(\s*['"]?[^)]*not\s*(yet\s*)?implemented|raise\s+NotImplementedError|panic\(\s*["']not implemented/i, msg: 'leaves an unimplemented stub', product: true },
  // Script dòng lệnh (seed của BTC, migration, tool) in ra là bình thường.
  { re: /\bconsole\.(log|debug|trace)\s*\(|^\s*debugger\s*;?\s*$|\bSystem\.out\.println\s*\(|\bvar_dump\s*\(|\bprintStackTrace\s*\(/, msg: 'leaves debug output', product: true,
    skipPath: /(^|\/)(scripts?|bin|prisma|seeds?|migrations?|tools?|cli)\// },
  // SQL viết hoa (SELECT ... FROM, INSERT INTO...) ghép bằng + hay ${}; template có tag ($queryRaw`...`, sql`...`) là
  // truy vấn có tham số nên bỏ qua. Viết hoa để "Select ${name}" trong giao diện không bị bắt nhầm.
  { re: /\$(queryRaw|executeRaw)Unsafe\s*\(|\b(SELECT\b[^;\n]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^;\n]*(['"]\s*\+\s*[\w(]|\$\{)|\.(execute|query)\s*\(\s*f["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b/,
    skip: /(\$queryRaw|\$executeRaw|\bsql|\bPrisma\.sql)\s*`/, msg: 'builds SQL from strings (injection risk); use parameters', product: true },
  { re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    skip: /process\.env|import\.meta\.env|os\.environ|getenv\(|CHANGE_ME|changeme|example|placeholder|<[^>]+>/i, msg: 'hard-codes a credential' },
  { re: /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[bpas]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: 'contains what looks like a real key or token' }
];
const JUNK_FILE = /(\.(bak|backup|orig|rej|tmp|swp)|~|[-.](backup|bak|old|copy)\d*)$|[-.](backup|bak)[-.]|(^|\/)(capture|scratch|debug|tmp|temp|try)[-_.][^/]*\.(m?[jt]s|ps1|py|sh|bat)$/i;

export async function codeScan(checkoutRoot, base, files, folder) {
  const warnings = [];
  for (const f of files.filter(x => x.status !== 'D' && x.path.startsWith(`${folder}/`) && !x.path.startsWith(`${folder}/answers/`))) {
    if (f.status === 'A' && JUNK_FILE.test(f.path)) {
      warnings.push(`${f.path}: looks like a backup or helper script left in the match folder (scratch belongs in .team-work/scratch/)`);
      continue;
    }
    if (!CODE_FILE.test(f.path) && !/\.(json|ya?ml|properties|env\.example|toml|ini)$/i.test(f.path)) continue;
    const test = TEST_FILE.test(f.path);
    const { added } = await fileDiff(checkoutRoot, base, f);
    for (const [line, text] of added) {
      for (const rule of SCAN) {
        if ((rule.product && (test || !CODE_FILE.test(f.path))) || rule.skipPath?.test(f.path) || !rule.re.test(text) || rule.skip?.test(text)) continue;
        warnings.push(`${f.path}:${line}: ${rule.msg}: ${text.trim().slice(0, 80)}`);
        break;
      }
    }
  }
  return warnings.slice(0, 15);
}

// Test của baseline không còn chạy (mục 7): biến mất hoặc chuyển sang skip. Có id thì so theo id, không thì theo tổng
// số. `accepted`: id đã được bỏ có lý do ở item khác (journal), không tính lại.
export function disappearedTests(baseline, run, accepted = []) {
  const skip = new Set(accepted);
  if (baseline?.tests && run?.report) {
    return Object.entries(baseline.tests)
      .filter(([id, s]) => s !== 'skipped' && !skip.has(id) && ['missing', 'skipped'].includes(run.report.tests.get(id) ?? 'missing'))
      .map(([id]) => id);
  }
  const before = baseline?.counts?.total;
  const now = run?.counts?.total;
  if (Number.isFinite(before) && Number.isFinite(now) && now < before - skip.size) return [`${before - now} of ${before} baseline tests`];
  return [];
}

// Mục 5: chạy test của item trên code chưa sửa (probe ở base). Test mới (không có trong baseline) vẫn pass ở đó thì
// nó không tái hiện lỗi / không kiểm thay đổi. Chỉ cảnh báo: root gửi lại cho fixer, reviewer nhận làm gate finding.
async function failBefore(probe, { base, files, folder, checkoutRoot, matchRoot, profile, addedRun, baseline, targets, logFile, timeoutMs }) {
  const check = { name: 'fail-before' };
  const known = baseline?.tests ?? {};
  const fresh = addedRun.report ? [...addedRun.report.tests].filter(([id, s]) => s === 'passed' && !Object.hasOwn(known, id)).map(([id]) => id) : null;
  if (fresh && !fresh.length) return { ...check, status: 'skipped', reason: 'no new test among the declared ones (only existing tests changed)' };
  if (!(await probe.ready(90_000))) return { ...check, status: 'skipped', reason: probe.error ?? 'probe worktree not ready yet' };
  const copies = files.filter(f => f.status !== 'D' && TEST_FILE.test(f.path) && !f.path.startsWith(`${folder}/answers/`))
    .map(f => ({ path: f.path, from: join(checkoutRoot, f.path) }));
  try {
    const run = await probe.run(base, copies, probeMatch => runTests({ ...profile, root: join(probeMatch, relative(matchRoot, profile.root)) },
      'test_one', { targets, logFile, timeoutMs }));
    const passed = fresh && run.report ? fresh.filter(id => run.report.tests.get(id) === 'passed')
      : run.res.code === 0 ? ['every declared test'] : [];
    return { ...check, status: passed.length ? 'warn' : 'ok', source: run.source, ...(fresh ? { newTests: fresh.length } : {}),
      ...(passed.length ? { warnings: [`passes on the unfixed code, so it does not reproduce the problem: ${passed.slice(0, 5).join('; ')}`] } : {}) };
  } catch (error) {
    return { ...check, status: 'skipped', reason: String(error?.message ?? error).slice(0, 160) };
  }
}

// Chữ ký khi log không cho chữ ký nào: loại lỗi + dòng đáng chú ý đầu tiên (số thay bằng N), để vẫn đếm được lặp lại.
const fallbackSignature = (kind, text, root) => {
  const first = condense(text, { maxLines: 1, root }).split('\n')[0].replace(/\d+/g, 'N').trim().slice(0, 120);
  return first ? `${kind}:${first}` : kind;
};

export async function runGate(job, { key, checkoutRoot, matchRoot, folder, profile, base, baseline, template, schema = null, mvs = null,
  needsDependency = false, testsAdded = [], allowTestChange = null, acceptedRemovals = [], probe = null, logDir, limits }) {
  const checks = [];
  const result = { passed: false, failKind: null, signature: null, checks, regression: null, testsAdded: null };
  // Mọi cảnh báo (check "warn") gom vào `findings` để root đưa cho reviewer trong <gate_findings>.
  const finish = () => {
    const findings = checks.filter(c => c.status === 'warn').flatMap(c => (c.warnings ?? c.problems ?? []).map(w => `${c.name}: ${w}`));
    if (findings.length) result.findings = findings.slice(0, 20);
    return result;
  };
  // `signature` (port orchestrator/logs.py) giữ nguyên qua các lần thử cùng một lỗi; tools.mjs đếm số lần lặp.
  // answer_invalid không có chữ ký: sửa submit.json không cần lượt fixer mới.
  const done = (kind, detail, sig = kind) => {
    result.failKind = kind;
    result.signature = kind === 'answer_invalid' ? null : sig;
    if (detail) result.detail = detail;
    return finish();
  };
  const log = name => join(logDir, `${key}-gate-${job.id}-${name}.log`);
  const excerpt = (text, maxLines = 15) => condense(text, { maxLines, maxChars: 2000, root: profile.root });
  const pathOf = problem => problem.split(': ')[0];
  const justified = Boolean(allowTestChange?.reason && allowTestChange?.source);
  const testChangeHint = 'If the item text or a company standard says the old test is wrong, rerun with allowTestChange {reason, source} and quote it in the answer.';

  job.progress.push('diff');
  const files = await changedFiles(checkoutRoot, base);
  const code = files.filter(f => !f.path.startsWith(`${folder}/answers/${key}/`));
  checks.push({ name: 'diff', status: 'ok', files: files.length });
  if (files.length === 0) return done('no_change', 'no changes');
  if (code.length > limits.maxFiles) return done('diff_too_large', `${code.length} files > ${limits.maxFiles}`);

  const forbidden = [];
  for (const f of files) {
    if (!f.path.startsWith(`${folder}/`)) forbidden.push(`${f.path}: outside ${folder}/`);
    else if (ALWAYS_FORBIDDEN.test(f.path)) forbidden.push(`${f.path}: protected file`);
    else if (f.status === 'D' && TEST_FILE.test(f.path)) forbidden.push(`${f.path}: deletes a test`);
    else if (BUILD_FILES.test(f.path) && !needsDependency) forbidden.push(`${f.path}: build/dependency file (set needsDependency)`);
    else if (new RegExp(`^${folder}/(evidence|challenge/evidence)/`).test(f.path)) forbidden.push(`${f.path}: forbidden evidence folder`);
  }
  if (profile?.forbiddenSkip?.length) {
    const diff = await git(['diff', base, '--', ...files.filter(f => TEST_FILE.test(f.path) && f.status !== 'D').map(f => f.path)], { cwd: checkoutRoot, allowFail: true });
    for (const line of diff.out.split(/\r?\n/)) {
      if (line.startsWith('+') && !line.startsWith('+++') && profile.forbiddenSkip.some(m => line.includes(m))) {
        forbidden.push(`adds skip marker: ${line.slice(1, 120).trim()}`);
      }
    }
  }
  checks.push({ name: 'forbidden', status: forbidden.length ? 'fail' : 'ok', ...(forbidden.length ? { problems: forbidden } : {}) });
  if (forbidden.length) return done('forbidden_change', forbidden.join('; '), `forbidden:${pathOf(forbidden[0])}`);

  job.progress.push('tests-guard');
  const guard = await testGuard(checkoutRoot, base, files, baseline);
  checks.push({ name: 'tests-guard', status: !guard.length ? 'ok' : justified ? 'warn' : 'fail',
    ...(guard.length ? { problems: guard } : {}), ...(guard.length && justified ? { justification: allowTestChange } : {}) });
  if (guard.length && justified) result.testChangeJustification = allowTestChange;
  if (guard.length && !justified) return done('forbidden_change', `${guard.join('; ')}. ${testChangeHint}`, `forbidden:${pathOf(guard[0])}`);

  job.progress.push('test-quality');
  const appRel = relative(checkoutRoot, profile.root ?? matchRoot).replaceAll('\\', '/');
  const quality = await testQuality(checkoutRoot, base, files, appRel);
  checks.push({ name: 'test-quality', status: quality.problems.length ? 'fail' : quality.warnings.length ? 'warn' : 'ok',
    ...(quality.problems.length ? { problems: quality.problems } : {}), ...(quality.warnings.length ? { warnings: quality.warnings } : {}) });
  if (quality.problems.length) return done('weak_test', quality.problems.join('; '), `weak_test:${pathOf(quality.problems[0])}`);

  job.progress.push('code-scan');
  const scan = await codeScan(checkoutRoot, base, files, folder);
  checks.push({ name: 'code-scan', status: scan.length ? 'warn' : 'ok', ...(scan.length ? { warnings: scan } : {}) });

  const c = profile.commands;
  const cwd = profile.root;
  const logSignature = (kind, res, name) => (res.timedOut ? `timeout:${name}`
    : signature(res.tail, { root: cwd }) ?? fallbackSignature(kind, res.tail, cwd));
  for (const name of ['typecheck', 'build']) {
    if (!c[name]) continue;
    job.progress.push(name);
    const res = await runPwsh(c[name], { cwd, timeoutMs: limits.buildMs, logFile: log(name), tailBytes: 64 * 1024 });
    checks.push({ name, status: res.code === 0 ? 'ok' : 'fail', seconds: Math.round(res.ms / 1000),
      ...(res.code ? { tail: excerpt(res.tail) } : {}) });
    if (res.code !== 0) return done('compile', `${name} failed`, logSignature('compile', res, name));
  }

  // Test fixer khai: phải pass với bản sửa. Fail thì chạy lại một lần (mục 10, như gate Python cũ): pass lần hai là flaky.
  const targets = testsAdded.filter(t => SAFE_TARGET.test(t));
  let addedRun = null;
  if (targets.length && c.test_one) {
    job.progress.push('tests-added');
    addedRun = await runTests(profile, 'test_one', { targets, logFile: log('tests-added'), timeoutMs: limits.testMs });
    let flaky = false;
    if (addedRun.res.code !== 0 && !addedRun.res.timedOut) {
      const again = await runTests(profile, 'test_one', { targets, logFile: log('tests-added-rerun'), timeoutMs: limits.testMs });
      if (again.res.code === 0) { flaky = true; addedRun = again; }
    }
    const res = addedRun.res;
    result.testsAdded = addedRun.counts;
    checks.push({ name: 'tests-added', status: res.code !== 0 ? 'fail' : flaky ? 'warn' : 'ok', counts: result.testsAdded, source: addedRun.source,
      ...(flaky ? { warnings: ['failed once, then passed on rerun (flaky)'] } : {}), ...(res.code ? { tail: excerpt(res.tail) } : {}) });
    if (res.code !== 0) return done('original_still_failing', 'declared tests fail', logSignature('original_still_failing', res, 'tests-added'));
  }

  if (c.test_all) {
    job.progress.push('regression');
    const run = await runTests(profile, 'test_all', { logFile: log('regression'), timeoutMs: limits.testMs });
    const { res } = run;
    const known = new Set(baseline?.failing ?? []);
    let fresh = run.failing.filter(t => !known.has(t));
    let flaky = [];
    // Mục 10: test mới fail được chạy lại một lần; lần hai pass thì là flaky (cảnh báo), không tốn một lượt fixer.
    if (fresh.length && !res.timedOut && c.test_one) {
      const again = rerunTargets(fresh, profile);
      if (again.length) {
        job.progress.push('regression-rerun');
        const rerun = await runTests(profile, 'test_one', { targets: again, logFile: log('regression-rerun'), timeoutMs: limits.testMs });
        const still = rerun.report ? fresh.filter(id => rerun.report.tests.get(id) !== 'passed') : rerun.res.code === 0 ? [] : fresh;
        flaky = fresh.filter(id => !still.includes(id));
        fresh = still;
      }
    }
    result.regression = run.counts;
    // Test fail sẵn từ lúc chuẩn bị: không phải do bản sửa, root không được tính vào kịch bản fail.
    result.baselineFailures = run.failing.filter(t => known.has(t));
    const regressed = res.timedOut || fresh.length > 0 || (res.code !== 0 && run.failing.length === 0);
    checks.push({ name: 'regression', status: regressed ? 'fail' : flaky.length ? 'warn' : 'ok', counts: run.counts, source: run.source,
      timedOut: res.timedOut, ...(flaky.length ? { warnings: [`failed, then passed on rerun (flaky): ${flaky.slice(0, 5).join('; ')}`] } : {}),
      ...(regressed ? { newFailures: fresh.slice(0, 20), tail: excerpt(res.tail, 20) } : {}) });
    // Chữ ký regression theo tên các test mới fail: log còn có lỗi của test fail sẵn, lấy theo log sẽ lẫn.
    if (regressed) {
      const sig = res.timedOut ? 'timeout:regression'
        : fresh.length ? `regression:${[...fresh].sort().slice(0, 3).join(' | ').slice(0, 200)}` : logSignature('regression', res, 'regression');
      return done(res.timedOut ? 'timeout' : 'regression', fresh.slice(0, 5).join('; ') || 'test command failed', sig);
    }

    // Mục 7 (test_case_disappeared của harness mẫu): test chạy ở baseline mà nay biến mất hay bị skip trông y như pass.
    const gone = disappearedTests(baseline, run, acceptedRemovals);
    checks.push({ name: 'tests-kept', status: !gone.length ? 'ok' : justified ? 'warn' : 'fail',
      compared: baseline?.tests && run.report ? 'ids' : 'counts', ...(gone.length ? { problems: gone.slice(0, 20) } : {}) });
    if (gone.length && justified) result.removedTests = gone;
    if (gone.length && !justified) {
      return done('forbidden_change', `tests that ran at baseline no longer run: ${gone.slice(0, 5).join('; ')}. ${testChangeHint}`, `tests-removed:${gone[0]}`);
    }
  }

  // Build và test đã pass: lưu tree của đúng nội dung vừa kiểm (trừ answers/<ID>/, còn được sửa tiếp). worktree
  // integrate và commit_and_push chỉ nhận nội dung có tree này (hard gate). Tính sau khi build/test chạy để file
  // chính gate sinh ra (nếu repo không ignore) cũng nằm trong đó.
  result.codePassed = true;
  result.tree = await contentTree(checkoutRoot, folder, [`${folder}/answers/${key}`]);

  if (probe && addedRun) {
    job.progress.push('fail-before');
    checks.push(await failBefore(probe, { base, files, folder, checkoutRoot, matchRoot, profile, addedRun, baseline, targets,
      logFile: log('fail-before'), timeoutMs: limits.testMs }));
  }

  const { problems, warnings } = answerCheck(matchRoot, key, template, schema, mvs);
  checks.push({ name: 'answer', status: problems.length ? 'fail' : warnings.length ? 'warn' : 'ok', schema: Boolean(schema),
    ...(problems.length ? { problems } : {}), ...(warnings.length ? { warnings } : {}) });
  if (problems.length) return done('answer_invalid', problems.join('; '));

  result.passed = true;
  return finish();
}
