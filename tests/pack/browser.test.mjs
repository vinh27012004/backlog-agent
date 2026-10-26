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
  } finally {
    client.close();
    server.close();
  }
});
