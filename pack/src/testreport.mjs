// Kết quả test máy đọc (ý tưởng từ verify-unit-test-* của harness mẫu): chạy test với reporter JSON/JUnit để có
// danh sách test kèm trạng thái, thay cho regex trên đuôi log. Không có reporter (stack lạ, script test ghép nhiều lệnh,
// file báo cáo không được ghi) thì quay về đọc log như cũ. Định dạng JSON của vitest 3.2 đã đối chiếu bằng lần chạy thật.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runPwsh } from './jobs.mjs';

export const SAFE_TARGET = /^[A-Za-z0-9_./\\:#-]{1,200}$/;

// Đếm test từ output của các runner phổ biến. Không đọc được thì trả null (không bịa số).
export function parseTestCounts(text) {
  const t = String(text);
  let m = t.match(/Tests\s+(.+?)\(\s*(\d+)\s*\)/);          // vitest: "Tests  10 passed | 2 failed (12)"
  if (m) {
    const part = m[1];
    const n = re => Number((part.match(re) ?? [])[1] ?? 0);
    const passed = n(/(\d+)\s+passed/), failed = n(/(\d+)\s+failed/), skipped = n(/(\d+)\s+skipped/) + n(/(\d+)\s+todo/);
    return { total: Number(m[2]), passed, failed, skipped };
  }
  m = t.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/);   // jest
  if (m) return { total: Number(m[4]), failed: Number(m[1] ?? 0), skipped: Number(m[2] ?? 0), passed: Number(m[3] ?? 0) };
  m = t.match(/=+\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped)?.*?in\s+[\d.]+s/);    // pytest
  if (m && (m[1] || m[2])) {
    const failed = Number(m[1] ?? 0), passed = Number(m[2] ?? 0), skipped = Number(m[3] ?? 0);
    return { total: failed + passed + skipped, passed, failed, skipped };
  }
  m = t.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g);             // maven
  if (m) {
    const last = m[m.length - 1].match(/(\d+)\D+(\d+)\D+(\d+)\D+(\d+)/);
    const total = Number(last[1]), failed = Number(last[2]) + Number(last[3]), skipped = Number(last[4]);
    return { total, failed, skipped, passed: total - failed - skipped };
  }
  return null;
}

// Tên test fail (vitest/jest: dòng "FAIL  path > suite > name" hoặc "× name").
export function failingTests(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:FAIL|×|✕)\s+(.+?)(?:\s+\d+ms)?\s*$/);
    if (m && !/Tests?\s+\d/.test(m[1])) out.add(m[1].trim().slice(0, 200));
  }
  return [...out].slice(0, 100);
}

const quote = s => `'${String(s).replaceAll("'", "''")}'`;
const posix = p => p.replaceAll('\\', '/');

// Thay {target} bằng các test cần chạy (đã lọc an toàn): maven nhận danh sách phẩy, gradle lặp --tests.
export function fillTargets(command, targets, stack, limit = 10) {
  const safe = [...new Set(targets)].filter(t => SAFE_TARGET.test(t)).slice(0, limit);
  if (stack === 'java-maven') return command.replace('{target}', quote(safe.join(',')));
  if (command.includes('--tests {target}')) return command.replace('--tests {target}', safe.map(t => `--tests ${quote(t)}`).join(' '));
  return command.replace('{target}', safe.map(quote).join(' '));
}

// Script `test` của package.json kết thúc bằng chính runner (vd "vitest run", "dotenv -e .env.test -- jest"): tham số
// thêm vào `pnpm test ...` mới tới được runner. Script ghép kiểu "vitest run && node check.js" thì không.
export function scriptEndsWithRunner(script, runner) {
  if (!script || !runner) return false;
  const last = String(script).split(/&&|\|\||;|\|/).pop().trim().split(/\s+/);
  const skip = new Set(['cross-env', 'dotenv', 'env', 'npx', 'pnpm', 'yarn', 'exec', '--', '-e']);
  let i = 0;
  while (i < last.length && (skip.has(last[i]) || /^[A-Z_][A-Z0-9_]*=/.test(last[i]) || /^\.env/.test(last[i]))) i++;
  return last[i] === runner;
}

// Lệnh chạy test kèm reporter máy đọc. `kind`: test_all | test_one. Trả {command, format, file?, dir?} hoặc null
// khi profile không có lệnh đó; format null = chỉ có log.
export function testCommand(profile, kind, file, targets = null) {
  const base = profile?.commands?.[kind];
  if (!base) return null;
  const one = cmd => (kind === 'test_one' ? fillTargets(cmd, targets ?? [], profile.stack) : cmd);
  const insert = flags => (kind === 'test_one' ? one(base.replace('{target}', `${flags} {target}`)) : `${base} ${flags}`);
  if (profile.stack === 'node' && ['vitest', 'jest'].includes(profile.testRunner)) {
    const flags = profile.testRunner === 'vitest'
      ? `--reporter=default --reporter=json --outputFile.json=${quote(file)}` : `--json --outputFile=${quote(file)}`;
    if (kind === 'test_all') {
      if (!scriptEndsWithRunner(profile.testScript, profile.testRunner)) return { command: base, format: null };
      return { command: `${base}${profile.packageManager === 'npm' ? ' --' : ''} ${flags}`, format: 'jest-json', file };
    }
    return { command: insert(flags), format: 'jest-json', file };
  }
  if (profile.stack === 'python') return { command: insert(`--junitxml=${quote(file)}`), format: 'junit', file };
  if (profile.stack === 'php') return { command: insert(`--log-junit ${quote(file)}`), format: 'junit', file };
  if (profile.stack === 'java-maven') return { command: one(base), format: 'junit-dir', dir: join('target', 'surefire-reports') };
  if (profile.stack === 'java-gradle') return { command: one(base), format: 'junit-dir', dir: join('build', 'test-results', 'test') };
  return { command: one(base), format: null };
}

const STATUS = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped', todo: 'skipped', disabled: 'skipped' };

// JSON của vitest (reporter json) và jest (--json) cùng dạng. Id = "<file tương đối root> > <suite> > ... > <test>",
// giống dòng FAIL của vitest trên console. File không load được thành một test "(load error)" fail.
function parseJestJson(text, root) {
  const data = JSON.parse(text);
  const tests = new Map();
  for (const file of data.testResults ?? []) {
    const rel = posix(relative(root, String(file.name ?? '')));
    const cases = file.assertionResults ?? [];
    if (!cases.length && file.status === 'failed') tests.set(`${rel} > (load error)`, 'failed');
    for (const a of cases) tests.set([rel, ...(a.ancestorTitles ?? []), a.title].join(' > '), STATUS[a.status] ?? 'skipped');
  }
  return tests;
}

const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = text => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], unescapeXml(m[2])]));

// pytest không ghi file vào JUnit (xunit2): tìm module dài nhất trong classname có file .py thật.
function pythonId(classname, name, root) {
  const segs = classname.split('.');
  for (let i = segs.length; i > 0; i--) {
    const file = `${segs.slice(0, i).join('/')}.py`;
    if (existsSync(join(root, file))) return [file, ...segs.slice(i), name].join('::');
  }
  return `${classname}::${name}`;
}

// JUnit XML (pytest, maven surefire, gradle, phpunit). Id python = node id của pytest; java = "<pkg>/<Class>.java > <test>".
function parseJunit(text, root, stack, tests = new Map()) {
  for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]);
    const body = m[2] ?? '';
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const cls = a.classname ?? a.class ?? '';
    const id = a.file && stack !== 'python' ? `${posix(relative(root, join(root, a.file)))} > ${a.name}`
      : stack === 'python' ? pythonId(cls, a.name, root)
        : `${cls.replaceAll('.', '/')}.java > ${a.name}`;
    tests.set(id, status);
  }
  return tests;
}

// Đọc báo cáo của một lần chạy; null khi không có / hỏng (người gọi quay về log).
export function readReport(plan, { root, stack, startedAt = 0 }) {
  try {
    let tests;
    if (plan.format === 'jest-json') tests = parseJestJson(readFileSync(plan.file, 'utf8'), root);
    else if (plan.format === 'junit') tests = parseJunit(readFileSync(plan.file, 'utf8'), root, stack);
    else if (plan.format === 'junit-dir') {
      const dir = join(root, plan.dir);
      tests = new Map();
      for (const f of readdirSync(dir).filter(f => f.endsWith('.xml'))) {
        if (statSync(join(dir, f)).mtimeMs + 2000 >= startedAt) parseJunit(readFileSync(join(dir, f), 'utf8'), root, stack, tests);
      }
    } else return null;
    if (!tests.size) return null;
    const statuses = [...tests.values()];
    const count = s => statuses.filter(x => x === s).length;
    return { tests, counts: { total: tests.size, passed: count('passed'), failed: count('failed'), skipped: count('skipped') } };
  } catch {
    return null;
  }
}

// Chạy test_all / test_one một lần: {res, report, counts, failing, source}. `report.tests` là Map id → trạng thái.
export async function runTests(profile, kind, { targets = null, logFile, timeoutMs, tailBytes = 64 * 1024 }) {
  const file = logFile.replace(/\.log$/, profile.stack === 'node' ? '.json' : '.xml');
  const plan = testCommand(profile, kind, file, targets);
  if (!plan) return null;
  rmSync(file, { force: true });
  const startedAt = Date.now();
  const res = await runPwsh(plan.command, { cwd: profile.root, timeoutMs, logFile, tailBytes });
  const report = plan.format && !res.timedOut ? readReport(plan, { root: profile.root, stack: profile.stack, startedAt }) : null;
  const failing = report ? [...report.tests].filter(([, s]) => s === 'failed').map(([id]) => id).slice(0, 500)
    : res.code === 0 ? [] : failingTests(res.tail);
  return { res, report, counts: report?.counts ?? parseTestCounts(res.tail), failing, source: report ? 'report' : 'log' };
}

// Baseline lưu trong journal: số đếm, test fail sẵn, và (có báo cáo) trạng thái từng test để biết test nào biến mất.
export function baselineOf(run) {
  if (!run) return null;
  if (run.res.timedOut) return { status: 'TIMEOUT' };
  return { status: run.res.code === 0 ? 'PASS' : 'FAIL', counts: run.counts, failing: run.failing, source: run.source,
    ...(run.report ? { tests: Object.fromEntries([...run.report.tests].slice(0, 3000)) } : {}) };
}

// Test cần chạy lại cho các id fail (mục 10): node chạy lại cả file, python theo node id, java theo Class#method.
export function rerunTargets(ids, profile) {
  const uniq = xs => [...new Set(xs.filter(Boolean))];
  if (profile.stack === 'node') return uniq(ids.map(id => id.split(' > ')[0]).filter(f => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)));
  if (profile.stack === 'python') return uniq(ids.map(id => (id.includes('::') ? id : null)));
  if (profile.stack === 'java-maven' || profile.stack === 'java-gradle') {
    return uniq(ids.map(id => {
      const [file, name] = id.split(' > ');
      if (!file || !name || !/\.java$/.test(file)) return null;
      const method = name.replace(/\(\)$/, '');
      const cls = file.replace(/\.java$/, '');
      return profile.stack === 'java-maven' ? `${cls.split('/').pop()}#${method}` : `${cls.replaceAll('/', '.')}.${method}`;
    }));
  }
  return [];
}
