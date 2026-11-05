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

## 1. Acceptance criteria & test viewpoints
Derive criteria from the description. Cover the 4 core test viewpoint dimensions without inventing unrequested features:
- **Normal (Happy path)**: standard valid inputs, expected successful outcomes, correct HTTP status and data formats.
- **Boundary**: limits and edge values (0, empty string `""`, max size/length, page boundary 0/1, empty list, first/last element).
- **Error**: invalid payloads, missing mandatory fields, not found (404), unauthenticated/unauthorized (401/403), duplicate records.
- **Cross-field**: interactions between dependent fields (e.g. date start after end, discount exceeding total, mutually exclusive flags).

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
