# Bug patterns (any stack)

| Pattern | Typical signs | Look first at | Reproduce with |
|---|---|---|---|
| Null / missing value | NullPointerException, `undefined is not a function`, `NoneType has no attribute`, NullReferenceException | optional relations, missing map/dict keys, absent request fields, empty query result | unit test with the missing value |
| Wrong calculation | wrong total/amount/count, off by a factor | arithmetic order, double application (per-line + total), integer division, float for money, rounding mode/scale | unit test with the item's numbers |
| Boundary / off-by-one | first/last element missing, page repeats, limit off by one | `<` vs `<=`, page index base 0/1, inclusive vs exclusive date ranges | test at the boundary and one past it |
| Date / time zone | wrong day/month, works some hours only, "since today" | server vs user time zone, `now()` in UTC vs local, start/end of day/month, DST, string date parsing | test with a fixed clock near midnight / month end |
| Mapping / serialization | field missing or renamed in API, wrong enum text, null in JSON | DTO ↔ entity mappers, JSON naming config, enum serialization, ignored fields | API/controller test asserting the JSON |
| Validation | valid input rejected or invalid accepted, wrong status code | validation annotations/schemas, regex, required flags, error handler | API test with the input |
| Query / persistence | missing or duplicated rows, slow page, stale data | WHERE/JOIN conditions, soft-delete filter, ORDER BY with paging, N+1, missing transaction, lazy loading outside session | repository/integration test with seeded data |
| State / concurrency | intermittent, double submit, lost update, race | shared mutable state, missing lock/transaction/unique constraint, async without await, singleton with request state | test that calls twice / in parallel |
| Error handling | 500 instead of 4xx, error swallowed, blank page | catch-all handlers, empty catch, ignored promise rejection, wrong status mapping | test asserting status and body |
| Config / environment | works locally not in "prod", feature missing | profile-specific config, env var names, default values, feature flags | test with that config value |
| Security / access | user sees other users' data, action allowed without role | missing ownership check, role check on wrong layer, IDOR | test with two users |
| Caching | stale value after update | cache key, eviction on write, TTL | test update-then-read |

Rules that apply to every pattern:
- The reproduction must fail for the reported reason, not for a setup mistake.
- Fix where the wrong value is **produced**, not where it is first noticed.
