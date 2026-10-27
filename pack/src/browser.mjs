// capture_evidence: điều khiển Edge/Chrome headless đã cài sẵn qua Chrome DevTools Protocol (CDP),
// không cần Playwright hay dependency nào. Chỉ mở URL loopback (app do đội tự chạy); ảnh chỉ lưu vào
// answers/<ID>/evidence/ trong thư mục trận. Click/gõ phím dùng sự kiện input thật nên React nhận.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail, HelperError, sleep } from './util.mjs';

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
export function evidencePath(teamWorkspace, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('INVALID_ARGUMENT', 'screenshot path must be absolute');
  const abs = resolve(path);
  const rel = relative(join(teamWorkspace, 'matches'), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', 'screenshot must be inside TeamWorkspace/matches');
  const parts = rel.split(sep);
  const i = parts.lastIndexOf('evidence');
  if (i < 2 || parts[i - 2] !== 'answers' || i !== parts.length - 2 || !/\.png$/i.test(abs)) {
    fail('PATH_NOT_ALLOWED', 'screenshot must be answers/<ID>/evidence/<name>.png');
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
      this.pending.set(id, { resolve: ok, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function launch(browser, userDataDir, viewport) {
  mkdirSync(userDataDir, { recursive: true });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--disable-sync',
    '--disable-features=msEdgeSidebarV2,EdgeCollections', `--window-size=${viewport.width},${viewport.height}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (port && path) return { child, endpoint: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
    }
    await sleep(100);
  }
  kill(child);
  fail('BROWSER_START_FAILED', 'browser did not open a DevTools port');
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

// Khi một bước lỗi: trang đang ở đâu và có gì bấm được, để lần gọi sau sửa bước mà không phải đoán.
const PAGE_STATE = `() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll('button,a[href],[role=tab],[role=button],[role=option],[role=menuitem],[role=combobox],input,select,textarea')].filter(visible);
  const candidates = els.slice(0, 50).map(el => {
    const role = el.getAttribute('role'); const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name');
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (role ? '[role=' + role + ']' : '') +
      (name ? '[' + (el.getAttribute('aria-label') ? 'aria-label' : el.getAttribute('placeholder') ? 'placeholder' : 'name') + '="' + name.slice(0, 40) + '"]' : '') +
      (text ? ' "' + text + '"' : '');
  });
  return { url: location.href, title: document.title, visibleText: (document.body && document.body.innerText || '').slice(0, 800), candidates };
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
  timeoutMs = 45_000 }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 60) fail('INVALID_ARGUMENT', 'steps must be 1-60 actions');
  const browser = findBrowser();
  if (!browser) fail('BROWSER_NOT_FOUND', 'no Edge or Chrome installation found');
  const vp = { width: Math.min(3840, Math.max(320, viewport.width | 0 || 1366)), height: Math.min(4000, Math.max(240, viewport.height | 0 || 900)) };
  // Kiểm toàn bộ bước trước khi mở trình duyệt.
  const rules = new Map();
  for (const [i, s] of steps.entries()) {
    if (s.action === 'goto' && !loopback(s.url)) fail('URL_NOT_ALLOWED', 'goto only accepts http(s)://localhost or 127.0.0.1');
    if (s.action === 'screenshot') s.path = evidencePath(teamWorkspace, s.path);
    if (s.action === 'route') rules.set(i, routeRule(s, i));
    checkSelector(s, i);
  }
  const profileDir = browserProfile && /^[A-Za-z0-9_-]{1,40}$/.test(browserProfile)
    ? join(teamWorkspace, 'team-sdlc-pack', 'local', 'browser', browserProfile)
    : join(tmpdir(), `mtm-browser-${process.pid}-${Date.now()}`);
  const deadline = Date.now() + Math.min(MAX_TOTAL_MS, timeoutMs);
  const { child, endpoint } = await launch(browser, profileDir, vp);
  const log = [];
  const consoleErrors = [];
  const shots = [];
  let ws;
  let cdp;
  try {
    ws = new WebSocket(endpoint);
    await new Promise((ok, reject) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true }); });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => cdp.send(m, p, sessionId);
    cdp.listeners.push(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      }
      if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 300));
    });
    await send('Page.enable');
    await send('Runtime.enable');
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
            const r = await click(q, { timeoutMs: s.timeoutMs, force: s.force });
            if (r.obscured) log.push({ step: i + 1, action: 'fill', obscuredBy: r.by, forced: true });
            await evaluate(`(q) => { const el = (${FIND})(q); el.focus(); if (el.select) el.select(); }`, q);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await send('Input.insertText', { text: String(s.value ?? '') });
            break;
          }
          case 'press': {
            const key = String(s.key ?? 'Enter');
            const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
            for (const type of ['keyDown', 'keyUp']) {
              await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
            }
            break;
          }
          case 'select':
            await locate(q, s.timeoutMs);
            await evaluate(`(q) => { const el = (${FIND})(q); el.value = q.value; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }`, { ...q, value: s.value });
            break;
          case 'waitFor':
            if (s.selector) { await locate(q, s.timeoutMs ?? 10_000); break; }
            {
              const until = Math.min(deadline, Date.now() + (s.timeoutMs ?? 10_000));
              const want = String(s.text ?? '').toLowerCase();
              while (!(await evaluate(`(t) => !!document.body && document.body.innerText.toLowerCase().includes(t)`, want).catch(() => false))) {
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
            const found = await evaluate(`(t) => document.body && document.body.innerText.includes(t)`, String(s.text));
            log.push({ step: i + 1, action: 'assertText', text: s.text, found });
            if (!found && s.required !== false) fail('ASSERT_FAILED', `text not on page: ${s.text}`);
            break;
          }
          case 'screenshot': {
            await sleep(Math.min(3000, s.settleMs ?? 400));
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
            shots.push({ path: s.path, bytes });
            break;
          }
          default:
            fail('INVALID_ARGUMENT', `unknown action ${s.action} at step ${i + 1}`);
        }
        if (s.action !== 'assertText') log.push({ step: i + 1, action: s.action });
      }
    } catch (error) {
      // Kèm trạng thái trang vào lỗi (callTool trả nó trong error.details).
      if (error instanceof HelperError && at >= 0) {
        const state = await evaluate(`(${PAGE_STATE})()`).catch(() => null);
        error.details = { failedStep: at + 1, action: steps[at].action, ...(state ?? {}), stepsDone: log, consoleErrors: consoleErrors.slice(0, 5) };
      }
      throw error;
    }
    const finalUrl = await evaluate('location.href').catch(() => null);
    const title = await evaluate('document.title').catch(() => null);
    const text = await evaluate('(document.body && document.body.innerText || "").slice(0, 600)').catch(() => '');
    return { screenshots: shots, finalUrl, title, visibleText: text, consoleErrors: consoleErrors.slice(0, 10), steps: log,
      ...(rules.size ? { routed: routed.slice(0, 30),
        note: 'Responses in `routed` were simulated by the browser, not produced by the server: say so in the scenario note and engineeringRecord.' } : {}) };
  } finally {
    // Đóng êm để trình duyệt ghi cookie ra profile: kill ngay thì browserProfile mất đăng nhập ở lần gọi sau
    // (Practice #5: fixer goto /accounting bị đẩy về /login, tưởng tab Invoices không tồn tại).
    if (cdp) await closeGracefully(cdp, child);
    try { ws?.close(); } catch { /* bỏ qua */ }
    kill(child);
    if (!browserProfile) await removeLater(profileDir);
  }
}

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
