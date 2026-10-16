---
name: implement-cr
description: Implement a Change Request in any stack. Turn the spec into a delta, change every place it touches, keep everything else unchanged, pass the MVS scenario.
---

# CR (Change Request)

A CR changes how the system should behave. The organizers verify it with an MVS scenario that must
pass, and existing behaviour outside the change must stay intact.

## 1. Spec delta (write it down before coding)
| Changes | Stays the same |
|---|---|
| new/changed rule, field, endpoint, status code, message, default, permission | everything the spec does not mention |

Spec unclear? Use the assumption in the brief's `ambiguities`; prefer the option that breaks the fewest
existing callers.

## 2. Find every place the change touches
Use `codegraph` from the thing you change outward. Typical chain in a web app:
route/controller → request/response DTO + validation → service/business rule → repository/query →
schema/migration → serializers/mappers → error handling → tests → API docs (OpenAPI, README) if the
project keeps them. Frontend in the same repo consumes the API? Check it too.

## 3. Compatibility rules
- New request fields: optional with a sensible default unless the spec says required.
- Do not rename or remove response fields unless the spec says so.
- Schema change: only through the project's migration mechanism (Flyway, Liquibase, Alembic,
  Django/Rails/EF migrations, Prisma...). Never edit an already-applied migration; add a new one.
- New error case: use the project's existing error format and status-code conventions.
- New config value: add a default so existing environments keep working.

## 4. Tests from the spec
- For each changed rule: a test of the new behaviour, including the boundary the spec implies
  (e.g. limit 5 → test 5 allowed, 6 rejected).
- One test that shows behaviour outside the delta is unchanged, where the change is risky.
- Update an existing test **only** where the spec changes its expected result; list each one in
  `summary` with the reason.

## 5. Implement
Follow the existing layering and naming. Put rules where similar rules already live. Need a new
library? Edit the build file and list it in `needs_dependency` (no network in the sandbox; the
orchestrator downloads it).

## 6. Verify
New tests · existing tests of touched modules · MVS via `runner.mvs_run` if available · build.

## Done when
Every row of the spec delta has a passing test · callers updated · MVS passes (or reported as not
runnable) · no unrelated changes.
