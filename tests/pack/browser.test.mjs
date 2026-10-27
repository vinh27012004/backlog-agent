// capture_evidence: Edge headless qua CDP trên một app giả ở localhost (đăng nhập → form → chụp).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureEvidence, findBrowser } from '../../pack/src/browser.mjs';
import { install, McpClient, tempDir } from './support.mjs';

const page = body => `<!doctype html><html><head><title>Solova test</title></head><body>${body}</body></html>`;

// State giữ trong JS và chỉ cập nhật qua sự kiện input, giống input có kiểm soát của React.
const LOGIN = page(`
<form id="f"><input name="username" id="u"><input type="password" name="password" id="p"><button type="submit">Sign in</button></form>
<script>
const s = {u:'', p:''};
u.addEventListener('input', e => s.u = e.target.value); p.addEventListener('input', e => s.p = e.target.value);
f.addEventListener('submit', async e => { e.preventDefault();
  const r = await fetch('/api/login', {method:'POST', body: JSON.stringify(s)});
  if (r.ok) location.href = '/dashboard'; else document.body.insertAdjacentHTML('beforeend', '<p>Invalid</p>'); });
</script>`);
const DASHBOARD = page('<h1>Dashboard</h1><a href="/invoices/new">New invoice</a>');
// Lớp phủ che nút (giống sidebar đè nội dung): click thường phải báo ELEMENT_OBSCURED.
const COVERED = page(`<button id="hidden" style="position:absolute;left:20px;top:20px">Save</button>
<nav style="position:fixed;left:0;top:0;width:300px;height:100%;background:#222;color:#fff">Sidebar</nav><div id="out"></div>
<script>hidden.addEventListener('mousedown', () => out.textContent = 'saved');</script>`);
const INVOICE = page(`
<label>Company <select id="c"><option value="USD">Acme (USD)</option><option value="VND">Saigon (VND)</option></select></label>
<input id="price" placeholder="Unit price"><button id="create">Create</button><div id="out"></div>
<script>
let price = '';
document.getElementById('price').addEventListener('input', e => price = e.target.value);
document.getElementById('create').addEventListener('click', () => {
  const cur = document.getElementById('c').value;
  const n = Number(price);
  document.getElementById('out').textContent = cur === 'VND' ? 'Total ₫' + n.toLocaleString('en-US') : 'Total $' + n.toFixed(2);
});
</script>`);

function app() {
  let loggedIn = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const html = h => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); };
    if (req.url === '/login') return html(LOGIN);
    if (req.url === '/covered') return html(COVERED);
    if (req.url === '/api/login') {
      const { u, p } = JSON.parse(body);
      loggedIn = u === 'admin' && p === 'secret';
      res.writeHead(loggedIn ? 200 : 401); return res.end();
    }
    if (!loggedIn) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (req.url === '/dashboard') return html(DASHBOARD);
    if (req.url === '/invoices/new') return html(INVOICE);
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const browser = findBrowser();

test('capture_evidence logs in, fills a form and saves a screenshot', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const { server, url } = await app();
  const shot = join(tw, 'matches', 'M1', 'M1', 'answers', 'BUG-02', 'evidence', 'tc-01-vnd-invoice.png');
  try {
    const result = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `${url}/login` },
      { action: 'fill', selector: '#u', value: 'admin' },
      { action: 'fill', selector: 'input[name=password]', value: 'secret' },
      { action: 'click', text: 'Sign in' },
      { action: 'waitFor', text: 'Dashboard' },
      { action: 'click', text: 'New invoice' },
      { action: 'select', selector: '#c', value: 'VND' },
      { action: 'fill', selector: '#price', value: '12345' },
      { action: 'click', selector: '#create' },
      { action: 'assertText', text: '₫12,345' },
      { action: 'screenshot', path: shot }
    ] });
    assert.equal(result.screenshots.length, 1);
    assert.ok(result.finalUrl.endsWith('/invoices/new'), result.finalUrl);
    const png = readFileSync(shot);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(png.length > 2000);
  } finally {
    server.close();
  }
});

test('capture_evidence reports covered elements and can force the click', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const { server, url } = await app();
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `${url}/covered` }, { action: 'click', text: 'Save', timeoutMs: 800 }] }), /ELEMENT_OBSCURED.*Sidebar/);
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `${url}/covered` }, { action: 'click', text: 'Save', timeoutMs: 800, force: true }, { action: 'assertText', text: 'saved' }] });
    assert.match(res.steps.find(s => s.forced).obscuredBy, /Sidebar/);
  } finally {
    server.close();
  }
});

// Practice #5 (BC3JL6ZC, BUG-02): sidebar của BUG-01 đè tab Invoices; tab của Radix chỉ nhận sự kiện con trỏ thật.
const TABS = page(`<nav style="position:fixed;z-index:10;left:0;top:0;width:300px;height:100%;background:#222"><a href="#">Contacts</a></nav>
<div role="tablist" style="position:absolute;left:40px;top:60px"><button role="tab" id="t-inv">Invoices</button><button role="tab">Payments</button></div>
<div id="panel" style="position:absolute;left:400px;top:120px"></div>
<script>document.getElementById('t-inv').addEventListener('pointerdown', e => { if (e.isTrusted) panel.innerHTML = '<button>New invoice</button>'; });</script>`);

test('capture_evidence force clicks through a cover with real input; selector and text combine', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TABS); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url },
      { action: 'click', selector: '[role=tab]', text: 'Invoices', timeoutMs: 800, force: true },
      { action: 'waitFor', selector: '#panel button', text: 'New invoice', timeoutMs: 2000 }] });
    assert.match(res.steps.find(s => s.forced).obscuredBy, /Contacts/);
    // Lớp che được trả lại pointer-events sau cú bấm.
    assert.match(res.visibleText, /New invoice/);
  } finally {
    server.close();
  }
});

test('capture_evidence rejects Playwright selectors and reports the page on a failed step', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'click', selector: "[role=tab]:has-text('Invoices')" }] }),
    e => e.code === 'INVALID_SELECTOR' && /selector, text/.test(e.message));
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'click', selector: "button >> nth=0" }] }), /INVALID_SELECTOR/);
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TABS); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const t0 = Date.now();
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url }, { action: 'click', selector: 'button[' }] }),
      e => e.code === 'INVALID_SELECTOR' && e.details.failedStep === 2);
    assert.ok(Date.now() - t0 < 4000, 'invalid CSS fails at once, not after the wait');
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url }, { action: 'click', text: 'Receipts', timeoutMs: 500 }] }), e => {
      assert.equal(e.code, 'ELEMENT_NOT_FOUND');
      assert.equal(e.details.failedStep, 2);
      assert.ok(e.details.url.startsWith(url));
      assert.ok(e.details.candidates.includes('button#t-inv[role=tab] "Invoices"'), e.details.candidates.join(' | '));
      assert.deepEqual(e.details.stepsDone, [{ step: 1, action: 'goto' }]);
      return true;
    });
  } finally {
    server.close();
  }
});

test('capture_evidence browserProfile keeps the login cookie across calls', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => {
    const cookie = req.url === '/login' ? { 'Set-Cookie': 'sid=ok; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' } : {};
    res.writeHead(200, { 'Content-Type': 'text/html', ...cookie });
    res.end(req.url === '/login' || /sid=ok/.test(req.headers.cookie ?? '') ? '<h1>Accounting</h1>' : '<h1>Please sign in</h1>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await captureEvidence({ teamWorkspace: tw, browserProfile: 'solova-admin', steps: [{ action: 'goto', url: `${url}/login` }] });
    const res = await captureEvidence({ teamWorkspace: tw, browserProfile: 'solova-admin', steps: [{ action: 'goto', url: `${url}/accounting` }] });
    assert.match(res.visibleText, /Accounting/);
  } finally {
    server.close();
  }
});

test('capture_evidence refuses non-loopback URLs and paths outside answers/<ID>/evidence', async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: 'https://example.com/' }] }), /URL_NOT_ALLOWED/);
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'screenshot', path: join(tw, 'matches', 'M1', 'M1', 'src', 'x.png') }] }), /PATH_NOT_ALLOWED/);
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'screenshot', path: join(tw, 'elsewhere', 'answers', 'A', 'evidence', 'x.png') }] }), /PATH_NOT_ALLOWED/);
});

test('capture_evidence is callable through MCP without configure_session', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  install(tw);
  const { server, url } = await app();
  const client = new McpClient(join(tw, 'team-sdlc-pack', 'runtime', 'bin', 'runtime-server.mjs'), process.env);
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const shot = join(tw, 'matches', 'M1', 'M1', 'answers', 'BUG-01', 'evidence', 'login.png');
    const res = await client.call('capture_evidence', { steps: [{ action: 'goto', url: `${url}/login` }, { action: 'screenshot', path: shot }] });
    assert.equal(res.screenshots[0].path, shot);
    // Lỗi một bước tới agent kèm trạng thái trang.
    await assert.rejects(client.call('capture_evidence', { steps: [{ action: 'goto', url: `${url}/login` }, { action: 'click', text: 'Invoices', timeoutMs: 300 }] }),
      e => e.code === 'ELEMENT_NOT_FOUND' && e.details.candidates.some(c => c.includes('Sign in')));
  } finally {
    client.close();
    server.close();
  }
});

// Mục 13: server luôn trả 200, nhưng MVS đòi ảnh màn hình khi API xuất lỗi / quá hạn. route để trình duyệt tự trả lời.
const EXPORT = page(`<button id="export">Export CSV</button><div id="out"></div>
<script>
document.getElementById('export').addEventListener('click', async () => {
  const out = document.getElementById('out');
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('/api/invoices/export', { method: 'POST', signal: ctrl.signal }); clearTimeout(t);
    out.textContent = r.ok ? 'Exported ' + (await r.text()) : 'Export failed (' + r.status + '), please retry';
  } catch (e) { out.textContent = 'Network problem, please retry'; }
});
</script>`);

test('capture_evidence route simulates a failing or slow server without touching it', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/export') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(EXPORT); }
    if (req.url === '/api/invoices/export') { hits++; res.writeHead(200); return res.end('3 rows'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const shot = join(tw, 'matches', 'M1', 'M1', 'answers', 'CR-01', 'evidence', 'tc-03-export-error.png');
  try {
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `${url}/export` },
      { action: 'route', url: '/api/invoices/export', method: 'POST', status: 500, body: { error: 'boom' }, times: 1 },
      { action: 'click', text: 'Export CSV' },
      { action: 'waitFor', text: 'Export failed (500)' },
      { action: 'screenshot', path: shot },
      // times: 1 đã dùng hết: lần bấm sau tới server thật.
      { action: 'click', text: 'Export CSV' },
      { action: 'waitFor', text: 'Exported 3 rows' },
      { action: 'route', url: '*/api/invoices/*', abort: 'TimedOut' },
      { action: 'click', text: 'Export CSV' },
      { action: 'waitFor', text: 'Network problem' },
      { action: 'unroute' },
      { action: 'route', url: '/api/invoices/export', delayMs: 8000 },
      { action: 'click', text: 'Export CSV' },
      { action: 'waitFor', text: 'Network problem' }
    ] });
    assert.equal(res.screenshots[0].path, shot);
    assert.deepEqual(res.routed.map(r => [r.step, r.status ?? r.abort ?? `delay ${r.delayMs}`]), [[2, 500], [8, 'TimedOut'], [12, 'delay 8000']]);
    assert.match(res.note, /simulated by the browser/);
    // Server chỉ thấy lần bấm thật: 500 và TimedOut do trình duyệt trả, request bị làm chậm thì trang tự huỷ ở 4 s.
    assert.equal(hits, 1);
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'route', url: '/api', status: 700 }] }), /status must be 100-599/);
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'route', url: '/api' }] }), /give status, abort or delayMs/);
  } finally {
    server.close();
  }
});
