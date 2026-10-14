"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { StatusPill, formatMs, formatUsd, formatUsdPrecise } from "./format";

const utcTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(5, 16).replace("T", " ")}Z`;
};

/**
 * Trace drill-down. Metadata only — no prompt, output or raw header is ever
 * available here to render, because none is ever stored.
 */
export default function TraceDrilldown({ from, to }) {
  const [traces, setTraces] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ from, to, limit: "25" });
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/usage/traces?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setTraces(Array.isArray(json.items) ? json.items : []);
        setTotal(json.total || 0);
      } catch {
        if (!cancelled) setTraces([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  // Deselecting hides the panel via `selected`, so the stale detail is simply
  // not rendered — no synchronous reset needed inside the effect body.
  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    (async () => {
      setDetail(null);
      setDetailError(false);
      try {
        const res = await fetch(`/api/usage/traces/${encodeURIComponent(selected)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setDetail(json);
      } catch {
        if (!cancelled) setDetailError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <Card
      padding="sm"
      className="flex min-w-0 flex-col gap-3"
      title="Traces"
      subtitle={loading ? "Loading…" : `${traces.length} of ${total} requests in range`}
    >
      {!loading && traces.length === 0 ? (
        <p className="text-sm text-text-muted">No traced requests in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Traced requests in range</caption>
            <thead>
              <tr className="text-xs uppercase text-text-muted">
                <th scope="col" className="py-1 pr-2 font-semibold">Started (UTC)</th>
                <th scope="col" className="py-1 pr-2 font-semibold">Endpoint</th>
                <th scope="col" className="py-1 pr-2 font-semibold">Model</th>
                <th scope="col" className="py-1 pr-2 font-semibold">Task</th>
                <th scope="col" className="py-1 pr-2 text-right font-semibold">Priced cost</th>
                <th scope="col" className="py-1 pr-2 pl-3 font-semibold">Status</th>
                <th scope="col" className="py-1 text-right font-semibold"><span className="sr-only">Detail</span></th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr
                  key={t.requestId}
                  className={`border-t border-border-subtle ${selected === t.requestId ? "bg-surface-2" : ""}`}
                >
                  <th scope="row" className="py-2 pr-2 font-normal tabular-nums text-text-main">{utcTime(t.startTime)}</th>
                  <td className="py-2 pr-2 text-text-muted">{t.endpoint}</td>
                  <td className="py-2 pr-2 text-text-main">{t.requestedModel || "—"}</td>
                  <td className="max-w-[140px] truncate py-2 pr-2 text-text-muted" title={t.taskId || ""}>{t.taskId || "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-text-main">
                    {/* Priced subtotal, not the request total: `cost` is null as
                        soon as one dispatch in the chain was unpriced, which would
                        make this column read "Unknown" on every single row and
                        say nothing. Null here means nothing was priceable at all. */}
                    {t.pricedUsd == null ? <span className="text-[#B45309]">Unknown</span>
                      : t.pricedUsd > 0 && t.pricedUsd < 0.01 ? formatUsdPrecise(t.pricedUsd) : formatUsd(t.pricedUsd)}
                  </td>
                  <td className="py-2 pr-2 pl-3"><StatusPill status={t.status} /></td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(selected === t.requestId ? null : t.requestId)}
                      aria-expanded={selected === t.requestId}
                      className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                    >
                      {selected === t.requestId ? "Hide" : "Attempts"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="rounded-[10px] border border-border-subtle bg-bg p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase text-text-muted">
            Dispatches for {selected.slice(0, 8)}
          </h4>
          {detailError ? (
            <p className="text-sm text-text-muted">Could not load this trace.</p>
          ) : !detail ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : detail.attempts.length === 0 ? (
            <p className="text-sm text-text-muted">
              This request never reached an upstream provider — no dispatch was billed.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">Provider / model</th>
                  <th scope="col" className="py-1 pr-2 font-medium">TTFT</th>
                  <th scope="col" className="py-1 pr-2 font-medium">Duration</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">Tokens</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">Cost</th>
                  <th scope="col" className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.attempts.map((a) => (
                  <tr key={a.attemptId} className="border-t border-border-subtle">
                    <th scope="row" className="py-1 pr-2 font-normal text-text-main">
                      {a.provider}/{a.model}
                    </th>
                    <td className="py-1 pr-2 text-text-muted">{a.ttftMs == null ? "—" : formatMs(a.ttftMs)}</td>
                    <td className="py-1 pr-2 text-text-muted">{formatMs(a.durationMs)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-text-main">
                      {a.usage?.totalTokens ?? "—"}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums text-text-main">
                      {a.usage?.cost == null ? <span className="text-[#B45309]">Unknown</span>
                        : a.usage.cost > 0 && a.usage.cost < 0.01 ? formatUsdPrecise(a.usage.cost) : formatUsd(a.usage.cost)}
                    </td>
                    <td className="py-1"><StatusPill status={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

TraceDrilldown.propTypes = { from: PropTypes.string.isRequired, to: PropTypes.string.isRequired };