---
name: fix-bug
description: Fix a BUG item in any stack. Reproduce with a failing test first, find the root cause, make the minimal fix, pass the MVS scenario.
---

# BUG

A BUG reports wrong behaviour, usually with a log or stack trace. The organizers verify it with an
MVS scenario that must pass, and they check that nothing else broke.

## 1. Read the evidence (do not open many files yet)
- **Error signature** = exception/error type + the first stack frame inside project code
  (skip framework, library and runtime frames). This is what "reproduced" means.
- If there is no stack trace: the signature is the wrong value or behaviour
  ("expected X, got Y" for input Z).
- Classify the bug with `.agents/skills/backlog-references/bug-patterns.md`; it tells you where to look first.

## 2. Locate
- Start from the error signature and the entry point. Use codegraph (`codegraph_callers`, `codegraph_callees`, `codegraph_impact`) to walk from the entry
  point (endpoint / job / handler) to the failing frame.
- Read only the methods on that path. Check recent commits on those files:
  `git log -n 10 --oneline -- <files>`; a recent change is often the cause.

## 3. Reproduce first (no production change before this)
- Write the smallest test that fails **for the reported reason**, at the lowest layer that shows it:
  a unit test of the faulty function if possible, an API/integration test only if the bug is in
  wiring, mapping, serialization, validation or persistence.
- Put it next to the existing tests of that class/module, follow their style and fixtures.
  Isolate test data (unique IDs, teardown or rollback) so shared state does not break other tests.
- Run only that test (see `test_one` in the project profile). Confirm it fails with the signature.
  If it passes on the unfixed code, it checks the wrong behaviour: fix the test before you touch production
  code (the gate rejects a test that passes on the unfixed code).
- Cannot reproduce in ~1/3 of your time? Stop before changing production code. Return `partial`, record
  what you tried and the remaining hypotheses in `verification`, and ask root for the next investigation.
  Missing test commands or an unavailable probe mean unverified reproduction, never a passing proof.

## 4. Root cause, then fix
- Write the root cause in one or two sentences: which code, which condition, why wrong.
- Fix **the cause**. Not acceptable: catching and ignoring the error, a null check that hides missing
  data, special-casing the exact input from the item, changing the test's expectation.
- Smallest change that is correct for all inputs, not only the reported one. Think about the
  neighbours of the failing input (null/empty, zero, negative, boundary, other locales/time zones).
- Same bug pattern elsewhere in the same function/class? Fix it there too and say so; do not go hunting
  across the codebase. Clean up any temporary debug code (`console.log`, `print`, `debugger`, stubs).

## 5. Verify
1. Reproduction test: failed before, passes now.
2. Existing tests of the touched classes/modules.
3. MVS: run each MVS scenario from the brief and make it pass. Its log is the evidence.
4. Build of the touched module(s).

## Report
- `root_cause`: the one-to-two sentence explanation.
- `summary`: what changed and why, in terms a reviewer can check in the diff.
- `tests_added`: the reproduction test(s).

## Done when
Reproduction test failed before and passes after · related tests pass · MVS passes (or is reported
as not runnable) · diff contains only the fix and its tests, with no debug leftovers.
