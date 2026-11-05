---
name: implement-task
description: Implement a TASK item in any stack. No MVS exists, so derive acceptance criteria, follow existing patterns, and prove each criterion with a test.
---

# TASK

## 0. Fast-Path Classification (Answer-Only vs Feature)
Check the item description immediately upon opening:
- **Form A: Answer-Only / Calculation TASK** (e.g. "Which value does...", "Trace the ledger...", "Question(s)...", or Out of scope states "changing application source is out of scope"):
  - **DO NOT build or run the web app**.
  - **DO NOT modify application source code**.
  - **Write a targeted 10-20 line calculation script** in `answers/<ID>/evidence/derive.mjs` (or `.ts`) that imports or computes directly from the canonical source / QA test data.
  - The item's canonical scope is the input: every action, amount and assumption it states ("assume every amount is stored correctly") is data that reaches storage as written, even when the issued screen has no control for it (CA3WKX60 TASK-04: the form sends `taxMinor: 0`, yet the stated 30.00 tax is part of the stored total; dropping it cost the receivable field). Trace what the issued server, posting and status code do with those stored values, bugs included. When two readings remain, take the one that uses every stated value and name the other in the summary.
  - Fill `answers/<ID>/submit.json` with the exact computed values, ensuring correct string/integer types matching `challenge/<ID>-submit.schema.json`.
  - A canonical commit the item names but the clone lacks (the issued history is squashed) is not a blocker: use the issued source, say so in the summary and keep status DONE when the answer is derived.
  - Checkpoint candidate without writing a fix-result (the helper writes it from submit.json and validates submit.json) and hand off within 2-3 minutes!
- **Form B: Code Feature / Endpoint TASK**:
  - Follow the sections below to derive criteria, locate nearest template, and implement minimal service + tests.
- **Form C: Integration Test Suite / Specification Coverage TASK** (test suites written from specification):
  - **Mutation Testing Rule (Broken Build Detection)**: Graders test integration suites against 4-6 broken builds (mutants) where each mutant injects a subtle bug. The suite scores full points ONLY when it passes on the correct build AND detects (fails on) EVERY broken mutant build!
  - **The 6-Axis Universal Test Derivation Matrix (MANDATORY)**:
    Every test suite must systematically cover all 6 axes:
    1. *Dual-Sided Boundaries*: Test both sides of every threshold (`threshold` vs `threshold + 1`, `limit - 1` vs `limit`).
    2. *State Mutation & Reciprocity*: Reciprocal pairs, counterpart updating, cascading deletion, reassignment across containers.
    3. *Pipeline & Precedence*: Filter/rule ordering, overrides, exact match vs fallback match.
    4. *Multiplicity & Deduplication*: Repeated identical entries, case-insensitivity, duplicate resolution.
    5. *Scale & Batch Volume*: Bulk operations (> 20-50+ items in a single batch). Assert zero dropped items (`expect(created.length).toBe(N)`), reciprocal counterpart creation for all items, and exact conservation of aggregate balances down to the cent.
    6. *Encoding & Data Diversity*: Unicode characters (minus signs, international text), zero, negative numbers.
  - **Pre-Submission Mental Mutation Walkthrough**:
    Ask: *"If a developer drops the 10th item in a batch loop, or changes `<=` to `<`, does at least one test in my suite FAIL?"* If not, the suite has blindspots—add targeted cases immediately.
  - Register every case in answers/<ID>/submit.json as { file, title, rules: ['<rule_id>', ...] } matching specification rule IDs.

## 1. Acceptance criteria & test viewpoints (The 6-Axis Matrix)
Derive criteria from the description. Cover all 6 universal test viewpoint axes without inventing unrequested features:
- **Normal (Happy path)**: Standard valid inputs, expected successful outcomes, correct status and data formats.
- **Dual-Sided Boundary**: Limits and edge values (0, empty string `""`, max size/length, page boundary 0/1, both sides of every comparison threshold).
- **Error & Negative**: Invalid payloads, missing mandatory fields, not found (404), unauthorized (401/403), duplicate records.
- **Cross-field & Interaction**: Interactions between dependent fields (e.g. date start after end, discounts, reciprocal pairs).
- **Scale & Batch Volume**: Bulk operations (> 20-50 items per batch) to catch bulk-processing regressions, SQL chunking drops, and batch-volume mutants.
- **Data Encoding & Charset**: Unicode characters, international accents, special minus/dash symbols, integer currency precision.

Ambiguous? Pick the interpretation closest to how similar features already behave in this project.

## 2. Find the template inside the project
Locate the most similar existing feature (`codegraph_search`, directory listing, search by naming) and copy
its structure: layers, naming, DTOs, validation style, error handling, test style, where config lives.
Do not introduce a new framework, library or architectural layer unless the task requires it.

## 3. Definition of done for typical tasks
- **New endpoint/API**: route + input validation + service logic + error cases with the project's
  error format + tests at the same level the project tests other endpoints.
- **Export/report**: correct columns/format, encoding (UTF-8, BOM if the project's other exports use it),
  empty result, filters, large data (stream or page rather than loading everything).
- **Refactor/technical task**: behaviour unchanged — existing tests pass before and after.
- **UI task** (if frontend is in scope): component + state + API call + basic test if the project
  has UI tests.

## 4. Test data isolation & hygiene
To prevent flaky failures and broken regression (`test_all` failure):
- Never overwrite or hardcode IDs of shared seed data. Use isolated identifiers (e.g. `test_task_<ID>_...`).
- Always clean up created records or wrap DB tests in transactional rollbacks/teardown.

## 5. Tests first, then implement
One test per criterion, named after the criterion. Implement until they pass. Run related existing
tests. Clean up all debug output (`console.log`, `print`, `debugger`, stubs) before reporting completion.

## Report
`tests_added` lists one test per criterion; `summary` maps criteria → where implemented.

## Done when
Each criterion has a passing test · existing tests of touched modules pass · no debug leftovers · no gold-plating beyond
the description.
