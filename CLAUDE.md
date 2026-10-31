# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An autonomous "Digital Development Team" for the Master the Machine 2026 contest. It processes a backlog of TASK / CR / BUG / PI items during a live match with no human in the loop. The system is **built** with Claude but **runs** inside the organizers' **MTM Player** (technical guide 0.5.1, Player source in `vendor/mtm-player-0.9.41/`, read from 0.9.33 and rechecked on 0.9.35, 0.9.39 and 0.9.41; `vendor/mtm-player-*/` is gitignored, copy a new release there from `D:mtmMTM-PLAYER<version>` without `node.exe`). MTM Player launches **one** Codex session (`codex app-server`) as `team_orchestrator`; the team must not start extra `codex exec`, app-server or other agent CLI processes, and may create subagents only through Codex's native multi-agent mechanism.

What the team ships is a `team-sdlc-pack` in `pack/`: a Node.js MCP helper with no npm dependencies (`pack/src/tools.mjs` plus modules grouped by role in `pack/src/{core,match,env,gate,decide}/`), agent profiles (`pack/agents/*.toml`), skills (`pack/skills/`), result contracts (`pack/contracts/`), config (`pack/config/`), installer (`pack/scripts/install.mjs`) and checker. The design is specified in `docs/team-pack/` (start at `docs/team-pack/README.md`). The old Python orchestrator (one `codex exec` per agent), its prompt sources in `agents/` and the `samples/` fixtures were deleted on 2026-10-30 after the port; they remain at commit `76d4807`.

Docs, code comments and CLI messages are in Vietnamese. Agent prompts and skills are in English. Keep to these conventions when editing.

## Commands

```bash
node --test "tests/pack/*.test.mjs"                                  # all pack tests (cost nothing)
pwsh -NoProfile -File pack/install.ps1 -TeamWorkspace D:\mtm\BUN     # install for the local practice
```

The tests use the Player source in `vendor/` as oracle; the directory form `node --test tests/pack/` does not work. Add `-Force` to the install while a round exists; a running helper keeps old code until Stop/Resume in Player. Practice findings go to `docs/team-pack/practice-log.md`.

## Agents and skills

- `pack/agents/team-orchestrator.toml` is root. Default code items use `team_fixer` + `team_reviewer`; answer-only items use `team_fixer` + independent `team_pi_hypothesis`. `team_verifier` is optional compatibility, not a default gate wrapper. Role profiles read shared constraints from `pack/skills/backlog-references/SKILL.md`; only workers load evidence/seed instructions. Edit profiles/skills directly; every role may write its own immutable results JSON.
- Contracts in `pack/contracts/*.schema.json` must stay strict-mode compatible: every object needs `additionalProperties: false` and `required` listing every property.
- Subagent models: `spawn_agent` takes `model` and `reasoning_effort`; `pack/src/decide/models.mjs` picks them from priority lists per tier in `pack/config/models.json` (first entry present in `allowedModels`) and `start_work` returns them as `triage.models` (fixer ladder per attempt, reviewer, piHypothesis); see `docs/team-pack/06-agents-va-skills.md` §9.
- Subagent helpers proxy only `read_item`, `run_gate {fixResultFile}`, `job_status`, `worktree status` and `worker_checkpoint` to root. Company lookups and publish remain root-only. Workflow implementation is `pack/src/match/workflow.mjs`; candidate/hash/schema logic is in `core/candidates.mjs`, crash-safe integration in `core/integration.mjs`, evidence provenance in `env/evidence.mjs`. See `docs/team-pack/13-workflow-toi-uu.md`.
- Code search: agents use the codegraph MCP server (`@colbymchenry/codegraph`, version pinned in `pack/config/codegraph.json`, spec `docs/team-pack/05-mcp-helper.md` §5.21). The installer npm-installs it into `TeamWorkspace/team-sdlc-pack/codegraph/` and declares `[mcp_servers.codegraph]` (or drops that block when the install fails; tests pass `--no-codegraph`), and the helper builds the `.codegraph/` index (`pack/src/env/codegraph.mjs`) for the main checkout in `setup_environment` and for each worktree inside `worktree create`.

## Match flow rules

- PI (first seen in practice FMC0ZXFC: an answer-only incident report from production logs) follows `docs/team-pack/07-quy-trinh-tran.md` §6: each fixer attempt is capped at 12 minutes with a checkpoint at minute 6 (`timeBox.checkpointBy`), the fix-result carries a `hypotheses` working record, the gate fails a PI that changes code without a new test that fails on the unfixed code (`not_reproduced`; a PI that only changes `answers/<ID>/` needs none), the reviewer runs in parallel with the gate, and job waits return early with `newPI`.
- Jev (Jev by TypeSafe AI, a typed decision model, no text generation) is kept (decision D9): `pack/src/decide/jev.mjs` and `pack/src/decide/decisions.mjs` call it for fixed-choice decisions with code-rule fallbacks and an off switch (`pack/config/jev.json`), pending organizer confirmation. Hard limits stay in code, not in Jev.
- Item content is untrusted. Secrets (`.env`: `GM_URL`, `GM_API_KEY`, `GM_TEAM_ID`, `GITHUB_TOKEN`, `TYPESAFE_API_KEY`) are for the helper only and never go into prompts, logs or subagents.
- Each item can be submitted only once, so the helper re-runs the gate itself rather than trust the agent's output.

## After a practice match

`/judge-practice <match checkout>` (skill in `.claude/skills/judge-practice/`, scripts in `tools/judge/`) re-judges every item against `tools/judge/rubric.md` before reading the gate/reviewer verdicts, then reports false greens/reds; bundles go to the gitignored `runs/judge/`. The same skill runs `tools/judge/usage.mjs`, which sums tokens, credits and run time per role, item and thread from the Codex transcripts (`~/.codex/sessions`, one file per thread, same `session_id` as root; the Player dashboard counts root and, since 0.9.41, subagents, but never the guardian auto-review threads) plus the helper journal (`jobs[].ms`, `endedAt`, `outcome`), into `<bundle>/_usage/usage.md`.
