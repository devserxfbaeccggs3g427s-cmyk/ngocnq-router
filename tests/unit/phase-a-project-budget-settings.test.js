import { describe, expect, it } from "vitest";
import { normalizeApiKeyProject } from "@/lib/db/repos/apiKeysRepo.js";
import {
  mergeWithDefaults,
  normalizeBudgetSettings,
} from "@/lib/db/repos/settingsRepo.js";

describe("Phase A project attribution", () => {
  it("normalizes trusted project metadata and supports clearing", () => {
    expect(normalizeApiKeyProject({
      projectId: "team:alpha",
      projectLabel: "  Alpha project  ",
    })).toEqual({
      projectId: "team:alpha",
      projectLabel: "Alpha project",
    });

    expect(normalizeApiKeyProject({ projectId: null }, {
      projectId: "team:alpha",
      projectLabel: "Alpha project",
    })).toEqual({ projectId: null, projectLabel: null });
  });

  it("clears a stale label when moving a key to another project", () => {
    expect(normalizeApiKeyProject({ projectId: "team:beta" }, {
      projectId: "team:alpha",
      projectLabel: "Alpha project",
    })).toEqual({ projectId: "team:beta", projectLabel: null });
  });

  it("rejects malformed or orphaned project metadata", () => {
    expect(() => normalizeApiKeyProject({ projectId: "../unsafe" })).toThrow(/projectId/);
    expect(() => normalizeApiKeyProject({ projectLabel: "No project" })).toThrow(/requires projectId/);
    expect(() => normalizeApiKeyProject({
      projectId: "team-a",
      projectLabel: "x".repeat(129),
    })).toThrow(/projectLabel/);
  });
});

describe("Phase A warning-only budget settings", () => {
  it("provides disabled safe defaults", () => {
    expect(mergeWithDefaults({}).budget).toEqual({
      enabled: false,
      global: { dailyUsd: null, monthlyUsd: null },
      projects: {},
      thresholds: [0.5, 0.8, 1],
    });
  });

  it("normalizes limits, project scopes, and sorted unique thresholds", () => {
    expect(normalizeBudgetSettings({
      enabled: true,
      global: { dailyUsd: 10, monthlyUsd: 100 },
      projects: {
        "team:alpha": { dailyUsd: 2, monthlyUsd: 20 },
      },
      thresholds: [1, 0.5, 0.8, 0.5],
    })).toEqual({
      enabled: true,
      global: { dailyUsd: 10, monthlyUsd: 100 },
      projects: {
        "team:alpha": { dailyUsd: 2, monthlyUsd: 20 },
      },
      thresholds: [0.5, 0.8, 1],
    });
  });

  it("merges a partial budget patch against the existing configuration", () => {
    const current = normalizeBudgetSettings({
      enabled: false,
      global: { dailyUsd: 10, monthlyUsd: 100 },
      projects: {},
      thresholds: [0.8, 1],
    });

    expect(normalizeBudgetSettings({ enabled: true }, current)).toEqual({
      ...current,
      enabled: true,
    });
  });

  it("rejects unknown fields and invalid amounts or thresholds", () => {
    expect(() => normalizeBudgetSettings({ enabled: false, hardLimit: true })).toThrow(/unsupported field/);
    expect(() => normalizeBudgetSettings({
      enabled: true,
      global: { dailyUsd: -1 },
    })).toThrow(/positive finite USD/);
    expect(() => normalizeBudgetSettings({
      enabled: true,
      thresholds: [1.1],
    })).toThrow(/at most 1/);
    expect(() => normalizeBudgetSettings({
      enabled: true,
      projects: { "bad/id": { dailyUsd: 1 } },
    })).toThrow(/invalid projectId/);
  });

  it("fails closed when malformed persisted budget data is read", () => {
    expect(mergeWithDefaults({
      budget: { enabled: true, global: { dailyUsd: -1 } },
    }).budget.enabled).toBe(false);
  });
});
