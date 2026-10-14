# Phase B — Tasks

**Trạng thái:** Toàn bộ chưa bắt đầu. Mục này là **kế hoạch**, không phải nhật ký thực thi — không mục nào được tick khi chưa có bằng chứng.
**Nguồn:** [Requirements](requirements.md) · [Design](design.md) · [`docs/ROADMAP.md`](../../../ROADMAP.md).
**Bộ trước:** [Phase A — Tasks](../2026-10-13-phase-a/tasks.md).

> Không bắt đầu task nào trước khi người dùng review/duyệt cả bộ spec. Giữ nguyên mọi sửa đổi Phase A chưa commit; không reset hay sửa baseline để che regression. Mỗi task hoàn tất khi **hành vi được test chứng minh**, không phải khi thêm API/hàm.
>
> Task gắn **[MỞ]** chỉ bắt đầu khi điều kiện mở ghi kèm đã được thỏa. Task không mở được thì chuyển sang [Khoảng trống còn lại](#khoảng-trống-còn-lại), **không** tick.

## Lát cắt 0 — chuẩn bị và chốt hợp đồng

- [ ] **T01 — Chụp hiện trạng và viết test thất bại cho các lỗ hổng.** [BD-01, BD-03, CX-01, CX-04]
  **Tệp:** `open-sse/executors/{base,codex,commandcode,mimo-free,xiaomi-mimo}.js`, `src/sse/handlers/{chat,embeddings,imageGeneration,systemone}.js`, `open-sse/rtk/{index,headroom,systemInject}.js`, `src/lib/db/{schema,migrate}.js`, `tests/unit/*`.
  **Việc làm:** đối chiếu dirty diff hiện có; lập bảng "dispatch có tính phí" cho từng executor (hiện `codex.js:279-327`, `commandcode.js:42-60`, `mimo-free.js:131-159`, `xiaomi-mimo.js:90-112`); xác nhận 3 handler ghi usage không attribution; xác nhận RTK không có mốc trước và `contextSavings` chưa tồn tại; đo **nền hiện tại** của `benchmark*` (hiện chỉ có `db-benchmark.test.js` đo SQLite). Viết test tái hiện nhưng không đụng hợp đồng `/v1/*`.
  **Hoàn thành khi:** có bảng đường đi dispatch→attempt→ledger, và test phân biệt được baseline hiện tại với đích.
  > Chưa làm. Chưa có bằng chứng.

## Lát cắt 1 — nền tảng đo (phụ thuộc T01)

- [ ] **T02 — Đếm đúng mọi dispatch có tính phí.** [BD-01]
  **Tệp:** `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/attemptTrace.js`, `open-sse/executors/{codex,commandcode,mimo-free,xiaomi-mimo}.js`, `src/lib/db/schema.js`, `src/lib/db/migrations/006-*.js`, `src/lib/db/repos/{traceRepo,usageRepo}.js`.
  **Việc làm:** thêm `dispatchCount` (mặc định 1) trên `traceAttempts`/`usageHistory`; executor trả về số lượt thực sự gửi qua một kênh callback đã có; `commandcode.js` chuyển `maxRetries` hardcode về `this.config.retry`; usage và cost cộng trên **tổng** các lượt. Không phá vỡ quan hệ "1 execute = 1 attempt" đang có test.
  **Test:** từng executor retry nội bộ → `dispatchCount` đúng và tổng token khớp số lượt gửi; không có double count; migration cold/upgrade/lặp lại; ledger không nhân aggregate.
  **Hoàn thành khi:** thiếu tiền do retry nội bộ bị đo bằng số trước/sau, và **khoảng cách với provider thật được công bố** (kể cả khi còn dư).
  > Chưa làm. Đây là điều kiện tiên quyết cho mọi so sánh chi phí của Phase B.

- [ ] **T03 — Attribution cho các endpoint chưa có.** [BD-03]
  **Tệp:** `src/sse/handlers/{embeddings,imageGeneration,systemone}.js`, `src/lib/traceCoverage.js`.
  **Việc làm:** truyền `apiKeyId`/`projectId` từ `getKeyAccessContext()` mà handler đã gọi sẵn; không thêm mốc trả ngược lần thứ hai; giữ nguyên response gateway. Với endpoint quyết định **không** instrument: nêu đích danh trong `traceCoverage.js` để chi phí là **unknown**, không phải `$0`.
  **Test:** mỗi endpoint success/error; rows có projectId đúng; rows của key không hợp lệ vẫn `null`; disclosure liệt kê đúng những gì chưa phủ.
  **Hoàn thành khi:** ngân sách theo dự án không còn thiếu tiền của endpoint nào trong im lặng.

- [ ] **T04 — Đo tiết kiệm context thay vì in ra console.** [CX-01, CX-02, CX-03, CX-05, CX-06]
  **Tệp:** `open-sse/rtk/{index,headroom}.js`, `open-sse/handlers/chatCore.js`, `src/lib/db/{schema,migrate}.js`, `src/lib/db/repos/traceRepo.js`, `src/lib/db/migrations/006-*.js`, bảng `contextSavings`.
  **Việc làm:** snapshot byte **trước và sau** quanh lời gọi RTK (theo mẫu `captureSizeSnapshot()` `headroom.js:32-46`); ghi theo attempt qua callback fail-open giống `onPxpipeEvent` (`chatCore.js:322`); đưa `isHeadroomPhantomSavings()` dùng chung cho cả hai; ghi `skippedReason` cho mọi nhánh bỏ qua kể cả `RAW_CAP` (`index.js:124-127`); `systemInject.js` ghi lỗi đếm được thay vì `catch (_) {}`.
  **Test:** trước/sau khớp byte thật; phát hiện tiết kiệm ảo khi proxy báo nhưng body không co; `over_raw_cap` không báo thành công; callback lỗi không làm hỏng request; byte và token là **hai cột riêng**, cột token gắn nhãn ước lượng.
  **Hoàn thành khi:** có số liệu trước–sau theo attempt, và UI không bao giờ phát biểu token tiết kiệm như sự thật (ước lượng `chars/4` mù CJK, chạy trên body đã nén).

## Lát cắt 2 — Project Workspace (phụ thuộc T03)

- [ ] **T05 — Thực thể dự án + migration backfill.** [PW-01, SEC-05]
  **Tệp:** `src/lib/db/schema.js`, `src/lib/db/migrations/006-*.js`, `src/lib/db/repos/projectsRepo.js`, `src/lib/db/index.js`.
  **Việc làm:** `projects(id, label, archivedAt, createdAt, updatedAt)` với `id` **bằng** `projectId` đang chạy; backfill hợp nhất từ `apiKeys.projectId` và khóa của `budget.projects`; nâng **cả** `SCHEMA_VERSION` lẫn version migration; ledger không đặt FK. Không viết lại `traces.projectId`/`usageHistory.projectId`.
  **Test:** cold DB; DB có dữ liệu thật; chạy 2 lần không trùng; key đã gắn trỏ đúng; key chưa gắn vẫn `null`; xoá mềm không phá lịch sử.
  **Hoàn thành khi:** mọi `projectId` đang tồn tại đều có dự án, và báo cáo Phase A không đổi số.

- [ ] **T06 — Không gian cấu hình dự án + combo mặc định.** [PW-02, PE-01, PE-02, SEC-04]
  **Tệp:** `src/lib/db/repos/settingsRepo.js`, `src/app/api/settings/route.js`, `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, `src/sse/utils/traceCoordinator.js`.
  **Việc làm:** `settings.projectSettings` theo khuôn `comboStrategies` — shape đóng, từ chối key lạ, có trần entry, **normalize trong `mergeWithDefaults()`** (hiện `comboStrategies` không được normalize — sửa luôn). Combo mặc định chỉ áp khi: có `ctx`, có `projectId`, combo tồn tại, và `enforceKeyAccess(ctx, combo)` **không** trả 403. Không mở rộng allowlist. Ghi metadata quyết định vào trace.
  **Test:** không có dự án thì hành vi y như cũ; combo mặc định ngoài allowlist thì **không** dùng; key restricted không nới quyền; `ctx = null` (local/no-key) thì không thay; combo không tồn tại ⇒ ghi `fallbackReason`; settings hỏng rơi về mặc định an toàn chứ không throw ra request.
  **Hoàn thành khi:** default dự án chỉ thu hẹp, không bao giờ nới; tắt là hành vi cũ.

- [ ] **T07 — API quản lý dự án.** [PW-01, PW-03, PW-05, SEC-01, SEC-02]
  **Tệp:** `src/app/api/projects/**`, `src/app/api/projects/[id]/preferences/route.js`, `src/lib/db/repos/projectsRepo.js`.
  **Việc làm:** CRUD dự án (xoá = archive), gán/gỡ key, đọc/ghi `projectSettings`; ngân sách vẫn đọc từ `budget.projects` nên `evaluateBudgetAlerts()` không đổi; dashboard auth, deny-by-default, `no-store`, `TypeError → 400`, lỗi nội bộ 500 message chung. Không endpoint nào đọc project từ request.
  **Test:** qua middleware Next thật (401/403); ID sai định dạng 400; body thừa key bị từ chối; archive không mất cảnh báo đã phát; ngân sách sau khi có entity vẫn đúng mốc UTC và một cảnh báo/ngưỡng/kỳ.
  **Hoàn thành khi:** vòng đời dự án hoạt động qua API mà không đổi ngữ nghĩa budget của Phase A.

- [ ] **T08 — Màn dự án trên dashboard.** [PW-04, PW-05]
  **Tệp:** `src/app/(dashboard)/dashboard/projects/**`, `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`.
  **Việc làm:** tạo/đổi tên/archive, gán-gỡ key, xem thành viên, combo mặc định, ngân sách; thêm chọn dự án vào trang key (hiện `EndpointPageClient.js` **không** đọc `projectId`). Hiển thị **đúng hiện trạng** khi các key cùng `projectId` mang `projectLabel` khác nhau — không tự chọn một nhãn.
  **Test:** UI với fixture nhiều key/ít key/không dự án; keyboard và accessibility; không hiện raw key ngoài trang key hiện có; số liệu khớp API.
  **Hoàn thành khi:** người dùng gán dự án và thấy hệ quả (thành viên, ngân sách, combo mặc định) mà không cần sửa tay file.

## Lát cắt 3 — Prompt Management (phụ thuộc T05)

- [ ] **T09 — Lưu template có phiên bản bất biến + engine resolve.** [PT-01, PT-02]
  **Tệp:** `src/lib/db/schema.js`, `src/lib/db/migrations/006-*.js`, `src/lib/db/repos/promptRepo.js`.
  **Việc làm:** `promptTemplates` + `promptTemplateVersions`; sửa nội dung tạo version mới, version cũ vẫn resolve được; `variablesJson` khai báo `{name, required, type, default}`; `resolve()` chỉ thay `{{tên}}` và so khớp tập biến dùng với tập khai báo. **Không** `eval`, không template-engine tùy ý.
  **Test:** version cũ không đổi sau khi sửa; thiếu biến bắt buộc, thừa biến, sai kiểu, tên biến trùng/lạ ⇒ mã lỗi chứ không thay thế im lặng; xoá template không xoá version đã dùng.
  **Hoàn thành khi:** mọi cách sai với biến đều **thất bại rõ ràng**.

- [ ] **T10 — Tích hợp chỉ-đọc + từ chối im lặng.** [PT-03, PT-04, CX-05]
  **Tệp:** `open-sse/rtk/cavemanPrompts.js`, `open-sse/rtk/ponytailPrompt.js`, `open-sse/rtk/{caveman,ponytail,systemInject}.js`, `src/lib/db/migrations/006-*.js`, `src/sse/handlers/chat.js`.
  **Việc làm:** seed prompt tích hợp sẵn thành template `builtin` từ **một nguồn import duy nhất**, chỉ đọc; sửa level không hợp lệ (`caveman.js:8` trả `undefined` ⇒ `systemInject.js:13` no-op) thành mã lỗi. **Không** thêm middleware nào chèn template vào body.
  **Test (quan trọng):** **byte-identity** — bật template bất kỳ thì request `/v1/*` không đổi một byte; level sai trả mã lỗi chứ không im lặng; template builtin không sửa được qua API.
  **Hoàn thành khi:** [PT-03] được chứng minh bằng test byte-identity, không bằng lập luận.

- [ ] **T11 — API + UI template.** [PT-05, SEC-01, SEC-03]
  **Tệp:** `src/app/api/prompts/**`, `src/app/(dashboard)/dashboard/prompts/**`, `src/app/api/settings/route.js`.
  **Việc làm:** CRUD template/version, endpoint resolve trả body đã thay biến (người dùng tự gửi); UI duyệt chênh lệch giữa version. Nội dung template không vào trace/log; `exportSettings()` không kéo template hoặc phải đánh dấu rõ.
  **Test:** auth thật; body/response không chứa payload/secret ngoài phạm vi template API; export không rò template.
  **Hoàn thành khi:** có thể tái dùng template có phiên bản mà `/v1/*` không hề biết.

## Lát cắt 4 — Benchmark (phụ thuộc T02, T04)

- [ ] **T12 — Tập tác vụ coding v1.** [BM-01]
  **Tệp:** `docs/benchmarks/v1/manifest.json`, `docs/benchmarks/v1/tasks/*.json`.
  **Việc làm:** 10–20 tác vụ coding đại diện, mỗi cái có id ổn định, prompt đóng gói, **thang chấm điểm định nghĩa trước** và `estTokens`. Tập nằm trong repo để review bằng mắt và diff; đổi tác vụ/thang chấm phải tăng `version`.
  **Test:** manifest hợp lệ, id duy nhất, mọi task có rubric; validator chạy offline không cần provider.
  **Hoàn thành khi:** tập được review và thang chấm viết **trước** khi có kết quả — không chấm sau khi đã thấy kết quả.

- [ ] **T13 — Runner thủ công có cổng duyệt chi phí.** [BM-02, BM-03, BM-05]
  **Tệp:** `src/app/api/benchmarks/**`, `src/lib/db/{schema,migrate}.js`, `src/lib/db/repos/benchmarkRepo.js`, `tests/unit/*`.
  **Việc làm:** `POST` dựng lần chạy + **ước tính chi phí** từ `pricingRepo` (phần chưa có giá hiện **“không rõ”**, không phải `$0`); chỉ chạy khi có xác nhận rõ ràng; gọi lại chính `/v1/*` với `taskId` riêng từng task; kết quả nối ledger bằng `taskId`; **không** sửa `settings` (override cục bộ + `try/finally` khôi phục kể cả khi throw). Không lịch, không cron, không tự chạy khi boot.
  **Test:** không có xác nhận thì **không** phát provider call (assert bằng mock executor); ước tính đúng với giá thiếu; `cost = null` không thành `$0`; endpoint chưa trace được liệt kê tên; chạy lỗi giữa chừa vẫn khôi phục cấu hình.
  **Hoàn thành khi:** không tồn tại đường nào phát provider call ngoài lúc người dùng xác nhận.

- [ ] **T14 — Báo cáo và so sánh.** [BM-04, BM-06, SEC-03]
  **Tệp:** `src/app/api/benchmarks/**`, `src/app/(dashboard)/dashboard/benchmarks/**`, `src/app/(dashboard)/dashboard/usage/components/phaseA/**`.
  **Việc làm:** kết quả bất biến, truy vết model/combo/cấu hình/token/chi phí/trạng thái/thời điểm; so sánh thứ tự cố định vs smart opt-in và giữa các lần chạy; **tách** điểm người đánh giá khỏi số liệu máy đo (chi phí, latency, tỷ lệ hoàn tất), không gộp một điểm; hiển thị tỷ lệ `unknown` cạnh mọi tổng tiền.
  **Test:** hai lần chạy khác config so sánh được; số liệu khớp API/ledger; không có ô nào in `$0` khi thực ra là chưa biết; palette validate light/dark trước khi ship UI.
  **Hoàn thành khi:** người dùng nhìn một màn và trả lời được "model nào rẻ hơn trên **tác vụ của tôi**, và ta không biết bao nhiêu".

## Lát cắt 5 — Vá lỗ hổng đã biết của context [CX-04] (phụ thuộc T04)

- [ ] **T15 — Một cổng quyết định "được nén hay không".** [CX-04]
  **Tệp:** `open-sse/rtk/index.js`, `open-sse/rtk/headroom.js`, `open-sse/rtk/filters/*.js`, `tests/unit/{rtk,rtkKiro}.test.js`.
  **Việc làm:** gom quyết định vào `compressText()` (`index.js:120-146`); bổ sung bảo vệ lỗi cho shape tool result kiểu OpenAI (hiện `index.js:44-61` **không** kiểm tra gì — buộc phải dùng heuristic nội dung vì không có field cấu trúc); siết `is_error === true` (`index.js:67`) và `status === "error"` (`index.js:103`); **`headroom.js:132-146` phải hỏi cùng cổng** — hiện nó chiếu mọi `toolResults` nên bật Headroom là vô hiệu hoá lớp bảo vệ của RTK.
  **Test:** lỗi bằng mọi hình thức (`true`/`"true"`/`1`, stderr, `Traceback`, `exit code N`) đều giữ nguyên; lỗi qua **cả** RTK lần Headroom; kết quả thành công vẫn nén; không lỗi nào thoát ra ngoài (fail-open giữ nguyên).
  **Hoàn thành khi:** bật Headroom **không còn** lách được quy tắc "không cắt tool result lỗi".

## Lát cắt 6 — Nhãn agent và phân loại tác vụ (phụ thuộc T12, T14)

- [ ] **T16 — Gắn nhãn coding agent bên ngoài.** [OR-01, SEC-02, SEC-04]
  **Tệp:** `src/sse/utils/traceCoordinator.js`, `src/lib/db/repos/traceRepo.js`, `src/lib/db/schema.js`, `src/lib/db/migrations/006-*.js`, `open-sse/config/*`.
  **Việc làm:** gộp `AGENT_LABEL_PATTERN` đang chép ở 2 nơi về một nguồn; sửa `readHeader` (`traceCoordinator.js:38-44`) từ **cắt rồi validate** sang validate rồi từ chối; thêm index `idx_traces_agent`; từ vựng agent chuẩn ở `config/` cho **tên hiển thị và gợi ý** (không phải allowlist cứng); UI chọn/gợi ý nhãn. Nhãn vẫn **không phải định danh**.
  **Test:** header quá dài bị **từ chối** chứ không bị cắt ngắn; nhãn lạ vẫn lưu được; header giả không cấp quyền gì; nếu suy ra nhãn từ `User-Agent` thì phải là **gợi ý** để xác nhận, không tự gán.
  **Hoàn thành khi:** có thể nhìn "nhóm theo coding agent" trên dashboard mà không mở rộng bất kỳ quyền nào.

- [ ] **T17 — Luật phân loại chỉ khi benchmark có bằng chứng.** [TI-01, TI-02, TI-03] **[MỞ]**
  **Tệp:** `src/lib/taskClassifier.js`, `open-sse/services/combo.js`, `src/sse/handlers/chat.js`, `src/lib/db/repos/traceRepo.js`.
  **Điều kiện mở:** có ít nhất một câu hỏi trả lời được sau ít nhất một lần chạy benchmark: “luật X giúp giảm chi phí / tăng tỷ lệ hoàn tất bao nhiêu, trên tập nào, và khi nào hỏng?”
  **Việc làm:** mỗi luật phải **trích dẫn** bằng chứng cụ thể; tách bạch khỏi `detectRequiredCapabilities()` (`combo.js:246-249`) vì đó là định dạng chứ không phải ý định; kết quả là metadata tham khảo, routing theo phân loại phải opt-in và tắt được; luôn có đường lùi về hành vi hiện tại khi không chắc.
  **Test:** luật thiếu bằng chứng thì không tồn tại trong code; phân loại sai không làm mất dữ liệu đầu vào; tắt là hành vi cũ; không đụng `HARD_CAPS`.
  **Hoàn thành khi:** có bằng chứng dẫn đường cho từng luật — không có thì ghi *chưa đủ điều kiện*, không viết luật số.

- [ ] **T18 — Chia nhỏ tác vụ ngoài `/v1/*`.** [TI-04, TI-05, TI-06, SEC-01]
  **Tệp:** `src/app/api/tasks/split/route.js`, `src/sse/utils/traceCoordinator.js` (`TRACE_ENDPOINTS`), `src/lib/db/repos/traceRepo.js`.
  **Việc làm:** endpoint dùng **dashboard auth**, không nằm trong `PUBLIC_API_PATHS`; **không** gọi provider trực tiếp — gọi lại chính `/v1/chat/completions` của gateway để mọi lượt con đều có attempt, ledger, chi phí và trace cha; thêm endpoint vào `TRACE_ENDPOINTS` **tường minh**; giới hạn số tác vụ con, độ sâu, timeout toàn bộ, trần chi phí. Vượt trần thì **dừng và báo**, không tự rút ngắn.
  **Test:** auth thật 401/403; mọi lượt con xuất hiện trong trace/ledger; không có đường gọi provider đi vòng; vượt trần dừng đúng và báo; không có lịch tự chạy.
  **Hoàn thành khi:** không có một đồng nào phát sinh ngoài ý muốn, và không có lượt con nào không được ghi.

## Lát cắt 7 — Agent Orchestrator (phụ thuộc T16, T18) **[MỞ]**

- [ ] **T19 — Chứng minh nhu cầu trước khi xây.** [OR-02]
  **Tệp:** `docs/superpowers/specs/2026-10-14-phase-b/orchestrator-need.md`.
  **Điều kiện mở:** tài liệu nêu (1) việc cần làm gì, (2) hiện đang làm thủ công thế nào, (3) vì sao combo/fallback hiện tại không đáp ứng.
  **Hoàn thành khi:** tài liệu tồn tại và được người dùng chấp nhận. **Không có tài liệu thì task này không hoàn thành bằng cách xây code.**
  > Nếu không mở được: ghi vào [Khoảng trống còn lại](#khoảng-trống-còn-lại) và dừng ở đây. Đây là kết quả **hợp lệ** của Phase B, không phải thất bại.

- [ ] **T20 — Điều phối có giới hạn, chỉ khi T19 mở.** [OR-03, OR-04, OR-05, SEC-01]
  **Điều kiện mở:** T19 hoàn thành.
  **Tệp:** `src/app/api/orchestrations/**`, `src/sse/handlers/chat.js`, `open-sse/services/combo.js`, `src/lib/db/repos/traceRepo.js`.
  **Việc làm:** nếu xây thì phải đủ **bốn** ràng buộc: **quyền** (deny-by-default, không bao giờ rộng hơn allowlist của key), **nhánh** (trần số nhánh/độ sâu), **timeout** (mỗi nhánh + toàn bộ), **trần chi phí** (mỗi nhánh + toàn bộ). Ngoài `/v1/*`, dashboard auth. Mọi nhánh là attempt con của **một** trace cha. Khi chạm ngưỡng thì **abort** phần còn chạy — không chỉ bỏ kết quả.
  **Lưu ý khi thiết kế:** hiện `panelHardTimeoutMs: 90000` là bức tường cứng duy nhất và **không abort** call thua (`combo.js:673-680` chỉ resolve `{__timeout:true}`); cơ chế timeout hiện có **không** dùng lại được cho nhánh. Sửa đúng chỗ đó.
  **Test:** nhánh vượt allowlist bị chặn; timeout/trần chi phí dừng và abort; không nhánh nào trả tiền mà không ghi; không có đường gọi provider ngoài ledger; không endpoint nào public.
  **Hoàn thành khi:** đủ bốn ràng buộc và có test cho **từng** thứ; thiếu một thứ thì không tính là đạt.

## Lát cắt 8 — cổng chất lượng Phase B (phụ thuộc tất cả)

- [ ] **T21 — Bảo mật, regression và Phase B exit gate.** [SEC-01..05, BD-02]
  **Tệp:** `tests/unit/*`, integration tests theo pattern repo, `tests/__baseline__/verify-no-regression.mjs`, `CHANGELOG.md`.
  **Việc làm:** rà auth deny-by-default cho mọi API mới, attribution, redaction (template/`contextSavings` không lỗi payload/secret), proxy/IP/SSRF, không provider probe tự động; `npx eslint .`; `npm run build`; offline Vitest + baseline verification, known failures báo riêng. **Sau khi người dùng duyệt chi phí**, chạy một tập tác vụ coding thật và đối chiếu ledger với provider.
  **Hoàn thành khi:** cổng [`requirements.md`](requirements.md#cổng-hoàn-thành-phase-b) có bằng chứng và mọi lỗi được báo trung thực; mọi mục **[MỞ]** hoặc có bằng chứng mở, hoặc được ghi rõ *chưa đủ điều kiện*.

## Khoảng trống còn lại (chưa đóng)

Bảng này **bắt đầu trống** và được cập nhật khi thực thi. Không điền trước khi có bằng chứng.

| # | Khoảng trống | Tác động | Điều kiện đóng |
|---|---|---|---|
| — | *(chưa có)* | — | — |

Các khoảng trống **kế thừa** từ Phase A và chưa đóng: xem [Phase A — Khoảng trống còn lại](../2026-10-13-phase-a/tasks.md#khoảng-trống-còn-lại-chưa-đóng) (`K1` → T02, `K2`, `K3` → T03/T04). `K2` (`db-concurrent` gộp row khi thiếu `attemptId`) **không** thuộc Phase B và không được dùng làm lý do trì hoãn.

## Ma trận phụ thuộc và coverage

`T01 → T02/T03/T04 → T05 → T06/T07 → T08`; `T05 → T09 → T10/T11`; `T02+T04 → T12 → T13 → T14`; `T04 → T15`; `T12+T14 → T16/T17 → T18 → T19 → T20`; `T21` chốt tất cả.

`BD-*`: T02, T03, T21. `PW-*`: T05–T08. `PE-*`: T06 (định nghĩa), T08. `PT-*`: T09–T11. `BM-*`: T12–T14, T21. `CX-*`: T04, T15. `TI-*`: T17, T18. `OR-*`: T16, T19, T20. `SEC-*`: mọi lát cắt, kiểm soát cuối T21.

## Lệnh kiểm chứng

Từ `tests/`: `./node_modules/.bin/vitest run unit/<file>.test.js --config vitest.config.js`.
Từ root: `node tests/__baseline__/verify-no-regression.mjs`, `npx eslint .`, `npm run build`.
Provider call **chỉ** sau khi người dùng duyệt chi phí. Không sửa `tests/__baseline__/current.json` hay snapshot nào khi chưa giải thích chênh lệch.