# Kiến trúc Digital Development Team — Master the Machine 2026

> Phiên bản: **v0.4** · Runtime: **Codex CLI / Codex SDK** · Ngân sách: **$50** (dev + practice + thi)
> v0.4: thêm Codex Plugin của BTC, Orchestrator Agent, kết nối Game Master, lịch Training Camp.
> v0.5: **JEV = Jev của TypeSafe AI** (model ra quyết định có kiểu) cho các quyết định nhanh; không còn agent phân tích riêng: **fixer tự phân tích** ở bước đầu (tiết kiệm 1 lần gọi Codex mỗi item, quan trọng với PI).
> Bản vẽ: `docs/diagrams.html` (01 Architecture, 02 Infrastructure)

---

## 1. Bối cảnh trận đấu

Tổng hợp từ buổi phổ biến của BTC.

**Diễn biến một trận**

1. Game Master đẩy source vào repo của đội. Hệ thống tự pull code, cài dependency, rồi **báo sẵn sàng**. Từ đây con người không can thiệp.
2. **Codex Plugin** của BTC xác thực đội với Game Master, rồi spawn **Orchestrator Agent** của đội. Agent vào trang match để lấy backlog.
3. Backlog đầu tiên hiện ra, có 40 phút làm. Item mới tiếp tục xuất hiện bất kỳ lúc nào, không báo trước. Agent tự sắp ưu tiên, tự làm và tự nộp.
4. Hết giờ, trận chuyển sang KẾT THÚC.

**BTC cung cấp gì**

| Thứ | Nội dung |
|---|---|
| **Codex Plugin** | Tool tích hợp sâu vào Codex SDK. (1) Xác thực đội và đăng ký với Game Master Server. (2) Xác thực xong thì **spawn Orchestrator Agent** của đội. (3) Theo dõi output của Orchestrator Agent và chi phí token của đội. |
| **Game Master Server** | URL endpoint, API key, team id. |
| **Repo** | GitHub. Game Master đẩy source vào repo của đội. |
| **AI** | Lúc thi: bắt buộc **Codex**, được **dùng kết hợp** với AI khác (đội dùng thêm **Jev** của TypeSafe). Lúc dựng hệ thống: AI nào cũng được (Claude, Copilot…) nếu có license hợp pháp. |

**Lịch**

- **Training Camp 26/10 – 6/11** (2 tuần): phát triển agent, test kết nối với Game Master Server, đấu thử giữa các đội (trial rounds).
- Chi tiết API kết nối và cách lấy task tự động: BTC công bố trong Training Camp. Trước đó đội dựng với **Game Master giả** cùng interface.

**Loại item** (mã dạng `{TYPE}-{số}`)

| Loại | Ý nghĩa | MVS | Evidence | Ưu tiên |
|---|---|---|---|---|
| TASK | Việc được giao thông thường | Không | Không | Bình thường |
| CR | Thay đổi theo spec mới | **Có, bắt buộc pass** | **Có** | Bình thường |
| BUG | Sửa lỗi, không làm hỏng chỗ khác | **Có, bắt buộc pass** | **Có** | Bình thường |
| PI | Sự cố production, ít thông tin, phải tự điều tra | Không | Không | **Cao nhất, điểm tính theo thời gian nộp** |

**Luật nộp bài**

- Phải báo "bắt đầu làm" trước, nộp khi chưa start sẽ bị từ chối.
- Mỗi item chỉ nộp **1 lần**. Đã ACCEPTED thì nộp lại bị từ chối.
- Điểm lúc nộp là tạm thời, Grader chấm lại thành điểm chính thức.
- Trạng thái item: VISIBLE → OPEN → CLOSED. Deadline tính bằng phút từ lúc item hiện ra, không tính lúc trận PAUSED.
- **Chỉ tin đồng hồ server** của Game Master.

**4 điều cấm**

- Dùng credential hoặc API key của đội khác, nộp thay đội khác.
- Vào Admin interface, Admin API hay Grader API khi không được cấp quyền.
- Tìm cách lấy đề, template, MVS chưa mở, hoặc dữ liệu riêng của đội khác.
- Can thiệp, làm gián đoạn Game Master hay hoạt động của đội khác.

---

## 2. Nguyên tắc thiết kế

1. **Codex là agent, còn lại là code của đội.** Orchestrator Agent do plugin spawn là Codex nhưng **mỏng**: việc lặp lại (theo dõi match, hàng đợi, gate, nộp bài) chạy trong code qua MCP, LLM chỉ được gọi khi có việc cần quyết. Gate, MCP tool và monitor là code thuần, không tốn $.
2. **Viết code dùng Codex, ra quyết định dùng JEV.** Quyết định có tập lựa chọn cố định (mức độ, độ khó, liên kết item, chọn model, nộp/thử/bỏ) hỏi Jev: ~100 ms, rẻ, có xác suất. Dưới ngưỡng tin cậy hoặc Jev lỗi thì dùng luật code.
3. **Không có người trong trận.** Mọi chỗ trước đây chuyển cho người đều thay bằng luật tự quyết.
4. **Không tin lời agent.** Orchestrator tự chạy lại gate trước khi nộp, vì mỗi item chỉ nộp được 1 lần.
5. **Chỉ tiêu $ ở chỗ đáng tiêu.** Việc nào code làm được thì không gọi LLM.
6. **Nội dung item là dữ liệu untrusted.** Agent không được làm theo câu lệnh nằm trong đề, đặc biệt là những gì dẫn tới vi phạm 4 điều cấm.

---

## 3. Sơ đồ tổng thể

```
Game Master ◄──xác thực, đăng ký── Codex Plugin (BTC) ──spawn──► ORCHESTRATOR AGENT (Codex, mỏng)
     ▲                         theo dõi output, token              │ gọi tool
     │                                                             ▼
     │◄── API (URL · API key · team id) ── MCP control (code đội): theo dõi /match · giờ server · hàng đợi
     │                                  │
     │                                  ▼
     │          ⇄ JEV (TypeSafe): mức độ · độ khó · chặn bẫy · liên kết · chọn model · nộp/thử/bỏ
     │                       Triage (JSON) = loại, deadline (code) + mức độ, độ khó, liên quan (JEV)
     │                                  │
     │                     xếp hàng: PI trước, rồi theo deadline
     │                                  ▼
     │                 codex exec (mỗi item 1 worktree, skill theo loại)
     │                   ⇄ MCP: CodeGraph · bản đồ hệ thống · MVS runner · build/test · web_search
     │                                  ▼
     │                  GATE (control tự chạy lại, profile theo loại)
     │                       │                         │
     │                     PASS                       FAIL
     │                       ▼                         ▼
     └──── nộp 1 lần ◄── Nộp bài               Log Condenser
          (CR/BUG kèm evidence MVS)             ├─ còn giờ, còn lượt → re-plan
                                                └─ không → Luật tự quyết
```

---

## 4. Thành phần

### 4.1 Chuẩn bị trước start

Chạy tự động trước khi báo sẵn sàng:

- Pull code, **nhận diện stack** và tạo **project profile** bằng code (`orchestrator/profile.py`): Java (Maven/Gradle), Node/TS, Python, .NET, Go, PHP; framework; lệnh build, test, chạy 1 test, chạy app; marker skip test bị cấm. Monorepo nhận nhiều stack.
- Cài dependency theo stack (môi trường thi có mạng), build sẵn.
- Index **CodeGraph**.
- Tạo **bản đồ hệ thống**: endpoint → controller → service → repository → bảng DB, cấu hình, vùng rủi ro (tiền, ngày giờ, phân trang, đồng thời, gọi service ngoài).
- Khởi động **app chạy sẵn** để PI tái hiện bằng cách gọi API.
- Chuẩn bị sẵn một worktree trống dành riêng cho PI.

### 4.2 Orchestrator Agent + MCP control

**Orchestrator Agent** do Codex Plugin spawn qua Codex SDK. Codex SDK chỉ bọc Codex CLI: mỗi "agent" là một thread `codex exec`, plugin đọc luồng sự kiện JSONL (kể cả số token) để theo dõi đội. Đội không đổi được cơ chế spawn, nhưng quyết định được agent đó **làm gì** (hướng dẫn) và **có tool gì** (MCP).

Thiết kế: agent mỏng, logic nằm trong **MCP server `control`** (code đội, chạy ngoài sandbox):

| Tool `control` | Việc |
|---|---|
| `wait_event(timeout)` | Chặn tới khi có việc cần quyết: item mới, gate xong, sắp hết deadline. Hết giờ chờ (vd. 5 phút) thì trả về trạng thái. **LLM không tự poll**, nên lúc chờ không tốn token. |
| `status()` | Bảng tóm tắt: item, trạng thái, deadline theo giờ server, số lần thử. |
| `act(action, item)` | `start` · `submit` · `retry` · `drop`. Code kiểm luật trước khi làm (vd. không nộp khi gate chưa pass, không nộp lần 2). |

- **Mặc định chạy tự động**: luật tự quyết (mục 4.6) nằm trong code và tự thực hiện. Agent nhận sự kiện, ghi tiến độ ra output để plugin theo dõi được, và chỉ quyết khi code trả về "cần quyết" (vd. 2 item cùng sắp hết hạn).
- **Vì sao không để agent tự làm hết**: poll bằng LLM đốt token suốt trận; sandbox của thread do plugin đặt có thể tắt mạng; luật nộp 1 lần cần kiểm bằng code, không tin LLM.

**Bên trong `control`** (code thuần):

- Theo dõi trang `/match/<id>` liên tục, phát hiện item mới.
- Báo "bắt đầu làm" trước khi giao việc.
- Hàng đợi: **PI trước**, sau đó theo deadline còn lại, giá trị và độ khó (lấy từ triage).
- Gọi worker `codex exec` cho từng việc (fixer, reviewer, PI hypothesis), mỗi item một git worktree, mỗi lần một phiên mới.
- Tự chạy lại gate, quyết định nộp hay re-plan hay bỏ.
- Nộp bài, đính kèm evidence MVS cho CR và BUG.
- Ghi trạng thái, thời gian và trace của từng lần chạy agent vào SQLite (không đếm token, không tính tiền — plugin BTC làm việc đó).

**Chờ Training Camp xác nhận** (có phương án dự phòng):

| Câu hỏi | Nếu "không" |
|---|---|
| Plugin có nạp cấu hình Codex của đội (MCP server, `CODEX_HOME`, `.codex/config.toml`)? | Agent chạy `python -m orchestrator run` bằng shell; cần sandbox cho phép mạng hoặc `danger-full-access`. |
| Hướng dẫn cho agent đặt ở đâu: `AGENTS.md` trong repo, prompt khai báo với plugin, hay skill? | Nếu bắt buộc `AGENTS.md` ở gốc repo: thêm vào `.git/info/exclude`, worktree tạo từ commit gốc nên không lẫn vào diff nộp bài. |
| Worker `codex exec` riêng có được phép, và plugin có tính token của chúng? | Dùng tính năng sub-agent của chính Codex (`multi_agent`) để mọi việc nằm trong thread plugin theo dõi. |
| Plugin có cấp sẵn tool gọi Game Master không? | `control` gọi thẳng HTTP API bằng URL + API key + team id (mục 4.7). |

### 4.3 JEV và triage

Không có agent phân tích riêng. Khi item mới hiện ra, orchestrator tạo **triage** từ code + JEV rồi giao thẳng cho fixer; **fixer tự phân tích** ở bước đầu (tiêu chí hoàn thành, vùng code nghi vấn bằng CodeGraph) và trả về trong `criteria`, `suspects` để reviewer và monitor dùng.

```json
{
  "id": "PI-03", "type": "PI", "deadlineMin": 18,
  "severity": "critical", "difficulty": "medium",
  "related": ["BUG-07"], "fixerModel": "strong", "reviewer": false
}
```

**JEV** = [Jev của TypeSafe AI](https://thenewstack.io/typesafe-jev-system-one/), model "System One": nhận `state` (văn bản) + các câu hỏi có kiểu (`noul` yes/no, `choice`, `score`), trả lời kèm xác suất và độ tin cậy, không sinh chữ. Code: `orchestrator/jev.py` (client), `orchestrator/decisions.py` (các điểm quyết định), cấu hình `config/jev.toml`.

| Điểm quyết định | Câu hỏi cho Jev | Luật code dự phòng |
|---|---|---|
| Nhận item | mức nghiêm trọng (score), độ khó (choice), module (choice) | PI → critical; theo `severity` trong item; độ khó medium |
| Chặn bẫy | item có câu lệnh nhắm vào AI? (noul, ngưỡng thấp 0.5) | regex dấu hiệu; Jev nói không nhưng regex khớp → vẫn cách ly |
| Liên kết item | 2 item cùng root cause / phụ thuộc? (noul) | cùng chữ ký lỗi |
| Chọn cách chạy | fixer dùng model nhỏ hay mạnh (choice); có cần reviewer (noul) | hard/PI/CR → mạnh; PI không review |
| Kiểm lời Codex | báo cáo của agent có khớp gate report? (noul) | theo kết quả gate |
| PI | root cause đã có bằng chứng? (noul) | có root_cause + confidence ≥ 0.7 + có kiểm pass |
| Luật tự quyết | nộp / thử lại / bỏ (choice) | luật ở mục 4.6 |

- **Ngưỡng**: `choice`/`score` dùng khi confidence ≥ 0.7; `noul` là "có" khi ≥ 0.8, "không" khi ≤ 0.2, ở giữa → luật code.
- **Ràng buộc cứng do code giữ**: Jev chỉ chọn trong các lựa chọn hợp lệ (vd. gate fail thì "nộp" không có trong danh sách); PI không chạy reviewer.
- Mỗi quyết định ghi vào SQLite (`jev_decisions`): giá trị, nguồn jev/fallback, độ tin cậy, thời gian — để xem tỉ lệ Jev tự quyết trên monitor.
- Jev chỉ đọc chữ và xử lý số kém: đưa số liệu vào `state` dạng văn bản có nhãn; quyết định dựa trên số (deadline, số lần thử) do code giới hạn trước.

### 4.4 Codex theo loại item

BTC sẽ đưa **nhiều loại source code**, nên kiến thức chia 2 lớp: **skill theo loại item** (quy trình, không phụ thuộc stack) và **gói kiến thức theo stack** (layout, cách test, lỗi hay gặp). Code ghép vào prompt đúng thứ cần: luật chung + vai trò + skill + tài liệu tham khảo theo việc + gói stack theo profile + project profile (chi tiết ở `agents/README.md`). Không ghi `AGENTS.md` hay `.agents/` vào repo BTC để khỏi lẫn vào diff nộp bài.

| Skill | Cách làm |
|---|---|
| TASK | Tự liệt kê tiêu chí từ đề → viết test cho từng tiêu chí → implement |
| CR | Theo spec mới → implement → pass MVS |
| BUG | Viết failing test tái hiện lỗi → fix → test pass → pass MVS |
| PI | Điều tra theo checklist → tái hiện → fix theo root cause (xem mục 6) |

- **Tài liệu tham khảo** (`agents/references/`): `bug-patterns` cho fixer BUG, `pi-triage` cho PI, `retry-playbook` khi re-plan.
- **Gói stack** (`agents/stacks/`): java, node, python, dotnet, go, php, unknown (khi không nhận diện được: agent tự đọc README/CI để tìm lệnh).
- **Model nhỏ** cho đọc đề, tóm tắt. **Model mạnh** cho plan và fix. Chỉnh `reasoning effort` theo bước.
- **Sandbox Codex** ở chế độ `workspace-write`, **tắt mạng** (máy có mạng, nhưng lệnh Codex tự chạy thì không). Lý do: item là dữ liệu untrusted có thể chứa bẫy, Codex có thể vô tình gọi Admin/Grader API, và tra web lan man tốn giờ, tốn $. Cần tra tài liệu thì dùng tool `web_search` ở mục 4.5.
- **PI bị kẹt** mới bật 2–3 Codex read-only kiểm giả thuyết song song.

### 4.5 MCP tool (code thuần)

- **CodeGraph** và **bản đồ hệ thống**: tra chuỗi gọi hàm, vùng impact.
- **MVS runner**: chạy kịch bản của BTC, xuất log làm evidence.
- **Build, test, app chạy sẵn**: build, gọi API để tái hiện. CR cần thêm thư viện thì Codex chỉ sửa `pom.xml`, orchestrator tải dependency ngoài sandbox.
- **web_search** (tool của đội, chạy ngoài sandbox):
  - Tra và đọc mọi trang web, không giới hạn tên miền.
  - Chỉ chặn tên miền Game Master và đường dẫn chứa `admin`, `grader` (luật thi).
  - Giới hạn số lần gọi mỗi item và cắt ngắn nội dung trả về.
  - Ghi log mọi lần gọi vào SQLite để xem trên monitor.
  - Mặc định bật cho cả 4 loại item; nếu đo ở practice thấy tốn $ thì chỉ bật cho PI bị kẹt.
- **Log Condenser**: rút gọn log, tạo chữ ký lỗi, phân loại kiểu fail.

Giới hạn output của từng tool để không đổ log dài vào context.

### 4.6 Luật tự quyết (thay cho người)

- Hết giờ hoặc hết số lần re-plan cho item → bỏ item (MVS đã pass thì nộp bản tốt nhất).
- MVS đã pass nhưng còn check phụ fail → nộp bản tốt nhất.
- Cùng chữ ký lỗi lặp 2 lần → bắt buộc đổi giả thuyết. Lặp tiếp → bỏ item.
- Khi có nhiều lựa chọn hợp lệ (nộp / thử lại / bỏ), hỏi JEV; dưới ngưỡng tin cậy thì theo luật trên.
- Nhiều item cùng sắp hết hạn → ưu tiên PI, rồi item gần xong nhất.

### 4.7 Kết nối Game Master

BTC cấp **URL endpoint, API key, team id**. Plugin dùng chúng để xác thực và đăng ký đội; `control` dùng để theo dõi match và nộp bài (trừ khi plugin cấp sẵn tool).

- **Bí mật**: để trong biến môi trường `GM_URL`, `GM_API_KEY`, `GM_TEAM_ID` (file `.env` không commit). Chỉ `control` đọc. Worker Codex không thấy (đã loại biến `*KEY*`, `*TOKEN*` khỏi môi trường lệnh shell), không đưa vào prompt hay log.
- **`GameMasterClient`**: một interface, nhiều bản cài đặt.

  | Hàm | Việc |
  |---|---|
  | `server_time()` | Giờ server, dùng cho mọi deadline |
  | `get_match()` | Trạng thái trận, danh sách item (VISIBLE / OPEN / CLOSED), deadline |
  | `get_item(id)` | Nội dung item |
  | `start_item(id)` | Báo "bắt đầu làm" |
  | `submit(id, payload, evidence)` | Nộp 1 lần |

  Bản cài đặt: `HttpGameMaster` (API thật, viết khi có tài liệu ở Training Camp) · `PluginGameMaster` (nếu plugin cấp tool) · **`FakeGameMaster`** (dựng ngay: ra item theo kịch bản, đồng hồ riêng, có PAUSED, từ chối nộp lần 2 hoặc nộp khi chưa start).
- **Nộp an toàn**: ghi "đang nộp" vào SQLite **trước** khi gọi API. Lỗi mạng thì hỏi lại trạng thái item rồi mới quyết, không gọi `submit` lần 2 một cách mù quáng.
- **Gọi lại khi lỗi**: thử lại có giãn cách cho các lệnh đọc; không tự thử lại `submit`.
- **GitHub**: repo của đội trên GitHub, Game Master đẩy source vào. Cần token hoặc deploy key để pull (và push nếu nộp bài qua git). Token chỉ dùng ở bước chuẩn bị và trong `control`.

---

## 5. Gate theo loại item

| Check | BUG | CR | TASK | PI |
|---|---|---|---|---|
| Build | ✔ | ✔ | ✔ | ✔ |
| MVS của BTC | ✔ bắt buộc | ✔ bắt buộc | — | — |
| Test tự viết | Failing test trước | Theo spec | Theo tiêu chí (nội bộ) | Test tái hiện |
| Regression vùng impact | ✔ | ✔ | ✔ | Test liên quan trực tiếp |
| Lint, scan | ✔ | ✔ | ✔ | — |
| Kích thước diff | ✔ | ✔ | ✔ | ✔ |
| Reviewer (codex read-only) | ✔ | ✔ | ✔ | — |
| Evidence khi nộp | ✔ | ✔ | — | — |

Khi sắp hết deadline, profile tự rút gọn: bỏ reviewer trước, rồi lint và scan. **Không bao giờ bỏ build, MVS và test quan trọng.**

---

## 6. Luồng PI

PI phải điều tra kỹ nhưng vẫn nhanh. Tốc độ đến từ chuẩn bị trước và chạy song song, không đến từ việc bỏ bước.

1. **Triệu chứng**: người dùng thấy gì, ở đâu, khi nào.
2. **Điểm vào**: tra bản đồ hệ thống ra endpoint và chuỗi code.
3. **Bằng chứng**: log, stack trace, cấu hình, commit gần đây chạm vùng đó.
4. **Giả thuyết**: 2–4 nguyên nhân, xếp theo khả năng.
5. **Xác nhận**: tái hiện bằng gọi API vào app chạy sẵn, hoặc unit test nhắm đúng chỗ. Chưa chắc chắn thì mới bật kiểm giả thuyết song song.
6. **Fix theo root cause**, rồi gate: build, test tái hiện chuyển fail → pass, test liên quan pass, diff gọn.

Dừng điều tra **khi có bằng chứng**, không dừng vì đã hết nửa thời gian. Chỉ khi sắp chạm deadline mới fix theo giả thuyết mạnh nhất.

---

## 7. Xử lý log

| | Log trong item | Log trong sandbox (gate) |
|---|---|---|
| Nói về | Lỗi của hệ thống | Lỗi của bản fix |
| Có khi nào | Trước khi agent làm | Sau khi agent sửa và chạy thử |
| Dùng để | Tìm chỗ cần sửa | Biết bản fix đã đúng chưa |

- **Chữ ký lỗi** = loại exception + frame đầu tiên thuộc code dự án. Dùng để xác nhận tái hiện đúng lỗi và phát hiện vòng lặp.
- **Log Condenser** rút log Maven hàng nghìn dòng còn vài dòng: test fail, assertion, frame đầu tiên, lỗi compile.
- **Phân loại kiểu fail** để re-plan đúng hướng: compile error, test gốc vẫn fail, regression, MVS fail, diff quá lớn.
- Mỗi lần thử bắt đầu lại từ branch sạch. Test fail thì chạy lại 1 lần để loại trừ test flaky.

---

## 8. Ngân sách $50

**Orchestrator không đọc token và không tính chi phí.** Codex Plugin của BTC đã theo dõi token và chi phí của đội, nên đội không làm lại việc đó. Chi phí được giữ trong tầm kiểm soát bằng **giới hạn cố định**, chỉnh theo số liệu xem trên plugin ở các phase practice và trial.

| Giai đoạn | Gợi ý |
|---|---|
| Dựng hệ thống | ~$5–8 |
| Trial, practice | ~$10–12, xem chi phí từng loại item trên plugin để chỉnh giới hạn |
| **Ngày thi** | **≥ $30** |

- Dựng bằng Claude, chạy bằng Codex: phần lớn hệ thống là code thuần, dựng không tốn $50.
- **Chế độ mock**: chạy Codex thật một lần, lưu output JSON, phát lại để test orchestrator và monitor.
- **Giới hạn cố định** (trong `config/agents.toml` và luật tự quyết):
  - số lần re-plan tối đa mỗi item;
  - thời gian chờ tối đa cho từng vai trò (fixer, reviewer, PI hypothesis);
  - model và mức suy luận theo vai trò: rẻ cho reviewer, PI hypothesis; fixer nhỏ hoặc mạnh do JEV chọn theo từng item;
  - kiểm giả thuyết song song chỉ khi PI bị kẹt;
  - số lần gọi `web_search` mỗi item.

---

## 9. Hạ tầng

Một máy của đội (VPS):

- **Tiến trình**: Codex Plugin (BTC) → Orchestrator Agent (thread Codex) → MCP `control` (code đội) → các worker `codex exec`; MCP tool local (stdio).
- **Lưu trữ**: SQLite cho state và trace. Monitor đọc từ SQLite. Token và chi phí xem trên plugin BTC.
- **Toolchain cài sẵn** trên VPS cho mọi stack có thể gặp: JDK + Maven/Gradle, Node + pnpm/yarn, Python + pip/poetry, .NET SDK, Go, PHP + Composer.
- **Vùng làm việc**: repo của đội, cache dependency, app chạy sẵn, mỗi item một git worktree. Sandbox Codex tắt mạng.
- **Ra ngoài** (môi trường thi có mạng): plugin xác thực với Game Master; `control` gọi JEV (TypeSafe API, key `TYPESAFE_API_KEY` trong `.env`); `control` gọi Game Master API (URL + API key + team id), pull repo GitHub và tải dependency; Codex CLI gọi OpenAI API (key BTC); tool `web_search` tra web tự do (trừ Game Master/Admin/Grader). Lệnh Codex tự chạy trong sandbox không ra mạng.
- **Người**: nhóm thi chỉ xem monitor, không can thiệp.

---

## 10. Monitor

`monitor/index.html`, đọc state từ SQLite (hiện chạy bằng dữ liệu mẫu trong `monitor/data.js`).

- Chỉ số tổng, luồng xử lý, danh sách item, chi tiết item (trace, gate, vùng impact).
- **Cần bổ sung**: deadline còn lại theo giờ server, 4 loại TASK / CR / BUG / PI, số lần thử mỗi item.

---

## 11. Lộ trình dựng

**Trước Training Camp (đến 25/10)**

1. ✅ Cài và **pin phiên bản Codex** (đã kiểm với codex-cli 0.162.1).
2. ✅ Agent: fixer (tự phân tích + sửa); luật chung, vai trò, 4 skill v2 TASK / CR / BUG / PI; reviewer, PI hypothesis; tài liệu tham khảo; gói 6 stack; nhận diện stack (`agents/`, `orchestrator/profile.py`).
3. ✅ Runner gọi `codex exec`, chế độ mock, SQLite (`orchestrator/`).
3b. ✅ Client JEV (TypeSafe) + 6 điểm quyết định có luật dự phòng (`orchestrator/jev.py`, `decisions.py`). Cần key `TYPESAFE_API_KEY` để chạy thật.
4. `GameMasterClient` + **`FakeGameMaster`**; MCP `control` (wait_event, status, act), hàng đợi, worktree.
5. MCP tool: CodeGraph, bản đồ hệ thống, runner (build, test, MVS, gọi app), Log Condenser, web_search. Gate. Test trên repo Spring nhỏ.
6. Hướng dẫn cho Orchestrator Agent (prompt + cách gọi `control`), chạy thử bằng Codex SDK giống cách plugin spawn.
7. Dựng bộ repo mẫu nhiều stack (vd. Spring, NestJS, FastAPI) với ~10 lỗi cài sẵn đủ 4 loại item; chạy Codex thật, sửa skill theo chỗ agent sai.

**Training Camp (26/10 – 6/11)**

8. Tuần 1: nhận plugin và tài liệu API → kiểm các câu hỏi ở mục 4.2, viết `HttpGameMaster`, test kết nối, chạy hết một trận practice.
9. Tuần 2: trial rounds. Xem chi phí từng loại item trên plugin, đo thời gian build/test/tái hiện PI, chỉnh luật tự quyết và các giới hạn cố định.

---

## 12. Rủi ro

| Rủi ro | Biện pháp |
|---|---|
| Hết $50 trước ngày thi | Chia ngân sách, dùng mock khi dựng, theo dõi chi phí trên plugin BTC |
| Nộp bản fix sai (chỉ nộp 1 lần) | Orchestrator tự chạy lại gate, MVS bắt buộc với CR/BUG |
| Agent loop, đốt $ | Giới hạn số lần re-plan và thời gian chờ, chữ ký lỗi, luật tự quyết |
| Build chậm làm PI mất điểm | Build sẵn, cache dependency, chỉ build module bị sửa |
| Prompt injection dẫn tới vi phạm luật | Item là untrusted, sandbox tắt mạng, `web_search` chặn Game Master/Admin/Grader, chỉ orchestrator gọi Game Master |
| Flag Codex thay đổi giữa các bản | Pin version, tập dượt đúng bản sẽ dùng |
| Lệch giờ máy và giờ server | Chỉ dùng giờ server cho deadline |
| JEV lỗi, chậm hoặc trả lời sai | Timeout 5 s, mọi quyết định có luật code dự phòng, ràng buộc cứng do code giữ; ghim phiên bản model (`jev-1.x`) trước ngày thi |
| JEV đang early access, API có thể đổi | Client gói toàn bộ lỗi thành `JevError` → luật code; kiểm lại API trong Training Camp |
| Plugin không nạp MCP của đội, hoặc sandbox của agent tắt mạng | Phương án dự phòng ở mục 4.2; kiểm ngay tuần đầu Training Camp |
| Worker `codex exec` ngoài plugin bị cấm hoặc không được tính | Chuyển sang sub-agent của Codex trong cùng thread |
| Lộ API key Game Master hoặc GitHub token | Chỉ nằm trong biến môi trường của `control`, loại khỏi môi trường worker, không ghi log |
| Nộp 2 lần do lỗi mạng | Ghi trạng thái trước khi nộp, hỏi lại trạng thái item thay vì gọi lại `submit` |

---

## 13. Câu hỏi mở cho BTC

**Đã chốt**

- Model: dùng model nào cũng được. MCP: được dùng. Môi trường thi: có mạng.
- Công cụ BTC: Codex Plugin (xác thực, spawn Orchestrator Agent, theo dõi output và token). Game Master cấp URL endpoint, API key, team id. Repo: GitHub.
- AI lúc dựng: tùy đội, cần license hợp pháp. Lúc thi: Codex.
- API kết nối và lấy task: công bố trong Training Camp (26/10 – 6/11).

- Được dùng kết hợp AI khác với Codex trong trận (đội dùng Jev của TypeSafe).

**Hỏi trong Training Camp**

- Plugin spawn Orchestrator Agent thế nào: lệnh, thư mục làm việc, sandbox, có mạng không, model, có nạp `CODEX_HOME` / `.codex/config.toml` / MCP của đội không?
- Hướng dẫn cho agent khai báo ở đâu: `AGENTS.md`, prompt cấu hình trong plugin, hay skill?
- Agent có được tự chạy thêm `codex exec` / Codex SDK (worker) không? Token của worker có được plugin tính vào chi phí đội không?
- Plugin có cấp sẵn tool gọi Game Master (lấy item, báo start, nộp bài) không, hay đội tự gọi HTTP API?
- Nộp bài qua API hay qua git push? Evidence của CR/BUG theo định dạng nào?
- Có trang xem số $ đã dùng không? Hết $ giữa trận thì sao? Rate limit của API?
- Quyền GitHub của đội: token hay deploy key, được push không?
- Phiên bản Codex CLI / SDK có bị cố định không?
