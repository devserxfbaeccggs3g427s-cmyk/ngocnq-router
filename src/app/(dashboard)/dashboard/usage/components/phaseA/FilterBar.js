"use client";

import PropTypes from "prop-types";
import { RANGE_PRESETS, utcRangeLabel } from "./format";

const BUCKETS = [
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
];

const GROUP_BYS = [
  { value: "", label: "No grouping" },
  { value: "provider", label: "Provider" },
  { value: "model", label: "Model" },
  { value: "project", label: "Project" },
  { value: "task", label: "Task" },
  { value: "agent", label: "Agent" },
  { value: "apiKey", label: "API key" },
];

/**
 * One filter row, one clock. Every KPI, chart and table on the page is driven
 * from exactly this state, so a number in the header can never disagree with a
 * number in a table.
 */
export default function FilterBar({ filters, onChange, range, updating }) {
  const set = (patch) => onChange({ ...filters, ...patch });

  const applyPreset = (preset) => {
    const to = new Date();
    const from = new Date(to.getTime() - preset.hours * 3600_000);
    set({ preset: preset.value, from: from.toISOString(), to: to.toISOString() });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Range preset */}
        <div
          role="group"
          aria-label="Time range (UTC)"
          className="grid gap-1 rounded-lg border border-border bg-surface-2 p-1"
          style={{ gridTemplateColumns: `repeat(${RANGE_PRESETS.length}, minmax(0, 1fr))` }}
        >
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={filters.preset === p.value}
              onClick={() => applyPreset(p)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${
                filters.preset === p.value
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Bucket */}
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <span className="sr-only sm:not-sr-only">Bucket</span>
          <select
            value={filters.bucket}
            onChange={(e) => set({ bucket: e.target.value })}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            {BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </label>

        {/* Group by */}
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <span className="sr-only sm:not-sr-only">Group by</span>
          <select
            value={filters.groupBy}
            onChange={(e) => set({ groupBy: e.target.value })}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            {GROUP_BYS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </label>

        {/* Attribution drill filters — optional, pattern-validated server-side. */}
        {["projectId", "taskId", "agentLabel"].map((name) => (
          <input
            key={name}
            type="text"
            value={filters[name] || ""}
            onChange={(e) => set({ [name]: e.target.value })}
            placeholder={name === "projectId" ? "Project" : name === "taskId" ? "Task id" : "Agent"}
            aria-label={`Filter by ${name}`}
            maxLength={64}
            className="w-32 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          />
        ))}

        {updating && (
          <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-xs text-text-muted">
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
            Updating
          </span>
        )}
      </div>

      {/* The clock, stated once, so nobody has to infer the timezone. */}
      <p className="text-xs text-text-muted">
        {utcRangeLabel(range.from, range.to)} · all figures UTC
      </p>
    </div>
  );
}

FilterBar.propTypes = {
  filters: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  range: PropTypes.object.isRequired,
  updating: PropTypes.bool,
};

FilterBar.defaultProps = { updating: false };