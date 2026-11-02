// Điều phối tất định: chuẩn bị, preflight, bàn giao, checkpoint và publish có thể tiếp tục sau restart.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { answerAgreement, answerCheck, answerFields, requirementsCheck } from '../gate/gate.mjs';
import { digest, repairPlan, resultArtifact, sourceSnapshot } from '../core/candidates.mjs';
import { contentTree, git, revParse } from '../core/git.mjs';
import { detectProfile } from '../env/environment.mjs';
import { evidenceProblems } from '../env/evidence.mjs';
import { fail } from '../core/util.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isKey = k => typeof k === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(k);
// Còn chừng này phút (theo hạn item hoặc hết trận) thì không sửa/review thêm: dừng worker, gate rồi nộp theo luật cơ hội
// cuối (NBDB5U0O: BUG-04 có candidate PARTIAL lúc 17:16, root lo publish CR-01/CR-02, item đóng 17:22 khi chưa nộp).
const LAST_CALL_MINUTES = 6;

export class Workflow {
  constructor(runtime) { this.rt = runtime; this.publishOwner = null; }
  item(key) {
    this.rt.session.require('GAME');
    if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
    return this.rt.journal.item(key);
  }
  artifact(file, kind) { return resultArtifact(join(this.rt.session.paths.teamWork, 'results'), file, kind); }
  nextResultFile(key, role = 'fixer') {
    const dir = join(this.rt.session.paths.teamWork, 'results');
    const re = new RegExp(`^${key.replace(/\./g, '\\.')}-${role}-(\\d+)\\.json$`, 'i');
    const versions = existsSync(dir) ? readdirSync(dir).map(f => Number(f.match(re)?.[1] ?? 0)) : [];
    return join(dir, `${key}-${role}-${Math.max(0, ...versions) + 1}.json`);
  }
  paths(key) {
    const r = this.rt;
    return r.liveWorktree(key) ? r.wtPaths(key) : r.session.paths;
  }
  snapshot(key, paths = this.paths(key)) {
    const checkout = paths.worktreeRoot ?? paths.checkoutRoot;
    return sourceSnapshot(checkout, this.rt.session.descriptor.matchId, detectProfile(paths.matchRoot), this.item(key).environmentEpoch ?? 0);
  }
  // File trong thư mục trận khác nhau giữa hai commit/tree, bỏ answers/ (mỗi item chỉ sửa answers của mình).
  async changedPaths(a, b, paths = null) {
    const folder = this.rt.session.descriptor.matchId;
    const res = await git(['diff', '--name-only', a, b, '--', ...(paths ?? [folder])], { cwd: this.rt.session.paths.checkoutRoot });
    return res.out.split(/\r?\n/).filter(p => p && !p.startsWith(`${folder}/answers/`));
  }
  metric(key, phase, since, detail = {}) {
    const ji = this.item(key);
    ji.metrics = [...(ji.metrics ?? []), { phase, at: new Date().toISOString(), ms: Date.now() - since, ...detail }].slice(-100);
    this.rt.journal.save();
  }
  async prepare({ backlogItemKey: key, waitSeconds = 0, force = false }) {
    const ji = this.item(key), r = this.rt;
    let job = r.jobs.jobs.get(ji.prepareJobId);
    if (!job || job.state === 'failed') {
      job = r.jobs.start('prepare_item', async () => {
        const since = Date.now();
        let started;
        if (ji.prepared) started = { ...ji.prepared, timeBox: r.timeBox(r.gm.view.items.find(i => i.key === key)), triage: r.compactTriage(key, ji) };
        else started = await r.startWork({ backlogItemKey: key, force });
        const item = r.readItem({ backlogItemKey: key });
        const worktree = await r.worktree({ action: 'create', backlogItemKey: key });
        const setup = await r.jobs.settle(worktree.setupJobId, 0);
        if (setup?.state === 'running') await r.jobs.jobs.get(worktree.setupJobId).promise;
        const done = r.jobs.view(r.jobs.jobs.get(worktree.setupJobId));
        if (done.state === 'failed' || done.result?.ok === false) fail('SETUP_FAILED', done.error?.message ?? done.result?.failure ?? 'worktree setup failed');
        const template = r.itemTemplate(key);
        ji.verificationKind = r.answerOnlyItem(key) && !Array.isArray(template?.testResults) ? 'answer_only'
          : r.itemMvs(key) ? 'mvs' : 'acceptance';
        ji.workerState = 'writing';
        ji.workStartedAt = Date.now();
        ji.prepared = started;
        this.metric(key, 'prepare', since);
        return { item: item.item, relatedEvents: item.relatedEvents ?? [], untrusted: true, ...started,
          worktree, profile: r.detectProfile({ path: worktree.matchRoot }), verificationKind: ji.verificationKind,
          companyFactsDir: join(r.itemDir(key), 'company'), resultsDir: join(r.session.paths.teamWork, 'results'),
          knowledgeHints: ji.signals?.kb ?? null,
          fixResultFile: this.nextResultFile(key),
          ...(started.independentAnswer ? { independentAnswer: { ...started.independentAnswer, resultsFile: this.nextResultFile(key, 'solver') } } : {}),
          worker: 'team_fixer', checker: ji.verificationKind === 'answer_only' ? 'team_pi_hypothesis' : 'team_reviewer',
          next: 'Spawn worker and the independent solver for answer_only; for code items open review only after preflight. No default verifier LLM.' };
      }, { key });
      ji.prepareJobId = job.id;
      r.journal.save();
    }
    return r.settleJob(job.id, Math.min(45, Math.max(0, waitSeconds)) * 1000);
  }
  checkpoint({ backlogItemKey: key, phase, threadId = null }) {
    const ji = this.item(key);
    if (!['ready_for_evidence', 'candidate', 'resume'].includes(phase)) fail('INVALID_ARGUMENT', 'checkpoint phase');
    if (phase === 'resume') {
      if (this.publishOwner === key || ji.integratePlan) fail('WORKTREE_BUSY', 'complete the pending publish/integration before resuming this worker');
      ji.workerState = 'writing';
      ji.workStartedAt = Date.now();
      if (threadId) ji.workerThread = threadId;
    } else {
      if (ji.workStartedAt) this.metric(key, ji.workerPhase ?? 'code_test', ji.workStartedAt);
      ji.workerState = 'yielded';
      ji.workerPhase = phase === 'ready_for_evidence' ? 'evidence' : 'handoff';
      this.rt.events.push('WORKER_YIELDED', { key, phase });
    }
    ji.checkpoint = phase;
    this.rt.journal.save();
    return { key, phase, writesAllowed: phase === 'resume',
      hint: phase === 'ready_for_evidence' ? 'Stop writing. Root may sync now, then sends resume; restart the app before final evidence.' : null };
  }
  async preflight({ backlogItemKey: key, fixResultFile, reviewFile = null }) {
    const since = Date.now(), r = this.rt, ji = this.item(key);
    if (ji.workerState === 'writing') fail('WORKER_BUSY', 'worker must checkpoint candidate before preflight');
    const artifact = this.artifact(fixResultFile, 'fix-result');
    if (ji.submitIntent && !ji.receipt && ji.candidate?.fixResultHash !== artifact.hash) fail('SUBMISSION_PENDING', 'replay the pending submission before changing candidate');
    if (!new RegExp(`^${key.replace(/\./g, '\\.')}-fixer-\\d+\\.json$`, 'i').test(basename(fixResultFile))) fail('PATH_NOT_ALLOWED', 'fix-result must belong to this item');
    ji.artifacts ??= {};
    const oldHash = ji.artifacts[basename(fixResultFile)];
    if (oldHash && oldHash !== artifact.hash) fail('RESULT_MUTATED', 'handoff files are immutable; write the next numbered fix-result');
    const paths = this.paths(key), snapshot = await this.snapshot(key, paths);
    const answerTree = await contentTree(paths.worktreeRoot ?? paths.checkoutRoot, r.session.descriptor.matchId);
    const id = digest({ artifact: artifact.hash, snapshot, answerTree });
    const old = ji.candidate;
    const answer = answerCheck(paths.matchRoot, key, r.itemTemplate(key), r.itemSchema(key), r.itemMvs(key), r.itemEvidence(key));
    let submitted = {};
    try { submitted = JSON.parse(readFileSync(join(paths.matchRoot, 'answers', key, 'submit.json'), 'utf8')); } catch { /* answerCheck */ }
    for (const row of submitted.testResults ?? []) {
      if (/^pass(ed)?$/i.test(row.result ?? '') && !artifact.value.verification.some(v => v.check === row.id && v.result === 'pass')) {
        answer.problems.push(`${row.id}: PASS is not backed by the fix-result verification with this scenario ID`);
      }
    }
    const template = r.itemTemplate(key);
    for (const req of r.itemRequirements(key)) if (artifact.value.requirements.filter(x => x.id === req.id).length !== 1) answer.problems.push(`${req.id}: fix-result must address this requirement exactly once`);
    ji.verificationKind ??= r.answerOnlyItem(key) && !Array.isArray(template?.testResults) ? 'answer_only' : r.itemMvs(key) ? 'mvs' : 'acceptance';
    if (Array.isArray(template?.testResults) && template.testResults.length) ji.requiredScenarios = new Set(template.testResults.map(x => x.id)).size;
    const status = submitted.status;
    const req = requirementsCheck(r.itemRequirements(key), artifact.value.requirements, status);
    const evidence = evidenceProblems(r.session.paths.teamWork, key, paths.matchRoot, snapshot);
    const review = reviewFile ? this.artifact(reviewFile, 'review').value : old?.review?.value;
    const gate = old?.id === id && old.gateJobId ? r.jobs.jobs.get(old.gateJobId)?.result : null;
    const repair = repairPlan({ fixer: artifact.value, answerProblems: [...answer.problems, ...req.problems], evidenceProblems: evidence, gate, review });
    const blocked = answer.problems.length || req.problems.length || evidence.length || artifact.value.status !== 'fixed'
      || (gate && !gate.passed) || (old?.id === id && review?.verdict === 'request_changes')
      || artifact.value.requirements.some(x => x.status === 'not_met')
      || (Array.isArray(submitted.testResults) && submitted.testResults.some(x => !/^pass(ed)?$/i.test(x.result ?? '')));
    const priorApproval = old?.review?.value.verdict === 'approve' && old.review.scope === 'full' && equal(old.snapshot, snapshot) ? old.review : old?.codeReview;
    const codeReview = priorApproval && equal(priorApproval.snapshot, snapshot) ? priorApproval : null;
    const candidate = old?.id === id ? old : { id, fixResultFile, fixResultHash: artifact.hash, snapshot, answerTree,
      createdAt: new Date().toISOString(), state: 'preflight', codeReview,
      solver: equal(old?.snapshot, snapshot) ? old?.solver : null };
    candidate.repair = repair;
    candidate.state = blocked ? 'repair' : candidate.review ? 'reviewed' : 'ready';
    candidate.reviewScope = codeReview ? 'evidence_answer' : 'full';
    ji.candidate = candidate;
    ji.artifacts[basename(fixResultFile)] = artifact.hash;
    ji.workerState = 'yielded';
    // Worker đã bàn giao và ngừng ghi: reviewer nhận graph của source cuối cùng.
    const codegraph = !blocked && !codeReview ? await r.refreshCodegraph(key, paths.matchRoot) : null;
    this.metric(key, 'handoff', since, { candidateId: id });
    return { candidateId: id, ready: !blocked, verificationKind: ji.verificationKind ?? 'acceptance', repair,
      nextFixResultFile: this.nextResultFile(key),
      reviewScope: candidate.reviewScope, priorReviewFile: codeReview?.file ?? null, codegraph,
      warnings: [...answer.warnings, ...req.warnings],
      next: blocked ? 'Repair the whole todo list before full review. Answer/evidence repair uses followup_task on the worker; then a new numbered result and preflight.'
        : ji.verificationKind === 'answer_only' ? 'Run the gate; validate independent solver through result_handoff. No default reviewer/verifier.'
          : 'Run gate and independent reviewer in parallel; reviewer checks MVS meaning and evidence content.' };
  }
  gateComplete(key, result, jobId) {
    const c = this.item(key).candidate;
    if (!c || result.where !== 'worktree') return;
    c.gateJobId = jobId;
    c.repair = repairPlan({ fixer: this.artifact(c.fixResultFile, 'fix-result').value, gate: result,
      answerProblems: c.repair.todo.filter(t => t.source === 'answer').map(t => t.action),
      evidenceProblems: c.repair.todo.filter(t => t.source === 'evidence').map(t => t.action), review: c.review?.value });
    c.state = !result.passed || c.review?.value.verdict === 'request_changes' ? 'repair' : c.review ? 'reviewed' : 'ready';
  }
  async handoff({ backlogItemKey: key, kind, resultFile, candidateId, purpose = 'solver' }) {
    const ji = this.item(key), c = ji.candidate;
    if (!c || candidateId !== c.id) fail('CANDIDATE_STALE', 'result must name the current candidateId');
    if (kind === 'fix-result') return this.preflight({ backlogItemKey: key, fixResultFile: resultFile });
    if (!['review', 'hypothesis'].includes(kind)) fail('INVALID_ARGUMENT', 'result kind');
    const artifact = this.artifact(resultFile, kind);
    ji.artifacts ??= {};
    if (ji.artifacts[basename(resultFile)] && ji.artifacts[basename(resultFile)] !== artifact.hash) fail('RESULT_MUTATED', 'write a new numbered result');
    if (!equal(await this.snapshot(key), c.snapshot)) fail('CANDIDATE_STALE', 'source/environment changed during review');
    if (kind === 'review') {
      if (!new RegExp(`^${key.replace(/\./g, '\\.')}-reviewer-\\d+\\.json$`, 'i').test(basename(resultFile))) fail('PATH_NOT_ALLOWED', 'review result must belong to this item');
      const binding = ji.reviewBindings?.[basename(resultFile)];
      if (binding && binding !== c.id) fail('RESULT_ALREADY_BOUND', 'review belongs to another candidate; request a new numbered delta review');
      for (const req of this.rt.itemRequirements(key)) if (artifact.value.requirements.filter(x => x.id === req.id).length !== 1) fail('RESULT_INVALID', `$.requirements: review must address ${req.id} exactly once`);
      ji.reviewBindings = { ...(ji.reviewBindings ?? {}), [basename(resultFile)]: c.id };
      c.review = { file: resultFile, hash: artifact.hash, value: artifact.value, snapshot: c.snapshot, scope: c.reviewScope };
      c.repair = repairPlan({ fixer: this.artifact(c.fixResultFile, 'fix-result').value,
        answerProblems: c.repair.todo.filter(t => t.source === 'answer').map(t => t.action),
        evidenceProblems: c.repair.todo.filter(t => t.source === 'evidence').map(t => t.action),
        gate: c.gateJobId ? this.rt.jobs.jobs.get(c.gateJobId)?.result : null, review: artifact.value });
      c.state = artifact.value.verdict === 'approve' ? 'reviewed' : 'repair';
    } else {
      const role = purpose === 'arbitration' ? 'arbitration' : purpose === 'hypothesis' ? 'pi_hypothesis' : 'solver';
      if (!new RegExp(`^${key.replace(/\./g, '\\.')}-${role}-\\d+\\.json$`, 'i').test(basename(resultFile))) fail('PATH_NOT_ALLOWED', 'hypothesis result path does not match item and purpose');
      if (purpose === 'hypothesis') c.hypotheses = [...(c.hypotheses ?? []), { file: resultFile, hash: artifact.hash }];
      else c[purpose === 'arbitration' ? 'arbitration' : 'solver'] = { file: resultFile, hash: artifact.hash };
    }
    ji.artifacts[basename(resultFile)] = artifact.hash;
    this.rt.journal.save();
    return { candidateId: c.id, kind, accepted: true, state: c.state, repair: c.repair };
  }
  answerProof(key, matchRoot, { allowUnverified = false } = {}) {
    const c = this.item(key).candidate;
    if (!c?.solver) { if (allowUnverified) return { supported: false, solverFile: null }; fail('ANSWER_UNVERIFIED', 'validate the independent solver with result_handoff first'); }
    const s = this.artifact(c.solver.file, 'hypothesis');
    if (s.hash !== c.solver.hash) fail('RESULT_MUTATED', 'solver changed after handoff');
    const fields = answerFields(this.rt.itemTemplate(key));
    const covers = fields.length > 0 && fields.every(f => s.value.answer_values.filter(v => v.field === f).length === 1);
    if (!covers && !allowUnverified) fail('ANSWER_UNVERIFIED', 'solver must cover each answer field exactly once');
    const answer = JSON.parse(readFileSync(join(matchRoot, 'answers', key, 'submit.json'), 'utf8'));
    const agreement = answerAgreement(answer, s.value.answer_values, fields);
    if (agreement?.state !== 'agree') {
      const arbitration = c.arbitration && this.artifact(c.arbitration.file, 'hypothesis');
      if (!arbitration || arbitration.hash !== c.arbitration.hash || arbitration.value.verdict !== 'refuted' || !arbitration.value.evidence.length) {
        if (allowUnverified) return { supported: false, solverFile: c.solver.file };
        fail('ANSWER_DISPUTED', 'independent answer differs; validate a checker refutation with result_handoff purpose=arbitration, or change the answer and preflight again');
      }
    }
    return { supported: covers && s.value.verdict === 'supported' && s.value.evidence.length > 0, solverFile: c.solver.file, fields, derivation: s.value.evidence };
  }
  async assertCandidate(key, { main = false } = {}) {
    const c = this.item(key).candidate;
    if (!c) fail('CANDIDATE_REQUIRED', 'run candidate_preflight first');
    const a = this.artifact(c.fixResultFile, 'fix-result');
    if (a.hash !== c.fixResultHash) fail('RESULT_MUTATED', 'fix-result changed after handoff');
    const p = main ? this.rt.session.paths : this.paths(key);
    const tree = await contentTree(p.worktreeRoot ?? p.checkoutRoot, this.rt.session.descriptor.matchId);
    if (!main && (tree !== c.answerTree || !equal(await this.snapshot(key), c.snapshot))) fail('CANDIDATE_STALE', 'candidate changed; checkpoint and preflight the new version');
    return c;
  }
  async publish({ backlogItemKey: key, candidateId, message = 'work', lastChance = null, waitSeconds = 0 }) {
    const r = this.rt, ji = this.item(key);
    if (ji.receipt) return { state: 'done', result: { status: 'SUBMITTED', receiptId: ji.receipt.id, replay: true } };
    let job = r.jobs.jobs.get(ji.publishJobId);
    if (job?.state === 'running') return r.settleJob(job.id, Math.min(45, waitSeconds) * 1000);
    if (this.publishOwner) fail('PUBLISH_BUSY', `publish ${this.publishOwner} first`);
    if (candidateId !== ji.candidate?.id) fail('CANDIDATE_STALE', 'publish requires current candidateId');
    this.publishOwner = key;
    job = r.jobs.start('publish_item', async job => {
      const since = Date.now();
      const step = name => { job.progress.push(name); ji.publishStep = name; r.journal.save(); };
      try {
        if (ji.publishedRevision && ji.publishedCandidateId === candidateId) {
          step('submit'); return await r.submitWork({ backlogItemKey: key, gitRevision: ji.publishedRevision, lastChance });
        }
        const c = await this.assertCandidate(key);
        if (c.state === 'repair' && !lastChance) fail('PREFLIGHT_REQUIRED', 'candidate still has repair tasks');
        if (ji.verificationKind !== 'answer_only') {
          if (!c.review || c.review.value.verdict !== 'approve') {
            if (!lastChance) fail('REVIEW_REQUIRED', 'independent review must approve this candidate');
          }
          if (c.review && this.artifact(c.review.file, 'review').hash !== c.review.hash) fail('RESULT_MUTATED', 'review changed after handoff');
        }
        if (!c.gateJobId) fail('GATE_REQUIRED', 'run_gate with this candidate fixResultFile first');
        step('verification');
        const verification = r.recordVerification({ backlogItemKey: key, gateJobId: c.gateJobId, lastChance: Boolean(lastChance) });
        if (verification.status !== 'PASSED' && !lastChance) fail('VERIFICATION_REQUIRED', verification.hint ?? 'verification has not passed');
        if (!ji.integratedRevision || ji.integratedCandidateId !== c.id) {
          // Main đổi ở file khác thì integrate luôn, main_gate test cây đã gộp; chỉ khi cả hai cùng sửa một file mới
          // phải sync và làm lại evidence (NBDB5U0O: CR-01, CR-02, BUG-04 chụp lại toàn bộ sau BUG-01, mỗi item ~15 phút).
          const base = ji.integratedRevision ?? ji.worktreeBase, head = await revParse(r.session.paths.checkoutRoot);
          if (!ji.integratePlan && head !== base) {
            const others = new Set(await this.changedPaths(base, head));
            const shared = (await this.changedPaths(base, c.snapshot.source)).filter(p => others.has(p));
            if (shared.length) fail('SYNC_REQUIRED', `main changed files this item also changes (${shared.slice(0, 5).join(', ')}); sync a yielded worker, refresh evidence and preflight before integrate`);
          }
          step('integrate'); await r.worktree({ action: 'integrate', backlogItemKey: key, message });
          ji.integratedCandidateId = c.id; r.journal.save();
        }
        // Main phải chứa đúng nội dung đã review ở mọi file của item; file khác là thay đổi của item khác.
        const mainSource = (await this.snapshot(key, r.session.paths)).source;
        if (mainSource !== c.snapshot.source) {
          const own = await this.changedPaths(ji.worktreeBase, c.snapshot.source);
          if (!own.length || (await this.changedPaths(c.snapshot.source, mainSource, own)).length) fail('CANDIDATE_STALE', 'main source differs from reviewed candidate in this item\'s files; sync, refresh evidence and review a new candidate');
        }
        step('main_gate');
        try { await r.requireGate(key, r.session.paths.checkoutRoot); }
        catch (e) {
          if (!['GATE_REQUIRED', 'GATE_STALE'].includes(e.code)) throw e;
          const pending = await r.runGate({ backlogItemKey: key, where: 'main', waitSeconds: 0 });
          await r.jobs.jobs.get(pending.jobId).promise;
          await r.requireGate(key, r.session.paths.checkoutRoot);
        }
        // Answer/evidence được integrate phải giữ nguyên bytes đã được reviewer kiểm.
        const answer = join(r.session.paths.matchRoot, 'answers', key, 'submit.json');
        const wtAnswer = join(r.wtPaths(key).matchRoot, 'answers', key, 'submit.json');
        if (existsSync(wtAnswer) && digest(readFileSync(answer)) !== digest(readFileSync(wtAnswer))) fail('CANDIDATE_STALE', 'integrated answer differs from reviewed candidate');
        step('push');
        const pushed = await r.commitAndPush({ backlogItemKey: key, message });
        ji.publishedCandidateId = c.id; r.journal.save();
        step('submit');
        const receipt = await r.submitWork({ backlogItemKey: key, gitRevision: pushed.revision, lastChance });
        if (receipt.status === 'SUBMITTED') step('done');
        return receipt;
      } finally { this.publishOwner = null; this.metric(key, 'publish', since); }
    }, { key });
    ji.publishJobId = job.id;
    r.journal.save();
    return r.settleJob(job.id, Math.min(45, Math.max(0, waitSeconds)) * 1000);
  }
  actions() {
    const r = this.rt;
    if (r.session.phase !== 'GAME' || !r.gm.view || !r.session.paths?.teamWork) return { nextActions: [], waitMs: 55_000 };
    const rows = r.itemRows(), items = r.journal?.data.items ?? {};
    const order = r.matchState().suggestedOrder;
    const nextActions = [];
    const add = (key, action, args = {}, extra = {}) => nextActions.push({ key, action, arguments: { backlogItemKey: key, ...args }, ...extra });
    let free = r.freeSlots(rows);
    const lastCallOf = (row, ji) => row?.minutesLeft != null && row.minutesLeft <= LAST_CALL_MINUTES && ji?.verificationKind !== 'answer_only';
    for (const key of order) {
      const row = rows.find(x => x.key === key), ji = items[key] ?? {}, c = ji.candidate;
      if (ji.prepareJobId && r.jobs.jobs.get(ji.prepareJobId)?.state === 'running') continue;
      if (row.local === 'todo' && (row.minutesLeft === null || row.minutesLeft >= 4) && (row.type === 'PI' || r.answerOnlyItem(key) || free > 0)) {
        add(key, 'prepare_item'); if (row.type !== 'PI' && !r.answerOnlyItem(key)) free--; continue;
      }
      if (ji.endedAt || ji.receipt) continue;
      if (ji.publishedRevision && (!c || ji.submitIntent || ji.publishedCandidateId === c.id)) { add(key, 'submit_work', { gitRevision: ji.publishedRevision }); continue; }
      const returnBy = ji.prepared?.timeBox?.returnBy ?? row.returnBy;
      if (ji.workerState === 'writing' && Date.parse(returnBy) <= Date.now()) { add(key, 'stop_worker', {}, { workerThread: ji.workerThread ?? null, returnBy }); continue; }
      if (ji.startedAt && lastCallOf(row, ji)) {
        // Cuối giờ: worker bàn giao ngay, gate rồi nộp; review/sửa thêm không kịp. Gate không qua build + regression thì
        // không có gì nộp được (luật cơ hội cuối không bao giờ che build/regression hỏng).
        const extra = { lastCall: true, minutesLeft: row.minutesLeft };
        if (ji.workerState === 'writing') { add(key, 'stop_worker', {}, { ...extra, workerThread: ji.workerThread ?? null, returnBy }); continue; }
        if (c && c.state !== 'stale') {
          const gate = c.gateJobId ? r.jobs.jobs.get(c.gateJobId) : null;
          if (!gate) { add(key, 'run_gate', { fixResultFile: c.fixResultFile }, extra); continue; }
          if (gate.state === 'running') continue;
          if (ji.lastGate?.jobId !== c.gateJobId || !ji.lastGate.tree) continue;
          const verified = gate.result?.passed && c.review?.value.verdict === 'approve';
          add(key, 'publish_item', { candidateId: c.id, ...(verified ? {} : { lastChance: { reason:
            `${Math.floor(row.minutesLeft)} min left: no time for another repair or review; unverified scenarios stay FAIL/NOT_RUN` } }) }, extra);
          continue;
        }
      }
      if (ji.prepared && !ji.workerThread && !c) { add(key, 'spawn_worker', {}, { prepareJobId: ji.prepareJobId }); continue; }
      if (ji.checkpoint === 'ready_for_evidence' && ji.workerState === 'yielded') { add(key, 'sync_before_evidence'); continue; }
      if (c?.state === 'stale') { add(key, 'refresh_candidate', {}, { candidateId: c.id, workerThread: ji.workerThread ?? null }); continue; }
      if (c?.state === 'repair') { add(key, 'repair_worker', {}, { candidateId: c.id, workerThread: ji.workerThread ?? null, repair: c.repair, nextFixResultFile: this.nextResultFile(key) }); continue; }
      if (c && (!c.gateJobId || !r.jobs.jobs.has(c.gateJobId))) add(key, 'run_gate', { fixResultFile: c.fixResultFile });
      if (c && ji.verificationKind !== 'answer_only' && !c.review && c.state !== 'repair') add(key, 'review_candidate', {}, { candidateId: c.id, scope: c.reviewScope });
      if (c && ji.verificationKind === 'answer_only' && !c.solver) add(key, 'collect_solver', {}, { candidateId: c.id });
      const gate = c?.gateJobId ? r.jobs.jobs.get(c.gateJobId) : null;
      if (c && gate?.result?.passed) {
        if (ji.verificationKind !== 'answer_only' && c.review?.value.verdict === 'approve') add(key, 'publish_item', { candidateId: c.id });
        else if (ji.verificationKind === 'answer_only' && c.solver) {
          try { const proof = this.answerProof(key, this.paths(key).matchRoot); add(key, proof.supported ? 'publish_item' : 'resolve_answer', { candidateId: c.id }); }
          catch (e) { add(key, 'resolve_answer', { candidateId: c.id }, { code: e.code, hint: e.detail }); }
        }
      }
    }
    for (const u of r.ungatedResults()) {
      if (items[u.key]?.candidate && items[u.key].candidate.fixResultFile === u.fixResultFile) continue;
      const row = rows.find(x => x.key === u.key);
      add(u.key, 'candidate_preflight', { fixResultFile: u.fixResultFile }, lastCallOf(row, items[u.key]) ? { lastCall: true, minutesLeft: row.minutesLeft } : {});
    }
    // Việc cuối giờ lên đầu, item ít phút nhất trước; các việc khác giữ thứ tự cũ.
    const urgency = a => (a.lastCall ? a.minutesLeft : Infinity);
    nextActions.sort((a, b) => (urgency(a) === urgency(b) ? 0 : urgency(a) - urgency(b)));
    const now = Date.now();
    const wake = [now + 55_000, Date.parse(r.releases()?.next?.at) + 1000,
      ...rows.filter(x => items[x.key]?.startedAt && !items[x.key]?.endedAt && !items[x.key]?.receipt && x.minutesLeft !== null)
        .map(x => now + (x.minutesLeft - LAST_CALL_MINUTES) * 60_000 + 1000),
      ...rows.filter(x => !items[x.key]?.endedAt).map(x => Date.parse(items[x.key]?.prepared?.timeBox?.returnBy ?? x.returnBy)),
      ...rows.filter(x => x.deadlineMinutes && x.minutesLeft !== null).map(x => now + Math.max(0, x.minutesLeft * 60_000 - 120_000))].filter(x => Number.isFinite(x) && x > now);
    return { nextActions, waitMs: Math.max(0, Math.min(...wake) - now) };
  }
}
