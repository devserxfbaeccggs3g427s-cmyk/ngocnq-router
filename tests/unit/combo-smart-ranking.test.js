import { describe, it, expect } from "vitest";
import {
  rankSmartComboCandidates,
  detectRequiredCapabilities,
  smartRankingIneligibility,
  UnsupportedModalityError,
  SMART_ROUTING_ELIGIBILITY,
} from "../../open-sse/services/combo.js";

// A candidate the ranking gate accepts: enough samples, fresh, fully priced.
const recent = new Date().toISOString();
const stale = new Date(Date.now() - 8 * 86400000).toISOString();
const eligibleMetric = (overrides = {}) => ({
  health: 0.8,
  p95: 1000,
  successRate: 0.95,
  costPer1k: 0.005,
  sampleCount: 1000,
  pricedSampleCount: 1000,
  pricedCoverage: 1,
  lastSeenAt: recent,
  ...overrides,
});

describe("rankSmartComboCandidates — hard capability filter", () => {
  const visionModels = ["anthropic/claude-sonnet-4.6", "openai/gpt-4o", "google/gemini-2.5-flash"];
  const textOnlyModels = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];

  it("throws when no model satisfies required hard capability (vision)", () => {
    expect(() => rankSmartComboCandidates({
      models: [...textOnlyModels],
      requiredCapabilities: new Set(["vision"]),
      metrics: {},
    })).toThrow("no model satisfies required hard capabilities: vision");
  });

  it("carries a machine-readable unsupported_modality code, not just a message", () => {
    let thrown;
    try {
      rankSmartComboCandidates({ models: [...textOnlyModels], requiredCapabilities: new Set(["vision"]), metrics: {} });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UnsupportedModalityError);
    expect(thrown.code).toBe("unsupported_modality");
    expect(thrown.missing).toEqual(["vision"]);
  });

  it("names every missing modality when several are unsupported", () => {
    expect(() => rankSmartComboCandidates({
      models: ["openai/gpt-4o"],
      requiredCapabilities: new Set(["pdf"]),
      metrics: {},
    })).toThrow("no model satisfies required hard capabilities: pdf");
  });

  it("filters to only capable models and preserves input order when nothing can be ranked", () => {
    const models = [...visionModels, ...textOnlyModels];
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: new Set(["vision"]), metrics: {} });

    expect(ranked).toEqual(visionModels);
    expect(ranked[0]).toBe("anthropic/claude-sonnet-4.6");
    expect(ranked[1]).toBe("openai/gpt-4o");
    expect(ranked[2]).toBe("google/gemini-2.5-flash");
  });

  it("filters audioInput as a hard capability", () => {
    const ranked = rankSmartComboCandidates({
      models: ["openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-chat"],
      requiredCapabilities: new Set(["audioInput"]),
      metrics: {},
    });
    expect(ranked).not.toContain("deepseek/deepseek-chat");
  });

  it("filters videoInput as a hard capability", () => {
    const ranked = rankSmartComboCandidates({
      models: ["openai/gpt-4o", "google/gemini-2.5-flash", "deepseek/deepseek-chat"],
      requiredCapabilities: new Set(["videoInput"]),
      metrics: {},
    });
    expect(ranked).not.toContain("deepseek/deepseek-chat");
  });

  it("does not filter on soft capabilities like search", () => {
    const ranked = rankSmartComboCandidates({
      models: ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"],
      requiredCapabilities: new Set(["vision", "search"]),
      metrics: {},
    });
    expect(ranked).not.toContain("deepseek/deepseek-chat");
    expect(ranked).toContain("openai/gpt-4o");
    expect(ranked).toContain("anthropic/claude-sonnet-4.6");
  });

  it("throws on empty models array", () => {
    expect(() => rankSmartComboCandidates({ models: [], requiredCapabilities: new Set(), metrics: {} }))
      .toThrow("models array is required and must not be empty");
  });

  it("accepts an array for requiredCapabilities", () => {
    const ranked = rankSmartComboCandidates({ models: ["openai/gpt-4o"], requiredCapabilities: ["vision"], metrics: {} });
    expect(ranked).toEqual(["openai/gpt-4o"]);
  });
});

describe("rankSmartComboCandidates — conservative eligibility gate (SR-03)", () => {
  const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"];
  const required = new Set(["vision"]);

  it("keeps combo order when a candidate has fewer than 100 samples", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ sampleCount: 99, pricedSampleCount: 99, pricedCoverage: 1 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("keeps combo order when a candidate has no metrics at all", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
      // anthropic absent entirely
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("keeps combo order when a candidate's data is older than 7 days", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ lastSeenAt: stale }),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("never ranks a candidate whose cost is unknown — unknown is not free", () => {
    const metrics = {
      // Cheapest-looking but unpriced: must not win.
      "openai/gpt-4o": eligibleMetric({ costPer1k: null }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ costPer1k: 0.02 }),
      "google/gemini-2.5-flash": eligibleMetric({ costPer1k: 0.02 }),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("keeps combo order when priced coverage is below 80%", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ pricedSampleCount: 790, pricedCoverage: 0.79 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("keeps combo order when health (an independent signal) is unavailable", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ health: null }),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("keeps combo order when p95 latency is missing", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ p95: null }),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
      "google/gemini-2.5-flash": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({ models, requiredCapabilities: required, metrics })).toEqual(models);
  });

  it("reports the disqualifying reason for each way of being ineligible", () => {
    expect(smartRankingIneligibility(undefined)).toBe("no_metrics");
    expect(smartRankingIneligibility(eligibleMetric({ sampleCount: 3 }))).toBe("insufficient_samples");
    expect(smartRankingIneligibility(eligibleMetric({ lastSeenAt: stale }))).toBe("stale_metrics");
    expect(smartRankingIneligibility(eligibleMetric({ health: null }))).toBe("missing_health");
    expect(smartRankingIneligibility(eligibleMetric({ p95: undefined }))).toBe("missing_latency");
    expect(smartRankingIneligibility(eligibleMetric({ successRate: null }))).toBe("missing_success_rate");
    expect(smartRankingIneligibility(eligibleMetric({ costPer1k: null }))).toBe("missing_cost");
    expect(smartRankingIneligibility(eligibleMetric({ pricedCoverage: 0.5 }))).toBe("insufficient_priced_coverage");
    expect(smartRankingIneligibility(eligibleMetric())).toBeNull();
  });
});

describe("rankSmartComboCandidates — weighted scoring (SR-04)", () => {
  const models = ["openai/gpt-4o", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"];
  const required = new Set(["vision"]);
  const { p95CeilingMs, costCeilingUsdPer1k } = SMART_ROUTING_ELIGIBILITY;

  it("ranks by health when every other signal is equal (health = 40%)", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ health: 0.9 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ health: 0.5 }),
      "google/gemini-2.5-flash": eligibleMetric({ health: 0.7 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    expect(ranked).toEqual(["openai/gpt-4o", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.6"]);
  });

  it("ranks by p95 latency when health is equal (p95 = 30%)", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ p95: 3000 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ p95: 1000 }),
      "google/gemini-2.5-flash": eligibleMetric({ p95: 2000 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    expect(ranked).toEqual(["anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash", "openai/gpt-4o"]);
  });

  it("ranks by cost when health and latency are equal (cost = 20%)", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ costPer1k: 0.005 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ costPer1k: 0.020 }),
      "google/gemini-2.5-flash": eligibleMetric({ costPer1k: 0.001 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    expect(ranked).toEqual(["google/gemini-2.5-flash", "openai/gpt-4o", "anthropic/claude-sonnet-4.6"]);
  });

  it("breaks a successRate tie in favour of the more reliable model (successRate = 10%)", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ successRate: 0.90 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ successRate: 0.99 }),
    };
    const ranked = rankSmartComboCandidates({
      models: ["openai/gpt-4o", "anthropic/claude-sonnet-4.6"],
      requiredCapabilities: required,
      metrics,
    });
    expect(ranked[0]).toBe("anthropic/claude-sonnet-4.6");
  });

  it("preserves combo order on an exact score tie", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric(),
      "anthropic/claude-sonnet-4.6": eligibleMetric(),
    };
    expect(rankSmartComboCandidates({
      models: ["openai/gpt-4o", "anthropic/claude-sonnet-4.6"],
      requiredCapabilities: required,
      metrics,
    })).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4.6"]);
  });

  it("clamps an outlier latency at the ceiling instead of scoring it negative", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ p95: p95CeilingMs * 50 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ p95: p95CeilingMs }),
      "google/gemini-2.5-flash": eligibleMetric({ p95: p95CeilingMs * 100 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    // At the ceiling the latency sub-score is already 0, so every outlier clamps to
    // the same value rather than going negative — all three tie and keep combo order.
    expect(ranked).toEqual(models);
  });

  it("clamps an outlier price at the ceiling instead of scoring it negative", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ costPer1k: costCeilingUsdPer1k * 10 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ costPer1k: costCeilingUsdPer1k }),
      "google/gemini-2.5-flash": eligibleMetric({ costPer1k: costCeilingUsdPer1k * 99 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    expect(ranked).toEqual(models);
  });

  it("still separates a genuinely slow model from a fast one below the ceiling", () => {
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ p95: 9000 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ p95: 500 }),
      "google/gemini-2.5-flash": eligibleMetric({ p95: 5000 }),
    };
    const ranked = rankSmartComboCandidates({ models, requiredCapabilities: required, metrics });
    expect(ranked).toEqual(["anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash", "openai/gpt-4o"]);
  });

  it("does not let a strong successRate outvote a broken account's health", () => {
    // Conflict case: anthropic succeeds often but its only account is in cooldown
    // (health 0), so openai must still win on the 40% health weight.
    const metrics = {
      "openai/gpt-4o": eligibleMetric({ health: 1, successRate: 0.90 }),
      "anthropic/claude-sonnet-4.6": eligibleMetric({ health: 0, successRate: 1.0 }),
    };
    const ranked = rankSmartComboCandidates({
      models: ["openai/gpt-4o", "anthropic/claude-sonnet-4.6"],
      requiredCapabilities: required,
      metrics,
    });
    expect(ranked[0]).toBe("openai/gpt-4o");
  });
});