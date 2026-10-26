# 12 · Rủi ro, giả định và câu hỏi gửi BTC

## 1. Rủi ro

Mức: **C** = nghiêm trọng (mất trận), **H** = cao, **M** = vừa, **L** = thấp.

| ID | Rủi ro | Khả năng | Tác động | Giảm thiểu |
|---|---|---|---|---|
| R1 | Codex không nạp MCP helper (workspace chưa trust, `node` không có trên PATH, path sai) | M | **C** | D13; checker chặn; Spike S1 ở Practice #1; checklist ngày thi |
| R2 | Không đăng nhập hoặc không parse được trang `/match` (định dạng lạ, đổi giữa các bản) | M | **C** | Spike S2 ngày 26/10; parser dựa trên fixture thật; lỗi parse thì báo blocker rõ ràng thay vì đoán |
| R3 | Root kết thúc lượt GAME sớm → Player khởi động lại liên tục | M | H | Skill nhấn mạnh; `wait_for_update` luôn có việc để gọi; recovery nhanh và rẻ |
| R4 | Context của root phình suốt 40 phút, bị nén và mất trạng thái | M | H | Trạng thái nằm ở helper (`match_state`), journal; root trả lời ngắn; không đọc code |
| R5 | Cơ chế subagent khác dự kiến (S4: không spawn được profile, không chọn được model, giới hạn luồng) | M | H | Phương án lùi: brief chứa đủ hướng dẫn và dùng agent mặc định; giảm còn 1 lane |
| R6 | Tool MCP bị đòi approval và `auto_review` từ chối (S3) | M | H | Annotation `readOnlyHint`; cấu hình MCP; bị chặn thì blocker `HOST_APPROVAL_REQUIRED` |
| R7 | Log vượt 256 KB, dashboard Player ngừng đọc | M | M | Ngân sách byte, poll giãn dần, summary ngắn ([04 §7](04-progress-log.md#7-ngân-sách-byte-và-nhịp-polling)) |
| R8 | Tài khoản Codex chạm hạn mức giữa trận | M | H | Đổi tài khoản không bị phạt (Q&A #13); recovery từ journal; theo dõi credit theo S8 |
| R9 | Git hỏi mật khẩu hoặc treo khi push | L | H | GCM đăng nhập sẵn; `GIT_TERMINAL_PROMPT=0`; Spike S9; blocker `GIT_AUTHENTICATION_REQUIRED` |
| R10 | Commit tích hợp làm hỏng build/regression, kéo hỏng mọi item nộp sau | M | **C** | Gate trên checkout chính sau tích hợp; cấm commit khi regression fail (D6, D11) |
| R11 | Worktree song song chậm (vd `npm ci` mỗi worktree) | M | M | Cache trong `.team-work/cache`; số lane cấu hình được; stack nặng thì 1 lane |
| R12 | Định dạng template, MVS, evidence khác dự kiến | H | M | Spike S7; skill linh hoạt; giữ đủ key template |
| R13 | Player ra bản mới đổi hợp đồng | M | H | Contract test với source Player; checklist [02 §12](02-hop-dong-player.md#12-khi-player-ra-bản-mới) |
| R14 | Lộ credential qua transcript, log, brief | L | **C** | Chép frame một lần; redact mọi output; không đưa vào brief; event không chứa secret |
| R15 | Prompt injection trong đề | M | M | Rào nội dung; scout gắn cờ; AGENTS.md; 4 điều cấm thắng mọi yêu cầu |
| R16 | Chi phí token vượt ngân sách $50 | M | H | Root mỏng; đo sau mỗi Practice; model rẻ cho scout/checker |
| R17 | Mạng công ty chặn hoặc cần proxy | L | M | Spike S9; `NODE_USE_ENV_PROXY=1` |
| R18 | Chuẩn bị quá ~10 phút (Q5): repo nặng, cài dependency hay test baseline chậm | M | H | Mục tiêu ≤ 7 phút; login song song với setup; baseline ≤ 4 phút, quá thì để GAME chạy tiếp; mốc cứng 8 phút; repo-map tuỳ chọn |
| R19 | Đọc sai thời gian hoặc deadline | L | M | Ưu tiên số trên trang; skew từ header `Date`; ngưỡng an toàn 2 phút |
| R20 | Guide hoặc sample còn "bẫy" chưa phát hiện | M | M | Thứ tự tin cậy nguồn (README); kiểm mọi giả định ở Practice |

## 2. Giả định đang dùng

| ID | Giả định | Kiểm bằng |
|---|---|---|
| A1 | Máy thi là máy của đội, cài được toolchain, Node, Git, Edge | Q&A #15, Kick-off |
| A2 | Practice Match giống trận chính thức về giao thức | Practice |
| A3 | Lượt PREPARE và GAME dùng cùng thread và cùng tiến trình helper | Spike S1 |
| A4 | Subagent native có thể chạy song song và nhận brief tuỳ ý | Spike S4 |
| A5 | Cài dependency từ registry công khai được phép | Q3: **đã xác nhận** cho setup (26/10); giữa trận còn chờ hỏi lại |
| A6 | Grader chấm mỗi `gitRevision` độc lập (clone đúng SHA) | Tài liệu API ("Grader clone đúng giá trị này"), Q6 |
| A7 | Không cần đọc kết quả chấm trong trận để ra quyết định | Q12 |

## 3. Câu hỏi gửi BTC

Gửi qua kênh Q&A. Ghi câu trả lời và ngày bên dưới từng câu, rồi cập nhật tài liệu liên quan.

1. **Q1 · Agent profiles.** Ngoài `team_orchestrator`, Player có yêu cầu đăng ký profile nào khác không?
   Guide nói 4 profile (`team_repo_scout`, `team_feature_worker`, `team_quality_checker`), sample pack
   có 5 tên khác, còn Player 0.9.33 chỉ kiểm `team-orchestrator.toml`.
2. **Q2 · Nạp MCP helper.** Cách chính thức để Codex nạp MCP server của đội có phải là
   `TeamWorkspace/.codex/config.toml` không? Codex chỉ đọc file này khi thư mục đã được trust. Máy thi có
   được trust sẵn không, hay đội tự trust?
3. **Q3 · Mạng và cache.** Trong lúc chuẩn bị và trong trận, có được truy cập registry package (npm, Maven
   Central, PyPI, NuGet…) không? Build tool ghi cache ngoài TeamWorkspace (`~/.m2`, npm cache) có bị coi là
   vi phạm không?
4. **Q4 · Tần suất đọc trang.** Có giới hạn tần suất đọc `/match/<matchId>` không? Player giới hạn progress
   log 256 KB, nên ghi `GAME_MASTER_API` cho mọi refresh 5 giây sẽ vượt mức. Giãn nhịp refresh (15–60 giây)
   có được chấp nhận không?
5. **Q5 · Thời gian chuẩn bị.** Pha PREPARING có giới hạn thời gian không?
6. **Q6 · Git.** Mỗi item nên nộp theo cách nào?
   (a) Mỗi item một branch riêng tách từ base (vd `item/BUG-01`), push branch đó và nộp SHA của nó, để các item
   độc lập với nhau; hay
   (b) bắt buộc push lên **branch được giao**, nên item nộp sau nằm trên commit chứa cả thay đổi của item nộp
   trước (vd BUG-01 nộp SHA `A`, TASK-02 nộp SHA `B` là con của `A`)?
   Nếu là (b): Grader chấm mỗi item độc lập tại đúng SHA đã nộp phải không?
   *Bối cảnh:* guide bước 12 ghi "push to the assigned branch" và Player 0.9.33 chỉ cấp quyền
   `PUSH_ASSIGNED_BRANCH` (`team-runtime.mjs:157`), nên đội đang làm theo (b) (D6). Đội nghiêng về (a) nếu được
   phép, vì một item hỏng sẽ không kéo các item sau hỏng theo (R10).
7. **Q7 · Evidence và MVS.** Evidence nên ở định dạng nào (ảnh chụp, JSON, log)? MVS có định dạng chuẩn
   không?
8. **Q8 · Tạm dừng và kết thúc.** Ở chế độ app-server, `MATCH_PAUSED_V1`/`MATCH_ENDED_V1` có được gửi tới
   agent không, hay Player chỉ dừng cây tiến trình?
9. **Q9 · Final result schema.** `agent-result.schema.json` còn được Player dùng không? Nếu có, ở đâu?
10. **Q10 · Đề bị sửa.** Item có thể bị sửa nội dung sau khi hiện không? Nếu có, nhận biết bằng cách nào?
11. **Q11 · Web search.** Agent có được dùng web search của Codex trong trận không?
12. **Q12 · Kết quả chấm.** Trong trận, trang `/match` có hiện kết quả `PASSED`/`FAILED` của đội không?

### Câu trả lời

- **Q3 (26/10):** Khi nhận source, đội được dùng **mọi hình thức** để setup repo (tải dependency từ
  registry, cache của build tool…). Giả định A5 đã được xác nhận cho pha chuẩn bị. Còn mở: đổi hoặc cài
  dependency **giữa trận** (vd item "Resolve production dependency vulnerabilities") có được coi là setup
  không; đội tạm hiểu là được và hỏi lại BTC cho chắc. Đã cập nhật [08 §4–5](08-guardrails.md#5-mạng).
- **Q5 (26/10):** Pha chuẩn bị có khoảng **10 phút**. Mục tiêu `ENVIRONMENT_READY` ≤ 7 phút, chừa 3 phút dự
  phòng: `login_match` chạy song song với job `setup_environment`, test baseline giới hạn 4 phút, helper có mốc
  cứng 8 phút để bỏ phần không bắt buộc. Đã cập nhật [05 §5.3](05-mcp-helper.md#53-setup_environment-job),
  [06 §3.1](06-agents-va-skills.md#31-game-preparation), [07 §1–2](07-quy-trinh-tran.md#1-tổng-quan-thời-gian).
  Chưa rõ quá 10 phút thì chuyện gì xảy ra (bị huỷ hay chỉ trễ); ghi lại khi Practice.
- **Q7 (26/10):** Evidence **tuỳ từng backlog item**, không có một định dạng chung. Vì vậy mỗi item TASK/CR/BUG
  có bước phân tích đề bắt buộc (`team_repo_scout` + skill `item-analysis`) trả về `evidencePlan`; worker làm
  theo, checker kiểm đủ. Định dạng MVS vẫn chờ dữ liệu thật (Spike S7). Đã cập nhật
  [06](06-agents-va-skills.md) và [07 §5, §8](07-quy-trinh-tran.md#8-answer-và-evidence).
- **Q8 (26/10, từ source Player 0.9.33, ưu tiên thấp):** Không gửi. Khi dừng, `local-app.mjs:267` gọi
  `cliSupervisor.stop()`; với app-server (`codex-app-server.mjs:230`) chỉ có `turn/interrupt` rồi kill cây tiến
  trình. Hàm dựng `MATCH_PAUSED_V1`/`MATCH_ENDED_V1` có trong `session-control.mjs:63` nhưng không được gửi tới
  agent. Thiết kế giữ nguyên (T4, D12). Chỉ cần hỏi BTC nếu muốn chắc các bản Player sau không đổi.
- **Q9 (26/10, từ source Player 0.9.33, ưu tiên thấp):** Không dùng. `app/src` không tham chiếu
  `agent-result.schema.json`; file chỉ có trong sample pack (`contracts/`). Root không cần trả kết quả theo
  schema này; trạng thái cuối nằm ở `ORCHESTRATOR_ENDED` trong progress log.
- **Q10 (26/10):** **Không bao giờ** có chuyện đề bị sửa sau khi hiện. Đã bỏ sự kiện `ITEM_CHANGED`, luật
  "làm lại với đề mới" và case chèn lỗi tương ứng ([03](03-game-master.md), [05 §5.15](05-mcp-helper.md),
  [06 §3.2](06-agents-va-skills.md), [07 §13](07-quy-trinh-tran.md), [10 §4](10-kiem-thu.md)). Nội dung item
  đọc một lần rồi lưu trong `.team-work/items/<ID>/`, không cần so lại.
- **Q11 (26/10):** Được. Agent được dùng web search của Codex trong trận. Đã cập nhật
  [08 §5](08-guardrails.md#5-mạng) và [09 §3](09-dong-goi-va-van-hanh.md#3-configcodextoml-và-file-đăng-ký).

> *(các câu khác: điền khi có)*

### Còn chờ BTC (cập nhật 26/10)

| Câu | Mức | Ảnh hưởng nếu trả lời khác giả định hiện tại |
|---|---|---|
| Q1 · Agent profiles | Thấp | Thêm/đổi tên file trong `.codex/agents/` |
| Q2 · Nạp MCP helper, trust | **Cao** | Helper không chạy thì cả pack không chạy (R1); Spike S1 cũng trả lời được |
| Q4 · Tần suất đọc trang | Vừa | Nhịp poll và ngân sách log (R7) |
| Q6 · Git: branch riêng hay branch được giao | **Cao** | Đổi D6, `commit_and_push`, khoá publish |
| Q12 · Kết quả chấm trong trận | Thấp | Có thể bỏ qua; Practice sẽ thấy (spectator có cột `Graded`) |
| Q13 · Gọi Jev | Vừa | Tắt `jev.enabled` nếu không được (R21) |
| Q14 · Dependency giữa trận | Vừa | Cách worker xử lý item kiểu "Resolve production dependency vulnerabilities" |

14. **Q14 · Dependency giữa trận** (tiếp Q3). Trong lúc làm item (giữa trận, không phải lúc setup), agent có
    được cài hoặc nâng dependency từ registry công khai không, ví dụ để vá lỗ hổng bảo mật theo yêu cầu của đề?

### Bổ sung (D9: giữ Jev)

13. **Q13 · Dịch vụ AI ngoài.** MCP helper của đội có được gọi API của một dịch vụ AI bên ngoài (TypeSafe Jev:
    model ra quyết định có kiểu, không sinh văn bản, chỉ gửi tiêu đề/mô tả item đã cắt, không gửi code) trong
    trận không? Các lời gọi này có cần khai báo trước origin, hay đã được tính là công cụ bên thứ ba như
    Q&A #9? Nếu không được thì đội tắt bằng cờ cấu hình.

Rủi ro tương ứng: **R21** (H/M): BTC coi gọi Jev là vi phạm → tắt `jev.enabled`, hệ thống chạy bằng luật code.
**R22** (L/H): `TYPESAFE_API_KEY` lọt vào shell của model hoặc transcript → loại trừ biến khỏi
`shell_environment_policy`, `redact.mjs`, Spike S11.
