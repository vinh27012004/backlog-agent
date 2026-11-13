// Tool `app`: helper chạy app của một worktree cho evidence (TOKXKPBV: fixer BUG-01 mất ~6 phút tự chạy `pnpm dev` 4 lần,
// `taskkill` theo port, dev server trả CSS cũ). Build bản production rồi `start` trong một tiến trình tách rời trên port
// trống từ 3100, log ở .team-work/logs/<ID>-app.log (không trong worktree: Windows khoá file log, worktree không xoá được).
// Trạng thái là file trong team-sdlc-pack/local/apps/ vì helper của subagent là tiến trình khác helper của root;
// `worktree remove` của root dừng app của item qua file đó.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest, sourceSnapshot } from '../core/candidates.mjs';
import { parseEnv } from './applogin.mjs';
import { detectProfile } from './environment.mjs';
import { childEnv, killTree, pwshScript } from '../core/jobs.mjs';
import { redact } from '../core/redact.mjs';
import { fail, sleep, writeFileAtomic } from '../core/util.mjs';

const FIRST_PORT = 3100;
const LAST_PORT = 3199;
// Một lần gọi chờ tối đa 110 s (< tool_timeout_sec 120) và trả về ngay khi app sẵn sàng; chờ dương nào cũng là chờ tối
// đa. QXUD1QAI CR-07: app start trả "starting" sau 50 s lúc 16:45:56, app lên lúc 16:46:22, worker không hỏi lại và
// bàn giao không có ảnh ở 16:47:39 (mất 19 điểm). Hạn chung cho chờ build của run_checks và chờ app trả lời.
const MAX_WAIT_SECONDS = 110;
const deadlineOf = waitSeconds => Date.now() + (Number(waitSeconds) > 0 ? MAX_WAIT_SECONDS : 0) * 1000;
const WAIT_HINT = 'waitSeconds 110 (start that exec with // @exec: {"yield_time_ms": 120000}); it returns as soon as the app answers';
const PORT_RETRIES = 3;
const WRAPPER = "const [cmd, ...args] = JSON.parse(process.argv[1]); "
  + "const r = require('child_process').spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }); process.exit(r.status ?? 1);";
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);

export const appsDir = teamWorkspace => join(teamWorkspace, 'team-sdlc-pack', 'local', 'apps');
const stateFile = (teamWorkspace, key) => join(appsDir(teamWorkspace), `${key}.json`);

export function readState(teamWorkspace, key) {
  try { return JSON.parse(readFileSync(stateFile(teamWorkspace, key), 'utf8')); } catch { return null; }
}

// Bản build production gần nhất của một thư mục app: snapshot source/môi trường lúc build và dấu của thư mục build
// (.next/BUILD_ID của Next.js). Start lại cùng snapshot thì chỉ start (NBDB5U0O: BUG-02 build hai lần đúng một source,
// ~35 s mỗi lần). App build thư mục đó thì ghi.
const buildsDir = teamWorkspace => join(teamWorkspace, 'team-sdlc-pack', 'local', 'builds');
const buildFile = (teamWorkspace, root) => join(buildsDir(teamWorkspace),
  `${digest(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)).slice(0, 24)}.json`);
const buildMarker = root => { try { return statSync(join(root, '.next', 'BUILD_ID')).mtimeMs; } catch { return null; } };

export function rememberBuild(teamWorkspace, root, snapshot, by) {
  if (!teamWorkspace || !root || !snapshot) return;
  writeFileAtomic(buildFile(teamWorkspace, root), JSON.stringify({ root: resolve(root), snapshot, marker: buildMarker(root), by,
    at: new Date().toISOString() }));
}

export function forgetBuild(teamWorkspace, root) {
  if (teamWorkspace && root) rmSync(buildFile(teamWorkspace, root), { force: true });
}

// `output`: app cần chính bản build đó còn nguyên trong thư mục (dấu build không đổi: không ai build tay hay chạy dev
// đè lên); gate chỉ cần biết đúng source và môi trường này đã build được.
export function reusableBuild(teamWorkspace, root, snapshot, { output = true } = {}) {
  if (!teamWorkspace || !root || !snapshot) return null;
  let rec;
  try { rec = JSON.parse(readFileSync(buildFile(teamWorkspace, root), 'utf8')); } catch { return null; }
  if (JSON.stringify(rec.snapshot) !== JSON.stringify(snapshot)) return null;
  if (output && (rec.marker ?? null) !== buildMarker(root)) return null;
  return { by: rec.by, at: rec.at };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}


// matchRoot phải là thư mục trận (chính hoặc worktree) trong TeamWorkspace/matches/<matchId>/; log nằm ở .team-work/logs.
export function locate(teamWorkspace, matchRoot) {
  if (typeof matchRoot !== 'string' || !isAbsolute(matchRoot)) fail('INVALID_ARGUMENT', 'matchRoot must be an absolute path');
  const abs = resolve(matchRoot);
  const rel = relative(join(teamWorkspace, 'matches'), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', 'matchRoot must be inside TeamWorkspace/matches');
  if (!existsSync(abs)) fail('NOT_FOUND', `${abs} does not exist`);
  return { matchRoot: abs, logDir: join(teamWorkspace, 'matches', rel.split(sep)[0], '.team-work', 'logs') };
}

// Trên Windows mỗi địa chỉ bind riêng: thử bind 127.0.0.1 vẫn được khi một app khác giữ `::` (next start, http.listen
// không host). L7TZXHII: server của test bị bỏ lại giữ :::3100, helper vẫn chọn 3100 cho cả 4 item, app nào cũng
// EADDRINUSE. Port chỉ trống khi bind được trên cả bốn; máy không có IPv6 thì bỏ qua lỗi họ địa chỉ.
const bindable = (port, host) => new Promise(ok => {
  const srv = createServer();
  srv.once('error', error => ok(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)));
  srv.listen({ port, host, exclusive: true }, () => srv.close(() => ok(true)));
});

const portFree = async port => {
  for (const host of ['::', '0.0.0.0', '127.0.0.1', '::1']) if (!await bindable(port, host)) return false;
  return true;
};

async function freePort(teamWorkspace) {
  const taken = new Set();
  try {
    for (const f of readdirSync(appsDir(teamWorkspace))) {
      const s = readState(teamWorkspace, f.replace(/\.json$/, ''));
      if (s && alive(s.pid)) taken.add(s.port);
    }
  } catch { /* chưa có app nào */ }
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) if (!taken.has(port) && await portFree(port)) return port;
  fail('NO_FREE_PORT', `ports ${FIRST_PORT}-${LAST_PORT} are all in use`);
}

// Lệnh build + start cho stack node. `next start` nhận -p (PORT trong .env của app có thể đè biến môi trường); app khác
// đọc PORT. Không có script start thì chạy dev (vẫn có PORT). mode "dev" chạy script dev, không build, cho MVS ghi
// "development app running" (Practice NO5X6J0K: BUG-01-TC-01 phải NOT_RUN vì tool chỉ chạy production, mất 67 điểm).
export function appCommand(matchRoot, port, mode = 'production') {
  const profile = detectProfile(matchRoot);
  if (profile.stack !== 'node') return { profile, error: `stack ${profile.stack}: start the app by hand (evidence playbook §1)` };
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(profile.root, 'package.json'), 'utf8')); } catch { /* detectProfile đã đọc được */ }
  const scripts = pkg.scripts ?? {};
  const pm = profile.packageManagerCommand ?? profile.packageManager;
  const viaNext = script => (/^next (start|dev)\b/.test(script ?? '') ? `${pm} exec ${script} -p ${port}` : null);
  const dev = scripts.dev ? viaNext(scripts.dev) ?? `${pm} run dev` : null;
  if (mode === 'dev') return dev ? { profile, build: null, start: dev, mode: 'dev' } : { profile, error: 'package.json has no dev script' };
  const start = scripts.start ? viaNext(scripts.start) ?? `${pm} run start` : dev;
  if (!start) return { profile, error: 'package.json has no start or dev script' };
  return { profile, build: scripts.start && profile.commands.build ? profile.commands.build : null, start, mode: scripts.start ? 'production' : 'dev' };
}

// Auth.js/NextAuth chuyển hướng (logout, callback) theo AUTH_URL/NEXTAUTH_URL trong .env của app; port ở đó khác port
// helper chọn thì logout đưa tới port không có app (Practice MZP27104, TASK-02: fixer ghi PASS cho smoke logout hỏng,
// thêm một lượt fixer). Next.js không ghi đè biến môi trường đã có bằng .env, nên chỉ đặt cho tiến trình app, không
// sửa file. Chỉ URL localhost; giữ đường dẫn (base path của auth).
const AUTH_URL_KEYS = ['AUTH_URL', 'NEXTAUTH_URL'];
const AUTH_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local'];

export function authUrlEnv(appRoot, port) {
  const out = {};
  for (const file of AUTH_ENV_FILES) {
    let env;
    try { env = parseEnv(readFileSync(join(appRoot, file), 'utf8')); } catch { continue; }
    for (const key of AUTH_URL_KEYS) {
      let url;
      try { url = new URL(env[key]); } catch { continue; }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) continue;
      const path = url.pathname === '/' && !env[key].endsWith('/') ? '' : url.pathname;
      out[key] = `${url.protocol}//${url.hostname}:${port}${path}${url.search}`;
    }
  }
  return out;
}

function tail(file, bytes = 3000) {
  try {
    const text = readFileSync(file, 'utf8');
    return redact(text.slice(-bytes)).replace(/\x1b\[[0-9;]*m/g, '');
  } catch { return ''; }
}

// Phần log do lần launch hiện tại ghi (lần thử lại vì port ghi tiếp sau log cũ).
function sinceLaunch(s) {
  try { return readFileSync(s.log).subarray(s.logFrom ?? 0).toString('utf8'); } catch { return ''; }
}

async function responds(port) {
  try {
    await fetch(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

// Chờ app trả lời HTTP (bất kỳ mã nào), tiến trình chết, hoặc hết waitSeconds. Chỉ `ready` khi tiến trình của mình còn
// sống: L7TZXHII trả `ready` vì app lạ trên port trả lời trong lúc app của item đã chết vì EADDRINUSE. App chết vì
// port bị chiếm (lệnh start chỉ chạy sau khi build xong) thì start lại không build trên port khác, tối đa PORT_RETRIES lần.
async function settle(teamWorkspace, key, deadline) {
  for (;;) {
    const s = readState(teamWorkspace, key);
    if (!s) return { state: 'stopped', hint: 'No app is running for this item: call app start.' };
    if (alive(s.pid) && await responds(s.port) && alive(s.pid)) {
      if (s.built && !s.recorded) await noteBuild(teamWorkspace, key, s);
      if (s.custom && !s.custom.sharedFrom && !s.shared) {
        try { rememberShared(teamWorkspace, key, s.matchRoot, s.custom); } catch { /* không nhớ được thì thôi */ }
        const current = readState(teamWorkspace, key);
        if (current?.pid === s.pid) writeFileAtomic(stateFile(teamWorkspace, key), JSON.stringify({ ...current, shared: true }));
      }
      return { state: 'ready', url: `http://localhost:${s.port}`, port: s.port, pid: s.pid, mode: s.mode, log: s.log,
        ...(s.reusedBuild ? { reusedBuild: s.reusedBuild } : {}), ...(s.authEnv ? { authEnv: s.authEnv } : {}),
        ...(s.custom?.sharedFrom ? { commandsFrom: s.custom.sharedFrom } : {}),
        hint: `Use this url in capture_evidence. Call app stop once your evidence is written.${s.custom?.sharedFrom
          ? ` Started with the project commands ${s.custom.sharedFrom} already ran successfully on this app (mode custom): send your own custom only when this start fails.` : ''}${s.authEnv
          ? ` ${Object.keys(s.authEnv).join('/')} already point at this port for this app: do not edit .env for it.` : ''}` };
    }
    if (!alive(s.pid)) {
      const retries = s.retries ?? 0;
      if (retries < PORT_RETRIES && /EADDRINUSE/.test(sinceLaunch(s))) {
        await launch(teamWorkspace, key, locate(teamWorkspace, s.matchRoot), s.requestedMode ?? s.mode, false, retries + 1,
          { built: s.built, snapshot: s.snapshot ?? null, reusedBuild: s.reusedBuild }, s.custom ?? null);
        continue;
      }
      rmSync(stateFile(teamWorkspace, key), { force: true });
      // Bản build dùng lại không start được (thư mục build hỏng, build tay dở dang): lần start sau phải build lại.
      if (s.reusedBuild) forgetBuild(teamWorkspace, s.appRoot);
      // Lệnh riêng của item hỏng mà đã có lệnh chạy được của item khác: bỏ lệnh hỏng, lần start sau dùng lệnh kia.
      const other = s.custom && !s.custom.sharedFrom ? sharedCommands(teamWorkspace, s.matchRoot) : null;
      if (other) rmSync(customFile(teamWorkspace, key), { force: true });
      return { state: 'failed', log: s.log, tail: tail(s.log),
        hint: other ? `Your custom commands did not start the app. The commands that started it for ${other.sharedFrom} are remembered: call app start again without custom.`
          : s.reusedBuild ? 'The reused build did not start: call app start again, it builds afresh.'
          : 'The build or the app exited: read the tail, fix the cause, then call app start again.' };
    }
    if (Date.now() >= deadline) {
      return { state: 'starting', port: s.port, pid: s.pid, log: s.log, seconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000),
        ...(s.reusedBuild ? { reusedBuild: s.reusedBuild } : {}),
        hint: `Still building or starting: call app status with ${WAIT_HINT}. Prepare your capture steps meanwhile.` };
    }
    await sleep(1000);
  }
}

// Build vừa xong và app đã trả lời: ghi bản build cho lần start sau và cho gate. Source hay môi trường đổi giữa lúc start
// và lúc này thì không ghi, vì không biết bản build khớp snapshot nào. Mỗi lần start xét một lần.
async function noteBuild(teamWorkspace, key, s) {
  const profile = detectProfile(s.matchRoot);
  const now = s.snapshot ? await sourceSnapshot(dirname(s.matchRoot), basename(s.matchRoot), profile).catch(() => null) : null;
  if (now && JSON.stringify(now) === JSON.stringify(s.snapshot)) rememberBuild(teamWorkspace, s.appRoot ?? profile.root, s.snapshot, 'app');
  const current = readState(teamWorkspace, key);
  if (current?.pid === s.pid) writeFileAtomic(stateFile(teamWorkspace, key), JSON.stringify({ ...current, recorded: true }));
}

// run_checks của chính item đang build thư mục này (helper tự chạy nó sau sync ở ready_for_evidence): chờ nó xong để
// dùng lại bản build, thay vì build chồng lên cùng thư mục .next (08OQBPW8: app tự build 56 s rồi run_checks build
// lại). Trạng thái đọc từ file vì run_checks có thể chạy trong helper của root.
async function checksBuilding(where, key, deadline) {
  const file = join(dirname(where.logDir), 'items', key, 'checks.json');
  for (;;) {
    let rec = null;
    try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { /* chưa có run_checks */ }
    // rec.build: bước build của lần chạy đã xong (checks.mjs ghi ngay), bộ test có thể vẫn chạy tiếp.
    if (rec?.state !== 'running' || !(rec.checks ?? []).includes('build') || rec.build || !alive(rec.pid)) return null;
    if (Date.now() >= deadline) {
      return { state: 'waiting_for_checks', runId: rec.runId,
        hint: `run_checks is still building this worktree: call app start again with ${WAIT_HINT}; it starts as soon as that build is done and reuses it, while the test suite may still run.` };
    }
    await sleep(1000);
  }
}

// Lệnh riêng của project (OMZJW0S0/UOMNKT6Z BUG-09: README "Commands during the match" build web rồi chạy sync-server
// với ACTUAL_* trỏ tới thư mục dữ liệu; lệnh start chung của node chạy sai app, fixer mất 2,5–3 phút tự khởi động server
// và hỏng 2 lần vì thiếu build/thư mục). Fixer đưa lệnh từ README, helper vẫn lo port, thư mục dữ liệu, log, chờ và dừng.
// {port}: port helper chọn; {data}: .team-work/app-data/<ID> (ngoài worktree, tạo sẵn, cả thư mục con một biến env trỏ
// tới); {matchRoot}: thư mục trận của worktree. Nhớ theo item để start lại sau khi sửa code không phải gửi lại.
const customFile = (teamWorkspace, key) => join(teamWorkspace, 'team-sdlc-pack', 'local', 'app-commands', `${key}.json`);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Lệnh riêng đã chạy được (app trả lời HTTP) nhớ theo app, cho item khác và trận sau cùng app. 33R91I3Q: lệnh start
// chung hỏng trên app này ('sh' is not recognized), lệnh riêng chỉ nhớ theo item nên BUG-09, CR-05, CR-07, CR-08 mỗi đề
// tự tìm lại, mỗi lần thử 83–121 s (CR-07 mất 6 trong 15 phút, CR-08 không kịp chụp ảnh nào). Dấu của app: manifest ở
// thư mục app (package.json…); cwd lưu tương đối theo matchRoot, đường dẫn worktree trong lệnh đổi thành {matchRoot}.
// Bản có bước build không bị bản không build ghi đè (đề đó dùng lại bản build của run_checks, đề khác chưa có).
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'go.mod', 'composer.json', 'Gemfile'];
function appSign(matchRoot) {
  let root;
  try { root = detectProfile(matchRoot).root ?? matchRoot; } catch { root = matchRoot; }
  for (const base of [root, matchRoot]) {
    for (const name of MANIFESTS) {
      try { return digest(`${name}\n${readFileSync(join(base, name), 'utf8').replace(/\r\n/g, '\n')}`).slice(0, 24); } catch { /* thử file kế */ }
    }
  }
  return null;
}
const sharedFile = (teamWorkspace, sign) => join(teamWorkspace, 'team-sdlc-pack', 'local', 'app-commands', `app-${sign}.json`);

export function rememberShared(teamWorkspace, key, matchRoot, custom) {
  const sign = appSign(matchRoot);
  if (!sign || !custom?.start) return null;
  const spots = [matchRoot, matchRoot.replace(/\\/g, '/'), matchRoot.replace(/\\/g, '\\\\')];
  const loose = text => spots.reduce((t, s) => t.split(s).join('{matchRoot}'), text);
  const step = s => ({ command: loose(s.command), cwd: relative(matchRoot, s.cwd).replace(/\\/g, '/') || '.' });
  const value = { from: key, at: new Date().toISOString(), build: (custom.build ?? []).map(step), start: step(custom.start),
    env: Object.fromEntries(Object.entries(custom.env ?? {}).map(([k, v]) => [k, loose(v)])) };
  // Còn đường dẫn tuyệt đối của trận hay worktree khác trong lệnh: không dùng lại được cho worktree khác.
  if (/\.team-work|[\\/]matches[\\/]/i.test(JSON.stringify(value).replaceAll('{matchRoot}', ''))) return null;
  const file = sharedFile(teamWorkspace, sign);
  try { if (JSON.parse(readFileSync(file, 'utf8')).build?.length && !value.build.length) return null; } catch { /* chưa có */ }
  writeFileAtomic(file, JSON.stringify(value));
  return value;
}

// App của item chạy bằng lệnh riêng có biến môi trường trỏ vào {data} (.team-work/app-data/<ID>): dữ liệu của nó là của
// riêng item, không cần khoá app_data chung. CUZ7KL95: CR-05 giữ khoá chung 10 phút, CR-08 (server riêng, thư mục dữ
// liệu riêng) chờ khoá và nộp ba kịch bản NOT_RUN. Xét app đang chạy, lệnh item đã nhớ, rồi lệnh nhớ theo app.
export function dedicatedAppData(teamWorkspace, key, matchRoot = null) {
  const own = custom => Object.values(custom?.env ?? {}).some(v => typeof v === 'string' && v.includes('{data}'));
  const state = readState(teamWorkspace, key);
  if (state?.custom) return own(state.custom) ? `app-data/${key}` : null;
  try { if (own(JSON.parse(readFileSync(customFile(teamWorkspace, key), 'utf8')))) return `app-data/${key}`; } catch { /* chưa có lệnh riêng */ }
  const root = matchRoot ?? state?.matchRoot ?? null;
  let shared = null;
  try { shared = root ? sharedCommands(teamWorkspace, root) : null; } catch { shared = null; }
  return shared && own(shared) ? `app-data/${key}` : null;
}

export function sharedCommands(teamWorkspace, matchRoot) {
  const sign = appSign(matchRoot);
  if (!sign) return null;
  try {
    const saved = JSON.parse(readFileSync(sharedFile(teamWorkspace, sign), 'utf8'));
    return { ...normalizeCustom({ build: saved.build, start: saved.start, env: saved.env }, matchRoot), sharedFrom: saved.from };
  } catch { return null; }
}

export function normalizeCustom(custom, matchRoot) {
  if (custom === undefined || custom === null) return null;
  if (typeof custom !== 'object' || Array.isArray(custom)) fail('INVALID_ARGUMENT', 'custom must be {build?, start, env?}');
  const step = (s, what) => {
    const v = typeof s === 'string' ? { command: s } : s;
    if (!v || typeof v.command !== 'string' || !v.command.trim() || v.command.length > 2000) fail('INVALID_ARGUMENT', `custom.${what}.command must be a non-empty command`);
    const cwd = resolve(matchRoot, typeof v.cwd === 'string' && v.cwd ? v.cwd : '.');
    const rel = relative(matchRoot, cwd);
    if (rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', `custom.${what}.cwd must stay inside matchRoot`);
    if (!existsSync(cwd)) fail('NOT_FOUND', `custom.${what}.cwd ${cwd} does not exist`);
    return { command: v.command, cwd };
  };
  const builds = custom.build === undefined || custom.build === null ? [] : Array.isArray(custom.build) ? custom.build : [custom.build];
  if (builds.length > 5) fail('INVALID_ARGUMENT', 'custom.build takes at most 5 steps');
  const env = custom.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env)) fail('INVALID_ARGUMENT', 'custom.env must be an object of strings');
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || typeof v !== 'string') fail('INVALID_ARGUMENT', `custom.env.${k} must be a string under a plain variable name`);
  }
  return { build: builds.map((b, i) => step(b, `build[${i}]`)), start: step(custom.start, 'start'), env: { ...env } };
}

function expand(text, vars) {
  return text.replace(/\{(port|data|matchRoot)\}/g, (_, name) => vars[name]);
}

export function stopApp(teamWorkspace, key) {
  const s = readState(teamWorkspace, key);
  if (!s) return { stopped: false, reason: 'no app recorded for this item' };
  killTree(s.pid);
  rmSync(stateFile(teamWorkspace, key), { force: true });
  return { stopped: true, pid: s.pid, port: s.port };
}

export async function app({ teamWorkspace, action, backlogItemKey: key, matchRoot, mode = 'production', build = true,
  custom = undefined, waitSeconds = MAX_WAIT_SECONDS }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  if (action === 'stop') return stopApp(teamWorkspace, key);
  const deadline = deadlineOf(waitSeconds);
  if (action === 'status') return settle(teamWorkspace, key, deadline);
  if (action !== 'start') fail('INVALID_ARGUMENT', 'action');
  if (!['production', 'dev'].includes(mode)) fail('INVALID_ARGUMENT', 'mode');

  const where = locate(teamWorkspace, matchRoot);
  // custom: {} (hay null) bỏ lệnh đã nhớ; không truyền thì dùng lại lệnh đã nhớ cho đúng worktree này.
  let commands = null;
  const forget = custom === null || (typeof custom === 'object' && !Array.isArray(custom) && !Object.keys(custom).length);
  if (forget) rmSync(customFile(teamWorkspace, key), { force: true });
  else if (custom !== undefined) {
    commands = normalizeCustom(custom, where.matchRoot);
    writeFileAtomic(customFile(teamWorkspace, key), JSON.stringify({ matchRoot: where.matchRoot, ...commands }));
  } else {
    try {
      const saved = JSON.parse(readFileSync(customFile(teamWorkspace, key), 'utf8'));
      if (saved.matchRoot === where.matchRoot) commands = saved;
    } catch { /* chưa có lệnh riêng */ }
    // Chưa có lệnh riêng của item: dùng lệnh một item khác đã chạy được trên cùng app.
    commands ??= sharedCommands(teamWorkspace, where.matchRoot);
  }
  const waiting = await checksBuilding(where, key, deadline);
  if (waiting) return waiting;
  // Start lại (sau khi sửa code, hay để chụp ảnh trước khi sửa) luôn là tiến trình mới; build lại khi source hay môi
  // trường khác bản build còn trong thư mục.
  stopApp(teamWorkspace, key);
  await launch(teamWorkspace, key, where, mode, build, 0, null, commands);
  return settle(teamWorkspace, key, deadline);
}

// Lần thử lại vì port (retries > 0) ghi tiếp vào log để vẫn thấy dòng EADDRINUSE trước đó, không build, và mang theo
// `carry` của lần đầu: bản build nó đã làm (built, snapshot) hay đã dùng lại (reusedBuild).
async function launch(teamWorkspace, key, where, mode, build, retries, carry = null, custom = null) {
  const port = await freePort(teamWorkspace);
  let root, snapshot = null, reused = null, building, steps, env, appMode, authEnv = {};
  if (custom) {
    // Lệnh riêng: bước build do fixer đưa chạy khi build !== false (lần thử lại vì port thì không); không ghi nhớ bản
    // build vì helper không biết thư mục output của nó.
    const data = join(dirname(where.logDir), 'app-data', key);
    const vars = { port: String(port), data, matchRoot: where.matchRoot };
    env = Object.fromEntries(Object.entries(custom.env ?? {}).map(([k, v]) => [k, expand(v, vars)]));
    mkdirSync(data, { recursive: true });
    for (const [k, v] of Object.entries(custom.env ?? {})) if (/^\{data\}/.test(v)) mkdirSync(env[k], { recursive: true });
    root = where.matchRoot;
    building = Boolean(!carry && build && custom.build.length);
    const at = (s, cwd) => process.platform === 'win32' ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${s}` : `cd '${cwd.replace(/'/g, "'\\''")}' && ${s}`;
    steps = [...(building ? custom.build : []), custom.start].map(s => at(expand(s.command, vars), s.cwd));
    appMode = 'custom';
  } else {
    const cmd = appCommand(where.matchRoot, port, mode);
    if (cmd.error) fail('UNSUPPORTED_APP', `${cmd.error}; or pass custom {build, start, env} with the project's own commands (README)`);
    root = cmd.profile.root;
    snapshot = carry ? carry.snapshot
      : existsSync(join(dirname(where.matchRoot), '.git')) ? await sourceSnapshot(dirname(where.matchRoot), basename(where.matchRoot), cmd.profile) : null;
    reused = !carry && build && cmd.build ? reusableBuild(teamWorkspace, root, snapshot) : null;
    building = Boolean(!carry && build && cmd.build && !reused);
    // Build mới hay dev server ghi đè thư mục build: bản ghi cũ không còn đúng.
    if (building || cmd.mode === 'dev') forgetBuild(teamWorkspace, root);
    steps = [building && cmd.build, cmd.start].filter(Boolean);
    authEnv = authUrlEnv(cmd.profile.root, port);
    env = authEnv;
    appMode = cmd.mode;
  }
  // Build rồi start trong một tiến trình tách rời, sống tiếp khi helper của subagent kết thúc. Vỏ là node: trên Windows
  // pwsh chạy detached (không console) không ghi gì ra file log, còn pwsh con của một node detached thì ghi được.
  const shell = process.platform === 'win32'
    ? ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      pwshScript(steps.map(s => `${s}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join('; '))]
    : ['sh', '-c', steps.join(' && ')];
  mkdirSync(where.logDir, { recursive: true });
  const log = join(where.logDir, `${key}-app.log`);
  const fd = openSync(log, retries ? 'a' : 'w');
  const logFrom = fstatSync(fd).size;
  let child;
  try {
    child = spawn(process.execPath, ['-e', WRAPPER, JSON.stringify(shell)], { cwd: root,
      env: childEnv({ PORT: String(port), ...env }), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const reusedBuild = reused ?? carry?.reusedBuild;
  // Lệnh riêng không ghi nhớ bản build (noteBuild chỉ xét built của lệnh chung).
  writeFileAtomic(stateFile(teamWorkspace, key), JSON.stringify({ key, pid: child.pid, port, mode: appMode, requestedMode: mode,
    built: custom ? false : building || Boolean(carry?.built), retries, matchRoot: where.matchRoot, appRoot: root, log, logFrom,
    startedAt: new Date().toISOString(), ...(snapshot ? { snapshot } : {}), ...(reusedBuild ? { reusedBuild } : {}),
    ...(custom ? { custom } : {}), ...(Object.keys(authEnv).length ? { authEnv } : {}) }));
}
