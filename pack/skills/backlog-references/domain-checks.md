# Domain checks

Read only the sections your item touches. Each line is a case to put in a test or a scenario before handoff; skip a
line the item and code make irrelevant. Write the cases you covered into engineeringRecord tests as `[edge] ...` and
the existing callers you re-ran as `[regression] ...`, next to the red and green results.

## Money and amounts
- Minor units per currency: 2 decimals (USD, EUR), zero decimals (JPY, KRW, VND); take the factor from the project's
  money helper, never a hard-coded 100.
- The currency is the record's own (client, invoice, payment), not the workspace default; the label and input step
  follow it.
- Integer arithmetic: no float rounding on totals; bigint/BIGINT above Number.MAX_SAFE_INTEGER stays exact when
  formatted.
- Zero, negative (void, refund, credit) and overpayment (paid > total) amounts.
- Full payment at exactly the total (`>=`, not `>`), partial payment, several payments summed.

## Dates, times and status by date
- Compare calendar dates when the rule is per day (due date, aging bucket, "today"): the whole due day is not
  overdue; state which timezone (UTC or the settings timezone) and cite the rule.
- Boundaries: 23:59:59.999 and the next 00:00:00, month end, year end, 29 February, a DST change when a local
  timezone applies.
- Null or missing date; a date stored as midnight UTC shown in a non-UTC zone.
- Bucket edges are inclusive on the side the standard says (day 30 vs 31, 60 vs 61).

## Ordering and positions
- Insert at the top, bottom and between, repeated many times (for example 50+ top drops): positions stay distinct
  and strictly ordered, never tie or go negative unless allowed.
- Gap collapse triggers the existing rebalance; empty list; single item.
- Order persists: reload the page or read back from the database, not only the optimistic UI.

## Batch, import and pagination
- When the item requires collection-wide behavior, trace its entry point through chunk/page reads, parameter
  limits, deduplication and post-processing. Take the boundary N from the actual code or stated contract, not a
  convenient fixture size. Check N-1, N and N+1 where relevant; exercise another page when loop advancement matters.
  At an explicit public size cap, assert the specified rejection or continuation rather than assuming an oversized
  request must succeed.
- Include a focused integration case crossing the real boundary. Verify the identity and required state of every
  resulting record, missing/duplicate records, totals and dependent effects (for example transfer counterparts),
  including records after the first page. A correct first record or a successful exit does not prove completeness.
- If additions, updates and deletions share one fetch/chunk path, test a mixed change whose combined size crosses
  its boundary, even when each individual list is smaller. Include duplicates/order variations only where the
  specification constrains them; do not assert unspecified matching or ordering choices.
- Keep this targeted: use focused helper boundary checks and representative module interactions rather than every
  rule at every size. Do not shrink production limits or change issued test configuration to simulate a crossing.
  If the actual boundary cannot be exercised within the allowed resources, report that coverage as unverified.

## File export (CSV and similar)
- Exact header names and column order from the item or company standard; BOM and line endings (CRLF) as specified.
- Quote fields that contain comma, quote or newline; double inner quotes; keep Unicode (Vietnamese diacritics) intact.
- Rows match the screen: same filter, same order, every status the list shows; an empty selection gives the header
  only.
- Amounts in the record's currency precision, dates as calendar dates.
- Prove it with a real browser download and a byte-level check of the file (a script that parses it and compares
  with the seeded data), not with the serializer's own output.

## Access and tenancy
- Signed-out request to the new or changed endpoint: 401/redirect and no data in the body.
- Another company's or user's record: refused or filtered, not returned.
- Validation: malformed input (bad date such as 2026-02-30, wrong type) returns 400, not 500.

## UI layout
- The app mode the item names (dev, production or both): a fix that works in one can fail in the other (Tailwind v4
  logical utilities in `next dev`, see stack-notes).
- Desktop, the breakpoint edge (for example 768 px) and mobile: check computed geometry of the elements (left/right
  of main, header, sidebar), not only how the screenshot looks.
- A new utility class must exist in the compiled CSS; an undeclared theme token renders nothing.
- Existing controls on the page still work after the change.

## Incident reports (PI)
- Collect every log the services involved emit for the window, not a sample; say how many entries each source had.
- Timeline in UTC, ordered, each line citing the record (request ID, release, flag).
- For each candidate record (invoice, user, request) state why it is included or excluded under the company rule.
- Root cause names the release/component and why later releases did not cause it; containment names the exact flag
  or action without performing it when the item is report-only.
