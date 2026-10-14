"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { StatusPill, formatUsd } from "./format";

function severity(threshold) {
  if (threshold >= 1) return { status: "error", label: "Over budget" };
  if (threshold >= 0.9) return { status: "error", label: "Critical" };
  return { status: "unknown", label: "Warning" };
}

/**
 * Budget warnings. `budgetEnabled` is read from settings, never inferred from
 * whether rows happen to exist — an empty list means "no threshold crossed",
 * not "no budget configured", and the panel says which one it is.
 */
export default function BudgetAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [budgetEnabled, setBudgetEnabled] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/usage/alerts?limit=25", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setAlerts(Array.isArray(json.alerts) ? json.alerts : []);
        setBudgetEnabled(json.budgetEnabled === true);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Card
      padding="sm"
      className="flex min-w-0 flex-col gap-3"
      title="Budget"
      subtitle={budgetEnabled === null ? "Loading…" : budgetEnabled ? "Global and project budgets (UTC periods)" : "No budget configured"}
      action={budgetEnabled ? <StatusPill status="success" label="Enabled" /> : null}
    >
      {error ? (
        <p className="text-sm text-text-muted">Could not load budget alerts.</p>
      ) : !budgetEnabled ? (
        <p className="text-sm text-text-muted">
          Budgets are off, so no thresholds are being watched. Nothing is being capped — requests are never
          blocked or rerouted by a budget.
        </p>
      ) : alerts.length === 0 ? (
        <p className="text-sm text-text-muted">No threshold crossed in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="sr-only">Budget warnings</caption>
            <thead>
              <tr className="text-xs uppercase text-text-muted">
                <th scope="col" className="py-1 pr-2 font-semibold">Scope</th>
                <th scope="col" className="py-1 pr-2 font-semibold">Period</th>
                <th scope="col" className="py-1 pr-2 text-right font-semibold">Cost / budget</th>
                <th scope="col" className="py-1 pr-2 text-right font-semibold">Threshold</th>
                <th scope="col" className="py-1 text-right font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => {
                const sev = severity(a.threshold);
                return (
                  <tr key={a.id ?? `${a.scopeId}-${a.periodKey}-${a.threshold}`} className="border-t border-border-subtle">
                    <th scope="row" className="max-w-[200px] truncate py-2 pr-2 font-medium text-text-main" title={a.scopeId}>
                      {a.scope === "global" ? "Global" : a.scopeId}
                    </th>
                    <td className="py-2 pr-2 text-text-muted">
                      {a.periodType} · {a.periodKey}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-text-main">
                      {formatUsd(a.currentCost)} / {formatUsd(a.budgetUsd)}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-text-muted">
                      {Math.round(a.threshold * 100)}%
                    </td>
                    <td className="py-2 text-right">
                      <StatusPill status={sev.status} label={sev.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

BudgetAlerts.propTypes = {};