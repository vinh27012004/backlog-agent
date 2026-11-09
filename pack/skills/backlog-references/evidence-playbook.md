# Evidence playbook (screenshots, running app, scenario data)

Read before screenshot, download or data scenarios. Scenarios that share app mode, phase, viewport and seeded data go
in one call (context.scenario "TC-01..TC-03", one screenshot or download per scenario named after it; §2); split only
for a different app mode, phase, viewport or data. At most two repaired retries per call and about a third of the
time box; report unfinished checks NOT_RUN. Before final evidence call worker_checkpoint ready_for_evidence: it syncs your worktree to main and usually returns writesAllowed:true, so start
the app again and capture at once. Only when it returns writesAllowed:false: stop writes and end your turn with its
hint as your reply; root gets the sync from the helper and sends a followup to resume (never send_message to root).

Every capture_evidence call supplies context: {backlogItemKey, matchRoot, scenario, appMode: "dev"|"production",
phase: "before_fix"|"final"}. Helper records source/environment fingerprint, worktree, app mode, time and byte hash
outside the checkout. Before-fix evidence keeps its own phase. Final captures become stale when your own files or the
environment change after capture; runtime changes synced from other items also invalidate them. Stale means
recapture when time allows, never downgrade: a scenario you verified stays PASS (note that it was captured before the
sync) unless the synced change alters what it shows. Only syncs limited to
tests and non-runtime documentation keep them valid. A manifest proves
provenance, not correct UI.

## 0. Evidence the item text asks for
- **Non-UI reports, logs and text files (e.g. *.txt, *.json, *.csv, *.log)**: NEVER use the browser for these.
  Generate them directly by running the test/script command and piping output to `answers/<ID>/evidence/<name>`
  (e.g. `node script.js > answers/<ID>/evidence/report.txt`). Only PNG screenshots and browser downloads use `capture_evidence`.
- **Time box**: Spend at most 3 minutes or 2 `capture_evidence` attempts. If a step fails, screenshots taken before it
  stay (`error.details.screenshotsDone`) and the helper saves the screen at the failed step as
  `<scenario image>.FAILED-step<N>.png` (`error.details.diagnostic`): look at it to fix the steps, but never cite it in
  testResults, rename it or copy it to the scenario's file name; candidate refuses a PASS that cites one. Report
  unfinished scenarios NOT_RUN honestly and proceed to publish.

`<required_evidence>` lists files the item description names outside the MVS (Practice ZVUYZ41V: "Capture screenshot
of Dashboard before fixing as dashboard_before_fixing.png" sat only in the Submission section; without it the item
scored 0 of 200 although all 3 scenarios passed). Every listed file must exist in `answers/<ID>/evidence/` and appear
in `evidenceFiles`; a missing file scores the whole item 0.
- `beforeFix: true`: capture it **first**, before you change any code, on the unfixed app (`app start`, one
  `capture_evidence` call, `app stop`). It shows the defect, so take it even though the screen looks broken.
- Code already changed (a retry): save your change as a patch, undo it, capture, re-apply it:
  `git diff HEAD --binary > <checkoutRoot>/.team-work/scratch/<ID>/fix.patch`, `git apply -R <that file>`, `app start`
  again (it rebuilds), capture, `git apply <that file>`, check `git status`. Never `git stash`: the stash is shared by every worktree.

## 1. Start the app from your worktree: the `app` tool
- `app {action: "start", backlogItemKey: "<ID>", matchRoot: "<worktree matchRoot>"}` builds the production version,
  starts it detached on a free port (3100+) with its log in `<checkoutRoot>/.team-work/logs/<ID>-app.log`, and waits
  until it answers. `state: "ready"` gives the `url` for `capture_evidence`; `"starting"`: call
  `app {action: "status", backlogItemKey, waitSeconds: 50}`; `"failed"`: read `tail`, fix the cause, start again.
- The project README (often a "Commands during the match" section) names its own build and serve commands, e.g.
  build the web app, then run a server that serves it with environment variables for its port and data folders:
  pass them as `custom` on the first `app start` instead of starting anything yourself (OMZJW0S0 and UOMNKT6Z BUG-09:
  the plain start ran the wrong app and the fixer lost 2.5-3 minutes and two failed launches starting the server by
  hand). `custom: {build: [{command, cwd}], start: {command, cwd}, env: {NAME: value}}`, cwd relative to matchRoot;
  `{port}` is the port the helper picked, `{data}` a fresh data folder for your item outside the worktree (folders an
  env value names under it are created), `{matchRoot}` your worktree match folder, e.g.
  `env: {APP_PORT: "{port}", APP_DATA_DIR: "{data}", APP_FILES: "{data}/files", WEB_ROOT: "{matchRoot}/src/web/build"}`.
  Later starts of the item reuse it; `build: false` skips its build steps when the build output is current.
- A scenario whose precondition says the development app runs (`pnpm dev`, "development app running"): `app start`
  with `mode: "dev"` (runs the dev script, no build; the first page load compiles, so `waitSeconds` may run out:
  call `status` again). Every other scenario uses the default production mode; switch with `app start` again
  (Practice NO5X6J0K: BUG-01-TC-01 needed the dev app, the tool only ran production, the scenario went `NOT_RUN`
  and the item lost 67 of 200 points).
- Group scenarios by mode and switch once: the dev server overwrites the production build, so every production
  start after a dev run rebuilds. Capture every production scenario first, including those that only need "app
  running" (a mobile viewport, for example), then start dev and capture the dev scenarios last (Practice J56ZZWSS:
  BUG-01 started the app 11 times across dev and production).
- Never run `pnpm dev`, `next start` or `taskkill` yourself (Practice TOKXKPBV: BUG-01's fixer started the dev
  server 4 times, killed processes by port and lost 6 minutes to a dev server that served stale CSS).
- Changed code since the last start: `app start` again; it stops the old app and rebuilds. Pass `build: false` only
  right after a build you ran yourself. Make every source change first (a seed script copied into `src/` counts),
  then start the app once: a later change makes capture fail `EVIDENCE_STALE_APP` naming the changed files (Practice
  4D895OVI: CR-01 and CR-02 rebuilt the app twice each).
- `app {action: "stop", backlogItemKey}` once your evidence is written (also on a time box stop).
- `UNSUPPORTED_APP` (not a node app): pass `custom` with the README's commands; only when that cannot work either,
  build, then start it yourself on a free port from 3100, output to the log path
  above (never into the worktree: Windows locks a running app's log and the worktree can no longer be synced or
  removed), and stop it with `taskkill /PID <pid> /T /F`. Never kill a process you did not start.
- Sign in with the `login` step (§2): the helper signs in with the account the app's seed script creates and never
  shows it to you. Never read, extract or type seed passwords yourself (`.env`, `seed.ts`, regex, dotenv), and never
  try another source after a failed login (Practice 9KNXREJ5: CR-01's fixer read `ADMIN_*` from a `.env` that had
  none, the login failed, it then pulled the default password out of `prisma/seed.ts`; auto-review rejected that as
  credential probing and the item lost its authenticated evidence). Only an account the item or its test data names
  with its password is typed with `fill`.
- Never use computer use, desktop control or the operator's browser windows.

## 2. One `capture_evidence` call per app mode, viewport and data state
Every call is a model turn. Run the scenarios of one call in MVS order; each gets its own `assertText` and the
screenshot or download the MVS names (max 60 steps):
```
login {url: "<base>/login", matchRoot: "<worktree matchRoot>"}
→ goto <the screen> → <TC-01 steps> → assertText <TC-01 value> → screenshot answers/<ID>/evidence/<TC-01 file>.png
→ <TC-02 steps, e.g. change the filter> → assertText <TC-02 value> → download / screenshot <TC-02 files>
```
Files already written stay when a later step fails (`stepsDone` and `screenshotsDone` list them): retry in a new call from the failed
scenario only, starting with `goto` and the steps that rebuild its state. A different viewport or app mode, or a
scenario that needs fresh seed data, starts a new call.
- Each call opens a new blank page: the page, its filters and any dialog never carry over. Start every call with
  `goto` to the screen and repeat the steps that set its state (Practice 4D895OVI: CR-01 lost three calls to
  `ELEMENT_NOT_FOUND` expecting the page left open by the previous call).
- Give every call the same `browserProfile` (e.g. `"<id>-admin"`): cookies, localStorage and IndexedDB are kept
  for the same origin (scheme, host and port), so a login or a budget/document the app keeps in the browser survives
  into later calls; an app restarted on another port is a new origin with none of it. A failed step whose
  `error.details.url` is `/login` means the session is gone: put the `login` step back in (it returns
  `alreadySignedIn` when the cookie still holds); landing on a first-run or setup screen means the local data is gone.
- A scenario that reloads the page so the app reads a changed setting: change the setting, reload (`goto` the same
  screen), and only then create the records the screenshot shows, `waitFor` each of them and capture without another
  reload. When the scenario needs a reload after writes (it checks that data survives), first `waitFor` every record
  you wrote, the last one too, read back from the app's list or its saved message, and only then `goto`: a write still
  in flight when the page unloads is lost (OMZJW0S0 and UOMNKT6Z BUG-09-TC-02: the schedule added last vanished on the
  reload right after its Add click, the scenario went NOT_RUN and lost 25 of 80 points). After any reload `waitFor`
  every expected record again before the screenshot.
- `NAVIGATION_FAILED` (connection refused): the app is not running on that url; check `app status`, never retry blindly.
- `LOGIN_FAILED`: the app refused the seeded account; `error.details.visibleText` has its message. Seeding again
  (`app_data` lock, §6) may restore it; otherwise the scenario is `NOT_RUN` with that message. A login bug the item
  itself is about is evidence: screenshot the error instead.
- An action rejected by auto-review: do not retry it or reach the same result another way. Finish everything else,
  mark only the scenarios that needed it `NOT_RUN` with the stated reason, and return; never ask for approval
  (nobody answers during the match).
- File names: exactly what the MVS lists under "Required evidence"; a `PASS` that misses one is not a pass.
- `assertText` before `screenshot`: a picture of the wrong state is worse than none.
  `assertText` waits up to 5 s; `screenshot` waits until requests and loading indicators are gone. A step with
  `unsettled` was captured while still loading: `waitFor` the loaded content and capture again. Paths may be
  relative to `context.matchRoot` (`answers/<ID>/evidence/<name>.png`).

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
