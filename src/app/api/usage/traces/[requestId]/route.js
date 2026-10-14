import { NextResponse } from "next/server";
import { getTrace } from "@/lib/db/repos/traceRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/traces/[requestId]
 * Returns a single trace with all its attempts for expanded row view.
 */
export async function GET(request, { params }) {
  try {
    const { requestId } = await params;

    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ error: "Invalid requestId" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const trace = await getTrace(requestId);
    if (!trace) {
      return NextResponse.json({ error: "Trace not found; usage aggregates may remain available" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ trace }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[API] Failed to get trace");
    return NextResponse.json({ error: "Failed to fetch trace" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}