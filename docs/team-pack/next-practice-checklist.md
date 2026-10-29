# Cần kiểm ở trận luyện sau (#7)

Những thay đổi đã qua test offline (`node --test "tests/pack/*.test.mjs"`, 71/71) nhưng chưa chạy trên trận thật.
Sau trận, chạy `/judge-practice <match checkout>` (gồm cả `tools/judge/usage.mjs`), rồi đối chiếu từng mục dưới đây với
transcript (`~/.codex/sessions/<ngày>/`, root là file `source: "vscode"`, subagent có `agent_path`) và
`<checkout>/.team-work/journal.json`. Ghi kết quả vào `practice-log.md` mục #7; mục nào đạt thì xoá khỏi file này.

## Trước trận

- [ ] Cài lại pack: `pwsh -NoProfile -File pack/install.ps1 -TeamWorkspace D:\mtm\BUN -Force`. Nếu helper đang chạy
      thì Stop/Resume trong Player, không thì nó vẫn chạy code cũ.
- [ ] `team-sdlc-pack/runtime/src/tools.mjs` có `liveWorktree` và `proxyCall`, có `runtime/src/proxy.mjs` (bản mới đã
      được cài).
- [ ] `TeamWorkspace/.codex/agents/team-verifier.toml` tồn tại (profile thứ tư), và checker của Player không báo lỗi.

## 1. Worktree trên Windows (L40, L41)

Mốc so sánh từ HIET12OA: hai lần root tự gỡ lỗi khoá file, 30 lượt, 3,6M token, khoảng 6 phút.

- [ ] `worktree sync` khi fixer của item đó **đã dừng** và app còn chạy (log bị khoá): trả `synced: true`, không có
      `GIT_FAILED`. Tìm trong transcript root: `action:"sync"`.
- [ ] Sau sync, file chưa track của item (code mới, `answers/<ID>/`) vẫn còn; `git -C <wt> stash list` rỗng.
- [ ] Không có lỗi `Filename too long` (`core.longpaths` được bật lúc `create`).
- [ ] `worktree remove` khi `.codegraph/codegraph.db` còn bị giữ: trả `removed: true` cộng `leftover`, root không
      kill tiến trình nào, `git worktree list` không còn item đó.
- [ ] Sửa `answers/<ID>/submit.json` trên main sau `integrate` rồi `commit_and_push`: không còn `WORKTREE_CONFLICT`.
- [ ] Nếu có `WORKTREE_CONFLICT` thật (xung đột code): worktree vẫn y như trước, patch còn trong `.team-work/scratch/`.

## 2. Root chờ và không gỡ tay (L42)

- [ ] Mọi `wait_agent` của root đều có `timeout_ms` 180000 (hoặc ngắn hơn nhưng có lý do: `return_by` hay
      `releases.next.at`). Mốc HIET12OA: 11 lần hết giờ 60 s, khoảng 2M token.
- [ ] Root không viết câu nào giữa hai lần chờ liên tiếp.
- [ ] Root không đọc `team-sdlc-pack/runtime/src/*`, không chạy `git` tay trong worktree hay checkout chính, không
      `Stop-Process`/`taskkill` ngoài app do chính item chạy. Tìm trong transcript root: `runtime\\src`, `Stop-Process`,
      `git -C`.
- [ ] Fixer không bị bảo "pause" để chờ sync; không fixer nào poll `wait_agent`/`sleep` (mốc HIET12OA: CR-01, 0,5M).
- [ ] Fixer ghi log app vào `.team-work/logs/<ID>-app.log`, không có `app.log` ở gốc worktree.
- [ ] Token của root, so với HIET12OA (13,0M, 134 lượt).

## 3. Test fail ở baseline (sửa sau HIET12OA, commit d843b25)

Mốc HIET12OA: test `deleting a company with invoices is RESTRICTED` fail sẵn, CR-01, TASK-02 và BUG-02 mất tổng 80 điểm.

- [ ] `start_work` trả `baselineFailures` với đúng một `youFix: true`; brief của fixer có `<baseline_failures>`.
- [ ] Chủ của test sửa nó với `test_change {reason, source}`, và gate (`tests-guard`) cho qua nhờ `allowTestChange`.
- [ ] Sau khi chủ integrate: `integrate` trả `baselineFixed` cùng `syncWorktrees`, rồi root sync các worktree đó
      (nằm trong mục 1).
- [ ] Các item còn lại báo `DONE`, không `PARTIAL` chỉ vì test này.

## 4. Còn treo từ các trận trước

- [ ] `capture_evidence` với `browserProfile` giữ đăng nhập qua các lần gọi (L28). Ở HIET12OA, `bug01_fix1` vẫn bị
      đẩy về `/login` ("redirected to /login") và trả `partial` vì thiếu evidence: xem lần gọi đó có bỏ bước login mà
      dùng profile chưa từng đăng nhập không, hay cookie vẫn mất.

- [ ] Fixer đọc `backlog-references/evidence-playbook.md` trước kịch bản cần ảnh (tìm trong transcript fixer:
      `evidence-playbook`). Đếm số lần gọi `capture_evidence` mỗi kịch bản (mục tiêu ≤ 3) và thời gian evidence so với
      cả lượt fixer (mục tiêu ≤ 1/3). Mốc BC3JL6ZC: BUG-02 6 lần gọi không lần nào xong, 30/150.
- [ ] Root không chép mẹo evidence vào brief nữa (brief ngắn hơn); fixer vẫn dùng đúng `[role=option]`, `force: true`,
      `pnpm exec next start`, log app ở `.team-work/logs/`.

## 5. Nếu trận có PI (chưa thấy ở trận nào)

- [ ] `job_status`/`run_gate` trả sớm với `newPI`; root `start_work` PI trong vòng 1 phút từ lúc đề hiện.
- [ ] Lần thử của fixer PI có `timeBox.checkpointBy` (phút 6) và dừng trước 12 phút; fix-result có `hypotheses`.
- [ ] Gate trả `not_reproduced` khi không có test mới fail trên code chưa sửa, `reproduced` khi có.
- [ ] Reviewer PI chạy song song với gate; PI kẹt thì có 2–3 `team_pi_hypothesis` song song.
- [ ] `start_work` của PI có `remote.newCommits` khi BTC đã đẩy commit lên remote.

## 6. Verifier chạy gate thay root (proxy, 05 §5.22)

Thay cho "mục 4" cũ (helper tự chạy gate khi thấy file kết quả). Mốc HIET12OA: root ngồi chờ gate tới 3 phút trong khi
fixer khác đã xong; 13,0M token, 134 lượt.

- [ ] `configure_session` của root trả `proxy: {ready: true}`; có `team-sdlc-pack/local/runtime-endpoint.json`.
      `ready: false` thì ghi lại `error` (named pipe bị chặn trong môi trường Player?).
- [ ] Player nhận profile thứ tư `team_verifier`: checker không báo lỗi, root spawn được với `agent_type` đó.
- [ ] Transcript verifier (`agent_path` `/root/<id>_verify<n>`): `run_gate` với `fixResultFile` trả `jobId`, không
      phải `NOT_CONFIGURED`; vòng `job_status` nằm trong một `exec` có pragma.
- [ ] Root không còn gọi `run_gate` trên worktree (chỉ `where: main` trong exec publish, hoặc sau `orchestrator_gate`).
      Tìm trong transcript root: `"run_gate"`.
- [ ] Verifier và reviewer được spawn trong cùng một lượt root; trong lúc chúng chạy root xử lý item khác.
- [ ] Publish là một `exec` (`record_verification` → `integrate` → `commit_and_push` → `submit_work` → `remove`);
      nếu có `stoppedAt` thì root làm tiếp từ đúng bước đó, không lặp bước đã xong.
- [ ] `answer_invalid` có `codePassed`: verifier sửa `submit.json`, `answer_fixed: true`, không chạy gate lại.
- [ ] Số thread cùng lúc lớn nhất (fixer + verifier + reviewer + pi-hypothesis) và có lỗi giới hạn `max_threads` không.
- [ ] Token: root so với 13,0M / 134 lượt; verifier mỗi lượt (mong đợi nhỏ, model `small`).
