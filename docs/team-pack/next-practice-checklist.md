# Cần kiểm ở trận luyện sau (#8)

Những thay đổi đã qua test offline (`node --test "tests/pack/*.test.mjs"`) nhưng chưa chạy trên trận thật, cộng các mục
trận #7 (`ZVUYZ41V`) chưa kiểm được. Sau trận, chạy `/judge-practice <match checkout>` (gồm cả `tools/judge/usage.mjs`),
rồi đối chiếu từng mục dưới đây với transcript (`~/.codex/sessions/<ngày>/`, root là file `source: "vscode"`, subagent
có `agent_path`) và `<checkout>/.team-work/journal.json`. Ghi kết quả vào `practice-log.md` mục #8; mục nào đạt thì xoá
khỏi file này. Kết quả đối chiếu của #7: `practice-log.md`, mục #7, "Đối chiếu checklist".

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

## 4. Thang model (L44, sửa sau ZVUYZ41V)

Mốc ZVUYZ41V: 30,29 credit; fixer 25,41, trong đó 17,8 là lượt 6.1-sol thứ 2–3. TASK-02 luna 15,6 phút rồi sol 3,8
phút; BUG-02 luna 7,1 phút rồi sol 2 phút; CR-01 luna 14 phút.

- [ ] Item tier `strong` (BUG-02, CR-01, TASK-02) chạy `gpt-6.1-sol` ngay lượt 1; item `small` chạy `gpt-6-luna`
      medium. Tìm trong transcript root: `"spawn_agent"` rồi xem `model`, `reasoning_effort`.
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
- [ ] `TeamWorkspace/.codex/config.toml` có `[agents] max_concurrent_threads_per_session = 8`; Player khởi động
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
