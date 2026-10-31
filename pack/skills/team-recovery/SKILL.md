---
name: team-recovery
description: Resume MTM preparation/game from durable journal, git and server state without duplicating work or submissions.
---

# Recovery
Configure the RESUME frame verbatim, report ORCHESTRATOR_RESTARTED (helper supplies attempt).
Do not reclone, erase journal, discard work or assume old native threads/jobs survive.
PREPARE follows game-preparation while skipping completed stages.

GAME: login_match, refresh_match, next_actions.
- Pending submitIntent without receipt: replay submit_work with the original revision before changing candidate.
- Published candidate: publish_item resumes its checkpoint. Receipt already present means no second POST.
- Missing RAM jobs: recreate the gate; stable candidate/proofs/reviews remain in journal and are checked again.
- Pending integration plan: resume publish to reconcile the frozen cherry-pick before allowing worker writes.
- Incomplete worker/repair: spawn a new native worker with saved worktree/materials and the COMPLETE todo,
  continue version numbering, register its thread using worker_checkpoint resume.
- Stale/yielded worktree: sync only without a writer or pending submission, refresh affected evidence, and preflight
  a new numbered result. Never overwrite a prior handoff to make an old gate look current.

Continue .agents/skills/team-orchestrator/SKILL.md. Only root performs native agent operations.
