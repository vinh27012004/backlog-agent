# PI triage: symptom → likely causes → fastest check

| Symptom | Likely causes (most common first) | Fastest check |
|---|---|---|
| Blank page / empty list | query returns nothing (filter, date range, tenant/user scope); exception swallowed and empty result returned; frontend expects a field that the API renamed | call the API directly: empty data or error? then check the query's WHERE and the date range |
| HTTP 500 | unhandled exception (null pointer, parse error, type mismatch, DB constraint violation), missing config/env value, schema mismatch | error text/stack in item → signature → failing frame (file:line) |
| HTTP 4xx where it used to work | validation rule tightened, auth/role check changed, route/path renamed, header missing | recent commits on validation, security config, controllers/routes |
| Slow / timeout | N+1 queries, missing index, unbounded query (no paging), external call without timeout, lock contention | count queries for one request; look for loops calling repository/HTTP |
| Wrong numbers / bad balance | calculation or rounding change, double counting, currency/units (cents vs dollars), time zone of aggregation | recompute one example with script; compare before vs after math |
| "Since this morning / today" | recent deploy or config change, date boundary (new day/month/year), expired token/certificate, data that appeared today | deploy logs and `git log -p` on the path; what is special about today's date |
| Stale data / wrong state shown | cache read without invalidation, cache TTL too long, background sync delayed, reading from read-replica before replication | check cache key/TTL, read logs for cache snapshot timestamp vs write timestamp |
| Only some users / some data | data-dependent: null column, new enum value, special characters, large payload, specific role/tenant | compare a failing and a working record side by side |
| Intermittent failures | race condition, concurrency without lock/transaction, connection pool exhaustion, unhandled promise rejection | check concurrency control, database connection pool limits |
| Duplicates | missing unique constraint, retry without idempotency, double submit, JOIN fan-out | check DB constraints, deduplication key, JOIN multiplicity |
| Missing notification/email/job | scheduler disabled/misconfigured, exception inside async worker, queue consumer dead, filter suppressed message | worker logs, queue consumer status, message filter predicates |

---

## The SRE Triangle Correlation (Find Root Cause in < 2 Minutes)
Every production incident in MTM traces back to one root cause: a recent commit, a recent release, or an enabled feature flag. Find it via three vertices:
1. **Timestamp & Symptom**: When was the incident reported, and when did symptoms first appear? (e.g. 10:05 UTC today).
2. **Deploy / Release History**: Examine deploy logs (`service: deploy` or `git log --since="today" -p`). What release deployed right before the symptoms started? (The introducing release is the first release that changed the component, not a subsequent release that added metrics or logging).
3. **Component & Containment Flag**: Check the service name and the exact feature flag (or config setting) deployed in that release from the deploy log or commit diff.

---

## Deterministic Log Correlation Pattern (Zero Mental Math)
**CRITICAL RULE**: Never read 50+ lines of raw JSON logs manually or calculate affected records in your head. An agent doing mental math takes 8+ minutes and misses edge cases.
Instead, write a 15-20 line targeted correlation script (`derive.mjs` or `derive.py` or `.ps1`) in `answers/<ID>/evidence/`:
1. **Completeness Check**: Load the helper's `company/timeline.json` (complete production log, one entry per line) and
   check `complete === true` and `entries.length === total`. When it is partial, follow its note; `search_logs` itself
   returns at most 20 entries per call, newest first, with no paging, so a single query file is never the whole log.
2. **Event Join**: Load event streams (e.g. payments and reminders, or requests and errors).
3. **Temporal Ordering**: Always compare timestamps via standard ISO parsing (`new Date(a.ts) < new Date(b.ts)`).
   - **TRAP**: Never sort opaque request IDs alphabetically (e.g. `req-BUN-91d2` vs `req-BUN-7f3a`); sort strictly by event timestamp `ts` ascending.
4. **Boundary Filtering**: Filter records strictly based on the company standard (e.g. status after transaction is settled, payment strictly before the event, balance == 0).
5. **Output & Artifacts**: Print the exact answers for `submit.json` and save the script output to `answers/<ID>/evidence/derivation.json`.

---

## Common SRE Traps to Avoid
- **Trap 1: Monitoring Release vs Introducing Release**: If release `rel-2` turned on the bad flag and release `rel-4` added a Prometheus metric for it, the root cause release is `rel-2`, NOT `rel-4`.
- **Trap 2: Customer Complaint Bias**: Customer tickets only reflect the users who complained. The incident report requires **ALL** affected records across the entire dataset. Always derive from complete logs.
- **Trap 3: Settle Timing Traps**: Exclude records where payment happened *after* the event was dispatched, or where payments were partial and balance remained overdue.


---

## One-Shot PI Submission Rules (Finish in < 4 Minutes on Version 1)
1. **Upfront Copy Company Facts**:
   Before handoff, copy `timeline.json` and the kb_search files from `.team-work/items/<ID>/company/` directly into `answers/<ID>/evidence/` byte-for-byte (a report-only PI already has them there).
2. **Clean Relative Paths Only**:
   In `submit.json` and `evidenceFiles`, all paths MUST be `"evidence/<filename>.json"`.
   **FATAL TRAP**: NEVER append `:line` or `:41` suffixes in path strings. Line numbers belong only in the `incidentRecord` prose, never inside path arrays.
3. **Deterministic Derivation Script**:
   Save your derivation script as `answers/<ID>/evidence/derive.mjs`, execute it, and include it in `evidenceFiles`.
   Validate `submit.json` with schema and hand off immediately on attempt 1!
