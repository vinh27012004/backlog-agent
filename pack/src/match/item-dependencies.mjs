// Dependency giữa item là quan hệ ngữ nghĩa do worker khai, tách khỏi needs_dependency (package/artifact).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { digest } from '../core/candidates.mjs';
import { git } from '../core/git.mjs';
import { fail } from '../core/util.mjs';
import { recordEvidence } from '../env/evidence.mjs';
import { readState as appState } from '../env/app.mjs';

const equal = (a, b) => digest(a) === digest(b);
const string = (v, label, max = 1500) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail('INVALID_ARGUMENT', `${label} is required (max ${max} characters)`);
  return v.trim();
};
const list = (v, label, required = false) => {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || v.length > 30 || required && !v.length) fail('INVALID_ARGUMENT', `${label} needs ${required ? '1' : '0'}-30 entries`);
  return [...new Set(v.map(s => string(s, label, 300)))];
};
function pointer(data, path = '') {
  if (path === '') return data;
  if (typeof path !== 'string' || !path.startsWith('/')) fail('INVALID_ARGUMENT', 'reportPointer must be a JSON pointer or empty');
  return path.slice(1).split('/').reduce((value, token) => {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('DEPENDENCY_OUTPUT_MISMATCH', `report lacks ${path}`);
    return value[key];
  }, data);
}
// Summary có thể là projection của report lớn hơn; array vẫn phải đúng thứ tự và đủ phần tử.
export function matchesReport(summary, report) {
  if (Array.isArray(summary)) return Array.isArray(report) && summary.length === report.length && summary.every((v, i) => matchesReport(v, report[i]));
  if (summary !== null && typeof summary === 'object') return report !== null && typeof report === 'object' && !Array.isArray(report)
    && Object.keys(summary).length > 0 && Object.entries(summary).every(([k, v]) => Object.hasOwn(report, k) && matchesReport(v, report[k]));
  return Object.is(summary, report);
}

export class ItemDependencies {
  constructor(workflow) { this.workflow = workflow; this.rt = workflow.rt; }
  records(key) { return Object.values(this.rt.journal.data.items[key]?.itemDependencies ?? {}); }
  revision(dep) {
    const ji = this.rt.journal.data.items[dep.dependsOn];
    return ji?.integratedRevision ?? ji?.publishedRevision ?? null;
  }
  revisionsCurrent(record) { return Object.entries(record.dependencies ?? {}).every(([dependsOn, revision]) => this.revision({ dependsOn }) === revision); }
  pending(key) { return this.records(key).filter(d => (!d.verified || d.verified.revision !== this.revision(d) || !this.revisionsCurrent(d.verified)) && d.deferred?.revision !== this.revision(d)); }
  related(a, b) { return a.scenarios.some(id => b.scenarios.includes(id)) || a.artifacts.some(p => b.artifacts.includes(p))
    || a.summaries.some(x => b.summaries.some(y => y.answerField === x.answerField)); }
  ready(key) {
    const pending = this.pending(key);
    return pending.filter(d => this.revision(d) && pending.filter(other => this.related(d, other)).every(other => this.revision(other)));
  }
  path(key, name, mustExist = false) {
    const path = string(name, 'evidence path', 300).replaceAll('\\', '/');
    if (!path.startsWith('evidence/') || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('PATH_NOT_ALLOWED', 'evidence must stay under this item answers/<ID>/evidence/');
    const root = join(this.rt.wtPaths(key).matchRoot, 'answers', key, 'evidence');
    const file = resolve(root, path.slice('evidence/'.length));
    if (mustExist) {
      if (!existsSync(file) || !statSync(file).isFile()) fail('INVALID_ARGUMENT', `missing ${path}`);
      const rel = relative(realpathSync(root), realpathSync(file));
      if (rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', 'linked evidence escapes this item');
    }
    return file;
  }
  get(key, dependsOn) {
    const dep = this.records(key).find(d => d.dependsOn === dependsOn);
    if (!dep) fail('DEPENDENCY_UNKNOWN', 'declare this item dependency first');
    return dep;
  }
  answer(key) { return JSON.parse(readFileSync(join(this.rt.wtPaths(key).matchRoot, 'answers', key, 'submit.json'), 'utf8')); }
  hasScenarioRows(key) { return Boolean(this.rt.itemTemplate(key)?.testResults?.length); }
  incomplete(key, dep) {
    try {
      const answer = this.answer(key);
      if (!['PARTIAL', 'BLOCKED'].includes(answer.status)) return false;
      return !this.hasScenarioRows(key) || dep.scenarios.every(id => answer.testResults?.some(r => r.id === id && ['FAIL', 'NOT_RUN'].includes(r.result)));
    } catch { return false; }
  }
  async present(key, revision) {
    if (!revision || !this.rt.journal.data.items[key]?.worktreeBase) return false;
    const result = await git(['rev-list', '--count', `${this.rt.journal.data.items[key].worktreeBase}..${revision}`], { cwd: this.rt.session.paths.checkoutRoot, allowFail: true });
    return result.code === 0 && result.out === '0';
  }
  async call({ action, backlogItemKey: key, dependsOn, scenarios, artifacts, summaries, csvBindings, replayData, reason, refreshSeconds, replayId, result, evidence }) {
    const ji = this.workflow.item(key);
    if (action === 'status') return { dependencies: this.records(key).map(d => ({ ...d, requiredRevision: this.revision(d) })) };
    if (!ji.startedAt || ji.endedAt || ji.receipt || !this.rt.liveWorktree(key) || this.rt.answerOnlyItem(key)) fail('INVALID_ARGUMENT', 'item dependencies require an active code worktree');
    if (action === 'declare') {
      if (dependsOn === key || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(dependsOn ?? '') || !this.rt.journal.data.items[dependsOn] && !this.rt.gm.view?.items.some(i => i.key === dependsOn)) fail('INVALID_ARGUMENT', 'dependsOn must name another visible match item');
      const visit = (id, seen = new Set()) => {
        if (id === key) fail('DEPENDENCY_CYCLE', 'item dependencies cannot form a cycle');
        if (seen.has(id)) return; seen.add(id);
        for (const child of this.records(id)) visit(child.dependsOn, seen);
      };
      visit(dependsOn);
      const names = list(scenarios, 'scenarios', true), files = list(artifacts, 'artifacts');
      const rows = this.rt.itemTemplate(key)?.testResults;
      if (rows?.length && names.some(id => !rows.some(r => r.id === id))) fail('INVALID_ARGUMENT', 'scenarios must name this item template rows');
      if (summaries !== undefined && !Array.isArray(summaries) || csvBindings !== undefined && !Array.isArray(csvBindings)) fail('INVALID_ARGUMENT', 'summaries and csvBindings must be arrays');
      const bindings = summaries ?? [], csv = csvBindings ?? [];
      if (bindings.length > 10 || csv.length > 10) fail('INVALID_ARGUMENT', 'at most 10 summary/CSV bindings');
      for (const b of bindings) {
        if (!b || typeof b !== 'object' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(b.answerField ?? '') || ['status','backlogId','schemaVersion','testResults','evidenceFiles'].includes(b.answerField)) fail('INVALID_ARGUMENT', 'summary answerField must name a top-level data field');
        this.path(key, b.reportFile);
        if (typeof b.reportPointer !== 'string' || b.reportPointer && !b.reportPointer.startsWith('/')) fail('INVALID_ARGUMENT', 'reportPointer must be empty or start with /');
      }
      for (const b of csv) {
        if (!b || typeof b !== 'object') fail('INVALID_ARGUMENT', 'CSV bindings must be objects');
        this.path(key, b.artifact); this.path(key, b.reportFile);
        if (!files.includes(b.artifact)) fail('INVALID_ARGUMENT', 'CSV artifact must also be declared in artifacts');
        if (bindings.length && !bindings.some(s => s.reportFile === b.reportFile)) fail('INVALID_ARGUMENT', 'CSV and summary must reference the same replay report');
        if (typeof b.reportPointer !== 'string' || !b.reportPointer.startsWith('/')) fail('INVALID_ARGUMENT', 'CSV reportPointer must select a report string');
      }
      files.forEach(f => this.path(key, f));
      const budget = refreshSeconds === undefined ? 180 : Number(refreshSeconds);
      if (!Number.isInteger(budget) || budget < 15 || budget > 300) fail('INVALID_ARGUMENT', 'refreshSeconds must be 15-300');
      const config = { dependsOn, scenarios: names, artifacts: files, summaries: bindings, csvBindings: csv, replayData: replayData === true, reason: string(reason, 'reason'), refreshSeconds: budget };
      const previous = ji.itemDependencies?.[dependsOn];
      if (previous && equal(previous.config, config)) return { declared: true, duplicate: true, ...previous, requiredRevision: this.revision(previous) };
      const dep = { ...config, config, declaredAt: new Date().toISOString() };
      (ji.itemDependencies ??= {})[dependsOn] = dep;
      this.rt.journal.save(); this.rt.events.push('ITEM_DEPENDENCY_DECLARED', { key, dependsOn });
      return { declared: true, ...dep, requiredRevision: this.revision(dep), hint: 'Continue independent work. After the required revision is in this worktree, begin a bounded replay, rebuild/start the correct source, use fresh fixture data if replayData, and regenerate affected outputs. needs_dependency is for external packages, not item keys.' };
    }
    const dep = this.get(key, dependsOn), revision = this.revision(dep);
    if (action === 'defer') {
      dep.deferred = { revision, reason: string(reason, 'reason'), at: new Date().toISOString() };
      delete dep.run; delete dep.verified;
      this.rt.journal.save();
      return { deferred: true, hint: 'Keep affected scenarios FAIL/NOT_RUN and status PARTIAL/BLOCKED; state what remains unverified. Other scenario results are unchanged.' };
    }
    if (action === 'begin') {
      const related = this.pending(key).filter(d => this.related(dep, d));
      const required = [...new Set([revision, ...related.map(d => this.revision(d))])];
      for (const needed of required) if (!await this.present(key, needed)) fail('DEPENDENCY_NOT_SYNCED', 'all fixes affecting this replay need to be on main and in this worktree; keep independent work moving meanwhile');
      this.opportunity(key, this.rt.itemRows().find(r => r.key === key));
      if (!ji.dependencyRefreshUntil || Date.parse(ji.dependencyRefreshUntil) <= Date.now()) fail('DEPENDENCY_REFRESH_EXPIRED', 'targeted refresh budget expired; defer with the actual unverified outcomes and hand off');
      const snapshot = await this.workflow.snapshot(key);
      dep.run = { id: randomUUID(), revision, dependencies: Object.fromEntries([dep, ...related].map(d => [d.dependsOn, this.revision(d)])), snapshot, startedAt: Date.now() };
      delete dep.verified; delete dep.deferred;
      this.rt.journal.save();
      return { replayId: dep.run.id, revision, snapshot, scenarios: dep.scenarios, replayData: dep.replayData,
        deadline: ji.dependencyRefreshUntil ?? null, hint: `${dep.replayData ? 'Create a fresh budget/database and replay the original fixture through the corrected pipeline; existing imported data is not repaired by reload. ' : ''}Run only affected checks, export actual artifacts and update the declared summary fields from the same report. Complete after processes have exited; do not fabricate downloads.` };
    }
    if (action !== 'complete') fail('INVALID_ARGUMENT', 'action must be declare, status, begin, complete or defer');
    const writers = this.workflow.writerProblems(key);
    if (writers.length) fail('DEPENDENCY_JOBS_RUNNING', writers.join('; '));
    const logs = list(evidence, 'evidence', true);
    const requestHash = digest({ result, evidence: logs });
    if (!dep.run && dep.verified?.replayId === replayId && dep.verified.requestHash === requestHash) {
      await this.problems(key);
      if (dep.verified) return { verified: true, replay: true, result: dep.verified.result, revision: dep.verified.revision };
    }
    const run = dep.run;
    if (!run || run.id !== replayId || run.revision !== revision || !this.revisionsCurrent(run) || !equal(run.snapshot, await this.workflow.snapshot(key))) fail('DEPENDENCY_REPLAY_STALE', 'replay source/environment/revision changed; begin again on the final source');
    if (!['pass', 'fail'].includes(result)) fail('INVALID_ARGUMENT', 'complete result must be pass or fail');
    const answer = this.answer(key);
    if (result === 'pass' && this.hasScenarioRows(key) && !dep.scenarios.every(id => answer.testResults?.some(r => r.id === id && r.result === 'PASS'))) fail('DEPENDENCY_OUTPUT_MISMATCH', 'affected scenario rows must reflect the replay PASS');
    if (result === 'fail' && !this.incomplete(key, dep)) fail('DEPENDENCY_OUTPUT_MISMATCH', 'a failed replay needs PARTIAL/BLOCKED and affected rows FAIL/NOT_RUN');
    const app = appState(this.rt.teamWorkspace, key);
    if (app?.pid) {
      let alive = true;
      try { process.kill(app.pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
      if (alive && app.snapshot && (!equal(app.snapshot, run.snapshot) || typeof app.matchRoot !== 'string' || resolve(app.matchRoot) !== resolve(this.rt.wtPaths(key).matchRoot))) fail('DEPENDENCY_APP_STALE', 'managed app still serves a different source/environment/worktree; restart it before replay evidence');
    }
    const files = [...new Set([...dep.artifacts, ...logs, ...dep.summaries.map(b => b.reportFile), ...dep.csvBindings.map(b => b.reportFile)])];
    const hashes = {};
    for (const file of files) {
      const path = this.path(key, file, true);
      if (statSync(path).mtimeMs + 2 < run.startedAt) fail('DEPENDENCY_ARTIFACT_STALE', `${file} predates this replay; regenerate it`);
      hashes[file] = digest(readFileSync(path));
    }
    const report = b => pointer(JSON.parse(readFileSync(this.path(key, b.reportFile, true), 'utf8')), b.reportPointer);
    const values = {};
    for (const b of dep.summaries) {
      if (!Object.hasOwn(answer, b.answerField) || !matchesReport(answer[b.answerField], report(b))) fail('DEPENDENCY_OUTPUT_MISMATCH', `${b.answerField} differs from its replay report (including order)`);
      values[b.answerField] = digest(answer[b.answerField]);
    }
    for (const b of dep.csvBindings) {
      const csv = report(b);
      if (typeof csv !== 'string' || !readFileSync(this.path(key, b.artifact, true)).equals(Buffer.from(csv, 'utf8'))) fail('DEPENDENCY_OUTPUT_MISMATCH', `${b.artifact} differs from the report CSV bytes`);
    }
    dep.verified = { revision, dependencies: run.dependencies, replayId, requestHash, snapshot: run.snapshot, result, hashes, values, completedAt: new Date().toISOString() };
    delete dep.run; delete dep.deferred;
    for (const file of files) recordEvidence(this.rt.session.paths.teamWork, key, { ...run.snapshot, base: ji.worktreeBase,
      name: file.slice('evidence/'.length), path: this.path(key, file), worktree: this.rt.wtPaths(key).matchRoot,
      phase: 'final', role: 'evidence', kind: 'external', scenario: dep.scenarios.join(','), attemptId: replayId,
      sha256: hashes[file], capturedAt: dep.verified.completedAt });
    this.rt.journal.save(); this.rt.events.push('ITEM_DEPENDENCY_VERIFIED', { key, dependsOn, revision, result });
    return { verified: true, result, revision, hint: 'Only declared affected outputs were refreshed. This records provenance/consistency; independent specification assertions still decide correctness.' };
  }
  async problems(key, { partial = false } = {}) {
    const out = [];
    const current = this.records(key).some(d => d.verified) ? await this.workflow.snapshot(key) : null;
    for (const dep of this.records(key)) {
      const revision = this.revision(dep), v = dep.verified;
      let valid = Boolean(v && v.revision === revision && this.revisionsCurrent(v) && equal(v.snapshot, current));
      if (valid) {
        try {
          const answer = this.answer(key);
          valid = Object.entries(v.hashes).every(([file, hash]) => digest(readFileSync(this.path(key, file, true))) === hash)
            && Object.entries(v.values).every(([field, hash]) => digest(answer[field]) === hash)
            && (v.result === 'fail' ? this.incomplete(key, dep) : !this.hasScenarioRows(key) || dep.scenarios.every(id => answer.testResults?.some(r => r.id === id && r.result === 'PASS')));
        } catch { valid = false; }
      }
      if (valid) continue;
      if (v) { delete dep.verified; this.rt.journal.save(); }
      if ((partial || dep.deferred?.revision === revision) && this.incomplete(key, dep)) continue;
      out.push(`${dep.dependsOn}: ${revision ? 'replay affected scenarios on revision ' + revision.slice(0, 12) : 'required fix is not on main yet'}; ${dep.scenarios.join(', ')} need fresh artifacts/summary, or defer with the actual failed/unverified outcomes`);
    }
    return out;
  }
  // Một lượt refresh có hạn cố định, không gia hạn theo polling/retry; luôn chừa ít nhất một phút submit.
  opportunity(key, row) {
    const ji = this.rt.journal.data.items[key], pending = this.ready(key);
    if (!pending.length || row?.minutesLeft != null && row.minutesLeft * 60 <= 75) return null;
    const token = digest(this.records(key).map(d => [d.dependsOn, this.revision(d)]).sort());
    if (!ji.dependencyRefreshUntil || ji.dependencyRefreshToken !== token) {
      const seconds = Math.min(...pending.map(d => d.refreshSeconds), row?.minutesLeft == null ? 300 : row.minutesLeft * 60 - 60);
      ji.dependencyRefreshUntil = new Date(Date.now() + seconds * 1000).toISOString(); ji.dependencyRefreshToken = token; this.rt.journal.save();
    }
    return Date.parse(ji.dependencyRefreshUntil) > Date.now() ? { until: ji.dependencyRefreshUntil, dependencies: pending } : null;
  }
  followup(key, opportunity) {
    const deps = opportunity.dependencies;
    return `Bounded dependency refresh authorized until ${opportunity.until} UTC (then hand off PARTIAL if unfinished). Call worker_checkpoint resume if yielded, then ready_for_evidence for a safe sync; wait for setup/checks already running, reuse valid installs/builds. Required items: ${deps.map(d => `${d.dependsOn}: ${d.scenarios.join(', ')}`).join('; ')}. Use item_dependency begin after the required revisions are present. ${deps.some(d => d.replayData) ? 'Start from fresh fixture data and rerun import/rules/edits; reload does not repair previously stored data. ' : ''}Refresh only affected checks, real downloads and bound summary fields, then item_dependency complete and a new candidate. Keep independent results that remain valid. Do not mark stale dependent results PASS; if time is insufficient, defer with a reason and report actual FAIL/NOT_RUN. Do not restart full setup for a new turn.`;
  }
}
