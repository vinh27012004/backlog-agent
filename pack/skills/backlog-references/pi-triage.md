# PI triage: symptom → likely causes → fastest check

| Symptom | Likely causes (most common first) | Fastest check |
|---|---|---|
| Blank page / empty list | query returns nothing (filter, date range, tenant/user scope); exception swallowed and empty result returned; frontend expects a field that the API renamed | call the API directly: empty data or error? then check the query's WHERE and the date range |
| HTTP 500 | unhandled exception (null, parse, constraint), missing config/env value, DB schema mismatch | error text/stack in item → signature → failing frame |
| HTTP 4xx where it used to work | validation rule changed, auth/role check changed, route/path changed | recent commits on validation, security config, routes |
| Slow / timeout | N+1 queries, missing index, unbounded query (no paging), external call without timeout, lock contention | count queries for one request; look for loops calling repository/HTTP |
| Wrong numbers | calculation or rounding change, double counting, currency/units, time zone of aggregation | recompute one example by hand from the data |
| "Since this morning / today" | recent deploy or config change, date boundary (new day/month/year), expired token/certificate, data that appeared today | `git log --since` on the path; what is special about today's date |
| Only some users / some data | data-dependent: null column, new enum value, special characters, large size, specific role/tenant | compare a failing and a working example |
| Intermittent | race condition, cache, connection pool exhaustion, retries, load balancer with mixed versions | look for shared state and missing transactions |
| Duplicates | missing unique constraint, retry without idempotency, double submit, JOIN fan-out | check constraints and the JOIN |
| Missing notification/email/job result | scheduler disabled/misconfigured, exception inside async job, queue consumer not running | job config and job error handling |

Evidence to record for the report: the request you sent and the response you got, the code line
(file:line), the commit that introduced it if found, the log line.
