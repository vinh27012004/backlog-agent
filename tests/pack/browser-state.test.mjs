// Ứng dụng mẫu độc lập: browser storage, reload, retry, concurrency và provenance ảnh.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { browserProfileFile, withBrowserLocks, withBrowserProfile } from '../../pack/src/env/browser-profile.mjs';
import { evidenceProblems, recordEvidence } from '../../pack/src/env/evidence.mjs';
import { run } from '../../pack/src/core/jobs.mjs';
import { digest } from '../../pack/src/core/candidates.mjs';
import { ensurePlaywright, sh, tempDir } from './support.mjs';

const { captureEvidence, findBrowser } = await import(process.env.MTM_BROWSER_MODULE ?? new URL('../../pack/src/env/browser.mjs', import.meta.url).href);
const browser = findBrowser();
if (browser) ensurePlaywright();
const browserTest = { skip: !browser && 'no Edge/Chrome', timeout: 90_000 };

const STORAGE_PAGE = `<!doctype html><title>Storage fixture</title>
<button id="save">Save records</button><button id="add">Add record</button><button id="file">Save file</button>
<p id="summary">Opening storage</p><p id="files">Opening files</p>
<script>
const request = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
async function open() {
  const req=indexedDB.open('fixture',1);
  req.onupgradeneeded=()=>req.result.createObjectStore('records',{keyPath:'id'});
  return request(req);
}
async function rows() {
  const db=await open(), tx=db.transaction('records');
  const result=await request(tx.objectStore('records').getAll()); db.close(); return result;
}
async function render() {
  const data=await rows();
  summary.textContent='Records '+data.length+'; Binary '+(data[0]?Array.from(new Uint8Array(data[0].binary)).join(','):'empty')
    +'; Preference '+(localStorage.getItem('window')||'empty')+'; Cookie '+(document.cookie.includes('fixture=yes')?'yes':'no')
    +'; Session '+(sessionStorage.getItem('temporary')||'empty');
}
async function store(data) {
  const db=await open(), tx=db.transaction('records','readwrite');
  for(const row of data) tx.objectStore('records').put(row);
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);}); db.close();
  await render(); document.documentElement.dataset.saved='yes';
}
document.getElementById('save').onclick=async()=>{
  document.documentElement.dataset.saved='no';
  localStorage.setItem('window','extended');document.cookie='fixture=yes;Path=/';sessionStorage.setItem('temporary','transient');
  summary.textContent='Saving records';await new Promise(resolve=>setTimeout(resolve,200));
  await store([{id:1,binary:new Uint8Array([0,7,255]).buffer},{id:2,binary:new ArrayBuffer(0)}]);
};
document.getElementById('add').onclick=async()=>{
  document.documentElement.dataset.saved='no';const data=await rows();
  await store([{id:data.length+1,binary:new Uint8Array([0,7,255]).buffer}]);
};
async function renderFile(){
  try{const root=await navigator.storage.getDirectory(), handle=await root.getFileHandle('fixture.bin');
    files.textContent='File '+Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())).join(',');
  }catch{files.textContent='File empty';}
}
document.getElementById('file').onclick=async()=>{
  const root=await navigator.storage.getDirectory(), handle=await root.getFileHandle('fixture.bin',{create:true});
  const writer=await handle.createWritable();await writer.write(new Uint8Array([2,4,8]));await writer.close();await renderFile();
};
render();renderFile();
</script>`;

async function fixture(handler = null) {
  const tw = tempDir('mtm-evidence-state-');
  const evidence = join(tw, 'matches', 'M1', 'M1', 'answers', 'BUG-01', 'evidence');
  const server = createServer(handler ?? ((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(STORAGE_PAGE); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { tw, evidence, server, url, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const saveSteps = url => [{ action: 'goto', url }, { action: 'click', selector: '#save' },
  { action: 'waitFor', selector: 'html[data-saved="yes"]' }];

test('IndexedDB binary records, cookies and localStorage survive a second capture without losing data', browserTest, async () => {
  const f = await fixture();
  try {
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'storage', steps: saveSteps(f.url) });
    const result = await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'storage', steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Records 2' },
      { action: 'assertText', text: 'Binary 0,7,255' }, { action: 'assertText', text: 'Preference extended; Cookie yes; Session empty' },
      { action: 'screenshot', path: join(f.evidence, 'restored.png'), requireAssertion: true }
    ] });
    assert.equal(result.browserState.restored, true); assert.equal(result.browserState.saved, true);
    assert.ok(result.browserState.stores.includes('indexedDB'));
    assert.ok(result.browserState.notPersisted.includes('sessionStorage'));
    assert.deepEqual(result.screenshots[0].assertionSteps, [2, 3, 4]);
  } finally { await f.close(); }
});

test('OPFS files survive across captures with the same profile', browserTest, async () => {
  const f = await fixture();
  try {
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'files', steps: [
      { action: 'goto', url: f.url }, { action: 'click', selector: '#file' }, { action: 'assertText', text: 'File 2,4,8' }
    ] });
    const result = await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'files', steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'File 2,4,8' }
    ] });
    assert.equal(result.browserState.saved, true); assert.ok(result.browserState.stores.includes('opfs'));
  } finally { await f.close(); }
});

test('observable save completion survives reload; an ephemeral capture starts fresh next time', browserTest, async () => {
  const f = await fixture();
  try {
    const result = await captureEvidence({ teamWorkspace: f.tw, steps: [...saveSteps(f.url),
      { action: 'reload' }, { action: 'assertText', text: 'Records 2' }, { action: 'assertText', text: 'Session transient' },
      { action: 'screenshot', path: join(f.evidence, 'reloaded.png'), requireAssertion: true }
    ] });
    assert.deepEqual(result.screenshots[0].assertionSteps, [5, 6]);
    assert.equal(result.browserState.mode, 'ephemeral'); assert.equal(result.browserState.saved, false);
    await captureEvidence({ teamWorkspace: f.tw, steps: [{ action: 'goto', url: f.url }, { action: 'assertText', text: 'Records 0' }] });
  } finally { await f.close(); }
});

test('concurrent captures with one profile restore the latest write instead of overwriting each other', browserTest, async () => {
  const f = await fixture();
  try {
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'counter', steps: saveSteps(f.url) });
    const results = await Promise.all([1, 2].map(() => captureEvidence({ teamWorkspace: f.tw, browserProfile: 'counter', steps: [
      { action: 'goto', url: f.url }, { action: 'click', selector: '#add' }, { action: 'waitFor', selector: 'html[data-saved="yes"]' }
    ] })));
    assert.deepEqual(results.map(r => Number(r.visibleText.match(/Records (\d+)/)[1])).sort(), [3, 4]);
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'counter', steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Records 4' }
    ] });
  } finally { await f.close(); }
});

test('a broken saved profile fails explicitly without making a fresh session or replacing its state', browserTest, async () => {
  let requests = 0;
  const f = await fixture((req, res) => { requests++; res.end('fresh session'); });
  const file = browserProfileFile(f.tw, 'broken'), data = '{private-corrupt-state';
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data);
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: f.tw, browserProfile: 'broken', steps: [{ action: 'goto', url: f.url }] }), e => {
      assert.equal(e.code, 'BROWSER_PROFILE_RESTORE_FAILED'); assert.doesNotMatch(e.message, /private-corrupt-state/);
      assert.equal(e.details.browserState.saved, false); return true;
    });
    assert.equal(requests, 0); assert.equal(readFileSync(file, 'utf8'), data);
    assert.equal(existsSync(`${file}.lock`), false);
  } finally { await f.close(); }
});

test('a profile save failure returns completed artifacts and releases the profile lock', browserTest, async () => {
  let stateFile;
  const f = await fixture((req, res) => {
    if (req.url === '/break') { mkdirSync(stateFile); return res.end('ok'); }
    res.end('<button onclick="fetch(\'/break\').then(()=>document.body.textContent=\'Saved on screen\')">Break state save</button>');
  });
  stateFile = browserProfileFile(f.tw, 'save-failure');
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: f.tw, browserProfile: 'save-failure', steps: [
      { action: 'goto', url: f.url }, { action: 'click', text: 'Break state save' }, { action: 'assertText', text: 'Saved on screen' },
      { action: 'screenshot', path: join(f.evidence, 'completed.png'), requireAssertion: true }
    ] }), e => {
      assert.equal(e.code, 'BROWSER_PROFILE_SAVE_FAILED'); assert.equal(e.details.screenshots.length, 1);
      assert.equal(e.details.browserState.saved, false); return true;
    });
    assert.equal(existsSync(join(f.evidence, 'completed.png')), true);
    assert.equal(existsSync(`${stateFile}.lock`), false);
  } finally { await f.close(); }
});

test('failed attempts preserve completed images and save fresh diagnostics under unique names', browserTest, async () => {
  const f = await fixture((req, res) => res.end('<h1>Ready</h1>'));
  const first = join(f.evidence, 'completed.png'), pending = join(f.evidence, 'pending.png');
  const invoke = () => captureEvidence({ teamWorkspace: f.tw, steps: [
    { action: 'goto', url: f.url }, { action: 'assertText', text: 'Ready' }, { action: 'screenshot', path: first, requireAssertion: true },
    { action: 'assertText', text: 'Missing', timeoutMs: 0 }, { action: 'screenshot', path: pending, requireAssertion: true }
  ] });
  try {
    const failures = [];
    for (let i = 0; i < 2; i++) await assert.rejects(invoke(), e => {
      assert.equal(e.code, 'ASSERT_FAILED'); assert.equal(e.details.failedStep, 4);
      assert.equal(e.details.screenshots.length, 1); assert.equal(e.details.diagnostics.length, 1);
      assert.equal(e.details.diagnostics[0].role, 'diagnostic');
      assert.ok(existsSync(e.details.diagnostics[0].path)); failures.push(e); return true;
    });
    assert.equal(existsSync(first), true); assert.equal(existsSync(pending), false);
    assert.notEqual(failures[0].details.diagnostics[0].path, failures[1].details.diagnostics[0].path);
    assert.notEqual(failures[0].details.attemptId, failures[1].details.attemptId);
    assert.equal(readdirSync(f.evidence).filter(n => n.includes('.failed-')).length, 2);
    const original = readFileSync(first);
    await assert.rejects(captureEvidence({ teamWorkspace: f.tw, steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Missing', timeoutMs: 0 },
      { action: 'screenshot', path: first, requireAssertion: true }
    ] }), e => {
      assert.equal(e.details.screenshots.length, 0);
      assert.notEqual(e.details.diagnostics[0].path, first); return true;
    });
    assert.deepEqual(readFileSync(first), original);
  } finally { await f.close(); }
});

test('screenshots can require current postconditions and reject conditions that become stale', browserTest, async () => {
  const f = await fixture((req, res) => res.end('<h1>Ready</h1><button onclick="document.querySelector(\'h1\').textContent=\'Changed\'">Change</button>'));
  try {
    await assert.rejects(captureEvidence({ teamWorkspace: f.tw, steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Ready' }, { action: 'click', text: 'Change' },
      { action: 'screenshot', path: join(f.evidence, 'unasserted.png'), requireAssertion: true }
    ] }), e => e.code === 'ASSERTION_REQUIRED');
    await assert.rejects(captureEvidence({ teamWorkspace: f.tw, steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Ready' },
      { action: 'route', url: '/unused', status: 500 }, { action: 'screenshot', path: join(f.evidence, 'cleared.png'), requireAssertion: true }
    ] }), e => e.code === 'ASSERTION_REQUIRED');
    const timed = await fixture((req, res) => res.end('<h1>Ready</h1><script>setTimeout(()=>document.querySelector(\'h1\').textContent=\'Changed\',500)</script>'));
    try {
      await assert.rejects(captureEvidence({ teamWorkspace: timed.tw, steps: [
        { action: 'goto', url: timed.url }, { action: 'assertText', text: 'Ready' },
        { action: 'screenshot', path: join(timed.evidence, 'stale.png'), requireAssertion: true, settleMs: 700 }
      ] }), e => e.code === 'ASSERTION_STALE');
      assert.equal(existsSync(join(timed.evidence, 'stale.png')), false);
    } finally { await timed.close(); }
  } finally { await f.close(); }
});

test('identical profile names are isolated between worktrees', browserTest, async () => {
  const f = await fixture(), checkout = join(f.tw, 'matches', 'M1'), main = join(checkout, 'M1');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'package.json'), '{}'); writeFileSync(join(checkout, '.gitignore'), '.team-work/\n');
  sh('git', ['init', '-q'], checkout); sh('git', ['config', 'user.name', 'test'], checkout); sh('git', ['config', 'user.email', 'test@example.test'], checkout);
  sh('git', ['add', '.'], checkout); sh('git', ['commit', '-q', '-m', 'fixture'], checkout);
  const wt = join(checkout, '.team-work', 'wt', 'BUG-01');
  sh('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], checkout);
  const ctx = root => ({ matchRoot: root, backlogItemKey: 'BUG-01', scenario: 'storage', appMode: 'production', phase: 'final' });
  const a = ctx(main), b = ctx(join(wt, 'M1'));
  try {
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'same-name', context: a, steps: saveSteps(f.url) });
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'same-name', context: b, steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Records 0' }
    ] });
    await captureEvidence({ teamWorkspace: f.tw, browserProfile: 'same-name', context: a, steps: [
      { action: 'goto', url: f.url }, { action: 'assertText', text: 'Records 2' }
    ] });
    assert.notEqual(browserProfileFile(f.tw, 'same-name', a), browserProfileFile(f.tw, 'same-name', b));
  } finally { await f.close(); }
});

test('diagnostic provenance cannot support a PASS and does not invalidate unrelated completed evidence', async () => {
  const root = tempDir('mtm-evidence-role-'), teamWork = join(root, '.team-work'), evidence = join(root, 'answers', 'BUG-01', 'evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'ok.png'), 'completed'); writeFileSync(join(evidence, 'failure.png'), 'diagnostic');
  const snapshot = { source: 'current', environment: 'current' };
  for (const [name, role] of [['ok.png', 'evidence'], ['failure.png', 'diagnostic']]) {
    recordEvidence(teamWork, 'BUG-01', { name, role, path: join(evidence, name), phase: 'final',
      source: role === 'evidence' ? 'current' : 'old', environment: 'current', sha256: digest(readFileSync(join(evidence, name))) });
  }
  const answer = evidence => writeFileSync(join(root, 'answers', 'BUG-01', 'submit.json'), JSON.stringify({ testResults: [{ result: 'PASS', evidence }] }));
  answer(['evidence/ok.png']); assert.deepEqual(await evidenceProblems(teamWork, 'BUG-01', root, snapshot), []);
  answer(['evidence/failure.png']); assert.match((await evidenceProblems(teamWork, 'BUG-01', root, snapshot)).join(), /diagnostic.*cannot support PASS/);
});

test('provenance distinguishes identical artifact names in separate worktrees and published copies', async () => {
  const root = tempDir('mtm-evidence-worktrees-'), teamWork = join(root, '.team-work');
  const a = join(root, 'a'), b = join(root, 'b'), published = join(root, 'published');
  const path = worktree => join(worktree, 'answers', 'BUG-01', 'evidence', 'same.png');
  for (const [worktree, bytes, source] of [[a, 'image A', 'source A'], [b, 'image B', 'source B']]) {
    mkdirSync(dirname(path(worktree)), { recursive: true }); writeFileSync(path(worktree), bytes);
    recordEvidence(teamWork, 'BUG-01', { name: 'same.png', path: path(worktree), phase: 'final',
      role: 'evidence', source, environment: 'env', sha256: digest(readFileSync(path(worktree))) });
  }
  assert.deepEqual(await evidenceProblems(teamWork, 'BUG-01', a, { source: 'source A', environment: 'env' }), []);
  assert.deepEqual(await evidenceProblems(teamWork, 'BUG-01', b, { source: 'source B', environment: 'env' }), []);
  mkdirSync(dirname(path(published)), { recursive: true }); writeFileSync(path(published), readFileSync(path(b)));
  assert.deepEqual(await evidenceProblems(teamWork, 'BUG-01', published, { source: 'source B', environment: 'env' }), []);
  writeFileSync(path(a), readFileSync(path(b)));
  assert.match((await evidenceProblems(teamWork, 'BUG-01', a, { source: 'source A', environment: 'env' })).join(), /bytes changed/);
});

test('profile locks synchronize helper processes and release after a failing capture', async () => {
  const root = tempDir('mtm-profile-lock-'), file = join(root, 'profile.json'), trace = join(root, 'trace');
  const module = new URL('../../pack/src/env/browser-profile.mjs', import.meta.url).href;
  let child;
  await withBrowserProfile(file, async () => {
    writeFileSync(trace, 'parent start\n');
    child = run(process.execPath, ['--input-type=module', '-e', `import {withBrowserProfile} from ${JSON.stringify(module)}; import {appendFileSync} from 'node:fs'; await withBrowserProfile(${JSON.stringify(file)}, async()=>appendFileSync(${JSON.stringify(trace)},${JSON.stringify('child\n')}));`]);
    await new Promise(resolve => setTimeout(resolve, 500));
    writeFileSync(trace, 'parent start\nparent end\n');
  });
  const completed = await child;
  assert.equal(completed.code, 0, completed.tail);
  assert.equal(readFileSync(trace, 'utf8'), 'parent start\nparent end\nchild\n');
  await assert.rejects(withBrowserProfile(file, async () => { throw new Error('fixture'); }), /fixture/);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('independent profile resources can run while another profile is held', async () => {
  const root = tempDir('mtm-profile-parallel-'), a = join(root, 'a.json'), b = join(root, 'b.json');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = withBrowserLocks([a], async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  try { await withBrowserLocks([b], async () => assert.equal(existsSync(`${a}.lock`), true)); }
  finally { release(); await first; }
});
