"use client";

import { useId, useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import Card from "@/shared/components/Card";
import { formatInt, formatMs, formatPct, formatTokens, formatUsdPrecise } from "./format";

// Single-hue data mark. Brand #E56A4A passes the lightness band, chroma floor
// and >=3:1 contrast against BOTH the light (#ffffff) and dark (#262626) card
// surface, so the same step is correct in either mode without a flip.
const SERIES_COLOR = "#E56A4A";

const METRICS = [
  // Axis ticks are rounded labels, not money: "$0.0000" is noise. Cents are kept
  // only while the whole axis lives below a dollar.
  {
    value: "pricedUsd",
    label: "Priced cost",
    format: formatUsdPrecise,
    axis: (v) => (v === 0 ? "$0" : v < 1 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString("en-US")}`),
    note: "Priced subtotal — buckets with unpriced attempts are lower than actual.",
  },
  { value: "totalTokens", label: "Tokens", format: formatTokens, axis: formatTokens },
  { value: "requests", label: "Requests", format: formatInt, axis: formatInt },
  { value: "attempts", label: "Dispatches", format: formatInt, axis: formatInt },
  { value: "p95Ms", label: "p95 latency", format: formatMs, axis: (v) => (v == null ? "" : formatMs(v)) },
];

function shortLabel(bucket, isoFrom) {
  const d = new Date(isoFrom);
  if (Number.isNaN(d.getTime())) return String(isoFrom);
  return bucket === "hour"
    ? `${String(d.getUTCHours()).padStart(2, "0")}:00`
    : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * One measure, one axis. There is deliberately no second y-scale: a cost and a
 * token count never share a frame, and the unknown-cost gap is reported as a
 * labelled column rather than smuggled onto the plot as a second series.
 */
export default function TrendChart({ series, bucket, loading }) {
  const [metric, setMetric] = useState("pricedUsd");
  const [view, setView] = useState("chart");
  const gradientId = useId().replace(/:/g, "");
  const cfg = METRICS.find((m) => m.value === metric) || METRICS[0];

  const data = useMemo(
    () => series.map((s) => ({ ...s, short: shortLabel(bucket, s.from || s.key) })),
    [series, bucket],
  );

  const hasData = data.some((d) => Number(d[metric]) > 0);

  return (
    <Card
      padding="sm"
      className="flex min-w-0 flex-col gap-3"
      title="Trend"
      subtitle={cfg.note || "One measure per frame"}
      action={
        <div className="flex items-center gap-2">
          <div className="hidden gap-1 rounded-lg border border-border bg-surface-2 p-1 sm:grid" style={{ gridTemplateColumns: `repeat(${METRICS.length}, minmax(0, 1fr))` }}>
            {METRICS.map((m) => (
              <button
                key={m.value}
                type="button"
                aria-pressed={metric === m.value}
                onClick={() => setMetric(m.value)}
                className={`rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${
                  metric === m.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {/* Every chart has a table equivalent — never hover-only information. */}
          <button
            type="button"
            onClick={() => setView(view === "chart" ? "table" : "chart")}
            aria-pressed={view === "table"}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            {view === "chart" ? "Table" : "Chart"}
          </button>
        </div>
      }
    >
      <label className="flex items-center gap-2 text-xs text-text-muted sm:hidden">
        <span>Measure</span>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        >
          {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>

      {!hasData && !loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-text-muted">
          No data in this range
        </div>
      ) : view === "table" ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{cfg.label} by UTC {bucket}</caption>
            <thead className="sticky top-0 bg-bg text-text-muted">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">Bucket (UTC)</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">{cfg.label}</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">Unknown</th>
                <th scope="col" className="py-1 text-right font-medium">Dispatches</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key} className="border-t border-border-subtle">
                  <th scope="row" className="py-1 pr-2 font-normal text-text-main">{d.short}</th>
                  <td className="py-1 pr-2 text-right tabular-nums text-text-main">
                    {d[metric] == null ? "—" : cfg.format(d[metric])}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-text-muted">
                    {d.unknownAttempts > 0 ? (
                      <span className="text-[#B45309]">{`${d.unknownAttempts} (${formatPct(d.unknownAttempts / (d.attempts || 1))})`}</span>
                    ) : "0"}
                  </td>
                  <td className="py-1 text-right tabular-nums text-text-muted">{formatInt(d.attempts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={SERIES_COLOR} stopOpacity={0.22} />
                <stop offset="95%" stopColor={SERIES_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Recessive grid: present for reading values, never competing with the mark. */}
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
            <XAxis
              dataKey="short"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={cfg.axis}
              width={56}
            />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.25 }}
              contentStyle={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "10px",
                fontSize: "12px",
              }}
              labelFormatter={(label, payload) => `${payload?.[0]?.payload?.short || label} UTC`}
              formatter={(value, name) => [cfg.format(value), cfg.label]}
            />
            <Area
              type="monotone"
              dataKey={metric}
              stroke={SERIES_COLOR}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

TrendChart.propTypes = {
  series: PropTypes.array.isRequired,
  bucket: PropTypes.string.isRequired,
  loading: PropTypes.bool,
};

TrendChart.defaultProps = { loading: false };