# Evidence playbook, details (open only when the core playbook sends you here)

The core rules are in evidence-playbook.md (app start, enterApp, one capture call per mode, file names, retries).
This file covers the cases that come up only on some screens. Read the one section you need.

## 3. Selectors
- Before writing steps for a screen you have not driven yet, take its flow and selectors from the project's own
  browser tests: e2e/, playwright/, cypress/ folders and their page models (`rg -l "page.goto|getByRole|getByTestId"`
  over the test folders). They show the first-run screens (server choice, password, "Start budgeting"), the route
  of each screen and how custom fields (combobox, date input) are filled. Read component source only for a screen no
  test covers (OMZJW0S0 and UOMNKT6Z BUG-09: about 2 minutes and 3 failed captures reading WelcomeScreen.tsx and
  Select.tsx, while desktop-client/e2e/page-models had the whole flow).
- `selector` is CSS or Playwright selector syntax (`text=Invoices`, `[role=tab]:has-text("Invoices")`,
  `role=button[name="Save"]`, `>> nth=1`).
- Pick by visible text with `selector` + `text` together: `{selector: "[role=tab]", text: "Invoices"}`,
  `{selector: "button", text: "New invoice"}`; an exact text match wins over a partial one; `index` picks the n-th match.
- `ELEMENT_NOT_ACTIONABLE`: the element is there but not clickable (the message says why, e.g. `element is not
  enabled`): wait for the state that enables it (`waitFor {selector, state: "enabled"}`) instead of retrying.
- Mobile viewport: the desktop sidebar is hidden and navigation moves to a menu or bottom bar with its own labels.
  Use `goto` unless the scenario is about that navigation; otherwise take the label from `error.details.candidates`.
- A custom select (Radix, shadcn): click its trigger, then `{action: "click", selector: "[role=option]", text: "<name>"}`.
  A native `<select>` uses `{action: "select", selector, value}`.
- A failed step returns `error.details`: `failedStep`, `url`, `visibleText` and the clickable `candidates` on the page.
  Fix the steps from those, never by guessing.

## 4. Something covers the target (`obscuredBy`)
- A click on a covered element goes through the cover with real mouse events, and the step in the result carries
  `obscuredBy` naming the cover (Practice #5: BUG-01's sidebar covered the Accounting tabs in every other item's
  worktree). Say in the scenario note that a shared layout bug was clicked through.
- On a UI-layout bug, the cover is the bug: `obscuredBy` plus a screenshot of the covered screen is your "before"
  evidence.
- The cover also hides what your screenshot must show: when the scenario names no viewport, capture at a width below
  the app's desktop breakpoint (e.g. 1023 or 767 px, where the sidebar collapses) so the content is visible, and say so.
- Never copy another item's files and never wait or yield for another item's fix (Practice 4D895OVI: CR-01 and CR-02
  yielded for BUG-01's layout fix, which never reached main, and neither was submitted). Capture now; if you later
  sync runtime changes, recapture final evidence from that updated worktree before handoff.

## 5. A failing server (500, timeout, offline, slow)
Add a `route` step before the action that sends the request, e.g. `{action: "route", url: "/api/invoices/export",
status: 500, times: 1}`, `abort: "TimedOut"` or `delayMs: 8000`. Never change code, stop the server or the database to
cause it. Write in the scenario note and `engineeringRecord` that the failure was simulated in the browser (the result
lists it in `routed`).

## 6. Scenario data
Organizer seeds wipe and recreate data (Practice #2: CR-01's seed deletes every invoice; a misclick voided BUG-02's
invoice and the later scenarios ran on damaged data). An item worktree's app normally has its own database, migrated
and seeded when the worktree was set up, so other items never see or change your data; `app_data lock` then returns
`dedicated: true` at once. Only a shared database (main checkout, `dedicated` absent) makes items queue.
1. `app_data {action: "lock", backlogItemKey, matchRoot: "<worktree matchRoot>", waitSeconds: 50}`; repeat while it
   returns `locked: false`. Always pass `matchRoot`: it is how the helper sees your own database.
2. Run the seed the MVS names, then every data scenario in MVS order in one pass (later ones often use records an
   earlier one created).
3. A step went wrong (wrong click, wrong value, a record in an unexpected state such as VOID): stop, re-seed only if the
   script says it is safe to re-run (otherwise mark the scenarios `NOT_RUN`), and redo from the first data scenario.
4. `app_data {action: "unlock"}` once the evidence or report that reads the data is written.
Never create records the MVS did not ask for.

## 7. Download and observable waits
Use {action: "download", selector: "button", text: "Export CSV", path: "<absolute evidence/file.csv>"} in the
same flow/profile as login/navigation. Helper registers listeners before click and saves completed HTTP/Blob
download bytes unchanged, including BOM/CRLF. downloads gives path, bytes and sha256. Never recreate CSV from source.
waitFor supports selector with state visible, hidden or enabled. Prefer a real observable state over sleep.
Only unsupported operations such as API-only checks need a scratch script in .team-work/scratch/<ID>/;
do not put it in product source, and fix it at most twice.

## 8. Pages that never settle, supplied check scripts
- A screen that polls without end (a default tab whose query refetches in a loop) never reaches network idle: open a
  tab or screen without that loop (click it right after `goto`) before `screenshot`, or pass `idle: false` when the
  scenario only needs the visible layout, and say so in the note.
- A check script the item supplies (challenge/<ID>-*.mjs) that times out waiting for network idle: run it once more at
  most, then record that check `NOT_RUN` with its log and keep your own passing checks; never loop on it.
