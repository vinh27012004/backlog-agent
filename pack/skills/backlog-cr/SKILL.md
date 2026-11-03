---
name: implement-cr
description: Implement a Change Request in any stack with maximum accuracy (10/10 Grader criteria) and ultra-fast delivery. Use spec delta decomposition, walk the full impact chain, test across 4 viewpoints, and ensure complete backward compatibility.
---

# CR (Change Request) Playbook

In MTM, Change Requests (CR) modify or extend system capabilities.
High scores require **complete implementation of all acceptance criteria (J1)**, **zero regressions on existing callers (J4)**, and **complete, verifiable evidence (J1 & J9)**.

---

## 1. Spec Delta Matrix (1 Minute Upfront)
Before touching code, write down the explicit delta:
| Spec Delta (What Changes) | Invariants (What Must Stay The Same) |
|---|---|
| New/changed endpoints, parameters, business rules, status codes, defaults, permissions | All existing routes, unmentioned fields, legacy response formats, authentication models |

*Rule of Ambiguity*: If the spec is ambiguous on a corner case, choose the interpretation that breaks the fewest existing callers and state the assumption clearly in the `summary`.

---

## 2. Walk the Full Impact Chain (Zero Missed Links)
Do not patch only the UI or only the service. Walk the full call chain outward:
1. **Route / Controller**: HTTP method, route path, headers, query/path parameters.
2. **DTO & Validation**: Schema validation, required vs optional flags, default values.
   - *CRITICAL*: New request fields MUST be optional with sensible defaults unless the spec explicitly states they are mandatory.
3. **Service / Business Logic**: Core algorithm, entity status transitions, authorization checks.
4. **Data Persistence / Migration**:
   - Schema changes must use the project's native migration tool (Prisma, Alembic, Flyway, Liquibase, EF Migrations).
   - *Forbidden*: Modifying existing historical migrations. Always create a new migration.
5. **Serialization / Mapping**: DTO $\leftrightarrow$ Entity mappers, date formatting, enum serializations.
   - *Forbidden*: Renaming or omitting existing response fields unless specifically mandated.
6. **Frontend / UI (if monorepo)**: Consume the updated API, add requested controls (buttons, modals, dropdowns).

---

## 3. The 4-Dimensional Test Matrix (J5 & J4 Protection)
For every feature or modification introduced in the CR, write tests covering 4 key viewpoints:
1. **Dimension 1: Happy Path**:
   - Verify expected behavior with valid inputs, expected status codes (e.g. 200, 201), and full response payloads.
2. **Dimension 2: Boundary & Limits**:
   - Verify thresholds implied by the spec (e.g. pagination limit, max upload size, date range limits).
   - Test exact boundary and one past the boundary (e.g. limit 5 $\to$ test 5 accepted, 6 rejected).
3. **Dimension 3: Negative & Error Path**:
   - Verify invalid, malformed, or missing required fields return appropriate status codes (e.g. 400, 422) in the project's standard error format.
   - Verify unauthenticated or unauthorized access returns 401/403 without data leakage (J7).
4. **Dimension 4: Backward Compatibility**:
   - Verify requests omitting the new fields continue to work seamlessly using defaults.

---

## 4. Focused Loop & Evidence Acquisition (Speed Maximizer)
1. **Focused Testing**:
   - Loop using `test_one` on your new CR test suite (takes 2–4 seconds per run).
   - Only after all 4 test dimensions pass, run the touched module tests to confirm zero regressions.
2. **Required Evidence Pre-Flight**:
   - Check the Submission section of the item description:
     - CSV exports, data dumps, JSON/TXT reports must be generated and saved into `answers/<ID>/evidence/`.
     - *Golden Rule*: Generate data exports and reports directly via backend scripts or API calls, ensuring exact row counts, byte sizes, and BOM/CRLF standards.
     - For UI screenshots, verify controls (e.g. export buttons, new columns) are clearly visible.
3. **Diff Hygiene (J3)**:
   - Verify `git diff`: ensure zero leftover debug statements (`console.log`, `print`, temporary stubs), no unrelated file touches, and no formatting churn.
4. **Candidate Checkpoint**:
   - Checkpoint candidate and hand off; root publishes it as is.
