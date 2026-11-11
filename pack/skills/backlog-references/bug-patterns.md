# Bug Patterns & Fast Diagnostic Reference (Multi-Stack)

| Pattern | Typical Signs | Root Cause Location | Fastest Diagnostic & Reproduction |
|---|---|---|---|
| **Null / Missing Value** | NullPointerException, `undefined is not a function`, `NoneType object has no attribute`, NullReferenceException | Missing dictionary/map key, optional relations not loaded, missing request property, empty query result | Unit test passing `null`/omitted field to the underlying domain function (not caller) |
| **Wrong Calculation / Currency** | Wrong total, discount miscalculated, off by 100x | Float vs Integer division, cents vs dollars (minor units), double application (per-item + order-level), rounding mode (`Math.floor` vs `Math.round`) | Unit test with exact fractional inputs, asserting exact minor-unit cents |
| **Boundary / Off-By-One** | First/last item missing, page duplicates, limit exceeded | `<` vs `<=`, 0-based vs 1-based indexing, exclusive vs inclusive date ranges (`endOfDay`), pagination offset | Test at exact boundary and one past the boundary (e.g. limit `n` and `n + 1`) |
| **Date & Timezone Rollover** | Wrong day/month, works only during certain hours, "since midnight" | Server vs UTC timezone, `new Date()` vs UTC calendar day, DST changes, string timestamp parsing without offset | Test with fixed UTC timestamps across 23:59:59 and 00:00:00 UTC |
| **Mapping & Serialization** | Field missing in API response, wrong enum casing, camelCase vs snake_case | DTO $\leftrightarrow$ Entity mappers, JSON annotations/naming policies, unmapped relation fields | API/controller test asserting the exact serialized JSON payload structure |
| **Validation / Status Code** | Valid input rejected with 400, or invalid input accepted | Regex mismatch, required flags, missing custom validator, unhandled validation exception | Test with valid boundary input and invalid malformed input |
| **Query & Persistence** | Missing/duplicated rows, stale data, query timeout | WHERE/JOIN conditions, soft-delete filter ignored, missing index, missing transaction commit, lazy loading outside session | Repository integration test with seeded entities; check query generation |
| **Concurrency & Race Condition** | Intermittent flakiness, double-spend, lost update | Missing DB transaction/row lock, async without `await`, shared mutable global/singleton state | Parallel test firing two concurrent requests with identical payload |
| **Error Handling & Masking** | HTTP 500 instead of 4xx, error swallowed, blank response | Catch-all handler (`catch (Exception e)`), empty catch block, unhandled Promise rejection, wrong status mapping | Test asserting both exact HTTP status code and structured error body |
| **Security & Access (IDOR)** | User sees another tenant's data, unauthenticated action allowed | Missing tenant ID filter in WHERE clause, auth middleware bypassed on specific route | Test invoking endpoint with Token A requesting Tenant B resources |

---

## 3 Core Principles for 10/10 Judge Verification

### 1. The Root-Cause Rule (Judge Criterion J2)
- **Fix where the wrong value is PRODUCED, never where it is noticed.**
- Do not wrap caller code in `if (val != null)` to suppress symptoms.
- Do not catch exceptions and return empty defaults unless explicitly required.
- Do not hardcode special cases for the specific test values in the prompt.

### 2. The Anti-Tautology Test Rule (Judge Criterion J5)
- **A reproduction test MUST test the actual codebase symbols.**
- Never create a new helper function or class and write a test that only exercises that new helper in isolation.
- The test must fail on the unfixed codebase because the application logic is wrong, and pass after the fix.

### 3. The 3-Boundary Safety Rule (Judge Criterion J4)
Every fix must be verified against 3 boundary conditions:
1. **The Failing Case**: Verifies the reported defect is resolved.
2. **The Baseline Invariant**: Verifies existing valid callers continue to work without regression.
3. **The Edge Boundary**: Verifies zero, empty collections (`[]`), null, negative numbers, or rollover dates do not trigger unhandled exceptions.
