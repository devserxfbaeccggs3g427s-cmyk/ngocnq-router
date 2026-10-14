import { NextResponse } from "next/server";
import { listTraces } from "@/lib/db/repos/traceRepo.js";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set(["success", "error", "pending", "cancelled"]);
const FILTER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

function parseInteger(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new TypeError("Invalid pagination");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new TypeError("Invalid pagination");
  return parsed;
}

function parseDate(value) {
  if (value === null) return null;
  if (!ISO_WITH_ZONE.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError("Invalid UTC date range");
  return new Date(value).toISOString();
}

function parseFilters(searchParams) {
  const now = Date.now();
  const from = parseDate(searchParams.get("from")) || new Date(now - MAX_RANGE_MS).toISOString();
  const to = parseDate(searchParams.get("to")) || new Date(now).toISOString();
  if (Date.parse(from) > Date.parse(to) || Date.parse(to) - Date.parse(from) > MAX_RANGE_MS) {
    throw new TypeError("Invalid UTC date range");
  }
  const filters = {};
  for (const name of ["taskId", "agentLabel", "provider", "model", "projectId", "apiKeyId"]) {
    const value = searchParams.get(name);
    if (value !== null) {
      if (!(name === "taskId" || name === "agentLabel" || name === "projectId" || name === "apiKeyId" ? LABEL_PATTERN : FILTER_PATTERN).test(value)) {
        throw new TypeError(`Invalid ${name}`);
      }
      filters[name] = value;
    }
  }
  return { ...filters, from, to };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const limit = parseInteger(searchParams.get("limit"), 50, 1, 100);
    const offset = parseInteger(searchParams.get("offset"), 0, 0, 100000);
    const status = searchParams.get("status");
    if (status !== null && !VALID_STATUSES.has(status)) throw new TypeError("Invalid status");
    const result = await listTraces({ limit, offset, status, ...parseFilters(searchParams) });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TypeError) return NextResponse.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "no-store" } });
    console.error("[API] Failed to list traces");
    return NextResponse.json({ error: "Failed to fetch traces" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}