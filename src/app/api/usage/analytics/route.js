import { NextResponse } from "next/server";
import {
  getUsageAnalytics,
  ANALYTICS_BUCKETS,
  ANALYTICS_GROUP_BYS,
} from "@/lib/db/repos/traceRepo.js";
import { getTraceCoverage } from "@/lib/traceCoverage.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

// Reuse the trace route's bounds so both surfaces agree on what is queryable.
function parseDate(value, fallback) {
  if (value === null) return fallback;
  if (!ISO_WITH_ZONE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Invalid UTC date range");
  }
  return new Date(value).toISOString();
}

function parseFilters(searchParams) {
  const now = Date.now();
  const from = parseDate(searchParams.get("from"), new Date(now - MAX_RANGE_MS).toISOString());
  const to = parseDate(searchParams.get("to"), new Date(now).toISOString());
  if (Date.parse(from) > Date.parse(to) || Date.parse(to) - Date.parse(from) > MAX_RANGE_MS) {
    throw new TypeError("Invalid UTC date range");
  }

  const filters = {};
  for (const name of ["taskId", "agentLabel", "projectId", "apiKeyId"]) {
    const value = searchParams.get(name);
    if (value !== null) {
      if (!LABEL_PATTERN.test(value)) throw new TypeError(`Invalid ${name}`);
      filters[name] = value;
    }
  }
  for (const name of ["provider", "model"]) {
    const value = searchParams.get(name);
    if (value !== null) {
      if (!PROVIDER_PATTERN.test(value)) throw new TypeError(`Invalid ${name}`);
      filters[name] = value;
    }
  }

  const bucket = searchParams.get("bucket");
  if (bucket !== null && !ANALYTICS_BUCKETS.includes(bucket)) throw new TypeError("Invalid analytics bucket");

  const groupBy = searchParams.get("groupBy");
  if (groupBy !== null && !Object.hasOwn(ANALYTICS_GROUP_BYS, groupBy)) {
    throw new TypeError("Invalid analytics groupBy");
  }

  return { from, to, bucket: bucket || "day", groupBy, ...filters };
}

/**
 * GET /api/usage/analytics
 *
 * Request-level analytics over an explicit UTC range, read from the trace + ledger
 * rather than the local-day aggregates the legacy usage UI uses, so every filter,
 * KPI, chart and table on a screen agrees on one clock and one cost basis.
 *
 * `totals.totalCostUsd` is null whenever any attempt could not be priced —
 * `totals.pricedUsd` is the priced subtotal, and `coverage.unknown` says how much
 * is missing. `coverage.tracing` states which paid `/v1/*` paths are outside Phase A
 * tracing entirely, so an untraced endpoint is never read as "$0".
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const analytics = await getUsageAnalytics(parseFilters(searchParams));
    return NextResponse.json(
      { ...analytics, coverage: { ...analytics.coverage, tracing: getTraceCoverage() } },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    // Never echo an internal error message: it can carry SQL text.
    console.error("[API] Failed to build usage analytics:", error?.message);
    return NextResponse.json({ error: "Failed to build usage analytics" }, { status: 500, headers: NO_STORE });
  }
}