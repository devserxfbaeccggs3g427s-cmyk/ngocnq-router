import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calculateCost } from "@/lib/db/repos/pricingRepo.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let trace;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-phase-a-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  trace = await import("@/lib/db/repos/traceRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await db.updatePricing({ "phase-a-test": { "priced": { input: 1_000_000, output: 0 }, "free": { input: 0, output: 0 } } });
});

afterAll(() => {
  adapter?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function attempt({ model = "priced", tokens = { prompt_tokens: 1, completion_tokens: 0 }, tokenSource = "upstream", projectId = "team:alpha", status = "success" } = {}) {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  await trace.beginTrace({ requestId, apiKeyId: "key-1", projectId, requestedModel: model, endpoint: "/v1/chat/completions" });
  await trace.beginAttempt({ attemptId, requestId, provider: "phase-a-test", model, connectionId: "account-1" });
  const finished = await trace.finishAttempt({ attemptId, status, tokens, tokenSource, durationMs: 120, httpStatus: status === "success" ? 200 : 429 });
  await trace.finishTrace({ requestId, status });
  return { requestId, attemptId, finished };
}

describe("Phase A pricing states", () => {
  it("distinguishes missing pricing and missing token rates from explicit free", () => {
    const tokens = { prompt_tokens: 12, completion_tokens: 4 };
    expect(calculateCost(tokens, null)).toBeNull();
    expect(calculateCost(tokens, { input: null, output: 0 })).toBeNull();
    expect(calculateCost(tokens, { input: 0, output: 0 })).toBe(0);
  });

  it("charges cached, reasoning and cache creation tokens only once", () => {
    expect(calculateCost({ prompt_tokens: 100, cached_tokens: 20, cache_creation_input_tokens: 10, completion_tokens: 40, reasoning_tokens: 5 },
      { input: 1_000_000, cached: 200_000, cache_creation: 2_000_000, output: 3_000_000, reasoning: 4_000_000 })).toBe(219);
  });
});

describe("Phase A traced usage and warning-only budgets", () => {
  it("persists each terminal attempt once through history and daily/lifetime aggregation", async () => {
    const first = await attempt();
    const before = adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
    expect(first.finished.cost).toBe(1);
    expect(first.finished.costStatus).toBe("known");
    expect(await trace.finishAttempt({ attemptId: first.attemptId, status: "error", tokens: { prompt_tokens: 100 } })).toMatchObject({ status: "success" });
    const rows = adapter.all("SELECT * FROM usageHistory WHERE attemptId = ?", [first.attemptId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ apiKey: null, apiKeyId: "key-1", projectId: "team:alpha", cost: 1, costStatus: "known" });
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'").value).toBe(before.value);
    const day = adapter.get("SELECT data FROM usageDaily ORDER BY dateKey DESC LIMIT 1");
    expect(JSON.parse(day.data).byProvider["phase-a-test"].requests).toBeGreaterThanOrEqual(1);
  });

  it("warns once per threshold in both UTC periods for global and trusted project", async () => {
    await db.updateSettings({ budget: {
      enabled: true,
      global: { dailyUsd: 1, monthlyUsd: 1 },
      projects: { "team:alpha": { dailyUsd: 1, monthlyUsd: 1 } },
      thresholds: [0.5, 1],
    } });
    await attempt();
    await attempt();
    const alerts = await trace.listBudgetAlerts({});
    const matching = alerts.filter((a) => ["global", "project"].includes(a.scope));
    expect(matching).toHaveLength(8);
    expect(new Set(matching.map((a) => `${a.scope}|${a.periodType}|${a.threshold}`)).size).toBe(8);
    expect(matching.every((a) => a.budgetUsd === 1 && a.currentCost >= 1)).toBe(true);
    expect((await db.getUsageHistory()).filter((r) => r.attemptId).length).toBeGreaterThanOrEqual(3);
  });

  it("does not treat unknown pricing as free or trigger a new alert", async () => {
    const count = (await trace.listBudgetAlerts({})).length;
    const unknown = await attempt({ model: "unpriced", tokens: { prompt_tokens: 100 } });
    expect(unknown.finished.cost).toBeNull();
    expect(unknown.finished.costStatus).toBe("unknown");
    expect((await trace.listBudgetAlerts({})).length).toBe(count);
    const estimated = await attempt({ tokens: { prompt_tokens: 2 }, tokenSource: "estimated" });
    expect(estimated.finished.costStatus).toBe("estimated");
    const free = await attempt({ model: "free", tokens: { prompt_tokens: 100 } });
    expect(free.finished.cost).toBe(0);
    expect(free.finished.costStatus).toBe("known");
  });

  it("remains warning-only: exhausted budgets never prevent attempts", async () => {
    const completed = await attempt({ status: "error" });
    expect(completed.finished.status).toBe("error");
    expect(adapter.get("SELECT COUNT(*) AS count FROM traceAttempts WHERE attemptId = ?", [completed.attemptId]).count).toBe(1);
  });
});
