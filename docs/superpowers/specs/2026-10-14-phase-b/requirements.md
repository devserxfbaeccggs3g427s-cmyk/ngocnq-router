# Phase B — Requirements

**Trạng thái:** Bản nháp để review, chưa phê duyệt triển khai.
**Nguồn phạm vi:** [`docs/ROADMAP.md`](../../../ROADMAP.md), mục “Giai đoạn B — P1”.
**Tài liệu cùng bộ:** [Design](design.md) · [Tasks](tasks.md).
**Bộ trước:** [`../2026-10-13-phase-a/`](../2026-10-13-phase-a/requirements.md) — Phase A đo trước, Phase B tối ưu sau.

## Mục tiêu và ranh giới

Coding agent chạy nhiều dự án cục bộ thì cần: gom key theo dự án, đặt combo mặc định và ngân sách riêng cho từng dự án; có template prompt có phiên bản để tái dùng mà không đụng request đang chạy; đo được model nào rẻ và nhanh với **tập tác vụ coding thật**; và chỉ mở rộng phân loại tác vụ / điều phối agent khi **bằng chứng đo** nói đáng làm. Vẫn giữ nguyên hợp đồng `/v1/*`, vận hành local-first, một người dùng, SQLite. “Hoàn thành” nghĩa là có kiểm thử hành vi tương ứng, không phải chỉ có schema, API hay hàm thuần.

**P0** = điều kiện bắt buộc trước cổng Phase B; **P1** = phần bổ trợ trong Phase B, không được làm chậm hoặc làm sai P0.

**Nhãn [MỞ]:** roadmap nói rõ ba mục (10, 11, 12) chỉ nên làm khi có bằng chứng hoặc nhu cầu cụ thể. Phase B này **phủ đủ cả 7 mục**, nhưng mọi requirement gắn **[MỞ]** phải được mở bằng đúng bằng chứng mà nó nêu trước khi task tương ứng bắt đầu. Đây là điều kiện nghiệm thu, không phải lời hoãn: không mở được thì mục đó được ghi là **chưa đủ điều kiện** ở cổng, chứ không được làm cho xong.

### Kế thừa bắt buộc từ Phase A

Phase B đo chi phí, hiệu quả context và benchmark chỉ đáng tin nếu số liệu Phase A là số thật. Ba khoảng trống đã ghi ở [`phase-a/tasks.md`](../2026-10-13-phase-a/tasks.md) phải được xử lý như điều kiện nền, không phải như việc phụ.

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| BD-01 | P0 | **K1 — executor retry nội bộ làm thiếu tiền thật.** `codex.js` tự retry ở tầng SSE, `commandcode.js` có `maxRetries = 2` hardcode, `mimo-free.js` bỏ qua `base.execute` và tự fetch lại khi 401, `xiaomi-mimo.js` gọi `super.execute` lần hai — mỗi lần gửi là một lần inference tính phí nhưng chỉ sinh **một** attempt. Phase B phải định nghĩa lại “dispatch” cho các executor này sao cho **mỗi POST có tính phí = một attempt** (hoặc một attempt mang `dispatchCount > 1` và usage cộng đủ), và chi phí phải khớp provider. Chấp nhận mọi đánh giá chi phí của Phase B chỉ khi khoảng cách này được đo và công bố. |
| BD-02 | P0 | **T12 chưa chạy provider thật.** Chưa có một mẫu tác vụ coding nào đối chiếu token/chi phí từng attempt với hóa đơn provider. Benchmark của Phase B phải bắt đầu bằng bước này; không có nó thì mọi so sánh model là so trên giả định. |
| BD-03 | P0 | **Attribution hụt ở 3 endpoint.** `embeddings.js`, `imageGeneration.js`, `systemone.js` gọi `saveRequestUsage()` chỉ với raw `apiKey`, không có `apiKeyId`/`projectId` → các dòng đó **không bao giờ** chạm ngân sách theo dự án và rơi vào nhóm unattributed. Phase B phải ghi attribution cho chúng hoặc công bố rõ là ngoài phạm vi project; không được âm thầm coi là $0. |

**Không thuộc Phase B:** Workflow Automation, Evaluation & Learning có trọng số tự học, Plugin & MCP Hub (đó là Giai đoạn C). Không đổi cơ chế xác thực, không mở rộng hợp đồng `/v1/*`, không thêm hard budget limit toàn cục. Không suy diễn hồ sơ người dùng từ lịch sử request. Benchmark với provider thật chỉ chạy khi người dùng ký duyệt chi phí cho từng lần chạy.

## Yêu cầu có thể nghiệm thu

### Nền tảng kế thừa — roadmap (không có mục riêng)

Xem bảng **BD-01..03** ở mục trên. Ba mục này là tiền đề của mọi bảng dưới đây.

### Project Workspace — roadmap (7)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| PW-01 | P0 | Dự án trở thành **thực thể hạng nhất** có `id` riêng, nhưng `id` **giữ nguyên** giá trị `apiKeys.projectId` đang dùng để gán — không viết lại lịch sử. Migration backfill từ các `projectId` khác nhau đang tồn tại; key đã gắn vẫn trỏ đúng dự án; key không gắn vẫn `projectId = null` và không bị gán nhầm. Gán/gỡ dự án chỉ qua API dashboard, **không** qua header inference. |
| PW-02 | P0 | Dự án mang **combo mặc định** và **không gian cấu hình riêng** với shape đóng: key lạ bị **từ chối** (không bỏ qua im lặng). Cấu hình dự án chỉ đổi **default**, không được mở rộng allowlist của key, không đổi auth, không ép chuyển model khi key không được phép gọi model đó. Không có dự án ⇒ hành vi hiện tại giữ nguyên. |
| PW-03 | P0 | Ngân sách theo dự án đọc từ cấu hình dự án nhưng giữ nguyên ngữ nghĩa Phase A: mốc **UTC**, tối đa một cảnh báo mỗi ngưỡng/kỳ/scope, chỉ cảnh báo — **không** chặn request, không đổi model. Hạng mục ngân sách cũ vẫn đọc được sau khi dự án thành thực thể; dự án bị xoá mềm không làm mất cảnh báo đã phát. |
| PW-04 | P0 | Dashboard có màn tạo/đổi tên/lịch sử/xoá mềm dự án, gán-gỡ key, xem thành viên, xem ngân sách và combo mặc định. Cùng một giá trị `projectId` trên nhiều key hiện mang nhiều `projectLabel` khác nhau và **không có gì buộc chúng khớp** — UI phải phản ánh đúng hiện trạng hoặc Phase B phải thống nhất, không được hiển thị một nhãn cho các key mang nhãn khác nhau. |
| PW-05 | P0 | Request local/no-key hoặc key không hợp lệ (`getKeyAccessContext()` trả `null`) có `projectId = null` và chỉ thuộc scope `global`; không được rơi vào một dự án bất kỳ. Xoá một key không được làm đổi lịch sử `projectId` của các request đã ghi. |

### Personalization Engine — roadmap (8)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| PE-01 | P0 | Sở thích lưu **tường minh** theo dự án, shape đóng và mặc định tắt. Chỉ những sở thích có tên, giá trị và được bật/tắt tường minh mới có hiệu lực. Không có “điểm cá nhân hóa” ẩn. |
| PE-02 | P0 | Sở thích chỉ đặt **mặc định có thể hoàn tác**: combo/model ưu tiên, mức bật token saver, template prompt mặc định. Không được suy rộng quyền key, không được ép model ngoài allowlist, không được bỏ qua kiểm tra modality. Tắt sở thích ⇒ hành vi y như chưa có Phase B. |
| PE-03 | P0 | **Không suy diễn hồ sơ.** Không tính điểm từ lịch sử request, số lần gọi, khung giờ, model hay provider được dùng nhiều, hay thứ tự request. Không có cơ chế tự học, tự điều chỉnh trọng số, hay “gợi ý” sinh ra từ dữ liệu hành vi. Lịch sử chỉ được dùng để **hiển thị**, không để **quyết định**. |
| PE-04 | P1 | Khi một model được chọn nhờ sở thích, trace và UI phải ghi **tên sở thích + giá trị + nguồn cấu hình**, để người dùng biết quyết định đến từ cấu hình tường minh chứ không phải điểm số ẩn. |

### Prompt Management — roadmap (9)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| PT-01 | P0 | Template có **phiên bản bất biến**: sửa nội dung tạo phiên bản mới, phiên bản cũ giữ nguyên và vẫn resolve được. Có `templateId + version` ổn định; xoá template không xoá phiên bản đã dùng. |
| PT-02 | P0 | Biến phải **khai báo** (`name`, kiểu, mặc định, bắt buộc) và được kiểm tra cả lúc ghi lẫn lúc resolve: thiếu biến bắt buộc, thừa biến không khai báo, hoặc sai kiểu đều **từ chối có mã**, không âm thầm thay thế. Không `eval`, không thực thi mã, không nội suy ngoài ký hiệu `{{tên_biến}}`. |
| PT-03 | P0 | Template **không tự chèn** vào request đang chạy. Không có middleware/pipeline nào của `/v1/*` chèn template vào body. Cách dùng duy nhất là người dùng resolve rồi tự gửi; `/v1/*` không có header nào kích hoạt template. Bật template không được đổi một byte nào của request không liên quan. |
| PT-04 | P0 | Prompt tích hợp sẵn (`CAVEMAN_PROMPTS`, `PONYTAIL_PROMPTS`) được hiện **chỉ đọc** và import từ một nguồn duy nhất. Muốn tuỳ biến phải tạo template riêng, không sửa bản dựng sẵn. Level không hợp lệ hiện âm thầm **không làm gì** — Phase B phải trả lỗi có mã thay vì im lặng. |
| PT-05 | P0 | Nội dung template là **nội dung người dùng**: không được ghi vào trace/usage/log, không xuất hiện trong API chia sẻ. Một template có thể chứa bí mật của người dùng — coi nó như payload, không như metadata. |

### Model Benchmark — roadmap (10)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| BM-01 | P0 | Tập **10–20 tác vụ coding đại diện**, mỗi tác vụ có id ổn định, prompt fixture đóng gói, và **thang chấm điểm định nghĩa trước**. Tập tác vụ có phiên bản; đổi tác vụ hoặc đổi thang chấm phải tăng phiên bản, kết quả của mỗi phiên bản không trộn lẫn. |
| BM-02 | P0 | Chỉ chạy **thủ công**. Trước mỗi lần chạy phải hiện ước tính chi phí (số tác vụ × số model × giá trị cấu hình, ghi rõ phần chưa có giá là **không rõ**) và **cần xác nhận rõ ràng** của người dùng. Không có lịch tự động, không cron, không chạy nền, không tự chạy lại khi server khởi động. |
| BM-03 | P0 | Kết quả nối với trace/usage bằng `taskId` và báo cáo **subtotal đã định giá + độ phủ `unknown`**. `cost = null` là *chưa biết*, không phải `$0`; không bao giờ cộng `null` thành 0 trong tổng. Endpoint chưa trace phải được nêu đích danh, không để trong tổng như miễn phí. |
| BM-04 | P0 | Kết quả là **bất biến và truy vết được**: mỗi lần chạy lưu model, combo, cấu hình routing, token, chi phí, trạng thái và thời điểm. So sánh được giữa các lần chạy và giữa “thứ tự cố định” với “smart opt-in”. |
| BM-05 | P0 | Benchmark **không sửa cấu hình người dùng**: chạy với override riêng, không bật smart routing toàn cục, không sửa budget/combo mặc định. Kết thúc phải trả cấu hình về nguyên trạng kể cả khi chạy lỗi giữa chừng. |
| BM-06 | P1 | Kết quả chấm điểm của model do **người dùng đánh giá** phải được tách khỏi số liệu máy đo (chi phí, latency, tỷ lệ hoàn tất) trong báo cáo, không trộn thành một điểm duy nhất. |

### Context Optimization — roadmap (13)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| CX-01 | P0 | **Đo trước, chính sách sau.** Hiện số liệu RTK chỉ tồn tại ở `console.log`, không có mốc “trước” và không được lưu — không thể chứng minh saver làm việc hay làm hỏng. Phase B phải ghi lại theo attempt: số byte/token ước tính trước và sau, filter nào bắt, hình dạng nguồn, và lý do bỏ qua; theo đúng mẫu `pxpipe/events.jsonl` đã có sẵn. |
| CX-02 | P0 | Phân biệt **byte** với **token**. RTK hiện báo phần trăm theo byte, còn bộ ước lượng token là `chars/4` — **mù với CJK** (thiếu tối đa 4×) và chạy trên body **đã nén**, nên không thể khôi phục kích thước trước. Báo cáo hai con số riêng, ghi rõ cái nào là byte và cái nào là ước lượng. Không dùng ước lượng để khẳng định tiền tiết kiệm. |
| CX-03 | P0 | Dựng cơ chế phát hiện **tiết kiệm ảo** giống `isHeadroomPhantomSavings()`: nếu proxy/filter báo tiết kiệm nhưng JSON gửi đi co lại <5%, phải cảnh báo rõ thay vì ghi nhận. Headroom đã có, RTK chưa có — Phase B đưa RTK về ngang bằng. |
| CX-04 | P0 | **Không cắt tool result lỗi.** Bổ sung các lỗ hổng hiện có: các shape tool result kiểu OpenAI **không hề** kiểm tra lỗi; `is_error` được so sánh bằng `=== true` nên `"true"`/`1` lọt; và `headroom.js` chiếu **mọi** `toolResults` kể cả `status:"error"`, tức bật Headroom là **vô hiệu hoá** luôn lớp bảo vệ của RTK. Bất kỳ chính sách nén mới cũng phải đi qua cùng một cổng và không được đi vòng nó. |
| CX-05 | P0 | Lỗi phải **quan sát được**: mỗi lần saver bỏ qua vì lý do gì, filter nào hoảng, blob quá ngưỡng không nén — đều phải có mã và được đếm. `systemInject.js` hiện nuốt lỗi không log; im lặng không được đồng nghĩa với “không có gì xảy ra”. |
| CX-06 | P0 | Không thêm filter, ngưỡng hay chính sách cắt mới nếu chưa có số liệu trước/sau từ [CX-01]. Blob >10 MiB hiện **không** bao giờ bị nén nhưng vẫn được tính vào tổng trước — phải được ghi nhận đúng, không được báo là tiết kiệm 0 hay thành công. |

### Task Intelligence — roadmap (12)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| TI-01 | P0 **[MỞ]** | Luật phân loại chỉ được thêm khi **benchmark chứng minh hữu ích**. Mỗi luật phải trích dẫn bằng chứng cụ thể: trên tập nào, so với cấu hình nào, cải thiện bao nhiêu, và ở điều kiện nào thì hỏng. Luật không có bằng chứng thì không viết. |
| TI-02 | P0 | Hiện **không có** bất kỳ phân loại ngữ nghĩa nào — chỉ có dò modality (`detectRequiredCapabilities()`), và nó là **định dạng**, không phải ý định. Luật mới phải tách bạch khỏi modality: phân loại sai không được làm mất dữ liệu đầu vào, và phải tồn tại đường lùi về hành vi hiện tại khi không chắc. |
| TI-03 | P0 | Kết quả phân loại là **metadata tham khảo** (ghi vào trace, hiện ở UI) và **không** tự đổi routing. Muốn routing theo phân loại thì phải là opt-in rõ ràng, giống smart routing Phase A, và tắt được. |
| TI-04 | P0 | **Chia nhỏ tác vụ nằm ngoài luồng `/v1/*`**, qua endpoint dùng dashboard auth. Mọi lượt gọi con đều đi qua chính gateway nên được trace và ghi chi phí như bình thường — không có đường gọi provider nào đi vòng ledger. Endpoint nằm ngoài allow-list endpoint trace hiện tại nên phải được thêm vào allow-list một cách tường minh, không âm thầm. |
| TI-05 | P0 | Việc chia nhỏ bị **giới hạn chặt**: số tác vụ con tối đa, độ sâu tối đa, timeout toàn bộ, và **trần chi phí** cho mỗi lần chạy. Vượt trần thì dừng và báo, không tự cắt ngắn để tiết kiệm. |
| TI-06 | P1 | Chia nhỏ là thao tác **tường minh của người dùng**: không tự chạy theo lịch, không tự phát sinh từ việc đọc trace. |

### Agent Orchestrator — roadmap (11)

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| OR-01 | P0 | **Trước hết là gắn nhãn coding agent bên nài.** Hiện `x-9router-agent-label` chấp nhận **bất kỳ** chuỗi `A-Za-z0-9._:-` nào, không có từ vựng, không chuẩn hoá, không mặc định, và `traces` **không có index** trên cột đó. Phase B định nghĩa từ vựng agent chuẩn + tra cứu tên hiển thị, có index, và cho phép gán nhãn ở UI. Nhãn **vẫn không phải xác thực**. |
| OR-02 | P0 **[MỞ]** | Chỉ xây điều phối khi có **nhu cầu cụ thể đã ghi ra**. Điều kiện mở: một mô tả nhu cầu nêu rõ việc cần làm gì, hiện tại làm thủ công thế nào, và vì sao combo/fallback hiện tại không đáp ứng. Không có tài liệu nhu cầu thì mục này ghi **chưa đủ điều kiện**, không xây. |
| OR-03 | P0 | Nếu được xây, điều phối **bắt buộc** có đủ bốn thứ: **giới hạn quyền** (deny-by-default, không bao giờ rộng hơn allowlist của key), **nhánh** (giới hạn số nhánh và độ sâu), **timeout** (mỗi nhánh và toàn bộ), và **trần chi phí** (mỗi nhánh và toàn bộ). Thiếu bất kỳ thứ nào thì không được coi là đạt. |
| OR-04 | P0 | Mọi nhánh phải là attempt con của **một** trace cha, có terminal state và usage như mọi attempt khác. Không có inference nào trả tiền mà không được ghi. Bất kỳ giới hạn nào chạm ngưỡng thì dừng **và abort** phần còn chạy, không chỉ bỏ qua kết quả. |
| OR-05 | P1 | Điều phối ở **ngoài** `/v1/*` và dùng dashboard auth, cùng lý do và cùng ranh giới với [TI-04]. |

### Bảo mật và tương thích — xuyên suốt

| ID | Ưu tiên | Yêu cầu / tiêu chí nghiệm thu |
|---|---|---|
| SEC-01 | P0 | Mọi API quản lý mới (projects, prompts, preferences, benchmark, agents) dùng **dashboard auth** hiện hữu, deny-by-default, `Cache-Control: no-store`. Không thêm prefix public mới. `/v1/*` giữ nguyên auth và key allowlist. Endpoint benchmark/chia nhỏ/điều phối **không** được nằm trong `PUBLIC_API_PATHS`. |
| SEC-02 | P0 | Dự án, sở thích, template, combo mặc định là **cấu hình tin cậy**: chỉ đọc từ DB qua đường xác thực. Không API nào trong `/v1/*` nhận project/preference từ request. Header `taskId`/`agentLabel` vẫn chỉ là **nhãn**, không phải định danh, không cấp quyền. |
| SEC-03 | P0 | Bảng/API mới chỉ chứa metadata allowlist. Đặc biệt: số liệu đo context của Phase B chỉ lưu **hình dạng, kích thước, filter, lý do** — tuyệt đối không lưu nội dung `tool_result`, prompt, output hay credential dù nó đã bị RTK nén. Không thêm đường gọi provider nào có URL đích tùy ý. |
| SEC-04 | P0 | `projectId` **đã bị dùng lại** với nghĩa khác trong credential của provider (`open-sse/services/projectId.js`, `connectionsRepo.js` cho antigravity/gemini-cli — đó là Google Cloud project id). Trường mới của Phase B không được trùng tên gây nhầm. Đồng thời `PROJECT_ID_PATTERN` đang bị **sao chép ở 4 nơi** với biến thể khác nhau — tập trung lại một nguồn trước khi thêm call site mới. |
| SEC-05 | P0 | Migration SQLite **additive**, có backup/version đúng cơ chế hiện có (`SCHEMA_VERSION` và version migration là **hai bộ đếm khác nhau**, phải nâng cả hai). Restart/adapter fallback không nhân usage, không mất cảnh báo. `/v1/*` response/stream không đổi hình dạng. Kiểm thử offline, so với regression baseline; known failures báo riêng. |

## Cổng hoàn thành Phase B

1. BD-01..03 đóng và **đo được**: khoảng cách chi phí giữa báo cáo và provider thật được công bố bằng số, không phải bằng suy đoán.
2. Test hành vi đáp ứng mọi ID P0 và UI security/accessibility; không dùng placeholder `expect(true)` làm bằng chứng.
3. Chạy một tập tác vụ coding thật **theo yêu cầu của người dùng**, sau khi xác nhận chi phí. Báo cáo gồm subtotal đã định giá, tỷ lệ `unknown`, và tỷ lệ attempt bị bỏ sót — không yêu cầu một con số tùy ý để che thiếu dữ liệu.
4. Với mỗi mục gắn **[Mở]**: hoặc có bằng chứng mở kèm theo, hoặc được ghi rõ **chưa đủ điều kiện** kèm lý do. Không mục nào được coi là xong khi điều kiện mở chưa có.
5. Rà bảo mật: auth, attribution, redaction, IP/proxy/SSRF, không có provider probe tự động, không có payload trong bảng/API mới. Ghi công khai giới hạn số liệu trong dashboard.
6. Không có sở thích nào tự học từ lịch sử, không có tác vụ nào tự chạy theo lịch, không có request provider nào phát sinh ngoài lúc người dùng bấm.