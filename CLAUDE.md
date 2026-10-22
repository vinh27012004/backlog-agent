# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An autonomous "Digital Development Team" for the Master the Machine 2026 contest. It processes a backlog of TASK / CR / BUG / PI items during a live match with no human in the loop. The system is **built** with Claude but **runs** on **Codex CLI** (`codex exec`, verified against codex-cli 0.162.1). Each "agent" is one `codex exec` call. The Python orchestrator decides which agent to call, builds its prompt, and reads back JSON that a schema forces into shape.

**JEV is not a Codex agent.** It is **Jev by TypeSafe AI**, a typed decision model (no text generation) that the orchestrator calls over HTTP for fast fixed-choice decisions. There is no separate analysis agent: the fixer analyses the item itself in its first step.

Docs, code comments and CLI messages are in Vietnamese. The agent prompts under `agents/` are in English. Keep to these conventions when editing.

## Commands

The code needs **Python 3.11+** (`tomllib`). On this machine the default `python` is 3.10, so use `py -3.13`.

```bash
py -3.13 -m unittest discover -s tests -v                    # all tests (cost nothing)
py -3.13 -m unittest discover -s tests -k test_route_pi_never_reviews   # one test (by name or class, e.g. -k ProfileTest)

py -3.13 -m orchestrator.cli profile D:/path/to/repo          # detect stack -> project profile JSON
py -3.13 -m orchestrator.cli prompt fixer --item samples/items/BUG-07.json --repo D:/path/to/repo   # print prompt, no $
py -3.13 -m orchestrator.cli agent fixer --item samples/items/BUG-07.json --mock   # replay mock output, no $
py -3.13 -m orchestrator.cli decide triage --item samples/items/PI-03.json --mock  # Jev decision with fake answers, no API call
py -3.13 -m orchestrator.cli runs                             # per-role run stats from runs/state.db
```

`python -m unittest tests.test_agents` does not work, because `tests/` has no `__init__.py` and the name clashes with an installed `tests` package. Use `discover -k` instead.

Known on Windows: `LiveRunWithFakeCodexTest` is skipped because the fake codex is a shebang script. Tests that open a `Store` must close it (use `with Store(...) as store:`), or Windows cannot delete the temp dir because the SQLite file is still locked.

A live Codex run costs real money from a fixed $50 budget. It needs `codex` on PATH, `CODEX_HOME` set to `config/codex-home/` and logged in there, and `--workdir` pointing at the target repo. A live Jev call needs `TYPESAFE_API_KEY` in the environment. Don't start live runs unless asked; use `--mock` or the `prompt` subcommand.

## Architecture

**Agent pipeline** (`orchestrator/`):
- `config.py`: loads `config/agents.toml`. A role's settings are `[defaults]`, then `[roles.<name>]`, then `[roles.<name>.by_type.<TYPE>]`, then `[tiers.<tier>]` (model + effort, only when a tier is passed), later entries winning. `small`/`strong` are labels that `Decider.route()` asks Jev to pick; Jev has no such modes itself. `item_type()` takes the type from the ID prefix (`BUG-07` gives `BUG`); this step never uses an LLM.
- `prompt.py`: `build_prompt()` puts the static parts first so the API prompt cache works: `rules/common.md`, then role, skill (fixer and reviewer only, picked by item type), references (`bug-patterns` for fixer BUG, `pi-triage` for fixer PI and pi-hypothesis, `retry-playbook` when there is a previous attempt), stack packs, and project profile. The parts that change come after: item_meta, triage, fix_result, item, other_items, diff, gate_report, previous_attempt, hypothesis. Untrusted data is wrapped by `_fence()`, which escapes closing tags to block prompt injection.
- `profile.py`: pure-code stack detection (java/node/python/dotnet/go/php; monorepos give several stacks). It produces the build, test_all, test_one (`{target}` placeholder) and run_app commands, plus `forbidden_skip` markers for the gate. Adding a stack takes `agents/stacks/<id>.md` plus a detector added to `DETECTORS`.
- `agents.py`: `AgentRunner.run()` builds the command with `build_command()` (`--json --strict-config --ephemeral -s <sandbox> --output-schema ... -o ... -`, prompt on stdin), runs it with a timeout kill, streams JSONL through `events.feed()`, then checks the final message with `validate_output()`. Modes: `live` or `mock`. Mock replays `samples/mock/<role>/<ITEM>.jsonl`, falling back to `default.jsonl`. Every run writes `runs/<item>/<role>-<attempt>.{prompt.md,jsonl,last.json}` and a row in SQLite.
- `events.py`: parses the `codex exec --json` event stream (`thread.started`, `item.completed`, `turn.failed`, `error`, plus legacy pre-0.44 names) into trace events. `Reconnecting...` errors are left out of the trace.
- `store.py`: SQLite (`runs/state.db`) with tables `agent_runs`, `agent_events` and `jev_decisions`. The monitor will read from it. `Store` is a context manager; call `close()` when done.

**Jev decisions** (`orchestrator/jev.py`, `orchestrator/decisions.py`, `config/jev.toml`):
- `jev.py`: `JevClient` posts to `{base_url}/v1/systemone` with typed questions built by `noul()` (yes/no), `choice()` and `score()`. It uses only the standard library and wraps every failure in `JevError`. Without `TYPESAFE_API_KEY` or with `enabled = false`, `available` is false.
- `decisions.py`: `Decider` holds the decision points: `triage` (severity, difficulty, injection, module), `related`, `route` (fixer tier `small`/`strong`, reviewer yes/no), `claims_supported`, `root_cause_confirmed`, `next_action` (submit/retry/drop). Each one asks Jev first and falls back to a code rule on error or below the thresholds in `config/jev.toml`. Every decision is recorded in `jev_decisions`. `mock_transport` gives deterministic fake answers.
- Hard limits stay in code, not in Jev: `next_action` only offers actions that are valid (never `submit` when the gate failed), PI never gets a reviewer, and the injection check counts as "yes" when the regex heuristic matches even if Jev says no.

**Agents** (`agents/`, see `agents/README.md` for the full table): roles `fixer` (fix-result, workspace-write), `reviewer` (review, read-only) and `pi_hypothesis` (hypothesis, read-only, runs 2–3 in parallel when a PI is stuck). The role key in the config is `pi_hypothesis`; its prompt file is `roles/pi-hypothesis.md`. The fixer returns its own analysis in `criteria` and `suspects`.

**Schemas** (`agents/schemas/*.schema.json`) must stay strict-mode compatible: every object needs `additionalProperties: false` and `required` listing every property. `SchemaTest` enforces this and expects exactly 3 schemas.

**Design rules that shape the code** (from `docs/ARCHITECTURE.md`):
- The orchestrator does **not** read tokens or compute cost, because the organizers' Codex plugin does that. A test asserts that results have no `cost_usd`.
- Skills are injected into the prompt by code and never written to the contest repo as `AGENTS.md` or `.agents/`, which would pollute the submitted diff.
- Item content is untrusted. The Codex sandbox has no network. `config/codex-home/config.toml` strips `*KEY*`/`*TOKEN*`/`*SECRET*` env vars from shell commands and disables browser, computer-use, plugins and similar features. Secrets in `.env` (`GM_URL`, `GM_API_KEY`, `GM_TEAM_ID`, `GITHUB_TOKEN`, `TYPESAFE_API_KEY`; template in `.env.example`) are for team control code only and never go into prompts or logs.
- Each item can be submitted only once, so the orchestrator must re-run the gate itself rather than trust the agent's output.

**Not built yet**: the main `run` loop that wires triage → route → fixer → gate → reviewer → `next_action` → submit; gate, Log Condenser (error signature, fail kind) and MVS runner; wiring `route()`'s tier into the run loop (`AgentRunner.run(tier=...)` already maps it to a model and effort); MCP servers (`codegraph`, `runner`, `web`; declared in `config/codex-home/config.toml` with `enabled = false`), the MCP `control` server and Game Master client (including `FakeGameMaster`), queue and worktrees, and the monitor's SQLite hookup (`monitor/index.html` still uses sample data in `monitor/data.js`). See the roadmap in `docs/ARCHITECTURE.md` §11.

`config/codex-home/` is gitignored except `config.toml`. Codex writes sessions and auth there.
