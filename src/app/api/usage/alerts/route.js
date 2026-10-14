import { NextResponse } from "next/server";
import { listBudgetAlerts } from "@/lib/db/repos/traceRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d"]);
const VALID_SCOPES = new Set(["global", "project"]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * GET /api/usage/alerts
 * Query parameters: scope, period, threshold
 * Returns budget alerts from durable DB storage.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope") || "global";
    const period = searchParams.get("period") || "30d";
    const thresholdParam = searchParams.get("threshold");
    const threshold = thresholdParam == null ? null : Number(thresholdParam);
    const scopeId = searchParams.get("scopeId");
    const limitParam = searchParams.get("limit");
    const offsetParam = searchParams.get("offset");
    if ((scopeId !== null && (scope !== "project" || !PROJECT_ID_PATTERN.test(scopeId))) || (scope === "project" && !scopeId)) {
      return NextResponse.json({ error: "Invalid scopeId" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if ((limitParam !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitParam)) ||
        (offsetParam !== null && (!/^\d+$/.test(offsetParam) || Number(offsetParam) > 100000))) {
      return NextResponse.json({ error: "Invalid pagination" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const limit = limitParam === null ? 50 : Number(limitParam);
    const offset = offsetParam === null ? 0 : Number(offsetParam);

    // Validate scope
    if (!VALID_SCOPES.has(scope)) {
      return NextResponse.json({ error: "Invalid scope. Must be global or project." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    // Validate period (matches traceRepo's period format)
    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period. Must be 24h, 7d, 30d, or 60d." }, { status: 400 });
    }

    // Validate threshold (0-1 range for percentage of budget)
    if (thresholdParam != null && (thresholdParam.trim() === "" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
      return NextResponse.json({ error: "Invalid threshold. Must be a number in (0, 1]." }, { status: 400 });
    }

    const [alerts, settings] = await Promise.all([
      listBudgetAlerts({ scope, scopeId, period, threshold, limit, offset }),
      getSettings(),
    ]);

    return NextResponse.json({ alerts, budgetEnabled: settings.budget?.enabled === true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[API] Failed to get budget alerts");
    return NextResponse.json({ error: "Failed to fetch budget alerts" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}