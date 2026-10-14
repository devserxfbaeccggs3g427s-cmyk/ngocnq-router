# Phase A — Requirements

**Trạng thái:** Bản nháp để review, chưa phê duyệt triển khai.  
**Nguồn phạm vi:** [`docs/ROADMAP.md`](../../../ROADMAP.md), mục “Giai đoạn A — P0”.  
**Tài liệu cùng bộ:** [Design](design.md) · [Tasks](tasks.md).

## Mục tiêu và ranh giới

Coding agent có thể xem một tác vụ đã dùng những upstream attempt nào, tốn bao nhiêu (với độ phủ giá rõ ràng), lỗi ở đâu và combo opt-in đã chọn model theo tín hiệu nào. Vẫn giữ nguyên request/response của `/v1/*`, vận hành local-first, một người dùng và SQLite. “Hoàn thành” nghĩa là có kiểm thử hành vi tương ứng, không phải chỉ có schema, API hay hàm thuần.

**P0** = điều kiện bắt buộc trước cổng Phase A; **P1** = phần bổ trợ trong Phase A, không được làm chậm hoặc làm sai P0. Tất cả yêu cầu dưới đây cần được đáp ứng để tuyên bố Phase A hoàn tất trừ khi ghi rõ là P1.

**Không thuộc Phase A:** Project Workspace và chính sách dự án nâng cao; personalization/benchmark tự động; prompt management; agent orchestrator; workflow/MCP hub; hard budget limit, chuyển model vì ngân sách, hay health check bằng inference tự động. Không đổi cơ chế xác thực hoặc cách gửi prompt tới provider hiện hữu. Benchmark với provider thật chỉ do người dùng khởi chạy thủ công sau khi chấp nhận chi phí.

## Yêu cầu có thể nghiệm thu

### Tracing — roadmap (5)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| TR-01 | P0 | Mỗi request inference hợp lệ đi vào routing có đúng một `requestId` UUID và trace cha; mỗi model-inference dispatch thực tế có một `attemptId` UUID riêng (kể cả executor tự retry nội bộ) liên kết tới cha. Retry sau refresh, chuyển account, chuyển model, từng fusion panel/judge đều đếm đủ; request không chạm upstream có 0 attempt và trạng thái kết thúc rõ ràng. |
| TR-02 | P0 | Trace/attempt ghi đường đi model, provider, account ID nội bộ, combo/fallback, thời điểm, TTFT nếu đo được, duration, trạng thái/HTTP status và mã lý do **allowlist**. Non-stream trả kết quả sau khi xử lý xong; stream chỉ success khi tiêu thụ hoàn tất, lỗi/abort cập nhật terminal; callback trùng không tạo lần ghi thứ hai. |
| TR-03 | P0 | `x-9router-task-id` và `x-9router-agent-label` là nhãn tùy chọn, giới hạn định dạng/độ dài; header sai bị bỏ qua, không làm hỏng inference. Nhãn không phải định danh xác thực. Không ghi payload, raw header, raw API key/OAuth token, prompt, output hoặc token chuỗi vào trace. **Counter số** về usage chỉ ở kho usage riêng; detail có thể ghép để hiển thị. |
| TR-04 | P0 | Tracing lỗi (DB, hook, serialization) không thay đổi response inference; quan sát được cảnh báo đã làm sạch, trace dang dở được phục hồi/đánh dấu thiếu số liệu thay vì khẳng định success. Những request bị auth/access từ chối không lộ metadata cho chủ thể khác. |

### Chi phí & phân tích usage — roadmap (2), (3)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| UA-01 | P0 | Tối đa một `usageHistory` row và một lần tăng aggregate cho mỗi `attemptId`, kể cả retry hook/terminal callback lặp. Usage của mọi attempt thực sự có phí được tính kể cả khi request cha cuối cùng lỗi hoặc fusion không dùng câu trả lời đó. Không ghi lần hai qua đường `saveUsageStats` hiện hữu. |
| UA-02 | P0 | Chuẩn hóa counter số `prompt`, `completion`, cache, reasoning theo một quy tắc; `tokenSource` = `upstream` / `estimated` / `unknown`. Dùng một công thức giá `calculateCost()`; `costStatus` = `known` / `estimated` / `unknown`, `cost=null` khi không đủ usage/price; chỉ giá 0 được khai báo rõ mới là $0. Các phép cộng tiền phải nêu phần đã định giá và tỷ lệ thiếu, không gán unknown thành miễn phí. |
| UA-03 | P0 | Có tổng theo thời gian, provider/model, API key ID, project ID tin cậy, task ID và agent label; đếm request cha riêng khỏi upstream attempt. Có lỗi, p50/p95 duration/TTFT khi đủ mẫu, tổng chi phí tác vụ và chi phí từng attempt. Filter chung của dashboard dùng cùng khoảng thời gian/timezone và cùng định nghĩa số liệu cho KPI/chart/table. |
| UA-04 | P0 | Có kiểm tra đối soát cho dữ liệu mới: số attempt có usage row, tổng counter và known-cost subtotal từng attempt khớp với aggregate trong khoảng tương ứng; chênh lệch và `unknown` được báo rõ. Dữ liệu lịch sử thiếu ID/giá không được tự suy ra chính xác hoặc gán project chỉ từ raw header. |

### Ngân sách & quota — roadmap (4)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| BQ-01 | P0 | Cấu hình USD ngày/tháng ở scope `global` hoặc `project` được gắn trên API key đã xác thực; mặc định tắt. Mốc ngày/tháng là UTC, được gắn nhãn rõ khi hiển thị; thay đổi budget không chặn request, không buộc fallback và không đổi model. API-key ID là chiều lọc usage, **chưa có limit theo từng API key** trong Phase A. |
| BQ-02 | P0 | Mỗi ngưỡng cấu hình (mặc định 50/80/100%) phát cảnh báo bền vững tối đa một lần mỗi scope/ID/kỳ/ngưỡng, kể cả khi ghi usage lặp hoặc request đồng thời; đọc lại không tạo thông báo mới. Cảnh báo nêu subtotal đã biết/ước tính và mức độ thiếu dữ liệu; không cam kết số tiền là hóa đơn provider. `enabled` lấy từ settings, không suy từ số alerts. |
| BQ-03 | P0 | Nếu upstream không cung cấp quota/usage, dashboard phải ghi “Không rõ” và thời điểm kiểm tra/cache; không biến thành “còn 0” hay “không giới hạn”. Không tự chạy inference để điền quota. |

### Provider management — roadmap (6)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| PM-01 | P0 | Danh sách account hiển thị trạng thái disabled/cooldown/error/degraded/healthy/unknown có nhãn chữ, thời điểm dữ liệu, cooldown còn lại, lỗi đã redacted, quota/usage cached nếu có. Không hiện credential hay nhãn account nhạy cảm chưa làm sạch. |
| PM-02 | P0 | Chỉ dùng trạng thái sẵn có và quota cached/endpoint không tính phí đã có; thao tác liệt kê/xem dashboard không tự gửi inference thử. Nếu người dùng chủ động dùng probe/ping có phí, cần cảnh báo và hành động riêng. |

### Smart combo routing — roadmap (1)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| SR-01 | P0 | Mặc định giữ chiến lược routing hiện hành. Chỉ combo được bật opt-in mới xếp hạng; direct model, fusion, round-robin, capacity-adapter và combo không bật opt-in giữ hành vi hiện tại, trừ yêu cầu an toàn modality/allowlist. Bật/tắt có thể rollback trong settings. |
| SR-02 | P0 | Danh sách ứng viên chỉ gồm thành viên combo đã khai báo: restricted key được quyền gọi combo thì được dùng các thành viên **qua combo**, không có quyền gọi trực tiếp thành viên ngoài allowlist; judge ngoài combo cần kiểm tra quyền riêng. Một model thiếu bất kỳ modality bắt buộc (`vision`, `pdf`, `audioInput`, `videoInput`) không được thử qua smart fallback; nếu không còn model phù hợp thì trả lỗi xác định **trước** khi gọi upstream. Không cho capacity adapter chèn model ngoài quyền. |
| SR-03 | P0 | Xếp hạng có giải thích: capability/request signal an toàn, health cached, success rate, p95 duration và USD/1k token cùng khoảng lấy mẫu/độ tin cậy. Thiếu/sai/cũ metric hoặc chưa đủ mẫu cho ứng viên có thể so sánh thì giữ thứ tự combo gốc; unknown cost không được thưởng như model miễn phí. Tie giữ thứ tự gốc; không lưu prompt để giải thích. |
| SR-04 | P1 | So sánh opt-in với thứ tự cố định trên cùng tập tác vụ coding được kiểm soát, theo chi phí/tác vụ **hoàn tất**, tỷ lệ hoàn tất và latency; không bật mặc định khi chất lượng giảm. Không tự phát sinh request provider cho phép đo này. |

### Bảo mật và tương thích — xuyên suốt

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| SEC-01 | P0 | Management API/trace/alert dùng dashboard auth hiện hữu, deny-by-default; inference `/v1/*` giữ auth/key allowlist hiện hữu. `apiKeyId`/`projectId` chỉ từ cùng key **active** đã được middleware/handler xác thực và cấu hình được bảo vệ, không tin project/header tự xưng; khi local-no-key hoặc key không hợp lệ được phép ở local mode, cả `apiKeyId` và `projectId` đều `null`. Truy vấn/filter không trả raw key hay provider secret. |
| SEC-02 | P0 | Trace/API/log mới chỉ có metadata allowlist; sanitize dữ liệu lỗi và label, validate query/pagination, không đưa URL có credentials, payload hay token chuỗi vào JSON/log. Không thay `custom-server.js` về TCP IP/X-Forwarded-For và không thêm đường SSRF/probe URL tùy ý. Debug/request-detail hiện có có thể chứa payload phải được đánh dấu tách biệt, không bị trace bật ngầm. |
| SEC-03 | P0 | Migration SQLite additive, backup/version đúng cơ chế hiện có; restart/adapter fallback không nhân usage hay mất cảnh báo; `/v1/*` response/stream không thay hình dạng. Kiểm thử offline và so với regression baseline hiện có; các known failures được báo riêng. |

## Cổng hoàn thành Phase A

1. Test hành vi đáp ứng các ID P0 và UI security/accessibility; không dùng placeholder `expect(true)` làm bằng chứng.
2. Chạy một mẫu tác vụ coding thực tế **theo yêu cầu của người dùng**, sau khi xác nhận việc gọi provider có thể tốn phí. Đối chiếu từng attempt với usage/tổng theo cùng khoảng thời gian và công bố tỷ lệ `unknown` (không yêu cầu một con số tùy ý để che thiếu dữ liệu).
3. So sánh combo opt-in với thứ tự cố định trên tập tác vụ đó: chi phí/tác vụ hoàn tất, tỷ lệ hoàn tất, p95 latency và chất lượng đầu ra được người dùng đánh giá. Không bật mặc định nếu chất lượng giảm.
4. Rà bảo mật: API auth, key/project attribution, redaction, IP/proxy/SSRF và không có provider probe tự động. Ghi giới hạn số liệu/giá ước lượng công khai trong dashboard.
