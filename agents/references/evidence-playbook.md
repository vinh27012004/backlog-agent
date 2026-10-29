# Evidence playbook (screenshots, running app, scenario data)

Read this before the first MVS scenario that needs a screenshot, a running app or data. Evidence is where items lost
the most time and points in practice (CV8WV1JM: BUG-02 fixed in 2 minutes, then 9 minutes of evidence and the item
closed unsubmitted; BC3JL6ZC: BUG-02 scored 30/150 because 6 `capture_evidence` calls never finished). The budget in
your rules holds: one call per scenario, at most 2 retries, at most a third of your time, then `NOT_RUN` with the
reason.

## 0. Evidence the item text asks for
`<required_evidence>` lists files the item description names outside the MVS (Practice ZVUYZ41V: "Capture screenshot
of Dashboard before fixing as dashboard_before_fixing.png" sat only in the Submission section; without it the item
scored 0 of 200 although all 3 scenarios passed). Every listed file must exist in `answers/<ID>/evidence/` and appear
in `evidenceFiles`; the gate fails the attempt as `evidence_missing` otherwise.
- `beforeFix: true`: capture it **first**, before you change any code, on the unfixed app (build, start, one
  `capture_evidence` call, stop). It shows the defect, so take it even though the screen looks broken.
- Code already changed (a retry): save your change as a patch, undo it, capture, re-apply it:
  `git diff HEAD --binary > <checkoutRoot>/.team-work/scratch/<ID>/fix.patch`, `git apply -R <that file>`, restart the
  app, capture, `git apply <that file>`, check `git status`. Never `git stash`: the stash is shared by every worktree.

## 1. Start the app from your worktree
- Build first, then start it on a free port (3100, 3101, …; another item's app may hold 3000) and record its PID.
  Stop it when your evidence is written: `taskkill /PID <pid> /T /F`.
- Send its output to `<checkoutRoot>/.team-work/logs/<ID>-app.log`, never into the worktree: a running app locks its
  log file on Windows and the orchestrator can no longer sync or remove the worktree (Practice HIET12OA).
- pnpm passes `--` literally: `pnpm exec next start -p 3100`, not `pnpm run start -- -p 3100`.
- `EADDRINUSE`: take the next port; never kill a process you did not start.
- Seeded login users and passwords are in the repo's seed script; use the ones the MVS names.
- Never use computer use, desktop control or the operator's browser windows.

## 2. One `capture_evidence` call per scenario
Put the whole flow in `steps` (max 60):
```
goto <base>/login → fill user → fill password → click "Sign in" → waitFor <a text of the first page>
→ goto <the screen> → <the MVS steps> → assertText <the expected value>
→ screenshot answers/<ID>/evidence/<exact file name the MVS asks for>.png
```
- Give every call the same `browserProfile` (e.g. `"<id>-admin"`): the login cookie is kept, so later calls may start
  at the screen. A failed step whose `error.details.url` is `/login` means the session is gone: put the login steps
  back in.
- File names: exactly what the MVS lists under "Required evidence"; the gate fails a `PASS` that misses one.
- `assertText` before `screenshot`: a picture of the wrong state is worse than none.

## 3. Selectors
- `selector` is plain CSS. Playwright syntax (`:has-text()`, `>>`, `text=`) fails with `INVALID_SELECTOR`.
- Pick by visible text with `selector` + `text` together: `{selector: "[role=tab]", text: "Invoices"}`,
  `{selector: "button", text: "New invoice"}`; `index` picks the n-th match.
- A custom select (Radix, shadcn): click its trigger, then `{action: "click", selector: "[role=option]", text: "<name>"}`.
  A native `<select>` uses `{action: "select", selector, value}`.
- A failed step returns `error.details`: `failedStep`, `url`, `visibleText` and the clickable `candidates` on the page.
  Fix the steps from those, never by guessing.

## 4. Something covers the target (`ELEMENT_OBSCURED`)
- On a UI-layout bug, the cover is the bug: that failure is your "before" evidence.
- Otherwise retry that click with `force: true` (Practice #5: BUG-01's sidebar covered the Accounting tabs in every
  other item's worktree). Say in the scenario note that a shared layout bug was clicked through.
- Never copy another item's files into your worktree to get rid of it, and never pause to wait for a sync: the
  orchestrator syncs between attempts. "Waiting for the other item's fix" is never a reason to mark a scenario
  `NOT_RUN` or to reply `partial` (Practice TOKXKPBV: CR-01 did, and its evidence-only second attempt cost 6 minutes).

## 5. A failing server (500, timeout, offline, slow)
Add a `route` step before the action that sends the request, e.g. `{action: "route", url: "/api/invoices/export",
status: 500, times: 1}`, `abort: "TimedOut"` or `delayMs: 8000`. Never change code, stop the server or the database to
cause it. Write in the scenario note and `engineeringRecord` that the failure was simulated in the browser (the result
lists it in `routed`).

## 6. Scenario data
Every worktree's app uses the same app database, and organizer seeds wipe and recreate data (Practice #2: CR-01's
seed deletes every invoice; a misclick voided BUG-02's invoice and the later scenarios ran on damaged data).
1. `app_data {action: "lock", backlogItemKey, waitSeconds: 50}`; repeat while it returns `locked: false`.
2. Run the seed the MVS names, then every data scenario in MVS order in one pass (later ones often use records an
   earlier one created).
3. A step went wrong (wrong click, wrong value, a record in an unexpected state such as VOID): stop, re-seed only if the
   script says it is safe to re-run (otherwise mark the scenarios `NOT_RUN`), and redo from the first data scenario.
4. `app_data {action: "unlock"}` once the evidence or report that reads the data is written.
Never create records the MVS did not ask for.

## 7. What `capture_evidence` cannot do
A file download or an API-only check: write a small script under `<checkoutRoot>/.team-work/scratch/<ID>/` (never in
the match folder), save its output as the evidence file, and fix it at most twice.
