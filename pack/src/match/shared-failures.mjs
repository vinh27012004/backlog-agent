// Lỗi chung phát hiện trong GAME: báo cáo chưa phải kết luận baseline; root phân loại và giao một chủ.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { digest } from '../core/candidates.mjs';
import { fail } from '../core/util.mjs';
import { readChecks } from '../env/checks.mjs';

const terminal = new Set(['landed', 'resolved', 'deferred', 'abandoned', 'failed']);
const text = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_ARGUMENT', `${name} needs 1-${max} characters`);
  return value.trim();
};
const state = issue => issue.baselineFix?.state ?? issue.state;

export class SharedFailures {
  constructor(workflow) { this.workflow = workflow; this.rt = workflow.rt; }
  records() { return Object.values(this.rt.journal.data.sharedFailures ?? {}); }
  get(id) {
    const issue = this.records().find(i => i.id === id);
    if (!issue) fail('SHARED_FAILURE_UNKNOWN', 'no shared failure with that id');
    return issue;
  }
  eligible(key) {
    const ji = this.rt.journal.data.items[key];
    return Boolean(ji?.startedAt && !ji.endedAt && !ji.receipt && !this.rt.answerOnlyItem(key));
  }
  affects(issue, key) { return this.eligible(key) && (!issue.affectedItems || issue.affectedItems.includes(key)); }
  ownerAvailable(key) {
    const ji = this.rt.journal.data.items[key];
    const until = Date.parse(ji?.prepared?.timeBox?.returnBy ?? '');
    return this.eligible(key) && !(until <= Date.now()) && Boolean(ji.workerThread) && this.rt.liveWorktree(key);
  }
  evidence(key, files) {
    if (!Array.isArray(files) || !files.length || files.length > 10) fail('INVALID_ARGUMENT', 'give 1-10 evidence paths');
    const base = join(this.rt.wtPaths(key).matchRoot, 'answers', key);
    return [...new Set(files)].map(raw => {
      const path = text(raw, 'evidence path', 300).replaceAll('\\', '/');
      if (isAbsolute(path) || !path.startsWith('evidence/') || path.split('/').some(p => !p || p === '..' || p === '.')) fail('PATH_NOT_ALLOWED', 'evidence must be relative to this item answer directory');
      const file = resolve(base, path), allowed = join(base, 'evidence');
      if (!existsSync(file) || !statSync(file).isFile()) fail('INVALID_ARGUMENT', `missing ${path}`);
      const outside = relative(realpathSync(allowed), realpathSync(file));
      if (outside.startsWith('..') || isAbsolute(outside)) fail('PATH_NOT_ALLOWED', 'evidence must stay inside this item evidence directory');
      return { path, sha256: digest(readFileSync(file)) };
    });
  }
  report({ backlogItemKey: key, failure }) {
    const ji = this.workflow.item(key);
    if (!this.eligible(key) || !this.rt.liveWorktree(key)) fail('INVALID_ARGUMENT', 'only an active code item with suite checks can report a shared failure');
    const summary = text(failure?.summary, 'failure.summary');
    if (!Array.isArray(failure?.failingTests) || !failure.failingTests.length || failure.failingTests.length > 40) fail('INVALID_ARGUMENT', 'give 1-40 failing test ids or failing command names');
    const failing = [...new Set(failure.failingTests.map(t => text(t, 'failing test', 500).replaceAll('\\', '/'))) ].sort();
    const evidence = this.evidence(key, failure.evidence);
    const at = new Date().toISOString();
    // Chỉ gộp cùng nhóm test. Khác nhóm cần root chẩn đoán, không đoán chung nguyên nhân từ tên gần giống.
    const signature = digest(failing);
    let issue = this.records().find(i => i.signature === signature && !terminal.has(state(i)));
    const duplicate = Boolean(issue);
    if (!issue) {
      const records = this.rt.journal.data.sharedFailures ??= {};
      const id = `shared-${Object.keys(records).length + 1}`;
      issue = records[id] = { id, signature, summary, failing, reports: [], state: 'reported', at };
    }
    const report = { key, summary, evidence, at };
    issue.reports = [...issue.reports.filter(r => r.key !== key), report];
    if (issue.affectedItems && !issue.affectedItems.includes(key)) issue.affectedItems.push(key);
    this.rt.journal.save();
    this.rt.events.push('SHARED_FAILURE_REPORTED', { key, failureId: issue.id, duplicate });
    return { key, phase: 'shared_failure', failureId: issue.id, duplicate, state: state(issue), owner: issue.baselineOwner ?? null,
      writesAllowed: ji.workerState === 'writing', hint: 'Root will classify this report and assign one owner. Continue your own work; do not repair a suspected shared failure without that assignment. Report real failed requirements as failed or partial.' };
  }
  manage({ action, failureId, owner, kind, reason, evidence, affectedItems }) {
    this.rt.session.require('GAME');
    if (action === 'status') return { failures: this.records().map(i => ({ ...i, state: state(i) })) };
    const issue = this.get(failureId), at = new Date().toISOString();
    const explanation = text(reason, 'reason');
    if (action === 'assign') {
      if (!['product', 'environment'].includes(kind)) fail('INVALID_ARGUMENT', 'classify as product or environment after inspecting the reproduction evidence');
      if (state(issue) === 'assigned' && issue.baselineOwner === owner && issue.kind === kind && this.ownerAvailable(owner)) return this.assignment(issue);
      if (!['reported', 'deferred', 'abandoned', 'failed'].includes(state(issue)) && !(state(issue) === 'assigned' && !this.ownerAvailable(issue.baselineOwner))) fail('SHARED_FAILURE_BUSY', 'this failure already has an active owner or a completed fix');
      if (!this.ownerAvailable(owner)) fail('INVALID_ARGUMENT', 'choose an active code item with a live worker, worktree and remaining time as owner');
      const ji = this.workflow.item(owner);
      if (ji.integratePlan || this.workflow.publishOwner === owner || this.rt.jobs.jobs.get(ji.publishJobId)?.state === 'running') fail('WORKTREE_BUSY', 'owner is publishing; choose another active worker');
      if (affectedItems !== undefined && (!Array.isArray(affectedItems) || !affectedItems.length || affectedItems.some(k => !this.eligible(k)))) fail('INVALID_ARGUMENT', 'affectedItems must contain active code items with suite checks');
      issue.history ??= [];
      issue.history.push({ state: state(issue), owner: issue.baselineOwner ?? null, at });
      Object.assign(issue, { kind, baselineOwner: owner, state: 'assigned', reason: explanation, assignedAt: at,
        affectedItems: affectedItems ? [...new Set([...affectedItems, owner, ...issue.reports.map(r => r.key).filter(k => this.eligible(k))])] : null });
      delete issue.baselineFix;
      issue.baseline = { failing: issue.failing }; // Báo cáo GAME tách khỏi baseline quan sát trong PREPARE.
      delete ji.question;
      this.rt.journal.save();
      this.rt.events.push('SHARED_FAILURE_ASSIGNED', { failureId, owner, kind });
      return this.assignment(issue);
    }
    if (action === 'defer') {
      if (['pending', 'landed', 'resolved'].includes(state(issue))) fail('SHARED_FAILURE_BUSY', 'a frozen or completed fix cannot be deferred');
      issue.state = 'deferred'; delete issue.baselineFix;
      issue.resolution = explanation; issue.endedAt = at;
    } else if (action === 'resolve') {
      if (issue.kind !== 'environment' || state(issue) !== 'assigned') fail('INVALID_ARGUMENT', 'resolve is for an assigned environment failure; product fixes use shared_failure_fixed');
      issue.resolutionEvidence = this.evidence(issue.baselineOwner, evidence);
      issue.state = 'resolved'; issue.resolution = explanation; issue.endedAt = at;
    } else fail('INVALID_ARGUMENT', 'action must be status, assign, resolve or defer');
    this.rt.journal.save();
    this.rt.events.push('SHARED_FAILURE_UPDATED', { failureId, state: issue.state });
    return { failureId, state: issue.state, hint: issue.state === 'resolved'
      ? 'Apply the environment correction to every affected copy/helper, then refresh their checks through next_actions. Resolution does not mark any test PASS.'
      : 'Recorded why the failure remains unresolved. Preserve failed requirements and PARTIAL/BLOCKED outcomes; no success is inferred.' };
  }
  assignment(issue) {
    const ji = this.workflow.item(issue.baselineOwner);
    return { failureId: issue.id, state: state(issue), owner: issue.baselineOwner, kind: issue.kind, workerThread: ji.workerThread ?? null,
      followup: `You own ${issue.id}: ${issue.summary}. Root classification: ${issue.kind}; ${issue.reason}. Call worker_checkpoint resume if yielded. Inspect the saved reports via shared failure details from root; reproduce the failure before fixing. ${issue.kind === 'product'
        ? `Change only the minimal product files; keep issued tests/config unchanged. The nominated files must contain only this repair, without unfinished changes from your own item; ask root to reassign if you cannot isolate them. After the failing tests and required suite pass, call worker_checkpoint shared_failure_fixed {failureId:"${issue.id}",files:[relative product paths]}. The helper commits those files separately for other worktrees.`
        : 'Find and verify the environment correction without changing product behavior or issued tests. Save the reproduction and successful verification logs; use worker_checkpoint blocked to tell root how to apply it to all affected copies and resolve it.'} If it cannot be fixed, report the concrete blocker so root can defer or reassign; never treat a failing acceptance requirement as met.` ,
      reports: issue.reports, failingTests: issue.failing };
  }
  productContexts() { return this.records().filter(i => i.kind === 'product' && i.baselineOwner && !['deferred', 'abandoned'].includes(state(i))); }
  ownerPending(key) { return this.records().find(i => i.baselineOwner === key && ['assigned', 'failed'].includes(state(i))); }
  // Hết thời gian chờ chủ sửa lỗi chung (sharedFixWaitMinutes, mặc định 8, tính từ lần giao gần nhất): item khác thôi
  // chờ, chính chủ cũng được nộp phần của nó. Lỗi vẫn assigned, chủ sửa tiếp được.
  waitExpired(issue) {
    const minutes = Number(this.rt.runtimeConfig().sharedFixWaitMinutes ?? 8);
    const since = Date.parse(issue?.assignedAt ?? '');
    return Number.isFinite(since) && minutes >= 0 && Date.now() - since >= minutes * 60_000;
  }
  async environmentRefresh(key) {
    for (const issue of this.records().filter(i => i.kind === 'environment' && state(i) === 'resolved' && this.affects(i, key))) {
      const checks = readChecks(this.rt.session.paths.teamWork, key);
      if (checks?.state !== 'done' || !(Date.parse(checks.startedAt) >= Date.parse(issue.endedAt)) || !checks.snapshot || !['typecheck', 'build', 'test'].every(n => checks.results?.some(r => r.name === n && ['passed', 'failed', 'skipped', 'timeout'].includes(r.state)))
        || checks.matchRoot !== this.rt.wtPaths(key).matchRoot || JSON.stringify(checks.snapshot) !== JSON.stringify(await this.workflow.snapshot(key))) return issue;
    }
    return null;
  }
  environmentWait(key) { return this.records().find(i => i.kind === 'environment' && state(i) === 'assigned' && this.affects(i, key)); }
  actions() {
    return this.records().filter(i => ['reported', 'failed'].includes(state(i)) || state(i) === 'assigned' && !this.ownerAvailable(i.baselineOwner)).map(i => ({
      key: i.reports[0].key, action: 'assign_shared_failure', arguments: { action: 'assign', failureId: i.id }, failure: i,
      candidates: Object.keys(this.rt.journal.data.items).filter(k => this.ownerAvailable(k)),
      hint: 'Inspect reproduction evidence, classify product versus environment (or an item regression), then use shared_failure assign with one owner and reason, or defer with a concrete reason. Do not discard a failed acceptance requirement merely because no owner existed.' }));
  }
}
