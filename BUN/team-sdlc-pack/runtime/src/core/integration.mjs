// Kế hoạch tích hợp bền: nhận diện cherry-pick đã commit nhưng chưa kịp lưu checkpoint.
import { changedFiles } from '../gate/gate.mjs';
import { git, revParse } from './git.mjs';
import { fail, oneLine } from './util.mjs';

export async function integrateCandidate(rt, key, message) {
  if (rt.workflow.publishOwner && rt.workflow.publishOwner !== key) fail('PUBLISH_BUSY', 'another item is being published');
  const { checkoutRoot } = rt.session.paths, folder = rt.session.descriptor.matchId, wt = rt.wtPaths(key);
  const j = rt.journal, ji = j.item(key);
  const files = await changedFiles(wt.worktreeRoot, 'HEAD');
  const outside = files.filter(f => !f.path.startsWith(`${folder}/`));
  if (outside.length) fail('PATH_NOT_ALLOWED', outside.map(f => f.path).join(', '));
  await rt.requireGate(key, wt.worktreeRoot);
  if (ji.integratePlan && files.length) fail('INTEGRATION_PENDING', 'finish the frozen integration before changing the candidate');
  if (files.length) {
    await git(['add', '--', folder], { cwd: wt.worktreeRoot });
    await git(['commit', '-m', oneLine(`${key}: ${message ?? 'work'}`, 120)], { cwd: wt.worktreeRoot });
  }
  const head = await revParse(wt.worktreeRoot);
  if (head === ji.worktreeBase) fail('NO_CHANGES', 'worktree has no commit to integrate');
  let plan = ji.integratePlan;
  if (plan && plan.head !== head) fail('INTEGRATION_PENDING', 'worktree HEAD differs from frozen integration plan');
  if (plan?.pending) {
    const pending = plan.pending, current = await revParse(checkoutRoot);
    if (current !== pending.parent) {
      const msg = (await git(['show', '-s', '--format=%P%n%B', 'HEAD'], { cwd: checkoutRoot })).out.replace(/\r\n/g, '\n');
      if (!msg.startsWith(`${pending.parent}\n`) || !msg.includes(`(cherry picked from commit ${pending.sha})`)) {
        fail('INTEGRATION_DIVERGED', 'main moved unexpectedly; preserve the integration plan and reconcile before continuing');
      }
      plan.cursor++; plan.pending = null; j.save();
    } else {
      const picking = await git(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { cwd: checkoutRoot, allowFail: true });
      if (picking.code === 0) {
        if (picking.out !== pending.sha) fail('INTEGRATION_DIVERGED', 'another cherry-pick is in progress');
        await git(['cherry-pick', '--abort'], { cwd: checkoutRoot });
      }
      plan.pending = null; j.save();
    }
  }
  if ((await git(['status', '--porcelain', '--untracked-files=no'], { cwd: checkoutRoot })).out) fail('WORKTREE_CONFLICT', 'main has uncommitted changes');
  if (!plan) {
    const commits = (await git(['rev-list', '--reverse', `${ji.integratedWorktreeHead ?? ji.worktreeBase}..${head}`], { cwd: checkoutRoot })).out.split(/\r?\n/).filter(Boolean);
    plan = ji.integratePlan = { head, mainBefore: await revParse(checkoutRoot), commits, cursor: 0, pending: null }; j.save();
  }
  for (const sha of plan.commits.slice(plan.cursor)) {
    plan.pending = { sha, parent: await revParse(checkoutRoot) }; j.save();
    const pick = await git(['cherry-pick', '-x', sha], { cwd: checkoutRoot, allowFail: true });
    if (pick.code !== 0) {
      const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: checkoutRoot, allowFail: true })).out;
      await git(['cherry-pick', '--abort'], { cwd: checkoutRoot, allowFail: true });
      plan.pending = null;
      if (plan.cursor === 0) delete ji.integratePlan;
      j.save(); fail('WORKTREE_CONFLICT', `cherry-pick conflicts: ${conflicts || 'unknown'}; worktree preserved`);
    }
    plan.cursor++; plan.pending = null; j.save();
  }
  const headRevision = await revParse(checkoutRoot), count = plan.commits.length, mainBefore = plan.mainBefore;
  ji.integratedRevision = headRevision; ji.integratedWorktreeHead = head; delete ji.integratePlan;
  const { fixedNow, sync } = rt.recordBaselineFix(key); j.save();
  return { integrated: true, headRevision, commits: count, baseChanged: mainBefore !== ji.worktreeBase,
    ...(fixedNow.length ? { baselineFixed: fixedNow, syncWorktrees: sync } : {}),
    hint: `${mainBefore !== ji.worktreeBase ? 'Main moved: run_gate where=main before push. ' : ''}Run commit_and_push or resume publish_item.${sync.length ? ` Sync yielded worktrees ${sync.join(', ')} after publishing the baseline fix.` : ''}` };
}
