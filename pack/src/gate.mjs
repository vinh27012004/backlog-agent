// Gate rút gọn (05 §5.10, port một phần orchestrator/gate.py): diff → thay đổi cấm → build → test
// (so baseline) → answer. Dừng ở lỗi đầu tiên; số test là số thật đã chạy.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failingTests, parseTestCounts } from './environment.mjs';
import { git } from './git.mjs';
import { runPwsh } from './jobs.mjs';
import { validateSchema } from './jsonschema.mjs';

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|Test\.java$/i;
const BUILD_FILES = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|go\.(mod|sum)|composer\.(json|lock)|[^/]+\.csproj)$/i;
const ALWAYS_FORBIDDEN = /(^|\/)(exam-info\.json|env-require\/.*|\.github\/.*|\.gitlab-ci\.yml)$/i;

const lastLines = (text, n = 12) => String(text).trim().split(/\r?\n/).slice(-n).join('\n');

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

// Kiểm answers/<ID>/submit.json: JSON hợp lệ, giữ key của template, khớp submit.schema.json của item (nếu có),
// status đã đổi khỏi giá trị ban đầu của template, mọi evidence/<file> tham chiếu đều tồn tại.
export function answerProblems(matchRoot, key, template, schema = null) {
  const file = join(matchRoot, 'answers', key, 'submit.json');
  if (!existsSync(file)) return [`missing answers/${key}/submit.json`];
  let answer;
  try { answer = JSON.parse(readFileSync(file, 'utf8')); } catch { return ['submit.json is not valid JSON']; }
  const problems = [];
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
  return problems;
}

// Đếm assertion trong một dòng code test (JS/TS, Java, Python, C#, Go, PHP).
const ASSERTION = /\b(?:expect|assert\w*|verify)\s*\(|\.(?:toBe|toEqual|toStrictEqual|toThrow\w*|rejects|resolves|toHaveBeenCalled\w*|toMatch\w*|toContain\w*|toHaveLength|toHaveProperty|toBeNull|toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeGreaterThan\w*|toBeLessThan\w*|should)\b|\bAssert\.\w+|\bassertThat\s*\(|^\s*assert\s|\bt\.(?:Error|Fatal)f?\s*\(|\$this->assert\w*\s*\(/g;
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

// Bảo vệ test hiện có (Practice #1, L2): sửa file test chứa test fail sẵn, hoặc làm giảm số assertion
// trong file test đã có, là thay đổi cấm trừ khi root khai allowTestChange kèm lý do từ đề/chuẩn công ty.
async function testGuard(checkoutRoot, base, files, baseline) {
  const problems = [];
  const failingFiles = baselineTestFiles(baseline?.failing);
  for (const f of files.filter(x => x.status === 'M' && TEST_FILE.test(x.path))) {
    const hit = failingFiles.find(t => f.path === t || f.path.endsWith(`/${t}`));
    if (hit) problems.push(`${f.path}: modifies a test file whose test already failed at baseline (${hit}); fix the product instead`);
    const diff = await git(['diff', base, '--', f.path], { cwd: checkoutRoot, allowFail: true });
    let removed = 0, added = 0;
    for (const line of diff.out.split(/\r?\n/)) {
      if (line.startsWith('-') && !line.startsWith('---')) removed += countAssertions(line.slice(1));
      if (line.startsWith('+') && !line.startsWith('+++')) added += countAssertions(line.slice(1));
    }
    if (removed > added) problems.push(`${f.path}: removes ${removed - added} assertion(s)`);
  }
  return problems;
}

export async function runGate(job, { key, checkoutRoot, matchRoot, folder, profile, base, baseline, template, schema = null,
  needsDependency = false, testsAdded = [], allowTestChange = null, logDir, limits }) {
  const checks = [];
  const result = { passed: false, failKind: null, checks, regression: null, testsAdded: null };
  const done = (kind, detail) => { result.failKind = kind; if (detail) result.detail = detail; return result; };
  const log = name => join(logDir, `${key}-gate-${job.id}-${name}.log`);

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
  if (forbidden.length) return done('forbidden_change', forbidden.join('; '));

  job.progress.push('tests-guard');
  const guard = await testGuard(checkoutRoot, base, files, baseline);
  const justified = guard.length && allowTestChange?.reason && allowTestChange?.source;
  checks.push({ name: 'tests-guard', status: !guard.length ? 'ok' : justified ? 'warn' : 'fail',
    ...(guard.length ? { problems: guard } : {}), ...(justified ? { justification: allowTestChange } : {}) });
  if (justified) result.testChangeJustification = allowTestChange;
  if (guard.length && !justified) {
    return done('forbidden_change', `${guard.join('; ')}. If the item text or a company standard says the old test is wrong, rerun with allowTestChange {reason, source} and quote it in the answer.`);
  }

  const c = profile.commands;
  const cwd = profile.root;
  for (const name of ['typecheck', 'build']) {
    if (!c[name]) continue;
    job.progress.push(name);
    const res = await runPwsh(c[name], { cwd, timeoutMs: limits.buildMs, logFile: log(name) });
    checks.push({ name, status: res.code === 0 ? 'ok' : 'fail', seconds: Math.round(res.ms / 1000),
      ...(res.code ? { tail: lastLines(res.tail) } : {}) });
    if (res.code !== 0) return done('compile', `${name} failed`);
  }

  if (testsAdded.length && c.test_one) {
    const safe = testsAdded.filter(t => /^[A-Za-z0-9_./\\:#-]{1,200}$/.test(t)).slice(0, 10);
    job.progress.push('tests-added');
    const res = await runPwsh(c.test_one.replace('{target}', safe.map(t => `'${t}'`).join(' ')),
      { cwd, timeoutMs: limits.testMs, logFile: log('tests-added'), tailBytes: 64 * 1024 });
    result.testsAdded = parseTestCounts(res.tail);
    checks.push({ name: 'tests-added', status: res.code === 0 ? 'ok' : 'fail', counts: result.testsAdded,
      ...(res.code ? { tail: lastLines(res.tail) } : {}) });
    if (res.code !== 0) return done('original_still_failing', 'declared tests fail');
  }

  if (c.test_all) {
    job.progress.push('regression');
    const res = await runPwsh(c.test_all, { cwd, timeoutMs: limits.testMs, logFile: log('regression'), tailBytes: 64 * 1024 });
    const counts = parseTestCounts(res.tail);
    const failing = res.code === 0 ? [] : failingTests(res.tail);
    const known = new Set(baseline?.failing ?? []);
    const fresh = failing.filter(t => !known.has(t));
    result.regression = counts;
    // Test fail sẵn từ lúc chuẩn bị: không phải do bản sửa, root không được tính vào kịch bản fail.
    result.baselineFailures = failing.filter(t => known.has(t));
    const regressed = res.timedOut || (res.code !== 0 && (fresh.length > 0 || failing.length === 0));
    checks.push({ name: 'regression', status: regressed ? 'fail' : 'ok', counts, timedOut: res.timedOut,
      ...(regressed ? { newFailures: fresh.slice(0, 20), tail: lastLines(res.tail, 20) } : {}) });
    if (regressed) return done(res.timedOut ? 'timeout' : 'regression', fresh.slice(0, 5).join('; ') || 'test command failed');
  }

  const problems = answerProblems(matchRoot, key, template, schema);
  checks.push({ name: 'answer', status: problems.length ? 'fail' : 'ok', schema: Boolean(schema), ...(problems.length ? { problems } : {}) });
  if (problems.length) return done('answer_invalid', problems.join('; '));

  result.passed = true;
  return result;
}
