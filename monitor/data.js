// DỮ LIỆU MẪU cho monitor.
// Khi có orchestrator thật: xuất state ra đúng cấu trúc này (xem README.md).
// Dùng file .js (không phải .json) để mở index.html trực tiếp bằng file:// vẫn đọc được.

window.MONITOR_DATA = {
  meta: {
    project: "Master the Machine 2026",
    repo: "order-service (Spring Boot)",
    sample: true,
    clock: "10:30",
    maxAttempts: 3,
    tokenBudget: 400000,
    confidenceThreshold: 0.7,
    evalTarget: 70
  },

  evalRuns: [
    { version: "v0.1", passed: 16, total: 50, note: "Baseline: 1 prompt, chưa reproduce" },
    { version: "v0.2", passed: 19, total: 50, note: "Thêm CodeGraph symbol search" },
    { version: "v0.3", passed: 21, total: 50, note: "Bắt buộc failing test trước khi fix" },
    { version: "v0.4", passed: 25, total: 50, note: "Impact analysis chọn regression test" },
    { version: "v0.5", passed: 27, total: 50, note: "Đưa log lỗi gate vào re-plan" },
    { version: "v0.6", passed: 26, total: 50, note: "Đổi model bước plan (giảm nhẹ)" },
    { version: "v0.7", passed: 31, total: 50, note: "Parse Spring config bù cạnh DI" },
    { version: "v0.8", passed: 34, total: 50, note: "Thêm reviewer agent độc lập" }
  ],

  tickets: [
    {
      id: "BUG-101", type: "BUG", priority: "P1",
      title: "Tổng tiền sai khi áp 2 mã giảm giá liên tiếp",
      stage: "review", agent: "Bug Agent", confidence: 0.93,
      attempts: 1, tokens: 148000, minutes: 11, branch: "agent/BUG-101",
      gate: { build: "pass", unit: "pass", regression: "pass", coverage: "pass", lint: "pass", scan: "pass", diff: "pass", reviewer: "pass" },
      impact: ["order/PricingService.java", "order/DiscountPolicy.java", "test/order/PricingServiceTest.java"],
      pr: {
        number: 47,
        rootCause: "DiscountPolicy.apply() tính trên giá gốc thay vì giá sau lần giảm trước, nên mã thứ hai bị trừ trùng.",
        fix: "Áp mã tuần tự trên subtotal hiện tại, giới hạn tổng giảm không vượt subtotal.",
        rejected: "Chặn áp mã thứ hai: thay đổi nghiệp vụ, ngoài phạm vi ticket.",
        tests: "Thêm 3 test. 214/214 unit pass, 38 test regression vùng impact pass."
      },
      trace: [
        { t: "09:12", step: "Triage", msg: "JEV phân loại Bug, confidence 0.93", s: "ok" },
        { t: "09:13", step: "Analyze", tool: "CodeGraph", msg: "symbol_search applyDiscount: 3 call site", s: "ok" },
        { t: "09:15", step: "Reproduce", tool: "Sandbox", msg: "PricingServiceTest#twoCoupons FAIL (đúng kỳ vọng)", s: "ok" },
        { t: "09:17", step: "Plan", msg: "Sửa DiscountPolicy.apply, giữ nguyên API public", s: "ok" },
        { t: "09:19", step: "Fix", tool: "Sandbox", msg: "Diff +24 −9 trên 2 file", s: "ok" },
        { t: "09:22", step: "Gate", msg: "8/8 check pass", s: "ok" },
        { t: "09:23", step: "PR", tool: "Git", msg: "Tạo PR #47, cập nhật ticket", s: "ok" }
      ]
    },
    {
      id: "BUG-102", type: "BUG", priority: "P1",
      title: "NullPointerException khi xuất báo cáo tháng không có đơn",
      stage: "gate", agent: "Bug Agent", confidence: 0.88,
      attempts: 2, tokens: 236000, minutes: 19, branch: "agent/BUG-102",
      linked: ["ISSUE-402"],
      gate: { build: "pass", unit: "pass", regression: "run", coverage: "pending", lint: "pending", scan: "pending", diff: "pass", reviewer: "pending" },
      impact: ["report/ReportService.java", "report/ReportController.java", "report/ReportExporter.java"],
      trace: [
        { t: "09:41", step: "Triage", msg: "JEV phân loại Bug, confidence 0.88", s: "ok" },
        { t: "09:43", step: "Analyze", tool: "CodeGraph", msg: "impact: ReportController → ReportService → OrderRepository", s: "ok" },
        { t: "09:46", step: "Reproduce", tool: "Sandbox", msg: "ReportServiceTest#emptyMonth FAIL (đúng kỳ vọng)", s: "ok" },
        { t: "09:49", step: "Fix", tool: "Sandbox", msg: "Trả về null khi không có dữ liệu", s: "ok" },
        { t: "09:52", step: "Gate", msg: "Unit test: ReportExportTest#header FAIL, header null", s: "fail" },
        { t: "09:53", step: "Re-plan", msg: "Đưa log lỗi vào plan, lần thử 2/3", s: "warn" },
        { t: "09:58", step: "Fix", tool: "Sandbox", msg: "Trả Optional.empty(), exporter vẫn ghi header", s: "ok" },
        { t: "10:01", step: "Gate", msg: "Đang chạy regression vùng impact (41 test)", s: "run" }
      ]
    },
    {
      id: "BUG-103", type: "BUG", priority: "P2",
      title: "Phân trang trả về bản ghi trùng ở trang cuối",
      stage: "agent", phase: "Reproduce", agent: "Bug Agent", confidence: 0.9,
      attempts: 1, tokens: 61000, minutes: 6, branch: "agent/BUG-103",
      impact: ["order/OrderQueryService.java", "order/OrderRepository.java"],
      trace: [
        { t: "10:18", step: "Triage", msg: "JEV phân loại Bug, confidence 0.90", s: "ok" },
        { t: "10:20", step: "Analyze", tool: "CodeGraph", msg: "findPage() sort theo createdAt, không có khóa phụ", s: "ok" },
        { t: "10:24", step: "Reproduce", tool: "Sandbox", msg: "Seed 25 đơn trùng createdAt, chạy test", s: "run" }
      ]
    },
    {
      id: "BUG-104", type: "BUG", priority: "P2",
      title: "Ngày sinh lệch 1 ngày sau khi lưu",
      stage: "escalated", agent: "Bug Agent", confidence: 0.86,
      attempts: 1, tokens: 97000, minutes: 9, branch: "agent/BUG-104",
      reason: "Không reproduce được trong sandbox (TZ=UTC). Cần timezone và phiên bản JDK của môi trường production.",
      impact: ["customer/CustomerMapper.java", "config/JacksonConfig.java"],
      trace: [
        { t: "09:30", step: "Triage", msg: "JEV phân loại Bug, confidence 0.86", s: "ok" },
        { t: "09:32", step: "Analyze", tool: "CodeGraph", msg: "LocalDate đi qua JacksonConfig và CustomerMapper", s: "ok" },
        { t: "09:35", step: "Reproduce", tool: "Sandbox", msg: "CustomerMapperTest#birthDate PASS, không tái hiện lỗi", s: "fail" },
        { t: "09:37", step: "Reproduce", tool: "Sandbox", msg: "Thử TZ=Asia/Saigon: vẫn PASS", s: "fail" },
        { t: "09:38", step: "Escalate", msg: "Chuyển người: thiếu thông tin môi trường", s: "warn" }
      ]
    },
    {
      id: "BUG-105", type: "BUG", priority: "P2",
      title: "Email xác nhận gửi 2 lần khi retry thanh toán",
      stage: "done", agent: "Bug Agent", confidence: 0.91,
      attempts: 1, tokens: 121000, minutes: 10, branch: "agent/BUG-105",
      note: "Đã merge PR #44",
      gate: { build: "pass", unit: "pass", regression: "pass", coverage: "pass", lint: "pass", scan: "pass", diff: "pass", reviewer: "pass" },
      impact: ["payment/PaymentRetryHandler.java", "notify/OrderMailer.java"],
      pr: {
        number: 44,
        rootCause: "Sự kiện PaymentSucceeded được publish ở cả lần thử đầu và lần retry.",
        fix: "Thêm idempotency key theo orderId cho OrderMailer.",
        rejected: "Bỏ retry thanh toán: ảnh hưởng tỉ lệ thanh toán thành công.",
        tests: "Thêm 2 test. 211/211 unit pass."
      },
      trace: [
        { t: "08:40", step: "Triage", msg: "JEV phân loại Bug, confidence 0.91", s: "ok" },
        { t: "08:44", step: "Reproduce", tool: "Sandbox", msg: "PaymentRetryTest#mailOnce FAIL (đúng kỳ vọng)", s: "ok" },
        { t: "08:50", step: "Gate", msg: "8/8 check pass", s: "ok" },
        { t: "08:51", step: "PR", tool: "Git", msg: "Tạo PR #44", s: "ok" },
        { t: "09:05", step: "Merge", msg: "Reviewer duyệt, đã merge", s: "ok" }
      ]
    },
    {
      id: "BUG-106", type: "BUG", priority: "P3",
      title: "Sai định dạng số điện thoại khi import CSV",
      stage: "backlog", trace: []
    },
    {
      id: "CR-201", type: "CR", priority: "P2",
      title: "Thêm bộ lọc theo trạng thái cho danh sách đơn hàng",
      stage: "agent", phase: "Plan", agent: "CR Agent", confidence: 0.91,
      attempts: 1, tokens: 88000, minutes: 8, branch: "agent/CR-201",
      impact: ["order/OrderController.java", "order/OrderQueryService.java", "order/OrderSpecification.java"],
      trace: [
        { t: "10:05", step: "Triage", msg: "JEV phân loại CR, confidence 0.91", s: "ok" },
        { t: "10:08", step: "Clarify", msg: "Yêu cầu đủ rõ: lọc theo 1 hoặc nhiều trạng thái", s: "ok" },
        { t: "10:12", step: "Analyze", tool: "CodeGraph", msg: "Đã có OrderSpecification, mở rộng thay vì viết mới", s: "ok" },
        { t: "10:15", step: "Plan", msg: "Thêm tham số status[] vào GET /api/orders", s: "run" }
      ]
    },
    {
      id: "CR-202", type: "CR", priority: "P3",
      title: "Cho phép xuất danh sách khách hàng",
      stage: "escalated", agent: "CR Agent", confidence: 0.82,
      attempts: 0, tokens: 23000, minutes: 3,
      reason: "Yêu cầu mơ hồ: chưa rõ định dạng (CSV hay Excel) và các cột cần xuất. Agent đã gửi câu hỏi làm rõ vào ticket.",
      trace: [
        { t: "09:55", step: "Triage", msg: "JEV phân loại CR, confidence 0.82", s: "ok" },
        { t: "09:57", step: "Clarify", msg: "Thiếu định dạng và danh sách cột", s: "warn" },
        { t: "09:58", step: "Escalate", msg: "Gửi 2 câu hỏi làm rõ, chờ người trả lời", s: "warn" }
      ]
    },
    {
      id: "CR-203", type: "CR", priority: "P3",
      title: "Đổi thông báo lỗi đăng nhập sang tiếng Việt",
      stage: "backlog", trace: []
    },
    {
      id: "SEC-301", type: "SEC", priority: "P1",
      title: "SQL injection ở endpoint /api/orders/search",
      stage: "agent", phase: "Fix", agent: "Security Agent", confidence: 0.97,
      attempts: 2, tokens: 172000, minutes: 15, branch: "agent/SEC-301",
      gate: { build: "pass", unit: "pass", regression: "pass", coverage: "pass", lint: "pass", scan: "fail", diff: "pass", reviewer: "skip" },
      impact: ["order/OrderSearchRepository.java", "order/OrderSearchController.java"],
      trace: [
        { t: "09:48", step: "Triage", msg: "JEV phân loại Security, confidence 0.97", s: "ok" },
        { t: "09:49", step: "Scan", tool: "SAST", msg: "1 finding HIGH: nối chuỗi SQL tại OrderSearchRepository:58", s: "ok" },
        { t: "09:52", step: "Fix", tool: "Sandbox", msg: "Chuyển keyword sang tham số bind", s: "ok" },
        { t: "09:56", step: "Gate", msg: "Security scan: còn 1 finding ở tham số sortBy", s: "fail" },
        { t: "09:57", step: "Re-plan", msg: "Đưa kết quả scan vào plan, lần thử 2/3", s: "warn" },
        { t: "10:02", step: "Fix", tool: "Sandbox", msg: "Whitelist cột sortBy", s: "run" }
      ]
    },
    {
      id: "SEC-302", type: "SEC", priority: "P1",
      title: "jackson-databind có CVE mức High",
      stage: "done", agent: "Security Agent", confidence: 0.99,
      attempts: 1, tokens: 54000, minutes: 5, branch: "agent/SEC-302",
      note: "Đã merge PR #45",
      gate: { build: "pass", unit: "pass", regression: "pass", coverage: "pass", lint: "pass", scan: "pass", diff: "pass", reviewer: "pass" },
      impact: ["pom.xml"],
      pr: {
        number: 45,
        rootCause: "SCA phát hiện jackson-databind 2.13.2 có CVE mức High.",
        fix: "Nâng lên bản vá cùng nhánh minor, không đổi API.",
        rejected: "Nâng major version: rủi ro breaking change.",
        tests: "211/211 unit pass, scan sạch."
      },
      trace: [
        { t: "08:20", step: "Scan", tool: "SCA", msg: "1 dependency có CVE mức High", s: "ok" },
        { t: "08:23", step: "Fix", tool: "Sandbox", msg: "Nâng version trong pom.xml", s: "ok" },
        { t: "08:27", step: "Gate", msg: "8/8 check pass", s: "ok" },
        { t: "08:28", step: "PR", tool: "Git", msg: "Tạo PR #45", s: "ok" },
        { t: "08:45", step: "Merge", msg: "Reviewer duyệt, đã merge", s: "ok" }
      ]
    },
    {
      id: "ISSUE-401", type: "ISSUE", priority: "P2",
      title: "API /reports chậm hơn 5 giây giờ cao điểm",
      stage: "triage", confidence: 0.48,
      trace: [
        { t: "10:26", step: "Triage", msg: "JEV đang phân loại: Bug hay Performance?", s: "run" }
      ]
    },
    {
      id: "ISSUE-402", type: "ISSUE", priority: "P2",
      title: "Báo cáo tháng 9 xuất ra trang trắng",
      stage: "triage", confidence: 0.84,
      trace: [
        { t: "10:27", step: "Triage", msg: "JEV kiểm tra trùng lặp với ticket đang mở", s: "run" }
      ]
    }
  ]
};
