# Phase B — Design

**Trạng thái:** Đề xuất để review; mô tả đích đến, **không** xác nhận code hiện tại đã hoạt động.
**Nguồn:** [`docs/ROADMAP.md`](../../../ROADMAP.md) · [Requirements](requirements.md) · [Tasks](tasks.md).
**Bộ trước:** [Phase A — Design](../2026-10-13-phase-a/design.md) — mọi quy ước trace/usage/budget ở đó vẫn hiệu lực.

## 1. Quyết định kiến trúc và hiện trạng

Nguyên tắc giữ nguyên từ Phase A: authorization, attribution và SQLite ở `src/`; engine `open-sse/` chỉ nhận callback/hook metadata; `/v1/*` không đổi hợp đồng. Phase B bổ sung **cấu hình tin cậy** và **đo đạc** — không bổ sung đường suy luận.

Điểm khác biệt cấu trúc so với Phase A: Phase A thêm **quan sát** vào một đường đã có; Phase B thêm **thực thể cấu hình** và **một hệ đo**. Cả hai đều dựa trên cùng một nguyên tắc: mọi thứ suy ra từ hành vi đã xảy ra phải được đo trước, đo được, rồi mới tối ưu.

```text
/v1/*  ──(không đổi)──► auth + keyAccess ──► routing ──► executor
                                                   │
                                                   ├─► [Phase A] trace/attempt/usage ledger
                                                   └─► [Phase B] contextSavings (đo, không quyết định)

/api/projects, /api/prompts, /api/projects/*/preferences   (dashboard auth) ► cấu hình tin cậy
/api/benchmarks/*                                         (dashboard auth) ► chạy thủ công, có duyệt chi phí
/api/tasks/split, /api/orchestrations/*                   (dashboard auth) ► ngoài /v1/*  [TI-04, OR-05]
```

| Vị trí hiện có | Khoảng trống hoặc cần xác minh | Thiết kế đề xuất |
|---|---|---|
| `apiKeys.projectId`/`projectLabel` (`schema.js:78-98`) là **chuỗi tự do** đã validate, có index, không FK, không entity | **Không có bảng `projects`**. Nhiều key cùng `projectId` mỗi key mang một `projectLabel` riêng, **không có gì buộc chúng khớp**. Không có createdAt, không có kiểm toán. | Thêm `projects(id, label, archivedAt, createdAt, updatedAt)` với `id` **bằng đúng** `projectId` đang chạy → attribution `traces.projectId`/`usageHistory.projectId` không phải viết lại. Key giữ `projectId` tham chiếu; ledger **không** đặt FK để lịch sử sống sót khi dự án bị xoá. Backfill idempotent từ `apiKeys.projectId` ∪ `budget.projects`. |
| `normalizeApiKeyProject()` (`apiKeysRepo.js:16-52`) | Patch semantics: vắng mặt → giữ, `null`/rỗng → xoá; **đổi `projectId` mà không gửi `projectLabel` sẽ xoá nhãn**. Route `PUT /api/keys/[id]` truyền **cả body** vào normalizer. | Giữ nguyên hàm. Thêm `projectExists()` để API dự án mới dùng chung một nguồn validate; không nhân bản regex. |
| `settings.budget.projects[id]` (`settingsRepo.js:7-14, 99-138`) | Shape **đóng**: `rejectUnknownKeys` + `BUDGET_LIMIT_KEYS = {dailyUsd, monthlyUsd}`. `defaultCombo` không thể nhồi vào đây mà không sửa cả hai. Tối đa 1000 project. | **Không** mở rộng `budget`. Thêm không gian cấu hình song song `projectSettings` theo đúng khuôn `comboStrategies` (`settingsRepo.js:20-68`): shape đóng, số entry có trần, `updateSettings` đã merge trong transaction. Ngân sách vẫn đọc từ `budget.projects` như Phase A. |
| `getKeyAccessContext()` (`keyAccess.js:64-84`) | Trả `projectId` từ **key record**, không kiểm tra `isActive`; mọi gate bắt đầu bằng `if (!ctx?.restricted) return null` ⇒ `null` ctx = không giới hạn (local mode). | Đường attribution giữ nguyên. Cấu hình dự án chỉ được đọc **sau** khi đã có `ctx`; `ctx === null` ⇒ không project default nào áp dụng. |
| `EndpointPageClient.js` là mặt duy nhất quản lý key | **Không đọc, không hiển thị, không ghi `projectId`/`projectLabel`.** Grep: 0 hit. Không có `/dashboard/keys`, không có trang sửa ngân sách. | Mở rộng trang này (assign project) + trang `/dashboard/projects` mới. Không dựng lại luồng key. |
| `embeddings.js:145`, `imageGeneration.js:31`, `systemone.js:129` gọi `saveRequestUsage()` chỉ với raw `apiKey` | Không `apiKeyId`/`projectId` ⇒ `projectId = NULL` ⇒ **không bao giờ** chạm ngân sách dự án, và dính nhóm `unattributed`. | [BD-03] Truyền `apiKeyId`/`projectId` từ `keyAccess` sẵn có trong handler. Nếu quyết định không instrument thì phải công bố qua `traceCoverage.js`, không để ngầm. |
| `SCHEMA_VERSION = 5` (`schema.js:6`); migration `001`(v1), `002`(v3), `003`(v4), `004`(v5) | **Không có version 2.** `SCHEMA_VERSION` (backup) và `latestVersion()` (`_meta.schemaVersion`) là **hai bộ đếm khác nhau**, hiện trùng nhau. `syncSchemaFromTables()` (`migrate.js:79-109`) tự tạo bảng/cột/index còn thiếu khi boot. | Version tiếp theo = **6**. Vẫn viết migration `up()` cho backfill/destructive như `004` đã làm (rebuild-and-swap). Nâng **cả hai** bộ đếm. Migrations chỉ forward, không `down`. |
| `readHeader()` (`traceCoordinator.js:38-44`) | **Cắt bật trước khi validate**: taskId 400 ký tự → còn 128 và **vẫn lưu**; agentLabel 500 ký tự → còn 128 rồi **rơi** vì giới hạn 64. `AGENT_LABEL_PATTERN` bị **chép** ở `traceRepo.js:13`. `traces` **không có index** `agentLabel`. | Gộp về một nguồn constant. Sửa thành **từ chối** thay vì cắt cho agent label. Thêm index `idx_traces_agent`. Nhãn vẫn không phải xác thực. |
| `CAVEMAN_PROMPTS`/`PONYTAIL_PROMPTS` (`cavemanPrompts.js`, `ponytailPrompt.js`) là **object hằng** trong code | Level sai ⇒ `undefined` ⇒ `injectSystemPrompt()` (`systemInject.js:13`) **im lặng không làm gì**. `systemInject.js` nuốt lỗi không log. | Seed thành template chỉ-đọc từ một nguồn; level sai trả mã lỗi. Bổ sung log đếm lỗi cho injector ([CX-05]). |
| `open-sse/rtk/index.js:149-155` `formatRtkLog()` → `console.log` | **Số liệu RTK không được lưu ở đâu cảt.** Không có mốc “trước”. `pxpipe` đã có pipeline đầy đủ (`chatCore.js:322` → `src/lib/pxpipe/events.js:15`). `headroom.js:32-46, 363-369` đã có snapshot byte + phát hiện tiết kiệm ảo. | Sao chép mẫu `pxpipe` thành bảng `contextSavings` gắn `attemptId`, và đưa `captureSizeSnapshot` + `isHeadroomPhantomSavings` sang RTK. Đây là tiền đề của [CX-01..03]. |
| `rtk/index.js:44-61` xử lý shape tool result kiểu OpenAI | **Không hề kiểm tra lỗi.** `index.js:67` dùng `is_error === true` (bỏ sót `"true"`, `1`). `headroom.js:132-146` chiếu **mọi** `toolResults` kể cả `status:"error"` ⇒ bật Headroom **vô hiệu hoá** lớp bảo vệ của RTK. | Một **cổng duy nhất** tại `compressText()` cho quyết định "có được nén không", dùng cho mọi shape. Bật Headroom phải đi qua cùng cổng ([CX-04]). |
| `detectRequiredCapabilities()` (`combo.js:246-249`) | Chỉ dò **modality** trên lượt user cuối, là **định dạng** chứ không phải ý định. `HARD_CAPS`/`CAPABILITY_KEYS` bị khai **hai nơi** (`combo.js:13`, `capacityAdapter.js:14`). | Không mở rộng hàm này thành phân loại ngữ nghĩa. Luật phân loại tác vụ là lớp **riêng**, chỉ khi [TI-01] mở. |
| `settings.comboStrategies[name]` (`settingsRepo.js:20-68`) | `normalizeComboStrategies` **không** được áp trong `mergeWithDefaults()` — chỉ `budget` được. JSON hỏng lọt thẳng vào routing không qua validate. | Khi thêm namespace mới, áp normalize trong `mergeWithDefaults()` cho cả namespace cũ; nếu hỏng thì rơi về mặc định an toàn, không throw ra request. |
| `PATCH /api/settings` (`route.js:39-134`) | Chỉ chặn `PROTECTED_SETTING_KEYS` + normalize `budget`/`comboStrategies`; **mọi key khác đi thẳng không validate** — mass assignment. | Namespace mới của Phase B **phải** có normalizer và được reject 400; không lặp lại lỗ hổng này. |

### Ranh giới đặc biệt: `/v1/*` và trace allow-list

`dashboardGuard.js:33` khai `PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"]`; ngoài đó rơi vào nhánh deny-by-default `/api/*` (`:186-192`) cần JWT dashboard. Đồng thời `traceCoordinator.js:31-36` có `TRACE_ENDPOINTS` là **allow-list đường dẫn cố định** — endpoint mới ngoài `/v1/*` sẽ **không** có trace nếu không thêm vào allow-list. Vì vậy [TI-04]/[OR-05] yêu cầu thêm endpoint một cách tường minh, và endpoint phải tự gọi lại chính gateway để mọi lượt con đều được trace.

## 2. Nền tảng đo: đóng K1 và attribution [BD-01..03]

Đây là lát cắt đầu tiên vì mọi con số của Phase B đều dựa trên nó.

**K1 — định nghĩa lại dispatch.** `chatCore.js` bọc mỗi `executor.execute()` thành một attempt, nhưng có bốn executor phát nhiều POST tính phí dưới **một** lần gọi:

| Executor | Cơ chế | Đề xuất |
|---|---|---|
| `codex.js:279-327` | Vòng retry tầng SSE khi body 200 chứa `event: error` | Tách `dispatchCount` + tổng usage qua `executorResult` |
| `commandcode.js:42-60` | `maxRetries = 2` **hardcode**, không đọc registry | Đưa về `this.config.retry` để có một nguồn |
| `mimo-free.js:131-159` | Bỏ qua `base.execute`, tự fetch lại khi 401/403 | Báo `dispatchCount = 2` qua cùng kênh |
| `xiaomi-mimo.js:90-112` | Gọi `super.execute()` lần hai khi 401 | Như trên |

Hai lựa chọn: **(a)** mỗi POST = một attempt (đúng nghĩa nhưng phá vỡ "1 execute = 1 attempt" đang được test khẳng định), hoặc **(b)** một attempt mang `dispatchCount > 1` và usage cộng đủ mọi lượt, cost tính trên tổng. Phase B chọn **(b)** vì nó giữ nguyên quan hệ cha–con và vẫn đảm bảo **tiền không bị bỏ sót**; nguyên tắc bất di bất dịch là `sum(usage over dispatches) == usage ghi`. `usageHistory.attemptId` vẫn UNIQUE, nên thêm cột `dispatchCount` mặc định `1` là additive.

Đo lại: sau khi sửa, chạy một tập nhỏ request có thể retry, đối chiếu `promptTokens/completionTokens` với provider. **Khoảng cách phải được công bố bằng số**, kể cả khi còn dư — dư và thiếu là hai loại lỗi khác nhau.

**BD-02** là bước đầu tiên của benchmark, không phải việc cuối: chạy vài tác vụ thật, đối chiếu ledger với provider, ghi tỷ lệ `unknown`. [BD-03] là sửa nhỏ nhưng chặn [PW-03]: nếu chưa sửa, ngân sách dự án sẽ **âm thầm thiếu** tiền của embeddings/image/systemone.

## 3. Project Workspace [PW-01..05]

Dự án là **thực thể định danh + không gian cấu hình**, không phải chuỗi gắn nhãn.

**Bảng mới** (additive, không FK từ ledger):

```text
projects(id TEXT PRIMARY KEY,          -- = giá trị apiKeys.projectId đang chạy
         label TEXT,                   -- nhãn hiển thị, nguồn sự thật duy nhất
         archivedAt TEXT,              -- xoá mềm; NULL = đang hoạt động
         createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)
```

Ba quyết định cố ý:

- **`id` giữ nguyên giá trị cũ** ⇒ `traces.projectId`/`usageHistory.projectId` không phải viết lại, mọi báo cáo Phase A giữ nguyên hiệu lực. Row lịch sử vẫn trỏ tới một `id` có thể đã archive — đúng như mong muốn.
- **Không FK từ `traces`/`usageHistory`** ⇒ xoá dự án không làm hỏng lịch sử. FK chỉ có thể từ `apiKeys`.
- **`projectLabel` trên key được giữ nhưng mất vai trò hiển thị.** Nhiều key cùng `projectId` có thể mang nhãn khác nhau ngay bây giờ; [PW-04] yêu cầu UI phản ánh đúng hiện trạng hoặc thống nhất — không được chọn một nhãn bất kỳ và gọi đó là sự thật.

**Không gian cấu hình** theo khuôn `comboStrategies` (`settingsRepo.js:20-68`): object, shape đóng, key là `projectId` theo `PROJECT_ID_PATTERN`, có trần số entry, từ chối key lạ. Nội dung Phase B: `{ defaultComboName, preferences }`. **Ngân sách không nằm ở đây** — nó vẫn ở `budget.projects` để `evaluateBudgetAlerts()` (`usageRepo.js:83-126`) không phải đổi.

```text
projectSettings = {
  "<projectId>": {
    defaultComboName: string | null,     // đã tồn tại trong combos và được phép gọi
    preferences: { <tên sở thích>: <giá trị> }   // xem §4
  }
}
```

**Combo mặc định là default, không phải quyền.** Thứ tự áp dụng trong `chat.js`, sau `enforceKeyAccess()` và sau khi `getComboModels()` đã trả về `null` (tức request không phải combo):

1. Không có `ctx` (local/no-key) ⇒ **không** thay.
2. Không có `projectId` ⇒ không thay.
3. `defaultComboName` không tồn tại trong `combos` ⇒ không thay, ghi `fallbackReason = "project_default_missing"`.
4. `enforceKeyAccess(ctx, defaultComboName)` trả 403 ⇒ **không** thay. Đây là điểm mấu chốt: default dự án không được mở rộng allowlist. Cùng logic Phase A dùng cho judge ngoài combo.
5. Nếu gán được thì ghi `comboName` vào trace để drill-down thấy được quyết định.

**Sửa skill:** `syncSchemaFromTables()` tự tạo bảng/cột thiếu khi boot, nên bảng mới không *bắt buộc* cần migration — nhưng backfill thì cần. Migration `version: 6` chèn `projects` từ `SELECT DISTINCT projectId FROM apiKeys WHERE projectId IS NOT NULL` hợp nhất với key của `budget.projects`; chạy lại không sinh trùng.

## 4. Personalization: cấu hình tường minh, không hồ sơ ẩn [PE-01..04]

Điểm thiết kế quan trọng nhất của cả Phase B: **đây không phải hệ thống học.** Không điểm, không trọng số học từ lịch sử, không "điểm cá nhân hóa".

Danh sách sở thích đóng, mỗi cái có tên hiển thị và trạng thái bật/tắt tường minh:

| Tên | Kiểu | Tác động cho phép | Cấm |
|---|---|---|---|
| `defaultCombo` | tên combo đã tồn tại | chọn combo khi client không chỉ định | không mở rộng allowlist |
| `tokenSaverProfile` | `off \| rtk \| rtk+headroom` | bật/tắt saver cho dự án | không cắt tool result lỗi |
| `promptTemplate` | `{templateId, version}` | chọn template **mặc định để người dùng resolve** | không chèn vào `/v1/*` |
| `preferredComboStrategy` | trong tập strategy hợp lệ | đặt `fallbackStrategy` mặc định | không ép `smart` tắt được |

Mỗi mục đều là **default có thể hoàn tác**: bỏ trong `projectSettings` là hành vi về đúng trạng thái trước Phase B. Không có cơ chế tích lũy dần theo thời gian.

Khi một sở thích thực sự làm thay đổi quyết định routing, trace ghi metadata enum (`preferenceApplied`, tên sở thích, giá trị) — **không** ghi chuỗi cấu hình tùy ý, không ghi nội dung. Đó là [PE-04]: quyết định phải truy được về một dòng cấu hình mà người dùng tự viết.

Phần `smartRoutingEnabled` của Phase A **không** được biến thành sở thích: nó là cờ opt-in an toàn đã có test và đã được T12 chặn việc bật mặc định.

## 5. Prompt Management [PT-01..05]

Xanh hoàn toàn — không có bảng, route, hay UI prompt nào trong repo. Tiền lệ duy nhất là `systemInject.js`, bộ chèn theo **wire format** đã rất kỹ (6 nhánh, idempotent theo segment, có ghi chú về kiro 400 khi gửi `systemPrompt` top-level).

```text
promptTemplates(id, name UNIQUE, builtin INTEGER, createdAt, updatedAt, archivedAt)
promptTemplateVersions(templateId, version, body, variablesJson, createdAt,
                       PRIMARY KEY(templateId, version))
```

`variablesJson` khai báo `[{name, required, type, default}]`. `body` chỉ chứa `{{tên_biến}}`. Cơ chế chặn: không có `eval`, không template-engine tùy ý; `resolve()` thay thế chuỗi và **so khớp tập biến đã dùng** với tập đã khai báo; lệch bất kỳ chiều nào ⇒ mã lỗi.

**PT-03 là ràng buộc cứng, không phải sở thích.** Không có middleware nào chèn template. Cách dùng: `GET /api/prompts/{id}/versions/{v}` trả body đã resolve, người dùng tự gửi. `/v1/*` không có header nào đọc template. Bằng chứng nghiệm thu là một test byte-identity: bật một template bất kỳ thì request `/v1/*` không đổi **một byte** nào.

**PT-04**: `CAVEMAN_PROMPTS`/`PONYTAIL_PROMPTS` được import **một lần** vào seed `builtin`, hiển thị chỉ-đọc. Tuỳ biến = tạo template riêng. Sửa đồng thời `caveman.js:8` để level không hợp lệ trả mã thay vì `undefined` im lặng.

**PT-05**: nội dung template là dữ liệu người dùng nhạy cảm. Không vào trace, không vào usage, không vào log. Export settings phải loại chúng hoặc đánh dấu rõ.

## 6. Model Benchmark [BM-01..06]

**Tập tác vụ là file trong repo, không phải row trong DB** — để review được bằng mắt và diff, và để đổi tập tác vụ là một thay đổi code đi qua review:

```text
docs/benchmarks/v1/tasks/<task-id>.json   { id, prompt, rubric, category, estTokens }
docs/benchmarks/v1/manifest.json          { version, tasks[], rubricVersion }
```

Kết quả chạy vào DB (`benchmarkRuns`, `benchmarkResults`) vì cần query theo phiên bản và so sánh.

**BM-02 là điều kiện bất di bất dịch.** Trước mỗi lần chạy: hiện ước tính (`số tác vụ × số model × giá`), phần chưa có giá hiện **“không rõ”** chứ không phải `$0`, rồi **chờ xác nhận rõ ràng**. Không lịch, không cron, không tự chạy khi boot. Con số ước tính lấy từ chính `pricingRepo` — không hardcode giá trong UI.

**BM-03** nối bằng `taskId` (`traces.taskId` đã index, `schema.js:199`). Báo cáo gồm: số request, số attempt, tỷ lệ hoàn tất, p95, **subtotal đã định giá**, và **tỷ lệ `unknown`**. `sumKnownCostSince()` (`usageRepo.js:64-81`) đã lọc `costStatus IN ('known','estimated')` — dùng đúng hàm đó, không tự `SUM(cost)` (sẽ biến `null` thành bỏ qua và ra số nhỏ giả tạo). Endpoint chưa trace được liệt kê bằng tên.

**BM-05**: chạy bằng **override cục bộ** truyền vào một lần chạy, không sửa `settings`. Bọc `try/finally` khôi phục, kể cả khi throw giữa chừng. Smart routing vẫn phải bật/tắt tường minh cho từng lần chạy.

## 7. Context Optimization: đo trước, không thêm chính sách [CX-01..06]

Thứ tự bắt buộc của lát cắt này: **đo → vá lỗ hổng đã biết → mới cân nhắc chính sách mới.**

**Bảng đo** `contextSavings(attemptId, kind, filterName, shape, bytesBefore, bytesAfter, tokensEstBefore, tokensEstAfter, skippedReason, createdAt)` — gắn `attemptId` để nối ledger. Ghi theo mẫu `pxpipe/events.jsonl` (`src/lib/pxpipe/events.js`) và trên đường `onContextSavings?.()` giống `onPxpipeEvent` (`chatCore.js:322`) — callback phải **fail-open**, không được làm hỏng request.

**CX-02 là cảnh báo thẳng vào spec**: `rtk/index.js:144` lưu `saved` theo **byte**, `formatRtkLog` in phần trăm byte, còn `estimateInputTokens()` (`usageTracking.js:343-352`) là `chars/4` — chạy trên body **đã nén** và mù CJK (`contextTier.js:69-85` có bản sửa CJK mà RTK không dùng). Hệ quả: **không thể suy ra token đã tiết kiệm từ dữ liệu sau nén**. Báo hai cột tách biệt, cột token gắn nhãn “ước lượng”, và câu chữ trong UI không bao giờ nói “đã tiết kiệm N token” như một sự thật.

**CX-03** chuyển `captureSizeSnapshot()` + `isHeadroomPhantomSavings()` (`headroom.js:32-46, 363-369`) sang dùng chung cho RTK. Ngưỡng 5% là ngưỡng đã có; giữ nguyên và ghi lại là quyết định có cơ sở.

**CX-04** gom quyết định "nén hay không" vào **một cổng** tại `compressText()` (`rtk/index.js:120-146`): nhận thêm cờ lỗi từ walker, nhận biết chuỗi lỗi cho shape OpenAI (không có field cấu trúc — buộc phải dùng heuristic `stderr`/`Traceback`/`exit code`), và Headroom phải hỏi cùng cổng trước khi chiếu `toolResults`. Sau khi sửa, `is_error === true` siết thành kiểm tra giá trị tương đương-true và `headroom.js` bỏ chiếu kết quả lỗi.

**CX-06** chốt: không thêm filter/ngưỡng mới nếu `contextSavings` chưa có số liệu trước–sau cho loại dữ liệu đó. Blob >10 MiB (`RAW_CAP`) hiện không nén nhưng vẫn vào tổng trước (`index.js:124-127`) — phải ghi `skippedReason = "over_raw_cap"` chứ không báo thành công.

## 8. Task Intelligence và Agent Orchestrator [TI-01..06, OR-01..05]

### Gắn nhãn agent trước (OR-01)

Đây là phần đầu tiên và là phần **đáng làm ngay** của roadmap mục 11. Hiện `agentLabel` chấp nhận mọi chuỗi `A-Za-z0-9._:-`, không index, không từ vựng, không ai sinh ra nó. Phase B:

- Từ vựng agent chuẩn (`claude-code`, `codex`, `cursor`, …) ở `config/`, dùng để tra **tên hiển thị** và gợi ý trong UI — **không** phải allowlist cứng: nhãn lạ vẫn lưu, chỉ mất nhãn đẹp.
- Index `idx_traces_agent`.
- Sửa `readHeader` từ *cắt rồi validate* sang *validate rồi cắt/từ chối*.
- Gộp `AGENT_LABEL_PATTERN` về một nguồn.
- Không suy ra nhãn từ `User-Agent` mà không ghi rõ: nếu làm, phải là **gợi ý** để người dùng xác nhận, không tự gán — vì header là do client kiểm soát và nhãn tuyệt đối không phải định danh.

### Điều kiện mở [OR-02]

Roadmap nói rõ: “chỉ xây điều phối khi có nhu cầu cụ thể”. Phase B ghi điều kiện mở thành **tiêu chí nghiệm thu**, không phải lời hoãn: cần một tài liệu nêu (1) việc cần làm, (2) hiện đang làm thủ công thế nào, (3) vì sao combo/fallback hiện tại không đáp ứng. Không có ⇒ mục này ghi *chưa đủ điều kiện* ở cổng. Nếu mở, [OR-03] đòi đủ bốn ràng buộc: **quyền** (deny-by-default, không bao giờ rộng hơn allowlist của key), **nhánh** (giới hạn số nhánh/độ sâu), **timeout** (mỗi nhánh + toàn bộ), **trần chi phí** (mỗi nhánh + toàn bộ). Thiếu một là chưa đạt.

Một sự thật hiện trạng cần nói thẳng: hệ thống **không có** timeout toàn request, và `panelHardTimeoutMs: 90000` là bức tường cứng duy nhất — lại **không abort** call thua (`combo.js:673-680`, chỉ resolve `{__timeout:true}` và bỏ kết quả). Bất kỳ điều phối nào mới phải sửa đúng chỗ đó, không dựa vào cơ chế timeout hiện có.

### Phân loại tác vụ [TI-01..03]

Hiện **không có** phân loại ngữ nghĩa nào — `detectRequiredCapabilities()` chỉ dò modality theo định dạng. Ba ranh giới:

1. Luật chỉ được viết khi có bằng chứng benchmark nêu tập, baseline, mức cải thiện và điều kiện hỏng ([TI-01]).
2. Phân loại sai không được gây mất dữ liệu — khác hẳn modality, nơi thiếu vision sẽ **bị lọc model** chứ không được đoán sai.
3. Kết quả là metadata tham khảo; routing theo phân loại phải opt-in và tắt được ([TI-03]).

### Chia nhỏ tác vụ ngoài `/v1/*` [TI-04..06]

`POST /api/tasks/split` — dashboard auth, **không** nằm trong `PUBLIC_API_PATHS`, và phải được thêm tường minh vào `TRACE_ENDPOINTS` nếu muốn có trace. Endpoint này **không** gọi provider trực tiếp: nó gọi lại chính endpoint `/v1/chat/completions` của gateway, nên mọi lượt con có attempt, ledger, chi phí, trace cha. Đây là cách duy nhất để [OR-04] “không có tiền mà không ghi” được bảo đảm bằng cấu trúc chứ không bằng kỷ luật.

Giới hạn bắt buộc ([TI-05]): số tác vụ con tối đa, độ sâu tối đa, timeout toàn bộ, trần chi phí. Vượt trần thì **dừng và báo**, không tự rút ngắn.

## 9. Bảo mật, rủi ro và kiểm thử [SEC-01..05]

- **Xác thực:** mọi route mới kế thừa prefix `/api/*` của `dashboardGuard.js` — deny-by-default, không bypass. `Cache-Control: no-store` trên cả 200 và lỗi. Test gọi qua middleware Next thật, không chỉ gọi thẳng `GET()`.
- **SQL injection:** mọi giá trị là `?` parameter; identifier đến từ object literal viết cứng như Phase A đã làm. Không nội suy tên bảng/cột từ input.
- **Attribution:** `projectId` chỉ đọc từ key record đã xác thực. `taskId`/`agentLabel` là nhãn. Cấu hình dự án/sở thích/template **không** bao giờ lấy từ request.
- **Dữ liệu nhạy cảm:** `contextSavings` chỉ lưu hình dạng/kích thước/filter/lý do — không lưu nội dung `tool_result`, dù đã nén. Template là nội dung người dùng, không vào trace/log. Export settings không kéo template.
- **Trùng tên:** `projectId` đã mang nghĩa *Google Cloud project id* trong credential của provider (`open-sse/services/projectId.js`, `connectionsRepo.js:174-179`). Trường mới dùng tên phân biệt; `PROJECT_ID_PATTERN` đang bị chép nhiều nơi — 3 bản giống hệt (`apiKeysRepo.js:6`, `settingsRepo.js:6`, `app/api/usage/alerts/route.js:9`) cộng 2 biến thể gần giống (`app/api/usage/analytics/route.js:12`, `app/api/usage/traces/route.js:37`) — gộp về một nguồn trước khi thêm call site.
- **Migration:** `SCHEMA_VERSION` và version migration là hai bộ đếm khác nhau, nâng cả hai; `up()` forward-only; test cold DB, DB nâng cấp có dữ liệu thật, chạy 2 lần, và adapter fallback.
- **Không đụng** `custom-server.js` (TCP peer IP, chỉ tin `X-Forwarded-For` từ loopback reverse proxy). Không thêm outbound path nào, không thêm URL đích tùy ý, không probe provider tự động.

**Kiểm thử bắt buộc:** `dispatchCount` cộng đúng usage trên cả bốn executor retry nội bộ; attribution của embeddings/image/systemone; dự án backfill idempotent và giữ nguyên lịch sử; sở thích không đổi allowlist và tắt là hành vi cũ; template byte-identity trên `/v1/*` và từ chối biến sai; benchmark chặn khi chưa duyệt chi phí và không sửa cấu hình; RTK đo trước–sau, phát hiện tiết kiệm ảo, và bảo vệ tool result lỗi trên **cả** RTK lẫn Headroom; split/orchestrate không có nhánh nào ngoài trần và mọi nhánh đều được ghi.

**Regression:** focused Vitest từ `tests/`, `node tests/__baseline__/verify-no-regression.mjs`, `npx eslint .`, `npm run build`. Full suite có known failures — dùng `tests/__baseline__/verify-no-regression.mjs` phân định, không sửa baseline để che hồi quy. Provider call chỉ chạy sau khi người dùng duyệt chi phí.