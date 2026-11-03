---
name: resolve-pi
description: Resolve a Production Incident in any stack. Rapidly triage between Form A (Incident Report / Answer-Only) and Form B (Live Hotfix). Use deterministic scripting for log analysis, confirm root cause, and submit fast for maximum race points.
---

# PI (Production Incident)

A PI is a customer-reported production incident with tight deadlines and decaying race points.
Teams are ranked by when their PASSED submission arrives:
- 1st team: 100% of points
- 2nd team: 90% of points
- 3rd team: 75% of points
- Subsequent teams: 60% of points

**A wrong submission scores 0 and cannot be resubmitted.**
Speed comes from deterministic correlation and zero guesswork. Never spend time exploring unrelated parts of the codebase.

---

## Phase 0: 30-Second Triage (Form A vs Form B)
Check the item description, `<materials>`, and `template.json`:

### FORM A: Incident Report / Post-Mortem (Answer-Only, Zero Source Code Edits)
- **Indicators**:
  - Item explicitly states: "Out of scope: Changing the application source".
  - `template.json` contains SRE post-mortem fields (`rootCauseRelease`, `rootCauseComponent`, `containmentFlag`, `affected...`, `incidentRecord`, etc.) and no code `testResults`.
- **Golden Rule**: **DO NOT build the app, DO NOT start the app server, DO NOT run the full test suite, and DO NOT edit application code.**
- Target completion time: **3–4 minutes**.

### FORM B: Live Production Hotfix (Source Code Edit Required)
- **Indicators**:
  - Source code modification is permitted and required to fix a runtime bug/defect.
- Target completion time: **5–6 minutes**.

---

## Form A Playbook: Incident Investigation (Deterministic Scripting)

1. **Read Materials & KB**:
   - Check `<materials>` or `company/` directory for raw search logs, deploy logs, and KB articles.
   - KB articles (e.g. `KB-OPS-01`) dictate exact naming conventions (e.g. format of release IDs `rel-YYYYMMDD-N`, valid service names, feature flag keys).
2. **Apply SRE Triangle Correlation (in < 2 minutes)**:
   - Identify when the incident started (e.g. 10:05 UTC today).
   - Find the deploy log or git log right before that time: identify the **introducing release** (the first release that turned on the feature or changed the component, not subsequent metric/patch releases).
   - Identify the affected service component and the exact containment feature flag.
3. **Deterministic Correlation Scripting (CRITICAL: Zero Mental Math)**:
   - **NEVER** scroll through hundreds of JSON log lines trying to manually count affected records.
   - In `answers/<ID>/evidence/`, write a small deterministic script (`derive.mjs`, or `.py`/`.ps1` depending on the environment):
     - Load JSON logs. Verify `total === returned` to ensure queries were not truncated.
     - Correlate events by joining related records (e.g. reminders sent after a full settlement).
     - Parse ISO timestamps (`Date.parse(ts)`) and sort chronologically ascending.
     - **TRAP**: Never sort opaque request IDs (e.g. `rem-BUN-91d2` vs `rem-BUN-7f3a`); sort strictly by event timestamp `ts`.
     - Exclude edge cases according to KB rules (e.g. payments that occurred *after* the reminder, or partial payments where balance remained > 0).
   - Run the script: verify it outputs the exact array of affected IDs and earliest request ID in < 1 second.
4. **Fill and Validate `submit.json`**:
   - Copy `challenge/<ID>-submit.json` to `answers/<ID>/submit.json`.
   - Populate all required fields from your deterministic derivation.
   - Write a complete `incidentRecord` (impact, timeline, root cause, containment, recovery, prevention).
   - Include all log snapshots and the derivation script in `evidenceFiles`.
   - Validate against `challenge/<ID>-submit.schema.json`.
5. **Checkpoint & Publish**:
   - Checkpoint candidate and hand off immediately: root publishes it as is.

---

## Form B Playbook: Live Production Hotfix

1. **Locate Failing Frame**:
   - Map incident error stack trace to exact project `file:line`.
   - Run `git log -p -n 5 -- <file>`: inspect recent changes on that path.
2. **Confirm with a Minimal Reproduction Test**:
   - Write the smallest reproduction test next to existing tests, targeting the reported failure with minimal inputs.
   - Run `test_one` on the reproduction test: **it MUST fail on the unfixed code**.
   - A test passing on unfixed code reproduces nothing—fix the test before touching production code.
3. **Apply Minimal Root-Cause Fix**:
   - Fix only the root cause (1–5 lines where possible).
   - Handle edge boundaries (null, empty, type conversions, timezones) cleanly without suppressing errors.
4. **Verify**:
   - Run `test_one`: reproduction test now PASSES.
   - Run related tests of the touched module to confirm zero regressions.
5. **Checkpoint & Publish**:
   - Record reproduction before/after in `verification`, checkpoint candidate and hand off: root publishes it at once, nothing re-checks it.

---

## Anti-Patterns to Avoid
- **Mental Math Trap**: Parsing 50+ lines of raw JSON in agent context leads to skipped records, hallucinated IDs, and failure of exact grader checks. Always use a deterministic script.
- **Form Confusion**: Attempting to compile and run tests for an Answer-Only incident wastes 5–10 minutes and can cause the Game Master to close the item before submission.
- **Premature Guessing**: Changing code before writing a failing reproduction test leaves the fix unproven; nothing after your handoff catches it.
- **Subsequent Release Confusion**: Never attribute root cause to a later monitoring or metric release that merely detected the problem.
