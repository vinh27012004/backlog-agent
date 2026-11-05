// Tool `run_checks`: helper chạy các bước kiểm cuối của một worktree (typecheck, build, cả bộ test) theo project
// profile, song song, ghi log vào answers/<ID>/evidence/ và chờ tới khi xong (tối đa waitSeconds). 9O802QWE: fixer tự
// chạy chuỗi typecheck → build → test trong shell rồi tốn 4–10 lượt model chỉ để chờ (`wait` 1 s) và đọc đuôi log
// (BUG-04: 10 lượt chờ, 60 s); mỗi lượt gửi lại cả context 60–110K token. Kết quả còn được ghi vào
// .team-work/items/<ID>/checks.json để worker_checkpoint candidate điền sẵn phần verification của fix-result.
// Build xong mà source và môi trường không đổi thì ghi nhớ bản build như app start, để `app start` sau đó dùng lại
// thay vì build lần nữa (~35–60 s).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sourceSnapshot } from '../core/candidates.mjs';
import { runPwsh } from '../core/jobs.mjs';
import { fail, sleep, writeFileAtomic } from '../core/util.mjs';
import { forgetBuild, locate, readState as appState, rememberBuild, stopApp } from './app.mjs';
import { detectProfile } from './environment.mjs';
import { runTests } from './testreport.mjs';

export const CHECKS = ['typecheck', 'build', 'test'];
const MAX_WAIT_SECONDS = 110;
const TIMEOUT_MS = { typecheck: 5 * 60_000, build: 10 * 60_000, test: 10 * 60_000 };
const LOG = { typecheck: 'typecheck.log', build: 'build.log', test: 'full-suite.log' };
// Tên check trong verification của fix-result.
export const CHECK_LABEL = { typecheck: 'typecheck', build: 'build', test: 'full test suite' };
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);

// Lần chạy đang dở trong tiến trình helper này (mỗi subagent có helper riêng): key → {runId, promise}.
const running = new Map();

export const checksFile = (teamWork, key) => join(teamWork, 'items', key, 'checks.json');
export function readChecks(teamWork, key) {
  try { return JSON.parse(readFileSync(checksFile(teamWork, key), 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const tailOf = (text, max) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(-max).trim();

async function runOne(name, profile, { logFile, scratch }) {
  const command = name === 'test' ? profile.commands.test_all : profile.commands[name];
  if (!command) return { name, command: null, state: 'skipped', reason: `the project profile has no ${name === 'test' ? 'test_all' : name} command` };
  if (name === 'test') {
    // Báo cáo JSON/JUnit của runner nằm ngoài worktree; chỉ log vào evidence.
    const scratchLog = join(scratch, LOG.test);
    const t = await runTests(profile, 'test_all', { logFile: scratchLog, timeoutMs: TIMEOUT_MS.test });
    try { copyFileSync(scratchLog, logFile); } catch { /* không có log thì thôi */ }
    const ok = !t.res.timedOut && t.res.code === 0;
    return { name, command, state: t.res.timedOut ? 'timeout' : ok ? 'passed' : 'failed', exitCode: t.res.code, ms: t.res.ms,
      counts: t.counts ?? null, failing: t.failing.slice(0, 40), ...(ok ? {} : { tail: tailOf(t.res.tail, 1500) }) };
  }
  const res = await runPwsh(command, { cwd: profile.root, timeoutMs: TIMEOUT_MS[name], logFile });
  const ok = !res.timedOut && res.code === 0;
  return { name, command, state: res.timedOut ? 'timeout' : ok ? 'passed' : 'failed', exitCode: res.code, ms: res.ms,
    ...(ok ? {} : { tail: tailOf(res.tail, 1500) }) };
}

// Một dòng verification cho mỗi check, đúng contract fix-result.
export function verificationRows(record) {
  const rows = [];
  for (const c of record?.results ?? []) {
    const result = c.state === 'passed' ? 'pass' : c.state === 'skipped' ? 'not_run' : c.state === 'failed' || c.state === 'timeout' ? 'fail' : 'not_run';
    const parts = [`run_checks ${c.state}`, c.log ? `log ${c.log}` : null,
      c.counts ? `${c.counts.passed ?? 0}/${c.counts.total ?? 0} passed, ${c.counts.failed ?? 0} failed` : null,
      c.failing?.length ? `failing: ${c.failing.slice(0, 8).join('; ')}` : null, c.reason ?? null];
    rows.push({ check: CHECK_LABEL[c.name] ?? c.name, command: c.command ?? null, result, note: parts.filter(Boolean).join('; ').slice(0, 1500) });
  }
  return rows;
}

function view(record, { waited = false } = {}) {
  if (!record) return { state: 'none', hint: 'No checks recorded for this item: call run_checks {action: "run"}.' };
  if (record.state === 'running') {
    return { state: 'running', runId: record.runId, checks: record.checks, startedAt: record.startedAt,
      seconds: Math.round((Date.now() - Date.parse(record.startedAt)) / 1000),
      hint: `Still running${waited ? ' after the wait' : ''}: call run_checks {action: "status", waitSeconds: ${MAX_WAIT_SECONDS}} (start that exec with // @exec: {"yield_time_ms": 120000}). Do not run these commands yourself meanwhile.` };
  }
  const failed = (record.results ?? []).filter(c => c.state === 'failed' || c.state === 'timeout');
  return { state: record.state, runId: record.runId, ok: !failed.length, ms: record.ms, results: record.results,
    ...(record.appStopped ? { appStopped: true } : {}), ...(record.buildRemembered ? { buildRemembered: true } : {}),
    hint: failed.length
      ? `Failed: ${failed.map(c => c.name).join(', ')}. Read the tail (full log under answers/${record.key}/evidence/), fix the cause, then run_checks again. Test failures listed in <baseline_failures> are not yours unless youFix is true.`
      : `All checks passed. Logs are in answers/${record.key}/evidence/ and worker_checkpoint candidate copies these results into the fix-result verification.${record.buildRemembered ? ' app start reuses this production build while the source stays unchanged: call it with the default build.' : ''}` };
}

async function waitFor(teamWork, key, runId, waitSeconds) {
  const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(waitSeconds) || 0)) * 1000;
  const mine = running.get(key);
  if (mine && mine.runId === runId) {
    await Promise.race([mine.promise, sleep(Math.max(0, deadline - Date.now()))]);
    return view(readChecks(teamWork, key), { waited: true });
  }
  // Lần chạy của tiến trình helper khác (worker khác của cùng item, hay helper đã khởi động lại): đọc file.
  for (;;) {
    const record = readChecks(teamWork, key);
    if (!record || record.runId !== runId || record.state !== 'running') return view(record);
    if (!alive(record.pid)) {
      const lost = { ...record, state: 'lost', results: [], endedAt: new Date().toISOString() };
      writeFileAtomic(checksFile(teamWork, key), JSON.stringify(lost, null, 2));
      return { ...view(lost), hint: 'The helper process that ran these checks is gone: call run_checks {action: "run"} again.' };
    }
    if (Date.now() >= deadline) return view(record, { waited: true });
    await sleep(1000);
  }
}

export async function runChecks({ teamWorkspace, action = 'run', backlogItemKey: key, matchRoot, checks = CHECKS,
  parallel = true, force = false, waitSeconds = MAX_WAIT_SECONDS }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  const where = locate(teamWorkspace, matchRoot);
  const teamWork = dirname(where.logDir);
  if (action === 'status') {
    const record = readChecks(teamWork, key);
    return record?.state === 'running' ? waitFor(teamWork, key, record.runId, waitSeconds) : view(record);
  }
  if (action !== 'run') fail('INVALID_ARGUMENT', 'action must be run or status');
  const names = [...new Set(Array.isArray(checks) && checks.length ? checks : CHECKS)];
  if (names.some(n => !CHECKS.includes(n))) fail('INVALID_ARGUMENT', `checks must be among ${CHECKS.join(', ')}`);
  const current = readChecks(teamWork, key);
  if (current?.state === 'running' && alive(current.pid)) return waitFor(teamWork, key, current.runId, waitSeconds);

  const profile = detectProfile(where.matchRoot);
  if (!profile.root) fail('UNSUPPORTED_APP', 'no application found under matchRoot: run the checks by hand');
  const checkout = dirname(where.matchRoot), folder = basename(where.matchRoot);
  const hasGit = existsSync(join(checkout, '.git'));
  // 08OQBPW8: mỗi worker chạy run_checks 3–4 lần (trước sync, sau sync, sau khi chép script seed, trước candidate),
  // 40–95 s mỗi lần. Source (ngoài answers/, challenge/) và môi trường như lần chạy xong trước thì trả lại kết quả đó.
  const before = hasGit ? await sourceSnapshot(checkout, folder, profile).catch(() => null) : null;
  if (!force && current?.state === 'done' && current.snapshot && before && JSON.stringify(current.snapshot) === JSON.stringify(before)
    && current.matchRoot === where.matchRoot) {
    const have = new Map((current.results ?? []).map(r => [r.name, r]));
    if (names.every(n => have.has(n) && have.get(n).state !== 'timeout')) {
      return { ...view({ ...current, results: current.results.filter(r => names.includes(r.name)) }), cached: true,
        hint: `Source and environment are unchanged since run ${current.runId}: these are its results, nothing was run again (force: true runs anyway).` };
    }
  }
  const evidenceDir = join(where.matchRoot, 'answers', key, 'evidence');
  const scratch = join(teamWork, 'scratch', key, 'checks');
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(dirname(checksFile(teamWork, key)), { recursive: true });
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const record = { runId, key, pid: process.pid, state: 'running', checks: names, parallel: Boolean(parallel),
    matchRoot: where.matchRoot, startedAt: new Date().toISOString() };
  // Build ghi đè thư mục build mà app (dev hay production) của item đang chạy dùng.
  if (names.includes('build') && appState(teamWorkspace, key)) { stopApp(teamWorkspace, key); record.appStopped = true; }
  writeFileAtomic(checksFile(teamWork, key), JSON.stringify(record, null, 2));

  const promise = (async () => {
    const t0 = Date.now();
    if (names.includes('build')) forgetBuild(teamWorkspace, profile.root);
    const one = name => runOne(name, profile, { logFile: join(evidenceDir, LOG[name]), scratch })
      .catch(error => ({ name, command: null, state: 'failed', tail: String(error?.message ?? error).slice(0, 600) }))
      .then(r => ({ ...r, ...(r.state === 'skipped' ? {} : { log: `evidence/${LOG[name]}` }) }));
    // typecheck không chạy cùng lúc với build: tsconfig của Next.js include '.next/types/**/*.ts', next build xoá rồi
    // dựng lại thư mục đó, tsc đang đọc thì báo TS6053 dù code đúng (ME1X0FFX: BUG-02 hạ 3 kịch bản đã đạt vì typecheck
    // "hỏng" giả ngay trước giờ đóng). Chạy typecheck trước (nhanh, hỏng sớm) rồi build; test song song với cả hai.
    const byName = {};
    const chain = async list => { for (const n of list) byName[n] = await one(n); };
    if (parallel) await Promise.all([chain(names.filter(n => n !== 'test')), chain(names.filter(n => n === 'test'))]);
    else await chain(names);
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
    writeFileAtomic(checksFile(teamWork, key), JSON.stringify(done, null, 2));
  })().catch(error => {
    writeFileAtomic(checksFile(teamWork, key), JSON.stringify({ ...record, state: 'lost', results: [], error: String(error?.message ?? error).slice(0, 600) }, null, 2));
  }).finally(() => { if (running.get(key)?.runId === runId) running.delete(key); });
  running.set(key, { runId, promise });
  return waitFor(teamWork, key, runId, waitSeconds);
}
