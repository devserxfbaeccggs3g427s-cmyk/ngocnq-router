export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false || effectiveStatus === "disabled") return "default";
  if (["active", "success", "healthy"].includes(effectiveStatus)) return "success";
  if (["error", "expired", "unavailable"].includes(effectiveStatus)) return "error";
  if (["cooldown", "degraded"].includes(effectiveStatus)) return "warning";
  return "default";
}

export function formatStatusCheckedAt(value) {
  if (!value) return "Never checked";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Never checked";
  return `Checked ${date.toLocaleString()}`;
}

export function formatQuotaStatus(quota) {
  if (!quota || quota.status !== "known") return "Quota unknown";
  if (typeof quota.remainingPercentage === "number") {
    return `${Math.max(0, Math.round(quota.remainingPercentage))}% quota remaining`;
  }
  return "Quota available";
}
