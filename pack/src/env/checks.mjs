// Tool `run_checks`: helper chạy các bước kiểm cuối của một worktree (typecheck, build, cả bộ test) theo project
// profile, song song, ghi log vào answers/<ID>/evidence/ và chờ tới khi xong (tối đa waitSeconds). 9O802QWE: fixer tự
// chạy chuỗi typecheck → build → test trong shell rồi tốn 4–10 lượt model chỉ để chờ (`wait` 1 s) và đọc đuôi log
// (BUG-04: 10 lượt chờ, 60 s); mỗi lượt gửi lại cả context 60–110K token. Kết quả còn được ghi vào
// .team-work/items/<ID>/checks.json để worker_checkpoint candidate điền sẵn phần verification của fix-result.
// Build xong mà source và môi trường không đổi thì ghi nhớ bản build như app start, để `app start` sau đó dùng lại
// thay vì build lần nữa (~35–60 s).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { sourceSnapshot } from '../core/candidates.mjs';
import { git } from '../core/git.mjs';
import { runPwsh } from '../core/jobs.mjs';
import { withHeavySlot } from './heavy.mjs';
import { fail, sleep, writeFileAtomic } from '../core/util.mjs';
import { forgetBuild, locate, readState as appState, rememberBuild, stopApp } from './app.mjs';
import { detectProfile } from './environment.mjs';
import { SAFE_TARGET, fillTargets, runTests } from './testreport.mjs';
import { appPrefixOf, listWorkspaces, testScope } from './test-scope.mjs';
import { mutantsRunning, restorePending, runMutants } from './mutants.mjs';

export const CHECKS = ['typecheck', 'build', 'test'];
const MAX_WAIT_SECONDS = 110;
// test 15 phút: bộ loot-core chạy riêng 172 s, bốn bộ chạy chung máy 517–534 s mỗi bộ (đo 13/11), trong trận có thêm build
// và app nên vượt 600 s (CUZ7KL95 TASK-08: lần chạy cuối hết giờ ở 600 s, nộp PARTIAL).
const TIMEOUT_MS = { typecheck: 5 * 60_000, build: 10 * 60_000, test: 15 * 60_000 };
const LOG = { typecheck: 'typecheck.log', build: 'build.log', test: 'full-suite.log' };
// Lần test chỉ chạy các file được chỉ định (testFiles): log riêng, nhãn riêng, để fix-result không nhận là cả bộ test.
const SELECTED_LOG = 'selected-tests.log';
export const SELECTED_LABEL = 'tests (selected files only, not the full suite)';
export const MAX_TEST_FILES = 40;
// Tên check trong verification của fix-result.
export const CHECK_LABEL = { typecheck: 'typecheck', build: 'build', test: 'full test suite' };
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);

// Lần chạy đang dở trong tiến trình helper này (mỗi subagent có helper riêng): key → {runId, promise}.
const running = new Map();

export const checksFile = (teamWork, key) => join(teamWork, 'items', key, 'checks.json');
// Yêu cầu huỷ một lần chạy (chứa runId): tiến trình helper đang chạy nó (thường là của root, khởi động ở
// ready_for_evidence) đọc file này mỗi giây rồi giết các lệnh con.
const cancelFile = (teamWork, key) => join(teamWork, 'items', key, 'checks.cancel');
const isBad = c => c?.state === 'failed' || c?.state === 'timeout';
// Lỗi typecheck chỉ nằm trong file test mới của item và đề không nói grader chạy type check: không làm mất điểm, nên
// không chặn (advisory). QXUD1QAI CR-07: 3 lỗi strict trong cr-07-replay.test.ts, worker sửa rồi chạy lại check, build
// bị làm lại, app lên muộn, trang không được chụp (−19); grader của bộ đề Actual chỉ chạy test loot-core.
const blocking = c => isBad(c) && !c.advisory;
// Check đã xong và hỏng (chặn) trong lúc lần chạy còn dở.
const failedSoFar = record => {
  const finished = Object.values(record?.finished ?? {});
  // Mọi check đã xong thì bản ghi `done` sắp được ghi: chờ nó, không báo "còn chạy".
  return finished.length < (record?.checks?.length ?? 0) ? finished.filter(blocking) : [];
};
const advisoryOf = list => Object.values(list ?? {}).filter(c => isBad(c) && c.advisory);
const ADVISORY_HINT = 'Type errors only in your own new test files, and this item\'s text does not say graders run the type check: they cost no points. Capture your evidence first and do not rerun run_checks for them now (a rerun cancels the build your app is waiting for); fix them afterwards if time allows, then run_checks again.';

// Đề nói grader chạy type check (bộ Solova: "runs the whole test suite and the type check"): lỗi typecheck luôn chặn.
// Có nhắc là tính, kể cả câu không rõ ràng: nội dung đề chỉ làm kiểm chặt hơn, không bao giờ nới ra.
export const typecheckGraded = text => /\btype[\s-]?check|\btypecheck|\btype errors?\b|\btsc\b|--noEmit/i.test(String(text ?? ''));
const TEST_PATH = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\//;
// File trong các dòng lỗi TypeScript ("path(12,3): error TS7006" hay "path:12:3 - error TS7006").
export function typeErrorFiles(text) {
  const files = new Set();
  for (const m of String(text ?? '').matchAll(/^\s*([^\s(:][^\s(]*?\.[cm]?[jt]sx?)(?:\(\d+,\d+\)|:\d+:\d+)\s*[:-]\s*error\s+TS\d+/gm)) {
    files.add(m[1].replaceAll('\\', '/'));
  }
  return [...files];
}
// Mọi lỗi nằm trong file test mới/sửa của chính item (so theo đuôi đường dẫn, vì lage in đường dẫn theo từng gói).
export function typeErrorsInOwnTests(logText, ownTests) {
  const files = typeErrorFiles(logText);
  if (!files.length || !ownTests?.length) return null;
  const own = f => TEST_PATH.test(f) && ownTests.some(t => t === f || t.endsWith(`/${f.replace(/^\.\//, '')}`));
  return files.every(own) ? files : null;
}
export function readChecks(teamWork, key) {
  try { return JSON.parse(readFileSync(checksFile(teamWork, key), 'utf8')); } catch { return null; }
}

// Huỷ lần run_checks còn chạy của item và chờ nó dừng (tối đa waitMs). Gọi khi worker đã bàn giao: kết quả của lần
// chạy dở không còn ai đọc, còn log của nó vẫn ghi vào answers/<ID>/evidence/ và làm cây answer đổi sau handoff
// (BI7A5ACV CR-08: build.log, typecheck.log ghi tới 13:40:01 sau handoff 13:37:17, 5 lần publish CANDIDATE_STALE).
// Trả về runId đã huỷ, hay null khi không có gì chạy.
export async function cancelChecks(teamWork, key, waitMs = 20_000) {
  const current = readChecks(teamWork, key);
  if (current?.state !== 'running' || !alive(current.pid)) return null;
  writeFileAtomic(cancelFile(teamWork, key), current.runId);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const now = readChecks(teamWork, key);
    if (now?.runId !== current.runId || now.state !== 'running' || !alive(now.pid)) break;
    await sleep(250);
  }
  return current.runId;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const tailOf = (text, max) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(-max).trim();

// File item sửa trong worktree, tương đối checkout: thay đổi chưa commit so với HEAD (worktree sync đặt HEAD về main
// và áp lại thay đổi của item chưa stage) cộng file mới chưa ignore. null khi git lỗi.
async function ownChanges(checkout) {
  try {
    const diff = await git(['diff', '--name-only', 'HEAD', '--'], { cwd: checkout });
    const untracked = await git(['ls-files', '--others', '--exclude-standard'], { cwd: checkout });
    return [...diff.out.split(/\r?\n/), ...untracked.out.split(/\r?\n/)].filter(p => p && !p.startsWith('.team-work/'));
  } catch { return null; }
}

// typecheck đọc thư mục mà build ghi lại: Next.js (tsconfig include '.next/types/**/*.ts', next build xoá rồi dựng lại
// thư mục đó; ME1X0FFX: TS6053 giả). Chỉ khi đó mới chạy typecheck rồi build lần lượt.
export function typecheckReadsBuild(root) {
  const read = name => { try { return readFileSync(join(root, name), 'utf8'); } catch { return ''; } };
  if (/\.next[\\/]types/.test(read('tsconfig.json'))) return true;
  try {
    const pkg = JSON.parse(read('package.json') || '{}');
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.next);
  } catch { return false; }
}

function itemText(teamWork, key) {
  try {
    const page = JSON.parse(readFileSync(join(teamWork, 'items', key, 'page.json'), 'utf8'));
    return `${page.title ?? ''}\n${page.descriptionMd ?? page.description ?? ''}`;
  } catch { return ''; }
}

// testFiles của run_checks: đường dẫn tương đối app root (posix), không tuyệt đối, không `..`, không bắt đầu bằng `-`
// (runner hiểu thành cờ), chỉ ký tự an toàn cho lệnh, file có thật. Trả danh sách đã chuẩn hoá hay báo INVALID_ARGUMENT.
const plainPath = raw => (typeof raw === 'string' ? raw.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '') : '');
const unsafePath = f => !f || isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.startsWith('/') || f.split('/').includes('..')
  || f.startsWith('-') || !SAFE_TARGET.test(f);
const isFileIn = (root, f) => { try { return statSync(join(root, f)).isFile(); } catch { return false; } };
export function checkTestFiles(appRoot, files) {
  if (!Array.isArray(files) || !files.length) fail('INVALID_ARGUMENT', 'testFiles must be a non-empty array of test file paths relative to the app root');
  if (files.length > MAX_TEST_FILES) fail('INVALID_ARGUMENT', `testFiles takes at most ${MAX_TEST_FILES} files: run the whole suite instead`);
  const out = [];
  for (const raw of files) {
    const f = plainPath(raw);
    if (unsafePath(f)) fail('INVALID_ARGUMENT', `testFiles: ${JSON.stringify(raw)} is not a plain path relative to the app root`);
    if (!isFileIn(appRoot, f)) fail('INVALID_ARGUMENT', `testFiles: ${f} does not exist under the app root ${appRoot}`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

// File test cần chạy lại khi bản sửa baseline (test fail sẵn ở bản phát) vừa vào worktree: file của các test fail sẵn
// cộng test mới của item, tương đối app root. Id baseline đọc từ log của runner theo gói (lage) thì tương đối gói đó
// (WQ7T6CEC: "src/server/transactions/import/parse-file.test.ts > …" nằm ở packages/loot-core/): tìm trong các
// workspace, phải đúng một chỗ. Không tính chắc được (profile không có test_one, file của một id không tìm thấy hay
// thấy ở hai gói, không có file nào, quá nhiều) thì null: người gọi giữ cách cũ (chạy cả bộ).
export function baselineRerunFiles(matchRoot, failingIds, ownTests = []) {
  const profile = detectProfile(matchRoot);
  if (!profile.root || !profile.commands?.test_one) return null;
  const root = profile.root;
  const workspaces = profile.stack === 'node' ? listWorkspaces(root) : [];
  const files = [];
  for (const id of failingIds ?? []) {
    const head = plainPath(String(id).split(' > ')[0].split('::')[0]);
    // Dòng "× tên test" của log không có file: cùng test đó thường có thêm một id kèm file.
    if (!/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/.test(head)) continue;
    if (unsafePath(head)) return null;
    const found = isFileIn(root, head) ? [head] : workspaces.map(w => `${w.dir}/${head}`).filter(f => isFileIn(root, f));
    if (found.length !== 1) return null;
    if (!files.includes(found[0])) files.push(found[0]);
  }
  if (!files.length) return null;
  for (const t of ownTests ?? []) {
    const rel = plainPath(relative(root, isAbsolute(t) ? t : join(matchRoot, t)));
    if (unsafePath(rel) || !isFileIn(root, rel)) continue;
    if (!files.includes(rel)) files.push(rel);
  }
  return files.length > MAX_TEST_FILES ? null : files;
}

async function runOne(name, profile, { logFile, scratch, scope, signal, typecheck = null, testFiles = null }) {
  if (name === 'test' && testFiles) {
    // Chỉ các file được chỉ định, bằng test_one của profile (cùng runner và config của project, kèm reporter máy đọc).
    if (!profile.commands.test_one) return { name, command: null, state: 'skipped', reason: 'the project profile has no test_one command', testFiles };
    const scratchLog = join(scratch, SELECTED_LOG);
    const t = await runTests(profile, 'test_one', { targets: testFiles, limit: MAX_TEST_FILES, logFile: scratchLog, timeoutMs: TIMEOUT_MS.test, signal });
    try { copyFileSync(scratchLog, logFile); } catch { /* không có log thì thôi */ }
    const ok = !t.res.timedOut && t.res.code === 0;
    return { name, command: fillTargets(profile.commands.test_one, testFiles, profile.stack, MAX_TEST_FILES), state: t.res.timedOut ? 'timeout' : ok ? 'passed' : 'failed', exitCode: t.res.code, ms: t.res.ms,
      testFiles, counts: t.counts ?? null, failing: t.failing.slice(0, 40), ...(ok ? {} : { tail: tailOf(t.res.tail, 1500) }) };
  }
  const command = name === 'test' ? scope?.command ?? profile.commands.test_all : profile.commands[name];
  if (!command) return { name, command: null, state: 'skipped', reason: `the project profile has no ${name === 'test' ? 'test_all' : name} command` };
  if (name === 'test') {
    // Báo cáo JSON/JUnit của runner nằm ngoài worktree; chỉ log vào evidence. Lệnh theo gói không kèm reporter: số
    // đếm và test hỏng đọc từ log.
    const scratchLog = join(scratch, LOG.test);
    const run = scope ? { ...profile, testScript: null, commands: { ...profile.commands, test_all: command } } : profile;
    const t = await runTests(run, 'test_all', { logFile: scratchLog, timeoutMs: TIMEOUT_MS.test, signal });
    try { copyFileSync(scratchLog, logFile); } catch { /* không có log thì thôi */ }
    const ok = !t.res.timedOut && t.res.code === 0;
    return { name, command, state: t.res.timedOut ? 'timeout' : ok ? 'passed' : 'failed', exitCode: t.res.code, ms: t.res.ms,
      ...(scope ? { scope: { packages: scope.packages, reason: scope.reason } } : {}),
      counts: t.counts ?? null, failing: t.failing.slice(0, 40), ...(ok ? {} : { tail: tailOf(t.res.tail, 1500) }) };
  }
  const res = await runPwsh(command, { cwd: profile.root, timeoutMs: TIMEOUT_MS[name], logFile, signal });
  const ok = !res.timedOut && res.code === 0;
  let advisory = null;
  if (name === 'typecheck' && !ok && !res.timedOut && typecheck && !typecheck.graded) {
    let log = '';
    try { log = readFileSync(logFile, 'utf8'); } catch { log = res.tail ?? ''; }
    const files = typeErrorsInOwnTests(log, typecheck.ownTests);
    if (files) advisory = { files, reason: 'type errors only in the item\'s own new test files; the item text does not say graders run the type check' };
  }
  return { name, command, state: res.timedOut ? 'timeout' : ok ? 'passed' : 'failed', exitCode: res.code, ms: res.ms,
    ...(ok ? {} : { tail: tailOf(res.tail, 1500) }), ...(advisory ? { advisory } : {}) };
}

// Một dòng verification cho mỗi check, đúng contract fix-result.
export function verificationRows(record) {
  const rows = [];
  for (const c of record?.results ?? []) {
    const result = c.state === 'passed' ? 'pass' : c.state === 'skipped' ? 'not_run' : c.state === 'failed' || c.state === 'timeout' ? 'fail' : 'not_run';
    const parts = [`run_checks ${c.state}`, c.log ? `log ${c.log}` : null,
      c.counts ? `${c.counts.passed ?? 0}/${c.counts.total ?? 0} passed, ${c.counts.failed ?? 0} failed` : null,
      c.failing?.length ? `failing: ${c.failing.slice(0, 8).join('; ')}` : null, c.reason ?? null,
      c.scope ? `scoped to ${c.scope.packages.join(', ')} (${c.scope.reason})` : null,
      c.advisory ? `not graded: ${c.advisory.reason} (${c.advisory.files.slice(0, 4).join(', ')})` : null,
      c.testFiles ? `not the full suite: ran only ${c.testFiles.slice(0, 12).join(', ')}${c.testFiles.length > 12 ? ', …' : ''}` : null];
    rows.push({ check: c.name === 'test' && c.testFiles ? SELECTED_LABEL : CHECK_LABEL[c.name] ?? c.name, command: c.command ?? null, result, note: parts.filter(Boolean).join('; ').slice(0, 1500) });
  }
  return rows;
}

function view(record, { waited = false } = {}) {
  if (!record) return { state: 'none', hint: 'No checks recorded for this item: call run_checks {action: "run"}.' };
  if (record.state === 'cancelled' || record.state === 'lost') {
    return { state: record.state, runId: record.runId, hint: 'This run did not finish: call run_checks {action: "run"} again.' };
  }
  if (record.state === 'running') {
    const built = record.build?.state === 'passed';
    // LXRMBRA2 BUG-11: build hỏng ở giây 138, worker chỉ thấy `build: failed` không kèm log và chờ bộ test tới giây
    // 425 mới đọc được lỗi (7 phút; CR-07 cần bản sửa này trên main trước hạn 20 phút). Check hỏng thì trả ngay kèm đuôi log.
    const bad = failedSoFar(record);
    if (bad.length) {
      return { state: 'running', runId: record.runId, checks: record.checks, startedAt: record.startedAt,
        seconds: Math.round((Date.now() - Date.parse(record.startedAt)) / 1000), failed: bad,
        hint: `${bad.map(c => c.name).join(', ')} already failed while the rest still runs: read the tail (full log under answers/${record.key}/evidence/) and fix the cause now, without waiting for the remaining checks. After your edit call run_checks {action: "run"}: it cancels this run and starts again on the changed source. A failure listed in <baseline_failures> is not yours unless youFix is true.` };
    }
    const advisory = advisoryOf(record.finished);
    return { state: 'running', runId: record.runId, checks: record.checks, startedAt: record.startedAt,
      seconds: Math.round((Date.now() - Date.parse(record.startedAt)) / 1000), ...(record.build ? { build: record.build.state } : {}),
      ...(advisory.length ? { advisory } : {}),
      hint: (advisory.length ? `${ADVISORY_HINT} ` : '') + (built
        ? 'The build passed and the rest is still running: app start now (it reuses that build) and capture your evidence; call run_checks {action: "status"} for the remaining checks before candidate. Do not run these commands yourself meanwhile.'
        : `Still running${waited ? ' after the wait' : ''}: call run_checks {action: "status", waitSeconds: ${MAX_WAIT_SECONDS}} (start that exec with // @exec: {"yield_time_ms": 120000}); it returns as soon as the checks finish. Meanwhile prepare submit.json and your candidate result, and change nothing that the checks cover: an edit makes this run stale. Do not run these commands yourself meanwhile.`) };
  }
  const failed = (record.results ?? []).filter(blocking);
  const advisory = (record.results ?? []).filter(c => isBad(c) && c.advisory);
  return { state: record.state, runId: record.runId, ok: !failed.length, ms: record.ms, results: record.results,
    ...(advisory.length ? { advisory: advisory.map(c => c.name) } : {}),
    ...(record.appStopped ? { appStopped: true } : {}), ...(record.buildRemembered ? { buildRemembered: true } : {}),
    hint: failed.length
      ? `Failed: ${failed.map(c => c.name).join(', ')}. Read the tail (full log under answers/${record.key}/evidence/), fix the cause, then run_checks again. Test failures listed in <baseline_failures> are not yours unless youFix is true.`
      : `${advisory.length ? `${ADVISORY_HINT} Everything else passed.` : 'All checks passed.'} Logs are in answers/${record.key}/evidence/ and worker_checkpoint candidate copies these results into the fix-result verification.${record.buildRemembered ? ' app start reuses this production build while the source stays unchanged: call it with the default build.' : ''}` };
}

// Chờ dương nào cũng là chờ tối đa: trả về ngay khi xong, nên chờ dài không mất gì (app start tự chờ phần build).
// RATH0OHJ: worker truyền waitSeconds 40–50 (72 lần), TASK-08 gọi status 6 lần liền, mỗi lần một lượt model, trong
// lúc cả bộ test chạy 6m43s. 0 vẫn là không chờ (helper tự khởi động run_checks ở ready_for_evidence).
async function waitFor(teamWork, key, runId, waitSeconds) {
  const deadline = Date.now() + (Number(waitSeconds) > 0 ? MAX_WAIT_SECONDS : 0) * 1000;
  const mine = running.get(key);
  for (;;) {
    const record = readChecks(teamWork, key);
    if (!record || record.runId !== runId || record.state !== 'running') return view(record);
    if (!mine || mine.runId !== runId) {
      // Lần chạy của tiến trình helper khác (worker khác của cùng item, hay helper đã khởi động lại): đọc file.
      if (!alive(record.pid)) {
        const lost = { ...record, state: 'lost', results: [], endedAt: new Date().toISOString() };
        writeFileAtomic(checksFile(teamWork, key), JSON.stringify(lost, null, 2));
        return { ...view(lost), hint: 'The helper process that ran these checks is gone: call run_checks {action: "run"} again.' };
      }
    }
    if (failedSoFar(record).length || Date.now() >= deadline) return view(record, { waited: true });
    const step = sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    await (mine && mine.runId === runId ? Promise.race([mine.promise, step]) : step);
  }
}

export async function runChecks({ teamWorkspace, action = 'run', backlogItemKey: key, matchRoot, checks = null,
  parallel = true, force = false, waitSeconds = MAX_WAIT_SECONDS, scopeTests = true, maxHeavy = null, testFiles = null }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  // PI: không chấm khả năng phát hiện lỗi và trần 10–12 phút không chừa chỗ (DVVFEPXF PI-03: worker tự chạy mutants 3 chỗ
  // sửa, lệnh chặn 121 s ngay trước return_by; item đóng khi chưa nộp).
  if (action === 'mutants' && /^PI-/i.test(String(key))) {
    return { state: 'skipped', skipped: 'PI', hint: 'The mutation check is not run for a PI: it is not graded and the PI time cap leaves no room. Your new test that fails on the unfixed code is enough; go on with the answers.' };
  }
  const where = locate(teamWorkspace, matchRoot);
  const teamWork = dirname(where.logDir);
  if (action === 'mutants') return runMutants({ teamWorkspace, backlogItemKey: key, matchRoot, waitSeconds, force, maxHeavy });
  // Bản đột biến bỏ dở (helper chết giữa lần mutants): trả lại file gốc trước khi chạy hay đọc gì.
  restorePending(teamWork, key);
  if (action === 'status') {
    const record = readChecks(teamWork, key);
    return record?.state === 'running' ? waitFor(teamWork, key, record.runId, waitSeconds) : view(record);
  }
  if (action !== 'run') fail('INVALID_ARGUMENT', 'action must be run, status or mutants');
  if (mutantsRunning(teamWork, key)) fail('MUTANTS_RUNNING', 'the mutation check is editing your product files one change at a time: call run_checks {action: "mutants"} until it finishes, then run');
  // testFiles (vài file test, vd test fail sẵn ở bản phát và test mới của item): không kèm checks thì chỉ chạy test.
  const selected = testFiles !== null && testFiles !== undefined;
  const names = [...new Set(Array.isArray(checks) && checks.length ? checks : selected ? ['test'] : CHECKS)];
  if (names.some(n => !CHECKS.includes(n))) fail('INVALID_ARGUMENT', `checks must be among ${CHECKS.join(', ')}`);
  if (selected && !names.includes('test')) fail('INVALID_ARGUMENT', 'testFiles needs the test check: checks ["test"]');
  let current = readChecks(teamWork, key);
  const failedRun = current?.state === 'running' && alive(current.pid) && failedSoFar(current).length > 0;
  if (current?.state === 'running' && alive(current.pid) && !failedRun) return waitFor(teamWork, key, current.runId, waitSeconds);

  const profile = detectProfile(where.matchRoot);
  if (!profile.root) fail('UNSUPPORTED_APP', 'no application found under matchRoot: run the checks by hand');
  const files = selected ? checkTestFiles(profile.root, testFiles) : null;
  if (files && !profile.commands.test_one) fail('UNSUPPORTED_APP', 'the project profile has no test_one command to run single test files: run without testFiles');
  const checkout = dirname(where.matchRoot), folder = basename(where.matchRoot);
  const hasGit = existsSync(join(checkout, '.git'));
  // 08OQBPW8: mỗi worker chạy run_checks 3–4 lần (trước sync, sau sync, sau khi chép script seed, trước candidate),
  // 40–95 s mỗi lần. Source (ngoài answers/, challenge/) và môi trường như lần chạy xong trước thì trả lại kết quả đó.
  const before = hasGit ? await sourceSnapshot(checkout, folder, profile).catch(() => null) : null;
  if (failedRun) {
    // Một check của lần chạy dở đã hỏng: source chưa đổi thì đó vẫn là kết quả; đã đổi (worker vừa sửa) thì huỷ lần
    // chạy cũ, kể cả khi nó thuộc tiến trình helper khác, rồi chạy lại.
    if (!before || !current.startSnapshot || JSON.stringify(before) === JSON.stringify(current.startSnapshot)) return view(current);
    writeFileAtomic(cancelFile(teamWork, key), current.runId);
    const stillRunning = () => { const now = readChecks(teamWork, key); return now?.runId === current.runId && now.state === 'running'; };
    for (let i = 0; i < 80 && stillRunning(); i++) await sleep(250);
    current = readChecks(teamWork, key);
    if (current?.state === 'running') return { ...view(current), hint: 'The earlier run is still stopping: call run_checks {action: "run"} again in a few seconds.' };
  }
  if (!force && current?.state === 'done' && current.snapshot && before && JSON.stringify(current.snapshot) === JSON.stringify(before)
    && current.matchRoot === where.matchRoot) {
    const have = new Map((current.results ?? []).map(r => [r.name, r]));
    // Lần chạy cả bộ thay được lần chạy vài file; lần chạy vài file chỉ thay được lần chạy đúng các file đó.
    const sameTests = t => !t?.testFiles || Boolean(files && [...t.testFiles].sort().join('|') === [...files].sort().join('|'));
    if (names.every(n => have.has(n) && have.get(n).state !== 'timeout') && (!names.includes('test') || sameTests(have.get('test')))) {
      return { ...view({ ...current, results: current.results.filter(r => names.includes(r.name)) }), cached: true,
        hint: `Source and environment are unchanged since run ${current.runId}: these are its results, nothing was run again (force: true runs anyway).` };
    }
  }
  const evidenceDir = join(where.matchRoot, 'answers', key, 'evidence');
  const scratch = join(teamWork, 'scratch', key, 'checks');
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(dirname(checksFile(teamWork, key)), { recursive: true });
  // Bộ test chỉ gồm các gói grader chạy khi đề nêu tên (test-scope.mjs; tắt bằng "scopedTests": false).
  const text = itemText(teamWork, key);
  const changedNow = hasGit && (names.includes('test') || names.includes('typecheck')) ? await ownChanges(checkout) : null;
  const scoped = names.includes('test') && scopeTests && hasGit && !files
    ? testScope({ profile, text, changed: changedNow, appPrefix: appPrefixOf(checkout, profile) })
    : { scope: null };
  // Lỗi typecheck chỉ trong test mới của item và đề không chấm type check: không chặn (advisory, ở trên).
  const typecheck = { graded: typecheckGraded(text), ownTests: (changedNow ?? []).filter(p => TEST_PATH.test(p)) };
  const logOf = n => (n === 'test' && files ? SELECTED_LOG : LOG[n]);
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const record = { runId, key, pid: process.pid, state: 'running', checks: names, parallel: Boolean(parallel),
    matchRoot: where.matchRoot, startedAt: new Date().toISOString(), ...(scoped.scope ? { testScope: scoped.scope.packages } : {}),
    ...(files ? { testFiles: files } : {}), ...(before ? { startSnapshot: before } : {}) };
  // Build ghi đè thư mục build mà app (dev hay production) của item đang chạy dùng.
  if (names.includes('build') && appState(teamWorkspace, key)) { stopApp(teamWorkspace, key); record.appStopped = true; }
  writeFileAtomic(checksFile(teamWork, key), JSON.stringify(record, null, 2));

  const ac = new AbortController();
  rmSync(cancelFile(teamWork, key), { force: true });
  const watch = setInterval(() => {
    try { if (readFileSync(cancelFile(teamWork, key), 'utf8').trim() === runId) ac.abort(); } catch { /* không có yêu cầu huỷ */ }
  }, 1000);
  watch.unref?.();
  const mine = () => { const now = readChecks(teamWork, key); return !now || now.runId === runId; };
  const promise = (async () => {
    const t0 = Date.now();
    if (names.includes('build')) forgetBuild(teamWorkspace, profile.root);
    // Mỗi lệnh giữ một chỗ "lệnh nặng" của cả máy (heavy.mjs); đang chờ chỗ thì checks.json ghi queued[name].
    const queued = n => { record.queued = { ...record.queued, [n]: new Date().toISOString() }; if (mine()) writeFileAtomic(checksFile(teamWork, key), JSON.stringify(record, null, 2)); };
    const one = name => withHeavySlot(teamWork, { max: maxHeavy, key, name, signal: ac.signal, onWait: () => queued(name) }, ({ waitedMs }) =>
      runOne(name, profile, { logFile: join(evidenceDir, logOf(name)), scratch, scope: scoped.scope, signal: ac.signal, typecheck, testFiles: files })
        .then(r => (waitedMs >= 1000 ? { ...r, queuedMs: waitedMs } : r)))
      .then(r => r ?? { name, command: null, state: 'failed', tail: 'cancelled while waiting for a free heavy-command slot' })
      .catch(error => ({ name, command: null, state: 'failed', tail: String(error?.message ?? error).slice(0, 600) }))
      .then(r => ({ ...r, ...(r.state === 'skipped' ? {} : { log: `evidence/${logOf(name)}` }) }));
    // typecheck không chạy cùng lúc với build ở project Next.js: tsconfig include '.next/types/**/*.ts', next build xoá
    // rồi dựng lại thư mục đó, tsc đang đọc thì báo TS6053 dù code đúng (ME1X0FFX: BUG-02 hạ 3 kịch bản đã đạt vì
    // typecheck "hỏng" giả ngay trước giờ đóng); ở đó chạy typecheck trước (nhanh, hỏng sớm) rồi build. Project khác chạy
    // cả ba cùng lúc: app start chờ build, mà typecheck đứng trước build làm app lên muộn khoảng 2 phút (QXUD1QAI CR-07:
    // typecheck 113 s rồi build 78 s; trong 9 trận CR-07 hạn 20 phút chỉ một lần kịp chụp trang).
    const byName = {};
    // Build xong thì ghi ngay vào checks.json: app start chỉ chờ build, không chờ cả bộ test (UOMNKT6Z: BUG-09 chờ
    // full suite 8,5 phút, quá 600 s, trước khi được start app để chụp evidence).
    const buildFinished = async r => {
      record.build = { state: r.state, endedAt: new Date().toISOString() };
      if (r.state === 'passed' && before) {
        const mid = await sourceSnapshot(checkout, folder, profile).catch(() => null);
        if (mid && JSON.stringify(mid) === JSON.stringify(before)) {
          rememberBuild(teamWorkspace, profile.root, before, 'run_checks'); record.buildRemembered = true;
        }
      }
    };
    // Mỗi check xong thì ghi ngay (state, đuôi log khi hỏng): status trả lỗi sớm, không chờ check còn lại.
    const chain = async list => {
      for (const n of list) {
        if (ac.signal.aborted) return;
        byName[n] = await one(n);
        if (ac.signal.aborted) return;
        const { name, state, exitCode, log, tail, failing, advisory } = byName[n];
        record.finished = { ...record.finished, [n]: { name, state, exitCode, log, ...(isBad(byName[n]) ? { tail, ...(failing?.length ? { failing: failing.slice(0, 20) } : {}) } : {}),
          ...(advisory ? { advisory } : {}) } };
        if (n === 'build') await buildFinished(byName[n]);
        if (mine()) writeFileAtomic(checksFile(teamWork, key), JSON.stringify(record, null, 2));
      }
    };
    if (!parallel) await chain(names);
    else if (typecheckReadsBuild(profile.root)) await Promise.all([chain(names.filter(n => n !== 'test')), chain(names.filter(n => n === 'test'))]);
    else await Promise.all(names.map(n => chain([n])));
    if (ac.signal.aborted) {
      if (mine()) writeFileAtomic(checksFile(teamWork, key), JSON.stringify({ ...record, state: 'cancelled', results: [], endedAt: new Date().toISOString() }, null, 2));
      return;
    }
    const results = names.map(n => byName[n]);
    const done = { ...record, state: 'done', results, ms: Date.now() - t0, endedAt: new Date().toISOString() };
    // Source đổi trong lúc chạy thì kết quả không gắn được với snapshot nào: không cache, không ghi nhớ bản build.
    const after = hasGit ? await sourceSnapshot(checkout, folder, profile).catch(() => null) : null;
    const stable = Boolean(before && after && JSON.stringify(after) === JSON.stringify(before));
    if (stable) done.snapshot = before;
    done.source = after?.source ?? null;
    if (stable && results.find(r => r.name === 'build')?.state === 'passed') {
      rememberBuild(teamWorkspace, profile.root, before, 'run_checks'); done.buildRemembered = true;
    }
    if (mine()) writeFileAtomic(checksFile(teamWork, key), JSON.stringify(done, null, 2));
  })().catch(error => {
    if (mine()) writeFileAtomic(checksFile(teamWork, key), JSON.stringify({ ...record, state: 'lost', results: [], error: String(error?.message ?? error).slice(0, 600) }, null, 2));
  }).finally(() => {
    clearInterval(watch);
    try { if (readFileSync(cancelFile(teamWork, key), 'utf8').trim() === runId) rmSync(cancelFile(teamWork, key), { force: true }); } catch { /* không có */ }
    if (running.get(key)?.runId === runId) running.delete(key);
  });
  running.set(key, { runId, promise });
  return waitFor(teamWork, key, runId, waitSeconds);
}
