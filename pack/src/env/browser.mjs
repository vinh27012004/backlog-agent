// capture_evidence: điều khiển Edge/Chrome headless đã cài sẵn qua Playwright (playwright-core, không tải trình duyệt
// riêng; installer cài vào team-sdlc-pack/playwright/, phiên bản ở config/playwright.json). Chỉ mở URL loopback (app do
// đội tự chạy); ảnh chỉ lưu vào answers/<ID>/evidence/ trong thư mục trận. Click/gõ phím là sự kiện input thật nên React nhận.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locate as locateMatchRoot } from './app.mjs';
import { seededAccount } from './applogin.mjs';
import { fail, HelperError, sleep } from '../core/util.mjs';
import { digest, sourceSnapshot } from '../core/candidates.mjs';
import { revParse, treeChanges } from '../core/git.mjs';
import { detectProfile } from './environment.mjs';
import { recordEvidence } from './evidence.mjs';

const MAX_TOTAL_MS = 50_000;
const SCRIPT_MS = 40_000;
const SETTLE_MS = 12_000;
// pack/ trong repo, team-sdlc-pack/runtime/ khi đã cài: playwright/ nằm cạnh nó (repo/playwright, team-sdlc-pack/playwright).
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// playwright-core đúng phiên bản của config/playwright.json: cạnh runtime/ (bản cài), hoặc MTM_PLAYWRIGHT_DIR (test).
let loaded = null;
export async function loadPlaywright() {
  if (loaded) return loaded;
  const cfg = JSON.parse(readFileSync(join(PACK_ROOT, 'config', 'playwright.json'), 'utf8'));
  let found = null;
  for (const dir of [join(PACK_ROOT, '..', 'playwright'), process.env.MTM_PLAYWRIGHT_DIR].filter(Boolean)) {
    const pkgDir = join(dir, 'node_modules', ...cfg.package.split('/'));
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    found = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
    if (found !== cfg.version) continue;
    loaded = await import(pathToFileURL(join(pkgDir, 'index.mjs')).href);
    return loaded;
  }
  fail('PLAYWRIGHT_NOT_INSTALLED', `${cfg.package}@${cfg.version} ${found ? `not found (installed ${found})` : 'not installed'}; rerun pack/install.ps1`);
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

// Selector là CSS hoặc cú pháp Playwright (text=, :has-text(), role=, >>, nth=): Playwright phân tích. Sai cú pháp thì
// báo ngay, không chờ hết giờ.
const BAD_SELECTOR = /while parsing|is not a valid selector|Unknown engine|Unexpected token|Unsupported token|Malformed/i;

const TARGETED = new Set(['click', 'fill', 'select', 'drag', 'download', 'waitFor']);

function checkSelector(s, i) {
  if (s.selector === undefined) {
    if (TARGETED.has(s.action) && (s.text === undefined || s.text === null || String(s.text).trim() === '')) {
      fail('INVALID_ARGUMENT', `step ${i + 1} (${s.action}) needs a selector or a text`);
    }
    return;
  }
  if (typeof s.selector !== 'string' || !s.selector.trim()) fail('INVALID_SELECTOR', `step ${i + 1}: selector must be a non-empty string`);
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
  try { if (q && q.selector) same = new Set(document.querySelectorAll(q.selector)); } catch (e) { /* selector Playwright, không phải CSS */ }
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

// Mỗi lần gọi mở một trang trắng: bước thao tác trước goto/login chắc chắn hỏng sau khi chờ hết giờ (NBDB5U0O BUG-02:
// click "New invoice" trên about:blank). Báo ngay, không mở trình duyệt.
const PAGE_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'drag', 'waitFor', 'assertText', 'screenshot', 'download', 'runScript']);

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

// Dòng đầu của lỗi Playwright, bỏ mã màu và call log.
const firstLine = error => String(error?.message ?? error).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300);
// Lý do Playwright còn chờ: dòng "element is ..." cuối của call log, vd "element is not enabled".
const waitingFor = error => String(error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  .map(l => l.replace(/^\s*(\d+ × )?-?\s*/, '').trim()).filter(l => /^element /.test(l)).pop()?.slice(0, 160) ?? 'not actionable';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cssString = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const describeQuery = q => q.selector ? `${q.selector}${q.text ? ` "${q.text}"` : ''}` : `text "${q.text}"`;

// Playwright 1.64 bỏ khoá falsy (0, '') của bản ghi out-of-line khi lưu IndexedDB, rồi khôi phục cả snapshot lỗi
// "key parameter was not provided" (OMZJW0S0 BUG-09: block 0 của SQLite budget local). Điền lại khoá từ getAllKeys của
// trang (cùng thứ tự khoá với bản ghi) cho origin trang đang mở; origin khác giữ nguyên.
export async function fillDroppedIdbKeys(state, page) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return state; }
  const entry = state.origins?.find(o => o.origin === origin);
  const stores = [];
  for (const db of entry?.indexedDB ?? []) for (const st of db.stores ?? []) {
    if (!st.keyPath && st.records?.some(r => !('key' in r) && !('keyEncoded' in r))) stores.push([db.name, st.name, st]);
  }
  if (!stores.length) return state;
  const keys = await page.evaluate(async list => Promise.all(list.map(([dbName, storeName]) => new Promise(done => {
    const req = indexedDB.open(dbName);
    req.onerror = () => done(null);
    req.onsuccess = () => {
      try {
        const all = req.result.transaction(storeName).objectStore(storeName).getAllKeys();
        all.onsuccess = () => { done(all.result.map(k => (typeof k === 'number' || typeof k === 'string' ? k : null))); req.result.close(); };
        all.onerror = () => done(null);
      } catch { done(null); }
    };
  }))), stores.map(([d, s]) => [d, s])).catch(() => null);
  stores.forEach(([, , st], i) => {
    const k = keys?.[i];
    if (!k || k.length !== st.records.length) return;
    st.records.forEach((r, j) => { if (!('key' in r) && !('keyEncoded' in r) && k[j] !== null) r.key = k[j]; });
  });
  return state;
}

// Bước runScript: chạy một script BTC phát trong trang của app. QDO8W480 CR-05: `challenge/CR-05-seed.js` ("Evaluate
// this function in the app's page with the fixture's data as its argument, for example with Playwright:
// page.evaluate(seed, data)") nạp dữ liệu chính thức vào budget đang mở; capture_evidence không có bước nào chạy được
// nó, thợ tự viết script Playwright, mất 5 phút rồi hết giờ: TC-02, TC-03, TC-04 NOT_RUN, mất 17/45 điểm (CR-08 cùng
// kiểu). Chỉ nhận file BTC phát cho item đó (.team-work/items/<ID>/files/ hoặc challenge/ trong matchRoot), không nhận
// script do thợ viết. Tham số: `arg` (JSON) hoặc `argFile` (file JSON của item hay trong matchRoot; file kết quả
// Company Tools được mở lớp content[0].text) và `argPath` ("data", "data.rows.0").
const inside = (root, file) => { const rel = relative(root, file); return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel); };
export function scriptStep(teamWorkspace, s, i, { base, key }) {
  const bad = msg => fail('INVALID_ARGUMENT', `runScript at step ${i + 1}: ${msg}`);
  if (!base || !key) bad('needs context {backlogItemKey, matchRoot}');
  const itemDir = join(dirname(locateMatchRoot(teamWorkspace, base).logDir), 'items', key);
  const pick = (value, roots, what) => {
    if (typeof value !== 'string' || !value) bad(`${what} must be a path`);
    const found = (isAbsolute(value) ? [resolve(value)] : roots.map(r => resolve(r, value))).find(f => existsSync(f) && statSync(f).isFile());
    if (!found) bad(`${what} ${value} not found (looked in ${roots.join(', ')})`);
    const real = realpathSync(found);
    if (!roots.some(r => existsSync(r) && inside(realpathSync(r), real))) fail('PATH_NOT_ALLOWED', `runScript at step ${i + 1}: ${what} must be one of the files issued for ${key} (${roots.join(' or ')})`);
    if (statSync(real).size > 512 * 1024) bad(`${what} is larger than 512 KB`);
    return real;
  };
  const file = pick(s.file, [join(itemDir, 'files'), join(base, 'challenge')], 'file');
  const source = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/[;\s]+$/, '');
  if (!source.trim()) bad('file is empty');
  let arg = s.arg;
  if (s.argFile !== undefined) {
    if (arg !== undefined) bad('give arg or argFile, not both');
    const argFile = pick(s.argFile, [itemDir, base], 'argFile');
    try { arg = JSON.parse(readFileSync(argFile, 'utf8')); } catch { bad(`argFile ${s.argFile} is not JSON`); }
    const text = arg?.content?.[0]?.text;
    if (typeof text === 'string' && arg?.tool) { try { arg = JSON.parse(text); } catch { /* giữ nguyên */ } }
  }
  if (s.argPath !== undefined) {
    for (const part of String(s.argPath).split('.').filter(Boolean)) {
      if (arg === null || typeof arg !== 'object' || !(part in arg)) bad(`argPath ${s.argPath}: no ${part}`);
      arg = arg[part];
    }
  }
  return { file, source, arg };
}

export async function captureEvidence({ teamWorkspace, steps, viewport = { width: 1366, height: 900 }, browserProfile = null,
  timeoutMs = 45_000, context = null }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 60) fail('INVALID_ARGUMENT', 'steps must be 1-60 actions');
  const browser = findBrowser();
  if (!browser) fail('BROWSER_NOT_FOUND', 'no Edge or Chrome installation found');
  const vp = { width: Math.min(3840, Math.max(320, viewport.width | 0 || 1366)), height: Math.min(4000, Math.max(240, viewport.height | 0 || 900)) };
  // Kiểm toàn bộ bước trước khi mở trình duyệt.
  const rules = new Map();
  const scripts = new Map();
  const accounts = new Map();
  const output = { base: context?.matchRoot ? locateMatchRoot(teamWorkspace, context.matchRoot).matchRoot : null, key: context?.backlogItemKey ?? null };
  let opened = false;
  for (const [i, s] of steps.entries()) {
    if (['goto', 'login'].includes(s.action) && !loopback(s.url)) fail('URL_NOT_ALLOWED', `${s.action} only accepts http(s)://localhost or 127.0.0.1`);
    if (s.action === 'login') accounts.set(i, seededAccount(locateMatchRoot(teamWorkspace, s.matchRoot).matchRoot));
    if (s.action === 'screenshot') s.path = evidencePath(teamWorkspace, s.path, output);
    if (s.action === 'download') s.path = evidencePath(teamWorkspace, s.path, { ...output, pngOnly: false });
    if (s.action === 'route') rules.set(i, routeRule(s, i));
    if (s.action === 'runScript') scripts.set(i, scriptStep(teamWorkspace, s, i, output));
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
      // App chạy bằng lệnh riêng (custom, README của project) không có mode dev/production: nhận appMode nào worker khai
      // (RATH0OHJ L99, LXRMBRA2 BUG-09: capture bị từ chối, worker hỏi root rồi mới chụp được, giữ khoá app_data 15 phút).
      if (resolve(running.matchRoot) !== resolve(where.matchRoot) || (running.mode !== 'custom' && running.mode !== context.appMode)) fail('EVIDENCE_APP_MISMATCH', 'running app worktree/mode differs from evidence context');
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
  // browserProfile giữ cookie, localStorage và IndexedDB giữa các lần gọi trong một file storageState (không dùng thư mục profile của
  // Edge: hai lần gọi song song cùng profile không khoá nhau, và đóng trình duyệt không phải chờ ghi profile).
  const stateFile = browserProfile && /^[A-Za-z0-9_-]{1,40}$/.test(browserProfile)
    ? join(teamWorkspace, 'team-sdlc-pack', 'local', 'browser', `${browserProfile}.json`) : null;
  const deadline = Date.now() + Math.min(MAX_TOTAL_MS, timeoutMs);
  const left = (cap = Infinity) => Math.max(100, Math.min(cap, deadline - Date.now()));
  const { chromium } = await loadPlaywright();
  // launchServer + kill thay cho launch + close: Edge đóng êm mất ~2 s mỗi lần gọi, kill ~0,4 s. Cookie đã nằm trong
  // storageState nên không cần Edge ghi profile.
  let server;
  let instance;
  try {
    server = await chromium.launchServer({ executablePath: browser, headless: true, timeout: 15_000 });
    instance = await chromium.connect(server.wsEndpoint(), { timeout: 15_000 });
  } catch (error) {
    await server?.kill().catch(() => null);
    fail('BROWSER_START_FAILED', `${firstLine(error)}; retry once`);
  }
  const log = [];
  const consoleErrors = [];
  const shots = [];
  const downloads = [];
  let ctx;
  let page;
  try {
    const options = { viewport: vp, deviceScaleFactor: 1, acceptDownloads: true };
    // IndexedDB khôi phục lỗi (Playwright không giữ được giá trị nhị phân, hay bản ghi out-of-line thiếu value: budget
    // local của OMZJW0S0 BUG-09) thì vẫn khôi phục cookie/localStorage, không mở phiên trắng làm mất đăng nhập.
    const withoutIdb = () => {
      try {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'));
        return { cookies: s.cookies ?? [], origins: (s.origins ?? []).map(({ indexedDB, ...o }) => o) };
      } catch { return null; }
    };
    if (stateFile && existsSync(stateFile)) {
      ctx = await instance.newContext({ ...options, storageState: stateFile }).catch(() => null);
      if (!ctx) {
        const partial = withoutIdb();
        ctx = partial ? await instance.newContext({ ...options, storageState: partial }).catch(() => null) : null;
        if (ctx) log.push({ step: 0, action: 'browserProfile', note: 'saved IndexedDB could not be restored (binary or keyless records); cookies and localStorage were restored: rebuild browser-local data in this call' });
      }
    }
    ctx ??= await instance.newContext(options);
    page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(15_000);
    const saved = (path, kind) => {
      const bytes = readFileSync(path), sha256 = digest(bytes);
      const record = { path, bytes: bytes.length, sha256 };
      if (provenance) {
        const { teamWork, key, ...origin } = provenance;
        recordEvidence(teamWork, key, { ...origin, ...record, name: basenamePath(path), kind, capturedAt: new Date().toISOString() });
      }
      return record;
    };
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
    page.on('pageerror', error => consoleErrors.push(String(error?.message ?? error).slice(0, 300)));
    // Request đang bay, để screenshot chờ dữ liệu về (WebSocket/EventSource sống mãi nên không tính; ảnh, font, media và
    // favicon không đổi nội dung chụp: J56ZZWSS TASK-02 chụp lại 2 lần chỉ vì favicon.svg còn treo).
    const inflight = new Map();
    page.on('request', r => {
      if (!['eventsource', 'websocket', 'image', 'font', 'media'].includes(r.resourceType()) && !/\/favicon[^/]*$/i.test(r.url().split('?')[0])) inflight.set(r, { url: r.url(), at: Date.now() });
    });
    page.on('requestfinished', r => inflight.delete(r));
    page.on('requestfailed', r => inflight.delete(r));

    // route: luật bật từ bước của nó trở đi, luật mới nhất thắng; unroute bỏ hết. Request không khớp đi tiếp như thường.
    const active = [];
    const routed = [];
    if (rules.size) {
      await ctx.route('**/*', async route => {
        const request = route.request();
        const rule = active.find(r => r.left > 0 && r.matches(request.url(), request.method()));
        try {
          if (!rule) return await route.fallback();
          rule.left--;
          routed.push({ step: rule.step, method: request.method(), url: request.url().slice(0, 200),
            ...(rule.status ? { status: rule.status } : {}), ...(rule.abort ? { abort: rule.abort } : {}), ...(rule.delayMs ? { delayMs: rule.delayMs } : {}) });
          if (rule.delayMs) await sleep(rule.delayMs);
          if (rule.abort) return await route.abort(rule.abort.toLowerCase());
          if (!rule.status) return await route.fallback();
          return await route.fulfill({ status: rule.status, contentType: rule.contentType, body: rule.body });
        } catch { /* request đã huỷ (trang chuyển đi) */ }
      });
    }

    const evaluate = (expression, arg) => page.evaluate(arg === undefined ? expression : `(${expression})(${JSON.stringify(arg)})`);
    // goto: lỗi kết nối (app chưa chạy, sai cổng) báo ngay; trang tải chậm quá 15 s thì vẫn đi tiếp như trước.
    const navigate = async url => {
      try { await page.goto(url, { waitUntil: 'load', timeout: left(15_000) }); }
      catch (error) {
        if (/net::ERR_(CONNECTION|NAME|ADDRESS|EMPTY_RESPONSE|UNSAFE_PORT)/.test(error.message)) fail('NAVIGATION_FAILED', firstLine(error));
        if (error.name !== 'TimeoutError' && !/net::ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error;
      }
    };
    const waitReady = () => page.waitForLoadState('load', { timeout: left(15_000) }).catch(() => null);
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

    // Tìm phần tử đang hiện theo selector, theo chữ hiển thị (hoặc aria-label), hoặc cả hai: chữ khớp đúng trước, chứa
    // chữ sau; `index` chọn phần tử thứ n.
    const candidatesFor = q => {
      const t = String(q.text ?? '').trim();
      const exact = new RegExp(`^\\s*${esc(t)}\\s*$`, 'i');
      const aria = page.locator(`[aria-label="${cssString(t)}" i]`);
      if (q.selector) {
        const base = page.locator(q.selector);
        return t ? [base.filter({ hasText: exact }), base.and(aria), base.filter({ hasText: t })] : [base];
      }
      return [page.getByText(exact), aria, page.getByText(t)];
    };
    const findNow = async q => {
      for (const c of candidatesFor(q)) {
        const visible = c.filter({ visible: true });
        let n = 0;
        try { n = await visible.count(); } catch (error) {
          if (BAD_SELECTOR.test(error.message)) fail('INVALID_SELECTOR', `${q.selector} is not a valid selector: ${firstLine(error)}`);
        }
        if (n > (q.index | 0)) return visible.nth(q.index | 0);
      }
      return null;
    };
    const find = async (q, waitMs = 5000) => {
      const until = Math.min(deadline, Date.now() + waitMs);
      for (;;) {
        const loc = await findNow(q);
        if (loc) return loc;
        if (Date.now() >= until) fail('ELEMENT_NOT_FOUND', q.selector ?? `text "${q.text}"`);
        await sleep(150);
      }
    };
    // Bị che (vd sidebar của BUG-01 đè tab Invoices ở mọi item khác): cho lớp che tạm pointer-events:none rồi bấm bằng
    // chuột thật như thường (Radix Tabs/Select nhận đúng chuỗi pointer), trả lại style sau cú bấm. Bước ghi obscuredBy.
    const clickThrough = async loc => {
      const peel = await loc.evaluate(el => {
        const label = n => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ' "' + (n.innerText || n.getAttribute('aria-label') || '').trim().slice(0, 40) + '"' : 'nothing';
        el.scrollIntoView({ block: 'center', inline: 'center' });
        let by = null;
        for (let n = 0; n < 6; n++) {
          const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (hit && (el === hit || el.contains(hit))) return { ok: true, by };
          by ??= label(hit);
          if (!hit || hit.contains(el)) return { ok: false, by };
          let cover = hit; while (cover.parentElement && !cover.parentElement.contains(el)) cover = cover.parentElement;
          cover.setAttribute('data-mtm-pe', cover.style.pointerEvents || ''); cover.style.pointerEvents = 'none';
        }
        return { ok: false, by };
      }).catch(() => ({ ok: false, by: null }));
      try {
        if (peel.ok) await loc.click({ force: true, timeout: left(2000) });
        // Không gỡ được lớp che: đủ chuỗi sự kiện con trỏ bằng JS (Radix kích hoạt ở pointerdown/mousedown).
        else await loc.evaluate(el => { const r = el.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerType: 'mouse', isPrimary: true };
          el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o)); el.focus?.();
          el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); });
      } finally {
        await evaluate(`() => { for (const el of document.querySelectorAll('[data-mtm-pe]')) {
          el.style.pointerEvents = el.getAttribute('data-mtm-pe'); el.removeAttribute('data-mtm-pe'); } }`).catch(() => null);
      }
      return { obscured: true, by: peel.by ?? 'another element', forced: true };
    };
    // Click như người dùng: Playwright chờ phần tử hiện, ổn định, bật và nhận được sự kiện. Lần đầu chờ tối đa 1,5 s;
    // bị che thì bấm xuyên lớp che ngay, lý do khác (đang tắt, đang chạy animation) thì chờ hết timeoutMs.
    const click = async (q, { timeoutMs = 5000 } = {}) => {
      const until = Math.min(deadline, Date.now() + timeoutMs);
      const rest = () => Math.max(200, until - Date.now());
      if (q.selector && /role=["']?option/i.test(q.selector)) {
        const optCount = await evaluate(`() => document.querySelectorAll('[role=option]').length`).catch(() => 0);
        if (optCount === 0) {
          await evaluate(`() => {
            const trigger = document.querySelector('[role=combobox],[data-radix-collection-item],button[aria-haspopup="listbox"],button[aria-haspopup="dialog"]');
            if (trigger) trigger.click();
          }`).catch(() => null);
          await sleep(250);
        }
      }
      const loc = await find(q, rest());
      const covered = error => /intercepts pointer events/.test(error.message);
      let error;
      try { await loc.click({ timeout: Math.min(rest(), 1500) }); return { obscured: false }; } catch (e) { error = e; }
      if (!covered(error)) {
        try { await loc.click({ timeout: rest() }); return { obscured: false }; } catch (e) { error = e; }
      }
      if (covered(error)) return clickThrough(loc);
      if (error.name === 'TimeoutError') fail('ELEMENT_NOT_ACTIONABLE', `${describeQuery(q)} is on the page but cannot be clicked: ${waitingFor(error)}`);
      throw error;
    };
    // Gõ như người dùng: Playwright xoá ô rồi nhập (input có kiểm soát của React nhận sự kiện input).
    const fill = async (q, value, { timeoutMs = 5000, force = false } = {}) => {
      const loc = await find(q, timeoutMs);
      try { await loc.fill(String(value ?? ''), { timeout: left(timeoutMs), force }); } catch (error) {
        if (error.name === 'TimeoutError') fail('ELEMENT_NOT_ACTIONABLE', `${describeQuery(q)} cannot be filled: ${waitingFor(error)}`);
        throw error;
      }
    };

    let at = -1;
    try {
      for (const [i, s] of steps.entries()) {
        at = i;
        if (Date.now() > deadline) fail('CAPTURE_TIMEOUT', `stopped before step ${i + 1}`);
        const q = { selector: s.selector, text: s.text, index: s.index };
        switch (s.action) {
          case 'goto':
            await navigate(s.url);
            break;
          case 'click': {
            const r = await click(q, { timeoutMs: s.timeoutMs });
            if (r.obscured) log.push({ step: i + 1, action: 'click', obscuredBy: r.by, forced: true });
            break;
          }
          case 'fill':
            await fill(q, s.value, { timeoutMs: s.timeoutMs, force: s.force });
            break;
          case 'login': {
            // Tài khoản seed do helper tìm (applogin.mjs); giá trị không vào log, kết quả hay error.details.
            const account = accounts.get(i);
            await navigate(s.url);
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
            if (form.submit) await click({ selector: '[data-mtm-login=submit]' });
            else await page.keyboard.press('Enter');
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
          case 'press':
            // Space + mũi tên: kéo-thả bằng bàn phím của @hello-pangea/dnd, dnd-kit (Space nhấc, mũi tên di, Space thả).
            await page.keyboard.press(s.key === ' ' || s.key === 'Space' ? 'Space' : String(s.key ?? 'Enter'));
            break;
          case 'drag': {
            // Kéo bằng chuột thật (FMC0ZXFC BUG-04: không có step kéo-thả, TC-02 NOT_RUN). Nhấn ở giữa nguồn, nhích quá
            // ngưỡng bắt đầu kéo (5 px của @hello-pangea/dnd), đi từng bước tới mép trên (before) / dưới (after) / giữa đích.
            const target = await find({ selector: s.to.selector, text: s.to.text, index: s.to.index }, s.timeoutMs);
            const source = await find(q, s.timeoutMs);
            await source.scrollIntoViewIfNeeded({ timeout: left(5000) });
            // @hello-pangea/dnd, react-beautiful-dnd: không nhấc khi chuột hay phím bắt đầu trong button/input nằm trong
            // handle (BTZNI69E BUG-04: cả card là <button>, kéo chuột chỉ mở card, TC-02 NOT_RUN mất 15 điểm). Nguồn và
            // đích cùng một Droppable thì focus chính handle, Space nhấc, mũi tên đúng số bước, Space thả.
            const plan = await source.evaluate((el, [to, position]) => {
              const near = (n, sel) => n.closest(sel) ?? n.querySelector(sel);
              const a = near(el, '[data-rfd-draggable-id]'), b = near(to, '[data-rfd-draggable-id]');
              const handle = near(el, '[data-rfd-drag-handle-draggable-id]');
              const drop = a?.closest('[data-rfd-droppable-id]');
              if (!a || !b || !handle || a === b || !drop || b.closest('[data-rfd-droppable-id]') !== drop) return null;
              const items = [...drop.querySelectorAll('[data-rfd-draggable-id]')].filter(n => n.closest('[data-rfd-droppable-id]') === drop);
              const from = items.indexOf(a), at = items.indexOf(b);
              const dest = position === 'after' ? (from > at ? at + 1 : at) : (from > at ? at : position === 'before' ? at - 1 : at);
              const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
              const vertical = Math.abs(rb.top - ra.top) >= Math.abs(rb.left - ra.left);
              handle.focus();
              return { steps: dest - from, vertical, focused: document.activeElement === handle };
            }, [await target.elementHandle(), s.position ?? 'center']);
            if (plan?.focused) {
              const key = plan.vertical ? (plan.steps < 0 ? 'ArrowUp' : 'ArrowDown') : (plan.steps < 0 ? 'ArrowLeft' : 'ArrowRight');
              if (plan.steps !== 0) {
                await page.keyboard.press('Space');
                await sleep(250);
                for (let n = 0; n < Math.abs(plan.steps); n++) { await page.keyboard.press(key); await sleep(200); }
                await sleep(250);
                await page.keyboard.press('Space');
                await sleep(Math.min(3000, s.settleMs ?? 500));
              }
              log.push({ step: i + 1, action: 'drag', mode: 'keyboard', moves: plan.steps });
              break;
            }
            const fb = await source.boundingBox(), tb = await target.boundingBox();
            if (!fb) fail('ELEMENT_NOT_FOUND', describeQuery(q));
            if (!tb) fail('ELEMENT_NOT_FOUND', describeQuery(s.to));
            const from = { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 };
            const dst = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
            const ty = s.position === 'before' ? tb.y + 4 : s.position === 'after' ? tb.y + tb.height - 4 : dst.y;
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await sleep(150);
            await page.mouse.move(from.x, from.y + (ty < from.y ? -10 : 10));
            await sleep(100);
            const moves = 20;
            for (let n = 1; n <= moves; n++) {
              await page.mouse.move(from.x + (dst.x - from.x) * n / moves, from.y + (ty - from.y) * n / moves);
              await sleep(25);
            }
            await sleep(250);
            await page.mouse.up();
            await sleep(Math.min(3000, s.settleMs ?? 500));
            log.push({ step: i + 1, action: 'drag', from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(dst.x), y: Math.round(ty) } });
            break;
          }
          case 'select': {
            const loc = await find(q, s.timeoutMs);
            if (await loc.evaluate(el => el.tagName === 'SELECT')) await loc.selectOption(String(s.value), { timeout: left(5000) });
            else await loc.evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true })); }, String(s.value));
            break;
          }
          case 'waitFor': {
            if (s.state && !['visible', 'hidden', 'enabled'].includes(s.state)) fail('INVALID_ARGUMENT', 'waitFor state is visible, hidden or enabled');
            const until = Math.min(deadline, Date.now() + (s.timeoutMs ?? 10_000));
            const want = String(s.text ?? '').toLowerCase();
            const ready = async () => {
              if (s.state === 'hidden') return !(await findNow(q));
              if (s.state === 'enabled') {
                const loc = await findNow(q);
                return !!loc && await loc.isEnabled().catch(() => false) && await loc.getAttribute('aria-disabled').catch(() => null) !== 'true';
              }
              if (q.selector || s.state === 'visible') return !!(await findNow(q));
              return evaluate(`(t) => !!document.body && document.body.innerText.toLowerCase().includes(t)`, want).catch(() => false);
            };
            while (!(await ready())) {
              if (Date.now() >= until) fail('ELEMENT_NOT_FOUND', s.selector ? describeQuery(q) : `text "${s.text}"`);
              await sleep(150);
            }
            break;
          }
          case 'wait':
            await sleep(Math.min(10_000, Math.max(0, s.ms | 0)));
            break;
          case 'route':
            active.unshift(rules.get(i));
            break;
          case 'runScript': {
            // File là một biểu thức: hàm thì gọi với arg, giá trị khác thì trả luôn. Chuỗi biểu thức đi qua CDP nên
            // không vướng CSP của trang.
            const { file, source, arg } = scripts.get(i);
            const run = page.evaluate(`(async () => { const v = (${source}
); return typeof v === 'function' ? v(${arg === undefined ? '' : JSON.stringify(arg)}) : v; })()`);
            let timer;
            const value = await Promise.race([run, new Promise((_, no) => { timer = setTimeout(() => no(new HelperError('SCRIPT_TIMEOUT', `the script did not finish in ${Math.round(left(SCRIPT_MS) / 1000)} s`)), left(SCRIPT_MS)); })])
              .catch(error => { if (error instanceof HelperError) throw error; fail('SCRIPT_FAILED', `${firstLine(error)}`.slice(0, 600)); })
              .finally(() => clearTimeout(timer));
            let result = null;
            try { result = value === undefined ? null : JSON.stringify(value); } catch { result = String(value); }
            log.push({ step: i + 1, action: 'runScript', file, ...(result === null ? {} : { result: result.length > 2000 ? `${result.slice(0, 2000)}…` : JSON.parse(result) }) });
            break;
          }
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
            // idle:false chụp ngay (bằng chứng trạng thái đang tải, vd sau route delayMs). Chờ tối đa 12 s: app dev biên dịch
            // route ở lần mở đầu, dashboard J56ZZWSS còn đợi tRPC sau 6 s ở 9/27 lần chụp, mỗi lần worker phải chụp lại.
            const unsettled = s.idle === false ? null : await settle(SETTLE_MS);
            const png = await page.screenshot({ fullPage: !!s.fullPage, timeout: left(15_000) });
            mkdirSync(dirname(s.path), { recursive: true });
            writeFileSync(s.path, png);
            const bytes = statSync(s.path).size;
            if (bytes > 5 * 1024 * 1024) fail('SCREENSHOT_TOO_LARGE', `${s.path} is ${bytes} bytes`);
            shots.push(saved(s.path, 'screenshot'));
            log.push({ step: i + 1, action: 'screenshot', ...(unsettled ? { unsettled,
              hint: `still loading after ${SETTLE_MS / 1000} s: if the screenshot shows the loaded content it is valid; otherwise waitFor that content and capture again (idle:false only for loading-state evidence)` } : {}) });
            break;
          }
          case 'download': {
            // Chờ download đăng ký trước click: cả URL download và Blob dùng cùng cookie của trang.
            const started = page.waitForEvent('download', { timeout: left() }).then(d => ({ d }), e => ({ e }));
            await click(q, { timeoutMs: s.timeoutMs });
            const got = await Promise.race([started, sleep(Math.min(30_000, s.timeoutMs ?? 20_000)).then(() => null)]);
            if (!got?.d) fail('DOWNLOAD_TIMEOUT', 'download did not complete; verify selector and page state');
            const url = got.d.url();
            if (!(loopback(url) || (url.startsWith('blob:') && loopback(url.slice(5))))) {
              await got.d.cancel().catch(() => null);
              fail('DOWNLOAD_FAILED', 'download URL must be loopback or a loopback Blob');
            }
            const failure = await got.d.failure();
            if (failure) fail('DOWNLOAD_FAILED', failure);
            // Trình duyệt nối qua connect(): Playwright chỉ chuyển file bằng saveAs, không có path().
            const tmp = join(teamWorkspace, 'team-sdlc-pack', 'local', 'downloads', randomUUID());
            let bytes;
            try {
              await got.d.saveAs(tmp);
              bytes = readFileSync(tmp);
            } finally { rmSync(tmp, { force: true }); }
            if (bytes.length > 5 * 1024 * 1024) fail('DOWNLOAD_TOO_LARGE', 'download exceeds 5 MB');
            mkdirSync(dirname(s.path), { recursive: true });
            writeFileSync(s.path, bytes);
            downloads.push(saved(s.path, 'download'));
            break;
          }
          default:
            fail('INVALID_ARGUMENT', `unknown action ${s.action} at step ${i + 1}`);
        }
        if (!['assertText', 'login', 'drag', 'screenshot', 'runScript'].includes(s.action)) log.push({ step: i + 1, action: s.action });
      }
    } catch (caught) {
      // Lỗi của Playwright (trang đóng, phím không tồn tại...) cũng tới agent như lỗi của bước, kèm trạng thái trang.
      const error = caught instanceof HelperError ? caught
        : new HelperError(caught?.name === 'TimeoutError' ? 'STEP_TIMEOUT' : 'BROWSER_STEP_FAILED', firstLine(caught));
      // Ảnh chẩn đoán của màn hình lúc hỏng, tên riêng `<ảnh kịch bản>.FAILED-step<N>.png`: không bao giờ mang tên ảnh
      // kịch bản (OMZJW0S0/UOMNKT6Z: ảnh dự phòng mang đúng tên tc-02-*.png nên dễ bị nộp nhầm như evidence đạt), không ghi
      // đè ảnh kịch bản đã chụp được, không vào manifest evidence. Chỉ để fixer xem vì sao hỏng.
      let diagnostic = null;
      const pending = steps.slice(Math.max(0, at)).find(s => s?.action === 'screenshot' && s.path)
        ?? steps.find(s => s?.action === 'screenshot' && s.path);
      if (pending) {
        try {
          const png = await page.screenshot({ timeout: 5000 }).catch(() => null);
          if (png) {
            diagnostic = pending.path.replace(/\.png$/i, '') + `.FAILED-step${at + 1}.png`;
            mkdirSync(dirname(diagnostic), { recursive: true });
            writeFileSync(diagnostic, png);
          }
        } catch { diagnostic = null; }
      }
      if (at >= 0) {
        const step = steps[at];
        const state = await evaluate(PAGE_STATE, { selector: step.selector ?? null, text: step.text ?? null }).catch(() => null);
        const hint = failureHint(step, state, error.code);
        error.details = { failedStep: at + 1, action: step.action, ...(state ?? {}), ...(hint ? { hint } : {}), stepsDone: log,
          screenshotsDone: shots.map(x => x.path),
          ...(diagnostic ? { diagnostic, diagnosticNote: 'screen at the failed step for debugging only: never list it as scenario evidence or rename it' } : {}),
          consoleErrors: consoleErrors.slice(0, 5) };
      }
      throw error;
    }
    const finalUrl = page.url();
    const title = await page.title().catch(() => null);
    const text = await evaluate('(document.body && document.body.innerText || "").slice(0, 600)').catch(() => '');
    return { screenshots: shots, downloads, finalUrl, title, visibleText: text, consoleErrors: consoleErrors.slice(0, 10), steps: log,
      ...(rules.size ? { routed: routed.slice(0, 30),
        note: 'Responses in `routed` were simulated by the browser, not produced by the server: say so in the scenario note and engineeringRecord.' } : {}) };
  } finally {
    // Lưu cookie cả khi bước lỗi (Practice #5: mất đăng nhập ở lần gọi sau thì fixer tưởng tab Invoices không tồn tại).
    // Ghi file tạm rồi đổi tên: lần gọi song song cùng profile không đọc phải file dở.
    if (stateFile && ctx) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
        // indexedDB: app lưu dữ liệu local trong IndexedDB (OMZJW0S0 BUG-09: budget "Don't use a server") mất ở lần gọi
        // sau nếu chỉ giữ cookie/localStorage; newContext({storageState}) khôi phục cả IndexedDB.
        writeFileSync(tmp, JSON.stringify(await fillDroppedIdbKeys(await ctx.storageState({ indexedDB: true }), page)));
        renameSync(tmp, stateFile);
      } catch { /* trình duyệt đã đóng */ }
    }
    await Promise.race([instance.close().catch(() => null), sleep(2000)]);
    await server.kill().catch(() => null);
  }
}

const basenamePath = path => path.split(/[\\/]/).pop();

// Dùng cho check-distribution: mở trình duyệt đã cài bằng playwright-core và đóng lại.
export async function browserSmoke() {
  const browser = findBrowser();
  if (!browser) fail('BROWSER_NOT_FOUND', 'no Edge or Chrome installation found');
  const { chromium } = await loadPlaywright();
  const instance = await chromium.launch({ executablePath: browser, headless: true, timeout: 15_000 });
  try {
    const page = await instance.newPage();
    await page.setContent('<p>ok</p>');
    return { browser, version: instance.version(), text: await page.textContent('p') };
  } finally { await instance.close().catch(() => null); }
}
