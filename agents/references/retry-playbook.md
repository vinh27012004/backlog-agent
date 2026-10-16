# Retry playbook

`<previous_attempt>` tells you why the last attempt failed. The worktree was reset to a clean
branch, so the previous change is gone; the condensed log and signature are what remain.

| fail_kind | Meaning | What to do differently |
|---|---|---|
| `compile` | build/compile/type check failed | Read the compiler error lines first. Usually a wrong import, signature or type. Fix only that and re-run the build before anything else. |
| `original_still_failing` | the reproduction / target test still fails | The fix was in the wrong place or the hypothesis was wrong. Go back to the root cause: trace where the wrong value is produced. Do not tweak the same lines again. |
| `regression` | other tests broke | Your change altered shared behaviour. Narrow it: apply the fix only on the path that needs it, or update callers consistently if the spec requires the change. Read the broken test to learn the expected behaviour. |
| `mvs_fail` | organizers' scenario failed | Compare the scenario's expectation (status, field names, message text, format) with your output exactly. MVS checks the external contract, not your tests. |
| `diff_too_large` / `forbidden_change` | too many files, or a forbidden edit (deleted assertion, skipped test, build file) | Redo with a minimal change. Never touch tests' expectations, skip markers or MVS files. |
| `timeout` | ran out of time | Pick the simplest correct fix; skip optional polishing; run only the narrowest test. |
| `review_high` | reviewer found a high-severity issue | Address exactly the issues listed; keep the rest of the approach. |

If the same error signature appears again after your change, your approach is wrong — change the
hypothesis, not the details.
