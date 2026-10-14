"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { formatInt, formatPct, formatUsdPrecise, formatUsd } from "./format";

const BAR_COLOR = "#E56A4A"; // same validated single hue as the trend

/**
 * Ranked breakdown. Magnitude is encoded by bar LENGTH, not by colour, so every
 * bar is one hue — a rainbow here would imply the categories have an order or a
 * type they do not have. Values are printed in the table, never hover-only.
 */
export default function BreakdownTable({ groups, groupBy, truncated }) {
  if (!groupBy || !groups?.length) return null;

  const max = Math.max(...groups.map((g) => g.pricedUsd || 0), 0.000001);

  return (
    <Card
      padding="sm"
      className="flex min-w-0 flex-col gap-3"
      title={`By ${groupBy}`}
      subtitle={
        truncated > 0
          ? `Top ${groups.length - 1} + ${truncated} smaller rolled into “other”`
          : "Priced subtotal per group — Unknown is the share we could not price"
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <caption className="sr-only">{`Usage grouped by ${groupBy}`}</caption>
          <thead>
            <tr className="text-xs uppercase text-text-muted">
              <th scope="col" className="py-1 pr-2 font-semibold">{groupBy}</th>
              <th scope="col" className="w-[38%] py-1 pr-2 font-semibold">Share of priced cost</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Dispatches</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Unknown</th>
              <th scope="col" className="py-1 text-right font-semibold">Priced cost</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const width = Math.max(((g.pricedUsd || 0) / max) * 100, (g.pricedUsd || 0) > 0 ? 1.5 : 0);
              return (
                <tr key={g.key} className="border-t border-border-subtle">
                  <th scope="row" className="max-w-[220px] truncate py-2 pr-2 font-medium text-text-main" title={g.key}>
                    {g.key}
                    {g.rolledUp && <span className="ml-1.5 text-[10px] uppercase text-text-subtle">rollup</span>}
                    {g.legacyLedgerRows > 0 && (
                      <span className="ml-1.5 text-[10px] uppercase text-text-subtle">
                        {g.legacyLedgerRows} legacy
                      </span>
                    )}
                  </th>
                  <td className="py-2 pr-2">
                    <span className="block h-2 w-full overflow-hidden rounded-full bg-surface-2">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${width}%`, backgroundColor: BAR_COLOR }}
                      />
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-text-main">{formatInt(g.attempts)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {g.unknownAttempts > 0 ? (
                      <span className="text-[#B45309]">
                        {formatPct(g.unknownAttempts / (g.attempts || 1))}
                      </span>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums text-text-main">
                    {/* The column is a priced SUBTOTAL and always means the same
                        thing. `totalCostUsd` is null whenever even one dispatch in
                        the group could not be priced — which, once any unpriced
                        traffic exists, is every group, and a column of nothing but
                        "Unknown" tells the reader nothing. So: print what we can
                        price, let the Unknown % beside it carry the caveat, and
                        still refuse to print a number for a group with nothing
                        priced at all. */}
                    {!g.pricedAttempts ? (
                      <span className="text-[#B45309]">Unknown</span>
                    ) : g.pricedUsd > 0 && g.pricedUsd < 0.01 ? (
                      formatUsdPrecise(g.pricedUsd)
                    ) : (
                      formatUsd(g.pricedUsd)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

BreakdownTable.propTypes = {
  groups: PropTypes.array,
  groupBy: PropTypes.string,
  truncated: PropTypes.number,
};

BreakdownTable.defaultProps = { groups: [], groupBy: null, truncated: 0 };