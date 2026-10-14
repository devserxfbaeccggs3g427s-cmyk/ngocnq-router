"use client";

import PropTypes from "prop-types";
import { formatInt, formatPct, formatTokens, formatUsd, formatUsdPrecise, StatusPill } from "./format";

function Tile({ label, children, hint, hintTone = "muted" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-border-subtle bg-bg px-3 py-3 shadow-[var(--shadow-soft)] sm:px-4">
      <span className="text-xs font-semibold uppercase text-text-muted">{label}</span>
      <span className="truncate text-lg font-bold text-text-main sm:text-xl">{children}</span>
      {hint && (
        <span className={`text-[11px] leading-tight ${hintTone === "warn" ? "text-[#B45309]" : "text-text-muted"}`}>
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * KPI row. The headline is the *priced subtotal*, and the gap is stated as a
 * ratio rather than hidden — a partial cost never silently reads as a total.
 */
export default function KpiTiles({ totals, coverage }) {
  const complete = coverage.unknown === 0;
  const unpriced = coverage.unknown > 0;

  return (
    <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-5">
      <Tile
        label="Total cost"
        hint={complete ? "Every attempt priced" : `${coverage.unknown} of ${coverage.attempts} attempts unpriced`}
        hintTone={unpriced ? "warn" : "muted"}
      >
        {totals.totalCostUsd == null ? (
          <span className="inline-flex items-center gap-1 text-[#B45309]">
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">help</span>
            Unknown
          </span>
        ) : totals.totalCostUsd > 0 && totals.totalCostUsd < 0.01 ? (
          formatUsdPrecise(totals.totalCostUsd)
        ) : (
          formatUsd(totals.totalCostUsd)
        )}
      </Tile>

      <Tile label="Priced subtotal" hint="What we can actually price">
        {formatUsdPrecise(totals.pricedUsd)}
      </Tile>

      <Tile
        label="Unknown cost"
        hint={coverage.attempts ? `${coverage.estimated} estimated · ${coverage.priced} confirmed` : "No attempts in range"}
        hintTone={unpriced ? "warn" : "muted"}
      >
        {formatPct(coverage.unknownRatio)}
      </Tile>

      <Tile label="Requests" hint={`${totals.success} ok · ${totals.error} error · ${totals.pending} pending`}>
        {formatInt(totals.requests)}
      </Tile>

      <Tile
        label="Dispatches"
        hint={`${formatInt(totals.attempts)} attempts · ${formatTokens(totals.totalTokens)} tokens`}
      >
        {formatInt(totals.attempts)}
      </Tile>
    </div>
  );
}

/**
 * Coverage disclosure. Phase A traces chat endpoints only — paid paths outside
 * that scope are named so their cost reads as unknown, never as free.
 */
export function CoverageNotice({ coverage }) {
  const tracing = coverage.tracing;
  if (!tracing) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-border-subtle bg-bg px-3 py-3 text-xs text-text-muted sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={tracing.untracedPaidEndpoints?.length ? "unknown" : "success"}
          label={tracing.untracedPaidEndpoints?.length ? "Partial tracing" : "Full tracing"} />
        <span>
          {tracing.tracedEndpoints?.length || 0} endpoint{tracing.tracedEndpoints?.length === 1 ? "" : "s"} traced
          {coverage.legacyLedgerRows > 0 && ` · ${coverage.legacyLedgerRows} legacy ledger row${coverage.legacyLedgerRows === 1 ? "" : "s"} included`}
        </span>
      </div>
      {tracing.untracedPaidEndpoints?.length > 0 && (
        <p>
          <span className="font-medium text-text-main">Not traced:</span>{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">
            {tracing.untracedPaidEndpoints.join(", ")}
          </code>{" "}
          — their cost is unknown, not zero.
        </p>
      )}
    </div>
  );
}

KpiTiles.propTypes = { totals: PropTypes.object.isRequired, coverage: PropTypes.object.isRequired };
CoverageNotice.propTypes = { coverage: PropTypes.object.isRequired };