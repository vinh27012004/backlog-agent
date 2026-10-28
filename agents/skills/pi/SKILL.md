---
name: resolve-pi
description: Resolve a Production Incident in any stack. Investigate with a time-boxed checklist, confirm the root cause with a reproduction test, apply a minimal fix that holds for every user. Score depends on submit time.
---

# PI (Production Incident)

A PI is a customer-reported production incident with little information and no MVS. Teams are ranked by when
their PASSED submission arrives (100 / 90 / 75 / 60 % of the points), timed from the moment the item appeared; a
wrong submission scores 0 and cannot be resubmitted. So: be correct, then lose no minute. Speed comes from a fixed
checklist, cheap evidence first and stopping as soon as a hypothesis is confirmed, never from skipping the
reproduction. Use `<pi_triage>` below to map symptoms to likely causes.

## Time box (absolute times in `<item_meta>`)
- By `checkpoint_by` (about 6 minutes in): steps 1–5 done and one hypothesis confirmed. If none is confirmed by
  then, stop: write your result with `status` = `partial` and the full `hypotheses` list (each with its check and
  what it showed, the untested ones `open`), and reply. The orchestrator checks the open hypotheses in parallel and
  starts the next attempt from your list, so a precise list is worth more than five more minutes of guessing.
- By `return_by`: fix, reproduction test and answer file done. Over time on a step? Move on with the best
  information you have.

## Checklist
1. **Incident report**: symptoms (who, what, where, since when, always or sometimes, all users or some), the
   expected behaviour and where it is stated (item text, `<company_facts>`, docs, code comments), and the answer
   contract: the template and schema fields in `<materials>` and any answer format the item gives (a field compared
   as an exact string follows the item's normalization rules).
2. **Evidence, cheapest first**:
   - the files in `<materials>` (logs, data, scripts) and `<company_facts>`; for more logs, tickets or
     standards, query company systems yourself (`company_tools`, then `company_call`, lookups only);
   - error text / stack trace → error signature;
   - what changed: `<recent_changes>` and `git log -p -n 5 -- <paths on the symptom's path>`; a change that
     matches the symptom is suspect number one;
   - configuration on the path (env files, application config, feature flags, time zone, limits);
   - data assumptions (empty table, null column, new enum value, date boundary).
3. **Entry point**: map the symptom to an endpoint/page/job and its call chain with codegraph (`codegraph_search`
   for the handler, then `codegraph_callees`).
4. **Hypotheses**: 2–4 causes, most likely first, each with a check whose outcome differs depending on whether it
   is true. Keep them in your `hypotheses` list as you go: a refuted one stays there with its evidence.
5. **Confirm with a reproduction test**: the smallest test that fails on the current code for the reported
   reason, at the lowest layer that shows it, next to the existing tests. A local HTTP call to the app you started
   is extra evidence, not a substitute. **Stop investigating at the first hypothesis the test confirms.**
6. **Fix the root cause** minimally, correct for every user and input, not only the reported case: the same
   pattern in the same function/class, and the neighbours of the failing input (null/empty, boundary, other time
   zones, roles or tenants). If the cause is one recent change, undoing that part is a valid fix when nothing
   else depends on it; say so.
7. **Verify**: the reproduction test failed before and passes now; the tests of the touched modules pass; the
   build passes.

## Rules
- The gate fails a PI whose declared tests include no new test that fails on the unfixed code (`not_reproduced`),
  unless the stack has no test runner.
- Not acceptable: catching and ignoring the error, a null check that hides missing data, special-casing the
  reported input, changing a test's expectation.
- A configuration or data-handling fix is fine if that is the root cause; say so in `root_cause`.

## Report
`root_cause` with the evidence (file:line, request → response, log line, commit id) · `hypotheses` (all of them)
· `tests_added` (the reproduction test) · `summary` of the fix · `verification` lists the reproduction
before/after · in the answer (`engineeringRecord` or what the template has): root cause, evidence, fix and how it
was verified, written for the grader.

## Done when
Root cause confirmed by a reproduction test that failed before and passes after · related tests pass · answer
file filled.
