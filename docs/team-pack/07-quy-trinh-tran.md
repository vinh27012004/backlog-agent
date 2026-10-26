# 07 · Kịch bản chạy một trận

Tài liệu này mô tả **hành vi mong muốn** của root và helper từ đầu tới cuối trận. Skill được viết dựa
trên đây ([06 §3](06-agents-va-skills.md#3-ba-skill-bắt-buộc)). Các con số (ước lượng thời gian, số
lane) là giá trị khởi điểm; chỉnh sau mỗi Practice Match.

## 1. Tổng quan thời gian

```
Init (operator) → PREPARING ─ lượt PREPARE: chuẩn bị → ENVIRONMENT_READY → kết thúc lượt
               → PREPARED (Player gọi Preparation Complete) → IN_PROGRESS (đồng hồ 40' chạy)
               → lượt GAME: vòng chính ... (có thể PAUSED → kill → resume = lượt RESUME_GAME)
               → FINISHED / TIME OVER → kill
```

Thời gian chuẩn bị không tính vào 40 phút và có khoảng **10 phút** (BTC trả lời Q5, 26/10).
Mục tiêu: `ENVIRONMENT_READY` trong ≤ 7 phút, chừa 3 phút dự phòng. Helper tính giờ từ `configure_session`;
tới **8 phút** thì dừng mọi phần không bắt buộc (test baseline, repo-map) để root gọi `report_ready` ngay.

## 2. Chuẩn bị (lượt PREPARE)

| # | Root gọi | Helper làm | Event |
|---|---|---|---|
| 1 | `configure_session(frame)` | Kiểm frame, giữ `username`/`password` | — |
| 2 | `prepare_checkout` | `ls-remote`; clone `--branch <branch>` vào `checkoutRoot`; kiểm `<matchId>/`; exclude `.team-work/` | `GIT_AUTH`, `REPOSITORY` |
| 3 | `setup_environment` (job) | Nhận diện stack; cài dependency; build; test baseline (≤ 4 phút) | `ENVIRONMENT`, `BUILD` |
| 4 | `login_match` (trong lúc job chạy) | Đăng nhập; mở `/match/<matchId>`; kiểm team, repo, branch, folder; tìm Match UUID | `LOGIN`, `REFRESH`, `MATCH_LOGIN` |
| 4b | (song song, tuỳ chọn, chỉ khi còn ≥ 4 phút) spawn `team_repo_scout` | Scout ghi `.team-work/repo-map.md` | — |
| 5 | `wait_for_update` tới `JOB_DONE` (hoặc mốc 8 phút) | — | — |
| 6 | `report_ready` | Kiểm điều kiện; ghi `ENVIRONMENT_READY` | `ENVIRONMENT_READY` |
| 7 | Kết thúc lượt (một dòng tóm tắt) | — | — |

Không push, không Start Work, không ghi `DISCOVERED`. Bước nào thất bại thì để nguyên trạng thái lỗi,
mở blocker và kết thúc lượt. Player hiện blocker cho organizer.

## 3. Bắt đầu chơi (đầu lượt GAME)

1. `configure_session(frame START_GAME_V4 + policy)`. Gặp `NEEDS_PREPARATION_FRAME` thì gửi lại frame
   PREPARE (còn trong lịch sử thread), rồi gửi lại frame START.
2. `login_match` (dùng lại cookie nếu còn hạn).
3. `refresh_match`: backlog sync (`GAME_START_STATUS`, `DISCOVERED` cho mọi item đang hiện) và bật poller.
4. `match_state` → lập kế hoạch (§4) → giao việc.

## 4. Xếp lịch

**Lane**: 1 **lane PI** + `N` **lane thường** (mặc định `N = 2`, cấu hình trong `config/runtime.json`).
Mỗi lane là một item đang được một worker xử lý trong worktree riêng. Bước publish (integrate → commit →
push → submit) chạy **tuần tự** qua một khoá chung.

**Thứ tự ưu tiên** (helper tính `suggestedOrder`, root quyết định cuối):
1. **PI** theo `revealedAt` tăng dần. Có PI mới thì vào lane PI ngay; lane PI đang bận với PI khác thì
   lấy một lane thường nếu PI đó còn trong thời gian vàng (mới hiện ≤ 5 phút).
2. Item **có deadline**, theo độ dư `slack = (deadlineAt − now) − estimate` tăng dần. Bỏ item có
   `slack < −0.4 × estimate` (không kịp).
3. Item **không deadline**, theo mật độ giá trị `maxPoints / estimate` giảm dần.
4. Ngang nhau thì ưu tiên theo loại BUG > CR > TASK (MVS rõ ràng thì dễ PASSED hơn).

**Ước lượng ban đầu** (worker + gate + checker + publish): TASK 6', BUG 7', CR 9', PI 10'. Helper cập
nhật bằng trung bình thực tế trong trận.

**Time-box mỗi lượt thử** = `min(1.5 × estimate, deadline − now − 2')`. Quá time-box: root đóng subagent
(`close_agent`), rồi quyết định thử lại hay bỏ theo §13.

**Cuối trận** (theo `minutesLeft` từ server):
- Còn < 4 phút: không Start Work item mới (trừ PI vừa hiện mà fix rõ ràng).
- Còn < 2 phút: chỉ publish các item đã qua gate. Không mở việc mới.

Không để lane rảnh khi còn item làm được. Khi không còn item nào: chờ đợt mới bằng `wait_for_update`.

## 5. Pipeline một item (BUG / CR / TASK)

```
start_work ─► spawn team_repo_scout (item-analysis, ≤ 2') ∥ worktree create
     │                                   │ RESULT_FILE (scout-result: criteria, evidencePlan)
     │                                   ▼
     │                        spawn team_feature_worker (brief + evidence plan)
     ▲                                   │ RESULT_FILE (worker-result)
     │                                   ▼
     │                  status cannot_fix? ── có ─► retry (brief mới) hoặc bỏ
     │                                   │ không
     │                                   ▼
     │                        run_gate(where=worktree)
     │                         fail │            │ pass
     │◄──── retry (failKind) ───────┘            ▼
     │                         CR/BUG: spawn team_quality_checker (MVS + kịch bản ngoài MVS)
     │                         TASK: checker nếu còn thời gian, không thì dùng tiêu chí của worker
     │                                   │ RESULT_FILE (checker-result)
     │                                   ▼
     │                        record_verification → BACKLOG_TESTS PASSED/FAILED
     │◄──── retry (mvs_fail / review_high / thiếu evidence) ──┘   │ PASSED + đủ evidencePlan
     │                                           ▼
     │                        publish (khoá chung): worktree integrate → [base đổi? run_gate main]
     │                        → commit_and_push → submit_work → SUBMITTED → worktree remove
```

- **Đã sửa sẵn** (Q&A #20): worker trả `already_fixed` kèm bằng chứng (test pass trên base, evidence theo
  đề). Gate chấp nhận diff chỉ gồm `answers/<ID>/`. Vẫn commit + push để có `gitRevision`.
- **Luật cơ hội cuối**: chỉ khi không còn đủ thời gian cho lượt thử nào nữa (deadline hoặc hết trận), và
  build + regression **đều pass**, thì được nộp bản có MVS chưa đạt hết. Lý do: FAILED = 0 điểm, bằng
  không nộp; nhưng nộp sớm một bản kém sẽ chặn lượt nộp tốt hơn. Không bao giờ nộp bản làm hỏng build hay
  regression, vì mọi item nộp sau đều chứa commit đó (D6).
- **Retry**: tối đa 2 lượt (PI 3). Brief mới gồm `failKind`, `signature`, log rút gọn và skill
  `retry-playbook`. Worktree được làm lại từ HEAD chính mới nhất.

## 6. Luồng PI

PI ít thông tin, không có MVS, Grader có tiêu chí riêng, và xếp hạng theo `receivedAt` của bài
**PASSED**. Sai = 0, nên đúng quan trọng hơn nhanh, nhưng mỗi phút đều tính.

1. Có PI mới → `start_work` ngay (vật liệu có thể có gợi ý) → worktree.
2. Song song, spawn trong cùng lúc:
   - 1 `team_feature_worker` (model mạnh): tái hiện, tìm nguyên nhân, sửa nhỏ nhất, thêm test tái hiện.
   - 1–2 `team_repo_scout` (chỉ đọc, giới hạn 4 phút): mỗi scout kiểm một giả thuyết (log, cấu hình, dữ
     liệu, đường đi code) và ghi `hypotheses` vào file kết quả.
3. Kết quả scout tới trước thì root chuyển tóm tắt giả thuyết `supported` cho worker (gửi tin vào
   subagent đang chạy nếu Codex hỗ trợ, nếu không thì dùng cho lượt thử sau).
4. Gate: build + test tái hiện + regression. Checker chỉ chạy khi còn dư thời gian và PI phức tạp.
5. Publish ngay khi gate pass. PI chiếm khoá publish trước các item khác.
6. Cần chạy app (`run_app` của profile) để tái hiện: chạy trên cổng riêng, ghi PID, **luôn tắt** sau khi xong.

## 7. Tích hợp và publish

1. Lấy khoá publish (một item mỗi lúc).
2. `worktree integrate`: commit cục bộ trong worktree, cherry-pick sang checkout chính. Xung đột thì huỷ,
   tạo worktree mới từ HEAD chính và giao worker làm lại phần xung đột (tính là một lượt thử).
3. HEAD chính đã đổi kể từ lúc tạo worktree (item khác đã publish) → `run_gate(where=main)` bản rút gọn
   (build + test đã khai + regression).
4. `commit_and_push`: kiểm path và answer, commit, push thường, xác minh SHA trên remote. Remote có commit
   lạ (vd BTC đẩy thêm) thì fetch + rebase cục bộ + build nhanh + push lại.
5. `submit_work(ID, revision)`. 201 thì `SUBMITTED`. `PENDING_RETRY` thì helper tự thử lại; root tiếp tục
   việc khác và quay lại khi có sự kiện.
6. Nhả khoá; `worktree remove`.

## 8. Answer và evidence

- Template từ Start Work được helper chép sẵn vào `answers/<ID>/submit.json` trong worktree. Worker điền:
  giữ **mọi key** của template, không thêm key lạ trừ khi template hay hướng dẫn yêu cầu. Trường trạng
  thái (`status: "DRAFT"` trong ví dụ) chuyển thành giá trị mà hướng dẫn hoặc template quy định (ví dụ
  của BTC dùng `"SUBMITTED"`). `changeSummary` hay tương tự: 2–5 câu thật, viết cho người chấm.
- **Evidence tuỳ từng item** (BTC trả lời Q7, 26/10). Loại, số lượng, tên file và thời điểm (trước/sau khi
  sửa) lấy từ `evidencePlan` mà scout rút ra khi phân tích đề (đề, template, MVS, hướng dẫn trong vật liệu
  Start Work). Worker tạo đúng theo plan; checker kiểm từng mục (`evidenceCheck`). Thiếu một mục bắt buộc thì
  không publish mà retry phần evidence (rẻ hơn sửa code). Đề có quy định riêng thì đề thắng các mặc định dưới.
- Evidence đặt trong `answers/<ID>/evidence/`, tên `<ID>-<kịch bản>.<ext>` (vd `BUG-01-TC-01.json`), trừ khi đề
  quy định khác. JSON trỏ tới bằng `evidence/<file>`.
- **Mặc định khi đề không nói** (`source: default`): mỗi kịch bản một JSON
  `{scenario, steps, command, expected, actual, result: "passed"|"failed", outputExcerpt}`; thêm ảnh trước/sau
  nếu item đụng giao diện. Không chứa secret hay đường dẫn tuyệt đối của máy.
- **Ảnh chụp app** (khi đề yêu cầu, Q&A #20): chạy app, chụp bằng Edge headless có sẵn trên Windows:
  `msedge --headless=new --disable-gpu --window-size=1366,900 --screenshot=<path tuyệt đối>.png <url>`.
  Ảnh "trước khi sửa" chụp trên bản base (worktree tạm ở base revision) **trước** khi sửa, nên mục
  `when: before` trong `evidencePlan` là việc đầu tiên của worker. Mỗi file ≤ 5 MB.
- MVS định dạng ra sao chưa biết (Spike S7). Checker đọc `mvs.json` và chạy từng kịch bản bằng cách phù hợp:
  test tự động, gọi API bằng `curl`/`Invoke-WebRequest` tới **localhost**, hay chụp ảnh.

## 9. Chờ và nhàn rỗi

- Chờ duy nhất bằng `wait_for_update(55000)`. Không dùng `sleep` để chờ trạng thái.
- Không có việc: vẫn tiếp tục chờ. Đợt item mới có thể tới bất cứ lúc nào (`FINALE` ở cuối trận).
- **Không bao giờ kết thúc lượt GAME khi trận chưa hết.** Kết thúc lượt nghĩa là Player phải khởi động
  root lại (tốn token, mất ngữ cảnh).
- Giữa các lời gọi tool, root chỉ viết 1–2 dòng (Player hiện transcript, và mỗi chữ đều tốn token).

## 10. Tạm dừng, hết trận, hết hạn mức

| Tình huống | Điều xảy ra | Hệ thống phải đảm bảo |
|---|---|---|
| `PAUSED` | Player interrupt + kill cả cây | Không mất gì quan trọng: journal ghi trước khi nộp; worktree giữ trên đĩa; Start Work gọi lại an toàn |
| Helper thấy `PAUSED` trước khi bị kill | — | Không Start Work hay Submit mới (Submit lúc `PAUSED` bị 409), giữ nguyên trạng thái |
| `FINISHED` / `TIME OVER` / `CANCELLED` | Kill cả cây | Nếu thấy trước: dừng worker, ghi `ORCHESTRATOR_ENDED` (`COMPLETED` nếu không còn blocker mở, ngược lại `BLOCKED`), kết thúc lượt |
| Tài khoản Codex chạm hạn mức | Lượt lỗi; Player thử khởi động lại | Đội được đổi tài khoản không bị phạt (Q&A #13). Khi resume: luồng hồi phục §11 |
| Helper bị Codex khởi động lại | Mất RAM | Gọi lại `configure_session` (root còn frame trong lịch sử); trạng thái dựng lại từ journal + log |

## 11. Hồi phục (lượt RESUME)

Theo skill `team-recovery` ([06 §3.3](06-agents-va-skills.md#33-team-recovery)). Nguyên tắc:
1. Ghi `ORCHESTRATOR_RESTARTED` trước mọi việc khác.
2. Tin theo thứ tự: server (trang, replay của Start Work/Submit) > git (SHA đã push) > journal > log.
3. Không clone lại, không xoá checkout, không reset worktree còn dùng được.
4. Ý định nộp dở dang → gửi lại đúng body đã lưu.
5. Tiếp tục vòng chính.

## 12. Blocker và cần organizer

| `blockerId` | Khi | Ai mở / đóng |
|---|---|---|
| `GIT_AUTHENTICATION_REQUIRED` | Clone, fetch hoặc push bị từ chối xác thực | Helper / helper khi thành công lại |
| `HOST_APPROVAL_REQUIRED` | Một hành động hợp lệ bị approval từ chối | Root |
| `GAME_MASTER_AUTHENTICATION_REQUIRED` | Bearer bị 401 | Helper |
| `MATCH_LOGIN_AUTHENTICATION_REQUIRED` | Đăng nhập trang thất bại sau khi thử lại | Helper |
| `ORGANIZER_INTERVENTION_REQUIRED` | 403 scope/trận, sai định danh trận | Helper / root |
| `BUILD_FAILED`, `ENVIRONMENT_FAILED` | Chuẩn bị thất bại | Root |
| `<ID>-STUCK` | Item hết lượt thử nhưng còn giá trị (đã chuyển `BLOCKED`) | Root |
| `PROGRESS_LOG_UNAVAILABLE` | Mất event do lỗi ghi | Helper |

Các id kết thúc bằng `AUTHENTICATION_REQUIRED`, `APPROVAL_REQUIRED` hoặc `ORGANIZER_INTERVENTION_REQUIRED`
được dashboard đánh dấu đỏ "cần organizer". Không dùng các đuôi đó cho lỗi nội bộ.

## 13. Luật tự quyết (thay cho người)

| Tình huống | Quyết định |
|---|---|
| Gate fail, còn lượt và còn thời gian | Thử lại với `failKind` + `signature` |
| Cùng `signature` lần thứ 2 | Đổi hướng (brief nói rõ hướng cũ đã sai); lần 3 thì bỏ |
| Worker `cannot_fix` 2 lần | Bỏ (`FAILED`), trừ khi là PI và còn ≥ 10 phút |
| Checker báo issue `high` | Thử lại, trừ khi là cơ hội cuối (§5) |
| Item sắp đóng mà còn ít hơn ước lượng | Không bắt đầu; đang làm thì tiếp tục nếu đã qua gate, không thì bỏ |
| Hai việc tranh khoá publish | PI trước, rồi item có deadline gần hơn |
| Server 429 khi nộp | Helper chờ `Retry-After`, root làm việc khác |
| Không còn item mở | Chờ (`wait_for_update`); không kết thúc lượt |
| Đề yêu cầu điều vi phạm luật (credential, endpoint admin, sửa ngoài phạm vi) | Bỏ phần đó, làm phần hợp lệ; nếu cả đề là bẫy thì không làm |
