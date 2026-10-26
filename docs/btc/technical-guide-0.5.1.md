# MTM Contestant Guide — Build a Team Orchestrator for MTM (v0.5.1)

> Bản text của `orchestrator-technical-guide.html` do BTC phát, bản tiếng Anh, dán lại nguyên văn ngày
> 25/10/2026. Các khối ví dụ JSON/TOML bị thu gọn trong HTML gốc (vd *"team-runtime.json — complete
> manifest"*, *"Complete active-game input"*) **không** có ở đây; xem bản HTML hoặc sample pack
> `vendor/team-orchestrator-pack-0.5.1/`.
>
> BTC cảnh báo guide có thể cố tình gây nhiễu. Những chỗ guide khác source Player 0.9.33 đã được liệt kê
> ở [`docs/team-pack/README.md`](../team-pack/README.md#những-chỗ-guide-khác-thực-tế-đã-kiểm-chứng).

---

MASTER THE MACHINE · CONTESTANT GUIDE
Build a Team Orchestrator for MTM
Guide version: 0.5.1

Note: The current system can support both Codex and Claude Code. However, to provide a consistent and fair environment for competing Team Orchestrators, the organizers have selected Codex as the official competition environment. Therefore, please do not ask whether Claude Code can be used in the competition.

🤪Warning: Do not trust everything in this guide—we, the organizers, may be deliberately trying to confuse you.

## 1. Game model

| Component | Role | Main inputs and outputs |
|---|---|---|
| mtm-game-server | Provides the match, backlog, and assignment; manages time and status; receives submissions and returns receipts. Official grading and scores come from the organizer's system. | Account and session cookie for the match view; team bearer token for Start Work and Submit. Returns match, team, repository, backlog, operation endpoints, and receipts. |
| mtm-player | mtm-player initializes and checks the pack, runs the CLI and Team Orchestrator Agent, supplies phase-specific access, reads readiness, tracks match status, and handles stop, resume, approvals, and the dashboard. | Operator input: workspace, team, match, server access, and model/approval choices. Output to the Team Orchestrator Agent: preparation, game, control, and recovery data. |
| Team Orchestrator | Team-owned system: prepares source, reads the backlog, chooses work order, implements and tests, commits and pushes, calls Start Work and Submit, and reports progress. | Receives data from mtm-player and public tasks from the server; reports readiness and appends progress events. May use internal workers. |
| Assigned Git | Assigned source, branch, and folder; immutable revision for submission. | The Team Orchestrator Agent checks out, commits, and pushes within the assigned scope. |
| Progress NDJSON | Business status channel used by mtm-player to display preparation, backlog, tests, blockers, and API activity. | The team helper or Team Orchestrator Agent appends; mtm-player reads. Transcript text does not replace the log. |

mtm-game-server decides match status and acceptance. The progress log reports team status, and the transcript does not replace mandatory logs.

## 2. Suggested orchestrator structure

The diagram proposes a Team Orchestrator acting as Project Manager with four specialist agents. The agents folder in the example pack follows the same structure: each TOML file has the corresponding agent name and a description. This is a reference structure; the registrations accepted by mtm-player may depend on its version. MCP Helper and Progress NDJSON are shared runtime components.

- TEAM ORCHESTRATOR — Project Manager • coordinate • make final decisions
- BUSINESS ANALYST — Requirements • acceptance criteria
- DEVELOPER — Design • code • integration
- CYBER SECURITY — Guardrails • secrets • scope
- TESTER — Test • regression • evidence
- MCP HELPER — NODE.JS — Session • Game API • retry; Credential-safe runtime
- PROGRESS NDJSON — Readiness • backlog • tests • blockers; mtm-player reads this file

Without a complete and valid progress log, mtm-player cannot accurately track the team's status.

**MUST NOT** — The Team Orchestrator may spawn subagents only through the provider's native mechanism within the active CLI session. It must not launch additional Codex CLI, Claude Code CLI, app-server, or other independent CLI processes to perform match work.

| Module | Responsibility |
|---|---|
| Team Orchestrator Agent | Acts as Project Manager: receives lifecycle input, selects backlog work, assigns tasks, reviews results, integrates changes, and owns the final decision. |
| Business Analyst | Reads the backlog and clarifies requirements, acceptance criteria, constraints, and inputs for the Developer and Tester. |
| Developer | Explores the source, designs and implements changes, runs technical checks, and prepares the commit. |
| Cyber Security | Checks guardrails, workspace and network scope, credential handling, and actions that may cause violations. |
| Tester | Derives test scenarios from acceptance criteria, runs regression tests, and verifies results and evidence before submission. |
| MCP Helper — Node.js | Shared runtime for the session, in-memory cookie and bearer token, Game API, retry and idempotency, and progress-log appends. Agents call the helper instead of holding credentials or issuing HTTP requests themselves. |
| Progress NDJSON | Mandatory status file used by mtm-player to read readiness, backlog, tests, blockers, and API activity. MCP Helper appends one JSON object per line to the exact progressLogFile; the transcript does not replace this file. |

### Agent declaration structure

The following structure example corresponds to the Developer role in the diagram and uses the file `agents/team_developer.toml`. The value of `name` must match the agent name in the filename (excluding the `.toml` extension). These profile files show declaration structure only; they contain no instructions or implementation source.

### Source package and installed workspace folder layout

Checkout root and match root: use the absolute paths supplied by mtm-player. `checkoutRoot` contains the Git checkout and `.git/`. `matchRoot = checkoutRoot/repository.folder` contains the assigned source, public challenge files, answers, and evidence. The repeated match ID in the example is intentional: the outer directory identifies the local checkout, and the inner directory comes from the server repository assignment.

Clone into checkoutRoot; build, test, and write answers inside matchRoot. A specialist worktree uses its own `worktreeRoot/repository.folder` as matchRoot. Pass both paths to the specialist. The compatibility field `challengeWorkspace` may point to `matches/`; use the explicit roots rather than treating that field as the source folder. Do not edit sibling match folders. Init/reset applies only to the selected match checkout; existing matches remain available. Resume uses the saved paths and preserves completed work.

### Helper tools to implement

| Suggested tool | Input | Output and behavior |
|---|---|---|
| configure_session | descriptor, modelPolicy if present | Validate session and paths; preparation derives paths from trusted cwd; start retains the verified match session and repository while replacing the bearer client; resume replaces access from fresh input. |
| login_match | {} | Authenticate the cookie session; return only a safe status. |
| refresh_match | {} | Current match view; verify identity and repository; emit DISCOVERED for new items only during active play. |
| start_work | backlogItemKey | Return public requirements, template, and scenarios; log before and after HTTP calls. |
| submit_work | clientSubmissionId, backlogItemKey, gitRevision, answer | Return the official receipt; keep the UUID unchanged when the outcome is uncertain. |
| report_progress | event without the envelope | Add schemaVersion and playerSessionId and append a schema-valid event. |
| wait_for_update | timeoutMs ≤ 55000 | Bounded serial polling; return on a change or timeout; stop on control messages. |

Use newline-delimited JSON-RPC for MCP over stdin/stdout. Implement initialize, notifications/initialized, tools/list, and tools/call. Each tool in tools/list needs an inputSchema. Write only JSON-RPC to stdout; tool output is safe JSON in a text content block. Bound request time, response size, redirects, and origins.

## 3. From spawn to match end

MUST log GAME_MASTER_API REQUESTED immediately before every login, refresh, Start Work, and Submit request; log SUCCEEDED or FAILED immediately after the result, including errors.

1. mtm-player spawns a new Team Orchestrator Agent — INPUT: team T01, match ABCD1234, repo/branch/folder, account, origins, model list
2. MUST: ORCHESTRATOR_STARTED — OUTPUT log: schemaVersion=1, playerSessionId, type, summary
3. Verify Git access → check out the assigned source — INPUT: repository.url, branch=main, folder=ABCD1234; OUTPUT: full revision
4. Install dependencies → build → baseline checks — MUST log PREPARATION_STATUS: GIT_AUTH / REPOSITORY / ENVIRONMENT / BUILD
5. Log in at the mtm-game-server URL supplied by mtm-player — INPUT: username + password from mtm-player; OUTPUT: successful login
6. Open https://ai-fest-five.vercel.app/match/ABCD1234 — INPUT: matchId from mtm-player; OUTPUT: page for the assigned match, team, repository, and backlog
7. MUST: MATCH_LOGIN completed + ENVIRONMENT_READY — LOG: requestId, repo, revision, build=PASS, matchLogin=PASS
8. Report environment readiness — OUTPUT: status=ENVIRONMENT_READY, requestId, repository, revision, build, matchLogin
9. mtm-player sends Preparation Complete — OUTPUT: PREPARED; mtm-player waits for official IN_PROGRESS status
10. mtm-player authorizes backlog work — INPUT: bearer key + length/hash, API scopes/origins, paths, prepared revision
11. Read /match/ABCD1234 after login — OUTPUT: current backlog and operation instructions displayed by mtm-game-server
12. MUST: BACKLOG_SYNC completed; DISCOVERED for each item — LOG: backlogId, title, status=DISCOVERED, revision=null, receiptId=null
13. POST /api/v1/matches/<UUID>/backlogs/start — BODY: {backlogItemKey:"TASK-01"}; OUTPUT: source template/scenarios; Team Orchestrator materializes answers/<ID>/submit.json and evidence/
14. MUST: BACKLOG_STATUS IN_PROGRESS; BACKLOG_TESTS NOT_RUN — Log IN_PROGRESS only after Start Work is accepted
15. Implement → run tests → complete the answer — MUST: tests RUNNING, then PASSED/FAILED; include required/executed/passed/failed/skipped
16. Commit and push to the assigned branch — OUTPUT: full pushed Git SHA; source/tests/evidence/answer in the same commit
17. POST /api/v1/matches/<UUID>/submissions — BODY: clientSubmissionId, backlogItemKey, gitRevision, answer; HEADER: Idempotency-Key
18. Server returns a receipt or error — Example OUTPUT: receiptId + status=RECEIVED; this does not mean grading has passed
19. MUST: BACKLOG_STATUS SUBMITTED — LOG: full revision + official receiptId; refresh and repeat for the next backlog item
20. mtm-player signals a pause or match end — INPUT: sessionId, matchId, matchStatus=PAUSED / FINISHED / CANCELLED
21. Stop API calls, Git, workers, and polling; preserve source/evidence — On match end: log ORCHESTRATOR_ENDED; on pause: wait for mtm-player to resume
22. On resume: mtm-player starts a replacement Team Orchestrator Agent — INPUT: fresh access, paths, repository, restartAttempt, reason, prepared revision
23. MUST: ORCHESTRATOR_RESTARTED — Reconcile logs/Git/receipts; do not repeat accepted submissions

MUST: write logs to `<TeamWorkspace>/team-sdlc-pack/logs/<matchId>.progress.ndjson`. Example match: ABCD1234.progress.ndjson. When mtm-player supplies progressLogFile, MUST use that exact path; append one JSON object per line without overwriting the file.

### Step-by-step instructions

**1. Receive input and initialize.** The Team Orchestrator Agent receives session, team, match, repository, Git read access, account, password, allowed origins, and model policy. Read workspace AGENTS.md. No team bearer key is available in this step.

**2. Source Check Out.** The Team Orchestrator Agent checks host-provided Git access and checks out the assigned repository, branch, and folder under challenge. MUST append PREPARATION_STATUS for GIT_AUTH and REPOSITORY when each check starts and ends; report COMPLETED only after verifying source and revision. Do not push during preparation.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"PREPARATION_STATUS","stage":"GIT_AUTH","status":"COMPLETED","summary":"Git access to the assigned repository verified."}
{"schemaVersion":1,"playerSessionId":"session-example","type":"PREPARATION_STATUS","stage":"REPOSITORY","status":"COMPLETED","summary":"Checked out the assigned repository, branch, folder, and revision."}
```

**3. Environment Setup.** The Team Orchestrator Agent checks Git, Node.js/npm, or the toolchain actually required by the source; installs locked dependencies; runs baseline tests and the build. MUST append PREPARATION_STATUS for ENVIRONMENT and BUILD at the start and end of each check. Report COMPLETED only for real success; report FAILED/BLOCKED on failure and do not emit ENVIRONMENT_READY.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"PREPARATION_STATUS","stage":"ENVIRONMENT","status":"COMPLETED","summary":"Required toolchain and dependencies are ready."}
{"schemaVersion":1,"playerSessionId":"session-example","type":"PREPARATION_STATUS","stage":"BUILD","status":"COMPLETED","summary":"Baseline checks and build passed."}
```

**4. Log in to mtm-game-server.** Open the mtm-game-server URL supplied by mtm-player. Log in with the supplied username and password. Then explicitly open the page for the assigned matchId; do not rely on the default redirect. Example URL: https://ai-fest-five.vercel.app/ ; Username/Password: supplied by mtm-player.

**5. Open the exact match and verify assignment.** After logging in, visit /match/<matchId> on the same mtm-game-server. For example, matchId ABCD1234 means https://ai-fest-five.vercel.app/match/ABCD1234. Read the match, team, repository/branch/folder, and backlog shown there. Verify them against mtm-player input. During preparation, verify access and assignment only; do not start backlog work. MUST open the page for the exact matchId; the generic /match page does not identify the task. Output is the visible match information and authorized backlog, without requiring a specific internal API response.

**6. Write the readiness log.** MUST log MATCH_LOGIN completed, then append an ENVIRONMENT_READY event to the exact progressLogFile through the team's progress writer/helper. mtm-player polls the log file, validates the event, and handles the required steps with mtm-game-server. The Team Orchestrator Agent does not send this JSON to an mtm-player API or need a parent task to forward it. The CLI final response may repeat the result for the reader; it does not replace the mandatory log. Flow: Team Orchestrator Agent → helper appends ENVIRONMENT_READY → progressLogFile → mtm-player polls and validates → mtm-player handles readiness with mtm-game-server. If the append does not succeed, mtm-player has not received readiness even if the transcript says preparation is complete.

**7. Wait for mtm-player to acknowledge preparation.** mtm-player verifies readiness, reports preparation status to mtm-game-server, and waits for the system to accept it. The Team Orchestrator Agent does not perform this operation or write the milestone owned by mtm-player. Begin backlog work only after mtm-player supplies active-game input. There is no separate operator command to start backlogs after preparation completes.

**8. Receive active-game access.** Validate environmentRevision, bearer UTF-8 length and SHA-256, origins, scopes, paths, and hostAuthorization. The helper retains repository and account information from preparation; start does not repeat them.

**9. Synchronize and report the backlog.** Reopen /match/<matchId>; report BACKLOG_SYNC in progress and completed. MUST log DISCOVERED for each new visible item, including unselected work. Do not duplicate an event already emitted by the background helper.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"GAME_START_STATUS","stage":"BACKLOG_SYNC","status":"COMPLETED","summary":"Retrieved the current backlog."}
{"schemaVersion":1,"playerSessionId":"session-example","type":"BACKLOG_STATUS","backlogId":"TASK-01","title":"Fix customer search","status":"DISCOVERED","summary":"Work status updated.","revision":null,"receiptId":null}
```

**10. Start Work before editing.** The Team Orchestrator Agent calls POST /api/v1/matches/<match.id UUID>/backlogs/start on mtm-game-server to begin one backlog item. Send the team bearer key in Authorization and the selected backlogItemKey in the JSON body. mtm-game-server confirms Start Work and returns the template and scenarios. Only after acceptance does the Team Orchestrator Agent log IN_PROGRESS and begin editing source. Accept and Content-Type are application/json.

```json
{ "backlogItemKey": "TASK-01" }
```

MUST — Canonical submission paths: A file such as challenge/TASK-01-submit.json returned by Start Work is a source template only. Copy its content to `<repository.folder>/answers/TASK-01/submit.json`. Store every evidence file in `<repository.folder>/answers/TASK-01/evidence/` and reference it in JSON as `evidence/<filename>`. Never create or commit evidence under `<repository.folder>/evidence/` or `<repository.folder>/challenge/evidence/`. The team may enforce this contract with MCP, a helper, or another implementation.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"GAME_MASTER_API","operation":"START_WORK","backlogId":"TASK-01","method":"POST","origin":"https://ai-fest-five.vercel.app","path":"/api/v1/matches/11111111-1111-4111-8111-111111111111/backlogs/start","phase":"REQUESTED","httpStatus":null,"requestId":null,"summary":"Calling mtm-game-server."}
{"schemaVersion":1,"playerSessionId":"session-example","type":"GAME_MASTER_API","operation":"START_WORK","backlogId":"TASK-01","method":"POST","origin":"https://ai-fest-five.vercel.app","path":"/api/v1/matches/11111111-1111-4111-8111-111111111111/backlogs/start","phase":"SUCCEEDED","httpStatus":200,"requestId":"req-start","summary":"Received the mtm-game-server result."}
```

Before submitting, verify the exact Git revision contains `<repository.folder>/answers/<backlogId>/submit.json` and every referenced evidence file under its evidence/ directory. Finding files at repository-root answers/ is insufficient. Local writes use matchRoot/answers/…; Git checks use paths relative to checkoutRoot. Relative JSON references remain evidence/<filename>.

**11. Implement, test, and complete the answer.** Log IN_PROGRESS and BACKLOG_TESTS NOT_RUN; edit source; run required scenarios and relevant regression tests. In submit.json, evidence paths are relative to the backlog answer directory, for example evidence/TASK-01-TC-01.json; do not include answers/TASK-01/ in those JSON values. Report RUNNING and then PASSED/FAILED with real counts. If blocked, log BLOCKER_OPENED; when resolved, log BLOCKER_RESOLVED with the same ID.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"BACKLOG_TESTS","backlogId":"TASK-01","status":"NOT_RUN","required":2,"executed":0,"passed":0,"failed":0,"skipped":0,"summary":"Tests have not run."}
{"schemaVersion":1,"playerSessionId":"session-example","type":"BACKLOG_TESTS","backlogId":"TASK-01","status":"PASSED","required":2,"executed":2,"passed":2,"failed":0,"skipped":0,"summary":"Both required tests passed."}
```

**12. Commit and push to the assigned branch.** Complete the answer using the template. Commit source, tests, evidence, and answer together; push to the assigned repository and branch; obtain the full 40- or 64-character SHA. Do not submit an ambiguous HEAD reference. The answer does not contain gitRevision; the SHA belongs at the top level of the submission request.

**13. Submit the work.** The Team Orchestrator Agent calls POST /api/v1/matches/<match.id UUID>/submissions on mtm-game-server to submit the completed backlog item. The JSON body contains clientSubmissionId, backlogItemKey, gitRevision, and answer. Send the team bearer key in Authorization, use JSON headers, and set Idempotency-Key to clientSubmissionId. Log REQUESTED immediately before the call and its outcome immediately after the response.

```json
{
  "clientSubmissionId": "33333333-3333-4333-8333-333333333333",
  "backlogItemKey": "TASK-01",
  "gitRevision": "0123456789abcdef0123456789abcdef01234567",
  "answer": {
    "backlogId": "TASK-01",
    "status": "SUBMITTED",
    "changeSummary": "Fixed search and tested the required scenarios."
  }
}
```

```
Authorization: Bearer <runtime team key>
Accept: application/json
Content-Type: application/json
Idempotency-Key: 33333333-3333-4333-8333-333333333333
```

**14. Receive the receipt and update the log.** mtm-game-server returns a receiptId and submission intake status (such as RECEIVED). The receipt confirms intake, not grading. The Team Orchestrator Agent MUST log BACKLOG_STATUS SUBMITTED with the full Git SHA and official receiptId so mtm-player can display it. HTTP 2xx without an acceptance receipt is not enough to report SUBMITTED.

```json
{ "receiptId": "receipt-123", "status": "RECEIVED" }
{"schemaVersion":1,"playerSessionId":"session-example","type":"BACKLOG_STATUS","backlogId":"TASK-01","title":"Fix customer search","status":"SUBMITTED","summary":"Work status updated.","revision":"0123456789abcdef0123456789abcdef01234567","receiptId":"receipt-123"}
```

**15. Repeat while the match is active.** Refresh after each submission. Choose the next item or wait for publication; use bounded, non-overlapping polling. Example helper cadence: 5 seconds after success, 10 after an error. The Team Orchestrator Agent waits up to 55 seconds per tool call before checking again. On submit timeout, preserve the UUID and body; reconcile or retry with the same idempotency key. Empty backlog, expired login, or temporary access issues are waiting/blocker states, not match completion.

**16. Pause, end, and stop.** mtm-player sends session, match, and matchStatus. Stop new API, Git, tool, worker, and polling activity and pack-owned processes; preserve source and evidence. Do not log ORCHESTRATOR_ENDED for a pause. At match end, log the event if possible; do not submit further work.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"ORCHESTRATOR_ENDED","status":"COMPLETED","summary":"The match has ended; all activity has stopped."}
```

COMPLETED is a valid status for the ORCHESTRATOR_ENDED log event. The separate final result schema currently accepts only SUBMITTED/BLOCKED/FAILED; do not return COMPLETED in that schema.

**17. Resume the same round when mtm-player requests it.** mtm-player starts a replacement Team Orchestrator Agent with fresh access, repository, paths, restartAttempt, and reason. Read the existing log and reconcile Git and receipts before retrying; MUST log ORCHESTRATOR_RESTARTED. A new init is a new round even if it uses the same public match code.

```json
{"schemaVersion":1,"playerSessionId":"session-example","type":"ORCHESTRATOR_RESTARTED","attempt":1,"phase":"GAME","reason":"OPERATOR_RESUME","summary":"Reconciled state before continuing."}
```

### Mandatory log rules

Append one UTF-8 JSON object per line to the exact progressLogFile. The envelope contains schemaVersion=1, the current playerSessionId, and the canonical type. Do not add timestamps or arbitrary fields. Include all required fields, even null and zero. mtm-player owns PREPARE_COMPLETE; team code does not log this milestone.

| When | Event MUST | Required content |
|---|---|---|
| Fresh Team Orchestrator Agent | ORCHESTRATOR_STARTED | summary; first event, only once. |
| Preparation steps | PREPARATION_STATUS | stage GIT_AUTH/REPOSITORY/ENVIRONMENT/BUILD/MATCH_LOGIN; status IN_PROGRESS/COMPLETED/BLOCKED/FAILED; summary. |
| Build and login verified | ENVIRONMENT_READY | requestId, repository URL/branch/folder, revision, build PASS, matchLogin PASS. |
| Initial backlog sync | GAME_START_STATUS | stage BACKLOG_SYNC, status, summary. |
| Discover / state changes | BACKLOG_STATUS | backlogId, title, status, summary, revision, receiptId; SUBMITTED needs a real receipt. |
| Before, during, and after testing | BACKLOG_TESTS | backlogId, status, required/executed/passed/failed/skipped, summary; do not estimate counts. |
| Before and after API calls | GAME_MASTER_API | operation, backlogId/null, method, origin, path, phase, httpStatus/null, requestId/null, summary. |
| Blocked / recover | BLOCKER_OPENED / BLOCKER_RESOLVED | stable blockerId; OPENED also needs backlogId/null and summary. |
| Replacement Team Orchestrator Agent | ORCHESTRATOR_RESTARTED | attempt, phase PREPARATION/GAME, reason, summary. |
| Match end or unrecoverable contract failure | ORCHESTRATOR_ENDED | status COMPLETED/BLOCKED/FAILED and summary; do not log merely for pause or wait. |

Do not duplicate events written by the helper. DISCOVERED must not reset IN_PROGRESS or SUBMITTED. If append fails, keep a bounded queue and retry in order; report PROGRESS_LOG_UNAVAILABLE if recovery fails.

## 4. Guardrails against violations

The Team Orchestrator Agent and every team-started worker, tool, or process must stay within the scope granted by mtm-player and the contest rules.

| Guardrail MUST | Where to enforce it | Violations to avoid |
|---|---|---|
| Workspace and source | Use canonical paths and block links and path escapes. Access only the assigned source/folder; outside the source, append only to the designated log. | Reading another team's files, hidden tests, grader, answer keys, mtm-player private state, or another task's transcript. |
| Git repository/branch | Verify the assignment before Git operations; use ordinary commits and pushes only; do not force-push or change the remote. | Pushing to another repository, changing the remote, or resetting remote history. |
| Network/API | Allowlist the origin and match UUID; use exact Start/Submit paths and correctly scoped cookies or bearer tokens; block unexpected redirects. | Calling private grader, organizer, or mtm-player control APIs, or using a key outside the assigned server. |
| Credential | Keep credentials in helper memory; exclude them from shell arguments, logs, source, Git config, raw tool output, and worker prompts. | Saving passwords or bearer tokens in files or commits. Team code must not use mtm-player secrets. |
| Model policy | Use the latest allowedModels; the Team Orchestrator Agent and its descendants must not substitute a prohibited model. Report unknown when the provider does not supply the information. | Ignoring model policy or reporting fabricated token counts or models. |
| Lifecycle | MUST NOT: Subagents must remain in the same CLI session. MTM-player continuously monitors and will stop the entire agent tree if a violation occurs. | Launching Codex, Claude, app-server, or another CLI process to evade monitoring, continue after stop, or create agents outside the managed tree. |
| Submission paths | Treat challenge/<ID>-submit.json as source only; materialize answers/<ID>/submit.json and store evidence only under answers/<ID>/evidence/. | Using the template folder as the destination; committing root evidence/ or challenge/evidence/; putting repository-relative paths in JSON. |
| Telemetry | Emit required events at the correct milestone and follow the schema; exclude secrets and raw bodies; report actual receipts and test results. | Reporting SUBMITTED without a receipt or PASSED without tests, or fabricating events to conceal actions. |
| Approval/authentication | Route provider requests through mtm-player; keep the agent alive while pending; report a blocker if rejected or unavailable; the operator handles Git authentication. | Modifying mtm-player to bypass approvals or logging in with credentials outside the authorized scope. |

Actions outside these guardrails may be recorded as a Suspected Violation and handled under the contest rules.

Common problems:
- Expired cookie: reauthenticate the current session and refresh. Rejected bearer token: report a blocker and wait for authorized recovery.
- Server/request timeout: keep the submission UUID unchanged while the outcome is uncertain.
- No backlog available: keep the Team Orchestrator Agent waiting; do not return a terminal result.
- Workspace moved after installation: rerun the installer to update the MCP path and reload the provider session.

## 5. Package the team pack

### Naming and identity rules — MUST

Team Orchestrator Agent is the role; its required registered name is `team_orchestrator` (underscore), rather than `team-orchestrator`. Hyphens are used in file paths. The following names are current mtm-player compatibility requirements, not team names.

| Location | Required value |
|---|---|
| package.json → name | team-sdlc-pack |
| team-runtime.json → name / kind | team-sdlc-pack / mtm-team-runtime |
| entrypoint.rootAgentType | team_orchestrator |
| agents/team-orchestrator.toml → name | team_orchestrator |
| Orchestrator skill file (not a manifest field) | skills/team-orchestrator/SKILL.md |
| File identity in package | team-pack-info.json |
| Installed identity file | `<TeamWorkspace>/.mtm/team-pack-info.json`; the payload copy is in team-sdlc-pack/runtime/ |

The source folder, ZIP filename, and TeamWorkspace path may use the team's name (for example HNKSUPER); MUST NOT change the package name to the team name. mtm-player manages the runtime session, so no custom session name is needed. Teams may share a package name, but each MUST use its own teamId registered on mtm-game-server.

team-pack-info.json — exactly four fields; no additional fields:
- schemaVersion: integer 1.
- version: a string in X.Y.Z format; MUST match the version in package.json and team-runtime.json.
- teamId: the registered team code, not the team record UUID. Use 1–128 characters, starting with a letter or digit, followed only by letters, digits, underscores, periods, colons, or hyphens. MUST match the initialized team; mtm-player compares IDs without case sensitivity.
- teamName: the team name; 1–160 characters, with no leading or trailing whitespace, newline, or NUL. MUST use the actual team name instead of the example name.

For example, HNKSUPER uses teamId HNKSUPER, teamName HNK Super; HNK uses its own identity. The installer MUST keep the identity copies in the payload and .mtm synchronized. Changing only one copy may cause an mtm-player registration/payload mismatch.

The minimal pack uses Node built-ins, without npm dependencies or installation lifecycle hooks. mtm-player currently requires four provider profiles: team_orchestrator, team_repo_scout, team_feature_worker, team_quality_checker. These are profile registrations; the Team Orchestrator Agent may spawn subagents only through the provider's native mechanism in the same CLI session, when separating responsibilities is useful. The roles in section 2 may be performed by these profiles or by the Team Orchestrator Agent.

Collapsed in the HTML: *package.json — preserve the order of the files array*; *team-pack-info.json — replace ID/name/version before building*; *team-runtime.json — complete manifest for the minimal pack*; *Suggested Team Orchestrator Agent profile; no pinned model or permission overrides*; *config/codex.toml — the installer expands only this path*.

The auxiliary profiles use the registered names above. team_repo_scout handles Business Analyst and Cyber Security responsibilities; team_feature_worker handles Developer responsibilities; team_quality_checker handles Tester responsibilities. A given backlog may not require every profile to be spawned. The manifest must contain exactly the fields shown below. Additional root or entrypoint fields are rejected. Keep instructions in agent profiles and skill files; do not add capabilities, supportedMessages, isolation, or hostRequirements to this manifest. The Team Orchestrator Agent must still follow allowedModels from its input.

### Installer and checker responsibilities

- Accept an absolute TeamWorkspace, resolve paths, and reject symlinks, junctions, and unsafe targets.
- Verify the package, version, checksum, Team ID/name, and existence of every declared file. Create matches and team-sdlc-pack if missing.
- Copy package.json and package.files entries into runtime; copy profiles, skills, manifest, and identity to the layout in section 2.
- Expand the MCP arguments to absolute runtime paths, using JSON-quoted paths and forward slashes in TOML; keep the source package portable. mtm-player compares registration bytes exactly and accepts only this expansion.
- Reinstalling the same version must be idempotent. Upgrades replace only pack-owned files; do not delete match checkouts or logs or overwrite configuration outside the pack.
- The read-only checker verifies registration/payload parity, identity/version, schema/manifest, and a READY result; exit with a nonzero code on failure.
- Package the complete source, installer, checker, and checksum in a ZIP. For npm pack tgz, the outer installer must extract and verify it; do not pass a tgz to an installer that accepts only directories.

Collapsed in the HTML: *Minimal install.ps1 wrapper*.

### Operator commands

The operator selects the workspace and Load team pack in mtm-player, checks the identity, and initializes the session. Team runtime does not call private mtm-player APIs to initialize itself. Verify MCP initialize/tools/list and configure/report in a fresh provider context; installed files alone do not establish that the host loaded the tools.

### Wire markers for parser implementation

The sequence uses operation names. The parser must match the actual markers in the following table. Parse the JSON line after the marker and the model-policy suffix separately; do not parse the entire prompt as JSON.

| Operation | Actual input marker | descriptor.type |
|---|---|---|
| Preparation | PREPARE_GAME_V2 | PREPARE_GAME |
| Start backlog work | START_GAME_V4 | START_GAME |
| Resume preparation | RESUME_PREPARATION_V1 | RESUME_PREPARATION |
| Resume game | RESUME_GAME_V1 | RESUME_GAME |
| Pause | MATCH_PAUSED_V1 | MATCH_PAUSED |
| End | MATCH_ENDED_V1 | MATCH_ENDED |
| Model rule | MTM_MODEL_POLICY_V1 | schemaVersion, orchestratorModel, allowedModels, enforcement, catalogSource, catalogFetchedAt, instruction |

### Smoke test before delivery

Use a mock server with the fictitious data in this HTML to cover login/cookies, correct match identity, empty/new backlog, Start Work/templates, submission receipts, timeout retries with the same UUID, expired authentication, append failures, pause/end, and resume. Loopback HTTP is for mock-test mode only; production uses an allowed HTTPS origin. Test the final ZIP in a clean workspace and reinstall it; existing source must be preserved. Exclude credentials, actual match logs, caches, and hidden competition-system files from the archive.

---

English version · Schema and metadata snapshots come from the current source. API examples are not production data. The internal architecture is a suggestion; the team is responsible for compatibility and guardrails.
