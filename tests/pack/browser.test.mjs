// capture_evidence: Edge headless qua Playwright trên một app giả ở localhost (đăng nhập → form → chụp).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { seededAccount } from '../../pack/src/env/applogin.mjs';
import { captureEvidence, entryPassword, evidencePath, findBrowser, profileHint } from '../../pack/src/env/browser.mjs';
import { ensurePlaywright, install, McpClient, sh, tempDir } from './support.mjs';

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
// Lớp phủ che nút (giống sidebar đè nội dung): click bấm xuyên lớp che và bước ghi obscuredBy.
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
if (browser) ensurePlaywright();

test('download preserves authenticated HTTP/Blob bytes and reports a download timeout', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-download-'), 'BUN'), bytes = Buffer.from('\ufeffname,value\r\n"Saigon,\nLtd",2\r\n');
  const server = createServer((req, res) => {
    if (req.url === '/login') return res.end(`<button onclick="fetch('/authorize').then(()=>location.href='/exports')">Sign in</button>`);
    if (req.url === '/authorize') { res.setHeader('Set-Cookie', 'auth=yes; Path=/; Max-Age=3600'); return res.end('ok'); }
    if (!req.headers.cookie?.includes('auth=yes')) { res.writeHead(401); return res.end('Unauthorized'); }
    if (req.url === '/file.csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="export.csv"' }); return res.end(bytes); }
    res.end(`<a id="http" href="/file.csv">Export HTTP</a><button id="blob">Export Blob</button><button id="nothing">No file</button>
      <button id="late" disabled>Ready</button><script>setTimeout(()=>late.disabled=false,200);
      blob.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([Uint8Array.from(atob('${bytes.toString('base64')}'),c=>c.charCodeAt(0))]));a.download='blob.csv';a.click();};</script>`);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const url = `http://127.0.0.1:${server.address().port}`;
  const folder = join(tw, 'matches', 'M1', 'M1', 'answers', 'CR-01', 'evidence');
  try {
    const r = await captureEvidence({ teamWorkspace: tw, browserProfile: 'downloads', steps: [
      { action: 'goto', url: `${url}/login` }, { action: 'click', text: 'Sign in' }, { action: 'waitFor', selector: '#http' },
      { action: 'waitFor', selector: '#late', state: 'enabled' }, { action: 'download', selector: '#http', path: join(folder, 'http.csv') },
      { action: 'download', selector: '#blob', path: join(folder, 'blob.csv') }
    ] });
    assert.equal(r.downloads.length, 2); for (const d of r.downloads) { assert.deepEqual(readFileSync(d.path), bytes); assert.equal(d.bytes, bytes.length); assert.match(d.sha256, /^[a-f0-9]{64}$/); }
    await assert.rejects(captureEvidence({ teamWorkspace: tw, browserProfile: 'downloads', steps: [
      { action: 'goto', url: `${url}/exports` }, { action: 'download', selector: '#nothing', path: join(folder, 'none.csv'), timeoutMs: 500 }
    ] }), e => e.code === 'DOWNLOAD_TIMEOUT' && e.details.failedStep === 2);
    assert.throws(() => evidencePath(tw, join(tw, 'outside.csv'), { pngOnly: false }), /PATH_NOT_ALLOWED/);
  } finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
});

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

// 428c517 (02/11): bị che thì luôn bấm xuyên, không đợi force (sidebar của BUG-01 đè tab của mọi item khác).
test('capture_evidence clicks through a covering element and reports the cover', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const { server, url } = await app();
  try {
    const t0 = Date.now();
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `${url}/covered` }, { action: 'click', text: 'Save' }, { action: 'assertText', text: 'saved' }] });
    assert.match(res.steps.find(s => s.forced).obscuredBy, /Sidebar/);
    assert.ok(Date.now() - t0 < 8000, 'a covered click does not wait the full timeout');
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

// Practice #5 (BC3JL6ZC): fixer viết selector Playwright; từ 03/11 engine là Playwright nên cú pháp đó chạy được.
test('capture_evidence accepts Playwright selectors and reports the page on a failed step', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: 'http://127.0.0.1:1/' }, { action: 'click' }] }),
    e => e.code === 'INVALID_ARGUMENT' && /needs a selector or a text/.test(e.message));
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TABS); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url },
      { action: 'click', selector: "[role=tab]:has-text('Invoices')" }, { action: 'waitFor', selector: 'text=New invoice', timeoutMs: 2000 },
      { action: 'click', selector: 'button >> nth=0' }] });
    assert.match(ok.visibleText, /New invoice/);
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

// OMZJW0S0/UOMNKT6Z BUG-09: ảnh dự phòng khi bước hỏng mang đúng tên ảnh kịch bản (tc-02-*.png), dễ bị nộp như evidence đạt.
test('a failed step writes a separately named diagnostic image, never the scenario image, and keeps earlier ones', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const evidence = join(tw, 'matches', 'M1', 'M1', 'answers', 'BUG-09', 'evidence');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TABS); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url },
      { action: 'screenshot', path: join(evidence, 'tc-01-schedules.png') },
      { action: 'click', text: 'Receipts', timeoutMs: 500 },
      { action: 'screenshot', path: join(evidence, 'tc-02-window-14.png') }] }), e => {
      assert.equal(e.details.failedStep, 3);
      assert.equal(e.details.diagnostic, join(evidence, 'tc-02-window-14.FAILED-step3.png'));
      assert.deepEqual(e.details.screenshotsDone, [join(evidence, 'tc-01-schedules.png')]);
      return true;
    });
    assert.ok(existsSync(join(evidence, 'tc-01-schedules.png')), 'the scenario captured before the failure stays');
    assert.ok(!existsSync(join(evidence, 'tc-02-window-14.png')), 'no file carries the name of the scenario that failed');
    assert.ok(existsSync(join(evidence, 'tc-02-window-14.FAILED-step3.png')));
  } finally {
    server.close();
  }
});

// NBDB5U0O BUG-02: click [role=option] khi danh sách chưa mở và click "New invoice" trên about:blank; candidates của
// lỗi chỉ là link sidebar đầu DOM.
const SIDEBAR_PAGE = page(`<nav>${Array.from({ length: 45 }, (_, i) => `<a href="/p${i}">Link ${i}</a>`).join('')}</nav>
<main><div role="tablist"><button role="tab" id="t-rep">Reports</button><button role="tab" id="t-inv">Invoices</button></div>
<button role="combobox" aria-label="Company">Pick a company</button></main>`);

test('a failed step lists the elements near it first and hints at the fix; a step before goto fails at once', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'click', selector: 'button', text: 'New invoice' }] }),
    e => e.code === 'INVALID_ARGUMENT' && /step 1 \(click\) comes before any goto or login/.test(e.message));
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(SIDEBAR_PAGE); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url },
      { action: 'click', selector: '[role=option]', text: 'Mekong Logistics', timeoutMs: 300 }] }), e => {
      assert.equal(e.code, 'ELEMENT_NOT_FOUND');
      assert.equal(e.details.hint, 'No option list is open: a custom select renders its options only after a click on its trigger '
        + '(button[role=combobox][aria-label="Company"] "Pick a company"); click it first.');
      assert.deepEqual(e.details.candidates.slice(0, 3), ['button#t-rep[role=tab] "Reports"', 'button#t-inv[role=tab] "Invoices"',
        'button[role=combobox][aria-label="Company"] "Pick a company"'], 'elements of main come before the 45 sidebar links');
      return true;
    });
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url },
      { action: 'click', selector: 'a', text: 'Invoices', timeoutMs: 300 }] }), e => {
      assert.equal(e.details.candidates[0], 'button#t-inv[role=tab] "Invoices"');
      assert.equal(e.details.hint, '"Invoices" is on the page as button#t-inv[role=tab] "Invoices": use that selector.');
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
    assert.ok(existsSync(join(tw, 'team-sdlc-pack', 'local', 'browser', 'solova-admin.json')));
    // CR-01 ở 3OCNFC54 chụp bốn kịch bản song song: cùng profile không khoá nhau.
    const all = await Promise.all([1, 2, 3].map(() =>
      captureEvidence({ teamWorkspace: tw, browserProfile: 'solova-admin', steps: [{ action: 'goto', url: `${url}/accounting` }] })));
    for (const res of all) assert.match(res.visibleText, /Accounting/);
    const fresh = await captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: `${url}/accounting` }] });
    assert.match(fresh.visibleText, /Please sign in/);
  } finally {
    server.close();
  }
});

// OMZJW0S0 BUG-09: app lưu budget local trong IndexedDB; profile chỉ giữ cookie/localStorage nên lần gọi sau về /bootstrap.
const IDB_PAGE = page(`<div id="out">loading</div><script>
const open = indexedDB.open('budget', 1);
open.onupgradeneeded = () => open.result.createObjectStore('rows');
open.onsuccess = () => {
  const db = open.result;
  // Khoá 0 và giá trị nhị phân như block SQLite của budget local (Playwright bỏ khoá 0 khi lưu).
  if (location.hash === '#add') {
    const tx = db.transaction('rows', 'readwrite');
    tx.objectStore('rows').put(new TextEncoder().encode('Edge 14 days').buffer, 0);
    tx.objectStore('rows').put(new TextEncoder().encode('Beyond 15 days').buffer, 1);
    tx.oncomplete = () => { out.textContent = 'saved'; };
  } else {
    const req = db.transaction('rows').objectStore('rows').getAll();
    req.onsuccess = () => { out.textContent = 'rows: ' + (req.result.map(b => new TextDecoder().decode(b)).join(', ') || 'none'); };
  }
};
</script>`);

test('capture_evidence browserProfile keeps IndexedDB data across calls', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(IDB_PAGE); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await captureEvidence({ teamWorkspace: tw, browserProfile: 'bug09', steps: [
      { action: 'goto', url: `${url}/#add` }, { action: 'assertText', text: 'saved' }] });
    const again = await captureEvidence({ teamWorkspace: tw, browserProfile: 'bug09', steps: [
      { action: 'goto', url: `${url}/` }, { action: 'assertText', text: 'rows:' }] });
    assert.match(again.visibleText, /rows: Edge 14 days, Beyond 15 days/);
    const fresh = await captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: `${url}/` }, { action: 'assertText', text: 'rows:' }] });
    assert.match(fresh.visibleText, /rows: none/);
  } finally {
    server.close();
  }
});

// Snapshot có bản ghi out-of-line thiếu khoá (như file cũ lưu trước khi sửa): Playwright không khôi phục được IndexedDB;
// khi đó vẫn phải giữ cookie đăng nhập thay vì mở phiên trắng.
test('a saved IndexedDB that cannot be restored still restores the login cookie', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(/sid=ok/.test(req.headers.cookie ?? '') ? '<h1>Accounting</h1>' : '<h1>Please sign in</h1>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = join(tw, 'team-sdlc-pack', 'local', 'browser');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken-idb.json'), JSON.stringify({
    cookies: [{ name: 'sid', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [{ origin, localStorage: [], indexedDB: [{ name: 'actual', version: 1, stores: [
      { name: 'data', autoIncrement: false, records: [{ value: 'block without its key' }], indexes: [] }] }] }] }));
  try {
    const res = await captureEvidence({ teamWorkspace: tw, browserProfile: 'broken-idb', steps: [{ action: 'goto', url: `${origin}/accounting` }] });
    assert.match(res.visibleText, /Accounting/);
    assert.ok(res.steps.some(s => s.action === 'browserProfile' && /IndexedDB could not be restored/.test(s.note)), JSON.stringify(res.steps));
  } finally {
    server.close();
  }
});

test('a visible element that never becomes clickable reports why; a closed port fails at goto', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('<button disabled>Record payment</button>')); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: `http://127.0.0.1:${server.address().port}/` },
      { action: 'click', text: 'Record payment', timeoutMs: 800 }] }), e => {
      assert.equal(e.code, 'ELEMENT_NOT_ACTIONABLE');
      assert.match(e.message, /not enabled/);
      assert.equal(e.details.failedStep, 2);
      return true;
    });
  } finally { server.close(); }
  const closed = createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: `http://127.0.0.1:${port}/` }] }),
    e => e.code === 'NAVIGATION_FAILED' && /ERR_CONNECTION_REFUSED/.test(e.message) && e.details.failedStep === 1);
});

// Thư mục trận giả có app node với seed đọc ADMIN_* (mặc định admin/secret, như prisma/seed.ts của Solova).
const SEED = 'const email = process.env.ADMIN_EMAIL ?? "admin";\nconst password = process.env.ADMIN_PASSWORD ?? "secret";\n';

function seededRepo(tw, { env = '', seed = SEED } = {}) {
  const root = join(tw, 'matches', 'M1', 'M1');
  mkdirSync(join(root, 'src', 'prisma'), { recursive: true });
  writeFileSync(join(root, 'src', 'package.json'), JSON.stringify({ name: 'app', scripts: { start: 'next start' } }));
  writeFileSync(join(root, 'src', 'prisma', 'seed.ts'), seed);
  writeFileSync(join(root, 'src', '.env'), env);
  return root;
}

test('seededAccount takes the seed script defaults, .env values first, and skips other services', () => {
  const tw = join(tempDir('mtm-login-'), 'BUN');
  let root = seededRepo(tw, { env: 'DATABASE_URL=postgres://x\nSMTP_USER=mailer\nSMTP_PASSWORD=mail\n' });
  assert.deepEqual(seededAccount(root), { username: 'admin', password: 'secret',
    sources: ['ADMIN_EMAIL default in src/prisma/seed.ts', 'ADMIN_PASSWORD default in src/prisma/seed.ts'] });
  root = seededRepo(tw, { env: 'ADMIN_PASSWORD="from-env" # comment\n' });
  const acct = seededAccount(root);
  assert.equal(acct.password, 'from-env');
  assert.deepEqual(acct.sources, ['ADMIN_EMAIL default in src/prisma/seed.ts', 'ADMIN_PASSWORD from src/.env']);
  root = seededRepo(tw, { seed: 'const url = process.env.DATABASE_URL;\n', env: 'SMTP_USER=a\nSMTP_PASSWORD=b\n' });
  assert.throws(() => seededAccount(root), e => e.code === 'LOGIN_ACCOUNT_NOT_FOUND');
});

test('capture_evidence login signs in with the seeded account without exposing it', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const root = seededRepo(tw);
  const { server, url } = await app();
  try {
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'login', url: `${url}/login`, matchRoot: root }, { action: 'assertText', text: 'Dashboard' }] });
    assert.ok(res.finalUrl.endsWith('/dashboard'), res.finalUrl);
    assert.deepEqual(res.steps[0], { step: 1, action: 'login', account: ['ADMIN_EMAIL default in src/prisma/seed.ts', 'ADMIN_PASSWORD default in src/prisma/seed.ts'] });
    assert.doesNotMatch(JSON.stringify(res), /secret/);
    // Mật khẩu sai: LOGIN_FAILED kèm trang (thông báo của app), không lộ mật khẩu.
    seededRepo(tw, { env: 'ADMIN_PASSWORD=wrong\n' });
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'login', url: `${url}/login`, matchRoot: root, timeoutMs: 2000 }] }), e => {
      assert.equal(e.code, 'LOGIN_FAILED');
      assert.match(e.details.visibleText, /Invalid/);
      assert.doesNotMatch(JSON.stringify({ m: e.message, d: e.details }), /wrong/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('capture_evidence refuses non-loopback URLs and paths outside answers/<ID>/evidence', async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url: 'https://example.com/' }] }), /URL_NOT_ALLOWED/);
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'login', url: 'https://example.com/login', matchRoot: tw }] }), /URL_NOT_ALLOWED/);
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'login', url: 'http://localhost:3100/login', matchRoot: tempDir('mtm-x-') }] }), /PATH_NOT_ALLOWED/);
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

// FMC0ZXFC BUG-04: thả card lên đầu danh sách cần kéo-thả thật; không có step drag nên TC-02 NOT_RUN. Danh sách kéo bằng
// chuột như @hello-pangea/dnd (bắt đầu kéo sau 5 px, thả trước phần tử dưới con trỏ) và nhận Space bằng bàn phím.
const DRAG = page(`<ul id="list" style="list-style:none;padding:0;margin:40px;width:200px">
<li style="height:40px">A</li><li style="height:40px">B</li><li style="height:40px">C</li></ul><div id="order"></div><div id="key"></div>
<script>
const show = () => order.textContent = 'order ' + [...list.children].map(li => li.textContent).join(',');
show(); let drag = null, start = null, moved = false;
list.addEventListener('mousedown', e => { drag = e.target.closest('li'); start = e.clientY; moved = false; });
window.addEventListener('mousemove', e => { if (drag && e.buttons === 1 && Math.abs(e.clientY - start) > 5) moved = true; });
window.addEventListener('mouseup', e => { if (drag && moved) { drag.style.display = 'none';
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li'); drag.style.display = '';
  if (over && over !== drag) list.insertBefore(drag, over); show(); } drag = null; });
window.addEventListener('keydown', e => { if (e.key === ' ' && e.keyCode === 32) key.textContent = 'lifted'; });
</script>`);

test('capture_evidence drags with real mouse events and presses Space', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'drag', text: 'C' }] }), /drag needs to/);
  await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'drag', text: 'C', to: { text: 'A' }, position: 'top' }] }), /position/);
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(DRAG); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `http://127.0.0.1:${server.address().port}/` },
      { action: 'drag', selector: 'li', text: 'C', to: { selector: 'li', text: 'A' }, position: 'before' },
      { action: 'assertText', text: 'order C,A,B' },
      { action: 'press', key: 'Space' }, { action: 'assertText', text: 'lifted' }] });
    assert.ok(res.steps.some(s => s.action === 'drag' && s.to));
  } finally {
    server.close();
  }
});

// BTZNI69E BUG-04: card của @hello-pangea/dnd là <button> trong drag handle; thư viện bỏ qua chuột/phím bắt đầu trong
// button nên kéo chuột chỉ mở card. Trang giả chặn như vậy và chỉ nhận Space/mũi tên trên chính handle.
const RFD = page(`<div data-rfd-droppable-id="L1" style="margin:40px;width:200px">
${['A', 'B', 'C'].map(t => `<div data-rfd-draggable-id="${t}" data-rfd-drag-handle-draggable-id="${t}" tabindex="0"><button style="width:100%;height:40px">${t}</button></div>`).join('')}
</div><div id="order"></div>
<script>
const drop = document.querySelector('[data-rfd-droppable-id]');
const show = () => order.textContent = 'order ' + [...drop.children].map(n => n.dataset.rfdDraggableId).join(',');
show(); let lifted = null;
window.addEventListener('mousedown', e => { if (e.target.closest('button')) return; });
window.addEventListener('keydown', e => {
  const h = e.target.closest?.('[data-rfd-drag-handle-draggable-id]');
  if (!h || e.target !== h) return;
  if (e.key === ' ') { e.preventDefault(); if (!lifted) lifted = h; else { lifted = null; show(); } return; }
  if (!lifted) return;
  if (e.key === 'ArrowUp' && lifted.previousElementSibling) drop.insertBefore(lifted, lifted.previousElementSibling);
  if (e.key === 'ArrowDown' && lifted.nextElementSibling) drop.insertBefore(lifted.nextElementSibling, lifted);
  lifted.focus();
});
</script>`);

test('capture_evidence drags a @hello-pangea/dnd card whose content is a button with the keyboard on its handle', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(RFD); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const card = t => ({ selector: `[data-rfd-draggable-id="${t}"]` });
    const res = await captureEvidence({ teamWorkspace: tw, steps: [
      { action: 'goto', url: `http://127.0.0.1:${server.address().port}/` },
      { action: 'drag', ...card('C'), to: card('A'), position: 'before' },
      { action: 'assertText', text: 'order C,A,B' },
      { action: 'drag', ...card('B'), to: card('C'), position: 'before' },
      { action: 'assertText', text: 'order B,C,A' },
      { action: 'drag', ...card('B'), to: card('A'), position: 'after' },
      { action: 'assertText', text: 'order C,A,B' }] });
    assert.deepEqual(res.steps.filter(s => s.action === 'drag').map(s => [s.mode, s.moves]), [['keyboard', -2], ['keyboard', -2], ['keyboard', 2]]);
  } finally {
    server.close();
  }
});

// PXWV53VC: đường dẫn tương đối bị từ chối (cả ba worker), ảnh dashboard chụp khi còn "—", assertText ngay sau click
// điều hướng báo ASSERT_FAILED.
test('evidence paths may be relative to context.matchRoot', () => {
  const tw = join(tempDir('mtm-evpath-'), 'BUN'), base = join(tw, 'matches', 'M1', '.team-work', 'wt', 'BUG-01', 'M1');
  const want = join(base, 'answers', 'BUG-01', 'evidence', 'a.png');
  for (const p of ['answers/BUG-01/evidence/a.png', 'evidence/a.png', 'a.png', './answers/BUG-01/evidence/a.png']) assert.equal(evidencePath(tw, p, { base, key: 'BUG-01' }), want);
  assert.throws(() => evidencePath(tw, 'a.png'), /relative to context.matchRoot/);
  assert.throws(() => evidencePath(tw, '../../x.png', { base, key: 'BUG-01' }), /PATH_NOT_ALLOWED/);
});

test('screenshot waits for pending requests and loading indicators; assertText waits for the text', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-settle-'), 'BUN'), root = join(tw, 'matches', 'M1', 'M1'); mkdirSync(root, { recursive: true });
  const checkout = join(tw, 'matches', 'M1');
  sh('git', ['init', '-q'], checkout);
  sh('git', ['config', 'user.name', 'test'], checkout);
  sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'export const app = true;\n');
  sh('git', ['add', 'M1'], checkout);
  sh('git', ['commit', '-q', '-m', 'browser fixture'], checkout);
  const server = createServer((req, res) => {
    if (req.url === '/api/stats') return setTimeout(() => res.end('16'), 1500);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(`<p id="n" aria-busy="true">—</p><button id="go">Money</button><script>
      fetch('/api/stats').then(r => r.text()).then(t => { n.textContent = 'Active companies ' + t; n.removeAttribute('aria-busy'); });
      go.onclick = () => setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<h1>Accounting</h1>'), 800);</script>`));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = { backlogItemKey: 'BUG-01', matchRoot: root, scenario: 'TC-1', phase: 'final', appMode: 'dev' };
    const res = await captureEvidence({ teamWorkspace: tw, context, steps: [
      { action: 'goto', url }, { action: 'screenshot', path: 'loading.png', idle: false }, { action: 'assertText', text: 'Active companies', required: false },
      { action: 'screenshot', path: 'answers/BUG-01/evidence/loaded.png' }, { action: 'assertText', text: 'Active companies 16', timeoutMs: 0 },
      { action: 'click', text: 'Money' }, { action: 'assertText', text: 'Accounting' }] });
    assert.equal(res.screenshots[0].path, join(root, 'answers', 'BUG-01', 'evidence', 'loading.png'));
    assert.equal(res.steps.find(s => s.step === 3).found, false);
    assert.equal(res.steps.find(s => s.step === 5).found, true);
    assert.ok(res.steps.filter(s => s.action === 'screenshot').every(s => !s.unsettled), JSON.stringify(res.steps));
  } finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
});

// QDO8W480 CR-05: challenge/CR-05-seed.js phải chạy trong trang của app (page.evaluate(seed, data)); không có bước nào
// làm được nên thợ tự viết script Playwright, hết giờ, TC-02..04 NOT_RUN.
test('runScript evaluates an issued script in the open page with data from the item files', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-script-'), 'BUN'), checkout = join(tw, 'matches', 'M1'), matchRoot = join(checkout, 'M1');
  const itemDir = join(checkout, '.team-work', 'items', 'CR-05');
  mkdirSync(join(matchRoot, 'src'), { recursive: true }); mkdirSync(join(itemDir, 'files', 'challenge'), { recursive: true }); mkdirSync(join(itemDir, 'company'), { recursive: true });
  writeFileSync(join(matchRoot, 'src', 'app.js'), 'x\n');
  sh('git', ['init', '-q'], checkout); sh('git', ['add', '-A'], checkout);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'issued'], checkout);
  writeFileSync(join(itemDir, 'files', 'challenge', 'CR-05-seed.js'),
    '// Evaluate this function in the app\'s page with the fixture\'s `data` as its argument.\nasync data => {\n  for (const c of data.categories) await window.$send(\'category-create\', c);\n  return { created: data.categories.length };\n};\n');
  writeFileSync(join(itemDir, 'files', 'challenge', 'broken.js'), 'async () => { throw new Error("no budget is open"); }');
  writeFileSync(join(itemDir, 'company', '01-get_test_data.json'), JSON.stringify({ tool: 'get_test_data', content: [{ type: 'text', text: JSON.stringify({ data: { categories: [{ name: 'Rent' }, { name: 'Food' }] } }) }] }));
  writeFileSync(join(matchRoot, 'src', 'mine.js'), '() => 1');
  const server = createServer((req, res) => res.end('<!doctype html><ul id="list"></ul><script>window.$send = async (name, c) => { const li = document.createElement("li"); li.textContent = name + " " + c.name; list.append(li); };</script>'));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const url = `http://127.0.0.1:${server.address().port}`;
  const context = { backlogItemKey: 'CR-05', matchRoot, scenario: 'CR-05-TC-03', phase: 'final', appMode: 'production' };
  try {
    const r = await captureEvidence({ teamWorkspace: tw, context, steps: [{ action: 'goto', url },
      { action: 'runScript', file: 'challenge/CR-05-seed.js', argFile: 'company/01-get_test_data.json', argPath: 'data' },
      { action: 'assertText', text: 'category-create Food' }] });
    const step = r.steps.find(s => s.action === 'runScript');
    assert.deepEqual(step.result, { created: 2 });
    assert.match(r.visibleText, /category-create Rent/);
    await assert.rejects(captureEvidence({ teamWorkspace: tw, context, steps: [{ action: 'goto', url }, { action: 'runScript', file: 'challenge/broken.js' }] }),
      e => e.code === 'SCRIPT_FAILED' && /no budget is open/.test(e.message) && e.details.failedStep === 2);
    await assert.rejects(captureEvidence({ teamWorkspace: tw, context, steps: [{ action: 'goto', url }, { action: 'runScript', file: join(matchRoot, 'src', 'mine.js') }] }),
      e => e.code === 'PATH_NOT_ALLOWED' && /files issued for CR-05/.test(e.message));
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'goto', url }, { action: 'runScript', file: 'challenge/CR-05-seed.js' }] }), /needs context/);
    await assert.rejects(captureEvidence({ teamWorkspace: tw, context, steps: [{ action: 'goto', url }, { action: 'runScript', file: 'challenge/CR-05-seed.js', argFile: 'company/01-get_test_data.json', argPath: 'data.rows' }] }), /argPath data.rows: no rows/);
  } finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
});

// EXP3I47A BUG-09: profile hỏng sau "Try Demo", mỗi goto /schedules rơi về /bootstrap; ba lần thử trên cùng profile (−65).
test('a step that fails after the app redirected a restored profile suggests a new browserProfile', () => {
  const hint = profileHint({ profile: 'bug09-desktop', restored: true, gotoUrl: 'http://localhost:3100/schedules', url: 'http://localhost:3100/bootstrap' });
  assert.match(hint, /restored browserProfile "bug09-desktop" and the app sent \/schedules to \/bootstrap.*new browserProfile name.*not one of your repair retries/);
  assert.equal(profileHint({ profile: 'p', restored: false, gotoUrl: 'http://localhost:3100/schedules', url: 'http://localhost:3100/bootstrap' }), null, 'a fresh profile: nothing saved to blame');
  assert.equal(profileHint({ profile: 'p', restored: true, gotoUrl: 'http://localhost:3100/schedules/', url: 'http://localhost:3100/schedules' }), null, 'no redirect');
  assert.equal(profileHint({ profile: 'p', restored: true, gotoUrl: 'http://localhost:3100', url: 'http://localhost:3100/budget' }), null, 'the root page moving on is normal');
  assert.equal(profileHint({ profile: null, restored: true, gotoUrl: 'http://localhost:3100/a', url: 'http://localhost:3100/b' }), null);
});

// WQ7T6CEC: app Actual có sync server. Server mới: /bootstrap (đặt mật khẩu, có nút bẫy "Try Demo"); server đã có mật khẩu:
// /login (chỉ một ô mật khẩu); đăng nhập rồi mà chưa có budget: màn chào "Start budgeting" / "Try the demo". CR-07 viết
// bước cố định, mỗi lần kẹt một màn khác và mất TC-03/04; BUG-09 thử 3 lần mới qua.
function entryApp() {
  // Phiên đăng nhập theo cookie của từng trình duyệt, như server thật: trình duyệt mới phải đăng nhập lại.
  const state = { password: null, budget: false, demo: false };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const html = h => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); };
    const go = to => { res.writeHead(302, { Location: to }); res.end(); };
    const url = req.url.split('?')[0];
    const authed = /sid=ok/.test(req.headers.cookie ?? '');
    if (url === '/api/bootstrap') { state.password = JSON.parse(body).p; res.writeHead(200); return res.end(); }
    if (url === '/api/login') { const ok = JSON.parse(body).p === state.password; res.writeHead(ok ? 200 : 401, ok ? { 'Set-Cookie': 'sid=ok; Path=/; HttpOnly; SameSite=Lax' } : {}); return res.end(); }
    if (url === '/api/demo') { state.demo = true; res.writeHead(200); return res.end(); }
    if (url === '/api/start') { state.budget = true; res.writeHead(200); return res.end(); }
    if (url === '/bootstrap') {
      return html(page(`<p>Welcome to Actual! To secure your data, you'll need to set a password for your server.</p>
<input type="password" placeholder="Password" id="a"><input type="password" placeholder="Confirm password" id="b">
<button id="demo">Try Demo</button><button id="ok">OK</button>
<script>
demo.onclick = async () => { await fetch('/api/demo', {method:'POST'}); location.href = '/'; };
ok.onclick = async () => { if (a.value !== b.value || !a.value) return; await fetch('/api/bootstrap', {method:'POST', body: JSON.stringify({p: a.value})}); setTimeout(() => location.href = '/login', 300); };
</script>`));
    }
    if (url === '/login') {
      return html(page(`<p>Sign in to this Actual instance</p><input type="password" placeholder="Password" id="p"><button id="go">Sign in</button><p id="msg"></p>
<script>go.onclick = async () => { const r = await fetch('/api/login', {method:'POST', body: JSON.stringify({p: p.value})}); if (r.ok) location.href = '/'; else msg.textContent = 'Invalid password'; };</script>`));
    }
    if (!state.password) return go('/bootstrap');
    if (!authed) return go('/login');
    if (!state.budget) {
      return html(page(`<h1>Welcome to Actual</h1><button id="d">Try the demo</button><button id="s">Start budgeting</button>
<script>d.onclick = async () => { await fetch('/api/demo', {method:'POST'}); location.href = '/budget'; };
s.onclick = async () => { await fetch('/api/start', {method:'POST'}); location.href = '/budget'; };</script>`));
    }
    return html(page(`<nav><a href="/schedules">Schedules</a></nav><h1>${url === '/schedules' ? 'Schedules' : 'Budget'}</h1>`));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('enterApp sets the server password, signs in and starts the budget, never the demo; a later call only signs in', { skip: !browser && 'no Edge/Chrome', timeout: 120_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const { server, state, url } = await entryApp();
  try {
    const first = await captureEvidence({ teamWorkspace: tw, steps: [{ action: 'enterApp', url }, { action: 'goto', url: `${url}/schedules` }, { action: 'assertText', text: 'Schedules' }] });
    assert.match(first.visibleText, /Schedules/);
    assert.deepEqual(first.steps.find(l => l.action === 'enterApp').screens, ['setup', 'signin', 'welcome']);
    assert.equal(state.demo, false, 'never the demo');
    assert.equal(state.budget, true);
    assert.equal(state.password, entryPassword(null));
    // Đề khác, trình duyệt mới, cùng server: chỉ còn màn đăng nhập, cùng mật khẩu.
    const second = await captureEvidence({ teamWorkspace: tw, steps: [{ action: 'enterApp', url }, { action: 'assertText', text: 'Budget' }] });
    assert.deepEqual(second.steps.find(l => l.action === 'enterApp').screens, ['signin']);
    // Server có mật khẩu khác (do tay người hay công cụ khác đặt): báo kẹt rõ ràng thay vì chờ hết giờ.
    state.password = 'someone-else';
    await assert.rejects(captureEvidence({ teamWorkspace: tw, steps: [{ action: 'enterApp', url }] }), /ENTRY_STUCK: still on the signin screen.*fresh app data/);
  } finally {
    server.close();
  }
});

test('a hand-written step that fails on a first-run screen points to enterApp', { skip: !browser && 'no Edge/Chrome', timeout: 90_000 }, async () => {
  const tw = join(tempDir('mtm-browser-'), 'BUN');
  const { server, url } = await entryApp();
  try {
    const err = await captureEvidence({ teamWorkspace: tw, timeoutMs: 15_000, steps: [{ action: 'goto', url }, { action: 'click', selector: 'button', text: 'Start budgeting', timeoutMs: 2000 }] })
      .then(() => null, e => e);
    assert.equal(err?.code, 'ELEMENT_NOT_FOUND');
    assert.match(err.details.hint, /first-run setup screen\. Start the call with enterApp/);
  } finally {
    server.close();
  }
});
