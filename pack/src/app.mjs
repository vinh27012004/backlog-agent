// Tool `app`: helper chạy app của một worktree cho evidence (TOKXKPBV: fixer BUG-01 mất ~6 phút tự chạy `pnpm dev` 4 lần,
// `taskkill` theo port, dev server trả CSS cũ). Build bản production rồi `start` trong một tiến trình tách rời trên port
// trống từ 3100, log ở .team-work/logs/<ID>-app.log (không trong worktree: Windows khoá file log, worktree không xoá được).
// Trạng thái là file trong team-sdlc-pack/local/apps/ vì helper của subagent là tiến trình khác helper của root;
// `worktree remove` của root dừng app của item qua file đó.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { detectProfile } from './environment.mjs';
import { childEnv, killTree } from './jobs.mjs';
import { redact } from './redact.mjs';
import { fail, sleep, writeFileAtomic } from './util.mjs';

const FIRST_PORT = 3100;
const LAST_PORT = 3199;
const MAX_WAIT_SECONDS = 50;
const WRAPPER = "const [cmd, ...args] = JSON.parse(process.argv[1]); "
  + "const r = require('child_process').spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }); process.exit(r.status ?? 1);";
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);

export const appsDir = teamWorkspace => join(teamWorkspace, 'team-sdlc-pack', 'local', 'apps');
const stateFile = (teamWorkspace, key) => join(appsDir(teamWorkspace), `${key}.json`);

function readState(teamWorkspace, key) {
  try { return JSON.parse(readFileSync(stateFile(teamWorkspace, key), 'utf8')); } catch { return null; }
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

const portFree = port => new Promise(ok => {
  const srv = createServer();
  srv.once('error', () => ok(false));
  srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => ok(true)));
});

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
  const pm = profile.packageManager;
  const viaNext = script => (/^next (start|dev)\b/.test(script ?? '') ? `${pm} exec ${script} -p ${port}` : null);
  const dev = scripts.dev ? viaNext(scripts.dev) ?? `${pm} run dev` : null;
  if (mode === 'dev') return dev ? { profile, build: null, start: dev, mode: 'dev' } : { profile, error: 'package.json has no dev script' };
  const start = scripts.start ? viaNext(scripts.start) ?? `${pm} run start` : dev;
  if (!start) return { profile, error: 'package.json has no start or dev script' };
  return { profile, build: scripts.start && profile.commands.build ? profile.commands.build : null, start, mode: scripts.start ? 'production' : 'dev' };
}

function tail(file, bytes = 3000) {
  try {
    const text = readFileSync(file, 'utf8');
    return redact(text.slice(-bytes)).replace(/\x1b\[[0-9;]*m/g, '');
  } catch { return ''; }
}

async function responds(port) {
  try {
    await fetch(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

// Chờ app trả lời HTTP (bất kỳ mã nào), tiến trình chết, hoặc hết waitSeconds.
async function settle(teamWorkspace, key, waitSeconds) {
  const s = readState(teamWorkspace, key);
  if (!s) return { state: 'stopped', hint: 'No app is running for this item: call app start.' };
  const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(waitSeconds) || 0)) * 1000;
  for (;;) {
    if (await responds(s.port)) {
      return { state: 'ready', url: `http://localhost:${s.port}`, port: s.port, pid: s.pid, mode: s.mode, log: s.log,
        hint: 'Use this url in capture_evidence. Call app stop once your evidence is written.' };
    }
    if (!alive(s.pid)) {
      rmSync(stateFile(teamWorkspace, key), { force: true });
      return { state: 'failed', log: s.log, tail: tail(s.log),
        hint: 'The build or the app exited: read the tail, fix the cause, then call app start again.' };
    }
    if (Date.now() >= deadline) {
      return { state: 'starting', port: s.port, pid: s.pid, log: s.log, seconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000),
        hint: 'Still building or starting: call app status with waitSeconds (up to 50).' };
    }
    await sleep(1000);
  }
}

export function stopApp(teamWorkspace, key) {
  const s = readState(teamWorkspace, key);
  if (!s) return { stopped: false, reason: 'no app recorded for this item' };
  killTree(s.pid);
  rmSync(stateFile(teamWorkspace, key), { force: true });
  return { stopped: true, pid: s.pid, port: s.port };
}

export async function app({ teamWorkspace, action, backlogItemKey: key, matchRoot, mode = 'production', build = true,
  waitSeconds = MAX_WAIT_SECONDS }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  if (action === 'stop') return stopApp(teamWorkspace, key);
  if (action === 'status') return settle(teamWorkspace, key, waitSeconds);
  if (action !== 'start') fail('INVALID_ARGUMENT', 'action');
  if (!['production', 'dev'].includes(mode)) fail('INVALID_ARGUMENT', 'mode');

  const where = locate(teamWorkspace, matchRoot);
  stopApp(teamWorkspace, key);   // start lại (sau khi sửa code, hay để chụp ảnh trước khi sửa) luôn là bản mới
  const port = await freePort(teamWorkspace);
  const cmd = appCommand(where.matchRoot, port, mode);
  if (cmd.error) fail('UNSUPPORTED_APP', cmd.error);
  const steps = [build && cmd.build, cmd.start].filter(Boolean);
  // Build rồi start trong một tiến trình tách rời, sống tiếp khi helper của subagent kết thúc. Vỏ là node: trên Windows
  // pwsh chạy detached (không console) không ghi gì ra file log, còn pwsh con của một node detached thì ghi được.
  const shell = process.platform === 'win32'
    ? ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ErrorActionPreference='Continue'; ${steps.map(s => `${s}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join('; ')}`]
    : ['sh', '-c', steps.join(' && ')];
  mkdirSync(where.logDir, { recursive: true });
  const log = join(where.logDir, `${key}-app.log`);
  const fd = openSync(log, 'w');
  let child;
  try {
    child = spawn(process.execPath, ['-e', WRAPPER, JSON.stringify(shell)], { cwd: cmd.profile.root, env: childEnv({ PORT: String(port) }),
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  child.unref();
  writeFileAtomic(stateFile(teamWorkspace, key), JSON.stringify({ key, pid: child.pid, port, mode: cmd.mode, built: steps.length > 1,
    matchRoot: where.matchRoot, log, startedAt: new Date().toISOString() }));
  return settle(teamWorkspace, key, waitSeconds);
}
