# Kiến trúc Digital Development Team — Master the Machine 2026

> **Đã được thay thế (25/10/2026).** Kiến trúc trong file này (Python orchestrator gọi `codex exec` cho
> từng agent, Jev lúc thi) trái với quy định của BTC: chỉ được chạy trong phiên Codex do MTM Player khởi
> chạy, và subagent chỉ được tạo bằng cơ chế native của Codex. Thiết kế hiện hành nằm ở
> [`docs/team-pack/`](../team-pack/README.md). File này giữ lại làm tham chiếu cho phần logic được port
> (gate, nhận diện stack, log condenser, luật tự quyết).

> Phiên bản: **v0.7** · Runtime: **Codex CLI / Codex SDK** · Ngân sách: **$50** (dev + practice + thi)
> v0.4: thêm Codex Plugin của BTC, Orchestrator Agent, kết nối Game Master, lịch Training Camp.
> v0.5: **JEV = Jev của TypeSafe AI** (model ra quyết định có kiểu) cho các quyết định nhanh; không còn agent phân tích riêng: **fixer tự phân tích** ở bước đầu (tiết kiệm 1 lần gọi Codex mỗi item, quan trọng với PI).
> v0.6: **Jev không dùng ngân sách làm đặc trưng quyết định.** Chọn model và quyết định tự quyết dựa trên `pending_items` (số item đang chờ) và `minutes_left` (thời gian còn lại), cả hai do code biết chắc. Ngân sách $50 chỉ còn là ràng buộc cố định ở mục 8.
> v0.7: đối chiếu **luật chơi chính thức** (`docs/btc/MTM_Game_Rules.md`) và **Q&A với BTC** (`docs/btc/Q&A.md`, số `#n`): nộp bài kèm `gitRevision` (commit đã push), submit template và MVS nhận lúc start, evidence ảnh chụp app, bug đã sửa sẵn, điểm PI theo thứ hạng, phạt −50 khi vào máy, hết $50 giữa trận, item không có deadline, tự hồi phục.
> Bản vẽ: `docs/legacy/diagrams.html` (01 Architecture, 02 Infrastructure)

---

## 1. Bối cảnh trận đấu

Tổng hợp từ buổi phổ biến, luật chơi chính thức (`docs/btc/MTM_Game_Rules.md`) và Q&A với BTC (`docs/btc/Q&A.md`, số `#n`).

**Diễn biến một trận**

1. Game Master đẩy source vào repo của đội. Hệ thống tự pull code, cài dependency, rồi **báo sẵn sàng**. Từ đây con người không can thiệp.
2. **Codex Plugin** của BTC xác thực đội với Game Master, rồi spawn **Orchestrator Agent** của đội. Agent vào trang match để lấy backlog.
3. Backlog đầu tiên hiện ra, có 40 phút làm. Mỗi trận khoảng **10 item** (#18). Item mới xuất hiện theo từng đợt, không báo trước (dashboard gắn nhãn đợt: `FAULT`, `INCIDENT`, `PRESSURE`, `TWIST`, `FINALE`). Agent tự sắp ưu tiên, tự làm và tự nộp.
4. Hết giờ, trận chuyển `FINISHED`. Grader chấm từng bài `PASSED` / `FAILED`, BGK chốt điểm.

**Codebase**: không biết trước tech stack, mỗi vòng một repo khác, mọi đội dùng chung một codebase; không được đổi stack hay viết lại (#1, #2, #16). Codebase không lớn, không dùng stack hiếm, nhưng BTC cài "bẫy" cho vui.

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
| TASK | Việc được giao thông thường | Không | Theo đề | Bình thường |
| CR | Thay đổi theo spec mới | **Có, bắt buộc pass** | **Có** | Bình thường |
| BUG | Sửa lỗi, không làm hỏng chỗ khác | **Có, bắt buộc pass** | **Có** | Bình thường |
| PI | Sự cố production, ít thông tin, phải tự điều tra | Không | Theo đề | **Cao nhất, điểm theo thứ hạng thời gian** |

- Type gán sẵn trong item (#21); mã `{TYPE}-{số}` chỉ là dự phòng.
- Evidence thường gồm log MVS và **ảnh chụp app trước và sau khi sửa** (#20).
- MVS chỉ là mức tối thiểu: Grader chấm thêm kịch bản ngoài MVS, nên phải tự test chặt hơn MVS.

**Tính điểm**

- Tối đa **1.000 điểm** mỗi trận. Điểm tối đa từng item hiện trên trang match.
- **PI xếp hạng giữa các đội** theo thời gian từ lúc đề hiện ra tới lúc bài được chấm `PASSED`: nhất 100%, nhì 90%, ba 75%, còn lại 60%. Chưa xong hoặc `FAILED` = **0**. Nghĩa là nộp PI sai thiệt hơn nộp chậm.
- Mỗi lần người vào máy sửa hệ thống: **−50 điểm** (tối đa 5 phút mỗi lần). Ngoại lệ: hết $50 và agent dừng thì được vào đổi tài khoản Codex, không bị phạt (#13). Tài khoản BTC không nạp thêm được (#17).
- Bằng điểm thì xét điểm phụ: mốc hoàn thành item cuối nhanh hơn trung bình bao nhiêu %, credit Codex ít hơn trung bình bao nhiêu %, mỗi 1% = +10. Vẫn hòa thì BGK quyết định.

**Luật nộp bài**

- Phải báo **start working** trước; lúc start, server trả về **submit template** (và MVS với CR/BUG). Nộp khi chưa start bị từ chối.
- Nộp theo template, kèm **`gitRevision`** = SHA của commit đã push lên repo GitHub của đội.
- Mỗi item chỉ nộp **1 lần**. Đã `ACCEPTED` thì nộp lại bị từ chối.
- Điểm lúc nộp là tạm thời; Grader chấm `PASSED` / `FAILED` thành điểm chính thức.
- Có item có deadline, có item không (#18). Không có deadline thì nộp lúc nào trước hết trận cũng được. Deadline tính bằng phút từ lúc item hiện ra, không tính lúc trận `PAUSED`.
- Trạng thái item: `VISIBLE` → `OPEN` → `CLOSED` (hết hạn, không nộp được nữa).
- Bug đã được sửa sẵn (vd. test có sẵn đã bắt được) thì báo là đã sửa, nhưng vẫn phải kèm evidence (#20).
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
7. **Tự hồi phục.** Người vào máy = −50 điểm, nên hệ thống phải tự đứng dậy: crash thì watchdog khởi động lại và chạy tiếp từ SQLite; Codex hết quota hay bị rate limit thì tạm dừng chờ, không đốt lượt thử của item.

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
     └──── nộp 1 lần ◄── commit + push         Log Condenser
       (template · gitRevision · evidence)      ├─ còn giờ, còn lượt → re-plan
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
- Kiểm quyền push lên repo GitHub của đội (cần để có `gitRevision`) và kiểm `codex login`.
- Xong hết thì gọi `ready()` báo sẵn sàng với Game Master.

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

- Theo dõi trang `/match/<id>` liên tục, phát hiện item mới và **item bị sửa nội dung** (so hash; đổi thì bỏ lần thử đang chạy và re-plan với đề mới).
- Báo "start working" trước khi giao việc; lưu submit template và MVS server trả về.
- Hàng đợi: **PI trước**, sau đó theo deadline còn lại, **điểm tối đa** và độ khó (lấy từ triage).
- Gọi worker `codex exec` cho từng việc (fixer, reviewer, PI hypothesis), mỗi item một git worktree, mỗi lần một phiên mới.
- Tự chạy lại gate, quyết định nộp hay re-plan hay bỏ.
- Nộp bài: commit thay đổi của item trong worktree, push, rồi gửi payload theo template kèm `gitRevision` và evidence (mục 4.7).
- Sau khi nộp, theo dõi kết quả chấm `PASSED` / `FAILED` để hiện trên monitor.
- Codex hết quota hoặc bị rate limit: tạm dừng giao việc, không tính lần thử (mục 4.6).
- Ghi trạng thái, thời gian và trace của từng lần chạy agent vào SQLite (không đếm token, không tính tiền — plugin BTC làm việc đó).
- Chạy dưới **watchdog**: crash thì tự khởi động lại; vòng run đọc SQLite, bỏ qua item đã nộp hoặc đã bỏ, làm tiếp phần còn lại.

**Chờ Training Camp xác nhận** (có phương án dự phòng):

| Câu hỏi | Nếu "không" |
|---|---|
| Plugin có nạp cấu hình Codex của đội (MCP server, `CODEX_HOME`, `.codex/config.toml`)? | Agent chạy `python -m orchestrator run` bằng shell; cần sandbox cho phép mạng hoặc `danger-full-access`. |
| Hướng dẫn cho agent đặt ở đâu: `AGENTS.md` trong repo, prompt khai báo với plugin, hay skill? | Nếu bắt buộc `AGENTS.md` ở gốc repo: thêm vào `.git/info/exclude`, worktree tạo từ commit gốc nên không lẫn vào diff nộp bài. |
| Worker `codex exec` riêng có được phép, và plugin có tính token của chúng? | Dùng tính năng sub-agent của chính Codex (`multi_agent`) để mọi việc nằm trong thread plugin theo dõi. |
| Plugin có cấp sẵn tool gọi Game Master không? | `control` gọi thẳng HTTP API bằng URL + API key + team id (mục 4.7). |
| Grader chấm mỗi `gitRevision` độc lập trên commit gốc? | Mặc định: mỗi item một commit trên commit gốc, push nhánh `mtm/<item>`. Nếu phải cộng dồn trên một nhánh: cherry-pick lần lượt, chạy lại gate trên bản cộng dồn trước khi push. |

### 4.3 JEV và triage

Không có agent phân tích riêng. Khi item mới hiện ra, orchestrator tạo **triage** từ code + JEV rồi giao thẳng cho fixer; **fixer tự phân tích** ở bước đầu (tiêu chí hoàn thành, vùng code nghi vấn bằng CodeGraph) và trả về trong `criteria`, `suspects` để reviewer và monitor dùng.

```json
{
  "id": "PI-03", "type": "PI", "deadlineMin": 18, "maxPoints": 150,
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
| Chọn cách chạy | fixer dùng model nhỏ hay mạnh (choice); có cần reviewer (noul). `state` gồm loại item, triage (cả điểm tối đa), `pending_items`, `minutes_left` | hard/PI/CR → mạnh; PI không review; loại khác mặc định có review |
| Kiểm lời Codex | báo cáo của agent có khớp gate report? (noul) | theo kết quả gate |
| PI | root cause đã có bằng chứng? (noul) | có root_cause + confidence ≥ 0.7 + có kiểm pass |
| Luật tự quyết | nộp / thử lại / bỏ (choice) | luật ở mục 4.6 |

- **Ngưỡng**: `choice`/`score` dùng khi confidence ≥ 0.7; `noul` là "có" khi ≥ 0.8, "không" khi ≤ 0.2, ở giữa → luật code.
- **Ràng buộc cứng do code giữ**: Jev chỉ chọn trong các lựa chọn hợp lệ (vd. gate fail thì "nộp" không có trong danh sách); PI không chạy reviewer.
- Mỗi quyết định ghi vào SQLite (`jev_decisions`): giá trị, nguồn jev/fallback, độ tin cậy, thời gian — để xem tỉ lệ Jev tự quyết trên monitor.
- **Không có ngân sách trong `state`**: orchestrator không theo dõi token hay chi phí (plugin BTC làm việc đó). Áp lực tài nguyên được biểu diễn bằng `pending_items` và `minutes_left`.
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
- **Submit template**: fixer điền các trường của template vào `template_answers` (danh sách `field`/`value`, vì schema strict không cho khóa động); code ghép vào payload, các trường code biết chắc (`gitRevision`, danh sách file) do code điền.
- **Bug đã sửa sẵn**: fixer trả `status: already_fixed` khi không tái hiện được lỗi trên code gốc và có test chứng minh hành vi đã đúng. Gate đi nhánh riêng (không đòi diff, chạy test đó trên commit gốc), nộp với `gitRevision` = commit gốc kèm evidence.

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
- **Evidence** (chạy ngoài sandbox): khởi động app bằng `run_app` của profile, headless browser (Playwright) chụp trang liên quan ở commit gốc (ảnh "trước", chụp song song với fixer ngay khi start) và ở bản fix (ảnh "sau"); đính kèm log MVS. Trang cần chụp do fixer khai trong kết quả.

Giới hạn output của từng tool để không đổ log dài vào context.

### 4.6 Luật tự quyết (thay cho người)

- Hết giờ hoặc hết số lần re-plan cho item → bỏ item (MVS đã pass thì nộp bản tốt nhất).
- MVS đã pass nhưng còn check phụ fail → nộp bản tốt nhất.
- Cùng chữ ký lỗi lặp 2 lần → bắt buộc đổi giả thuyết. Lặp tiếp → bỏ item.
- Khi có nhiều lựa chọn hợp lệ (nộp / thử lại / bỏ), hỏi JEV với `attempts`, `minutes_left`, `pending_items`, kết quả gate; dưới ngưỡng tin cậy thì theo luật trên.
- Nhiều item cùng sắp hết hạn → ưu tiên PI, rồi item gần xong nhất.
- Item không có deadline → thời gian còn lại = thời gian còn lại của trận; mọi luật theo giờ ở trên dùng con số này.
- Codex báo **hết quota** hoặc **rate limit** → lần thử đó không tính, worktree reset, không giao item mới, chờ `limit_wait_sec` rồi thử lại. Hết quota thì monitor báo rõ "đổi tài khoản Codex" (đổi tài khoản không bị phạt, #13). Hết deadline trong lúc chờ → bỏ item.
- PI: `FAILED` = 0 điểm còn nộp chậm vẫn ≥ 60%, nên PI chỉ bỏ reviewer, **không bỏ gate** để nộp sớm.

### 4.7 Kết nối Game Master

BTC cấp **URL endpoint, API key, team id**. Plugin dùng chúng để xác thực và đăng ký đội; `control` dùng để theo dõi match và nộp bài (trừ khi plugin cấp sẵn tool).

- **Bí mật**: để trong biến môi trường `GM_URL`, `GM_API_KEY`, `GM_TEAM_ID` (file `.env` không commit). Chỉ `control` đọc. Worker Codex không thấy (đã loại biến `*KEY*`, `*TOKEN*` khỏi môi trường lệnh shell), không đưa vào prompt hay log.
- **`GameMasterClient`**: một interface, nhiều bản cài đặt.

  | Hàm | Việc |
  |---|---|
  | `server_time()` | Giờ server, dùng cho mọi deadline |
  | `ready()` | Báo sẵn sàng sau bước chuẩn bị (chờ API thật) |
  | `get_match()` | Trạng thái trận, danh sách item (VISIBLE / OPEN / CLOSED), deadline (có thể không có), điểm tối đa, kết quả chấm của item đã nộp |
  | `get_item(id)` | Nội dung item |
  | `start_item(id)` | Báo "start working", nhận submit template (+ MVS với CR/BUG) |
  | `submit(id, payload, evidence)` | Nộp 1 lần; payload theo template, có `gitRevision` |

  `minutes_left` của item = min(đến deadline, đến hết trận); item không có deadline thì `deadline_min = None` và `minutes_left` = thời gian còn lại của trận.

  Bản cài đặt: `HttpGameMaster` (API thật, viết khi có tài liệu ở Training Camp) · `PluginGameMaster` (nếu plugin cấp tool) · **`FakeGameMaster`** (dựng ngay: ra item theo kịch bản, đồng hồ riêng, có PAUSED, từ chối nộp lần 2 hoặc nộp khi chưa start).
  Cài đặt: interface, `with_retry`, `safe_submit` ở `orchestrator/gamemaster.py`; bản giả ở gói riêng `fake_gamemaster/` (ngoài orchestrator, chỉ `cli match` và test dùng). `FakeGameMaster` đọc kịch bản JSON (`samples/scenarios/practice.json`: phút item hiện ra, deadline, các lần PAUSED), chạy bằng `FastClock(speed)` để tua nhanh hoặc `ManualClock` trong test, và giả được lỗi mạng trước hoặc sau khi server xử lý (`fail_next`). Giả định trạng thái: VISIBLE = chưa start, OPEN = đã start, CLOSED = đã nộp / hết hạn / hết trận; mã từ chối `NOT_STARTED`, `ALREADY_SUBMITTED`, `CLOSED`, `MATCH_NOT_RUNNING`. Kiểm lại tất cả khi có API thật.
- **Nộp an toàn**: ghi "đang nộp" vào SQLite **trước** khi gọi API. Lỗi mạng thì hỏi lại trạng thái item rồi mới quyết, không gọi `submit` lần 2 một cách mù quáng.
- **Gọi lại khi lỗi**: thử lại có giãn cách cho các lệnh đọc; không tự thử lại `submit`. Cài đặt: `safe_submit()` + bảng `submissions` (mỗi item một dòng), `with_retry()` cho lệnh đọc.
- **GitHub**: repo của đội trên GitHub, Game Master đẩy source vào. Cần token hoặc deploy key để pull và push. Token chỉ dùng ở bước chuẩn bị và trong `control`.
- **`gitRevision`**: agent không commit. Khi quyết định nộp, orchestrator commit thay đổi của item trong worktree (tác giả lấy từ `config/run.toml`), push SHA đó lên `push_remote` nhánh `push_branch` (mặc định `origin`, `mtm/{item}`), rồi đưa SHA vào payload. Không bao giờ push `--force`: chạy lại sau crash mà nhánh đã trỏ commit khác (có thể đã được nộp) thì push sang `mtm/<item>-<sha8>`, để SHA đã nộp vẫn còn trên remote. `push_branch` bắt buộc chứa `{item}` để không đẩy lên nhánh chung. Push lỗi mạng thì thử lại, không push được thì **không nộp**. `push_remote = ""` thì chỉ commit (debug). Trận giả: repo mẫu có một bare repo làm `origin`.

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
| Evidence khi nộp | ✔ log MVS + ảnh | ✔ log MVS + ảnh | theo đề | theo đề |

Khi sắp hết deadline, profile tự rút gọn: bỏ reviewer trước, rồi lint và scan. **Không bao giờ bỏ build, MVS và test quan trọng.**

**Cài đặt** (`orchestrator/gate.py`, giới hạn trong `config/gate.toml`). Chạy theo thứ tự rẻ trước, dừng ở bước fail đầu tiên:

1. **Diff** so với commit gốc (gồm file mới chưa track): phải có thay đổi; không quá `max_files` / `max_lines`.
2. **Luật cấm**: thêm marker skip (`forbidden_skip` của profile) vào file test, xóa file test, bớt assertion, sửa file build khi agent không khai `needs_dependency`, sửa CI/wrapper. Đổi assertion có sẵn mà không bớt → chỉ cảnh báo cho reviewer.
3. **Build** cho từng stack có file bị sửa.
4. **Test agent khai** (`tests_added`) ghép vào `test_one`; fail thì chạy lại 1 lần để loại trừ test flaky.
5. **Regression** (`test_all`); bỏ được khi sắp hết giờ (`full_regression=False`).
6. **MVS** nếu có lệnh; CR/BUG chưa có MVS runner thì ghi `skipped`.

Kết quả: `passed`, `fail_kind`, chữ ký lỗi, log rút gọn, `to_text()` cho reviewer và `Decider.claims_supported`, `previous_attempt()` cho fixer thử lại. Mỗi lần chạy ghi vào bảng `gate_runs` để phát hiện chữ ký lặp lại. Gate chạy **ngoài sandbox**: tên test do agent khai bị lọc ký tự trước khi ghép vào lệnh shell, biến môi trường chứa KEY/TOKEN/SECRET/PASSWORD và `GM_*` bị bỏ khỏi lệnh.

Chưa làm: lint/scan; kiểm test tái hiện fail trên code gốc rồi mới pass (BUG/PI); nhánh `already_fixed` (không đòi diff, test phải pass trên code gốc).

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

Điểm PI theo thứ hạng giữa các đội (100 / 90 / 75 / 60%), nhưng `FAILED` = 0. Chậm một bậc mất 10–15%, sai mất hết: PI bỏ reviewer để nhanh, nhưng vẫn qua đủ gate.

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
- Cài đặt: `orchestrator/logs.py` (`condense`, `signature`, `compile_errors`, `failing_tests`) cho Java/Kotlin, Node/TS, Python, .NET, Go, PHP. Chữ ký bỏ số dòng và đường dẫn worktree nên giữ nguyên giữa các lần thử.

---

## 8. Ngân sách $50

**Orchestrator không đọc token và không tính chi phí.** Codex Plugin của BTC đã theo dõi token và chi phí của đội, nên đội không làm lại việc đó. Chi phí được giữ trong tầm kiểm soát bằng **giới hạn cố định**, chỉnh theo số liệu xem trên plugin ở các phase practice và trial.

| Giai đoạn | Gợi ý |
|---|---|
| Dựng hệ thống | ~$5–8 |
| Trial, practice | ~$10–12, xem chi phí từng loại item trên plugin để chỉnh giới hạn |
| **Ngày thi** | **≥ $30** |

- Dựng bằng Claude, chạy bằng Codex: phần lớn hệ thống là code thuần, dựng không tốn $50.
- **Hết $50 giữa trận** (#13, #17): tài khoản BTC không nạp thêm được. Codex báo hết quota → orchestrator tạm dừng (mục 4.6), monitor báo đổi tài khoản; đội vào máy chỉ để đổi tài khoản thì không bị phạt, sau đó vòng run tự chạy tiếp. Tài khoản cá nhân chỉ dùng trên máy cá nhân (luật BMTT).
- Điểm phụ khi hòa tính theo credit Codex so với trung bình các đội: tiết kiệm credit có giá trị thật, không chỉ để giữ ngân sách.
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

`monitor/index.html` + `orchestrator/monitor.py`. Chạy `python -m orchestrator.cli monitor` (trận mới nhất trong `runs/`) rồi mở http://127.0.0.1:8765. Trang đọc `/api/state` mỗi 3 giây, lấy từ SQLite của trận ở chế độ chỉ đọc. Mở `index.html` trực tiếp thì dùng dữ liệu mẫu `monitor/data.js` (sinh từ một trận mock).

- Chỉ số: đã nộp và điểm tạm, đang làm, bỏ / lỗi, PI, lần thử trung bình, tỉ lệ Jev tự quyết.
- Luồng: Chờ → Đang làm → Đã nộp; Bỏ; Lỗi / chưa rõ nộp. Lọc theo trạng thái và loại TASK / CR / BUG / PI.
- Bảng item: số phút còn lại theo giờ Game Master (vòng run ghi vào `match_state` mỗi lần poll), số lần thử, 7 ô gate (diff, luật cấm, build, test agent viết, regression, MVS, reviewer).
- Cảnh báo to khi Codex hết quota (kèm việc cần làm: đổi tài khoản) hoặc đang bị rate limit.
- Chi tiết: kết quả nộp, `gitRevision`, kết quả chấm `PASSED` / `FAILED`, lý do bỏ, cảnh báo bẫy prompt, check gate + chữ ký lỗi + log rút gọn, reviewer, tóm tắt và root cause của fixer, trace gộp (agent, gate, quyết định, nộp bài).
- Không có token hay chi phí (plugin BTC theo dõi).

---

## 11. Lộ trình dựng

**Trước Training Camp (đến 25/10)**

1. ✅ Cài và **pin phiên bản Codex** (đã kiểm với codex-cli 0.162.1).
2. ✅ Agent: fixer (tự phân tích + sửa); luật chung, vai trò, 4 skill v2 TASK / CR / BUG / PI; reviewer, PI hypothesis; tài liệu tham khảo; gói 6 stack; nhận diện stack (`agents/`, `orchestrator/profile.py`).
3. ✅ Runner gọi `codex exec`, chế độ mock, SQLite (`orchestrator/`).
3b. ✅ Client JEV (TypeSafe) + 6 điểm quyết định có luật dự phòng (`orchestrator/jev.py`, `decisions.py`). Cần key `TYPESAFE_API_KEY` để chạy thật.
4. ✅ `GameMasterClient` + **`FakeGameMaster`** + `safe_submit` (`orchestrator/gamemaster.py`, bản giả ở `fake_gamemaster/`).
4b. ✅ Vòng `run` (`orchestrator/match.py`): triage → route → fixer → gate → reviewer → `next_action` → nộp, hàng đợi ưu tiên PI, worktree mỗi item (`orchestrator/workspace.py`), chạy song song, chạy lại sau crash. Chạy cả trận giả không tốn $: `python -m orchestrator.cli match --mock --jev-mock` trên repo mẫu `samples/repo-template/`.
4c. MCP `control` (wait_event, status, act) bọc vòng `run` cho Orchestrator Agent.
4d. ✅ Monitor đọc SQLite (mục 10).
4e. ✅ Chạy Codex thật lần đầu (22/10, 1 item BUG trên repo mẫu, tài khoản cá nhân): fixer `gpt-6-luna` sửa đúng, gate pass, reviewer approve, nộp được. Hai lỗi tìm ra và đã sửa: Windows cần `[windows] sandbox = "elevated"` (thiếu thì mọi lệnh shell bị chặn); fixer khai `tests_added` kiểu Java cho dự án unittest (schema + vai trò fixer giờ yêu cầu đúng `{target}` của `test_one`, gate coi tên không tìm thấy là cảnh báo).
4f. ✅ Nộp bài theo luật chính thức: commit + push mỗi item, `gitRevision` trong payload; item không có deadline; tạm dừng khi Codex hết quota / rate limit, banner trên monitor (mục 4.6, 4.7). Mẫu thông báo quota của Codex cần kiểm lại với tài khoản thật.
4g. Submit template (`template_answers`), `already_fixed`, theo dõi item đổi nội dung, `max_points` trong hàng đợi, theo dõi kết quả chấm, `ready()`.
4h. Evidence ảnh chụp: chạy app + Playwright ngoài sandbox (mục 4.5).
4i. Watchdog tự khởi động lại `control` khi crash.
5. ✅ Gate + Log Condenser (`orchestrator/gate.py`, `orchestrator/logs.py`, mục 5 và 7).
5b. MCP tool: CodeGraph, bản đồ hệ thống, runner (build, test, MVS, gọi app), web_search. Test gate trên repo Spring nhỏ.
6. Hướng dẫn cho Orchestrator Agent (prompt + cách gọi `control`), chạy thử bằng Codex SDK giống cách plugin spawn.
7. Dựng bộ repo mẫu nhiều stack (vd. Spring, NestJS, FastAPI) với ~10 lỗi cài sẵn đủ 4 loại item; chạy Codex thật, sửa skill theo chỗ agent sai.

**Training Camp (26/10 – 6/11)**

8. Tuần 1: nhận plugin và tài liệu API → kiểm các câu hỏi ở mục 4.2, viết `HttpGameMaster` (định dạng template, evidence, `gitRevision`, kết quả chấm), test kết nối và push, chạy hết một trận practice.
9. Tuần 2: trial rounds. Xem chi phí từng loại item trên plugin, đo thời gian build/test/tái hiện PI, chỉnh luật tự quyết và các giới hạn cố định.

---

## 12. Rủi ro

| Rủi ro | Biện pháp |
|---|---|
| Hết $50 trước ngày thi | Chia ngân sách theo giai đoạn (mục 8), dùng mock khi dựng, theo dõi chi phí trên plugin BTC; Jev không tham gia việc này |
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
| Codex hết quota giữa trận, item bị bỏ hàng loạt | Nhận diện lỗi quota / rate limit, tạm dừng không tính lần thử, monitor báo đổi tài khoản (không bị phạt) |
| Orchestrator crash, người phải vào máy (−50) | Watchdog tự khởi động lại, chạy tiếp từ SQLite |
| Không push được lên GitHub, không có `gitRevision` | Kiểm quyền push ở bước chuẩn bị, thử lại push, không nộp khi chưa push |
| Nộp PI sai → 0 điểm | PI không bỏ gate, chỉ bỏ reviewer |
| Đề đổi giữa trận (đợt `TWIST`) | So hash nội dung item mỗi lần poll, đổi thì re-plan |

---

## 13. Câu hỏi mở cho BTC

**Đã chốt**

- Model: dùng model nào cũng được. MCP: được dùng. Môi trường thi: có mạng.
- Công cụ BTC: Codex Plugin (xác thực, spawn Orchestrator Agent, theo dõi output và token). Game Master cấp URL endpoint, API key, team id. Repo: GitHub.
- AI lúc dựng: tùy đội, cần license hợp pháp. Lúc thi: Codex.
- API kết nối và lấy task: công bố trong Training Camp (26/10 – 6/11).

- Được dùng kết hợp AI khác với Codex trong trận (đội dùng Jev của TypeSafe). Được dùng tool bên thứ ba (#9).
- Nộp bài theo submit template nhận lúc start, kèm `gitRevision` (SHA đã push). Evidence thường có ảnh app trước/sau; bug đã sửa sẵn thì báo đã sửa (#20).
- Hết $50: đổi tài khoản không bị phạt; tài khoản BTC không nạp thêm (#13, #14, #17).
- Item có thể không có deadline (#18); type gán sẵn (#21).
- Mỗi đội 1 máy, 1 tài khoản Game Master, không giới hạn số agent (#15).

**Hỏi trong Training Camp**

- Plugin spawn Orchestrator Agent thế nào: lệnh, thư mục làm việc, sandbox, có mạng không, model, có nạp `CODEX_HOME` / `.codex/config.toml` / MCP của đội không?
- Hướng dẫn cho agent khai báo ở đâu: `AGENTS.md`, prompt cấu hình trong plugin, hay skill?
- Agent có được tự chạy thêm `codex exec` / Codex SDK (worker) không? Token của worker có được plugin tính vào chi phí đội không?
- Plugin có cấp sẵn tool gọi Game Master (lấy item, báo start, nộp bài) không, hay đội tự gọi HTTP API?
- `gitRevision` phải nằm trên nhánh nào? Grader chấm từng SHA độc lập trên commit gốc hay cộng dồn các bài đã nộp?
- Evidence gửi thế nào: ảnh upload qua API, URL, hay commit vào repo? Định dạng submit template?
- Trạng thái `OPEN` nghĩa chính xác là gì (đã start, hay chỉ đang mở)? Kết quả chấm `PASSED` / `FAILED` đọc ở đâu?
- Đợt `TWIST` có sửa nội dung item đã ra không?
- Codex báo hết quota bằng thông báo nào (để nhận diện chắc chắn)? Có trang xem số $ đã dùng không? Rate limit của API?
- Quyền GitHub của đội: token hay deploy key, được push không?
- Phiên bản Codex CLI / SDK có bị cố định không?
