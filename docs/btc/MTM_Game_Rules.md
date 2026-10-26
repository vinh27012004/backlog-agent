# MTM — Luật chơi Vòng Thực chiến

> Chuyển từ slide của BTC [`MTM_Game_Rules.html`](MTM_Game_Rules.html), bản tiếng Việt, giữ nguyên nội dung. Slide 15 chỉ có ảnh chụp Battle Dashboard nên được mô tả lại bằng chữ ở mục 13.

Dành cho các đội thi: AI của bạn tự nhận đề, tự làm, tự nộp bài. **40 phút**, tối đa **1.000 điểm**.

## 1. Mục tiêu cuộc thi: xây một đội dự án số chạy bằng AI

**Kịch bản:** BTC đóng vai khách hàng. Mỗi đội là một vendor được giao take over hệ thống có sẵn của khách hàng: fix bug, làm CR, xử lý sự cố production. Vendor đáp ứng yêu cầu hiệu quả nhất sẽ được chính thức chuyển giao vận hành và phát triển tiếp hệ thống.

Mỗi đội cần xây một Agentic AI System cho SDLC, gọi là **Digital Project Team**. Trong trận, hệ thống phải tự làm được 5 việc:

1. Tự nhận và hiểu đề bài
2. Theo dõi thay đổi liên tục
3. Lập và điều chỉnh kế hoạch
4. Dùng đúng agent và tool
5. Tự làm và nộp đúng lúc

Đội thắng là đội làm được:

- Đúng yêu cầu, điểm cao nhất
- Nhanh nhất
- Ít token/credit nhất

## 2. Tổng quan: trận đấu qua 4 con số

| Con số | Ý nghĩa |
|---|---|
| **40 phút** | Hết giờ, Game Master chốt điểm. |
| **1.000 điểm tối đa** | Tổng điểm mọi backlog trong một trận. |
| **4 loại backlog** | TASK, CR, BUG và PI. |
| **−50 điểm mỗi lần** | Khi đội xin vào máy để sửa AI. |

## 3. Quy trình trận đấu: 4 chặng

1. **Chuẩn bị:** Game Master đẩy source vào repo của đội. AI pull code mới nhất, báo sẵn sàng. Người rời máy.
2. **Bắt đầu:** Đợt backlog đầu tiên hiện ra. Cả đội xuống ghế khán giả. Đồng hồ 40 phút chạy.
3. **Thi đấu:** Backlog mới hiện ra không báo trước. AI tự làm, tự nộp. Grader chấm liên tục.
4. **Tổng kết:** Hết giờ, trận chuyển `FINISHED`. MC công bố, đội khiếu nại nếu cần, BGK chốt điểm.

> Từ lúc **Start Match**, con người chỉ ngồi xem: Digital Project Team tự chạy.

## 4. Bốn loại backlog

| Loại | Tên | Mô tả | MVS |
|---|---|---|---|
| **TASK** | Nhiệm vụ chung | Việc được giao thông thường. | Không có MVS |
| **CR** | Change Request | Thay đổi sản phẩm theo spec mới, đảm bảo chất lượng, gửi evidence. | Có MVS, bắt buộc pass |
| **BUG** | Fix Bug | Sửa lỗi đúng kỳ vọng, đảm bảo không hỏng chỗ khác, gửi evidence. | Có MVS, bắt buộc pass |
| **PI** | Product Incident | Sự cố production khách báo. Ít thông tin, phải tự điều tra. **Ưu tiên cao nhất.** | Không có MVS, đua tốc độ |

- Mã item có dạng `{TYPE}-{số}`, ví dụ `TASK-01`, `CR-02`, `BUG-01`, `PI-01`.
- Điểm tối đa của từng item hiện trên trang match khi đề được mở.
- **MVS** = *Minimum Verification Scenarios*: bộ kịch bản kiểm thử tối thiểu do Game Master cung cấp.

## 5. CR & BUG: MVS chỉ là mức tối thiểu

MVS (do Game Master đưa) chỉ là một phần trong mọi kịch bản Grader dùng để chấm.

- MVS chỉ được gửi khi đội **start working** item đó.
- Bắt buộc pass hết MVS và gửi evidence khi submit.
- Grader còn chấm cả kịch bản khác ngoài MVS.

→ **AI nên tự test chặt hơn MVS.**

## 6. Product Incident: ai xong trước, điểm cao hơn

| Thứ hạng | Điểm nhận được |
|---|---|
| Nhanh nhất | 100% (không bị trừ) |
| Nhanh nhì | 90% (trừ 10%) |
| Nhanh ba | 75% (trừ 25%) |
| Còn lại | 60% (trừ 40%) |

- Bấm giờ từ lúc đề hiện ra đến lúc nộp bài được chấm `PASSED`.
- Chưa xong hoặc `FAILED` = **0 điểm**.

## 7. Cách xử lý một backlog item: vòng lặp 5 bước của AI

1. **Đọc đề:** trên trang match của trận.
2. **Start working:** nhận submit template (và MVS nếu là CR/BUG).
3. **Làm bài:** code và test trên Git repo của đội.
4. **Submit:** theo template, kèm `gitRevision` (SHA commit đã push).
5. **Chờ chấm:** Grader trả về `PASSED` hoặc `FAILED`.

> Backlog mới có thể hiện ra bất kỳ lúc nào → AI phải theo dõi trang `/match/<match-id>` liên tục và quay lại bước 1.

## 8. Luật nộp bài: phải thông báo Start working, chỉ được submit một lần

- **Chưa start = bị từ chối.** Submit khi chưa start working sẽ bị từ chối. Digital Project Team cần thông báo khi bắt đầu làm việc.
- **Mỗi item nộp 1 lần.** Sau khi nộp item và server `ACCEPTED`, nộp lại item đó bị từ chối.
- **Điểm khi nộp chỉ là tạm thời.** Grader sẽ chấm và điều chỉnh thành điểm chính thức.

## 9. Deadline: có một số item phải nộp trước giờ đóng

| Trạng thái | Ý nghĩa |
|---|---|
| `VISIBLE` | Đề đã hiện trên trang match. |
| `OPEN` | Đang mở, đội làm và nộp được. |
| `CLOSED` | Hết hạn: không nộp được nữa. |

- **Deadline tính từ lúc đề hiện.** Đếm bằng phút, không tính lúc trận `PAUSED`. Bài nộp trước hạn vẫn được chấm.
- **Chỉ tin đồng hồ server.** Giờ chính thức là giờ server Game Master. Giờ trên máy đội chơi không được sử dụng.

## 10. Xin tiếp cận máy: được vào sửa, nhưng mất điểm

**−50 điểm mỗi lần**, **tối đa 5 phút mỗi lần**.

- Đội xin, Admin/MC bật phiên trên Control Room.
- Kiểm tra và sửa Digital Project Team trong phiên đó.
- Không giới hạn số lần, nhưng lần nào cũng trừ 50.
- Ngoài phiên này, đội ngồi ghế khán giả, AI tự chạy.

> **Ngoại lệ không bị trừ điểm:** nếu token chạm giới hạn **$50** và agent ngừng chạy, đội được dùng máy để đổi tài khoản (nếu muốn). Chỉ đổi tài khoản thì không bị phạt.

## 11. Xếp hạng: điểm cao nhất thắng, hòa thì xét điểm phụ

1. **Điểm chính thức:** tổng điểm tất cả các backlog item (đã được chấm), trừ 50 mỗi lần vào máy. Cao nhất thắng.
2. **Bằng điểm chính thức → tính điểm phụ:**
   - **Thời gian:** mốc hoàn thành backlog item cuối cùng nhanh hơn trung bình (các đội cần so chỉ số phụ) bao nhiêu %, mỗi 1% được +10.
   - **Credit Codex:** dùng ít hơn trung bình (các đội cần so chỉ số phụ) bao nhiêu %, mỗi 1% được +10 điểm phụ.
   - Điểm phụ không cộng vào điểm chính thức.
3. **Vẫn hòa:** Ban Giám khảo quyết định.

> Mẹo: nhanh hơn và tốn ít credit hơn chính là lợi thế khi hòa điểm.

## 12. Hành vi không được phép

4 điều đội và AI không được làm:

1. Truy cập, submit thay, hay dùng credential/API key của team khác.
2. Vào Admin interface, Admin API hay Grader API khi không được cấp quyền.
3. Tìm cách lấy đề, template, MVS chưa mở, hoặc dữ liệu riêng của đội khác.
4. Can thiệp, làm gián đoạn Game Master hay hoạt động của đội khác.

Khai thác lỗi hệ thống để vượt các giới hạn trên không được tính là hợp lệ.

## 13. Battle Dashboard (ảnh minh họa)

Slide 15 là ảnh chụp màn hình Battle Dashboard của một trận thử (`[Test Match] NEW MTM-26-K9F5U9`, Duration 00:40:00, Status `TIME OVER`). Dashboard gồm:

- **Thanh đội** (đầu trang): mỗi đội một thẻ với mã ngắn (HNK, DLQ, T01…T04), hiện `Points`, `Submitted`, `Working`, `Graded`, hoặc "Waiting for team to join".
- **PRODUCT BACKLOG**: mỗi dòng một item (vd. `TASK-11 Authentication restoration graph`, `CR-07 Show the filtered customer count`, `BUG-05 Reset restores the full customer list`, `PI-03 Production Alert`), cột `Max pt`, rồi một cột cho mỗi đội: điểm kèm dấu tích khi đã chấm, `WORKING` khi đang làm, ✕ khi chưa làm. Dòng `TOTAL` cộng điểm từng đội.
- **MATCH EVENT**: các đợt backlog mới theo thời gian, mỗi đợt có nhãn (`FAULT-01`, `INCIDENT`, `PRESSURE`, `TWIST`, `FINALE`), tiêu đề và danh sách item mới, ví dụ `INCIDENT: Cảnh báo production khẩn cấp, New backlog items: PI-03`.
- **TEAM EVENT**: nhật ký theo giờ như `Team HNK started working on TASK-13`, `Team HNK submitted TASK-12`.

## 14. Tóm tắt: checklist cho Digital Project Team

- [ ] Đọc đề trên trang `/match/<match-id>`
- [ ] Start working để nhận template và MVS
- [ ] Test chặt hơn MVS, rồi submit một lần
- [ ] Theo dõi wave mới, ưu tiên PI ngay
- [ ] Canh deadline, nhớ: vào máy = −50 điểm

**Khi có tranh chấp:**

- Game Master là nguồn ghi nhận chính thức: giờ start và submit, kết quả `PASSED`/`FAILED`, số lần vào máy.
- Đội khiếu nại trong phần tổng kết. Ban Giám khảo quyết định cuối cùng.
