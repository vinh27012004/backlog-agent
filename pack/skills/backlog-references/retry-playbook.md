# Retry playbook

`<previous_attempt>` tells you why the last attempt failed. The worktree still holds the previous
attempt's change (`git diff HEAD`): keep what is right and change what the failure points at.

| fail_kind | Meaning | What to do differently |
|---|---|---|
| `compile` | build/compile/type check failed | Read the compiler error lines first. Usually a wrong import, signature or type. Fix only that and re-run the build before anything else. |
| `original_still_failing` | the reproduction / target test still fails | The fix was in the wrong place or the hypothesis was wrong. Go back to the root cause: trace where the wrong value is produced. Do not tweak the same lines again. |
| `regression` | other tests broke | Your change altered shared behaviour. Narrow it: apply the fix only on the path that needs it, or update callers consistently if the spec requires the change. Read the broken test to learn the expected behaviour. |
| `mvs_fail` | organizers' scenario failed | Compare the scenario's expectation (status, field names, message text, format) with your output exactly. MVS checks the external contract, not your tests. |
| `diff_too_large` / `forbidden_change` | too many files, or a forbidden edit (deleted assertion, skipped test, build file, a baseline test that no longer runs) | Redo with a minimal change. Never touch tests' expectations, skip markers, test names or MVS files. |
| `weak_test` | a new test has no assertion, or one that cannot fail | Assert the specific value the item expects (`expect(total).toBe(900)`), computed by hand from the item, not by the code under test. |
| `no_change` | the worktree had no change at all | You reported a fix but nothing was written. Make the change in the files themselves, then re-run the narrowest test. |
| `timeout` | ran out of time | Pick the simplest correct fix; skip optional polishing; run only the narrowest test. |
| `review_high` | reviewer found a high-severity issue | Address exactly the issues listed; keep the rest of the approach. |

If the same error signature appears again after your change, your approach is wrong — change the
hypothesis, not the details.
