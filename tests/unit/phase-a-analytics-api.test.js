import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let traceRepo;
let adapter;
let GET;
let usageRepo;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Rates are USD per MILLION tokens, so 1000 = $1 per 1K tokens.
// That makes every assertion below exact arithmetic.
const PER_1K = 1000;
// Anchor on an exact UTC hour safely in the past, so a default-range query
// (which ends at "now") still covers every synthetic row.
const NOW = Math.floor((Date.now() - 5 * HOUR) / HOUR) * HOUR;
const FROM = iso(NOW - 7 * DAY);
const TO = iso(NOW + HOUR);
// A real UTC midnight, for the bucket-boundary assertions.
const MIDNIGHT = Math.floor((NOW - DAY) / DAY) * DAY;

const url = (query = "") => new Request(`http://localhost:20128/api/usage/analytics${query}`);
const body = async (response) => response.json();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-analytics-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  traceRepo = await import("@/lib/db/repos/traceRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  ({ GET } = await import("@/app/api/usage/analytics/route.js"));
  await db.updatePricing({
    alpha: { "m-1": { input: PER_1K, output: PER_1K } },
    beta: { "m-2": { input: PER_1K, output: PER_1K } },
  });
});

afterAll(() => {
  adapter?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM traces");
  adapter.run("DELETE FROM traceAttempts");
  adapter.run("DELETE FROM usageHistory");
});

let seq = 0;
/** One traced request with `attempts` billable dispatches, then finalized. */
async function traced({ projectId = "team:a", apiKeyId = "key-1", taskId = null, agentLabel = null, attempts, at, status = "success" }) {
  const requestId = `req-${++seq}`;
  await traceRepo.beginTrace({
    requestId, projectId, apiKeyId, taskId, agentLabel,
    requestedModel: "m-1", endpoint: "/v1/chat/completions",
  });
  adapter.run("UPDATE traces SET startTime = ? WHERE requestId = ?", [iso(at), requestId]);
  for (const a of attempts) {
    const attemptId = `att-${seq}-${Math.random().toString(36).slice(2, 8)}`;
    await traceRepo.beginAttempt({ attemptId, requestId, provider: a.provider, model: a.model });
    await traceRepo.finishAttempt({
      attemptId, status: a.status || "success", httpStatus: a.httpStatus ?? 200,
      ttftMs: a.ttftMs ?? 10, durationMs: a.durationMs ?? 100,
      tokens: a.tokens, tokenSource: a.tokenSource,
    });
    // finishAttempt stamps the real terminal time; pin it for deterministic buckets.
    adapter.run("UPDATE traceAttempts SET endTime = ? WHERE attemptId = ?", [iso(at), attemptId]);
    adapter.run("UPDATE usageHistory SET timestamp = ? WHERE attemptId = ?", [iso(at), attemptId]);
  }
  await traceRepo.finishTrace({ requestId, status, httpStatus: status === "success" ? 200 : 500 });
  adapter.run("UPDATE traces SET endTime = ? WHERE requestId = ?", [iso(at), requestId]);
  return requestId;
}

/** A pre-Phase-A ledger row: billed, but with no trace behind it. */
async function legacy({ at, provider = "alpha", model = "m-1", cost = 1.5, apiKeyId = null, projectId = null }) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, cost, costStatus, status, promptTokens, completionTokens, apiKeyId, projectId)
     VALUES(?, ?, ?, ?, 'known', 'ok', 10, 10, ?, ?)`,
    [iso(at), provider, model, cost, apiKeyId, projectId]
  );
}

const pricedTokens = (p, c) => ({ prompt_tokens: p, completion_tokens: c });

describe("GET /api/usage/analytics — response contract", () => {
  it("returns range, coverage, totals, series and groups", async () => {
    await traced({ at: NOW - HOUR, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 50), tokenSource: "upstream" }] });
    const res = await GET(url(`?from=${FROM}&to=${TO}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const json = await body(res);
    expect(json.range).toEqual({ from: FROM, to: TO, timezone: "UTC", bucket: "day" });
    expect(json.coverage).toMatchObject({ requests: 1, attempts: 1, priced: 1, estimated: 0, unknown: 0 });
    expect(json.totals).toMatchObject({
      requests: 1, attempts: 1, success: 1,
      pricedUsd: 0.15,            // 150 tokens @ $1/1K
      totalCostUsd: 0.15,
      promptTokens: 100, completionTokens: 50, totalTokens: 150,
    });
    expect(json.series).toHaveLength(1);
    expect(json.groups).toEqual([]);
    expect(json.groupBy).toBeNull();
  });

  it("discloses that Phase A traces only the chat endpoints", async () => {
    const json = await body(await GET(url()));
    expect(json.coverage.tracing.scope).toBe("chat-only");
    expect(json.coverage.tracing.tracedEndpoints).toContain("/v1/chat/completions");
    // A paid-but-untraced path must be named, so it is never read as free.
    expect(json.coverage.tracing.untracedPaidEndpoints).toContain("/v1/embeddings");
    expect(json.coverage.tracing.disclosure).toMatch(/unknown, not zero/i);
  });

  it("counts every dispatch, not just the one that won the fallback chain", async () => {
    await traced({ at: NOW - 3600_000, attempts: [
      { provider: "alpha", model: "m-1", status: "error", httpStatus: 429, tokens: null, tokenSource: "unknown" },
      { provider: "alpha", model: "m-1", status: "error", httpStatus: 500, tokens: null, tokenSource: "unknown" },
      { provider: "beta", model: "m-2", tokens: pricedTokens(1000, 500), tokenSource: "upstream" },
    ] });
    const json = await body(await GET(url()));
    expect(json.coverage).toMatchObject({ requests: 1, attempts: 3, priced: 1, unknown: 2 });
    expect(json.totals.attemptSuccess).toBe(1);
    expect(json.totals.attemptError).toBe(2);
    expect(json.totals.success).toBe(1);
  });

  it("keeps totalCostUsd null — not zero — while any attempt is unpriced", async () => {
    await traced({ at: NOW - 3600_000, attempts: [
      { provider: "alpha", model: "m-1", tokens: pricedTokens(100, 50), tokenSource: "upstream" },
      { provider: "beta", model: "unknown-model", tokens: pricedTokens(100, 50), tokenSource: "upstream" },
    ] });
    const json = await body(await GET(url()));
    expect(json.totals.pricedUsd).toBe(0.15);   // the priced subtotal is still useful
    expect(json.totals.totalCostUsd).toBeNull();
    expect(json.coverage.unknown).toBe(1);
    expect(json.coverage.unknownRatio).toBe(0.5);
  });

  it("marks estimated counters distinctly from upstream-confirmed ones", async () => {
    await traced({ at: NOW - 3600_000, attempts: [
      { provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "estimated" },
    ] });
    const json = await body(await GET(url()));
    expect(json.coverage).toMatchObject({ priced: 0, estimated: 1, unknown: 0 });
    expect(json.totals.pricedUsd).toBe(0.1);
    expect(json.totals.totalCostUsd).toBe(0.1);
  });
});

describe("GET /api/usage/analytics — UTC bucketing", () => {
  it("splits a day bucket on UTC boundaries, not local midnight", async () => {
    // 30 minutes either side of a real UTC midnight.
    await traced({ at: MIDNIGHT - 30 * 60_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    await traced({ at: MIDNIGHT + 30 * 60_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    const json = await body(await GET(url(`?from=${FROM}&to=${TO}&bucket=day`)));
    expect(json.series.map((s) => s.key)).toEqual([
      iso(MIDNIGHT - 30 * 60_000).slice(0, 10),
      iso(MIDNIGHT).slice(0, 10),
    ]);
    expect(json.series[0].requests).toBe(1);
    expect(json.series[1].requests).toBe(1);
  });

  it("splits an hour bucket with exact inclusive/exclusive bounds", async () => {
    await traced({ at: MIDNIGHT + 7 * HOUR + 5 * 60_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    await traced({ at: MIDNIGHT + 8 * HOUR + 5 * 60_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    const json = await body(await GET(url(`?from=${FROM}&to=${TO}&bucket=hour`)));
    expect(json.series.map((s) => s.key)).toEqual([iso(MIDNIGHT + 7 * HOUR).slice(0, 13), iso(MIDNIGHT + 8 * HOUR).slice(0, 13)]);
    expect(json.series[0]).toMatchObject({
      from: iso(MIDNIGHT + 7 * HOUR),
      to: iso(MIDNIGHT + 8 * HOUR),
    });
  });

  it("excludes attempts outside the requested window", async () => {
    await traced({ at: NOW - 3600_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    const outside = await body(await GET(url(`?from=${FROM}&to=${iso(NOW - 2 * HOUR)}`)));
    expect(outside.coverage.attempts).toBe(0);
    const inside = await body(await GET(url(`?from=${FROM}&to=${TO}`)));
    expect(inside.coverage.attempts).toBe(1);
  });
});

describe("GET /api/usage/analytics — grouping", () => {
  it("groups by provider and by composed provider/model", async () => {
    await traced({ at: NOW - 3600_000, attempts: [
      { provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" },
      { provider: "beta", model: "m-2", tokens: pricedTokens(100, 0), tokenSource: "upstream" },
    ] });
    const byProvider = await body(await GET(url(`?groupBy=provider`)));
    expect(byProvider.groups.map((g) => g.key)).toEqual(["alpha", "beta"]);

    const byModel = await body(await GET(url(`?groupBy=model`)));
    expect(byModel.groups.map((g) => g.key).sort()).toEqual(["alpha/m-1", "beta/m-2"]);
  });

  it("groups request-level attribution and labels unattributed rows", async () => {
    await traced({ at: NOW - 3600_000, projectId: "team:a", taskId: "build-1", attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    await traced({ at: NOW - 3600_000, projectId: null, taskId: null, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    const json = await body(await GET(url(`?groupBy=project`)));
    expect(json.groups.map((g) => g.key).sort()).toEqual(["team:a", "unattributed"]);
    expect(json.groups.reduce((sum, g) => sum + g.attempts, 0)).toBe(2);
  });

  it("caps the group list at 8 and rolls the remainder into 'other'", async () => {
    for (let i = 0; i < 11; i++) {
      await legacy({ at: NOW - 3600_000, provider: `p-${String(i).padStart(2, "0")}`, cost: i + 1 });
    }
    const json = await body(await GET(url(`?groupBy=provider`)));
    expect(json.groups).toHaveLength(9);          // 8 + other
    expect(json.groups.at(-1).key).toBe("other");
    expect(json.groups.at(-1).rolledUp).toBe(true);
    expect(json.groupsTruncated).toBe(3);
    // Rolling up must not lose or invent spend.
    expect(json.groups.reduce((sum, g) => sum + g.pricedUsd, 0)).toBeCloseTo(66, 6);
    expect(json.groups.at(-1).pricedUsd).toBeCloseTo(6, 6);   // p-08 + p-09 + p-10
    expect(json.groups.at(-1).attempts).toBe(3);
  });

  it("orders groups deterministically so a tie cannot reshuffle the palette", async () => {
    await legacy({ at: NOW - 3600_000, provider: "zeta", cost: 1 });
    await legacy({ at: NOW - 3600_000, provider: "alpha", cost: 1 });
    await legacy({ at: NOW - 3600_000, provider: "mid", cost: 5 });
    const first = await body(await GET(url(`?groupBy=provider`)));
    const second = await body(await GET(url(`?groupBy=provider`)));
    expect(first.groups.map((g) => g.key)).toEqual(["mid", "alpha", "zeta"]);
    expect(second.groups.map((g) => g.key)).toEqual(first.groups.map((g) => g.key));
  });
});

describe("GET /api/usage/analytics — legacy ledger visibility", () => {
  it("keeps untraced legacy spend in the global total instead of dropping it", async () => {
    await traced({ at: NOW - 3600_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    await legacy({ at: NOW - 3600_000, cost: 2.5 });
    const json = await body(await GET(url()));
    expect(json.coverage.attempts).toBe(2);
    expect(json.coverage.legacyLedgerRows).toBe(1);
    expect(json.totals.pricedUsd).toBeCloseTo(2.6, 6);   // 0.10 traced + 2.50 legacy
    expect(json.totals.totalCostUsd).toBeCloseTo(2.6, 6);
  });

  it("surfaces legacy rows under legacy/unattributed when grouping by a trace dimension", async () => {
    await legacy({ at: NOW - 3600_000, cost: 2.5 });
    const json = await body(await GET(url(`?groupBy=task`)));
    expect(json.groups.map((g) => g.key)).toEqual(["legacy/unattributed"]);
    expect(json.groups[0].legacyLedgerRows).toBe(1);
  });

  it("drops legacy rows from an attribution filter they cannot satisfy", async () => {
    await legacy({ at: NOW - 3600_000, cost: 2.5 });                    // no projectId
    await legacy({ at: NOW - 3600_000, cost: 1.0, projectId: "team:a" });
    const filtered = await body(await GET(url(`?projectId=team:a`)));
    expect(filtered.coverage.legacyLedgerRows).toBe(1);
    expect(filtered.totals.pricedUsd).toBeCloseTo(1.0, 6);

    const none = await body(await GET(url(`?projectId=team:missing`)));
    expect(none.coverage.legacyLedgerRows).toBe(0);
    expect(none.totals.attempts).toBe(0);
  });

  it("does not double-count a traced attempt after trace retention prunes it", async () => {
    const requestId = await traced({ at: NOW - 3600_000, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(100, 0), tokenSource: "upstream" }] });
    // Retention deletes the trace metadata but keeps the ledger.
    adapter.run("DELETE FROM traceAttempts WHERE requestId = ?", [requestId]);
    adapter.run("DELETE FROM traces WHERE requestId = ?", [requestId]);
    const json = await body(await GET(url()));
    expect(json.coverage.requests).toBe(0);        // no trace to report
    expect(json.coverage.attempts).toBe(1);        // but the money is still counted
    expect(json.coverage.legacyLedgerRows).toBe(1);
    expect(json.totals.pricedUsd).toBeCloseTo(0.1, 6);
  });
});

describe("GET /api/usage/analytics — validation and errors", () => {
  it("rejects a malformed date with 400", async () => {
    const res = await GET(url("?from=yesterday"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await body(res)).error).toMatch(/UTC date range/i);
  });

  it("rejects a naive timestamp with no zone", async () => {
    // "2026-10-14T00:00:00" has no offset — the whole contract is UTC-explicit.
    expect((await GET(url("?from=2026-10-14T00:00:00"))).status).toBe(400);
  });

  it("rejects an inverted or over-long range with 400", async () => {
    expect((await GET(url(`?from=${TO}&to=${FROM}`))).status).toBe(400);
    expect((await GET(url(`?from=${iso(NOW - 200 * DAY)}&to=${TO}`))).status).toBe(400);
  });

  it("rejects an unknown bucket, groupBy or filter value with 400", async () => {
    expect((await GET(url("?bucket=minute"))).status).toBe(400);
    expect((await GET(url("?groupBy=region"))).status).toBe(400);
    expect((await GET(url("?projectId=<script>"))).status).toBe(400);
    expect((await GET(url("?taskId=" + "a".repeat(65)))).status).toBe(400);
    expect((await GET(url("?provider=" + "a".repeat(129)))).status).toBe(400);
  });

  it("never echoes an internal error message", async () => {
    vi.spyOn(traceRepo, "getUsageAnalytics").mockRejectedValueOnce(new Error("SQLITE_CONSTRAINT near \"secret token\""));
    const res = await GET(url());
    expect(res.status).toBe(500);
    const json = await body(res);
    expect(json.error).toBe("Failed to build usage analytics");
    expect(JSON.stringify(json)).not.toMatch(/SQLITE|secret token/);
    vi.restoreAllMocks();
  });

  it("defaults to a bounded window and a day bucket when no params are given", async () => {
    const json = await body(await GET(url()));
    expect(json.range.bucket).toBe("day");
    expect(json.range.timezone).toBe("UTC");
    const span = Date.parse(json.range.to) - Date.parse(json.range.from);
    expect(span).toBeLessThanOrEqual(90 * DAY);
  });
});

/**
 * The trace LIST is what the dashboard's per-request cost column reads. `cost`
 * alone goes null as soon as one dispatch in the chain is unpriced, so a single
 * unpriced attempt anywhere makes every row read "Unknown". `pricedUsd` keeps
 * the partial figure available without ever inventing a total.
 */
describe("listTraces — pricedUsd alongside the nullable request total", () => {
  const listOne = async (requestId) => {
    const { items } = await traceRepo.listTraces({ limit: 100, from: FROM, to: TO });
    return items.find((t) => t.requestId === requestId);
  };

  it("sums only the dispatches that could be priced, and leaves `cost` null", async () => {
    // alpha/m-1 prices at $1 per 1K; "unknown-model" is absent from the pricing
    // table, so that dispatch is unpriced and the request total stays unknown.
    const requestId = await traced({
      at: NOW - HOUR,
      attempts: [
        { provider: "beta", model: "unknown-model", tokens: pricedTokens(1000, 1000), tokenSource: "upstream" },
        { provider: "alpha", model: "m-1", tokens: pricedTokens(1000, 500), tokenSource: "upstream" },
      ],
    });

    const row = await listOne(requestId);
    expect(row.cost).toBeNull();
    expect(row.costStatus).toBe("unknown");
    expect(row.pricedUsd).toBeCloseTo(1.5, 6);
  });

  it("is null — not zero — when no dispatch in the request could be priced", async () => {
    const requestId = await traced({
      at: NOW - HOUR,
      attempts: [{ provider: "beta", model: "unknown-model", tokens: pricedTokens(1000, 1000), tokenSource: "upstream" }],
    });

    const row = await listOne(requestId);
    expect(row.pricedUsd).toBeNull();
  });

  it("reports an explicitly free dispatch as $0, which is known, not unknown", async () => {
    const requestId = await traced({ at: NOW - HOUR, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(0, 0), tokenSource: "upstream" }] });

    const row = await listOne(requestId);
    expect(row.pricedUsd).toBe(0);
    expect(row.cost).toBe(0);
  });

  it("does not let a legacy untraced row leak into another request's priced subtotal", async () => {
    const requestId = await traced({ at: NOW - HOUR, attempts: [{ provider: "alpha", model: "m-1", tokens: pricedTokens(1000, 1000), tokenSource: "upstream" }] });
    await legacy({ at: NOW - HOUR, cost: 99 });

    const row = await listOne(requestId);
    expect(row.pricedUsd).toBeCloseTo(2, 6);
  });
});