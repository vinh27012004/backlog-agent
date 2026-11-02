#!/usr/bin/env node
// Token và thời gian của một trận luyện tập, đọc sau trận (không chạy trong trận nên không đụng hợp đồng Player).
// Player chỉ ghi token của root (dashboard). Token của fixer, reviewer, PI và guardian nằm trong transcript Codex
// (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl): mỗi thread một file, cùng session_id với root, có agent_role,
// agent_path (gắn item), timestamp, token cộng dồn và % hạn mức. Guardian có parent_thread_id là agent được review,
// và tool_name của hành động nằm trong yêu cầu review. Thời gian item và job lấy từ journal của helper.
// Kết quả ở <bundle>/_usage/ (usage.md, usage.json, transcripts/); judge không đọc thư mục này trước khi chấm.
// Chạy: node tools/judge/usage.mjs <checkoutRoot> [--sessions <dir>] [--session <rootThreadId>] [--out <bundle>] [--no-copy]
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexStandardPriceCard } from '../../vendor/mtm-player-0.9.44/app/src/codex-price-card.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COUNTERS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const ROLES = ['root', 'team_fixer', 'team_reviewer', 'team_pi_hypothesis', 'guardian'];
const DAY = 86_400_000;

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const zero = () => Object.fromEntries(COUNTERS.map(k => [k, 0]));
const addTokens = (a, b) => { for (const k of COUNTERS) a[k] += b[k] ?? 0; return a; };

// Dòng đầu (session_meta); base_instructions có thể dài nên đọc dần tới ký tự xuống dòng.
function firstLine(file, cap = 8 << 20) {
  const fd = openSync(file, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(1 << 16);
    for (let pos = 0; pos < cap;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      if (nl >= 0) break;
      pos += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { closeSync(fd); }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
  }
  return out;
}

// Chỉ quét các ngày quanh trận (thư mục YYYY/MM/DD theo giờ máy, nên lấy thêm một ngày mỗi bên); không biết ngày thì quét hết.
function transcriptFiles(sessionsDir, times) {
  const days = new Set();
  for (const t of times) for (const d of [-DAY, 0, DAY]) {
    const x = new Date(t + d);
    days.add(join(sessionsDir, String(x.getUTCFullYear()), String(x.getUTCMonth() + 1).padStart(2, '0'), String(x.getUTCDate()).padStart(2, '0')));
  }
  const dirs = [...days].filter(existsSync);
  return dirs.length ? dirs.flatMap(d => walk(d)) : walk(sessionsDir);
}

// Mọi id thread trong dashboard của Player (root ở cli.sessionId, subagent ở các task đã đăng ký).
export function dashboardThreadIds(file) {
  if (!existsSync(file)) return [];
  return [...new Set([...readFileSync(file, 'utf8').matchAll(/"sessionId":"([0-9a-f-]{36})"/g)].map(m => m[1]))];
}

// "fix_bug_02", "Item BUG-02 (BUG)" → khoá item của trận (so số, không so số 0 đứng đầu).
export function itemOf(text, keys = []) {
  for (const m of String(text ?? '').matchAll(/(?<![a-z])(bug|cr|task|pi)[-_ ]?(\d+)/gi)) {
    const type = m[1].toUpperCase();
    const hit = keys.find(k => k.split('-')[0] === type && Number(k.split('-')[1]) === Number(m[2]));
    if (hit || !keys.length) return hit ?? `${type}-${m[2]}`;
  }
  return null;
}

const shortTool = name => (name === 'exec_command' ? 'shell' : String(name).replace(/^mcp__.+?__/, ''));

// Root gọi helper qua code mode: một lời gọi `exec` chứa nhiều tools.X(...); nhãn là tập tool bên trong.
function toolLabel(p) {
  if (p.name !== 'exec') return shortTool(p.name);
  const inner = [...new Set([...String(p.input ?? p.arguments ?? '').matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g)].map(m => shortTool(m[1])))];
  return inner.length ? (inner.length > 3 ? `${inner.slice(0, 3).join('+')}+…` : inner.join('+')) : 'exec';
}

const contentText = content => (Array.isArray(content) ? content.map(c => c?.text ?? '').join('') : String(content ?? ''));

// Hành động guardian đang review: JSON sau "Planned action JSON:" (MCP có tool_name, còn lại là tool).
export function reviewedTool(text) {
  const a = text.indexOf('Planned action JSON:');
  if (a < 0) return null;
  const b = text.indexOf('>>> APPROVAL REQUEST END', a);
  const body = text.slice(a + 'Planned action JSON:'.length, b < 0 ? undefined : b);
  try { const j = JSON.parse(body); return shortTool(j.tool_name ?? j.tool ?? 'unknown'); } catch { /* bị cắt: dùng regex */ }
  const m = body.match(/"tool_name":\s*"([^"]+)"/) ?? body.match(/"tool":\s*"([^"]+)"/);
  return m ? shortTool(m[1]) : 'unknown';
}

const roleOf = m => m.agent_role ?? (m.thread_source === 'guardian_review' || m.source?.subagent?.other === 'guardian' ? 'guardian'
  : m.id === m.session_id ? 'root' : String(m.thread_source ?? 'other'));

export function parseTranscript(file, keys = []) {
  const t = { file, id: null, sessionId: null, parent: null, role: null, agentPath: null, item: null, model: null, effort: null, serviceTier: null,
    start: null, end: null, busyMs: 0, tokens: zero(), calls: 0, maxContext: 0, quota: { first: null, last: null, plan: null },
    limitErrors: 0, limitAt: null, triggers: {}, warnings: 0 };
  // Thread không có khoá item trong agent_path (NBDB5U0O: /root/pi_worker, /root/review01): lấy item được nhắc nhiều
  // nhất trong lời gọi tool và tin nhắn giao việc (backlogItemKey, results/<ID>-…, items/<ID>/, answers/<ID>/).
  const votes = new Map();
  const vote = text => {
    for (const m of String(text ?? '').matchAll(/backlogItemKey\\?["']?\s*:\s*\\?["']([A-Za-z]+-\d+)|(?:results|items|answers|wt)[\\/]+([A-Za-z]+-\d+)/g)) {
      const key = itemOf(m[1] ?? m[2], keys);
      if (key) votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  };
  const bump = label => (t.triggers[label] ??= { calls: 0, input: 0 });
  const callLabel = new Map();
  let totals = null;
  let trigger = null;
  let turnStart = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { t.warnings++; continue; }
    const p = r.payload ?? {};
    const ts = Date.parse(r.timestamp ?? p.timestamp);
    if (Number.isFinite(ts)) { t.start ??= ts; t.end = ts; }
    if (r.type === 'session_meta') {
      // Thread fork (spawn_agent không có fork_turns "none") chép cả session_meta của root vào sau: chỉ lấy dòng đầu.
      if (t.id) continue;
      Object.assign(t, { id: p.id, sessionId: p.session_id, parent: p.parent_thread_id ?? null, role: roleOf(p), agentPath: p.agent_path ?? null });
      t.item = itemOf(p.agent_path, keys);
    } else if (r.type === 'turn_context') {
      t.model = p.model ?? t.model;
      t.effort ??= p.effort ?? null;
    } else if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const label = toolLabel(p);
        callLabel.set(p.call_id, label);
        if (t.role !== 'root' && t.role !== 'guardian') vote(p.arguments ?? p.input);
        bump(label).calls++;
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        trigger = callLabel.get(p.call_id) ?? 'tool';
      } else if (p.type === 'message' && p.role === 'user') {
        const text = contentText(p.content);
        if (t.role === 'guardian') {
          const tool = reviewedTool(text);
          if (tool) { trigger = tool; bump(tool).calls++; }
        } else {
          trigger = 'message';
          if (!t.item && t.role !== 'root') t.item = itemOf(text.match(/\bItem\s+([A-Za-z]+-\d+)/)?.[1], keys);
          if (t.role !== 'root') vote(text);
        }
      }
    } else if (r.type === 'event_msg') {
      if (p.type === 'thread_settings_applied') t.serviceTier = p.thread_settings?.service_tier ?? t.serviceTier;
      else if (p.type === 'task_started') turnStart = ts;
      else if (['task_complete', 'turn_aborted', 'task_aborted'].includes(p.type)) {
        if (turnStart !== null && Number.isFinite(ts)) t.busyMs += ts - turnStart;
        turnStart = null;
        if (/usage limit/i.test(p.error?.message ?? '')) { t.limitErrors++; t.limitAt ??= r.timestamp; }
      } else if (p.type === 'token_count') {
        const q = p.rate_limits?.primary?.used_percent;
        if (typeof q === 'number') { t.quota.first ??= q; t.quota.last = q; }
        t.quota.plan ??= p.rate_limits?.plan_type ?? null;
        const next = p.info?.total_token_usage;
        if (!next) continue;
        const delta = Object.fromEntries(COUNTERS.map(k => [k, (next[k] ?? 0) - (totals?.[k] ?? 0)]));
        totals = Object.fromEntries(COUNTERS.map(k => [k, next[k] ?? 0]));
        if (COUNTERS.some(k => delta[k] < 0)) { t.warnings++; continue; }       // bộ đếm bị đặt lại: lấy mốc mới
        if (delta.input_tokens <= 0 && delta.output_tokens <= 0) continue;    // chỉ cập nhật hạn mức
        addTokens(t.tokens, delta);
        t.calls++;
        t.maxContext = Math.max(t.maxContext, p.info?.last_token_usage?.input_tokens ?? 0);
        bump(trigger ?? '(khác)').input += delta.input_tokens;
        trigger = null;
      }
    }
  }
  if (turnStart !== null && t.end !== null) t.busyMs += t.end - turnStart;   // lượt còn chạy khi transcript dừng
  if (!t.item && votes.size) t.item = [...votes].sort((a, b) => b[1] - a[1])[0][0];
  return t;
}

// Credit danh nghĩa theo price card của Player (cùng công thức với nominalCredit trên dashboard). Từ 0.9.39 price card
// có hệ số theo service tier (Fast = `priority` ×2); tier lạ thì không tính, như dashboard (TIER_RATE_UNAVAILABLE).
export function credits(tokens, model, serviceTier = 'default') {
  const rate = codexStandardPriceCard.models[model];
  const multiplier = (codexStandardPriceCard.serviceTierMultipliers ?? { default: 1 })[serviceTier ?? 'default'];
  if (!rate || !multiplier) return null;
  const cached = tokens.cached_input_tokens;
  return ((tokens.input_tokens - cached) * rate.input + cached * rate.cachedInput + tokens.output_tokens * rate.output) * multiplier
    / codexStandardPriceCard.unitTokens;
}

// ------------------------------------------------------------------ định dạng (dấu phẩy thập phân như practice-log)
const dec = (n, d = 1) => n.toFixed(d).replace('.', ',');
const tok = n => (n >= 1e6 ? `${dec(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const pct = (a, b) => (b ? `${dec((100 * a) / b)}%` : '—');
const dur = ms => { if (ms === null || ms === undefined) return '—'; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
const hhmm = t => (Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 19)}Z` : '—');
const cr = n => (n === null ? '—' : dec(n, 2));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

function selectTranscripts({ files, ids, teamWorkspace, window }) {
  const metas = [];
  for (const file of files) {
    let m;
    try { m = JSON.parse(firstLine(file)); } catch { continue; }
    if (m?.type === 'session_meta' && m.payload?.id) metas.push({ file, meta: m.payload, at: Date.parse(m.payload.timestamp ?? m.timestamp) });
  }
  let roots = new Set(ids);
  if (!roots.size) {
    // Không có dashboard và --session: root là phiên Player mở ở TeamWorkspace, chạy trong lúc trận có item.
    const same = (a, b) => resolve(String(a ?? '')).toLowerCase() === resolve(b).toLowerCase();
    roots = new Set(metas.filter(({ file, meta, at }) => meta.id === meta.session_id && meta.originator === 'mtm_player' &&
      same(meta.cwd, teamWorkspace) && window && at <= window.to && statSync(file).mtimeMs >= window.from)
      .map(({ meta }) => meta.id));
  }
  return metas.filter(({ meta }) => roots.has(meta.id) || roots.has(meta.session_id)).map(({ file }) => file);
}

export function usageMatch(checkoutRoot, { sessionsDir = null, rootId = null, out = null, copy = true } = {}) {
  const teamWork = join(checkoutRoot, '.team-work');
  const journal = readJson(join(teamWork, 'journal.json'));
  if (!journal) throw new Error(`không có .team-work/journal.json trong ${checkoutRoot}`);
  const matchId = journal.matchId ?? basename(checkoutRoot);
  const teamWorkspace = resolve(checkoutRoot, '..', '..');
  const keys = [...new Set([...Object.keys(journal.items ?? {}),
    ...(existsSync(join(teamWork, 'items')) ? readdirSync(join(teamWork, 'items')) : [])])].sort();
  const times = Object.values(journal.items ?? {}).flatMap(ji => [ji.startedAt, ji.endedAt, ji.receipt?.receivedAt])
    .map(t => Date.parse(t)).filter(Number.isFinite);
  const window = times.length ? { from: Math.min(...times) - 3_600_000, to: Math.max(...times) + 3_600_000 } : null;
  const dir = sessionsDir ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const ids = rootId ? [rootId] : dashboardThreadIds(join(teamWorkspace, 'team-sdlc-pack', 'logs', `${matchId}.dashboard.html`));
  const files = selectTranscripts({ files: transcriptFiles(dir, times), ids, teamWorkspace, window });
  if (!files.length) throw new Error(`không tìm thấy transcript Codex của trận trong ${dir} (thử --sessions hoặc --session)`);

  const threads = files.map(f => parseTranscript(f, keys)).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const byId = new Map(threads.map(t => [t.id, t]));
  for (const t of threads) {
    t.credits = credits(t.tokens, t.model, t.serviceTier);
    if (t.role !== 'guardian') continue;
    const parent = byId.get(t.parent);
    t.reviewedRole = parent?.role ?? 'unknown';
    t.item = parent?.item ?? null;
  }

  const total = threads.reduce((a, t) => addTokens(a, t.tokens), zero());
  const totalCredits = threads.reduce((a, t) => (t.credits === null ? a : a + t.credits), 0);
  const unpriced = [...new Set(threads.filter(t => t.credits === null && t.calls).map(t => t.model ?? '?'))];
  const byRole = {};
  for (const t of threads) {
    const r = (byRole[t.role] ??= { threads: 0, calls: 0, tokens: zero(), credits: null, busyMs: 0 });
    r.threads++; r.calls += t.calls; addTokens(r.tokens, t.tokens); r.busyMs += t.busyMs;
    if (t.credits !== null) r.credits = (r.credits ?? 0) + t.credits;
  }
  // Journal cũ (trước 27/10) chưa có gateHistory: đếm job gate từ tên log <ID>-gate-job-<n>-run_gate-<check>.log.
  const logs = existsSync(join(teamWork, 'logs')) ? readdirSync(join(teamWork, 'logs')) : [];
  const gateJobs = key => new Set(logs.filter(f => f.startsWith(`${key}-gate-`)).map(f => f.match(/-(job-\d+)-/)?.[1]).filter(Boolean)).size;

  const items = {};
  for (const key of [...new Set([...keys, ...threads.map(t => t.item).filter(Boolean)])].sort()) {
    const ji = journal.items?.[key] ?? {};
    const own = threads.filter(t => t.item === key);
    if (!ji.startedAt && !own.length) continue;
    const role = name => {
      const list = own.filter(t => t.role === name);
      return { threads: list.length, calls: list.reduce((a, t) => a + t.calls, 0), input: list.reduce((a, t) => a + t.tokens.input_tokens, 0),
        output: list.reduce((a, t) => a + t.tokens.output_tokens, 0), busyMs: list.reduce((a, t) => a + t.busyMs, 0) };
    };
    const jobs = {};
    for (const j of ji.jobs ?? []) { const x = (jobs[j.kind] ??= { n: 0, ms: 0 }); x.n++; x.ms += j.ms ?? 0; }
    const phases = {};
    for (const m of ji.metrics ?? []) { const x = (phases[m.phase] ??= { n: 0, ms: 0 }); x.n++; x.ms += m.ms ?? 0; }
    const start = Date.parse(ji.startedAt);
    const end = Date.parse(ji.endedAt ?? ji.receipt?.receivedAt);
    items[key] = { outcome: ji.outcome ?? (ji.receipt ? 'SUBMITTED' : ji.startedAt ? 'NOT_SUBMITTED' : 'NOT_STARTED'),
      startedAt: ji.startedAt ?? null, endedAt: ji.endedAt ?? ji.receipt?.receivedAt ?? null,
      ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : null, attempts: ji.attempts ?? 0,
      gates: ji.gateHistory?.length ?? gateJobs(key), jobs, phases, dispatchMs: ji.dispatchMs ?? null, fixer: role('team_fixer'), reviewer: role('team_reviewer'),
      pi: role('team_pi_hypothesis'), guardian: role('guardian') };
  }

  const rootThreads = threads.filter(t => t.role === 'root');
  const rootInput = rootThreads.reduce((a, t) => a + t.tokens.input_tokens, 0);
  const rootTriggers = {};
  for (const t of rootThreads) for (const [k, v] of Object.entries(t.triggers)) {
    const x = (rootTriggers[k] ??= { calls: 0, input: 0 }); x.calls += v.calls; x.input += v.input;
  }
  const guardianBy = { reviewed: {}, tool: {} };
  for (const t of threads.filter(x => x.role === 'guardian')) {
    const g = (guardianBy.reviewed[t.reviewedRole] ??= { threads: 0, reviews: 0, input: 0 });
    g.threads++; g.input += t.tokens.input_tokens;
    for (const [k, v] of Object.entries(t.triggers)) {
      g.reviews += v.calls;
      const x = (guardianBy.tool[k] ??= { reviews: 0, input: 0 }); x.reviews += v.calls; x.input += v.input;
    }
  }
  const ordered = threads.filter(t => t.quota.first !== null);
  const quota = { plan: threads.find(t => t.quota.plan)?.quota.plan ?? null, first: ordered[0]?.quota.first ?? null,
    max: ordered.length ? Math.max(...ordered.map(t => t.quota.last)) : null };
  const limitAt = threads.map(t => t.limitAt).filter(Boolean).sort()[0] ?? null;
  const limitErrors = threads.reduce((a, t) => a + t.limitErrors, 0);
  const from = Math.min(...threads.map(t => t.start ?? Infinity));
  const to = Math.max(...threads.map(t => t.end ?? 0));

  const target = join(out ?? join(REPO, 'runs', 'judge', matchId), '_usage');
  mkdirSync(target, { recursive: true });
  if (copy) {
    mkdirSync(join(target, 'transcripts'), { recursive: true });
    for (const t of threads) copyFileSync(t.file, join(target, 'transcripts', basename(t.file)));
  }

  const roleRows = [...ROLES, ...Object.keys(byRole).filter(r => !ROLES.includes(r))].filter(r => byRole[r]).map(r => {
    const x = byRole[r];
    return [r, x.threads, x.calls, tok(x.tokens.input_tokens), pct(x.tokens.input_tokens, total.input_tokens),
      pct(x.tokens.cached_input_tokens, x.tokens.input_tokens), tok(x.tokens.output_tokens), cr(x.credits), dur(x.busyMs)];
  });
  const side = x => (x.threads ? `${x.threads} · ${x.calls} lượt · ${tok(x.input)} · ${dur(x.busyMs)}` : '—');
  const itemRows = Object.entries(items).map(([k, x]) => [k, x.outcome, `${hhmm(Date.parse(x.startedAt))} → ${hhmm(Date.parse(x.endedAt))}`,
    dur(x.ms), side(x.fixer), side(x.reviewer), x.pi.threads ? side(x.pi) : '—',
    x.guardian.threads ? `${tok(x.guardian.input)}` : '—',
    `${x.gates}${x.jobs.run_gate ? ` · ${dur(x.jobs.run_gate.ms)}` : ''}`, x.jobs.worktree_setup ? dur(x.jobs.worktree_setup.ms) : '—']);
  const triggerRows = Object.entries(rootTriggers).sort((a, b) => b[1].input - a[1].input).slice(0, 15)
    .map(([k, v]) => [`\`${k}\``, v.calls || '—', tok(v.input), pct(v.input, rootInput)]);
  const threadRows = threads.map(t => [t.id?.slice(-8) ?? '?', t.role, t.agentPath ?? (t.role === 'guardian' ? `review ${t.reviewedRole}` : '—'),
    t.item ?? '—', `${t.model ?? '?'}${t.effort ? ` (${t.effort})` : ''}`, hhmm(t.start), dur(t.busyMs), t.calls,
    tok(t.tokens.input_tokens), tok(t.tokens.output_tokens), tok(t.maxContext)]);
  const md = [
    `# Token và thời gian: ${matchId}`, '',
    `${rootThreads.length} phiên root, ${threads.length} transcript, ${hhmm(from)} → ${hhmm(to)} (${dur(to - from)}).`,
    `Tổng: **${tok(total.input_tokens)} input** (${pct(total.cached_input_tokens, total.input_tokens)} cache), ` +
      `${tok(total.output_tokens)} output (reasoning ${tok(total.reasoning_output_tokens)}), ≈ ${cr(totalCredits)} credit ` +
      `theo price card \`${codexStandardPriceCard.id}\`${unpriced.length ? ` (không tính model ngoài price card: ${unpriced.join(', ')})` : ''}.`,
    `Hạn mức Codex${quota.plan ? ` (gói ${quota.plan})` : ''}: ${quota.first ?? '?'}% → ${quota.max ?? '?'}%` +
      (limitAt ? `; **hết hạn mức lúc ${limitAt.slice(11, 19)}Z** (${limitErrors} lượt lỗi).` : '.'),
    '', '## Theo vai trò', '',
    table(['Vai trò', 'Thread', 'Lượt gọi model', 'Input', '% tổng', 'Cache', 'Output', 'Credit', 'Thời gian chạy'], roleRows),
    '', '## Theo item', '',
    'Ô fixer/reviewer/PI: số thread · lượt gọi model · input · thời gian chạy. Gate: số lần · tổng thời gian (journal cũ chưa có thời gian job).', '',
    table(['Item', 'Kết quả', 'Bắt đầu → kết thúc', 'Thời gian', 'Fixer', 'Reviewer', 'PI', 'Guardian', 'Gate', 'Chuẩn bị worktree'], itemRows),
    '', '## Thời gian theo giai đoạn', '',
    'Dispatch từ lúc helper quan sát item tới Start Work. Code/test và evidence đo theo checkpoint; các hoạt động song song không cộng thành thời gian toàn trận.', '',
    table(['Item', 'Dispatch', 'Chuẩn bị', 'Code/test', 'Evidence', 'Bàn giao', 'Publish'], Object.entries(items).map(([key, x]) =>
      [key, dur(x.dispatchMs), ...['prepare', 'code_test', 'evidence', 'handoff', 'publish'].map(p => x.phases[p] ? dur(x.phases[p].ms) : '—')])),
    '', '## Root: lượt gọi model đến sau việc gì', '',
    `Context lớn nhất của root: ${tok(Math.max(0, ...rootThreads.map(t => t.maxContext)))}. Mỗi lượt gọi model được tính cho tool vừa trả kết quả ` +
      '(`message` = tin nhắn của Player hoặc agent khác); `exec` được tách theo tool bên trong.', '',
    table(['Sau', 'Số lần gọi tool', 'Input của lượt kế tiếp', '% input root'], triggerRows),
    '', '## Guardian', '',
    table(['Agent được review', 'Thread', 'Lượt review', 'Input'], Object.entries(guardianBy.reviewed).sort((a, b) => b[1].input - a[1].input)
      .map(([k, v]) => [k, v.threads, v.reviews, tok(v.input)])), '',
    table(['Tool được review', 'Lượt review', 'Input'], Object.entries(guardianBy.tool).sort((a, b) => b[1].input - a[1].input).slice(0, 15)
      .map(([k, v]) => [`\`${k}\``, v.reviews, tok(v.input)])),
    '', '## Thread', '',
    table(['Thread', 'Vai trò', 'Agent', 'Item', 'Model', 'Bắt đầu', 'Thời gian chạy', 'Lượt', 'Input', 'Output', 'Context max'], threadRows), ''
  ].join('\n');
  const report = join(target, 'usage.md');
  writeFileSync(report, md);
  const summary = { matchId, sessionsDir: dir, roots: rootThreads.map(t => t.id), transcripts: threads.length, window: { from, to },
    total, credits: totalCredits, unpriced, quota: { ...quota, limitAt, limitErrors }, byRole, items, rootTriggers, guardian: guardianBy,
    threads: threads.map(({ file, triggers, ...t }) => ({ ...t, file: basename(file) })) };
  writeFileSync(join(target, 'usage.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { out: target, report, ...summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const sessionsDir = opt('--sessions');
  const rootId = opt('--session');
  const out = opt('--out');
  const copy = !args.includes('--no-copy');
  const [checkoutRoot] = args.filter(a => a !== '--no-copy');
  if (!checkoutRoot) {
    console.error('dùng: node tools/judge/usage.mjs <checkoutRoot của trận> [--sessions <dir>] [--session <rootThreadId>] [--out <bundle>] [--no-copy]');
    process.exit(2);
  }
  const res = usageMatch(resolve(checkoutRoot), { sessionsDir: sessionsDir && resolve(sessionsDir), rootId, out: out && resolve(out), copy });
  console.log(`${res.transcripts} transcript, ${tok(res.total.input_tokens)} input, ${tok(res.total.output_tokens)} output → ${res.report}`);
  for (const [role, x] of Object.entries(res.byRole)) console.log(`  ${role}: ${tok(x.tokens.input_tokens)} (${pct(x.tokens.input_tokens, res.total.input_tokens)})`);
}
