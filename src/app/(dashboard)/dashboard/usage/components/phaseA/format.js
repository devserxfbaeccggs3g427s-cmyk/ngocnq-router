/**
 * Shared formatting + validated visual tokens for the Phase A analytics surface.
 *
 * Palette provenance — every value below was run through the dataviz validator
 * (`dataviz/scripts/validate_palette.js`) against the real Card surface
 * (`--color-surface` = #ffffff light / #262626 dark), not eyeballed:
 *
 *   light  #cf222e #3B82F6 #10B981 #B45309  → all checks PASS
 *          (contrast WARN on success 2.54:1 → relieved by the always-visible
 *           text label on every status pill)
 *   dark   #dc2626 #3b82f6 #16a34a #b45309  → all checks PASS
 *          (CVD WARN 7.3 deutan on success↔warning → legal only with secondary
 *           encoding, which every status pill provides via icon + text label)
 *
 * Dark steps are *selected* from the same ramps and validated against the dark
 * surface — not an automatic flip of the light values.
 */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4,
});
const int = new Intl.NumberFormat("en-US");

export const formatUsd = (n) => (typeof n === "number" && Number.isFinite(n) ? usd.format(n) : "—");
export const formatUsdPrecise = (n) =>
  typeof n === "number" && Number.isFinite(n) ? (Math.abs(n) < 0.01 ? usdPrecise.format(n) : usd.format(n)) : "—";
export const formatInt = (n) => (typeof n === "number" && Number.isFinite(n) ? int.format(n) : "—");

export function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export const formatPct = (n) => (typeof n === "number" && Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");

export const formatMs = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
};

/**
 * A cost is only ever rendered as a number when the server said it is complete.
 * `null` means "we could not price part of this" and must never read as $0.
 */
export function CostValue({ total, priced, className = "" }) {
  if (total == null) {
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[16px] text-[#B45309]"
        >
          help
        </span>
        <span>Unknown</span>
      </span>
    );
  }
  return <span className={className}>{priced != null ? formatUsd(total) : formatUsdPrecise(total)}</span>;
}

/**
 * Status pill. Colour is NEVER the only carrier: every pill renders an icon and
 * a word, which is also what legalises the dark-mode CVD warning above.
 */
const STATUS_STYLES = {
  success: { icon: "check_circle", label: "Success", tone: "text-[#10B981] dark:text-[#16a34a]" },
  error: { icon: "error", label: "Error", tone: "text-[#cf222e] dark:text-[#dc2626]" },
  cancelled: { icon: "cancel", label: "Cancelled", tone: "text-text-muted" },
  pending: { icon: "pending", label: "Pending", tone: "text-[#B45309]" },
  running: { icon: "pending", label: "Running", tone: "text-[#B45309]" },
  unknown: { icon: "help", label: "Unknown", tone: "text-[#B45309]" },
  estimated: { icon: "schedule", label: "Estimated", tone: "text-[#3B82F6] dark:text-[#3b82f6]" },
};

export function StatusPill({ status, label, className = "" }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.unknown;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg px-2 py-0.5 text-xs font-medium ${style.tone} ${className}`}>
      <span aria-hidden="true" className="material-symbols-outlined text-[14px] leading-none">
        {style.icon}
      </span>
      <span>{label || style.label}</span>
    </span>
  );
}

/** The single UTC clock every surface on this page agrees on. */
export function utcRangeLabel(from, to) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${fmt.format(new Date(from))} → ${fmt.format(new Date(to))} UTC`;
}

export const RANGE_PRESETS = [
  { value: "24h", label: "24h", hours: 24 },
  { value: "7d", label: "7D", hours: 24 * 7 },
  { value: "30d", label: "30D", hours: 24 * 30 },
  { value: "90d", label: "90D", hours: 24 * 90 },
];

/** Presets resolve to explicit UTC instants — the API rejects naive timestamps. */
export function presetRange(hours, now = Date.now()) {
  return { from: new Date(now - hours * 3600_000).toISOString(), to: new Date(now).toISOString() };
}