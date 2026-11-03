# Đề Practice Match · bộ item Solova 1

Bộ item dùng từ practice #1 `E1OOHQ5U` tới #13 `MZP27104` ([practice-log.md](practice-log.md)). App: Solova,
Next.js + Prisma + PostgreSQL. Nội dung đề chép nguyên văn từ trang trận (tiếng Anh), chỉ hạ cấp heading cho từng
item. Phần đầu của BUG-01 (loại, trạng thái, deadline) không có trong bản chép; điểm lấy từ nội dung đề.

| Item | Loại | Điểm | Deadline | Tóm tắt |
|---|---|---|---|---|
| [BUG-01](#bug-01) | Bug | 200 | — | Sidebar desktop che nội dung chính |
| [BUG-02](#bug-02) | Bug | 150 | 18 phút từ lúc mở | Số tiền khách VND bị nhân 100 |
| [CR-01](#cr-01) | Change Request | 300 | — | Xuất danh sách invoice đã lọc ra CSV |
| [TASK-02](#task-02) | Task | 250 | — | Sửa lỗ hổng dependency production |
| [TASK-01](#task-01) | Task | 100 | — | Truy vị trí card sau khi kéo thả (chỉ trả lời) |

Lần nộp gần nhất của mỗi item trên trang: `Latest attempt #1 · GRADED`.

---

## BUG-01

Bug · 200 pts

### Desktop sidebar obscures the main content

#### Context
After login, the left sidebar overlaps content on Dashboard and other administration pages on desktop. Statistics, charts, or tables at the left edge cannot be read. The small-screen mobile interface remains usable.

#### Expected outcome
On desktop, the main content and top bar sit beside the sidebar and remain fully readable.

#### Requirements
Fix the shared administration layout in both development and production. Preserve mobile navigation and existing page controls. Maximum practice score: 200 points.

Desktop wireframe:

```text
| Sidebar | Top bar                         |
| Sidebar | Dashboard / administration page |
| Sidebar | Cards, charts, tables           |
```

#### Acceptance criteria
1. The sidebar does not cover main content or the top bar on any administration page at desktop widths, including 1024px and 1440px.
2. The result holds with pnpm dev and the production pnpm build / pnpm start flow.
3. At 390px viewport width, mobile navigation and content remain usable without a new overlapping desktop sidebar.
4. Existing pnpm test cases and pnpm typecheck pass.

#### Out of scope
Redesigning the navigation, replacing charts, or unrelated refactoring.

#### Submission

Create `answers/BUG-01/`, copy `challenge/BUG-01-submit.json` to `answers/BUG-01/submit.json`, and create its `evidence/` child directory. Capture screenshot of Dashboard before fixing as dashboard_before_fixing.png and commit to `evidence/` folder. Record actual test results and relative evidence paths. Every PASS result must reference an existing evidence file. Commit source, tests, evidence, and the completed submission together. Do not add a gitRevision field; give the pushed commit SHA to Game Master separately.

##### submit.json contract

`submit.json` must validate against `challenge/BUG-01-submit.schema.json` (JSON Schema 2020-12), delivered with the submit template. Grading checks this schema first: a file that does not validate scores 0 and no test case is graded.

- Start from the template. It already lists one `testResults` row per test case, in the required order: `BUG-01-TC-01`, `BUG-01-TC-02`, `BUG-01-TC-03`. Keep exactly these rows and these field names: `id`, `result`, `evidence`, and optionally `note`. Do not rename, add or remove fields or rows.
- `result` is `PASS`, `FAIL` or `NOT_RUN` (upper case). A `PASS` row lists at least one evidence path.
- Evidence paths are `evidence/<file name>`, for files directly inside `answers/BUG-01/evidence/`.
- Before submitting, set the top-level `status` to `DONE` (all requirements met), `PARTIAL` or `BLOCKED`.

Example row:

```json
{ "id": "BUG-01-TC-01", "result": "PASS", "evidence": ["evidence/<file name>"] }
```

Complete the engineering record with observed/expected behavior, diagnosis, affected files, changes, and verification. Its prose supports review; functional behavior determines points.

---

## BUG-02

Bug · 150 pts · Deadline 18 min from reveal

### Amounts for VND clients are 100 times too large

#### Context
Our accountant reports that invoices for Vietnamese clients are wrong. When she creates an invoice for a client billed in VND and types a unit price of 12,345, the saved invoice shows ₫1,234,500. Payments recorded for those clients are inflated the same way. Invoices for USD clients look correct.

#### Expected outcome
Amounts typed for a client are saved and shown in that client's currency, following Solova's accounting standards for money, for every currency the product supports.

#### Requirements
Fix the amounts entered on Accounting screens for clients whose currency differs from the workspace currency. Existing USD behaviour, stored data of other invoices and accounting postings must stay correct. Maximum practice score: 150 points. This item has a deadline of 18 minutes from its release: after that, Game Master closes the item and accepts no submission for it.

Screen flow:

```text
Accounting → Invoices → New invoice → client billed in VND → unit price 12345 → Create → Issue
Accounting → Payments → same client → applies to that invoice → amount 5000 → Record
```

#### Acceptance criteria
1. An invoice for a VND client with unit price 12345 is saved with total ₫12,345 (12345 minor units).
2. A payment of 5000 applied to it is saved as ₫5,000 and the invoice becomes partially paid.
3. An invoice for a USD client with unit price 123.45 is still saved as $123.45.
4. Existing tests keep passing. Do not weaken, skip or delete existing tests. If an existing test contradicts the application's intended behavior, fix the test and explain why in the engineering record.

#### Verification data
Verify with the official QA test data issued to your team for BUG-02; other data cannot match the expected results. A loader script, a report script and the verification scenarios are provided when you start this item.

#### Out of scope
Currency conversion, changing invoice numbering or accounting postings, and unrelated UI changes.

#### Submission

Create `answers/BUG-02/`, copy `challenge/BUG-02-submit.json` to `answers/BUG-02/submit.json`, and create its `evidence/` child directory. Follow the evidence rules and file names in `BUG-02-minimum-verification-scenarios.md`. Every PASS result must reference an existing evidence file. Commit source, tests, evidence, and the completed submission together. Do not add a gitRevision field; give the pushed commit SHA to Game Master separately.

##### submit.json contract

`submit.json` must validate against `challenge/BUG-02-submit.schema.json` (JSON Schema 2020-12), delivered with the submit template. Grading checks this schema first: a file that does not validate scores 0 and no test case is graded.

- Start from the template. It already lists one `testResults` row per test case, in the required order: `BUG-02-TC-01`, `BUG-02-TC-02`, `BUG-02-TC-03`, `BUG-02-TC-04`. Keep exactly these rows and these field names: `id`, `result`, `evidence`, and optionally `note`. Do not rename, add or remove fields or rows.
- `result` is `PASS`, `FAIL` or `NOT_RUN` (upper case). A `PASS` row lists at least one evidence path.
- Evidence paths are `evidence/<file name>`, for files directly inside `answers/BUG-02/evidence/`.
- Before submitting, set the top-level `status` to `DONE` (all requirements met), `PARTIAL` or `BLOCKED`.

Example row:

```json
{ "id": "BUG-02-TC-01", "result": "PASS", "evidence": ["evidence/tc-01-vnd-invoice.png", "evidence/currency-report.txt"] }
```

Complete the engineering record with the observed and expected behaviour, the root cause, the affected files, the change and its verification.

---

## CR-01

Change Request · 300 pts

### Export the filtered invoice list as CSV

#### Context
Our accountants import invoice lists into their bookkeeping tool. Today they retype invoices from the Accounting screen because Solova has no export. They asked for a CSV download that their tool can import without manual fixing.

#### Expected outcome
On Accounting → Invoices, the user can download, as one CSV file, exactly the invoice list selected by the current company filter.

#### Requirements
1. Place a button labelled **Export CSV** beside **New invoice**, to the right of the company filter. Keep the existing controls available.
2. Export every invoice returned by the current company filter, in the order shown on screen, without silently excluding any status. An empty selection still downloads a valid file.
3. The file goes straight into the accountants' import tool, so its layout, encoding, columns, amounts, paid and outstanding balances, status values and dates must follow Solova's accounting data-exchange standards exactly. The accounting team maintains those standards in the company's internal systems; they are authoritative and override assumptions.
4. Invoice and company financial data stays restricted to signed-in staff, also through the new export. Either an authenticated server export or an export built from the already authenticated invoice list is acceptable.
5. Add automated tests for the export logic, including filtering, CSV escaping, amount/date formatting and the signed-out case. Existing tests must keep passing. Do not weaken, skip or delete existing tests. If an existing test contradicts the application's intended behavior, fix the test and explain why in the engineering record.

Desktop wireframe:

```text
Accounting
Reports | Invoices | Payments | Products | Expenses | Journal | Accounts
[All companies / selected company]       [Export CSV] [New invoice]
Invoice list selected by that company filter
```

#### Acceptance criteria
1. Clicking Export CSV on Invoices downloads a CSV of exactly the invoices selected by the active company filter, in screen order, including draft and void invoices.
2. The file conforms to Solova's invoice export standard: encoding, header, column order, quoting, amounts per currency, paid and outstanding balances, status values and dates.
3. Company names with Vietnamese letters, commas, double quotes and line breaks survive the round trip unchanged.
4. An empty selection downloads a file with only the header row; existing invoice actions keep working.
5. Signed-out users cannot obtain invoice data or an export through the implemented flow.
6. `pnpm test` (including the new tests) and `pnpm typecheck` pass.

#### Verification data
Verify with the official QA test data issued to your team for CR-01; other data cannot match the expected results. A loader script and the verification scenarios are provided when you start this item.

#### Out of scope
PDF export, changing invoice accounting or statuses, currency conversion, and unrelated UI changes. Do not introduce a heavy library when it is unnecessary. Formula-injection protection is optional and carries no points; if you add it, the verification data must still round-trip unchanged.

#### Submission
Create `answers/CR-01/` with `submit.json` (copied from `challenge/CR-01-submit.json`) and an `evidence/` child folder. Follow the evidence rules and file names in `CR-01-minimum-verification-scenarios.md`. Every PASS result must reference existing evidence files. Commit source, tests, evidence and the completed submission together. Do not add a gitRevision field; give the pushed commit SHA to Game Master separately.

##### submit.json contract

`submit.json` must validate against `challenge/CR-01-submit.schema.json` (JSON Schema 2020-12), delivered with the submit template. Grading checks this schema first: a file that does not validate scores 0 and no test case is graded.

- Start from the template. It already lists one `testResults` row per test case, in the required order: `CR-01-TC-01` … `CR-01-TC-05`. Keep exactly these rows and these field names: `id`, `result`, `evidence`, and optionally `note`. Do not rename, add or remove fields or rows.
- `result` is `PASS`, `FAIL` or `NOT_RUN` (upper case). A `PASS` row lists at least one evidence path.
- Evidence paths are `evidence/<file name>`, for files directly inside `answers/CR-01/evidence/`.
- Before submitting, set the top-level `status` to `DONE` (all requirements met), `PARTIAL` or `BLOCKED`.

Example row:

```json
{ "id": "CR-01-TC-01", "result": "PASS", "evidence": ["evidence/tc-01-all-invoices.png", "evidence/tc-01-all-invoices.csv"] }
```

The engineering record describes the chosen export design, the standards applied and the edge cases handled. Its completeness is reviewed, but prose quality does not change functional points.

---

## TASK-02

Task · 250 pts

### Resolve production dependency vulnerabilities

#### Context
A production dependency security report identifies high and critical findings in the issued application. Resolve them while keeping the application usable, especially its existing credentials login.

#### Expected outcome
No high or critical findings remain in production dependencies. Existing application features still work.

#### Requirements
Use the locked dependency graph as the starting point. Limit changes to package.json, pnpm-lock.yaml, pnpm-workspace.yaml, compatibility code required by changed APIs, and existing tests that contradict intended behavior. Do not remove features or required packages, suppress audit findings, disable security checks, or add unrelated dependencies. Development-only moderate findings are outside the mandatory target. No particular package version is mandated.

#### Acceptance criteria
1. pnpm install --frozen-lockfile succeeds with the submitted manifests.
2. pnpm audit --prod --audit-level=high reports no high or critical production findings.
3. pnpm typecheck and all existing pnpm test cases pass. Do not weaken, skip or delete existing tests. If an existing test contradicts the application's intended behavior, fix the test and explain why in the engineering record.
4. A valid seeded user can log in, open Dashboard and Accounting, refresh while remaining authenticated, and log out; a signed-out browser cannot access Accounting data.
5. The engineering record lists upgraded packages with old/new versions, transitive dependency handling, compatibility changes, and remaining lower-severity findings with reasons.

#### Canonical scope
Production dependencies reachable from the issued lockfile, required API compatibility changes, and the existing login flow.

#### Canonical algorithm
Inspect the production audit report, fix the reported high/critical findings, install with the frozen lockfile, run typecheck and existing tests, and replay login and signed-out checks. Submit changes and actual results. This is an implementation task, not an exact-JSON source-analysis question.

#### Normalization
Keep machine-produced logs intact. Record installed package versions rather than only manifest ranges. Explain infrastructure failures instead of reporting PASS.

#### Ordering
Verification order: frozen installation, production audit, typecheck, tests, authentication smoke checks.

#### Answer format
Complete submit.json with changes and evidence. Maximum practice score: 250 points. Functional checks determine points; engineering prose is supporting evidence only.

#### Out of scope
Unrelated refactoring and removing lower-severity development-only findings.

#### Submission

Create `answers/TASK-02/`, copy `challenge/TASK-02-submit.json` to `answers/TASK-02/submit.json`, and create its `evidence/` child directory. Record actual test results and relative evidence paths. Every PASS result must reference an existing evidence file. Commit source, tests, evidence, and the completed submission together. Do not add a gitRevision field; give the pushed commit SHA to Game Master separately.

`testResults` rows follow the verification order above: `TASK-02-TC-01` frozen installation, `TASK-02-TC-02` production audit, `TASK-02-TC-03` typecheck, `TASK-02-TC-04` existing tests, `TASK-02-TC-05` authentication smoke checks (login, Dashboard, Accounting, refresh, logout, signed-out access).

##### Evidence

After your changes, run the provided check runner from the `src/` folder: `node <path>/TASK-02-run-checks.mjs ../answers/TASK-02/evidence`. It runs the first four checks in order and writes `install.log`, `audit.log`, `typecheck.log` and `test.log`. Keep them unedited. Add two screenshots for the authentication smoke checks: `tc-05-login-dashboard.png` (signed in on Dashboard after a refresh) and `tc-05-signed-out.png` (a fresh private window opening `/accounting`).

| Test case | Evidence |
|---|---|
| `TASK-02-TC-01` | `evidence/install.log` |
| `TASK-02-TC-02` | `evidence/audit.log` |
| `TASK-02-TC-03` | `evidence/typecheck.log` |
| `TASK-02-TC-04` | `evidence/test.log` |
| `TASK-02-TC-05` | `evidence/tc-05-login-dashboard.png`, `evidence/tc-05-signed-out.png` |

Grading also reads `src/package.json`, `src/pnpm-lock.yaml`, `src/pnpm-workspace.yaml` and the original test files at the commit you submit.

##### submit.json contract

`submit.json` must validate against `challenge/TASK-02-submit.schema.json` (JSON Schema 2020-12), delivered with the submit template. Grading checks this schema first: a file that does not validate scores 0 and no test case is graded.

- Start from the template. It already lists one `testResults` row per test case, in the required order: `TASK-02-TC-01`, `TASK-02-TC-02`, `TASK-02-TC-03`, `TASK-02-TC-04`, `TASK-02-TC-05`. Keep exactly these rows and these field names: `id`, `result`, `evidence`, and optionally `note`. Do not rename, add or remove fields or rows.
- `result` is `PASS`, `FAIL` or `NOT_RUN` (upper case). A `PASS` row lists at least one evidence path.
- Evidence paths are `evidence/<file name>`, for files directly inside `answers/TASK-02/evidence/`.
- Before submitting, set the top-level `status` to `DONE` (all requirements met), `PARTIAL` or `BLOCKED`.

Example row:

```json
{ "id": "TASK-02-TC-01", "result": "PASS", "evidence": ["evidence/<file name>"] }
```

---

## TASK-01

Task · 100 pts

### Trace a card position after reordering

#### Context
Understand the existing board ordering behavior from the issued source. In an initially empty list on a board, a user creates cards A, B, C sequentially using the normal Create card action. They then drag C between A and B.

#### Canonical scope
Use the issued source at commit 571c531681e672241f18842025c905e499a3641d. Follow normal card creation and the same-list drag-and-drop flow. Exclude templates, imported cards, concurrent changes, and previously existing cards.

#### Canonical algorithm
Determine the positions assigned by normal creation in the given order. Follow the move operation with A immediately before C and B immediately after C. Apply any rebalance rule that this source would trigger. Report C's final persisted database position.

#### Normalization
The answer is one unsigned decimal integer string, without whitespace, separators, units, or explanatory prose. Do not return a JSON number.

#### Ordering
The initial visible order is A, B, C; the final visible order is A, C, B. There is only one answer field.

#### Answer format
Set the position field in submit.json to the required string. Maximum practice score: 100 points. The answer is compared by exact string equality; no AI judgment is used.

#### Submission

Create `answers/TASK-01/`, copy `challenge/TASK-01-submit.json` to `answers/TASK-01/submit.json`, and create its `evidence/` child directory. Record actual test results and relative evidence paths. Every PASS result must reference an existing evidence file. Commit source, tests, evidence, and the completed submission together. Do not add a gitRevision field; give the pushed commit SHA to Game Master separately.

##### submit.json contract

`submit.json` must validate against `challenge/TASK-01-submit.schema.json` (JSON Schema 2020-12), delivered with the submit template. Grading checks this schema first: a file that does not validate scores 0.

- Keep exactly the template fields: `schemaVersion`, `backlogId`, `status`, `evidenceFiles`, `position`. Do not add or rename fields.
- `position` is a JSON string of digits only, for example `"123"`, not a JSON number.
- Evidence paths are `evidence/<file name>`, for files directly inside `answers/TASK-01/evidence/`.
- Before submitting, set the top-level `status` to `DONE`, `PARTIAL` or `BLOCKED`.
