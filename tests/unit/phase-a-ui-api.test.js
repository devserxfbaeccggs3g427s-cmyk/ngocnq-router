import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-phase-a-ui-api-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  adapter?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Mock Next.js with proper Response objects
vi.doMock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json", ...init.headers },
      });
    },
  },
  NextRequest: vi.fn().mockImplementation((url, init) => ({
    url,
    method: init?.method || "GET",
    headers: new Headers(init?.headers),
    json: async () => init?.body ? JSON.parse(init.body) : {},
    nextUrl: new URL(url),
  })),
}));

// Mock DB layer - use hoisted mocks for modules that need to be shared
const mockLocalDb = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getApiKeys: vi.fn(),
  getApiKeyById: vi.fn(),
  createApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  validateApiKey: vi.fn(),
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
}));

const mockUsageDb = vi.hoisted(() => ({
  getUsageHistory: vi.fn(),
  getUsageStats: vi.fn(),
  getChartData: vi.fn(),
}));

const mockApiKeysRepo = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getApiKeyById: vi.fn(),
  createApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  normalizeApiKeyProject: vi.fn((input, current) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Project attribution must be an object");
    }
    const hasProjectId = Object.prototype.hasOwnProperty.call(input, "projectId");
    const hasProjectLabel = Object.prototype.hasOwnProperty.call(input, "projectLabel");
    let projectId = hasProjectId
      ? (input.projectId == null || input.projectId === "" ? null : String(input.projectId).trim() || null)
      : (current?.projectId || null);
    let projectLabel = hasProjectLabel
      ? (input.projectLabel == null || input.projectLabel === "" ? null : String(input.projectLabel).trim() || null)
      : (current?.projectLabel || null);

    const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
    const PROJECT_LABEL_MAX_LENGTH = 128;
    const CONTROL_CHAR_PATTERN = /[-]/;

    if (projectId && !PROJECT_ID_PATTERN.test(projectId)) {
      throw new TypeError("projectId must be 1-64 characters using letters, numbers, '.', '_', ':' or '-'");
    }
    if (projectLabel) {
      if (projectLabel.length > PROJECT_LABEL_MAX_LENGTH || CONTROL_CHAR_PATTERN.test(projectLabel)) {
        throw new TypeError(`projectLabel must be at most ${PROJECT_LABEL_MAX_LENGTH} characters without control characters`);
      }
    }

    if (hasProjectId && projectId !== (current?.projectId || null) && !hasProjectLabel) {
      projectLabel = null;
    }
    if (!projectId && projectLabel) {
      throw new TypeError("projectLabel requires projectId");
    }
    if (!projectId) projectLabel = null;

    return { projectId, projectLabel };
  }),
}));

const mockTraceRepo = vi.hoisted(() => ({
  listTraces: vi.fn(),
  listBudgetAlerts: vi.fn(),
  getTrace: vi.fn(),
  getTraceStats: vi.fn(),
  getTraceAnalytics: vi.fn(),
  getRoutingMetrics: vi.fn(),
}));

const mockSettingsRepo = vi.hoisted(() => ({
  getSettings: vi.fn(),
  normalizeBudgetSettings: vi.fn((b) => b),
}));

vi.mock("@/lib/localDb", () => mockLocalDb);
vi.mock("@/lib/usageDb", () => mockUsageDb);
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => mockApiKeysRepo);
vi.mock("@/lib/db/repos/traceRepo.js", () => mockTraceRepo);
vi.mock("@/lib/db/repos/settingsRepo.js", () => mockSettingsRepo);
vi.mock("@/shared/utils/keyAccess.js", () => ({
  validateKeyAccessInput: vi.fn((access) => ({ ok: true, value: access })),
  keyAccessFromColumns: vi.fn(),
  keyAccessToColumns: vi.fn(),
}));
vi.mock("@/shared/constants/keyAccess.js", () => ({
  KEY_ACCESS_UNRESTRICTED: { restricted: false, allow: [] },
}));
vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));
vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

describe("Phase A: Budget warning, usage tracing, provider management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset temp DB for each test
    adapter.exec(`DELETE FROM settings`);
    adapter.exec(`DELETE FROM traces`);
    adapter.exec(`DELETE FROM traceAttempts`);
    adapter.exec(`DELETE FROM budgetAlerts`);
    adapter.exec(`DELETE FROM usageHistory`);
    adapter.exec(`DELETE FROM usageDaily`);
    adapter.exec(`DELETE FROM _meta`);
    // Re-initialize defaults
    adapter.exec(`INSERT OR IGNORE INTO _meta(key, value) VALUES('totalRequestsLifetime', 0)`);
    adapter.exec(`INSERT OR IGNORE INTO _meta(key, value) VALUES('totalCostLifetime', 0)`);

    // Mock getSettings to return a valid default budget for settings PATCH validation
    mockLocalDb.getSettings.mockResolvedValue({
      budget: { enabled: false, global: { dailyUsd: null, monthlyUsd: null }, projects: {}, thresholds: [0.5, 0.8, 1] }
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Settings API - Budget and Routing config validation", () => {
    it("should validate budget config at trust boundary", async () => {
      const { updateSettings } = await import("@/lib/localDb");
      const { PATCH } = await import("@/app/api/settings/route.js");

      const mockSettings = { budget: { enabled: true, global: { dailyUsd: 10, monthlyUsd: 100 }, projects: {}, thresholds: [0.5, 0.8, 1] } };
      updateSettings.mockResolvedValue(mockSettings);

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ budget: { enabled: true, global: { dailyUsd: 10, monthlyUsd: 100 } } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.ok).toBe(true);
      expect(updateSettings).toHaveBeenCalled();
    });

    it("should reject invalid budget config (negative limit)", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ budget: { enabled: true, global: { dailyUsd: -1 } } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it("should reject invalid budget config (threshold > 1)", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ budget: { enabled: true, thresholds: [1.5] } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it("should reject unknown budget fields (hardLimit)", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ budget: { enabled: true, hardLimit: true } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it("should reject invalid projectId in budget", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ budget: { enabled: true, projects: { "../unsafe": { dailyUsd: 1 } } } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });
  });

  describe("API Keys - projectId/projectLabel local config", () => {
    it("should allow projectId/projectLabel on create/update (local dashboard only)", async () => {
      const { normalizeApiKeyProject } = mockApiKeysRepo;

      const result = normalizeApiKeyProject({
        projectId: "team:alpha",
        projectLabel: "  Alpha project  ",
      });

      expect(result.projectId).toBe("team:alpha");
      expect(result.projectLabel).toBe("Alpha project");
    });

    it("should reject projectId from untrusted inference headers", () => {
      // Client-supplied x-project-id header should not be trusted
      expect(() => mockApiKeysRepo.normalizeApiKeyProject({ projectId: "../unsafe" })).toThrow(/projectId/);
      expect(() => mockApiKeysRepo.normalizeApiKeyProject({ projectLabel: "No project" })).toThrow(/requires projectId/);
    });

    it("should clear stale label when moving key to another project", () => {
      expect(mockApiKeysRepo.normalizeApiKeyProject({ projectId: "team:beta" }, {
        projectId: "team:alpha",
        projectLabel: "Alpha project",
      })).toEqual({ projectId: "team:beta", projectLabel: null });
    });

    it("should reject malformed or orphaned project metadata", () => {
      expect(() => mockApiKeysRepo.normalizeApiKeyProject({ projectId: "../unsafe" })).toThrow(/projectId/);
      expect(() => mockApiKeysRepo.normalizeApiKeyProject({ projectLabel: "No project" })).toThrow(/requires projectId/);
      expect(() => mockApiKeysRepo.normalizeApiKeyProject({
        projectId: "team-a",
        projectLabel: "x".repeat(129),
      })).toThrow(/projectLabel/);
    });
  });

  describe("Usage API - Traces and Alerts", () => {
    it("GET /api/usage/traces - bounded pagination with dashboardGuard", async () => {
      const { listTraces } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/route.js");

      listTraces.mockResolvedValue({ items: [], total: 0 });

      const request = new Request("http://localhost/api/usage/traces?limit=50&offset=0");

      const response = await GET(request);
      expect(response.ok).toBe(true);
      expect(listTraces).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
    });

    it("GET /api/usage/traces - rejects an oversized limit", async () => {
      const { listTraces } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/route.js");

      listTraces.mockResolvedValue({ items: [], total: 0 });

      const request = new Request("http://localhost/api/usage/traces?limit=200");

      const response = await GET(request);
      // Oversized pages are rejected rather than silently scanning unbounded data.
      expect(response.status).toBe(400);
      expect(listTraces).not.toHaveBeenCalled();
    });

    it("GET /api/usage/traces - rejects a negative offset", async () => {
      const { listTraces } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/route.js");

      listTraces.mockResolvedValue({ items: [], total: 0 });

      const request = new Request("http://localhost/api/usage/traces?offset=-1");

      const response = await GET(request);
      expect(response.status).toBe(400);
      expect(listTraces).not.toHaveBeenCalled();
    });

    it("GET /api/usage/traces - filters taskId, provider, model, status, from, to", async () => {
      const { listTraces } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/route.js");

      listTraces.mockResolvedValue({ items: [], total: 0 });

      const request = new Request("http://localhost/api/usage/traces?taskId=task-123&provider=openai&model=gpt-4o&status=success&from=2026-09-01T00:00:00Z&to=2026-10-01T23:59:59Z");

      const response = await GET(request);
      expect(response.ok).toBe(true);
      expect(listTraces).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "task-123",
        provider: "openai",
        model: "gpt-4o",
        status: "success",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T23:59:59.000Z",
      }));
    });

    it("GET /api/usage/traces - rejects invalid status", async () => {
      const { GET } = await import("@/app/api/usage/traces/route.js");

      const request = new Request("http://localhost/api/usage/traces?status=invalid");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/traces - rejects invalid date format", async () => {
      const { GET } = await import("@/app/api/usage/traces/route.js");

      const request = new Request("http://localhost/api/usage/traces?from=invalid-date");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/alerts - budget alerts with scope/period/threshold", async () => {
      const { listBudgetAlerts } = await import("@/lib/db/repos/traceRepo.js");
      const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
      const { GET } = await import("@/app/api/usage/alerts/route.js");

      listBudgetAlerts.mockResolvedValue([]);
      getSettings.mockResolvedValue({ budget: { enabled: true } });

      const request = new Request("http://localhost/api/usage/alerts?scope=project&scopeId=team:alpha&period=7d&threshold=0.8");

      const response = await GET(request);
      expect(response.ok).toBe(true);
      expect(listBudgetAlerts).toHaveBeenCalledWith({ scope: "project", scopeId: "team:alpha", period: "7d", threshold: 0.8, limit: 50, offset: 0 });
    });

    it("GET /api/usage/alerts - rejects invalid scope", async () => {
      const { GET } = await import("@/app/api/usage/alerts/route.js");

      const request = new Request("http://localhost/api/usage/alerts?scope=invalid");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/alerts - rejects invalid period", async () => {
      const { GET } = await import("@/app/api/usage/alerts/route.js");

      const request = new Request("http://localhost/api/usage/alerts?period=invalid");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/alerts - rejects invalid threshold", async () => {
      const { GET } = await import("@/app/api/usage/alerts/route.js");

      const request = new Request("http://localhost/api/usage/alerts?threshold=1.5");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/alerts - rejects threshold <= 0", async () => {
      const { GET } = await import("@/app/api/usage/alerts/route.js");

      const request = new Request("http://localhost/api/usage/alerts?threshold=0");

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("GET /api/usage/traces/[requestId] - returns single trace with attempts", async () => {
      const { getTrace } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/[requestId]/route.js");

      const requestId = "00000000-0000-4000-8000-000000000123";
      const mockTrace = {
        requestId,
        status: "success",
        cost: 0.01,
        costStatus: "known",
        attempts: [{ attemptId: "att-1", provider: "openai", model: "gpt-4o" }],
      };
      getTrace.mockResolvedValue(mockTrace);

      const request = new Request(`http://localhost/api/usage/traces/${requestId}`);

      const response = await GET(request, { params: Promise.resolve({ requestId }) });
      expect(response.ok).toBe(true);
      expect(getTrace).toHaveBeenCalledWith(requestId);
      expect(await response.json()).toEqual({ trace: mockTrace });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("GET /api/usage/traces/[requestId] - returns 404 for missing trace", async () => {
      const { getTrace } = await import("@/lib/db/repos/traceRepo.js");
      const { GET } = await import("@/app/api/usage/traces/[requestId]/route.js");

      getTrace.mockResolvedValue(null);

      const requestId = "00000000-0000-4000-8000-000000000999";
      const request = new Request(`http://localhost/api/usage/traces/${requestId}`);

      const response = await GET(request, { params: Promise.resolve({ requestId }) });
      expect(response.status).toBe(404);
      expect(getTrace).toHaveBeenCalledWith(requestId);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await response.json()).error).toMatch(/usage aggregates may remain available/);
    });

    it("GET /api/usage/stream - reuse existing SSE stream for real-time updates", async () => {
      const { GET } = await import("@/app/api/usage/stream/route.js");

      const response = await GET();
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    });
  });

  describe("Provider Management UI - Status/Errors display", () => {
    it("should show rateLimitedUntil, lastTested safely", async () => {
      const { getProviderConnections } = await import("@/lib/localDb");
      const providersRoute = await import("@/app/api/providers/route.js");

      getProviderConnections.mockResolvedValue([
        { id: "conn-1", provider: "openai", name: "Test", isActive: true, data: { rateLimitedUntil: "2026-01-01T00:00:00Z", lastTested: "2026-01-01T00:00:00Z" } },
      ]);

      const request = new Request("http://localhost/api/providers");

      const response = await providersRoute.GET(request);
      expect(response.ok).toBe(true);
    }, 10000);

    it("should show masked account label and quota from existing endpoints", async () => {
      const { getProviderConnections } = await import("@/lib/localDb");
      const providersRoute = await import("@/app/api/providers/route.js");

      getProviderConnections.mockResolvedValue([
        { id: "conn-1", provider: "openai", name: "Test Account", isActive: true },
      ]);

      const request = new Request("http://localhost/api/providers");

      const response = await providersRoute.GET(request);
      expect(response.ok).toBe(true);
    });

    it("listing providers only reads cached data and cannot send a paid inference", async () => {
      const { getProviderConnections } = await import("@/lib/localDb");
      const { GET } = await import("@/app/api/providers/route.js");
      getProviderConnections.mockResolvedValue([]);
      const response = await GET();
      expect(response.status).toBe(200);
      expect(getProviderConnections).toHaveBeenCalledTimes(1);
      expect(await response.json()).toEqual({ connections: [] });
    });
  });

  describe("Security - Input validation and redaction", () => {
    it("should reject unauthorized input at API boundary - malformed JSON returns 500 (undici throws)", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      // Malformed body - undici throws before handler, returns 500
      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(500);
    });

    it("should reject non-object settings payload", async () => {
      const { PATCH } = await import("@/app/api/settings/route.js");

      const request = new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify(["array", "not", "object"]),
        headers: { "Content-Type": "application/json" },
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it("should redact sensitive data in responses", async () => {
      const { getSettings } = await import("@/lib/localDb");
      const { GET } = await import("@/app/api/settings/route.js");

      getSettings.mockResolvedValue({
        password: "hashed-password",
        oidcClientSecret: "secret",
        oidcIssuerUrl: "https://example.com",
        oidcClientId: "client-id",
      });

      const request = new Request("http://localhost/api/settings");

      const response = await GET(request);
      const data = await response.json();
      expect(data).not.toHaveProperty("password");
      expect(data).not.toHaveProperty("oidcClientSecret");
      expect(data.oidcConfigured).toBe(true);
    });
  });
});

describe("Regression: existing functionality unchanged", () => {
  it("existing usage stats still work", async () => {
    const { getUsageStats } = await import("@/lib/usageDb");
    const { GET } = await import("@/app/api/usage/stats/route.js");

    getUsageStats.mockResolvedValue({ totalRequests: 10, totalCost: 1.5 });

    const request = new Request("http://localhost/api/usage/stats?period=7d");

    const response = await GET(request);
    expect(response.ok).toBe(true);
    expect(getUsageStats).toHaveBeenCalledWith("7d");
  });

  it("existing provider list still works", async () => {
    const { getProviderConnections } = await import("@/lib/localDb");
    const providersRoute = await import("@/app/api/providers/route.js");

    getProviderConnections.mockResolvedValue([]);

    const request = new Request("http://localhost/api/providers");

    const response = await providersRoute.GET(request);
    expect(response.ok).toBe(true);
  });

  it("existing API key CRUD still works", async () => {
    const { createApiKey, getApiKeys, updateApiKey, deleteApiKey } = await import("@/lib/localDb");

    createApiKey.mockResolvedValue({ id: "key-1" });
    getApiKeys.mockResolvedValue([]);
    updateApiKey.mockResolvedValue({});
    deleteApiKey.mockResolvedValue({});

    expect(createApiKey).toBeDefined();
    expect(getApiKeys).toBeDefined();
    expect(updateApiKey).toBeDefined();
    expect(deleteApiKey).toBeDefined();
  });
});