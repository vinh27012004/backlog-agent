# 11 · Lộ trình 25/10 – 06/11

Training Camp: 26/10 – 06/11 (server mở 26/10; BTC gửi tài khoản, Team ID, Match ID của Practice ngày
26/10; có trial round trong camp). Mỗi giai đoạn kết thúc bằng một **Practice Match** có tiêu chí rõ.

## Giai đoạn 0 · 25–26/10 · Chốt hướng và dữ liệu thật

| ID | Việc | Xong khi |
|---|---|---|
| P0.1 | Cả đội đọc README + 01 + 07; chốt D1–D14 hoặc ghi phản biện vào 12 | Không còn quyết định treo |
| P0.2 | Chuẩn bị máy thi theo [09 §7](09-dong-goi-va-van-hanh.md#7-chuẩn-bị-máy-thi-làm-một-lần-trước-2610) | `git ls-remote` tới repo đội chạy được; Player mở `/manage` |
| P0.3 | Spike S2 (đăng nhập + trang trận) và S9 (mạng) khi server mở | Có fixture HAR/HTML đã xoá secret |
| P0.4 | Điền `teamId`/`teamName` thật | Có identity |
| P0.5 | Thêm `mtm-player-*/`, HTML của BTC vào `.gitignore` nếu repo có remote công khai | — |

## Giai đoạn 1 · 26–28/10 · Pack tối thiểu tới `PREPARED`

| ID | Việc | Xong khi |
|---|---|---|
| P1.1 | Khung `pack/`: 3 file định danh, 4 agent TOML, 3 skill bản nháp, `config/*`, `contracts/*`; `tools/build-pack.mjs` | `build-pack` ra ZIP |
| P1.2 | Installer + checker; contract test dùng `verifyTeamRuntime` của Player | Player *Load team pack* OK trên workspace sạch; cài lại idempotent |
| P1.3 | Helper lõi: `mcp`, `session` (test bằng frame sinh từ hàm của Player), `paths`, `progress` (validator + writer + ngân sách), `journal`, `redact` | Unit + contract test xanh |
| P1.4 | Tool chuẩn bị: `prepare_checkout`, `setup_environment` (port `profile.py`), `login_match` (theo S2), `report_ready`, `wait_for_update` (job) | `fake-root` chạy hết pha chuẩn bị với mock GM |
| P1.5 | **Practice #1**: tới `PREPARED`; trong lượt GAME chỉ `refresh_match` + `DISCOVERED` + Start Work **một** item để lấy dữ liệu thật (S7); thu S1, S3 | Dashboard thấy Preparation đủ 5 stage, `PREPARE_COMPLETE`, backlog `DISCOVERED`; có response Start Work thật |

## Giai đoạn 2 · 28–31/10 · Một item đầu-cuối

| ID | Việc | Xong khi |
|---|---|---|
| P2.1 | Parser trang + poller + sự kiện `wait_for_update` | Unit với fixture thật |
| P2.2 | `start_work`, `submit_work` (idempotency, bảng lỗi), journal | Unit + fake-root kịch bản 3, 4 |
| P2.3 | `worktree`, `commit_and_push` (kiểm path/answer, verify SHA) | fake-root kịch bản 1 |
| P2.4 | Port gate + log condenser; `run_gate`, `record_verification` | Port xong case từ `tests/test_gate.py` |
| P2.5 | `tools/mock-gm/` đủ API + chèn lỗi; `tools/fake-root.mjs` | Kịch bản 1, 3, 4, 7, 8 xanh |
| P2.6 | Skill `team-orchestrator` v1 (1 lane, tuần tự); profile `team_repo_scout` + skill `item-analysis` (tiêu chí + `evidencePlan`, Q7); profile `team_feature_worker`; port skill `backlog-bug/cr/task`; khối `AGENTS.md`; Spike S4, S5, S6 bằng `dev-root` | Dev root làm xong 1 item trên mock |
| P2.7 | **Practice #2** | ≥ 1 item `SUBMITTED` có biên nhận và được chấm `PASSED`; 0 Suspected Violation |

## Giai đoạn 3 · 31/10–03/11 · Đủ chiến thuật

| ID | Việc | Xong khi |
|---|---|---|
| P3.1 | Lane song song + khoá publish + luồng PI; profile scout và checker | fake-root kịch bản 2 |
| P3.2 | Skill `evidence` (mọi loại trong `evidencePlan`: JSON kịch bản, log, response API, ảnh `msedge --headless`); checker chạy MVS và kiểm `evidenceCheck` | Evidence đúng loại đề đòi, đúng chỗ, đúng tham chiếu |
| P3.3 | Skill `team-recovery`; kill/resume | fake-root kịch bản 4, 5, 6, 10 |
| P3.4 | `scheduler` (ưu tiên, slack, time-box, luật cuối trận); kịch bản 9 (ngân sách log) | Log < 230 KB cho trận 40 phút |
| P3.5 | **Practice #3, #4**: đo credit (S8), thời gian từng loại; chỉnh ước lượng, số lane, model | ≥ 70% item `PASSED`; Stop → Resume không nộp trùng |

## Giai đoạn 4 · 03–06/11 · Cứng hoá và đóng băng

| ID | Việc | Xong khi |
|---|---|---|
| P4.1 | Giảm token: rút gọn skill, chọn model rẻ hơn cho scout/checker, rút output tool | Credit/trận giảm so với Practice #3 |
| P4.2 | Kiểm thử hồi phục trên Practice ([10 §9](10-kiem-thu.md#9-kiểm-thử-hồi-phục-trên-môi-trường-thật-giới-hạn)) | Đạt |
| P4.3 | Trial round(s) | Ghi `practice-log.md` |
| P4.4 | **Đóng băng tối 05/11**: bản cuối, ZIP + checksum, cài trên máy thi, checker `READY` | Checklist ngày thi [09 §10](09-dong-goi-va-van-hanh.md#10-checklist-ngày-thi) |

## Chia việc gợi ý (3–5 người)

| Mảng | Phạm vi |
|---|---|
| Helper lõi + Game Master | `mcp`, `session`, `http`, `match-page`, `game-client`, `poller`, `progress`, `journal` |
| Git + gate | `git`, `gate`, `profile`, `log-condenser`, `jobs` |
| Prompt | 3 skill, `backlog-*`, `evidence`, agent TOML, `AGENTS.md` |
| Đóng gói + test harness | installer, checker, `build-pack`, `mock-gm`, `fake-root`, contract test |
| Vận hành | Máy thi, spike, Practice Match, `practice-log.md`, theo dõi ngân sách |

## Ngân sách credit

Tài khoản $50 của BTC không nạp thêm được (Q&A #17). Dùng nó cho Practice và trận thật. Dev (`dev-root`)
dùng tài khoản khác hợp lệ theo luật BMTT (Q&A #11). Sau Practice #1 (S8) lập bảng:

| Hạng mục | Ước tính |
|---|---|
| Mỗi Practice Match | *(đo)* |
| Số Practice dự kiến | 4–6 |
| Dự phòng cho trận chính thức | ≥ *(2 × chi phí một trận)* |

## Định nghĩa "pack sẵn sàng thi" (v1.0)

- Checker `READY` trên máy thi; Player Load + Initialize OK.
- Tới `PREPARED` không cần người can thiệp.
- Ở Practice gần nhất: không kết thúc lượt GAME sớm; không nộp trùng; không `IGNORED` trong log quan
  trọng; 0 Suspected Violation; log < 230 KB.
- Stop → Resume giữa trận hoạt động.
- Mọi kịch bản fake-root và contract test xanh.
