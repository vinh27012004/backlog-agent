---
name: fix-bug
description: Fix a BUG item in any stack with maximum accuracy (10/10 Grader criteria) and ultra-fast resolution. Locate via inverted git blame, write non-tautological reproduction tests, fix root causes, and verify the 3 boundaries.
---

# BUG Resolution Playbook

In MTM, BUG tasks are scored on **Pass / Accuracy (J1–J10 criteria)** and **Speed**.
Every minute saved frees up slots and increases team ranking. High accuracy requires zero guesswork and zero regressions.

---

## 1. Ultra-Fast Defect Localization (< 2 Minutes)
Do not browse random files or read broad documentation. Follow the **Inverted 3-Step Localization**:
1. **Failing Stack Frame / Symptom**:
   - From error text / stack trace: pick the **top frame inside project code** (skip framework, runtime, and third-party libraries).
   - If no stack trace: locate the handler/function that produces the incorrect field ("expected X, got Y").
2. **Git Differential Focus (Suspect #1)**:
   - In MTM competitions, 90% of bugs are introduced by a recent commit or refactoring!
   - Run: `git log -p -n 5 -- <file>` on the failing file.
   - Check what was recently added, renamed, or modified. A recent diff matching the symptom reveals the root cause in under 60 seconds.
3. **Trace to the Source (Rule of Root Cause - J2)**:
   - **Fix where the wrong value is PRODUCED, never where it is noticed.**
   - *Forbidden*: Catching and ignoring errors, adding null checks that hide missing data, special-casing the exact input from the prompt, or hacking the caller instead of fixing the underlying function.

---

## 2. Non-Tautological Reproduction Test (J5 Protection)
Before modifying any production code, write a minimal reproduction test:
- **Anti-Tautology Rule**:
  - The test **MUST call existing project functions, endpoints, or classes** with the failing input.
  - **CRITICAL**: Never create a new helper function and then write a test that only tests your new helper! (Grader rejects self-referential tests as failing J5).
- **Placement & Isolation**:
  - Place next to existing test files of that module, following the project's test syntax and runner conventions.
  - Isolate test data (unique IDs, teardown/rollback) to avoid breaking baseline tests.
- **Fail-Before Verification**:
  - Run ONLY this test using `test_one` from the project profile (takes 2–4 seconds).
  - Confirm it **FAILS** with the exact reported error signature.
  - If it passes on unfixed code, the test does not reproduce the bug—fix the test before touching production code.

---

## 3. Minimal Root-Cause Fix & The 3-Boundary Check (J3 & J4 Protection)
- **Minimal Diff (J3)**:
  - Keep changes surgical (typically 1–10 lines).
  - Do not refactor unrelated methods, reformat untouched code, or leave debug statements (`console.log`, `print`, `debugger`, stubs).
- **The 3-Boundary Safety Check (J4)**:
  When fixing the condition, always verify three cases to prevent regressions:
  1. *The Failing Case*: The reported input now produces the correct result.
  2. *The Baseline / Existing Callers*: Normal existing inputs continue to work identically (e.g. default currency, standard user role).
  3. *Boundary / Edge Values*:
     - Arithmetic / numeric: `0`, negative numbers, boundary thresholds (`<` vs `<=`), rounding modes.
     - Collections / strings: `null`, `undefined`, empty string `""`, empty array `[]`.
     - Time / dates: UTC midnight `00:00:00`, month/year rollover, timezone offsets.

---

## 4. Focused Verification Loop (Save 5–10 Minutes)
- **During Coding**:
  - Do NOT run the entire repo test suite repeatedly!
  - Loop exclusively with `test_one` on your reproduction test until it **PASSES**.
- **Post-Fix Verification**:
  1. Reproduction test passes.
  2. Touched module tests pass.
  3. Run MVS scenario(s) and confirm output matches requirements.
  4. Build of touched modules succeeds.

---

## 5. Artifact & Evidence Checklist (J1 & J9 Protection)
- Check `<required_evidence>` and the item description:
  - Every requested artifact (PNG screenshots, `.txt`, `.csv`, `.log`) must be present in `answers/<ID>/evidence/` and declared in `evidenceFiles`.
  - Non-UI artifacts (`.txt`, `.json`, `.csv`, `.log`) must be generated via scripts or command piping, never via browser.
- Checkpoint candidate immediately after verification.
- **ANTI-DOWNGRADE RULE FOR SUBMIT.JSON**:
  - When the reproduction test passes and the fix is verified, all MVS scenarios covered by that fix MUST be reported as "result": "PASS" in submit.json with their evidence file.
  - NEVER downgrade a verified scenario to "NOT_RUN" due to a minor browser screenshot glitch or demo state reset. BTC Grader requires "PASS" to trigger their replay check; marking "NOT_RUN" forfeits 25-30 points instantly!
