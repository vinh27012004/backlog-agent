# Retry playbook

`<previous_attempt>` tells you why the last attempt failed. The worktree still holds the previous
attempt's change (`git diff HEAD`): keep what is right and change what the failure points at.

Answer/evidence repair normally continues this worker through followup_task: keepImplementation, the COMPLETE
todo list, a short return_by and the next numbered results path. Resume writes with worker_checkpoint resume;
do not re-investigate accepted code. Failed implementation, a new hypothesis or model escalation can use a new
worker. Each handoff is a new immutable result version, even in one thread; never overwrite a gated result.

| fail_kind | Meaning | What to do differently |
|---|---|---|
| `compile` | build/compile/type check failed | Read the compiler error lines first. Usually a wrong import, signature or type. Fix only that and re-run the build before anything else. |
| `original_still_failing` | the reproduction / target test still fails | The fix was in the wrong place or the hypothesis was wrong. Go back to the root cause: trace where the wrong value is produced. Do not tweak the same lines again. |
| `regression` | other tests broke | Your change altered shared behaviour. Narrow it: apply the fix only on the path that needs it, or update callers consistently if the spec requires the change. Read the broken test to learn the expected behaviour. |
| `mvs_fail` | organizers' scenario failed | Compare the scenario's expectation (status, field names, message text, format) with your output exactly. MVS checks the external contract, not your tests. |
| `diff_too_large` / `forbidden_change` | too many files, or a forbidden edit (deleted assertion, skipped test, build file, a baseline test that no longer runs) | Redo with a minimal change. Never touch tests' expectations, skip markers, test names or MVS files, except a test you own in `<baseline_failures>` that contradicts the intended behaviour: then fill `test_change` so the orchestrator passes it to the gate. |
| `weak_test` | a new test has no assertion, or one that cannot fail | Assert the specific value the item expects (`expect(total).toBe(900)`), computed by hand from the item, not by the code under test. |
| `not_reproduced` | PI: none of the declared tests is new and fails on the unfixed code | Keep the fix if build and regression passed. Add the smallest new test that asserts the behaviour the incident broke, on the path your fix changed, with the expected value taken from the item, not from the code. An assertion the unfixed code also satisfies proves nothing; the gate runs the test on the unfixed code for you. List it in `tests_added`. |
| `evidence_missing` | a file the item description requires is not in `answers/<ID>/evidence/` | Keep the code: build and regression passed. Capture only the files named in the detail, with the exact names, and list them in `evidenceFiles`. A "before fixing" shot is taken on the unfixed code (evidence playbook §0). Without the file the item scores 0. |
| `no_change` | the worktree had no change at all | You reported a fix but nothing was written. Make the change in the files themselves, then re-run the narrowest test. |
| `timeout` | ran out of time | Pick the simplest correct fix; skip optional polishing; run only the narrowest test. |
| `review_high` | reviewer found a high-severity issue | Address exactly the issues listed; keep the rest of the approach. |

If the same error signature appears again after your change, your approach is wrong — change the
hypothesis, not the details.
