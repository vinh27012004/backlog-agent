// Chấm lại trận luyện tập (mục 12): collect gom đúng bài của từng item, score so judge với gate/reviewer.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBench } from '../../tools/judge/bench.mjs';
import { collectMatch } from '../../tools/judge/collect.mjs';
import { buildReport } from '../../tools/judge/items.mjs';
import { scoreMatch } from '../../tools/judge/score.mjs';
import { releaseTimes, usageMatch } from '../../tools/judge/usage.mjs';
import { sh, tempDir } from './support.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const json = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };

// Trận giả: BUG-09 đã tích hợp + nộp (commit "BUG-09: ..."), CR-02 còn dở trong worktree, TASK-03 chưa Start Work.
function fakeMatch() {
  const root = tempDir('mtm-judge-');
  const app = join(root, 'M1', 'src');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'lib.js'), 'exports.vnd = n => n * 10000;\n');
  sh('git', ['init', '-q', '-b', 'main'], root, env);
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.team-work/\n');
  sh('git', ['add', '-A'], root, env);
  sh('git', ['commit', '-q', '-m', 'Seed M1/'], root, env);
  const seed = sh('git', ['rev-parse', 'HEAD'], root);
  writeFileSync(join(app, 'lib.js'), 'exports.vnd = n => n * 100;\n');
  json(join(root, 'M1', 'answers', 'BUG-09', 'submit.json'), { status: 'DONE', testResults: [{ id: 'BUG-09-TC-01', result: 'PASS', evidence: ['evidence/tc-01.png'] }] });
  mkdirSync(join(root, 'M1', 'answers', 'BUG-09', 'evidence'), { recursive: true });
  writeFileSync(join(root, 'M1', 'answers', 'BUG-09', 'evidence', 'tc-01.png'), 'png');
  sh('git', ['add', '-A'], root, env);
  sh('git', ['commit', '-q', '-m', 'BUG-09: Fix VND amounts'], root, env);
  const head = sh('git', ['rev-parse', 'HEAD'], root);
  const tw = join(root, '.team-work');
  sh('git', ['worktree', 'add', '-q', '--detach', join(tw, 'wt', 'CR-02'), head], root, env);
  writeFileSync(join(tw, 'wt', 'CR-02', 'M1', 'src', 'export.js'), 'module.exports = () => "csv";\n');
  for (const [key, type] of [['BUG-09', 'BUG'], ['CR-02', 'CR'], ['TASK-03', 'TASK']]) {
    json(join(tw, 'items', key, 'page.json'), { key, type, title: `${key} title`, points: 100, descriptionMd: 'Do the thing.', submission: key === 'BUG-09' ? { scoreStatus: 'GRADED' } : null });
  }
  for (const key of ['BUG-09', 'CR-02']) {
    json(join(tw, 'items', key, 'start.json'), { startInstruction: 'Fill the template.' });
    writeFileSync(join(tw, 'items', key, 'mvs.json'), JSON.stringify(`## ${key}-TC-01\n\nRequired evidence (screenshot): tc-01.png\n`));
    json(join(tw, 'items', key, 'template.json'), { status: 'NOT_STARTED' });
  }
  json(join(tw, 'results', 'BUG-09-fixer-1.json'), { status: 'fixed', summary: 'first try' });
  json(join(tw, 'results', 'BUG-09-fixer-2.json'), { status: 'fixed', summary: 'second try' });
  json(join(tw, 'results', 'BUG-09-reviewer-1.json'), { verdict: 'approve', issues: [] });
  json(join(tw, 'journal.json'), { matchId: 'M1', preparation: { revision: seed }, items: {
    'BUG-09': { startedAt: 'x', attempts: 2, publishedRevision: head, receipt: { id: 'r1' }, lastGate: { jobId: 'job-4', passed: true, failKind: null } },
    'CR-02': { startedAt: 'y', attempts: 1, worktreeBase: head, lastGate: { jobId: 'job-5', passed: false, failKind: 'regression' } } } });
  return root;
}

test('collect builds one bundle per started item and keeps the verdicts apart', () => {
  const root = fakeMatch();
  const out = join(root, 'judge');
  const res = collectMatch(root, out);
  assert.deepEqual(res.items.map(i => [i.key, i.source]), [['BUG-09', 'commits'], ['CR-02', 'worktree']]);
  const bug = p => readFileSync(join(out, 'BUG-09', p), 'utf8');
  assert.match(bug('diff.patch'), /^commit [a-f0-9]{40}\nBUG-09: Fix VND amounts/);
  assert.match(bug('diff.patch'), /\+exports\.vnd = n => n \* 100;/);
  assert.doesNotMatch(bug('diff.patch'), /answers\//, 'answers are judged from answer.json, not from the diff');
  assert.equal(JSON.parse(bug('answer.json')).status, 'DONE');
  assert.equal(JSON.parse(bug('fix-result.json')).summary, 'second try');
  assert.equal(JSON.parse(bug('evidence.json'))[0].file, 'evidence/tc-01.png');
  assert.match(bug('item.md'), /Untrusted organizer text/);
  assert.match(bug('mvs.md'), /Required evidence \(screenshot\): tc-01\.png/);
  assert.match(readFileSync(join(out, 'CR-02', 'diff.patch'), 'utf8'), /\+\+\+ b\/M1\/src\/export\.js\n\+module\.exports/);
  const verdict = JSON.parse(readFileSync(join(out, '_verdicts', 'BUG-09.json'), 'utf8'));
  assert.equal(verdict.gate.passed, true);
  assert.equal(verdict.reviewer.verdict, 'approve');
  assert.equal(verdict.submitted, true);
  assert.doesNotMatch(readFileSync(join(out, 'BUG-09', 'fix-result.json'), 'utf8'), /approve/, 'bundles never carry the verdicts');
});

test('score finds false greens and false reds against the judge', () => {
  const root = fakeMatch();
  const out = join(root, 'judge');
  collectMatch(root, out);
  const crit = (id, severity, verdict) => ({ id, severity, verdict, where: verdict === 'fail' ? 'M1/src/lib.js:1' : null, evidence: 'seen' });
  json(join(out, 'BUG-09', 'judge.json'), { item: 'BUG-09', verdict: 'pass', criteria: [crit('J1', 'H', 'pass'), crit('J8', 'H', 'fail'), crit('J9', 'M', 'unjudgeable')] });
  json(join(out, 'CR-02', 'judge.json'), { item: 'CR-02', verdict: 'pass', criteria: [crit('J1', 'H', 'pass'), crit('J5', 'M', 'fail')] });
  const { rows, totals, report } = scoreMatch(out);
  const bug = rows.find(r => r.key === 'BUG-09');
  assert.equal(bug.gateVsJudge, 'false green');
  assert.equal(bug.reviewerVsJudge, 'false green');
  assert.equal(bug.selfInconsistent, true, 'judge said pass while an H criterion failed');
  assert.equal(rows.find(r => r.key === 'CR-02').gateVsJudge, 'false red', 'a medium failure does not fail the judge');
  assert.deepEqual(totals.gate, { agree: 0, 'false green': 1, 'false red': 1, 'n/a': 0 });
  const text = readFileSync(report, 'utf8');
  assert.match(text, /\*\*BUG-09 J8\*\* \(`M1\/src\/lib\.js:1`\)/);
  assert.match(text, /\*\*1 false green\*\*/);
});

// Transcript Codex giả của một trận: root, fixer, reviewer, guardian của fixer, và một phiên khác không thuộc trận.
function fakeSessions() {
  const root = tempDir('mtm-usage-');
  const tw = join(root, 'TW');
  const checkout = join(tw, 'matches', 'M2');
  const sessions = join(root, 'sessions');
  const day = join(sessions, '2026', '10', '26');
  mkdirSync(day, { recursive: true });
  const id = n => `01a00000-0000-7000-8000-00000000000${n}`;
  const [R, F, V, G, O] = [1, 2, 3, 4, 5].map(id);
  const rec = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  const at = s => `2026-10-26T03:${s}Z`;
  const tokens = (s, input, cached, output, used = null) => rec(at(s), 'event_msg', { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 },
      last_token_usage: { input_tokens: input } }, rate_limits: used === null ? null : { primary: { used_percent: used }, plan_type: 'plus' } });
  const user = (s, text) => rec(at(s), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const write = (n, lines) => {
    const file = join(day, `rollout-2026-10-26T10-00-0${n}-${id(n)}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    utimesSync(file, new Date(at('10:00')), new Date(at('10:00')));
  };
  write(1, [rec(at('00:00'), 'session_meta', { id: R, session_id: R, originator: 'mtm_player', cwd: tw, source: 'vscode' }),
    rec(at('00:00'), 'turn_context', { model: 'gpt-6-luna', effort: 'medium' }),
    rec(at('00:01'), 'event_msg', { type: 'task_started' }), user('00:02', 'GAME frame'), tokens('00:05', 1000, 800, 10, 40),
    rec(at('00:06'), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.mcp__team_runtime__job_status({jobId:"j"})' }),
    rec(at('00:07'), 'response_item', { type: 'custom_tool_call_output', call_id: 'c1' }), tokens('00:10', 3000, 2500, 30, 45),
    rec(at('00:11'), 'response_item', { type: 'function_call', name: 'wait_agent', call_id: 'c2' }),
    rec(at('00:19'), 'response_item', { type: 'function_call_output', call_id: 'c2' }), tokens('00:20', 6000, 5000, 40, 60),
    rec(at('10:00'), 'event_msg', { type: 'task_complete', error: { message: 'You’ve hit your usage limit.' } })]);
  write(2, [rec(at('01:00'), 'session_meta', { id: F, session_id: R, parent_thread_id: R, agent_role: 'team_fixer', agent_path: '/root/fix_bug_9' }),
    rec(at('01:00'), 'turn_context', { model: 'gpt-6-luna' }), rec(at('01:00'), 'event_msg', { type: 'task_started' }),
    tokens('01:30', 2000, 1000, 20), rec(at('05:00'), 'event_msg', { type: 'task_complete' })]);
  write(3, [rec(at('06:00'), 'session_meta', { id: V, session_id: R, parent_thread_id: R, agent_role: 'team_reviewer' }),
    rec(at('06:00'), 'turn_context', { model: 'gpt-6-luna' }), user('06:01', 'Item BUG-09 (BUG). Review the diff.'), tokens('06:30', 500, 0, 5)]);
  write(4, [rec(at('02:00'), 'session_meta', { id: G, session_id: R, parent_thread_id: F, thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } }),
    rec(at('02:00'), 'turn_context', { model: 'codex-auto-review' }),
    user('02:01', '>>> APPROVAL REQUEST START\nPlanned action JSON:\n{"server":"team_runtime","tool":"mcp_tool_call","tool_name":"capture_evidence"}\n>>> APPROVAL REQUEST END'),
    tokens('02:05', 700, 600, 3)]);
  write(5, [rec(at('00:00'), 'session_meta', { id: O, session_id: O, originator: 'mtm_player', cwd: join(root, 'elsewhere') }), tokens('00:30', 99999, 0, 9)]);
  json(join(tw, 'team-sdlc-pack', 'logs', 'M2.dashboard.html'), { cli: { provider: 'codex', status: 'STOPPED', sessionId: R } });
  json(join(checkout, '.team-work', 'journal.json'), { matchId: 'M2', items: { 'BUG-09': { startedAt: at('00:30'), endedAt: at('08:00'),
    outcome: 'SUBMITTED', attempts: 1, gateHistory: [{ jobId: 'job-3' }], dispatchMs: 800, metrics: [{ phase: 'prepare', ms: 1000 }, { phase: 'evidence', ms: 2000 }],
    jobs: [{ kind: 'worktree_setup', ms: 30000, state: 'done' }, { kind: 'run_gate', ms: 120000, state: 'done' }] } } });
  return { root, tw, checkout, sessions };
}

test('usage sums tokens and time per role and item from the Codex transcripts of the match', () => {
  const { root, tw, checkout, sessions } = fakeSessions();
  const out = join(root, 'judge');
  const res = usageMatch(checkout, { sessionsDir: sessions, out });
  assert.equal(res.transcripts, 4, 'the other session is left out');
  assert.equal(res.total.input_tokens, 9200);
  assert.equal(res.byRole.root.tokens.input_tokens, 6000);
  assert.equal(res.byRole.guardian.credits, null, 'codex-auto-review has no price');
  assert.deepEqual(res.unpriced, ['codex-auto-review']);
  // root: (1000 × 2,5 + 5000 × 0,25 + 40 × 12,5) / 1M, cộng fixer và reviewer
  assert.ok(Math.abs(res.credits - (0.00425 + 0.003 + 0.0013125)) < 1e-9);
  assert.deepEqual(res.rootTriggers.job_status, { calls: 1, input: 2000 });
  assert.deepEqual(res.rootTriggers.wait_agent, { calls: 1, input: 3000 });
  assert.equal(res.rootTriggers.message.input, 1000);
  const bug = res.items['BUG-09'];
  assert.deepEqual([bug.fixer.input, bug.reviewer.input, bug.guardian.input], [2000, 500, 700]);
  assert.equal(bug.ms, 450000);
  assert.equal(bug.gates, 1);
  assert.equal(bug.jobs.run_gate.ms, 120000);
  assert.equal(bug.phases.prepare.ms, 1000); assert.equal(bug.phases.evidence.ms, 2000); assert.equal(bug.dispatchMs, 800);
  assert.equal(bug.fixer.busyMs, 240000);
  assert.deepEqual(res.guardian.reviewed.team_fixer, { threads: 1, reviews: 1, input: 700 });
  assert.equal(res.guardian.tool.capture_evidence.input, 700);
  assert.deepEqual([res.quota.first, res.quota.max, res.quota.limitErrors], [40, 60, 1]);
  assert.equal(readdirSync(join(out, '_usage', 'transcripts')).length, 4);
  const md = readFileSync(res.report, 'utf8');
  assert.match(md, /\*\*hết hạn mức lúc 03:10:00Z\*\*/);
  assert.match(md, /\| BUG-09 \| SUBMITTED \| 03:00:30Z → 03:08:00Z \| 7m30s \|/);
  assert.match(md, /`capture_evidence`/);
  // Không có dashboard: tìm root theo TeamWorkspace và giờ của trận.
  rmSync(join(tw, 'team-sdlc-pack'), { recursive: true, force: true });
  assert.equal(usageMatch(checkout, { sessionsDir: sessions, out, copy: false }).transcripts, 4);
});

// Bảng từng item qua các trận (items.mjs): ghép usage, judge và tên đề; trận chưa chấm để trống thay vì ghi 0.
test('the item table joins usage, judge and titles across matches and flags what to look at', () => {
  const runs = tempDir('mtm-items-');
  const usage = (id, from, items, threads = []) => json(join(runs, id, '_usage', 'usage.json'),
    { matchId: id, window: { from, to: from + 3_600_000 }, credits: 100, quota: { limitAt: null }, items, threads });
  const item = (outcome, minutes, extra = {}) => ({ outcome, ms: minutes * 60_000, gates: 1, jobs: {}, phases: {}, reviewer: { threads: 1 }, ...extra });
  usage('OLD1', Date.UTC(2026, 9, 30, 1), { 'BUG-01': item('SUBMITTED', 20) });
  usage('NEW1', Date.UTC(2026, 10, 1, 1), {
    'BUG-01': item('SUBMITTED', 12, { phases: { code_test: { n: 1, ms: 60_000 }, evidence: { n: 2, ms: 7 * 60_000 } } }),
    'CR-01': item('CLOSED', 25) },
  [{ id: 't1', role: 'team_fixer', item: 'BUG-01', model: 'gpt-6.1-terra', effort: 'medium', calls: 50, busyMs: 400_000, credits: 9.5 }]);
  json(join(runs, 'NEW1', 'index.json'), { matchId: 'NEW1', collectedAt: 'x', items: [{ key: 'BUG-01', type: 'BUG', points: 100 }, { key: 'CR-01', type: 'CR', points: 140 }] });
  for (const [key, title] of [['BUG-01', 'Sidebar covers content'], ['CR-01', 'Export CSV']]) {
    mkdirSync(join(runs, 'NEW1', key), { recursive: true });
    writeFileSync(join(runs, 'NEW1', key, 'item.md'), `# ${key} (${key.split('-')[0]}, 100 points): ${title}\n\nbody\n`);
  }
  json(join(runs, 'NEW1', 'BUG-01', 'judge.json'), { item: 'BUG-01', criteria: [{ id: 'J1', severity: 'H', verdict: 'fail', evidence: 'wrong total' }], verdict: 'fail' });
  json(join(runs, 'NEW1', '_verdicts', 'BUG-01.json'), { gate: { passed: true }, reviewer: { verdict: 'approve' }, submitted: true });
  const { md, csv, rows } = buildReport(runs);
  const line = id => md.split('\n').find(l => l.startsWith(`| ${id} |`)).split(' | ');
  assert.deepEqual(line('OLD1').slice(4, 7), ['—', '—', '—'], 'a match nobody judged shows no judge numbers');
  assert.deepEqual(line('NEW1').slice(4, 7), ['0/1', '1', '1']);
  const bug = rows.find(r => r.match === 'NEW1' && r.key === 'BUG-01');
  assert.deepEqual(bug.flags, ['judge J1', 'gate false green', 'reviewer false green', 'evidence 7× code']);
  assert.equal(bug.secPerCall, 8);
  assert.deepEqual(rows.find(r => r.match === 'NEW1' && r.key === 'CR-01').flags, ['chưa nộp']);
  assert.match(md, /\| BUG-01 · Sidebar covers content \| NEW1: 12m00s ✗ \|/);
  assert.ok(csv.startsWith('match,key,type,points,title,outcome,judge'));
  assert.equal(csv.split('\n').length, 4, 'header and one row per item');
});

// Benchmark theo bộ đề (bench.mjs): trận cùng bộ item gom một nhóm dù dừng sớm, trận mới so với trận liền trước; mốc
// thời gian/credit tốt nhất chỉ lấy từ trận nộp ít nhất bằng trận mới, credit trống khi có model ngoài price card.
test('the bench groups matches by item set and compares the newest with the previous one', () => {
  const runs = tempDir('mtm-bench-');
  const big = ['BUG-01', 'BUG-02', 'BUG-03', 'CR-01', 'PI-01'], small = ['BUG-01', 'TASK-01', 'TASK-02'];
  const match = (id, day, keys, done, credits, unpriced = ['codex-auto-review']) => {
    const from = Date.UTC(2026, 10, day, 1);
    const items = Object.fromEntries(keys.map((k, i) => [k, i < done
      ? { outcome: 'SUBMITTED', ms: (10 + i) * 60_000, endedAt: new Date(from + (20 + i) * 60_000).toISOString(), phases: {}, jobs: {} }
      : { outcome: 'NOT_STARTED', phases: {}, jobs: {} }]));
    json(join(runs, id, '_usage', 'usage.json'), { matchId: id, window: { from, to: from + 40 * 60_000 }, credits, unpriced,
      total: { input_tokens: 1e7 }, byRole: { root: { tokens: { input_tokens: 4e6 } } }, quota: {}, items, threads: [] });
  };
  match('S1', 1, small, 3, 50);
  match('B1', 2, big, 2, 10);                                  // dừng sớm: rẻ nhưng không so được
  match('B2', 3, big.slice(0, 4), 3, 90, ['gpt-x', 'codex-auto-review']);   // thiếu PI-01 vẫn cùng bộ; credit không tin được
  match('B3', 4, big, 5, 80);
  // Chung 4/6 mã với bộ 5 item nhưng có item bộ đó không có: bộ khác (QDO8W480 bị gộp nhầm với bộ 12 item theo Jaccard).
  match('C1', 5, [...big.slice(0, 4), 'CR-05', 'PI-04'], 6, 70);
  const { groups, pairs, md } = buildBench(runs);
  assert.deepEqual(groups.map(g => [g.name, g.matches.map(m => m.id)]),
    [['Bộ 6 item', ['C1']], ['Bộ 5 item', ['B1', 'B2', 'B3']], ['Bộ 3 item', ['S1']]]);
  const p = pairs.find(x => x.cur === 'B3');
  assert.equal(p.prev, 'B2');
  const row = label => p.metricRows.find(r => r[0] === label);
  assert.deepEqual(row('Item nộp').slice(1, 4), ['5/5', '3/5', '+2 (+67%) ✓']);
  assert.deepEqual(row('Credit').slice(1, 5), ['80', '—', '—', '—'], 'B2 has an unpriced model, B1 submitted fewer items');
  assert.equal(row('Nộp xong item cuối (từ đầu trận)')[1], '24m00s');
  const pi = p.itemRows.find(r => r[0] === 'PI-01');
  assert.deepEqual([pi[2], pi[5]], ['· → nộp', 'mới nộp ✓']);
  assert.match(md, /## Bộ 5 item: B3 so với B2/);
  assert.match(md, /\*\*Trận mới chưa chấm judge\*\*/);
  assert.equal(buildBench(runs, { match: 'B2', vs: 'B1' }).pairs[0].prev, 'B1');
});

// Bench đo từ lúc đề ra: giờ server của bản đầu trừ độ lệch đồng hồ, ước lượng từ các item poller thấy (BTZNI69E: đợt
// đầu ra 04:08:08 giờ server, helper 04:08:49 mới thấy vì root đang khởi động; server nhanh hơn máy khoảng 2,7 s).
test('release times come from the server clock, corrected by the skew the poller saw', () => {
  const teamWork = join(tempDir('mtm-release-'), '.team-work');
  const page = (key, raw) => { mkdirSync(join(teamWork, 'items', key), { recursive: true }); writeFileSync(join(teamWork, 'items', key, 'page.json'), JSON.stringify(raw)); };
  page('BUG-01', { revisionNo: 1, revealedElapsedSec: 0, updatedAt: '2026-11-04T04:08:08.298Z' });
  page('BUG-03', { revisionNo: 1, revealedElapsedSec: 481, updatedAt: '2026-11-04T04:16:09.678Z' });
  page('CR-01', { revisionNo: 2, revealedElapsedSec: 481, updatedAt: '2026-11-04T04:30:00.000Z' });
  const journal = { items: {
    'BUG-01': { discoveredAt: '2026-11-04T04:08:49.984Z' },
    'BUG-03': { discoveredAt: '2026-11-04T04:16:07.010Z' },
    'CR-01': { discoveredAt: '2026-11-04T04:16:07.016Z' },
    'TASK-04': { discoveredAt: '2026-11-04T04:28:07.626Z', releasedAtServer: '2026-11-04T04:28:09.176Z', revealedElapsedSec: 1200 } } };
  const r = releaseTimes(teamWork, journal);
  assert.equal(r.skewMs, 2668, 'BUG-03: 04:16:09.678 server, seen 04:16:07.010');
  assert.equal(r.items['BUG-01'], '2026-11-04T04:08:05.630Z');
  // Bản sửa đổi đổi updatedAt: lấy giờ bắt đầu trận (04:08:08.298) + revealedElapsedSec 481 s − độ lệch.
  assert.equal(r.items['CR-01'], '2026-11-04T04:16:06.630Z');
  assert.equal(r.items['TASK-04'], '2026-11-04T04:28:06.508Z');
});
