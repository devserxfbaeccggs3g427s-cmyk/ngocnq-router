# Lộ trình 9Router cá nhân

Mục tiêu: coding agent thấy mỗi tác vụ tiêu gì, lỗi ở đâu và chọn model phù hợp mà không đổi hợp đồng `/v1/*`. Ưu tiên local-first, một người dùng, dùng SQLite và giao diện hiện có. Ngân sách giai đoạn đầu **chỉ cảnh báo**, không chặn hoặc tự đổi model.

## Giai đoạn A — P0: đo trước, tối ưu sau

Đang triển khai; từng mục chỉ coi là hoàn tất khi kiểm thử tương ứng đạt.

1. **Request Tracing (5):** request và từng upstream attempt có ID nội bộ; liên kết task ID tùy chọn, account/model/fallback, TTFT, thời gian, trạng thái. Mặc định chỉ giữ metadata; không lưu prompt, output, token hay header trong trace.
2. **Cost Intelligence (2) + Usage Analytics (3):** chi phí theo attempt (gồm retry và fusion), phân biệt giá/token đã biết, ước tính và chưa biết. Tổng hợp theo thời gian, provider/model, API key/dự án cục bộ, tác vụ và agent label; lỗi, p50/p95, chi phí mỗi tác vụ. Thiếu giá không có nghĩa miễn phí.
3. **Budget & Quota (4):** ngân sách USD ngày/tháng, toàn cục hoặc theo dự án đã cấu hình trên API key; một cảnh báo cho mỗi ngưỡng trong mỗi kỳ. Quota không lấy được phải hiện “không rõ”. Không có giới hạn cứng.
4. **Provider Management (6):** tình trạng account, lần kiểm tra, lỗi, cooldown, quota/usage nếu upstream cung cấp. Không tự chạy inference thử tốn phí.
5. **Smart Model Routing (1):** chỉ combo bật opt-in; xếp các model được cho phép bằng capability bắt buộc, health, chi phí, p95 latency và tín hiệu request minh bạch. Thiếu dữ liệu giữ thứ tự gốc; fallback không chọn model ngoài allowlist hoặc model thiếu modality.

Cổng sang P1: kiểm tra mẫu tác vụ coding thực tế; đối chiếu token/chi phí từng attempt với tổng và tỷ lệ unknown. So sánh routing opt-in với thứ tự cố định về chi phí trên tác vụ hoàn tất, tỷ lệ hoàn tất và latency. Không bật mặc định nếu chất lượng giảm.

## Giai đoạn B — P1: cá nhân hóa sau khi P0 ổn

Chưa triển khai.

6. **Project Workspace (7):** nhóm key thành dự án/môi trường local, combo mặc định và ngân sách; dự án lấy từ key đã gắn, không từ header tự xưng.
7. **Personalization Engine (8):** vài sở thích tường minh theo dự án; không suy diễn hồ sơ hành vi ngầm.
8. **Prompt Management (9):** template có phiên bản và biến được kiểm tra; không tự chèn vào request hiện hữu.
9. **Model Benchmark (10):** 10–20 tác vụ coding đại diện, chỉ chạy thủ công sau khi duyệt chi phí.
10. **Task Intelligence (12):** mở rộng luật phân loại khi benchmark chứng minh hữu ích; chia nhỏ tác vụ ngoài luồng `/v1/*`.
11. **Context Optimization (13):** đo hiệu quả và lỗi của RTK/headroom trước khi thêm chính sách; không cắt tool result lỗi.
12. **Agent Orchestrator (11):** trước hết gắn nhãn coding agent bên ngoài; chỉ xây điều phối khi có nhu cầu cụ thể, có giới hạn quyền, nhánh, timeout và chi phí.

Cổng sang P2: benchmark lặp lại cho thấy lợi ích rõ ràng; kiểm tra quyền công cụ và tổng chi phí của mọi nhánh.

## Giai đoạn C — P2: mở rộng khi cần

Chưa triển khai.

13. **Workflow Automation (14):** một vài quy trình cố định, retry và phê duyệt thao tác ghi; chưa xây canvas.
14. **Evaluation & Learning (15):** feedback thủ công theo task ID, so với benchmark; thay trọng số routing có thể rollback, không tự học từ request count.
15. **Plugin & MCP Hub (16):** tái dùng bridge MCP preset, quản lý trạng thái và quyền; không nhận command hoặc URL nội bộ tùy ý.

## Nguyên tắc bảo mật

API key và dự án chỉ được gắn từ cấu hình tin cậy; nhãn tác vụ không là xác thực. Dashboard/API bảo vệ truy cập, header IP chỉ tin reverse proxy loopback. Không để log/trace mới lộ prompt, credential hay token; debug logging payload đầy đủ phải được đánh dấu riêng và chỉ bật có chủ đích. Không tự động gọi provider thật để đo health hoặc benchmark.
