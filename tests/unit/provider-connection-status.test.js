import { describe, expect, it } from "vitest";
import {
  buildProviderConnectionStatus,
  maskSensitiveAccountLabel,
  normalizeCachedQuota,
  sanitizeProviderError,
} from "../../src/lib/providerConnectionStatus.js";
import {
  formatQuotaStatus,
  getStatusVariant,
} from "../../src/shared/utils/connectionStatus.js";

describe("provider connection status", () => {
  it("redacts credentials, auth headers, and URL query strings from errors", () => {
    const sanitized = sanitizeProviderError(
      "401 Authorization: Bearer secret-token-123456789 api_key=sk-live-1234567890 https://user:pass@example.com/path?token=secret",
    );

    expect(sanitized).toContain("Authorization=[REDACTED]");
    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("sk-live");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("?token");
  });

  it("masks opaque account labels but preserves human-readable names", () => {
    expect(maskSensitiveAccountLabel("Production Account")).toBe("Production Account");
    expect(maskSensitiveAccountLabel("abcdefghijklmnopqrstuvwxyz123456"))
      .toBe("abcdef***3456");
  });

  it("reports disabled, cooldown, degraded, healthy, and unknown states", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(buildProviderConnectionStatus({ isActive: false }).state).toBe("disabled");
    expect(buildProviderConnectionStatus({ isActive: true, rateLimitedUntil: future }).state).toBe("cooldown");
    expect(buildProviderConnectionStatus({ isActive: true, testStatus: "active", lastError: "credits exhausted" }).state).toBe("degraded");
    expect(buildProviderConnectionStatus({ isActive: true, testStatus: "active" }).state).toBe("healthy");
    expect(buildProviderConnectionStatus({ isActive: true, testStatus: "unknown" }).state).toBe("unknown");
  });

  it("uses the latest active cooldown across account and model locks", () => {
    const earlier = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();
    const status = buildProviderConnectionStatus({
      isActive: true,
      rateLimitedUntil: earlier,
      modelLock_modelA: later,
      modelLock_expired: new Date(Date.now() - 1000).toISOString(),
    });
    expect(status.cooldownUntil).toBe(later);
  });

  it("returns explicit unknown quota without triggering any provider fetch", () => {
    expect(normalizeCachedQuota(null)).toEqual({
      status: "unknown",
      source: null,
      remainingPercentage: null,
      resetAt: null,
      items: [],
    });
    expect(formatQuotaStatus(normalizeCachedQuota(null))).toBe("Quota unknown");
  });

  it("normalizes cached quota and picks the most constrained remaining percentage", () => {
    const quota = normalizeCachedQuota({
      modelA: { remainingPercentage: 80, resetAt: "2026-10-13T12:00:00.000Z" },
      modelB: { remainingPercentage: 25, resetAt: "2026-10-14T12:00:00.000Z" },
    });
    expect(quota.status).toBe("known");
    expect(quota.source).toBe("cache");
    expect(quota.remainingPercentage).toBe(25);
    expect(quota.resetAt).toBe("2026-10-14T12:00:00.000Z");
    expect(formatQuotaStatus(quota)).toBe("25% quota remaining");
  });

  it("maps provider health states to badge variants", () => {
    expect(getStatusVariant(true, "healthy")).toBe("success");
    expect(getStatusVariant(true, "degraded")).toBe("warning");
    expect(getStatusVariant(true, "cooldown")).toBe("warning");
    expect(getStatusVariant(true, "error")).toBe("error");
    expect(getStatusVariant(false, "healthy")).toBe("default");
  });
});
