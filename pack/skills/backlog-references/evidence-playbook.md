# Evidence playbook (screenshots, running app, scenario data)

Read before screenshot, download or data scenarios. The rarer cases are in evidence-playbook-details.md; open it only
for the section you need:
- §3 Selectors: a screen you have not driven yet (take the flow from the project's e2e tests and page models), a custom
  select, a mobile menu, `ELEMENT_NOT_FOUND` / `ELEMENT_NOT_ACTIONABLE`.
- §4 `obscuredBy`: something covers the target (a shared layout bug).
- §5 A failing server (500, timeout, offline, slow): the `route` step.
- §6 Scenario data: `app_data` lock, seeding, a data step that went wrong.
- §7 Downloads (CSV export) and `waitFor`.
- §8 Pages that never settle (`idle: false`), check scripts the item supplies.

Scenarios that share app mode, phase, viewport and seeded data go in one call (context.scenario "TC-01..TC-03", one
screenshot or download per scenario named after it; §2); split only for a different app mode, phase, viewport or data.
At most two repaired retries per call and about a third of the time box; report unfinished checks NOT_RUN. A retry on
the same broken state is not a repair: when a call lands on a first-run, setup or login screen it should have passed,
or keeps loading, the saved profile or data is the fault. Start again clean (a new browserProfile name, app restart,
fresh seed) and do not count that clean start as a retry (EXP3I47A BUG-09: three captures on a profile spoilt by "Try
Demo" all fell back to the setup screen, all three scenarios NOT_RUN with 23 minutes left, -65). Never use a demo or
sample-data mode for evidence: its data does not survive a reload.

Before final evidence call worker_checkpoint ready_for_evidence: it syncs your worktree to main and usually returns
writesAllowed:true, so start the app again and capture at once. Only when it returns writesAllowed:false: stop writes
and end your turn with its hint as your reply; root gets the sync from the helper and sends a followup to resume (never
send_message to root). An item with a deadline that needs screenshots (the brief's `<screens_first>`) captures them
before ready_for_evidence, as soon as the page renders: after it the app waits for the closing build, which takes
minutes (QXUD1QAI CR-07: the page was never captured, -19).

Every capture_evidence call supplies context: {backlogItemKey, matchRoot, scenario, appMode: "dev"|"production",
phase: "before_fix"|"final"}. The helper records source/environment fingerprint, worktree, app mode, time and byte hash.
Final captures become stale when your own files, the environment or runtime changes synced from other items change
after capture (syncs of only tests and non-runtime docs keep them valid). Stale means recapture when time allows, never
downgrade: a scenario you verified stays PASS (note that it was captured before the sync) unless the synced change
alters what it shows.

## 0. Evidence the item text asks for
- **Non-UI reports, logs and text files (*.txt, *.json, *.csv, *.log)**: never use the browser. Run the test/script and
  write the output to `answers/<ID>/evidence/<name>`. Only PNG screenshots and browser downloads use `capture_evidence`.
- **Official test data figures** (a CSV of the official data, summary fields in submit.json): the replay script of
  `backlog-cr` §4.3, not the browser; rerun it after every sync.
- **Time box**: at most 3 minutes or 2 `capture_evidence` attempts. Screenshots taken before a failed step stay
  (`error.details.screenshotsDone`); the screen at the failed step is saved as `<scenario image>.FAILED-step<N>.png`
  (`error.details.diagnostic`): look at it to fix the steps, but never cite, rename or copy it as the scenario's file;
  candidate refuses a PASS that cites one. Report unfinished scenarios NOT_RUN and proceed to publish.

`<required_evidence>` lists files the item description names outside the MVS (ZVUYZ41V: a before-fix screenshot named
only in the Submission section; without it the item scored 0 of 200). Every listed file must exist in
`answers/<ID>/evidence/` and appear in `evidenceFiles`; a missing file scores the whole item 0.
- `beforeFix: true`: capture it **first**, before you change any code, on the unfixed app (`app start`, one
  `capture_evidence` call, `app stop`). It shows the defect, so take it even though the screen looks broken.
- Code already changed (a retry): `git diff HEAD --binary > <checkoutRoot>/.team-work/scratch/<ID>/fix.patch`,
  `git apply -R <that file>`, `app start` (it rebuilds), capture, `git apply <that file>`, check `git status`. Never
  `git stash`: the stash is shared by every worktree.

## 1. Start the app from your worktree: the `app` tool
- `app {action: "start", backlogItemKey: "<ID>", matchRoot: "<worktree matchRoot>"}` builds the production version,
  starts it on a free port (3100+), log in `<checkoutRoot>/.team-work/logs/<ID>-app.log`, and waits until it answers.
  `state: "ready"` gives the `url`; `"starting"`: `app {action: "status", backlogItemKey, waitSeconds: 50}`;
  `"failed"`: read `tail`, fix the cause, start again.
- The project README (often "Commands during the match") names its own build and serve commands: pass them as `custom`
  on the first `app start` instead of starting anything yourself (BUG-09 lost 2.5-3 minutes starting the server by
  hand). `custom: {build: [{command, cwd}], start: {command, cwd}, env: {NAME: value}}`, cwd relative to matchRoot;
  `{port}` is the helper's port, `{data}` a fresh data folder for your item, `{matchRoot}` your worktree match folder,
  e.g. `env: {APP_PORT: "{port}", APP_DATA_DIR: "{data}", WEB_ROOT: "{matchRoot}/src/web/build"}`. Later starts reuse
  it; `build: false` skips its build steps when the build output is current.
- A scenario whose precondition says the development app runs (`pnpm dev`): `app start` with `mode: "dev"` (no build;
  the first page load compiles, call `status` again). Every other scenario uses production. Capture every production
  scenario first, then start dev and capture the dev scenarios last: the dev server overwrites the production build.
- Never run `pnpm dev`, `next start` or `taskkill` yourself. Make every source change first (a seed script copied into
  `src/` counts), then start the app once: a later change makes capture fail `EVIDENCE_STALE_APP` naming the changed
  files; `app start` again rebuilds. `app {action: "stop", backlogItemKey}` once your evidence is written.
- `UNSUPPORTED_APP` (not a node app): pass `custom` with the README's commands; only when that cannot work, start it
  yourself on a free port from 3100 with output to the log path above (never into the worktree), and stop it with
  `taskkill /PID <pid> /T /F`. Never kill a process you did not start.
- Open the app with the `enterApp {url: "<base>"}` step at the start of every capture. It passes the first-run screens
  the app shows, in any order: server password setup (it sets the team's password for the match), a password-only
  sign-in, a user name + password sign-in (seeded account), a welcome screen with Start budgeting; it never clicks a
  demo or tour. Never hand-write fill/click steps for those screens (WQ7T6CEC CR-07 lost TC-03/04 that way).
  `ENTRY_STUCK` names the screen that came back: restart the app with fresh app data and call it again.
- The `login` step signs in with the account the app's seed script creates and never shows it to you. Never read,
  extract or type seed passwords yourself (`.env`, `seed.ts`), and never try another source after a failed login
  (auto-review rejects it as credential probing). Only an account the item or its test data names with its password
  is typed with `fill`.
- Never use computer use, desktop control or the operator's browser windows.

## 2. One `capture_evidence` call per app mode, viewport and data state
Every call is a model turn. Run the scenarios of one call in MVS order; each gets its own `assertText` and the
screenshot or download the MVS names (max 60 steps):
```
enterApp {url: "<base>"}   (or login {url: "<base>/login", matchRoot: "<worktree matchRoot>"} for a plain sign-in)
→ goto <the screen> → <TC-01 steps> → assertText <TC-01 value> → screenshot answers/<ID>/evidence/<TC-01 file>.png
→ <TC-02 steps, e.g. change the filter> → assertText <TC-02 value> → download / screenshot <TC-02 files>
```
- Files already written stay when a later step fails (`stepsDone`, `screenshotsDone`): retry in a new call from the
  failed scenario only, starting with `goto` and the steps that rebuild its state. A different viewport or app mode,
  or a scenario that needs fresh seed data, starts a new call.
- Each call opens a new blank page: the page, its filters and any dialog never carry over. Start every call with
  `goto` and repeat the steps that set its state.
- Give every call the same `browserProfile` (e.g. `"<id>-admin"`): cookies, localStorage and IndexedDB of the same
  origin survive into later calls; an app restarted on another port is a new origin. A failed step whose
  `error.details.url` is `/login` means the session is gone: put `login` back in; landing on a first-run or setup
  screen means the local data is gone.
- A scenario that checks data survives a reload: `waitFor` every record you wrote, the last one too, read back from
  the app's list or its saved message, and only then `goto` (a write in flight when the page unloads is lost: BUG-09
  lost 25 of 80 points). After any reload `waitFor` every expected record again before the screenshot. A setting the
  app reads on reload: change it, reload, then create the records the screenshot shows.
- `NAVIGATION_FAILED` (connection refused): the app is not running on that url; check `app status`, never retry blindly.
- `LOGIN_FAILED`: `error.details.visibleText` has the app's message. Seeding again (details §6) may restore it;
  otherwise the scenario is `NOT_RUN` with that message. A login bug the item is about is evidence: screenshot it.
- An action rejected by auto-review: do not retry it or reach the same result another way. Finish everything else,
  mark only the scenarios that needed it `NOT_RUN` with the reason, and return; never ask for approval.
- File names: exactly what the MVS lists under "Required evidence"; a `PASS` that misses one is not a pass.
- `assertText` before `screenshot`: a picture of the wrong state is worse than none. `assertText` waits up to 5 s;
  `screenshot` waits until requests and loading indicators are gone. A step with `unsettled` was captured while still
  loading: `waitFor` the loaded content and capture again (a page that never settles: details §8). Paths may be
  relative to `context.matchRoot` (`answers/<ID>/evidence/<name>.png`).
- A failed step returns `error.details` (`failedStep`, `url`, `visibleText`, clickable `candidates`): fix the steps
  from those, never by guessing (details §3).
