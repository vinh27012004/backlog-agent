// run_checks {action: "mutants"}: helper bỏ từng chỗ sửa product của item (từng hunk của file đã có sẵn, khôi phục
// đúng dòng cũ), chạy các test mới của item, rồi trả lại nguyên file. Chỗ sửa nào bỏ đi mà không test mới nào đỏ là
// một lỗi bộ test không bắt được. EXP3I47A TASK-08 (−4): đội sửa đúng `reportedPayee` (so payee trước rules), nhưng
// case "first matching pass uses the payee after rules" đặt dòng ưu tiên ở vị trí thứ hai, nên chạy theo thứ tự
// fallback cũng ra đúng kết quả mong đợi; grader cài lại đúng lỗi đó (mutant import-payee-after-rules) và case vẫn xanh.
// File mới hoàn toàn không tính (bỏ cả file thì import hỏng, test nào cũng đỏ, không nói được gì).
// Chạy trong chính worktree, tuần tự (mỗi lần một bản đột biến); bản gốc của file đang bị đổi được ghi ra
// items/<ID>/mutants.restore.json trước khi đổi, và mọi lời gọi run_checks khôi phục nó trước khi làm gì khác.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { sourceSnapshot } from '../core/candidates.mjs';
import { git } from '../core/git.mjs';
import { run } from '../core/jobs.mjs';
import { fail, sleep, writeFileAtomic } from '../core/util.mjs';
import { locate } from './app.mjs';
import { detectProfile } from './environment.mjs';
import { withHeavySlot } from './heavy.mjs';

const MAX_WAIT_SECONDS = 110;
const MAX_HUNKS = 12;
const BUDGET_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 180_000;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(java|cs)$/;
const TEST_CONFIG = /(^|\/)((vitest|jest|playwright|cypress|karma|mocha)\.(config|setup|workspace)\.[cm]?[jt]s|setupTests\.[jt]sx?|pytest\.ini|conftest\.py)$/i;
// Chỉ code có hành vi: bỏ một dòng dữ liệu, tài liệu hay snapshot không phải là "chỗ sửa" mà test phải bắt.
const CODE_FILE = /\.([cm]?[jt]sx?|py|go|java|cs|rb|php|kt|rs)$/i;
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);
const posix = p => p.replaceAll('\\', '/');

const running = new Map();
export const mutantsFile = (teamWork, key) => join(teamWork, 'items', key, 'mutants.json');
const restoreFile = (teamWork, key) => join(teamWork, 'items', key, 'mutants.restore.json');
export function readMutants(teamWork, key) {
  try { return JSON.parse(readFileSync(mutantsFile(teamWork, key), 'utf8')); } catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Bản đột biến dở (helper chết giữa chừng): chép bản gốc về. Gọi trước mọi việc của run_checks và ở candidate.
export function restorePending(teamWork, key) {
  const file = restoreFile(teamWork, key);
  if (!existsSync(file)) return null;
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { rmSync(file, { force: true }); return null; }
  if (rec.pid && rec.pid !== process.pid && alive(rec.pid)) return null; // tiến trình khác còn đang chạy nó
  if (rec.target && rec.copy && existsSync(rec.copy)) copyFileSync(rec.copy, rec.target);
  rmSync(file, { force: true });
  return rec.target ?? null;
}

// Hunk của `git diff -U0`: {file, oldStart, oldCount, newStart, newCount, oldLines, newLines}.
export function parseHunks(diffText) {
  const hunks = [];
  let file = null, cur = null;
  for (const raw of String(diffText ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { file = null; cur = null; continue; }
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ')) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = file ? { file, oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], oldLines: [], newLines: [] } : null;
      if (cur) hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('-')) cur.oldLines.push(line.slice(1));
    else if (line.startsWith('+')) cur.newLines.push(line.slice(1));
  }
  return hunks;
}

// Dòng sửa liền nhau thành một hunk; hunk thay đúng n dòng bằng n dòng thì tách từng dòng (mỗi dòng là một chỗ sửa
// riêng mà test có thể bắt hay không).
export function splitLines(hunks) {
  return hunks.flatMap(h => (h.oldCount === h.newCount && h.newCount > 1
    ? h.newLines.map((line, i) => ({ ...h, oldStart: h.oldStart + i, oldCount: 1, newStart: h.newStart + i, newCount: 1, oldLines: [h.oldLines[i]], newLines: [line] }))
    : [h]));
}

// Nội dung file với hunk `h` bỏ đi (dòng mới thay bằng dòng cũ); null khi file không còn khớp hunk.
export function revertHunk(text, h) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const final = text.endsWith(eol);
  const lines = (final ? text.slice(0, -eol.length) : text).split(eol);
  const at = h.newCount === 0 ? h.newStart : h.newStart - 1;
  const now = lines.slice(at, at + h.newCount);
  if (now.length !== h.newCount || now.some((l, i) => l.replace(/\r$/, '') !== h.newLines[i])) return null;
  lines.splice(at, h.newCount, ...h.oldLines);
  return lines.join(eol) + (final ? eol : '');
}

// Chỗ sửa (hunk của file code có sẵn, ngoài test/config/answers) và test mới của item trong worktree, đường dẫn
// tương đối checkout. Thay đổi của item là phần chưa commit so với HEAD (worktree sync đặt HEAD về main).
export async function mutationTargets(checkout, folder) {
  const prefix = `${folder}/`;
  const skip = p => !p.startsWith(prefix) || p.startsWith(`${prefix}answers/`) || p.startsWith(`${prefix}challenge/`) || /(^|\/)node_modules\//.test(p);
  const diff = await git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', folder], { cwd: checkout });
  const hunks = splitLines(parseHunks(diff.out).filter(h => !skip(h.file) && CODE_FILE.test(h.file) && !TEST_FILE.test(h.file) && !TEST_CONFIG.test(h.file)));
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '--', folder], { cwd: checkout });
  const tests = untracked.out.split(/\r?\n/).filter(p => p && !skip(p) && TEST_FILE.test(p) && /\.([cm]?[jt]sx?|py)$/.test(p));
  return { hunks, tests };
}

function findUp(from, stop, rel) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, rel))) return join(dir, rel);
    if (dir === stop || dirname(dir) === dir || relative(stop, dir).startsWith('..')) return null;
  }
}

// Lệnh chạy một nhóm test của cùng gói: vitest/jest của gói (gọi thẳng bằng node, không qua .cmd), pytest.
export function testRunners(checkout, appRoot, tests) {
  const groups = new Map(), missing = [];
  for (const rel of tests) {
    const abs = join(checkout, rel);
    if (/\.py$/.test(rel)) {
      const k = `py:${appRoot}`;
      if (!groups.has(k)) groups.set(k, { cwd: appRoot, cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'pytest', '-q'], files: [] });
      groups.get(k).files.push(relative(appRoot, abs));
      continue;
    }
    const pkgFile = findUp(dirname(abs), appRoot, 'package.json');
    if (!pkgFile) { missing.push(rel); continue; }
    const pkgDir = dirname(pkgFile);
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch { /* package.json hỏng */ }
    const said = `${pkg.scripts?.test ?? ''} ${Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ')}`;
    const vitest = /vitest/.test(said) || existsSync(join(pkgDir, 'vitest.config.ts')) || existsSync(join(pkgDir, 'vitest.config.mts')) || existsSync(join(pkgDir, 'vitest.config.js'));
    const bin = vitest ? findUp(pkgDir, appRoot, join('node_modules', 'vitest', 'vitest.mjs'))
      : /jest/.test(said) ? findUp(pkgDir, appRoot, join('node_modules', 'jest', 'bin', 'jest.js')) : null;
    if (!bin) { missing.push(rel); continue; }
    const k = `${bin}|${pkgDir}`;
    if (!groups.has(k)) groups.set(k, { cwd: pkgDir, cmd: process.execPath, args: vitest ? [bin, 'run'] : [bin, '--runTestsByPath'], files: [] });
    groups.get(k).files.push(posix(relative(pkgDir, abs)));
  }
  return { groups: [...groups.values()], missing };
}

async function runGroups(groups, { teamWork, key, logFile, timeoutMs, maxHeavy }) {
  let out = { ok: true, timedOut: false, ms: 0, tail: '' };
  for (const g of groups) {
    const res = await withHeavySlot(teamWork, { max: maxHeavy, key, name: 'mutants' }, () =>
      run(g.cmd, [...g.args, ...g.files], { cwd: g.cwd, timeoutMs, logFile, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }));
    out = { ok: out.ok && res.code === 0 && !res.timedOut, timedOut: out.timedOut || res.timedOut, ms: out.ms + res.ms, tail: res.code === 0 ? out.tail : res.tail.slice(-800) };
    if (!out.ok) break;
  }
  return out;
}

const preview = h => (h.newLines.find(l => l.trim()) ?? h.oldLines.find(l => l.trim()) ?? '').trim().slice(0, 140);

function view(record) {
  if (!record) return { state: 'none', hint: 'No mutation check recorded: call run_checks {action: "mutants"}.' };
  if (record.state === 'running') {
    return { state: 'running', runId: record.runId, hunks: record.total, done: (record.hunks ?? []).length,
      hint: 'Still running: call run_checks {action: "mutants"} again (it waits up to 110 s; start that exec with // @exec: {"yield_time_ms": 120000}). Change no source file meanwhile: each step edits one of your product files for a moment and puts it back.' };
  }
  const survived = (record.hunks ?? []).filter(h => h.result === 'survived');
  const base = { state: record.state, runId: record.runId, ms: record.ms, ...(record.skipped ? { skipped: record.skipped } : {}),
    hunks: record.total ?? 0, caught: (record.hunks ?? []).filter(h => h.result === 'caught').length,
    survived: survived.map(({ file, line, preview: p }) => ({ file, line, change: p })),
    ...(record.notRun ? { notRun: record.notRun } : {}), ...(record.baseline ? { baseline: record.baseline } : {}), log: record.log ?? null };
  if (record.state === 'stale') return { ...base, hint: 'Source changed while it ran: call run_checks {action: "mutants"} again once your edits are done.' };
  if (record.skipped) return { ...base, hint: `Nothing to check: ${record.skipped}.` };
  if (record.baseline) return { ...base, hint: 'Your new tests do not pass on your own source, so undoing a change says nothing: make them pass (run_checks), then call mutants again.' };
  return { ...base, hint: survived.length
    ? 'Each change listed under survived can be undone and every new test still passes: graders put that old behaviour back (a mutant) and expect your tests to fail. Change the case that covers it so the old and the new code give different observable results (EXP3I47A TASK-08: the line that should win the payee pass also won the fallback pass, so the case passed without the fix), or add a case. A change with no behaviour (refactor, log line, type only) needs no case: say so in your result. Then call mutants again.'
    : `Every change is caught by at least one new test.${record.notRun ? ' Some changes were not checked in the time budget (notRun).' : ''}` };
}

async function waitFor(teamWork, key, runId, waitSeconds) {
  const deadline = Date.now() + (Number(waitSeconds) > 0 ? MAX_WAIT_SECONDS : 0) * 1000;
  const mine = running.get(key);
  for (;;) {
    const record = readMutants(teamWork, key);
    if (!record || record.runId !== runId || record.state !== 'running') return view(record);
    if ((!mine || mine.runId !== runId) && !alive(record.pid)) {
      restorePending(teamWork, key);
      const lost = { ...record, state: 'lost', endedAt: new Date().toISOString() };
      writeFileAtomic(mutantsFile(teamWork, key), JSON.stringify(lost, null, 2));
      return { state: 'lost', hint: 'The helper process that ran this check is gone (your files are restored): call run_checks {action: "mutants"} again.' };
    }
    if (Date.now() >= deadline) return view(record);
    const step = sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    await (mine && mine.runId === runId ? Promise.race([mine.promise, step]) : step);
  }
}

// Một lần chạy mutants đang dở của item (của tiến trình còn sống): run_checks run không chạy cùng lúc với nó.
export function mutantsRunning(teamWork, key) {
  const r = readMutants(teamWork, key);
  return r?.state === 'running' && alive(r.pid) ? r : null;
}

export async function runMutants({ teamWorkspace, backlogItemKey: key, matchRoot, waitSeconds = MAX_WAIT_SECONDS, force = false,
  maxHunks = MAX_HUNKS, budgetMs = BUDGET_MS, maxHeavy = null }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  const where = locate(teamWorkspace, matchRoot);
  const teamWork = dirname(where.logDir);
  const current = readMutants(teamWork, key);
  if (current?.state === 'running' && alive(current.pid)) return waitFor(teamWork, key, current.runId, waitSeconds);
  restorePending(teamWork, key);
  const profile = detectProfile(where.matchRoot);
  if (!profile.root) fail('UNSUPPORTED_APP', 'no application found under matchRoot');
  const checkout = dirname(where.matchRoot), folder = basename(where.matchRoot);
  if (!existsSync(join(checkout, '.git'))) fail('UNSUPPORTED_APP', 'matchRoot is not inside a git checkout');
  const before = await sourceSnapshot(checkout, folder, profile).catch(() => null);
  if (!force && current?.state === 'done' && before && current.source === before.source && current.matchRoot === where.matchRoot) {
    return { ...view(current), cached: true, hint: `Source is unchanged since run ${current.runId}: ${view(current).hint}` };
  }
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const record = { runId, key, pid: process.pid, state: 'running', matchRoot: where.matchRoot, startedAt: new Date().toISOString(),
    source: before?.source ?? null, hunks: [] };
  mkdirSync(dirname(mutantsFile(teamWork, key)), { recursive: true });
  const save = () => { const now = readMutants(teamWork, key); if (!now || now.runId === runId) writeFileAtomic(mutantsFile(teamWork, key), JSON.stringify(record, null, 2)); };
  // Lần chạy mới nhận bản ghi về mình; các lần ghi sau chỉ khi chưa có lần chạy nào mới hơn.
  writeFileAtomic(mutantsFile(teamWork, key), JSON.stringify(record, null, 2));
  const finish = extra => { Object.assign(record, extra, { state: extra.state ?? 'done', endedAt: new Date().toISOString(), ms: Date.now() - Date.parse(record.startedAt) }); save(); };

  const { hunks: all, tests } = await mutationTargets(checkout, folder);
  if (!all.length || !tests.length) {
    finish({ total: 0, skipped: !all.length ? 'no change to an existing code file outside tests' : 'no new test file' });
    return view(record);
  }
  const { groups, missing } = testRunners(checkout, profile.root, tests);
  if (!groups.length) {
    finish({ total: 0, skipped: `no test runner found for ${missing.slice(0, 4).join(', ')} (vitest, jest or pytest of the package)` });
    return view(record);
  }
  const hunks = all.slice(0, maxHunks);
  record.total = hunks.length;
  record.tests = tests;
  if (all.length > hunks.length) record.notRun = all.slice(maxHunks).map(h => `${h.file}:${h.newStart}`);
  save();
  const scratch = join(teamWork, 'scratch', key, 'mutants');
  mkdirSync(scratch, { recursive: true });
  const evidenceDir = join(where.matchRoot, 'answers', key, 'evidence');
  const summary = [];
  const promise = (async () => {
    const t0 = Date.now();
    const baseline = await runGroups(groups, { teamWork, key, logFile: join(scratch, 'baseline.log'), timeoutMs: RUN_TIMEOUT_MS, maxHeavy });
    if (!baseline.ok) { finish({ baseline: { timedOut: baseline.timedOut, tail: baseline.tail } }); return; }
    const timeoutMs = Math.min(RUN_TIMEOUT_MS, Math.max(30_000, baseline.ms * 3));
    for (const [i, h] of hunks.entries()) {
      const row = { file: posix(h.file).slice(folder.length + 1), line: h.newStart, preview: preview(h) };
      if (Date.now() - t0 > budgetMs) { record.notRun = [...(record.notRun ?? []), `${row.file}:${row.line}`]; continue; }
      const target = join(checkout, h.file);
      let text;
      try { text = readFileSync(target, 'utf8'); } catch { record.hunks.push({ ...row, result: 'skipped', reason: 'file unreadable' }); continue; }
      const mutated = revertHunk(text, h);
      if (mutated === null) { record.hunks.push({ ...row, result: 'skipped', reason: 'file no longer matches the diff' }); continue; }
      const copy = join(scratch, `original-${i}`);
      writeFileSync(copy, text);
      writeFileAtomic(restoreFile(teamWork, key), JSON.stringify({ pid: process.pid, target, copy }));
      let res;
      try {
        writeFileSync(target, mutated);
        res = await runGroups(groups, { teamWork, key, logFile: join(scratch, `mutant-${i}.log`), timeoutMs, maxHeavy });
      } finally {
        writeFileSync(target, text);
        rmSync(restoreFile(teamWork, key), { force: true });
      }
      // Hết giờ với bản đột biến (vòng lặp vô hạn…) cũng là bộ test phát hiện được thay đổi.
      const result = res.ok ? 'survived' : 'caught';
      record.hunks.push({ ...row, result, ...(res.timedOut ? { note: 'timed out' } : {}) });
      summary.push(`${result.padEnd(8)} ${row.file}:${row.line}  ${row.preview}`);
      save();
    }
    const after = await sourceSnapshot(checkout, folder, profile).catch(() => null);
    const stale = Boolean(before && after && after.source !== before.source);
    try {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'mutants.log'), [`Each product change undone in turn, then the item's new tests run (${tests.map(t => posix(t).slice(folder.length + 1)).join(', ')}).`,
        'caught: a new test failed with the change undone; survived: every new test still passed.', '', ...summary, ''].join('\n'));
      record.log = 'evidence/mutants.log';
    } catch { /* evidence không ghi được thì thôi */ }
    finish({ state: stale ? 'stale' : 'done' });
  })().catch(error => {
    restorePending(teamWork, key);
    finish({ state: 'lost', error: String(error?.message ?? error).slice(0, 600) });
  }).finally(() => { if (running.get(key)?.runId === runId) running.delete(key); });
  running.set(key, { runId, promise });
  return waitFor(teamWork, key, runId, waitSeconds);
}

// Dùng ở candidate (helper của root): các chỗ sửa nào bộ test mới chưa bắt, theo lần chạy mutants khớp source hiện tại.
export function mutantSummary(record) {
  if (!record) return null;
  return { state: record.state, source: record.source ?? null, skipped: record.skipped ?? null, baseline: Boolean(record.baseline),
    survived: (record.hunks ?? []).filter(h => h.result === 'survived').map(h => `${h.file}:${h.line} (${h.preview})`) };
}
