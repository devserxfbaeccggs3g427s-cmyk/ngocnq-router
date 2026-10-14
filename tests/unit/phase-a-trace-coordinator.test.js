import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let traceRepo;
let adapter;
let coordinator;

const chatRequest = (headers = {}) => ({
  url: "https://gw.local/v1/chat/completions?secret=leaked-in-query",
  headers: new Headers({
    "content-type": "application/json",
    "x-9router-task-id": "build-42",
    "x-9router-agent-label": "claude-code",
    ...headers,
  }),
  signal: new AbortController().signal,
});

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-trace-coordinator-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  traceRepo = await import("@/lib/db/repos/traceRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  coordinator = await import("@/sse/utils/traceCoordinator.js");
  await db.updatePricing({ "coord-test": { "priced": { input: 2_000_000, output: 0 } } });
});

afterAll(() => {
  adapter?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const makeTrace = (overrides = {}) => coordinator.createTraceCoordinator({
  request: chatRequest(),
  requestedModel: "priced",
  keyAccess: { keyId: "key-1", projectId: "team:alpha" },
  ...overrides,
});

describe("Phase A parent trace coordinator (T05)", () => {
  it("writes exactly one parent, attributed to the validated key and project", async () => {
    const ctx = await makeTrace();
    expect(ctx.enabled).toBe(true);
    const rows = adapter.all("SELECT * FROM traces");
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(ctx.requestId);
    expect(rows[0].apiKeyId).toBe("key-1");
    expect(rows[0].projectId).toBe("team:alpha");
    expect(rows[0].taskId).toBe("build-42");
    expect(rows[0].agentLabel).toBe("claude-code");
    expect(rows[0].status).toBe("pending");

    await ctx.finish("success", 200);
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("success");
  });

  it("never stores the raw request line, only an allow-listed endpoint", async () => {
    const ctx = await makeTrace();
    const row = adapter.get("SELECT endpoint FROM traces WHERE requestId = ?", [ctx.requestId]);
    // The query string carried a marker; it must not be reachable from any column.
    expect(row.endpoint).toBe("/v1/chat/completions");
    const serialized = JSON.stringify(adapter.get("SELECT * FROM traces WHERE requestId = ?", [ctx.requestId]));
    expect(serialized).not.toContain("leaked-in-query");
    await ctx.finish("success", 200);
  });

  it("records an unknown endpoint instead of echoing an arbitrary path", async () => {
    const ctx = await makeTrace({ request: { url: "https://gw.local/v1/../../etc/passwd", headers: new Headers() } });
    expect(adapter.get("SELECT endpoint FROM traces WHERE requestId = ?", [ctx.requestId]).endpoint).toBe("unknown");
    await ctx.finish("error", 400);
  });

  it("drops a malformed task id or agent label rather than storing it", async () => {
    const ctx = await makeTrace({
      request: chatRequest({ "x-9router-task-id": "<script>alert(1)</script>", "x-9router-agent-label": "a".repeat(500) }),
    });
    const row = adapter.get("SELECT taskId, agentLabel FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(row.taskId).toBeNull();
    expect(row.agentLabel).toBeNull();
    await ctx.finish("success", 200);
  });

  it("bounds an oversized but pattern-valid task id", async () => {
    const ctx = await makeTrace({ request: chatRequest({ "x-9router-task-id": "a".repeat(400) }) });
    const row = adapter.get("SELECT taskId FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(row.taskId.length).toBeLessThanOrEqual(128);
    await ctx.finish("success", 200);
  });

  it("records one child attempt per dispatch, including failures", async () => {
    const ctx = await makeTrace();
    for (const model of ["priced", "priced"]) {
      const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model, connectionId: "account-1" });
      expect(attempt.attemptId).toBeTruthy();
      await ctx.onTraceFinish({
        attemptId: attempt.attemptId,
        status: "error",
        httpStatus: 429,
        ttftMs: null,
        durationMs: 40,
        tokens: null,
        tokenSource: "unknown",
      });
    }
    const attempts = adapter.all("SELECT * FROM traceAttempts WHERE requestId = ?", [ctx.requestId]);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === "error")).toBe(true);
    await ctx.finish("error", 429, "rate_limit");
  });

  it("bills an attempt once, at its terminal time, under one usageHistory row", async () => {
    const ctx = await makeTrace();
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced", connectionId: "account-1" });
    const payload = {
      attemptId: attempt.attemptId, status: "success", httpStatus: 200,
      ttftMs: 12, durationMs: 90, tokens: { prompt_tokens: 100, completion_tokens: 5 }, tokenSource: "upstream",
    };
    await ctx.onTraceFinish(payload);
    // A second terminal callback for the same dispatch must not bill twice.
    await ctx.onTraceFinish(payload);
    await ctx.finish("success", 200);

    const usage = adapter.all("SELECT * FROM usageHistory WHERE attemptId = ?", [attempt.attemptId]);
    expect(usage).toHaveLength(1);
    expect(usage[0].cost).toBe(200);   // 100 prompt tokens @ $2/M
    expect(usage[0].apiKeyId).toBe("key-1");
    expect(usage[0].projectId).toBe("team:alpha");
    expect(usage[0].endpoint).toBe("/v1/chat/completions");
  });

  it("marks an unpriced attempt as unknown cost, never zero", async () => {
    const ctx = await makeTrace({ requestedModel: "no-such-model" });
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "no-such-model" });
    await ctx.onTraceFinish({
      attemptId: attempt.attemptId, status: "success", httpStatus: 200, ttftMs: 5, durationMs: 60,
      tokens: { prompt_tokens: 50, completion_tokens: 5 }, tokenSource: "upstream",
    });
    await ctx.finish("success", 200);
    const row = adapter.get("SELECT cost, costStatus FROM traceAttempts WHERE attemptId = ?", [attempt.attemptId]);
    expect(row.cost).toBeNull();
    expect(row.costStatus).toBe("unknown");
    // ...and the parent aggregate must not claim the request was free.
    const parent = adapter.get("SELECT cost, costStatus FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(parent.cost).toBeNull();
    expect(parent.costStatus).toBe("unknown");
  });

  it("stores no prompt, output, header or token counter on the attempt row", async () => {
    const ctx = await makeTrace();
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced", connectionId: "account-1" });
    // Counters chosen so they cannot collide with the derived cost (priced at
    // $2/M input => cost is exactly double, and 42 would appear either way).
    await ctx.onTraceFinish({
      attemptId: attempt.attemptId, status: "success", httpStatus: 200, ttftMs: 5, durationMs: 60,
      tokens: { prompt_tokens: 70001, completion_tokens: 80003 }, tokenSource: "upstream",
    });
    await ctx.finish("success", 200);

    const columns = adapter.all("PRAGMA table_info(traceAttempts)").map((c) => c.name);
    expect(columns).not.toContain("tokensJson");
    const row = adapter.get("SELECT * FROM traceAttempts WHERE attemptId = ?", [attempt.attemptId]);
    // Provenance + billing outcome only. The counters themselves live in usageHistory.
    expect(JSON.stringify(row)).not.toContain("70001");
    expect(JSON.stringify(row)).not.toContain("80003");
    expect(row.cost).toBe(140002);          // 70001 * $2/M, i.e. genuinely billed
    expect(columns).toEqual(expect.arrayContaining(["provider", "model", "connectionId", "status", "cost", "costStatus"]));
    // ...and they really are readable from the ledger.
    const usage = adapter.get("SELECT promptTokens, completionTokens FROM usageHistory WHERE attemptId = ?", [attempt.attemptId]);
    expect(usage.promptTokens).toBe(70001);
    expect(usage.completionTokens).toBe(80003);
  });

  it("exposes numeric usage through getTrace only under the nested usage key", async () => {
    const ctx = await makeTrace();
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced" });
    await ctx.onTraceFinish({
      attemptId: attempt.attemptId, status: "success", httpStatus: 200, ttftMs: 5, durationMs: 60,
      tokens: { prompt_tokens: 30, completion_tokens: 4 }, tokenSource: "upstream",
    });
    await ctx.finish("success", 200);

    const detail = await traceRepo.getTrace(ctx.requestId);
    expect(detail.metricsJson).toBeTruthy();   // internal column, not part of the response contract
    expect(detail.attempts[0].usage).toEqual({
      promptTokens: 30, completionTokens: 4, totalTokens: 34, cost: 60, costStatus: "known",
    });
    expect(detail.attempts[0]).not.toHaveProperty("tokens");
  });

  it("reports a request that never dispatched as unknown-cost, not free", async () => {
    const ctx = await makeTrace();
    await ctx.finish("error", 404, "model_not_found");
    const detail = await traceRepo.getTrace(ctx.requestId);
    expect(detail.status).toBe("error");
    expect(detail.cost).toBeNull();
    expect(detail.attempts).toEqual([]);
  });

  it("records the resolved combo, provider and account as metadata", async () => {
    const ctx = await makeTrace({ comboName: "fast" });
    await ctx.noteRouting({ comboName: "fast", provider: "coord-test", accountId: "account-7" });
    await ctx.noteRouting({
      metrics: {
        policyVersion: "smart-routing-v1", smartApplied: true,
        eligibleModels: ["a/1", "b/2"],
      },
    });
    await ctx.finish("success", 200);

    const row = adapter.get("SELECT comboName, provider, accountId, metricsJson FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(row.comboName).toBe("fast");
    expect(row.provider).toBe("coord-test");
    expect(row.accountId).toBe("account-7");
    expect(JSON.parse(row.metricsJson)).toMatchObject({ policyVersion: "smart-routing-v1", smartApplied: true });
  });

  it("refuses to rewrite routing metadata after the trace is terminal", async () => {
    const ctx = await makeTrace();
    await ctx.finish("success", 200);
    await ctx.noteRouting({ provider: "late-arrival" });
    const row = adapter.get("SELECT provider FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(row.provider).toBeNull();
  });

  it("is idempotent: finishing twice keeps the first terminal state", async () => {
    const ctx = await makeTrace();
    await ctx.finish("success", 200);
    await ctx.finish("error", 500, "upstream_error");
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("success");
  });

  it("terminalizes the parent when a streaming response body completes", async () => {
    const ctx = await makeTrace();
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

    const wrapped = ctx.wrap(upstream);
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("pending");
    await wrapped.text();
    // Let the reader's terminal pull finish.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("success");
  });

  it("terminalizes the parent as cancelled when the client aborts mid-stream", async () => {
    const ctx = await makeTrace();
    const controller = new AbortController();
    const request = { ...chatRequest(), signal: controller.signal };
    const ctxWithSignal = await coordinator.createTraceCoordinator({ request, requestedModel: "priced" });

    const upstream = new Response(
      new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); },
      }),
      { status: 200 }
    );
    const wrapped = ctxWithSignal.wrap(upstream);
    const reader = wrapped.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = adapter.get("SELECT status, reason FROM traces WHERE requestId = ?", [ctxWithSignal.requestId]);
    expect(row.status).toBe("cancelled");
    expect(row.reason).toBe("cancelled");
    expect(ctx.enabled).toBe(true);
  });

  it("produces a working no-op coordinator when the parent cannot be created", async () => {
    const broken = await coordinator.createTraceCoordinator({ request: null, requestedModel: null });
    expect(broken.enabled).toBe(false);
    expect(broken.onTraceBegin).toBeNull();
    const response = new Response("ok", { status: 200 });
    expect(broken.wrap(response)).toBe(response);
    await expect(broken.finish("success", 200)).resolves.toBeUndefined();
  });

  it("generates a distinct UUID per request so parents never collide", async () => {
    const a = await makeTrace();
    const b = await makeTrace();
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await a.finish("success", 200);
    await b.finish("success", 200);
  });
});

/**
 * T04's acceptance condition is "không đổi byte response /v1/*". Tracing wraps the
 * upstream response to learn when it really ends, so the claim has to be proven
 * against a byte stream — not inferred from the code reading correctly.
 */
describe("Phase A tracing does not alter the /v1 response (T04)", () => {
  // Multi-byte characters (✓, ✗, 🚀) and a deliberately truncated final frame:
  // anything that re-encodes, concatenates via string, or normalizes newlines
  // changes these bytes.
  const PAYLOAD = [
    'data: {"choices":[{"delta":{"content":"héllo ✓"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" 🚀"}}]}\n\n',
    "data: [DONE]\n\n",
    "data: {\"partial\":",   // no terminator — must survive being chunked
  ].join("");

  /** Split at byte offsets that deliberately cut through multi-byte characters. */
  function chunkedResponse(bytes, boundaries, headers) {
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const [start, end] of boundaries) controller.enqueue(bytes.slice(start, end));
          controller.close();
        },
      }),
      { status: 200, headers }
    );
  }

  async function readAllBytes(response) {
    const reader = response.body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }

  it("reproduces the upstream body byte-for-byte across hostile chunk boundaries", async () => {
    const original = Buffer.from(PAYLOAD, "utf8");
    // Offsets chosen to slice mid-codepoint rather than at frame boundaries.
    const boundaries = [[0, 7], [7, 23], [23, 29], [29, 55], [55, original.length]];
    const upstream = chunkedResponse(new Uint8Array(original), boundaries, { "Content-Type": "text/event-stream" });

    const ctx = await makeTrace();
    const wrapped = ctx.wrap(upstream);
    const received = await readAllBytes(wrapped);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Byte equality, not string equality — a lossy UTF-8 round trip would pass the latter.
    expect(received.equals(original)).toBe(true);
    expect(received.length).toBe(original.length);
    // And the decoded text still parses as the same SSE frames.
    expect(received.toString("utf8")).toBe(PAYLOAD);
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("success");
  });

  it("preserves status, statusText and every response header", async () => {
    const headers = {
      "Content-Type": "text/event-stream",
      "X-Request-Id": "upstream-abc",
      "Cache-Control": "no-cache",
    };
    const upstream = chunkedResponse(new TextEncoder().encode("data: x\n\n"), [[0, 9]], headers);
    const ctx = await makeTrace();
    const wrapped = ctx.wrap(upstream);

    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("x-request-id")).toBe("upstream-abc");
    expect(wrapped.headers.get("cache-control")).toBe("no-cache");
    expect(wrapped.body).not.toBeNull();
    await readAllBytes(wrapped);
  });

  it("surfaces an upstream error status unchanged and records it as an error trace", async () => {
    const upstream = new Response(new TextEncoder().encode('{"error":"nope"}'), {
      status: 429, statusText: "Too Many Requests", headers: { "Content-Type": "application/json" },
    });
    const ctx = await makeTrace();
    const wrapped = ctx.wrap(upstream);

    expect(wrapped.status).toBe(429);
    expect(wrapped.statusText).toBe("Too Many Requests");
    expect(await wrapped.text()).toBe('{"error":"nope"}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = adapter.get("SELECT status, reason FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(row.status).toBe("error");
    expect(row.reason).toBe("rate_limit");
  });

  it("returns a bodyless response by identity, adding no wrapper at all", async () => {
    const ctx = await makeTrace();
    const upstream = new Response(null, { status: 204, statusText: "No Content" });
    expect(ctx.wrap(upstream)).toBe(upstream);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("success");
  });
});

describe("Phase A usageHistory reconciliation", () => {
  it("repairs a terminal attempt whose usage write was lost, without inventing a cost", async () => {
    const ctx = await makeTrace();
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced" });
    await ctx.onTraceFinish({
      attemptId: attempt.attemptId, status: "error", httpStatus: 500, ttftMs: null,
      durationMs: 20, tokens: null, tokenSource: "unknown",
    });
    await ctx.finish("error", 500, "upstream_error");

    // Simulate a crash between the status transition and the ledger write.
    adapter.run("DELETE FROM usageHistory WHERE attemptId = ?", [attempt.attemptId]);
    expect(adapter.get("SELECT id FROM usageHistory WHERE attemptId = ?", [attempt.attemptId])).toBeUndefined();

    const repaired = await traceRepo.repairTerminalAttemptUsage();
    expect(repaired).toBeGreaterThan(0);

    const row = adapter.get("SELECT * FROM usageHistory WHERE attemptId = ?", [attempt.attemptId]);
    expect(row).toBeTruthy();
    // No token counters were ever observed, so the cost stays explicitly unknown.
    expect(row.cost).toBeNull();
    expect(row.costStatus).toBe("unknown");
    // Attribution still reaches the ledger through the parent trace.
    expect(row.apiKeyId).toBe("key-1");
    expect(row.projectId).toBe("team:alpha");
  });

  it("keeps billing the attempt's terminal time, so the row lands in that UTC period", async () => {
    const ctx = await makeTrace();
    const attempt = await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced" });
    await ctx.onTraceFinish({
      attemptId: attempt.attemptId, status: "success", httpStatus: 200, ttftMs: 5, durationMs: 60,
      tokens: { prompt_tokens: 10, completion_tokens: 1 }, tokenSource: "upstream",
    });
    const attemptRow = adapter.get("SELECT startTime, endTime FROM traceAttempts WHERE attemptId = ?", [attempt.attemptId]);
    const usageRow = adapter.get("SELECT timestamp FROM usageHistory WHERE attemptId = ?", [attempt.attemptId]);
    expect(usageRow.timestamp).toBe(attemptRow.endTime);
    expect(new Date(usageRow.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(attemptRow.startTime).getTime());
  });

  it("closes an abandoned in-flight attempt as cancelled on boot instead of leaving it running", async () => {
    const ctx = await makeTrace();
    await ctx.onTraceBegin({ requestId: ctx.requestId, provider: "coord-test", model: "priced" });
    expect(adapter.get("SELECT status FROM traces WHERE requestId = ?", [ctx.requestId]).status).toBe("pending");

    await traceRepo.closeAbandonedAttempts();

    const parent = adapter.get("SELECT status, reason FROM traces WHERE requestId = ?", [ctx.requestId]);
    expect(parent.status).toBe("cancelled");
    const attempts = adapter.all("SELECT attemptId, status FROM traceAttempts WHERE requestId = ?", [ctx.requestId]);
    expect(attempts).toHaveLength(1);
    expect(attempts.every((a) => a.status === "cancelled")).toBe(true);
    // A cancelled dispatch consumed no verified tokens, so it must not read as $0.
    const usage = adapter.get("SELECT cost, costStatus FROM usageHistory WHERE attemptId = ?", [attempts[0].attemptId]);
    expect(usage.cost).toBeNull();
    expect(usage.costStatus).toBe("unknown");
  });

  it("keys budget alerts by UTC period so a day boundary cannot double-fire or skip", async () => {
    const now = new Date();
    const first = await traceRepo.checkBudgetAlert({
      scope: "project", scopeId: "team:alpha", periodType: "daily",
      threshold: 0.8, budgetUsd: 10, currentCost: 8, now,
    });
    expect(first).toBeTruthy();
    // Same period, same threshold — the unique index must collapse the repeat.
    const repeat = await traceRepo.checkBudgetAlert({
      scope: "project", scopeId: "team:alpha", periodType: "daily",
      threshold: 0.8, budgetUsd: 10, currentCost: 9, now,
    });
    expect(repeat.currentCost).toBe(first.currentCost);
    // A different threshold in the same period is a distinct alert.
    const harder = await traceRepo.checkBudgetAlert({
      scope: "project", scopeId: "team:alpha", periodType: "daily",
      threshold: 1, budgetUsd: 10, currentCost: 10.5, now,
    });
    expect(harder.threshold).toBe(1);

    const utcKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    const alerts = await traceRepo.listBudgetAlerts({ scope: "project", scopeId: "team:alpha" });
    expect(alerts.every((a) => a.periodKey === utcKey)).toBe(true);
  });

  it("rejects a budget alert with a nonsensical threshold instead of clamping it", async () => {
    await expect(traceRepo.checkBudgetAlert({
      scope: "global", scopeId: "global", periodType: "daily",
      threshold: 5, budgetUsd: 10, currentCost: 1,
    })).rejects.toThrow();
    await expect(traceRepo.checkBudgetAlert({
      scope: "global", scopeId: "global", periodType: "daily",
      threshold: 0.5, budgetUsd: -10, currentCost: 1,
    })).rejects.toThrow();
  });
});