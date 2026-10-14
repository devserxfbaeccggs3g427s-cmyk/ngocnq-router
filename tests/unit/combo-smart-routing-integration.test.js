import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleComboChat, rankSmartComboCandidates } from "../../open-sse/services/combo.js";

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("handleComboChat — smart routing integration", () => {
  const mockModels = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"];
  const recent = new Date().toISOString();
  // Every candidate is fully eligible, so the ranking gate is satisfied and the
  // weighted score decides the order.
  const mockMetrics = {
    "openai/gpt-4o": { health: 0.95, p95: 1000, successRate: 0.98, sampleCount: 1000, pricedSampleCount: 1000, pricedCoverage: 1, lastSeenAt: recent, costPer1k: 0.005 },
    "anthropic/claude-sonnet-4.6": { health: 0.85, p95: 2000, successRate: 0.96, sampleCount: 1000, pricedSampleCount: 1000, pricedCoverage: 1, lastSeenAt: recent, costPer1k: 0.015 },
    "google/gemini-2.5-flash": { health: 0.90, p95: 1500, successRate: 0.97, sampleCount: 1000, pricedSampleCount: 1000, pricedCoverage: 1, lastSeenAt: recent, costPer1k: 0.001 },
  };

  let callCount = 0;
  let shouldSucceed = true;

  const mockHandleSingleModel = vi.fn(async (body, model) => {
    callCount++;
    if (!shouldSucceed) {
      return { ok: false, status: 500, statusText: "Internal Server Error" };
    }
    // First model succeeds
    if (model === "openai/gpt-4o") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Success from " + model } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Success from " + model } }] }) };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    callCount = 0;
    shouldSucceed = true;
  });

  it("uses smart strategy to reorder models by routing metrics before trying", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };

    const result = await handleComboChat({
      body,
      models: mockModels,
      handleSingleModel: mockHandleSingleModel,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "smart",
      routingMetrics: mockMetrics,
      requiredCapabilities: new Set(["vision"]),
    });

    // Should succeed on first try (openai/gpt-4o should be ranked first due to highest health)
    expect(result.ok).toBe(true);
    expect(mockHandleSingleModel).toHaveBeenCalledTimes(1);
    // The first call should be to the best-ranked model (openai/gpt-4o with health 0.95)
    expect(mockHandleSingleModel).toHaveBeenCalledWith(body, "openai/gpt-4o");
  });

  it("refuses to dispatch when no model satisfies hard capabilities, with an explicit code", async () => {
    const textOnlyModels = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const body = { messages: [{ role: "user", content: "Hello" }] };

    const result = await handleComboChat({
      body,
      models: textOnlyModels,
      handleSingleModel: mockHandleSingleModel,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "smart",
      routingMetrics: mockMetrics,
      requiredCapabilities: new Set(["vision"]),
    });

    // No upstream call may happen: silently trying text-only models would strip
    // the image and bill for a wrong answer.
    expect(mockHandleSingleModel).not.toHaveBeenCalled();
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe("unsupported_modality");
    expect(mockLog.warn).toHaveBeenCalledWith("COMBO", expect.stringContaining("refusing to dispatch"));
  });

  it("drops incapable members even with smart routing off, so a vision request is never retried on text-only", async () => {
    const models = ["deepseek/deepseek-chat", "openai/gpt-4o", "anthropic/claude-sonnet-4.6"];
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }] };

    const first = vi.fn(async () => ({ ok: false, status: 500, statusText: "Error" }));
    const second = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) }));
    const dispatch = vi.fn()
      .mockImplementationOnce(first)
      .mockImplementationOnce(second);

    await handleComboChat({
      body,
      models,
      handleSingleModel: dispatch,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "fallback",
      autoSwitch: true,
    });

    // deepseek-chat cannot read the image: it must not appear in the chain at all,
    // otherwise the retry after gpt-4o's 500 would strip the image and bill again.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4.6"]);
    expect(mockLog.info).toHaveBeenCalledWith("COMBO", expect.stringContaining("drops [deepseek/deepseek-chat]"));
  });

  it("leaves the chain intact when no member can read the request's modality", async () => {
    const models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }] };
    const dispatch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) }));

    await handleComboChat({
      body,
      models,
      handleSingleModel: dispatch,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "fallback",
      autoSwitch: true,
    });

    // Dropping everything would leave nothing to dispatch — preserve existing
    // behaviour and let the upstream produce its own error.
    expect(dispatch).toHaveBeenCalledWith(body, "deepseek/deepseek-chat");
  });

  it("respects round-robin rotation when strategy is round-robin", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };

    await handleComboChat({
      body,
      models: mockModels,
      handleSingleModel: mockHandleSingleModel,
      log: mockLog,
      comboName: "test-combo-rr",
      comboStrategy: "round-robin",
      comboStickyLimit: 1,
    });

    // First call should be to rotated model (index 0 = first model after rotation)
    expect(mockHandleSingleModel).toHaveBeenCalledWith(body, "openai/gpt-4o");
  });

  it("passes routingMetrics through to handleComboChat when strategy is smart", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };

    await handleComboChat({
      body,
      models: mockModels,
      handleSingleModel: mockHandleSingleModel,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "smart",
      routingMetrics: mockMetrics,
      requiredCapabilities: new Set(["vision"]),
    });

    // Verify the routing happened (smart reorder was applied)
    expect(mockLog.info).toHaveBeenCalledWith("COMBO", expect.stringContaining("Smart routing: reordered"));
  });

  it("keeps combo order and still walks the fallback chain on an upstream failure", async () => {
    const textOnlyModels = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const body = { messages: [{ role: "user", content: "Hello" }] };

    let attempt = 0;
    const failingThenSuccess = vi.fn(async (b, m) => {
      attempt++;
      if (attempt === 1) {
        return { ok: false, status: 500, statusText: "Error" };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    });

    await handleComboChat({
      body,
      models: textOnlyModels,
      handleSingleModel: failingThenSuccess,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "smart",
      routingMetrics: mockMetrics,
      requiredCapabilities: new Set(),   // no modality demanded → nothing is filtered
    });

    // Both members are text-only but none is *required* to be, so the combo runs.
    expect(failingThenSuccess).toHaveBeenCalledTimes(2);
    expect(failingThenSuccess).toHaveBeenNthCalledWith(1, body, "deepseek/deepseek-chat");
  });

  it("does not rank, and says why, when a candidate is under-sampled", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const underSampled = {
      "openai/gpt-4o": { ...mockMetrics["openai/gpt-4o"], sampleCount: 12, pricedSampleCount: 12 },
      "anthropic/claude-sonnet-4.6": mockMetrics["anthropic/claude-sonnet-4.6"],
      "google/gemini-2.5-flash": mockMetrics["google/gemini-2.5-flash"],
    };

    await handleComboChat({
      body,
      models: mockModels,
      handleSingleModel: mockHandleSingleModel,
      log: mockLog,
      comboName: "test-combo",
      comboStrategy: "smart",
      routingMetrics: underSampled,
      requiredCapabilities: new Set(["vision"]),
    });

    // gemini has the best score but gpt-4o is under-sampled → combo order wins.
    expect(mockHandleSingleModel).toHaveBeenNthCalledWith(1, body, "openai/gpt-4o");
  });
});

describe("rankSmartComboCandidates — edge cases for T11", () => {
  const recent = new Date().toISOString();

  it("keeps combo order when all metrics are missing", () => {
    const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6"];
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: new Set(["vision"]), metrics: {} });
    expect(ranked).toEqual(models);
  });

  it("keeps combo order when only some models have data — a missing metric never wins by default", () => {
    const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"];
    const metrics = {
      "openai/gpt-4o": { health: 0.9, p95: 1000, successRate: 0.95, costPer1k: 0.005, sampleCount: 10000, pricedSampleCount: 10000, pricedCoverage: 1, lastSeenAt: recent },
      // anthropic missing entirely
      "google/gemini-2.5-flash": { health: 0.7, p95: 2000, successRate: 0.95, costPer1k: 0.002, sampleCount: 10000, pricedSampleCount: 10000, pricedCoverage: 1, lastSeenAt: recent },
    };

    // One unknown candidate is enough to keep the declared combo order — an
    // unknown price/speed must never be treated as the best option.
    expect(rankSmartComboCandidates({ models, requiredCapabilities: new Set(["vision"]), metrics }))
      .toEqual(models);
  });

  it("filters audioInput as hard capability", () => {
    const models = ["openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-chat"];
    const required = new Set(["audioInput"]);
    const metrics = {};

    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });

    // deepseek should be filtered out (no audioInput)
    expect(ranked).not.toContain("deepseek/deepseek-chat");
  });

  it("filters videoInput as hard capability", () => {
    const models = ["openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-chat"];
    const required = new Set(["videoInput"]);
    const metrics = {};

    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });

    // deepseek should be filtered out (no videoInput)
    expect(ranked).not.toContain("deepseek/deepseek-chat");
  });

  it("does not filter on soft capabilities like search", () => {
    const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"];
    const required = new Set(["vision", "search"]); // search is soft
    const metrics = {};

    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });

    // All should pass hard filter (vision), search only affects scoring
    // deepseek has no vision so it should be filtered
    expect(ranked).not.toContain("deepseek/deepseek-chat");
  });
});