"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FilterBar from "./phaseA/FilterBar";
import KpiTiles, { CoverageNotice } from "./phaseA/KpiTiles";
import TrendChart from "./phaseA/TrendChart";
import BreakdownTable from "./phaseA/BreakdownTable";
import BudgetAlerts from "./phaseA/BudgetAlerts";
import TraceDrilldown from "./phaseA/TraceDrilldown";
import { presetRange } from "./phaseA/format";

const EMPTY = {
  range: { from: new Date(0).toISOString(), to: new Date(0).toISOString(), bucket: "day", timezone: "UTC" },
  totals: { requests: 0, attempts: 0, success: 0, error: 0, pending: 0, pricedUsd: 0, totalCostUsd: 0, totalTokens: 0 },
  coverage: { requests: 0, attempts: 0, priced: 0, estimated: 0, unknown: 0, unknownRatio: 0, legacyLedgerRows: 0 },
  series: [],
  groups: [],
  groupsTruncated: 0,
};

/**
 * The unified Phase A surface. One filter row owns the clock and every panel
 * below reads from the same query, so a KPI can never disagree with the table
 * next to it. Text inputs are debounced into the same state rather than firing
 * a request per keystroke.
 */
export default function PhaseAOverview() {
  const [filters, setFilters] = useState(() => ({ ...presetRange(24 * 7), preset: "7d", bucket: "day", groupBy: "provider" }));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const debounceRef = useRef(null);
  const hasData = useRef(false);

  const setFiltersDebounced = useCallback((next) => {
    setFilters(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilters(next), 350);
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      from: filters.from, to: filters.to, bucket: filters.bucket,
    });
    if (filters.groupBy) params.set("groupBy", filters.groupBy);
    // Empty inputs are "no filter", not "filter for the empty string".
    for (const key of ["projectId", "taskId", "agentLabel"]) {
      const value = filters[key]?.trim();
      if (value) params.set(key, value);
    }
    return params.toString();
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Keep the previous payload on screen while refetching — replacing it with a
      // skeleton on every filter change is what makes a dashboard feel like it is
      // blinking, and it also throws away numbers the reader is mid-way through.
      if (hasData.current) setUpdating(true);
      else setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/usage/analytics?${query}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json?.error || "Could not load analytics"); return; }
        setData(json);
        hasData.current = true;
      } catch {
        if (!cancelled) setError("Could not load analytics");
      } finally {
        if (!cancelled) { setLoading(false); setUpdating(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [query]);

  const payload = data || EMPTY;

  if (error && !data) {
    return (
      <div className="rounded-[14px] border border-border-subtle bg-surface p-4 text-sm text-text-muted">
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-text-muted" role="status" aria-live="polite">
        Loading analytics…
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        filters={filters}
        onChange={setFiltersDebounced}
        range={payload.range}
        updating={updating}
      />

      {error && (
        <p role="alert" className="rounded-[10px] border border-border-subtle bg-bg px-3 py-2 text-xs text-[#B45309]">
          {error} — showing the last successful read.
        </p>
      )}

      <KpiTiles totals={payload.totals} coverage={payload.coverage} />
      <CoverageNotice coverage={payload.coverage} />

      <TrendChart series={payload.series} bucket={payload.range.bucket} loading={loading} />

      <BreakdownTable
        groups={payload.groups}
        groupBy={payload.groupBy}
        truncated={payload.groupsTruncated}
      />

      <BudgetAlerts />

      <TraceDrilldown from={filters.from} to={filters.to} />
    </div>
  );
}