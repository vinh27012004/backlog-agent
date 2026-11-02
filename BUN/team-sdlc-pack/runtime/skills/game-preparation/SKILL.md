---
name: game-preparation
description: MTM PREPARE turn. Clone the assigned repository, prepare and build the environment, log in to the match portal, report ENVIRONMENT_READY, then end the turn.
---

# Game preparation (PREPARE_GAME_V2 / RESUME_PREPARATION_V1)

You have about 10 minutes. Everything goes through the `team_runtime` MCP tools. Do not write the
progress log yourself, do not call Preparation Complete, do not start backlog work, do not push.

1. `configure_session` with the frame copied **verbatim**: from the marker line (`PREPARE_GAME_V2` or
   `RESUME_PREPARATION_V1`) through the descriptor JSON line and every policy block after it.
   If it fails with `INVALID_FRAME`, re-copy the exact text; never edit values.
2. `prepare_checkout`. On `GIT_AUTH_FAILED` the helper has opened a blocker: end the turn with a
   one-line summary.
3. `setup_environment` (starts a background job). While it runs, call `login_match`.
4. Wait for the job: `job_status` with `waitSeconds: 45` (repeat) or `wait_for_update` until `JOB_DONE`.
5. If the job result has `build: "FAIL"` or the ENVIRONMENT stage failed:
   - Read `<matchRoot>/env-require/README.md` (if present) and the step tails in the job result.
   - Fix only environment problems (missing `.env` values, a missing service, dependency install).
     Never change application source or tests during preparation.
   - Run `setup_environment` again. Stop retrying after two attempts and end the turn: the failed
     stage stays visible to the organizer.
6. `report_ready`. It writes `ENVIRONMENT_READY` only when every stage is COMPLETED.
7. End the turn with one line, for example `Prepared: build PASS, login PASS, revision <12 chars>.`

Rules:
- `.env` values come from the helper (machine config + generated secrets). Never print them.
- Do not run long commands yourself while the job is running; the helper owns build and tests.
- If time is short (over 8 minutes used), skip optional checks and report readiness as soon as build and
  login have passed.
