---
name: team-recovery
description: Resume MTM preparation/game from durable journal, git and server state without duplicating work or submissions.
---

# Recovery
Configure the RESUME frame verbatim, report ORCHESTRATOR_RESTARTED (helper supplies attempt).
Do not reclone, erase journal, discard work or assume old native threads/jobs survive.
PREPARE follows game-preparation while skipping completed stages.

GAME: configure_session boots the match itself (`boot`); without `boot.ok`, call login_match and refresh_match. Then next_actions.
- Pending submitIntent without receipt: replay submit_work with the original revision before changing candidate.
- Published candidate: publish_item resumes its checkpoint. Receipt already present means no second POST.
- Missing RAM jobs: a handed-off fix-result is published again with publish_item; the candidate stays in the journal.
- Pending integration plan: resume publish to reconcile the frozen cherry-pick before allowing worker writes.
- Incomplete worker: spawn a new native worker with saved worktree/materials, continue version numbering, register
  its thread using worker_checkpoint resume.
- Stale/yielded worktree: sync only without a writer or pending submission, refresh affected evidence, and hand off
  a new numbered result. Never overwrite a prior handoff.
- Then work through next_actions in its order like any other turn, prepare_item included: an item that was waiting
  for a slot before the restart is still owed its start. Recovering old items never replaces that list.

Continue .agents/skills/team-orchestrator/SKILL.md. Only root performs native agent operations.
