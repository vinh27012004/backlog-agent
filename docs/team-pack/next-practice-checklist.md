# Cần kiểm ở trận luyện sau (#8)

Những thay đổi đã qua test offline (`node --test "tests/pack/*.test.mjs"`) nhưng chưa chạy trên trận thật, cộng các mục
trận #7 (`ZVUYZ41V`) chưa kiểm được. Sau trận, chạy `/judge-practice <match checkout>` (gồm cả `tools/judge/usage.mjs`),
rồi đối chiếu từng mục dưới đây với transcript (`~/.codex/sessions/<ngày>/`, root là file `source: "vscode"`, subagent
có `agent_path`) và `<checkout>/.team-work/journal.json`. Ghi kết quả vào `practice-log.md` mục #8; mục nào đạt thì xoá
khỏi file này. Kết quả đối chiếu của #7: `practice-log.md`, mục #7, "Đối chiếu checklist".

## Sau `33R91I3Q` (13/11): cần kiểm ở trận kế và việc còn mở

Các sửa lỗi của `practice-log.md` mục #25 (commit `2a1299d`, `22eb132`) mới qua test offline và một lần tái hiện
`enterApp` trên bản build của trận; chưa trận thật nào chạy chúng.

**Trước trận**
- [ ] Cài lại pack: `pwsh -NoProfile -File pack/install.ps1 -TeamWorkspace D:\mtm\BUN -Force`.
- [ ] `team-sdlc-pack/local/models.json` không tồn tại (đã xoá sau lần thử luna): CR/BUG/PI chạy `gpt-6.1-sol`.
- [ ] Chạy cùng bộ 14 item để so với `DVVFEPXF` (judge 12/14, 238 credit) và `33R91I3Q` (8/14, 64 credit).
- [ ] Nên cài Node 22 LTS: Node 24.11.1 của máy làm 2 test `windows-1252` trong `parse-file.test.ts` luôn đỏ.

**Kiểm sau trận** (transcript từng thợ + `journal.json`)
- [ ] `enterApp`: `screens` có `setup`/`signin`/`welcome` ở lần đầu của mỗi server mới, không còn `screens: []` rồi kẹt
      ở `/bootstrap` (L137). Có lần nào kết thúc ở "Too many requests" không (L145).
- [ ] `worktree sync` có `autoMerged`: file sau gộp còn biên dịch được, không dòng nào bị lặp (L138; xem
      `budget/app.ts`, `FinancesApp.tsx`).
- [ ] `app start` của đề thứ hai trở đi trả `commandsFrom`; không thợ nào tự viết lại `custom` (L139). Đếm số lần
      `app start` mỗi đề và thời gian tới `ready`.
- [ ] `typecheckGate`: có lần từ chối nào, đúng hay nhầm; main cuối trận typecheck sạch (L140). Đề sát hạn vẫn lọt
      (chỉ đòi chạy khi còn ≥ 4 phút).
- [ ] Baseline lúc chuẩn bị là `FAIL`/`PASS`, không `TIMEOUT` (L141).
- [ ] Checklist: brief của mọi đề có `<checklist>` ngay lúc prepare; `checklistDelivered` có ở đề chỉ trả lời và đề
      có hạn (33R91I3Q: 6/14 không nhận); `checklistSeen` từ chối đúng chỗ, không chặn nhầm như TASK-08 (L142).
- [ ] Thiếu evidence đề yêu cầu giờ bị từ chối một lần (trước chỉ cảnh báo, lựa chọn 03/11): xem có tốn lượt vô ích
      không, nếu có thì trả về cảnh báo.

**Bỏ analyst** (13/11, nhánh `turning/QXUD1QAI-base`, chưa trận nào chạy)
- [ ] Root không còn `spawn_analyst`; mỗi đề đúng một thread `team_fixer`.
- [ ] `.team-work/items/<ID>/grading-rules.json` có ở mọi đề; `detection: true` chỉ ở đề chấm "broken build" (bộ 14
      item: TASK-08). Đề khác gọi `run_checks mutants` nhận `skipped`, `mutantGate` không đòi.
- [ ] Phụ thuộc vẫn đủ: CR-08 → CR-05, CR-07 → BUG-11 có `dependsOn` từ chữ đề (trước đây analyst cũng chỉ thấy hai cặp này).

**Thêm sau `CUZ7KL95`** (practice-log #26, chưa trận nào chạy)
- [ ] Đề sát hạn gặp `SYNC_REQUIRED`: job publish có bước `sync`, cảnh báo `last call: main had changed …`, item được nộp (L148).
- [ ] Root spawn mọi `spawn_worker` ngay lượt nhận, không gọi `wait_for_update`/`next_actions` xen giữa (L149): so `spawnOfferedAt` với giờ bắt đầu thread.
- [ ] `app_data lock` trả `dedicated` cho đề chạy server riêng; không đề nào chờ khoá của đề khác (L150).
- [ ] Root không còn tự gọi `publish_item` khi helper publish được (L151).
- [ ] Có `interrupt_worker` nào không, root gọi `interrupt_agent` đúng một lần (L153).

**Việc còn mở** (chưa làm, có lý do)
- Gộp `<grading>`, `<required_evidence>`, `<checklist>` thành một khối: chờ xem checklist chạy ra sao trong một trận.
- Luật regex cho kích thước ảnh tối thiểu ("at least 1280x720") và điều kiện 0 điểm ("scores 0", "at most 20 MB"):
  `checklistProblems` đã kiểm được hai loại dòng này, chưa có luật viết chúng.
- Hai đề sửa cùng một dòng (CUZ7KL95 CR-07/PI-03): báo trùng theo đoạn code kèm diff của đề kia, và báo ngay khi đề
  kia lên main thay vì chờ tới publish. Chưa làm.
- Agent checker cho item dài và khó: đã duyệt, chưa xây; tốn thêm credit `gpt-6.1-sol`.
- `typecheckGate` cho đề sát hạn: cần chạy typecheck sớm hơn (ví dụ lúc `app start` đầu tiên), chưa thiết kế.
- `run_checks` bước test 500–570 s khi nhiều đề chạy cùng lúc (riêng một mình 172 s). `vitest related` đã đo và
  **không dùng**: file ở giữa đồ thị import kéo cả 99 file test (L147).
- Root spawn tuần tự: PI chờ 15–18 s khi root đang spawn thợ của đợt trước. Chưa có cách sửa không làm chậm đề khác.
- Test `prepare and play items in worktrees end to end` đỏ một lần khi chạy cả bộ (bước chờ prewarm 30 s), chạy riêng
  thì xanh: nghi do tải máy.
- Hạn mức gói plus: với model mặc định, trận 14 item tốn ~238 credit và từng hết hạn mức ở phút 40.

> **03/11:** bỏ gate, `team_reviewer`, `team_pi_hypothesis`, `team_verifier` và verified mode. Mục nào về gate, main gate,
> pre-gate, reviewer, solver hay checker giả thuyết không còn áp dụng; thay vào đó kiểm: mỗi item đúng một fixer (thêm
> một worker evidence khi tier strong), fixer chạy cả bộ test trước evidence, `publish_item` nộp ngay sau bàn giao, và
> `/judge-practice` có bao nhiêu item nộp sai mà trước đây reviewer/gate có thể bắt.
>
> **Sau J56ZZWSS (03/11):** bỏ worker evidence riêng của tier strong; `worker_checkpoint candidate` kiểm fix-result,
> submit.json và cấu hình test; root chỉ vòng `wait_agent` → `wait_for_update`; `prepare_item`/`publish_item` chờ job
> 25 s; `capture_evidence` chờ trang yên tới 12 s và bỏ qua favicon/ảnh. Kiểm ở trận sau:
> - [ ] Mỗi item đúng một `team_fixer`; không còn `spawn_evidence_worker`, `evidence_pending`.
> - [ ] Có lần `handedOff:false` nào không, worker sửa trong một lượt; không còn `RESULT_INVALID` ở `publish_item`;
>       worker không tự viết script kiểm schema (tìm `jsonschema`, `Test-Json`, `ajv` trong transcript fixer).
> - [ ] Không item nào đổi `vitest.config.*` hay file setup test (`git diff <seed> -- '*config*'` trên commit nộp).
> - [ ] Root: số lần `next_actions` và `job_status` (J56ZZWSS: 32 và 12 trên 105 lượt).
> - [ ] Số ảnh có `unsettled` và số lần chụp lại cùng kịch bản (J56ZZWSS: 9/27 ảnh unsettled).
> - [ ] UI fix cần bản dev dùng class logical có breakpoint (`md:ms-*`, `md:ps-*`, `md:start-*`): fixer dùng rule CSS
>       thường hoặc class vật lý ngay, không gỡ lỗi Tailwind. J56ZZWSS: build production có `.md:ms-sidebar`, bản dev
>       thì không (kể cả `@source inline`), worker mất ~10 phút rồi chuyển sang rule CSS thường.
>       Nguyên nhân (kiểm chứng 03/11, tái hiện ở cả checkout chính, không do worktree): Tailwind v4 sinh
>       `.md\:ms-x { @media (...) { margin-inline-start } }`; `next dev --turbo` đưa CSS qua Lightning CSS 1.32 với
>       browserslist mặc định của Next (Chrome 64, Safari 12), nó hạ thuộc tính logical thành `margin-left` + `:lang()`
>       và với `@media` lồng trong rule thì bỏ mất khai báo, còn lại `@media { }` rỗng. `md:ml-*` và rule thường
>       `@media (...) { .x { margin-inline-start } }` không bị. `next build` (webpack) không qua bước này.

## Trước trận

- [ ] Mở Player **0.9.39** ở `D:\mtm\MTM-PLAYER\0.9.39\mtm-player.exe`; không mở bản 0.9.35.
- [ ] Trang Init: model root `gpt-6-luna`; không bật Fast mode (transcript không ghi chế độ này, nên phải xem trên
      Player).
- [ ] Cài lại pack: `pwsh -NoProfile -File pack/install.ps1 -TeamWorkspace D:\mtm\BUN -Force`. Nếu helper đang chạy
      thì Stop/Resume trong Player, không thì nó vẫn chạy code cũ.
- [ ] `team-sdlc-pack/runtime/src/tools.mjs` có `itemEvidence`, `MAX_ITEMS_IN_FLIGHT = 4` và `gateTestChange` (bản sửa
      L43, L45, L47 đã được cài).

## 1. Worktree sync (L40; #7 không có lần sync nào)

- [ ] `worktree sync` khi fixer của item đó **đã dừng** và app còn chạy (log bị khoá): trả `synced: true`, không có
      `GIT_FAILED`. Tìm trong transcript root: `action:"sync"`.
- [ ] Sau sync, file chưa track của item (code mới, `answers/<ID>/`) vẫn còn; `git -C <wt> stash list` rỗng.
- [ ] Sửa `answers/<ID>/submit.json` trên main sau `integrate` rồi `commit_and_push`: không còn `WORKTREE_CONFLICT`.
- [ ] Nếu có `WORKTREE_CONFLICT` thật (xung đột code): worktree vẫn y như trước, patch còn trong `.team-work/scratch/`.

## 2. Test fail ở baseline (L46, L47, sửa sau ZVUYZ41V)

Mốc ZVUYZ41V: BUG-02 viết lại test fail sẵn, `baselineFixed` không có, gate main dừng publish 62 s.

- [ ] Chủ của test sửa nó bằng `test_change`: `integrate` trả `baselineFixed` cùng `syncWorktrees`, rồi root sync các
      worktree đó (mục 1).
- [ ] `start_work` của item bắt đầu sau đó trả `baselineFailures` với `failing: []` và `fixedBy`, không giao chủ mới.
- [ ] `exec` publish của chủ không dừng ở `mainGate` vì tests-guard.

## 3. Evidence mô tả đòi (L43, sửa sau ZVUYZ41V)

Mốc ZVUYZ41V: BUG-01 0/200 vì thiếu `dashboard_before_fixing.png`.

- [ ] `start_work` BUG-01 trả `requiredEvidence` có `dashboard_before_fixing.png` (`beforeFix`); fixer chụp ảnh đó
      trước khi sửa code.
- [ ] Thiếu file thì gate fail `evidence_missing`; lượt sau chỉ chụp bù (patch + `git apply -R`, không `stash`).
- [ ] Không có tên file lạ trong `requiredEvidence` (đường dẫn, file submit, file đề).

## 3b. Yêu cầu của cả đề và company facts (sửa sau TOKXKPBV)

Mốc HIET12OA: gate và reviewer mỗi bên 3 false green (criterion "pnpm test passes" ngoài MVS). TOKXKPBV: 0 false green
nhưng chuẩn CSV của CR-01 không lưu ở đâu nên không đối chiếu được.

- [ ] `start_work` mỗi item trả `requirements` và ghi `.team-work/items/<ID>/requirements.json`; không có câu khuôn
      mẫu (chép template, `gitRevision`, `testResults`) trong danh sách.
- [ ] Brief fixer và reviewer có `<requirements>`; mọi fix-result có `requirements` đủ id; mọi review có `requirements`.
- [ ] Không có fix-result nào ghi `met` mà không có bằng chứng; id `not_met` thì `submit.json` là `PARTIAL`.
- [ ] Root gọi `company_call` với `backlogItemKey`; `.team-work/items/<ID>/company/` có kết quả `kb_search` và test data,
      brief có đường dẫn `savedTo`. Fixer không phải nhắn root xin fixture (L54).
- [ ] `/judge-practice` đọc được chuẩn công ty từ `company/` khi chấm CR-01.
- [ ] Thời gian mỗi lượt fixer không tăng rõ so với TOKXKPBV vì phải khai bảng yêu cầu.
- [ ] TASK-01 (answer-only): `start_work` trả `independentAnswer {fields: ["position"]}`; root spawn `task01_solve1`
      cùng bước với fixer; solver không mở `answers/` hay `.team-work/results/` (xem transcript của nó); có
      `results/TASK-01-solver-1.json` với `answer_values`. Hai đáp án khớp thì publish không qua checker; lệch thì
      `ANSWER_DISPUTED` rồi một checker. Ghi credit và thời gian của solver.

## 3c. Sửa sau NO5X6J0K (L56–L59)

- [ ] Trang Init của Player: ô bật streaming được tích. Sau trận, dashboard Game Master không còn "Submitted without
      observed work" (L57). Còn thì hỏi BTC.
- [ ] BUG-01-TC-01 (cần bản dev): fixer gọi `app start {mode: "dev"}`, có `tc-01-desktop-dashboard.png` chụp trên bản dev, TC-01
      `PASS`; app dev sẵn sàng trong bao lâu (L56).
- [ ] CSV evidence của CR-01 trong commit đã đẩy giữ CRLF: `git show <sha>:<folder>/answers/CR-01/evidence/tc-03-special-company.csv | od -c`
      có `\r\n` cuối dòng và `\n` trong tên công ty (L58).
- [ ] TASK-01: reviewer không cho `high` chỉ vì thiếu commit `571c531`; tối đa 2 lượt fixer (L59).

## 4. Thang model (L44, sửa sau ZVUYZ41V)

Mốc ZVUYZ41V: 30,29 credit; fixer 25,41, trong đó 17,8 là lượt 6.1-sol thứ 2–3. TASK-02 luna 15,6 phút rồi sol 3,8
phút; BUG-02 luna 7,1 phút rồi sol 2 phút; CR-01 luna 14 phút.

- [ ] Item tier `strong` (BUG-02, CR-01, TASK-02) chạy `gpt-6.1-sol` high ngay lượt 1; item `small` lượt 1, reviewer
      và verifier chạy `gpt-6.1-terra` (medium; reviewer high); lượt 2 trở đi `gpt-6.1-sol` high; không lượt nào `gpt-6-sol`. Tìm trong transcript root: `"spawn_agent"` rồi xem `model`, `reasoning_effort`.
- [ ] Thời gian mỗi item và tổng credit so với ZVUYZ41V: sol từ lượt 1 có rút ngắn thời gian mà không đẩy credit vượt
      quá mức đã tiết kiệm không.
- [ ] Lần cuối của item có deadline hoặc PI dùng `gpt-6-astra`: ghi số lần và credit (một lượt ≈ 158 credit). #7 không
      gọi lần nào.
- [ ] So điểm với HIET12OA và ZVUYZ41V (cùng bộ item). Cần bảng điểm BTC của cả hai trận; practice-log chưa ghi.
- [ ] Đối chiếu tổng credit (usage.md) với dashboard Codex của tài khoản (cập nhật 7:00 UTC hằng ngày) sau một ngày.

## 5. Item mới và giới hạn thread (L45, L48)

Mốc ZVUYZ41V: TASK-01 ra lúc 02:49:49, root thấy lúc 03:02; `spawn_agent` thứ tư bị từ chối khi đã có 3 subagent chạy.

- [ ] Kết quả tool của root có `notice {newItems, freeSlots}` khi item mới ra; root `start_work` item đó trong vòng
      1 phút.
- [ ] `TeamWorkspace/.codex/config.toml` có `[agents] max_concurrent_threads_per_session = 16`; Player khởi động
      root bình thường và checker không báo lỗi với khoá này.
- [ ] Số subagent chạy cùng lúc lớn nhất (mong đợi trên 3), và có `agent thread limit reached` không. Nếu có: root
      chờ rồi spawn lại, không bỏ reviewer hay verifier.

## 6. Nếu trận có PI (chưa thấy ở trận nào)

- [ ] `job_status`/`run_gate` trả sớm với `newPI`; root `start_work` PI trong vòng 1 phút từ lúc đề hiện.
- [ ] Lần thử của fixer PI có `timeBox.checkpointBy` (phút 6) và dừng trước 12 phút; fix-result có `hypotheses`.
- [ ] Gate trả `not_reproduced` khi không có test mới fail trên code chưa sửa, `reproduced` khi có.
- [ ] Reviewer PI chạy song song với gate; PI kẹt thì có 2–3 `team_pi_hypothesis` song song.
- [ ] `start_work` của PI có `remote.newCommits` khi BTC đã đẩy commit lên remote.

## 7. Còn treo từ #7

- [ ] Chạy `/judge-practice` cho ZVUYZ41V (bundle đã có ở `runs/judge/ZVUYZ41V/`, chưa có `judge.json`): reviewer
      `gpt-6-luna` có false green nào ngoài L43 không.
- [ ] Evidence: không còn `screenshot path must be absolute`; fixer không mở profile mới chưa đăng nhập rồi bị đẩy về
      `/login`; không chụp khi app chưa chạy (`chrome-error`). Đếm lại số lần gọi mỗi kịch bản (≤ 3).
- [ ] `[role=option]` của Radix Select (L26) chạy được: BUG-02 TC-03 (USD) xong ngay lượt 1.
- [ ] Jev `difficulty`: #6 và #7 đều 0/5 lần đủ ngưỡng 0,7 (độ tin 0,27–0,48). Nếu #8 cũng vậy thì hạ ngưỡng hoặc bỏ
      câu hỏi này khỏi Jev.
- [ ] Item `easy` mà Jev cho bỏ reviewer (#7 không có item `easy`): kết quả chấm có lỗi mà reviewer đáng lẽ bắt được
      không.
- [ ] `start_work` chậm (#7: 3,2–12,2 s, Jev 0,2–3,8 s): tách thời gian `git grep`, Jev và Game Master.

## 8. Player 0.9.39 (chỉ xem được trên Player)

- [ ] Dashboard có cột **Mode** và dòng "Detected mode: Standard" (không có Fast, nếu không credit tính gấp 2).
- [ ] Credit trên dashboard có số cho root chạy `gpt-6-luna` (không còn "N/A").
- [ ] Nếu Player báo `INSTALLED_RUNTIME_TAMPERED`: ghi lại file nằm sau `File:` rồi cài lại pack bằng installer, không
      sửa tay file đã cài.
