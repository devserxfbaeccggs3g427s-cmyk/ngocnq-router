# Phase A — Tasks

**Trạng thái:** T01–T11 hoàn tất (hành vi đã được test chứng minh). **T12 chưa hoàn tất** — xem [Khoảng trống còn lại](#khoảng-trống-còn-lại-chưa-đóng).
**Nguồn:** [Requirements](requirements.md) · [Design](design.md) · [`docs/ROADMAP.md`](../../../ROADMAP.md).

> Không bắt đầu task nào trước khi người dùng review/duyệt cả bộ spec. Giữ nguyên mọi sửa đổi Phase A chưa commit; không reset hoặc sửa baseline để che regression. Mỗi task hoàn tất khi hành vi được test chứng minh, không chỉ khi thêm API/hàm.

**Bằng chứng kiểm chứng (chạy lại được):** 141 test Phase A xanh trên 8 file · `npx eslint .` 0 lỗi · `npm run build` thành công, `/api/usage/analytics` có trong route manifest · full suite 3700 test / 3493 pass / 108 fail, **mọi fail đều tái hiện ở HEAD sạch** (xem [Ghi nhận trung thực](#ghi-nhận-trung-thực)).

## Lát cắt 0 — chuẩn bị và chốt hợp đồng

- [x] **T01 — Chụp hiện trạng và viết test thất bại cho các lỗ hổng.** [TR-01, UA-01, SEC-03]
  **Tệp:** `src/sse/handlers/chat.js`, `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler,requestDetail}.js`, `src/lib/db/repos/{traceRepo,usageRepo}.js`, `tests/unit/*`.
  **Việc làm:** đối chiếu dirty diff hiện có, liệt kê tất cả `saveUsageStats`/`saveRequestUsage` call sites, mọi `/v1/*` entrypoint và executor có retry/HTTP inference nội bộ; xác nhận lỗi `beginTrace` chưa gọi, callback engine bị bỏ qua và đường ghi hai lần. Viết test tái hiện nhưng không đụng request/response contract.
  **Hoàn thành khi:** test có thể phân biệt baseline hiện tại với đích, và có bảng đường đi endpoint/usage writer; không có file user-owned nào bị reset.
  > **Bằng chứng:** audit đường đi writer (traceAttempts → usageHistory → usageDaily) và entrypoint `/v1/*` hoàn tất; executor có retry nội bộ được liệt kê (xem khoảng trống K1). Không reset file user-owned nào.

## Lát cắt 1 — schema, cost & nguồn sự thật (phụ thuộc T01)

- [x] **T02 — Migration + privacy boundary cho trace.** [TR-03, UA-02, SEC-02, SEC-03]
  **Tệp:** `src/lib/db/schema.js`, `src/lib/db/migrations/index.js`, migration version sau `003-phase-a-cost-attribution.js`, `src/lib/db/repos/traceRepo.js`.
  **Việc làm:** nâng schema version/backup, scrub `traceAttempts.tokensJson` cũ; chuyển numeric usage counters hoàn toàn sang `usageHistory`, bỏ field raw `tokensJson` khỏi API và không viết mới; index/filter/order ổn định, giữ data migration idempotent.
  **Test:** cold DB, DB nâng cấp có rows legacy, 2 lần startup, adapter fallback; quét persisted trace/API không có prompt/header/token/credential.
  **Hoàn thành khi:** trace tables chỉ metadata, dữ liệu cũ không mất, biết rõ unsupported adapter được skip thế nào.
  > **Bằng chứng:** `004-phase-a-privacy-reconciliation.js`, `SCHEMA_VERSION = 5`. Test chứng minh cột `tokensJson` không còn trên `traceAttempts`, counters 70001/80003 không xuất hiện trong bất kỳ cột nào của attempt row (chỉ đọc được qua `usageHistory`), và `getTrace` chỉ lộ usage dưới khoá lồng `usage`.

- [x] **T03 — Một ledger per attempt và đối soát chi phí.** [UA-01..04, BQ-02]
  **Tệp:** `src/lib/db/repos/{usageRepo,traceRepo,pricingRepo}.js`, `open-sse/handlers/chatCore/{requestDetail,streamingHandler,nonStreamingHandler,sseToJsonHandler}.js`.
  **Việc làm:** chốt canonical numeric token/price/cost provenance; một writer ghi `usageHistory.attemptId` và daily aggregate/event đúng một lần; hợp nhất/triệt đường `saveUsageStats()` cạnh tranh trên traced chat, còn đường legacy chưa trace giữ nguyên. Ghi terminal/ledger transactionally hoặc repair idempotent sau restart; định nghĩa usage-arrives-late/partial.
  **Test:** duplicate callback, đồng thời/restart, 401 retry, unknown pricing, giá 0 rõ ràng, cache/reasoning không double count, parent subtotal = tổng priced children.
  **Hoàn thành khi:** mỗi upstream attempt có tối đa 1 row usage và 1 aggregate increment, unknown hiển thị `null`/coverage, không lọt thành $0.
  > **Bằng chứng:** unique partial index `idx_uh_attempt`; hai callback terminal cho cùng một dispatch → đúng 1 row `usageHistory` (`phase-a-trace-coordinator.test.js`). Giá unknown → `cost=null, costStatus='unknown'` trên **cả** attempt và parent. `repairTerminalAttemptUsage()` phục hồi row mất mà **không** bịa cost. Timestamp ghi = terminal time của attempt.

## Lát cắt 2 — runtime trace và kết thúc stream (phụ thuộc T02, T03)

- [x] **T04 — Hook từng `executor.execute()` trong engine.** [TR-01..04]
  **Tệp:** `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler}.js`, `open-sse/utils/{stream,streamHandler}.js` và test `tests/unit/*`.
  **Việc làm:** hook metadata-only bắt đầu/kết thúc một attempt cho mỗi **dispatch thực tế** (xem audit T01 nếu executor retry nội bộ); nắm status, TTFT, duration, numeric usage và outcome parse/stream/abort. Callback từ app không được chặn inference nếu telemetry lỗi.
  **Test:** mock executor trả JSON, forced SSE→JSON, SSE thành công, upstream lỗi sau HTTP 200, client abort, stall và retry auth; assert số attempt/status/timing/null TTFT.
  **Hoàn thành khi:** 1 execute = 1 ID, 1 terminal, không có attempt success trước stream hoàn tất và không đổi byte response `/v1/*`.
  > **Bằng chứng:** `chatCore.js` định tuyến **cả hai** dispatch (lần đầu + retry sau refresh) qua `executeTraced()`. Test byte-identity mới: tái tạo body SSE có ký tự đa byte (✓ ✗ 🚀) và cắt chunk cố tình qua giữa ký tự → `Buffer` so sánh bằng **byte**, không phải string; status/statusText/header giữ nguyên; response 204 trả về **đúng object gốc**. Đã mutation-test (cắt mất 1 byte/chunk) → 2 test bắt được, đã hoàn nguyên.
  > ⚠️ Còn khoảng trống K1 (retry nội bộ của executor) — chưa đóng, xem [Khoảng trống còn lại](#khoảng-trống-còn-lại-chưa-đóng).

- [x] **T05 — Parent coordinator xuyên combo/solo/fusion.** [TR-01..04, SR-02]
  **Tệp:** `src/sse/handlers/chat.js`, `open-sse/services/combo.js`, `src/lib/db/repos/traceRepo.js`, test handler tích hợp.
  **Việc làm:** `beginTrace()` sau auth/allowlist/bypass với endpoint chuẩn; truyền cùng context qua top-level/nested combo, account/model fallback và fusion panel/judge. Parent chỉ terminal khi downstream và các attempt (kể cả panel bị bỏ) settle; abort/timeout panel còn chạy, watchdog dọn pending. Judge ngoài combo phải qua kiểm tra quyền riêng.
  **Test:** direct, combo 2 model, account fallback, fusion quorum/straggler/late usage/judge, no-credential, reject key và bypass.
  **Hoàn thành khi:** đúng một parent, đủ child attempts kể cả lỗi, không có paid orphan và không ghi trace cho request bị từ chối.
  > **Bằng chứng:** `tests/unit/phase-a-trace-coordinator.test.js` (27 test). Chứng minh: đúng 1 parent/request; `apiKeyId`/`projectId` lấy từ **key đã xác thực** (header tự khai báo về project không được dùng); endpoint allow-list (marker trong query string không lưu được; `/v1/../../etc/passwd` → `"unknown"`); taskId/agentLabel sai pattern bị **drop**; 1 child attempt cho mỗi dispatch **kể cả lỗi**; `closeAbandonedAttempts()` dọn pending lúc boot; terminal idempotent; routing metadata bị từ chối sau khi terminal.

- [x] **T06 — Phủ các inference entrypoint khác hoặc công bố coverage.** [TR-01, UA-01, SEC-03]
  **Tệp:** `src/sse/handlers/{embeddings,imageGeneration,systemone}.js` và các entrypoint `/v1/*` khác phát hiện ở T01; shared trace/usage helper nếu cần.
  **Việc làm:** instrument bằng cùng coordinator và writer nếu có upstream paid call. Với endpoint chưa tương thích, document phạm vi chưa có trace trong API/UI và không đánh dấu Phase A [TR-01] hoàn tất cho endpoint đó; không đổi gateway response.
  **Test:** mỗi endpoint có case success/error/abort hoặc có test chứng minh được đánh dấu chưa instrument; tổng coverage báo chính xác.
  **Hoàn thành khi:** yêu cầu “mọi attempt” không còn khoảng trống ngầm.
  > **Hoàn thành theo nhánh "công bố coverage"** mà spec cho phép: `src/lib/traceCoverage.js` khai báo `tracedEndpoints`, `untracedPaidEndpoints` (`/v1/embeddings`, `/v1/search`, …), `scope: "chat-only"`. Analytics API trả kèm `coverage.tracing` với disclosure kết thúc *"their cost is unknown, not zero."* — test khẳng định `/v1/embeddings` được nêu đích danh, để endpoint chưa trace **không bao giờ** bị đọc là $0. Đây là khoảng trống **công khai, không ẩn**.

## Lát cắt 3 — attribution, budget và API (phụ thuộc T03, T05)

- [x] **T07 — Attribution tin cậy và budget warning UTC.** [BQ-01..02, SEC-01]
  **Tệp:** `src/sse/services/keyAccess.js`, `src/lib/db/repos/{apiKeysRepo,settingsRepo,usageRepo,traceRepo}.js`, `src/app/api/{keys,settings}/**`.
  **Việc làm:** API-key ID/project chỉ từ key **active đã xác thực qua cùng extractor** với middleware; local-no-key hoặc header key sai/disabled khi `requireApiKey=false` không gắn project, hạn chế raw key trong ledger; tính daily/monthly theo terminal timestamp UTC và price coverage; unique warning, `notifiedAt`, không chặn/chuyển model. Chỉ global/project có cấu hình Phase A, API-key chỉ là filter.
  **Test:** header project giả, key gắn/đổi project, hai keys cùng project, local mode, ranh giới UTC/local midnight, đồng thời vượt nhiều ngưỡng, restart/duplicate, bật budget không có alerts.
  **Hoàn thành khi:** 1 warning/ngưỡng/kỳ/scope và không có response nào bị budget cản.
  > **Bằng chứng:** `tests/unit/phase-a-trace-budget.test.js`, `tests/unit/phase-a-project-budget-settings.test.js`. `periodKey` tính theo **UTC**; ngưỡng lặp lại trong cùng kỳ bị unique index gộp (không báo trùng), ngưỡng khác trong cùng kỳ là alert khác; threshold vô nghĩa bị **reject** chứ không clamp; budget chỉ cảnh báo, không chặn request.

- [x] **T08 — Trace, analytics và alerts management API.** [TR-02..03, UA-03..04, BQ-02, SEC-01..02]
  **Tệp:** `src/app/api/usage/{traces,alerts}/**`, route analytics mới, `src/lib/db/repos/{traceRepo,usageRepo}.js`, `src/dashboardGuard.js` (chỉ nếu cần).
  **Việc làm:** áp dụng shapes/filter/pagination/ISO UTC/limits/EXISTS provider-child trong [Design](design.md#4-attribution-api-và-truy-cập-tr-03-ua-03-bq-01); response field whitelist, subtotal+unknown coverage, no-store, uniform 400/401/403/404/500. `budgetEnabled` đọc settings, không suy từ rows.
  **Test:** qua Next middleware thật (unauth 401/403), oversized/invalid/reversed date, nhiều attempt/provider, project filters, no raw JSON/payload/secret, cache headers, pagination stable.
  **Hoàn thành khi:** `tests/unit/phase-a-ui-api.test.js` không còn placebo `expect(true)`; query giới hạn dữ liệu và thông tin trả ra.
  > **Bằng chứng:** `tests/unit/phase-a-ui-api.test.js` + `tests/unit/phase-a-analytics-api.test.js` (22 test cho `/api/usage/analytics`). Không còn `expect(true)` placebo. Phân trang ổn định (`ORDER BY … , requestId`), filter provider dùng `EXISTS` trên child attempt, `Cache-Control: no-store` trên cả 200 lẫn 400/500, **không** bao giờ echo message nội bộ (test chèn lỗi chứa `SQLITE_CONSTRAINT near "secret token"` và khẳng định response không chứa nó).

## Lát cắt 4 — provider và dashboard (phụ thuộc T07, T08)

- [x] **T09 — Provider cached status/quota không tự probe.** [BQ-03, PM-01..02, SEC-02]
  **Tệp:** `src/lib/{providerConnectionStatus,providerConnectionResponse}.js`, `src/app/api/providers/route.js`, `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`.
  **Việc làm:** rà normalization/cooldown/last-check/error redaction và quota `unknown`; giữ Auto-ping là hành động riêng được cảnh báo; kiểm tra URL/provider override/proxy không đưa secrets vào log hoặc tạo SSRF path mới.
  **Test:** mock provider fetch/executor và assert `GET providers`/render/refetch không phát upstream inference; status/quota permutations và redaction.
  **Hoàn thành khi:** dashboard hiện nguồn & tuổi dữ liệu, secrets không lộ, không trả chi phí thăm dò ngầm.
  > **Bằng chứng:** `tests/unit/provider-connection-status.test.js`. Status đọc từ cache có timestamp (hiển thị **tuổi dữ liệu**), quota thiếu → `unknown`; `GET providers` không phát inference; redaction giữ secret khỏi response.

- [x] **T10 — Usage/tracing/budget dashboard thống nhất.** [UA-02..04, BQ-01..03, TR-02, PM-01]
  **Tệp:** `src/app/(dashboard)/dashboard/usage/page.js`, `src/shared/components/UsageStats.js`, `src/app/(dashboard)/dashboard/usage/components/{OverviewCards,UsageChart}.js`, component mới tại cùng thư mục.
  **Việc làm:** một hàng filter chung (UTC), KPI priced subtotal và unknown ratio, trend một trục, task/provider/model tables, trace drill-down và budget warnings/quotas. Có table view + keyboard/hover tương đương, không color-only hay skeleton flash; text/labels render an toàn. Validate palette ở light/dark qua `dataviz/scripts/validate_palette.js` trước khi ship.
  **Test:** UI/interaction với fixture multiple attempts/unknown/empty; keyboard focus và accessibility; filter nhất quán từng KPI/chart/table; screenshot responsive dark/light.
  **Hoàn thành khi:** không có giá “unknown” trông như $0 và các số nhìn thấy được không cần hover.
  > **Tệp mới:** `usage/components/PhaseAOverview.js` + `usage/components/phaseA/{format,FilterBar,KpiTiles,TrendChart,BreakdownTable,BudgetAlerts,TraceDrilldown}.js`; tab `analytics` trong `usage/page.js`. Không sửa `UsageStats.js`/`OverviewCards`/`UsageChart` ( Overview cũ giữ nguyên lịch sử).
  > **Palette đã validate** bằng `validate_palette.js` trên nền thật (`#ffffff` / `#262626`), không so mắt: light `#cf222e #3B82F6 #10B981 #B45309` và dark `#dc2626 #3b82f6 #16a34a #b45309` đều PASS; các WARN (contrast 2.54:1 ở success, CVD 7.3 deutan success↔warning ở dark) được bù bằng **icon + chữ** trên mọi status pill. Series duy nhất `#E56A4A` — cùng một bước màu hợp lệ trên cả hai nền, không lật tự động.
  > **Bằng chứng hành vi:** `tests/unit/phase-a-analytics-api.test.js` (26 test) phủ contract mà UI đọc — `totalCostUsd` null **không phải** 0, `pricedUsd` một phần vẫn hữu ích, `pricedUsd` null khi không dispatch nào định giá được, và `listTraces` trả `pricedUsd` mà không rò legacy row của request khác. 106/106 test Phase A xanh.
  > **“Unknown” không bao giờ trông như $0:** KPI `TOTAL COST` in **Unknown** khi `totalCostUsd == null`; bảng `By provider` và `Traces` in **giá định giá được** + cột `Unknown %`, chỉ in “Unknown” khi **không** định giá được gì. Đây là sửa do kiểm tra bằng mắt phát hiện: `totalCostUsd` null ngay khi *một* dispatch không có giá, nên cột cost gốc in “Unknown” ở **100% số dòng** và không mang thông tin gì.
  > **Kiểm tra bằng mắt (bước 7 của procedure dataviz):** đã render thật (production build, `DATA_DIR` tạm có 121 request / 247 dispatch / 63,2% unknown / 4 legacy row) và xem **cả light lẫn dark** ở 1440px — không có label chồng nhau, không tràn, trục Y là `$0…$600` (đã sửa `$0.0000`), một trục duy nhất, không số nào chỉ hiện khi hover (mọi bảng có số in sẵn, trend có nút Chart/Table). Fixture tạm đã xoá sau khi chụp.
  > **Còn nợ nhỏ (không chặn T10):** `KpiTiles` dùng `text-[11px]` cứng thay vì token; panel dưới cùng chưa có test tương tác (expand trace) — hành vi đã kiểm bằng mắt, chưa có test tự động.

## Lát cắt 5 — routing opt-in và cổng chất lượng (phụ thuộc T05, T07, T08)

- [x] **T11 — Eligibility + smart ranking opt-in chỉ combo fallback.** [SR-01..03, SEC-01]
  **Tệp:** `open-sse/services/combo.js`, `src/sse/handlers/chat.js`, `src/lib/db/repos/{settingsRepo,traceRepo}.js`, `src/sse/services/keyAccess.js`, `tests/unit/combo-smart-ranking.test.js`.
  **Việc làm:** xác thựn cấu hình opt-in per combo; lọc modality cứng và giới hạn thành viên combo theo quyền đã cấp cho combo, giữ nguyên quyền gọi trực tiếp. Bảo toàn fusion/round-robin/adapter; `health` lấy từ cached account status còn mới (<=30 phút), không dùng lại successRate; p95 từ successful attempts, giá/1k chỉ từ priced attempts. Metric lấy 30d, >=100 mẫu mỗi ứng viên, mới <=7d, coverage giá >=80%; không đủ/DB lỗi → thứ tự gốc. Lưu explanation enum/score an toàn; không trộn prompt vào telemetry.
  **Test:** opt-in/off, từng modality, unknown file, allowlisted combo và judge ngoài combo, metrics cold/old/incomplete, cost unknown không phải free, score/ties, fallback không chọn model thiếu modality.
  **Hoàn thành khi:** opt-in có thể rollback, route explainable, không mở rộng allowlist, test runtime (không chỉ pure function) qua handler.
  > **Bằng chứng:** `tests/unit/combo-smart-ranking.test.js` + `tests/unit/combo-smart-routing-integration.test.js` (test runtime qua handler, không chỉ pure function). Opt-in per-combo, tắt là tắt; metrics thiếu/DB lỗi → giữ nguyên thứ tự gốc; **cost unknown không bao giờ được thưởng** như free; modality thiếu bị lọc cứng và trả `unsupported_modality` trước khi gọi upstream.
  > ⚠️ **Test đã bị viết lại** — xem [Ghi nhận trung thực](#ghi-nhận-trung-thực).

- [ ] **T12 — Bảo mật, regression và Phase A exit gate.** [UA-04, SR-04, SEC-01..03] — **CHƯA ĐÓNG**
  **Tệp:** tests dưới `tests/unit/`, integration tests theo pattern repo, `tests/__baseline__/verify-no-regression.mjs`, tài liệu release/CHANGELOG khi triển khai.
  **Việc làm:** test deny-by-default management API, project header spoofing, payload/redaction, proxy/IP trust & SSRF boundary; focused tests, `npx eslint .`, `npm run build`, offline Vitest và baseline verification (known failures báo riêng). Làm report đối soát attempt/usage/unknown coverage. Chỉ **sau khi người dùng duyệt chi phí**, chạy mẫu tác vụ coding với provider thật và so sánh fixed vs opt-in theo chi phí/tác vụ hoàn tất, tỷ lệ hoàn tất, latency và chất lượng.
  **Hoàn thành khi:** exit gate [`requirements.md`](requirements.md#cổng-hoàn-thành-phase-a) có bằng chứng và mọi lỗi được báo trung thực; không tự bật smart routing làm mặc định nếu chất lượng giảm.
  > **Đã làm:** review bảo mật (xem [Rà soát bảo mật](#rà-soát-bảo-mật-t12-phần-đã-làm)); `npx eslint .` 0 lỗi; `npm run build` thành công; attribution 108 fail của full suite về clean HEAD.
  > **Chưa đóng:** mẫu tác vụ coding với **provider thật** so sánh fixed vs opt-in **chưa chạy** — cần người dùng duyệt chi phí trước. Vì vậy **không được tuyên bố Phase A hoàn tất**, và smart routing **không** được bật làm mặc định.

## Khoảng trống còn lại (chưa đóng)

| # | Khoảng trống | Tác động | Trạng thái |
|---|---|---|---|
| **T12** | Chưa chạy mẫu với provider thật (fixed vs opt-in) | Exit gate chưa đủ bằng chứng | **Cần người dùng duyệt chi phí** |
| **K1** | Executor retry **nội bộ** phát nhiều POST có tính phí dưới **một** attempt → **thiếu tiền thật** | `open-sse/executors/base.js` (`tryRetry`), `kiro.js`, `antigravity.js`, `commandcode.js`, `codex.js`, `mimo-free.js`, `xiaomi-mimo.js` | Đã ghi nhận, **chưa sửa** — cần định nghĩa "dispatch" riêng cho các executor này |
| **K2** | `tests/unit/db-concurrent.test.js`: 100 `saveRequestUsage` song song → chỉ còn 2–3 row | `saveRequestUsage` dedup theo `(timestamp, provider, model, connectionId)` khi thiếu `attemptId`, nên request cùng **milli-giây** bị gộp | **Lỗi có sẵn ở HEAD v0.5.99**, không phải do Phase A; chưa sửa |
| **K3** | `/v1/embeddings`, `/v1/search`, `/v1/images` chưa instrument | Chi phí các endpoint này = **unknown**, không phải $0 | Đã **công bố** qua `coverage.tracing` (đúng nhánh T06) |

**K1 là lỗ hổng đo lường, không phải lỗ hổng bảo mật:** nó làm chi phí báo cáo **thấp hơn thực tế**, nên báo cáo vẫn bảo thủ — nhưng sai. Không được coi là đã đóng khi so số với provider thật ở T12.

## Rà soát bảo mật (T12, phần đã làm)

| Hạng mục | Kết quả |
|---|---|
| Xác thực | `/api/usage/analytics` kế thừa prefix `/api/usage` trong `PROTECTED_API_PATHS` của `dashboardGuard.js` — không cần (và không có) bypass |
| SQL injection | **Không có.** Mọi identifier được nội suy vào SQL đều đến từ object literal viết cứng (`Object.entries({provider, comboName, accountId})`, `traceFilters`, …); **mọi giá trị** đều là `?` parameter |
| Rò rỉ lỗi nội bộ | 500 trả message cố định, chỉ `console.error(error.message)` ở server |
| Rò rỉ dữ liệu | Response dựng từ danh sách cột tường minh, không `SELECT *`; `getTrace` chỉ lộ usage dưới khoá `usage` |
| Header/attribution | Coordinator chỉ đọc **2 header** tên cố định, validate theo pattern và cắt còn ≤128 ký tự trước khi lưu. Attribution lấy từ `keyAccess` (key đã xác thực), **không** từ header client tự khai |
| Query-string smuggling | Endpoint resolve qua allow-list cố định; `/v1/../../etc/passwd` → `"unknown"`, không echo path thô |
| IP trust boundary | **Không đụng.** `custom-server.js` vẫn lấy peer IP từ TCP socket và chỉ tin `X-Forwarded-For` từ loopback reverse proxy — không có mã mới nào đọc header IP |
| SSRF | Không thêm outbound path nào; `/api/usage/analytics` chỉ đọc SQLite |

## Ghi nhận trung thực

- **2 test bị viết lại, không phải xoá:**
  1. `tests/unit/combo-smart-ranking.test.js` — các test staged mâu thuẫn với spec (spec thắng). Nội dung mới kiểm đúng điều spec yêu cầu.
  2. `tests/unit/opencode-go-session.test.js` — đếm thô số call-site `executor.execute({` đã vỡ sau khi T04 gom 2 dispatch vào `executeTraced()`. Đã thay bằng assertion về **hành vi**: helper phải truyền `providerSessionId: sessionSeed` + `clientTool`, và **cả hai** dispatch (lần đầu + retry sau refresh) đều đi qua nó.
- **4 lỗi thật do test Phase A phát hiện và đã sửa:**
  1. `traceCoordinator.wrap` truyền object còn `finish` nhận tham số vị trí → **mọi trace streaming đứng `pending` vĩnh viễn**. Sửa bằng adapter closure.
  2. `finishTrace` đè `metricsJson`, xoá đúng lúc trace chuyển terminal — mất sạch decision record của routing. Sửa bằng merge thay vì thay thế.
  3. `finalizeTally` đếm **hai lần** unknown attempts (`unknownAttempts + unpriced` trong đó `unpriced` đếm lại chính các attempt đó).
  4. `bucketBounds` sinh ISO sai cho bucket giờ (`T07:00.000Z`) → series có `from/to = null`.
- **Baseline:** không sửa `tests/__baseline__/current.json` hay snapshot nào. Toàn bộ 17 fail "mới" đã được **phân định bằng worktree HEAD sạch**: 16 tái hiện nguyên vẹn ở HEAD (13 assertion source-text của security-audit, 3 db-concurrent, 2 request-details-tab); chỉ `opencode-go-session` là thay đổi thật do tôi gây ra, và nó là **test giòn** chứ không phải hồi quy hành vi (mục 2 ở trên).
- **2 lỗi trình bày do kiểm tra bằng mắt phát hiện (T10), đã sửa và có test:**
  1. Cột `Cost` ở `By provider` và ở `Traces` in **“Unknown” ở 100% số dòng**. Nguyên nhân: `totalCostUsd`/`cost` là `null` ngay khi **một** dispatch trong nhóm không định giá được — nên chỉ cần một lần gọi tới model chưa có bảng giá là cả bảng mất thông tin, dù `pricedUsd` vẫn dùng được. Sửa: cột in **giá định giá được** (đổi tên `Priced cost`) và chỉ in “Unknown” khi **không** dispatch nào định giá được. Với danh sách trace, `listTraces` trả thêm `pricedUsd` (subquery chỉ cộng `usageHistory.cost`, không chạm prompt/output); test ở `phase-a-analytics-api.test.js`.
  2. Trục Y của trend in `$0.0000`, `$150.00` — định dạng tiền cho **tick trục**, không phải số tiền thật. Sửa thành `$0` / `$150` / `$600`.
- **Cảnh báo về môi trường kiểm tra:** `npm run dev` của repo **hardcode `--port 20127`**, nên biến `PORT` bị bỏ qua. Trong dev, Turbopack **recompile liên tục** → Fast Refresh reload → `net::ERR_ABORTED` trên `fetch` → panel kẹt ở “Loading analytics…” dù API trả 200. Đây là **hiện tượng dev server, không phải lỗi sản phẩm**; kiểm tra bằng mắt phải chạy **production build** (`node custom-server.js --port 20127`) với `DATA_DIR` trỏ vào fixture tạm.

## Ma trận phụ thuộc và coverage

`T01 → T02/T03 → T04 → T05 → T06/T07/T08 → T09/T10/T11 → T12`; T03 phụ thuộc T02 nếu schema token được thay đổi; T08 phụ thuộc cả T05 và T07 cho attribution/budget. `TR-*`: T01, T02, T04–T06, T08, T10; `UA-*`: T02, T03, T06, T08, T10, T12; `BQ-*`: T07–T10; `PM-*`: T09; `SR-*`: T05, T11, T12; `SEC-*`: mọi lát cắt, kiểm soát cuối T12.

**Coverage hiện tại:** `TR-*` đạt cho toàn bộ endpoint chat; `UA-*` đạt ở cả ba tầng ledger → API → UI (T10); `BQ-*` đạt ở API + cảnh báo + panel Budget (T10), còn quota thì thuộc T09; `SR-*` đạt, nhưng **chưa có** bằng chứng định lượng từ provider thật (T12).

Các lệnh kiểm chứng: từ `tests/` chạy `./node_modules/.bin/vitest run unit/<file>.test.js --config vitest.config.js`; từ root chạy `node tests/__baseline__/verify-no-regression.mjs`, `npx eslint .`, `npm run build`. Full suite có known failures và live-provider tests phải tách riêng; không sửa snapshots/baseline khi chưa giải thích chênh lệch.