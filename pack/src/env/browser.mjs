// capture_evidence: điều khiển Edge/Chrome headless đã cài sẵn qua Chrome DevTools Protocol (CDP),
// không cần Playwright hay dependency nào. Chỉ mở URL loopback (app do đội tự chạy); ảnh chỉ lưu vào
// answers/<ID>/evidence/ trong thư mục trận. Click/gõ phím dùng sự kiện input thật nên React nhận.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { locate as locateMatchRoot } from './app.mjs';
import { seededAccount } from './applogin.mjs';
import { fail, HelperError, sleep } from '../core/util.mjs';
import { digest, sourceSnapshot } from '../core/candidates.mjs';
import { revParse, treeChanges } from '../core/git.mjs';
import { detectProfile } from './environment.mjs';
import { recordEvidence } from './evidence.mjs';

const MAX_TOTAL_MS = 50_000;

export function findBrowser() {
  const env = process.env;
  const candidates = [
    env.MTM_BROWSER_PATH,
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) ?? null;
}

const loopback = url => {
  let u;
  try { u = new URL(url); } catch { return false; }
  return ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
};

// Ảnh chỉ được ghi vào <TeamWorkspace>/matches/<matchId>/.../answers/<ID>/evidence/<file>.png
// Đường dẫn tương đối (answers/<ID>/evidence/x.png, evidence/x.png, x.png) tính từ context.matchRoot: PXWV53VC cả ba
// worker gửi đường dẫn tương đối, bị từ chối rồi gọi lại.
export function evidencePath(teamWorkspace, path, { pngOnly = true, base = null, key = null } = {}) {
  if (typeof path === 'string' && path && !isAbsolute(path) && base) {
    const parts = path.split(/[\\/]+/).filter(p => p && p !== '.');
    if (parts[0] === 'answers') path = join(base, ...parts);
    else if (key) path = join(base, 'answers', key, 'evidence', ...(parts[0] === 'evidence' ? parts.slice(1) : parts));
  }
  if (typeof path !== 'string' || !isAbsolute(path)) fail('INVALID_ARGUMENT', 'screenshot path must be absolute, or relative to context.matchRoot (answers/<ID>/evidence/<name>.png)');
  const abs = resolve(path);
  const rel = relative(join(teamWorkspace, 'matches'), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', 'screenshot must be inside TeamWorkspace/matches');
  const parts = rel.split(sep);
  const i = parts.lastIndexOf('evidence');
  if (i < 2 || parts[i - 2] !== 'answers' || i !== parts.length - 2 || (pngOnly && !/\.png$/i.test(abs))) {
    fail('PATH_NOT_ALLOWED', 'screenshot must be answers/<ID>/evidence/<name>.png');
  }
  let ancestor = resolve(teamWorkspace);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  const root = resolve(realpathSync(ancestor), relative(ancestor, resolve(teamWorkspace)));
  for (let p = abs; p !== dirname(p); p = dirname(p)) {
    if (!existsSync(p)) continue;
    const real = resolve(realpathSync(p), relative(p, abs)), inside = relative(root, real);
    if (inside.startsWith('..') || isAbsolute(inside)) fail('PATH_NOT_ALLOWED', 'evidence path follows a symlink outside TeamWorkspace');
    break;
  }
  return abs;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else ok(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HelperError('CDP_TIMEOUT', `${method} did not answer in 15 seconds`)); }, 15_000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); ok(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// Trên Windows Edge giữ DevToolsActivePort lúc đang ghi: đọc gặp EBUSY/EPERM thì thử lại. Mở hỏng vì bất kỳ lý do gì
// cũng phải kill Edge, nếu không tiến trình mồ côi giữ profile và lần sau cùng browserProfile báo BROWSER_START_FAILED
// (4D895OVI: BUG-04 mất khoảng 2,5 phút rồi phải đổi profile).
const FILE_BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function launch(browser, userDataDir, viewport) {
  mkdirSync(userDataDir, { recursive: true });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  try { rmSync(portFile, { force: true }); } catch (error) { if (!FILE_BUSY.has(error.code)) throw error; }
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--disable-sync',
    '--disable-features=msEdgeSidebarV2,EdgeCollections', `--window-size=${viewport.width},${viewport.height}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      let text = '';
      try { text = existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''; } catch (error) { if (!FILE_BUSY.has(error.code)) throw error; }
      const [port, path] = text.split(/\r?\n/);
      if (port && path) return { child, endpoint: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
      await sleep(100);
    }
    fail('BROWSER_START_FAILED', 'browser did not open a DevTools port; retry, or use a new browserProfile if it repeats');
  } catch (error) {
    kill(child);
    throw error;
  }
}

function kill(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* đã chết */ }
}

// JS chạy trong trang: tìm phần tử theo selector CSS, theo text hiển thị, hoặc cả hai (text lọc trong các phần tử
// khớp selector, `index` chọn phần tử thứ n).
const FIND = `(q) => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const textOf = el => ((el.innerText || el.textContent || '').trim() || el.getAttribute('aria-label') || '').trim().toLowerCase();
  const hasText = q.text !== undefined && q.text !== null && String(q.text) !== '';
  const want = String(q.text ?? '').trim().toLowerCase();
  if (q.selector) {
    const all = [...document.querySelectorAll(q.selector)].filter(visible);
    if (!hasText) return all[q.index || 0] || null;
    const exact = all.filter(el => textOf(el) === want);
    return (exact.length ? exact : all.filter(el => textOf(el).includes(want)))[q.index || 0] || null;
  }
  const pool = [...document.querySelectorAll('button,a,[role=button],[role=option],[role=menuitem],[role=tab],[role=link],label,summary,li,td,th,span,div,p,h1,h2,h3,h4,h5,h6,strong,dt,dd')].filter(visible);
  const exact = pool.filter(el => textOf(el) === want);
  const loose = pool.filter(el => textOf(el).includes(want));
  const pick = list => list.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
  return pick(exact) || pick(loose) || null;
}`;

// Bước login: đánh dấu ô mật khẩu đang hiện, ô tên/email đứng trước nó trong cùng form và nút gửi. null = không có form.
const LOGIN_FORM = `() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const el of document.querySelectorAll('[data-mtm-login]')) el.removeAttribute('data-mtm-login');
  const pass = [...document.querySelectorAll('input[type=password]')].find(visible);
  if (!pass) return null;
  const scope = pass.form || document;
  const fields = [...scope.querySelectorAll('input')].filter(el => visible(el) &&
    !/^(password|hidden|checkbox|radio|submit|button|image|file|reset)$/i.test(el.type));
  const before = fields.filter(el => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
  const user = before[before.length - 1] || fields[0];
  if (!user) return null;
  const buttons = [...scope.querySelectorAll('button,input[type=submit]')].filter(visible);
  const submit = buttons.find(b => (b.type || '').toLowerCase() === 'submit') ||
    buttons.find(b => /sign ?in|log ?in|đăng nhập/i.test(b.innerText || b.value || ''));
  user.setAttribute('data-mtm-login', 'user'); pass.setAttribute('data-mtm-login', 'password');
  if (submit) submit.setAttribute('data-mtm-login', 'submit');
  return { submit: !!submit };
}`;
const LOGIN_ROUTE = /\/(login|signin|sign-in|auth)\b/i;

// Practice #5 (BC3JL6ZC): fixer viết selector Playwright (`:has-text()`, `>> nth=0`); querySelectorAll ném lỗi,
// lỗi bị nuốt và tool chờ hết giờ rồi báo ELEMENT_NOT_FOUND. Chặn ngay, chỉ cách viết đúng.
const PLAYWRIGHT_ONLY = /:has-text\(|:text(-is|-matches)?\(|:visible\b|:nth-match\(|>>|^\s*(text|css|xpath|role)=/;

function checkSelector(s, i) {
  if (s.selector === undefined) return;
  if (typeof s.selector !== 'string' || !s.selector.trim()) fail('INVALID_SELECTOR', `step ${i + 1}: selector must be a non-empty CSS string`);
  if (PLAYWRIGHT_ONLY.test(s.selector)) {
    fail('INVALID_SELECTOR', `step ${i + 1}: "${s.selector}" is Playwright syntax; selector is plain CSS. ` +
      'Pick by visible text with {selector, text} (e.g. {selector:"[role=tab]", text:"Invoices"}) or {text} alone; index picks the n-th match');
  }
}

// Khi một bước lỗi: trang đang ở đâu và có gì bấm được, để lần gọi sau sửa bước mà không phải đoán. Phần tử gần bước
// hỏng lên đầu (chữ trùng, khớp selector của bước, trong dialog/listbox/main), link điều hướng xuống cuối (NBDB5U0O:
// BUG-02 hỏng [role=option] mà candidates chỉ là link sidebar). exact: phần tử có đúng chữ của bước; options: số option đang mở.
const PAGE_STATE = `(q) => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll('button,a[href],[role=tab],[role=button],[role=option],[role=menuitem],[role=combobox],input,select,textarea')].filter(visible);
  const describe = el => {
    const role = el.getAttribute('role'); const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name');
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (role ? '[role=' + role + ']' : '') +
      (name ? '[' + (el.getAttribute('aria-label') ? 'aria-label' : el.getAttribute('placeholder') ? 'placeholder' : 'name') + '="' + name.slice(0, 40) + '"]' : '') +
      (text ? ' "' + text + '"' : '');
  };
  const label = el => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const want = q && q.text ? String(q.text).trim().replace(/\\s+/g, ' ').toLowerCase() : '';
  let same = new Set();
  try { if (q && q.selector) same = new Set(document.querySelectorAll(q.selector)); } catch (e) { /* selector đã kiểm trước */ }
  const score = el => { const t = label(el); let s = 0;
    if (want && t === want) s += 8; else if (want && t.length > 2 && (t.includes(want) || want.includes(t))) s += 4;
    if (same.has(el)) s += 3;
    if (el.closest('[role=dialog],[role=listbox],[role=menu],main,[role=main]')) s += 2;
    if (el.closest('nav,aside,header,[role=navigation]')) s -= 1;
    return s; };
  const ranked = els.map((el, i) => ({ el, i, s: score(el) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.el);
  const exact = want ? ranked.find(el => label(el) === want) : null;
  const combo = els.find(el => el.getAttribute('role') === 'combobox');
  return { url: location.href, title: document.title, visibleText: (document.body && document.body.innerText || '').slice(0, 800),
    candidates: ranked.slice(0, 40).map(describe), exact: exact ? describe(exact) : null,
    options: els.filter(el => el.getAttribute('role') === 'option').length, combobox: combo ? describe(combo) : null };
}`;

// Gợi ý cho các lỗi hay gặp, từ trạng thái trang lúc hỏng.
export function failureHint(step, state, code) {
  if (!state) return null;
  if (state.url === 'about:blank') return 'This call never opened a page: start it with goto to the screen (each call opens a new blank page; browserProfile keeps the login cookie).';
  if (code !== 'ELEMENT_NOT_FOUND') return null;
  if (/role=["']?option/.test(step.selector ?? '') && !state.options) {
    return `No option list is open: a custom select renders its options only after a click on its trigger${state.combobox ? ` (${state.combobox})` : ''}; click it first.`;
  }
  if (state.exact && step.text !== undefined && step.text !== null) return `"${step.text}" is on the page as ${state.exact}: use that selector.`;
  return null;
}

// Pre-gate (tools.mjs) chạy test của item trong lúc worker chụp. Hỏng thì kết quả chụp báo luôn, để worker sửa code ngay
// thay vì chụp xong mới biết (helper của subagent không có session nên đọc journal của trận).
export function preGateNotice(teamWork, key) {
  try {
    const p = JSON.parse(readFileSync(join(teamWork, 'journal.json'), 'utf8')).items?.[key]?.preGate;
    return p?.state === 'failed' ? { jobId: p.jobId, failKind: p.failKind, detail: p.detail,
      hint: 'Your tests failed the early checks: stop evidence, fix the code, rerun the focused tests, then worker_checkpoint ready_for_evidence again.' } : null;
  } catch { return null; }
}

// Mỗi lần gọi mở một trang trắng: bước thao tác trước goto/login chắc chắn hỏng sau khi chờ hết giờ (NBDB5U0O BUG-02:
// click "New invoice" trên about:blank). Báo ngay, không mở trình duyệt.
const PAGE_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'drag', 'waitFor', 'assertText', 'screenshot', 'download']);

// Chỉ báo đang tải còn hiện: aria-busy, progressbar không xác định, skeleton/spinner phổ biến. null = không có.
const BUSY = `() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const el = [...document.querySelectorAll('[aria-busy=true],[role=progressbar]:not([aria-valuenow]),[data-loading=true],.animate-pulse,.animate-spin,.skeleton')].find(visible);
  return el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : null;
}`;

// Bước route (mục 13): trình duyệt tự trả lời request khớp `url` thay cho server, để chụp được cách app xử lý lỗi
// (500, timeout, mất mạng, mạng chậm) mà không sửa code hay tắt server/database dùng chung. Chỉ có tác dụng trong
// trình duyệt headless của lần gọi này. `url`: chuỗi con của URL, hoặc mẫu có `*`.
const ABORT_REASONS = new Set(['Failed', 'TimedOut', 'ConnectionRefused', 'ConnectionReset', 'InternetDisconnected', 'AddressUnreachable']);

function routeRule(s, i) {
  const bad = msg => fail('INVALID_ARGUMENT', `route at step ${i + 1}: ${msg}`);
  if (typeof s.url !== 'string' || !s.url.trim() || s.url.length > 300) bad('url must be a non-empty string');
  if (s.status !== undefined && !(Number.isInteger(s.status) && s.status >= 100 && s.status <= 599)) bad('status must be 100-599');
  if (s.abort !== undefined && !ABORT_REASONS.has(s.abort)) bad(`abort must be one of ${[...ABORT_REASONS].join(', ')}`);
  if (s.abort !== undefined && s.status !== undefined) bad('use either status or abort');
  if (s.status === undefined && s.abort === undefined && !s.delayMs) bad('give status, abort or delayMs');
  const delayMs = Math.min(30_000, Math.max(0, Number(s.delayMs) || 0));
  const pattern = s.url.includes('*') ? new RegExp(`^${s.url.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
  const body = s.body === undefined ? '' : typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
  return { step: i + 1, url: s.url, method: s.method ? String(s.method).toUpperCase() : null, status: s.status ?? null, abort: s.abort ?? null,
    delayMs, body, contentType: s.contentType ?? (typeof s.body === 'object' ? 'application/json' : 'text/plain; charset=utf-8'),
    left: Number.isInteger(s.times) && s.times > 0 ? s.times : Infinity,
    matches(url, method) { return (pattern ? pattern.test(url) : url.includes(s.url)) && (!this.method || this.method === method); } };
}

export async function captureEvidence({ teamWorkspace, steps, viewport = { width: 1366, height: 900 }, browserProfile = null,
  timeoutMs = 45_000, context = null }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 60) fail('INVALID_ARGUMENT', 'steps must be 1-60 actions');
  const browser = findBrowser();
  if (!browser) fail('BROWSER_NOT_FOUND', 'no Edge or Chrome installation found');
  const vp = { width: Math.min(3840, Math.max(320, viewport.width | 0 || 1366)), height: Math.min(4000, Math.max(240, viewport.height | 0 || 900)) };
  // Kiểm toàn bộ bước trước khi mở trình duyệt.
  const rules = new Map();
  const accounts = new Map();
  const output = { base: context?.matchRoot ? locateMatchRoot(teamWorkspace, context.matchRoot).matchRoot : null, key: context?.backlogItemKey ?? null };
  let opened = false;
  for (const [i, s] of steps.entries()) {
    if (['goto', 'login'].includes(s.action) && !loopback(s.url)) fail('URL_NOT_ALLOWED', `${s.action} only accepts http(s)://localhost or 127.0.0.1`);
    if (s.action === 'login') accounts.set(i, seededAccount(locateMatchRoot(teamWorkspace, s.matchRoot).matchRoot));
    if (s.action === 'screenshot') s.path = evidencePath(teamWorkspace, s.path, output);
    if (s.action === 'download') s.path = evidencePath(teamWorkspace, s.path, { ...output, pngOnly: false });
    if (s.action === 'route') rules.set(i, routeRule(s, i));
    if (s.action === 'drag') {
      if (!s.to || typeof s.to !== 'object' || (s.to.selector === undefined && s.to.text === undefined)) {
        fail('INVALID_ARGUMENT', `step ${i + 1}: drag needs to:{selector|text, index?}`);
      }
      if (s.position !== undefined && !['before', 'after', 'center'].includes(s.position)) fail('INVALID_ARGUMENT', `step ${i + 1}: position is before, after or center`);
      checkSelector(s.to, i);
    }
    checkSelector(s, i);
    if (['goto', 'login'].includes(s.action)) opened = true;
    else if (PAGE_ACTIONS.has(s.action) && !opened) {
      fail('INVALID_ARGUMENT', `step ${i + 1} (${s.action}) comes before any goto or login: each call opens a new blank page, so start with goto to the screen (browserProfile keeps the login cookie)`);
    }
  }
  let provenance = null;
  if (context) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(context.backlogItemKey ?? '') || !context.scenario
      || !['before_fix', 'final'].includes(context.phase) || !['dev', 'production'].includes(context.appMode)) fail('INVALID_ARGUMENT', 'evidence context needs backlogItemKey, scenario, phase before_fix|final and appMode dev|production');
    const where = locateMatchRoot(teamWorkspace, context.matchRoot);
    for (const s of steps.filter(s => ['screenshot', 'download'].includes(s.action))) {
      if (dirname(s.path) !== join(where.matchRoot, 'answers', context.backlogItemKey, 'evidence')) fail('PATH_NOT_ALLOWED', 'evidence context and output item/worktree must match');
    }
    const snapshot = await sourceSnapshot(dirname(where.matchRoot), basenamePath(where.matchRoot), detectProfile(where.matchRoot));
    const appState = join(teamWorkspace, 'team-sdlc-pack', 'local', 'apps', `${context.backlogItemKey}.json`);
    if (existsSync(appState)) {
      const running = JSON.parse(readFileSync(appState, 'utf8'));
      if (resolve(running.matchRoot) !== resolve(where.matchRoot) || running.mode !== context.appMode) fail('EVIDENCE_APP_MISMATCH', 'running app worktree/mode differs from evidence context');
      if (running.snapshot && JSON.stringify(running.snapshot) !== JSON.stringify(snapshot)) {
        // Nói rõ cái gì đổi để worker biết chính nó vừa sửa file nào sau khi start app.
        const changed = running.snapshot.source !== snapshot.source
          ? `source files ${(await treeChanges(dirname(where.matchRoot), running.snapshot.source, snapshot.source)).slice(0, 6).join(', ') || 'unknown'}`
          : 'environment (.env or installed dependencies)';
        fail('EVIDENCE_STALE_APP', `${changed} changed since app start; restart the app before evidence`);
      }
    }
    // base: HEAD của worktree lúc chụp, để preflight biết file nào đổi sau đó là do sync kéo từ main về.
    const base = await revParse(dirname(where.matchRoot)).catch(() => null);
    provenance = { ...snapshot, base, worktree: where.matchRoot, appMode: context.appMode, scenario: String(context.scenario), phase: context.phase,
      teamWork: dirname(where.logDir), key: context.backlogItemKey };
  }
  const profileDir = browserProfile && /^[A-Za-z0-9_-]{1,40}$/.test(browserProfile)
    ? join(teamWorkspace, 'team-sdlc-pack', 'local', 'browser', browserProfile)
    : join(tmpdir(), `mtm-browser-${process.pid}-${Date.now()}`);
  const deadline = Date.now() + Math.min(MAX_TOTAL_MS, timeoutMs);
  const { child, endpoint } = await launch(browser, profileDir, vp);
  const log = [];
  const consoleErrors = [];
  const shots = [];
  const downloads = [];
  const downloadDir = join(teamWorkspace, 'team-sdlc-pack', 'local', 'downloads', randomUUID());
  let ws;
  let cdp;
  try {
    ws = new WebSocket(endpoint);
    await new Promise((ok, reject) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true }); });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => cdp.send(m, p, sessionId);
    if (steps.some(s => s.action === 'download')) {
      mkdirSync(downloadDir, { recursive: true });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
    }
    const saved = (path, kind) => {
      const bytes = readFileSync(path), sha256 = digest(bytes);
      const record = { path, bytes: bytes.length, sha256 };
      if (provenance) {
        const { teamWork, key, ...origin } = provenance;
        recordEvidence(teamWork, key, { ...origin, ...record, name: basenamePath(path), kind, capturedAt: new Date().toISOString() });
      }
      return record;
    };
    cdp.listeners.push(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      }
      if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 300));
    });
    // Request đang bay, để screenshot chờ dữ liệu về (WebSocket/EventSource sống mãi nên không tính).
    const inflight = new Map();
    cdp.listeners.push(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.requestWillBeSent' && msg.params.type !== 'EventSource') inflight.set(msg.params.requestId, { url: msg.params.request.url, at: Date.now() });
      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') inflight.delete(msg.params.requestId);
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });

    // route: luật bật từ bước của nó trở đi, luật mới nhất thắng; unroute bỏ hết. Request không khớp đi tiếp như thường.
    const active = [];
    const routed = [];
    if (rules.size) {
      cdp.listeners.push(msg => {
        if (msg.sessionId !== sessionId || msg.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = msg.params;
        const rule = active.find(r => r.left > 0 && r.matches(request.url, request.method));
        (async () => {
          if (!rule) return send('Fetch.continueRequest', { requestId });
          rule.left--;
          routed.push({ step: rule.step, method: request.method, url: request.url.slice(0, 200),
            ...(rule.status ? { status: rule.status } : {}), ...(rule.abort ? { abort: rule.abort } : {}), ...(rule.delayMs ? { delayMs: rule.delayMs } : {}) });
          if (rule.delayMs) await sleep(rule.delayMs);
          if (rule.abort) return send('Fetch.failRequest', { requestId, errorReason: rule.abort });
          if (!rule.status) return send('Fetch.continueRequest', { requestId });
          return send('Fetch.fulfillRequest', { requestId, responseCode: rule.status,
            responseHeaders: [{ name: 'Content-Type', value: rule.contentType }], body: Buffer.from(rule.body).toString('base64') });
        })().catch(() => { /* request đã huỷ (trang chuyển đi) */ });
      });
      await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    }

    const evaluate = async (expression, arg) => {
      const res = await send('Runtime.evaluate', { expression: arg === undefined ? expression : `(${expression})(${JSON.stringify(arg)})`,
        returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
      return res.result.value;
    };
    const waitReady = async () => {
      const until = Math.min(deadline, Date.now() + 15_000);
      while (Date.now() < until) {
        if (await evaluate('document.readyState').catch(() => null) === 'complete') return;
        await sleep(100);
      }
    };
    // Trang yên khi 500 ms liền không còn request (bỏ long-poll đã chạy quá 15 s) và không còn chỉ báo loading hiện
    // trên màn hình. PXWV53VC BUG-01: ảnh dashboard chụp sau 400 ms còn toàn "—", reviewer bắt chụp lại.
    // Trả null khi yên, hoặc thứ còn đang chờ khi hết maxMs (vẫn chụp, kết quả ghi `unsettled`).
    const settle = async maxMs => {
      const until = Math.min(deadline, Date.now() + maxMs);
      let quietSince = null;
      for (;;) {
        const now = Date.now();
        const pending = [...inflight.values()].filter(r => now - r.at < 15_000);
        const busy = pending.length ? null : await evaluate(`(${BUSY})()`).catch(() => null);
        if (pending.length || busy) quietSince = null;
        else if (now - (quietSince ??= now) >= 500) return null;
        if (now >= until) return { pending: pending.slice(0, 3).map(r => r.url.slice(0, 120)), busy };
        await sleep(100);
      }
    };
    const locate = async (q, waitMs = 5000) => {
      const until = Math.min(deadline, Date.now() + waitMs);
      for (;;) {
        const box = await evaluate(`(q) => { const el = (${FIND})(q); if (!el) return null; el.scrollIntoView({block:'center', inline:'center'});
          const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName }; }`, q)
          .catch(e => /not a valid selector/i.test(e.message) ? fail('INVALID_SELECTOR', `${q.selector} is not valid CSS`) : null);
        if (box) return box;
        if (Date.now() >= until) fail('ELEMENT_NOT_FOUND', q.selector ?? `text "${q.text}"`);
        await sleep(150);
      }
    };
    // Click như người dùng: chỉ bấm khi điểm giữa phần tử ổn định và không bị phần tử khác che.
    // Bị che (vd sidebar đè nội dung) → ELEMENT_OBSCURED, trừ khi force thì click bằng JS.
    const click = async (q, { timeoutMs = 5000, force = false } = {}) => {
      const until = Math.min(deadline, Date.now() + timeoutMs);
      let last = null;
      for (;;) {
        const box = await locate(q, Math.max(500, until - Date.now()));
        await sleep(120);
        const probe = await evaluate(`(q) => { const el = (${FIND})(q); if (!el) return null; const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y);
          const label = n => n ? (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ' "' + (n.innerText || n.getAttribute('aria-label') || '').trim().slice(0, 40) + '"') : 'nothing';
          return { x, y, covered: !hit || !(el === hit || el.contains(hit)), by: label(hit) }; }`, q).catch(() => null);
        if (probe && !probe.covered && Math.abs(probe.x - box.x) < 2 && Math.abs(probe.y - box.y) < 2) {
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: probe.x, y: probe.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
          }
          return { obscured: false };
        }
        last = probe;
        if (Date.now() >= until) break;
      }
      if (force && last) {
        // Cho lớp che (vd sidebar của BUG-01 đè tab Invoices ở mọi item khác) tạm pointer-events:none rồi bấm bằng
        // chuột thật như thường: Radix Tabs/Select nhận đúng chuỗi pointer. Trả lại style sau cú bấm.
        const through = await evaluate(`(q) => { const el = (${FIND})(q); if (!el) return null;
          for (let n = 0; n < 6; n++) {
            const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (hit && (el === hit || el.contains(hit))) return { x, y };
            if (!hit || hit.contains(el)) return null;
            let cover = hit; while (cover.parentElement && !cover.parentElement.contains(el)) cover = cover.parentElement;
            cover.setAttribute('data-mtm-pe', cover.style.pointerEvents || ''); cover.style.pointerEvents = 'none';
          }
          return null; }`, q).catch(() => null);
        if (through) {
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: through.x, y: through.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
          }
        }
        await evaluate(`() => { for (const el of document.querySelectorAll('[data-mtm-pe]')) {
          el.style.pointerEvents = el.getAttribute('data-mtm-pe'); el.removeAttribute('data-mtm-pe'); } }`).catch(() => null);
        if (through) return { obscured: true, by: last.by, forced: true };
        // Không gỡ được lớp che: đủ chuỗi sự kiện con trỏ bằng JS (Radix kích hoạt ở pointerdown/mousedown).
        await evaluate(`(q) => { const el = (${FIND})(q); const r = el.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse', isPrimary: true };
          el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o)); el.focus?.();
          el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); }`, q);
        return { obscured: true, by: last.by, forced: true };
      }
      fail('ELEMENT_OBSCURED', `${q.selector ?? `text "${q.text}"`} is covered by ${last?.by ?? 'another element'} at its centre; ` +
        'force:true clicks through the cover');
    };
    // Gõ như người dùng: bấm vào ô, chọn hết, xoá, chèn text (input có kiểm soát của React nhận sự kiện input).
    const fill = async (q, value, opts) => {
      const r = await click(q, opts);
      await evaluate(`(q) => { const el = (${FIND})(q); el.focus(); if (el.select) el.select(); }`, q);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.insertText', { text: String(value ?? '') });
      return r;
    };

    let at = -1;
    try {
      for (const [i, s] of steps.entries()) {
        at = i;
        if (Date.now() > deadline) fail('CAPTURE_TIMEOUT', `stopped before step ${i + 1}`);
        const q = { selector: s.selector, text: s.text, index: s.index };
        switch (s.action) {
          case 'goto':
            await send('Page.navigate', { url: s.url });
            await waitReady();
            break;
          case 'click': {
            const r = await click(q, { timeoutMs: s.timeoutMs, force: s.force });
            if (r.obscured) log.push({ step: i + 1, action: 'click', obscuredBy: r.by, forced: true });
            break;
          }
          case 'fill': {
            const r = await fill(q, s.value, { timeoutMs: s.timeoutMs, force: s.force });
            if (r.obscured) log.push({ step: i + 1, action: 'fill', obscuredBy: r.by, forced: true });
            break;
          }
          case 'login': {
            // Tài khoản seed do helper tìm (applogin.mjs); giá trị không vào log, kết quả hay error.details.
            const account = accounts.get(i);
            await send('Page.navigate', { url: s.url });
            await waitReady();
            const formUntil = Math.min(deadline, Date.now() + 10_000);
            let form = null;
            while (!(form = await evaluate(`(${LOGIN_FORM})()`).catch(() => null))) {
              const href = await evaluate('location.pathname').catch(() => '');
              if (Date.now() >= formUntil || (href && !LOGIN_ROUTE.test(href) && await evaluate('document.readyState').catch(() => '') === 'complete')) break;
              await sleep(200);
            }
            if (!form) {
              const href = await evaluate('location.pathname').catch(() => '');
              if (LOGIN_ROUTE.test(href)) fail('LOGIN_FORM_NOT_FOUND', `no username + password field on ${s.url}`);
              log.push({ step: i + 1, action: 'login', alreadySignedIn: true });
              break;
            }
            await fill({ selector: '[data-mtm-login=user]' }, account.username, { force: true });
            await fill({ selector: '[data-mtm-login=password]' }, account.password, { force: true });
            if (form.submit) await click({ selector: '[data-mtm-login=submit]' }, { force: true });
            else await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
              .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
            const until = Math.min(deadline, Date.now() + (s.timeoutMs ?? 15_000));
            while (await evaluate(`[...document.querySelectorAll('input[type=password]')].some(el => el.getBoundingClientRect().width > 0)`).catch(() => true)) {
              if (Date.now() >= until) {
                fail('LOGIN_FAILED', `still on the sign-in form after submitting the seeded account (${account.sources.join(', ')}); ` +
                  'read error.details.visibleText for the app\'s message');
              }
              await sleep(200);
            }
            await waitReady();
            log.push({ step: i + 1, action: 'login', account: account.sources });
            break;
          }
          case 'press': {
            // Space + mũi tên: kéo-thả bằng bàn phím của @hello-pangea/dnd, dnd-kit (Space nhấc, mũi tên di, Space thả).
            const key = s.key === ' ' || s.key === 'Space' ? ' ' : String(s.key ?? 'Enter');
            const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, ' ': 32 };
            const code = key === ' ' ? 'Space' : key;
            for (const type of ['keyDown', 'keyUp']) {
              await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: codes[key] ?? 0,
                ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : type === 'keyDown' && key === ' ' ? { text: ' ' } : {}) });
            }
            break;
          }
          case 'drag': {
            // Kéo bằng chuột thật (FMC0ZXFC BUG-04: không có step kéo-thả, TC-02 NOT_RUN). Nhấn ở giữa nguồn, nhích quá
            // ngưỡng bắt đầu kéo (5 px của @hello-pangea/dnd), đi từng bước tới mép trên (before) / dưới (after) / giữa đích.
            const to = { selector: s.to.selector, text: s.to.text, index: s.to.index };
            await locate(to, s.timeoutMs);
            const from = await locate(q, s.timeoutMs);
            const dst = await evaluate(`(q) => { const el = (${FIND})(q); if (!el) return null; const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom }; }`, to);
            if (!dst) fail('ELEMENT_NOT_FOUND', to.selector ?? `text "${to.text}"`);
            const ty = s.position === 'before' ? dst.top + 4 : s.position === 'after' ? dst.bottom - 4 : dst.y;
            const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left',
              buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
            await mouse('mousePressed', from.x, from.y);
            await sleep(150);
            await mouse('mouseMoved', from.x, from.y + (ty < from.y ? -10 : 10));
            await sleep(100);
            const moves = 20;
            for (let n = 1; n <= moves; n++) {
              await mouse('mouseMoved', from.x + (dst.x - from.x) * n / moves, from.y + (ty - from.y) * n / moves);
              await sleep(25);
            }
            await sleep(250);
            await mouse('mouseReleased', dst.x, ty);
            await sleep(Math.min(3000, s.settleMs ?? 500));
            log.push({ step: i + 1, action: 'drag', from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(dst.x), y: Math.round(ty) } });
            break;
          }
          case 'select':
            await locate(q, s.timeoutMs);
            await evaluate(`(q) => { const el = (${FIND})(q); el.value = q.value; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }`, { ...q, value: s.value });
            break;
          case 'waitFor':
            if (s.selector && !s.state) { await locate(q, s.timeoutMs ?? 10_000); break; }
            {
              const until = Math.min(deadline, Date.now() + (s.timeoutMs ?? 10_000));
              const want = String(s.text ?? '').toLowerCase();
              if (s.state && !['visible', 'hidden', 'enabled'].includes(s.state)) fail('INVALID_ARGUMENT', 'waitFor state is visible, hidden or enabled');
              while (!(await evaluate(`(q) => { const el = (${FIND})(q); return q.state === 'hidden' ? !el : q.state === 'enabled' ? !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' : q.selector ? !!el : !!document.body && document.body.innerText.toLowerCase().includes(q.want); }`, { ...q, want, state: s.state }).catch(() => false))) {
                if (Date.now() >= until) fail('ELEMENT_NOT_FOUND', `text "${s.text}"`);
                await sleep(150);
              }
            }
            break;
          case 'wait':
            await sleep(Math.min(10_000, Math.max(0, s.ms | 0)));
            break;
          case 'route':
            active.unshift(rules.get(i));
            break;
          case 'unroute':
            active.length = 0;
            break;
          case 'assertText': {
            // Chờ text xuất hiện (mặc định 5 s): ngay sau click điều hướng, kiểm tức thì báo sai ASSERT_FAILED
            // (PXWV53VC BUG-01 mobile: click "Money" rồi assertText "Accounting" khi trang chưa chuyển).
            const until = Math.min(deadline, Date.now() + (s.timeoutMs ?? (s.required === false ? 0 : 5000)));
            let found;
            while (!(found = await evaluate(`(t) => !!document.body && document.body.innerText.includes(t)`, String(s.text)).catch(() => false))
              && Date.now() < until) await sleep(150);
            log.push({ step: i + 1, action: 'assertText', text: s.text, found });
            if (!found && s.required !== false) fail('ASSERT_FAILED', `text not on page: ${s.text}`);
            break;
          }
          case 'screenshot': {
            await sleep(Math.min(3000, s.settleMs ?? 400));
            // idle:false chụp ngay (bằng chứng trạng thái đang tải, vd sau route delayMs).
            const unsettled = s.idle === false ? null : await settle(6000);
            let params = { format: 'png' };
            if (s.fullPage) {
              const m = await send('Page.getLayoutMetrics');
              const size = m.cssContentSize ?? m.contentSize;
              params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(15000, Math.ceil(size.height)), scale: 1 } };
            }
            const { data } = await send('Page.captureScreenshot', params);
            mkdirSync(dirname(s.path), { recursive: true });
            writeFileSync(s.path, Buffer.from(data, 'base64'));
            const bytes = statSync(s.path).size;
            if (bytes > 5 * 1024 * 1024) fail('SCREENSHOT_TOO_LARGE', `${s.path} is ${bytes} bytes`);
            shots.push(saved(s.path, 'screenshot'));
            log.push({ step: i + 1, action: 'screenshot', ...(unsettled ? { unsettled,
              hint: 'still loading after 6 s: waitFor the loaded content, then capture again (idle:false only for loading-state evidence)' } : {}) });
            break;
          }
          case 'download': {
            let guid = null, complete = false, cancelled = null;
            // Listener được đăng ký trước click: cả URL download và Blob dùng cùng profile/cookie của trang.
            const listener = msg => {
              if (msg.method === 'Browser.downloadWillBegin' && !guid) {
                guid = msg.params.guid;
                const url = msg.params.url;
                if (!(loopback(url) || (url.startsWith('blob:') && loopback(url.slice(5))))) cancelled = 'download URL must be loopback or a loopback Blob';
              }
              if (msg.method === 'Browser.downloadProgress' && msg.params.guid === guid) {
                if (msg.params.receivedBytes > 5 * 1024 * 1024) cancelled = 'download exceeds 5 MB';
                if (msg.params.state === 'canceled') cancelled = 'browser canceled download';
                if (msg.params.state === 'completed') complete = true;
              }
            };
            cdp.listeners.push(listener);
            try {
              await click(q, s);
              const until = Math.min(deadline, Date.now() + Math.min(30_000, s.timeoutMs ?? 20_000));
              while (!complete && !cancelled && Date.now() < until) await sleep(100);
              if (cancelled) fail('DOWNLOAD_FAILED', cancelled);
              if (!complete || !guid) fail('DOWNLOAD_TIMEOUT', 'download did not complete; verify selector and page state');
              const bytes = readFileSync(join(downloadDir, guid));
              if (bytes.length > 5 * 1024 * 1024) fail('DOWNLOAD_TOO_LARGE', 'download exceeds 5 MB');
              mkdirSync(dirname(s.path), { recursive: true });
              writeFileSync(s.path, bytes);
              downloads.push(saved(s.path, 'download'));
            } finally {
              cdp.listeners = cdp.listeners.filter(l => l !== listener);
              if (guid && !complete) await cdp.send('Browser.cancelDownload', { guid }).catch(() => null);
            }
            break;
          }
          default:
            fail('INVALID_ARGUMENT', `unknown action ${s.action} at step ${i + 1}`);
        }
        if (!['assertText', 'login', 'drag', 'screenshot'].includes(s.action)) log.push({ step: i + 1, action: s.action });
      }
    } catch (error) {
      // Kèm trạng thái trang vào lỗi (callTool trả nó trong error.details).
      if (error instanceof HelperError && at >= 0) {
        const step = steps[at];
        const state = await evaluate(PAGE_STATE, { selector: step.selector ?? null, text: step.text ?? null }).catch(() => null);
        const hint = failureHint(step, state, error.code);
        const preGateFailed = provenance ? preGateNotice(provenance.teamWork, provenance.key) : null;
        error.details = { failedStep: at + 1, action: step.action, ...(state ?? {}), ...(hint ? { hint } : {}), stepsDone: log,
          consoleErrors: consoleErrors.slice(0, 5), ...(preGateFailed ? { preGateFailed } : {}) };
      }
      throw error;
    }
    const finalUrl = await evaluate('location.href').catch(() => null);
    const title = await evaluate('document.title').catch(() => null);
    const text = await evaluate('(document.body && document.body.innerText || "").slice(0, 600)').catch(() => '');
    const preGateFailed = provenance ? preGateNotice(provenance.teamWork, provenance.key) : null;
    return { screenshots: shots, downloads, finalUrl, title, visibleText: text, consoleErrors: consoleErrors.slice(0, 10), steps: log,
      ...(preGateFailed ? { preGateFailed } : {}),
      ...(rules.size ? { routed: routed.slice(0, 30),
        note: 'Responses in `routed` were simulated by the browser, not produced by the server: say so in the scenario note and engineeringRecord.' } : {}) };
  } finally {
    // Đóng êm để trình duyệt ghi cookie ra profile: kill ngay thì browserProfile mất đăng nhập ở lần gọi sau
    // (Practice #5: fixer goto /accounting bị đẩy về /login, tưởng tab Invoices không tồn tại).
    if (cdp) await closeGracefully(cdp, child);
    try { ws?.close(); } catch { /* bỏ qua */ }
    kill(child);
    if (!browserProfile) await removeLater(profileDir);
    if (existsSync(downloadDir)) await removeLater(downloadDir);
  }
}

const basenamePath = path => path.split(/[\\/]/).pop();

async function closeGracefully(cdp, child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(ok => child.once('exit', ok));
  await Promise.race([cdp.send('Browser.close').catch(() => null), sleep(2000)]);
  await Promise.race([exited, sleep(3000)]);
}

// Tiến trình con của Edge còn giữ file vài trăm ms sau khi bị kill: dọn best-effort, không làm hỏng kết quả.
async function removeLater(dir) {
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(300); }
  }
}
