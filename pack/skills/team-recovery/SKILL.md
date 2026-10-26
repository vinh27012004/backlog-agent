---
name: team-recovery
description: MTM RESUME turn after a restart. Restore state from the progress log, journal, git and the server, then continue preparation or the game without duplicating work or submissions.
---

# Team recovery (RESUME_PREPARATION_V1 / RESUME_GAME_V1)

1. `configure_session` with the RESUME frame copied verbatim. Its result shows what the log and
   journal already contain (stages, backlog statuses, open blockers, published revisions, receipts).
2. `report_progress` with `{"type":"ORCHESTRATOR_RESTARTED","phase":"PREPARATION"|"GAME","reason":"<frame.reason>","summary":"Orchestrator restarted; reconciling state."}`.
   The helper fills `attempt`.
3. Never clear, reclone or reset the existing checkout. Never discard uncommitted work blindly:
   look at `git status` first.

## RESUME_PREPARATION
Follow `.agents/skills/game-preparation/SKILL.md` but skip stages already COMPLETED. `prepare_checkout`
verifies the existing checkout instead of cloning. `report_ready` will not write a second, different
`ENVIRONMENT_READY`.

## RESUME_GAME
1. `login_match`, then `refresh_match`.
2. For every item the journal shows with a `submitIntent` but no receipt: call `submit_work` with the
   same revision; the helper resends the identical body and gets the stored receipt.
3. Items `published` but not submitted: `submit_work`. Items `started`: their worktrees survive the
   restart (`worktree status`); subagents do not. Run `run_gate` on the worktree to see where the item
   stands, then brief a new `team_fixer` with that result as `<previous_attempt>`.
4. Continue with `.agents/skills/team-orchestrator/SKILL.md` from "Priorities and time".
