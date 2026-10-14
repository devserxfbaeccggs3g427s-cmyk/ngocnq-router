import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BUDGET_KEYS = new Set(["enabled", "global", "projects", "thresholds"]);
const BUDGET_LIMIT_KEYS = new Set(["dailyUsd", "monthlyUsd"]);
const DEFAULT_BUDGET = Object.freeze({
  enabled: false,
  global: Object.freeze({ dailyUsd: null, monthlyUsd: null }),
  projects: Object.freeze({}),
  thresholds: Object.freeze([0.5, 0.8, 1]),
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Per-combo strategy entry (SR-01). `smartRoutingEnabled` is opt-in and must be a
// real boolean — a truthy string from the dashboard must never switch routing on.
const COMBO_STRATEGY_NAMES = new Set(["fallback", "round-robin", "fusion", "smart"]);
const COMBO_NAME_MAX = 200;

/**
 * Validate and bound the per-combo strategy map.
 *
 * Every value is length-capped and type-checked before it reaches the settings
 * blob: an unbounded combo name or a free-form strategy string would otherwise be
 * stored verbatim and later interpolated into logs and routing decisions.
 */
export function normalizeComboStrategies(value, fallback = {}) {
  if (value === undefined || value === null) return { ...fallback };
  if (!isPlainObject(value)) throw new TypeError("comboStrategies must be an object");
  const entries = Object.entries(value);
  if (entries.length > 500) throw new TypeError("comboStrategies supports at most 500 combos");

  const out = {};
  for (const [name, entry] of entries) {
    if (typeof name !== "string" || !name.trim() || name.length > COMBO_NAME_MAX) {
      throw new TypeError("comboStrategies contains an invalid combo name");
    }
    if (!isPlainObject(entry)) throw new TypeError(`comboStrategies["${name}"] must be an object`);

    const clean = { ...entry };
    if (Object.prototype.hasOwnProperty.call(clean, "smartRoutingEnabled")) {
      if (typeof clean.smartRoutingEnabled !== "boolean") {
        throw new TypeError(`comboStrategies["${name}"].smartRoutingEnabled must be a boolean`);
      }
    } else {
      delete clean.smartRoutingEnabled;
    }
    if (Object.prototype.hasOwnProperty.call(clean, "fallbackStrategy") && clean.fallbackStrategy !== null) {
      if (typeof clean.fallbackStrategy !== "string" || !COMBO_STRATEGY_NAMES.has(clean.fallbackStrategy)) {
        throw new TypeError(`comboStrategies["${name}"].fallbackStrategy is not a known strategy`);
      }
    }
    for (const key of ["judgeModel"]) {
      if (Object.prototype.hasOwnProperty.call(clean, key) && clean[key] != null) {
        if (typeof clean[key] !== "string" || clean[key].length > COMBO_NAME_MAX) {
          throw new TypeError(`comboStrategies["${name}"].${key} must be a short string`);
        }
      }
    }
    out[name] = clean;
  }
  return out;
}

function rejectUnknownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${path} contains unsupported field: ${unknown[0]}`);
}

function normalizeLimit(value, path) {
  if (value == null || value === 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive finite USD amount or null`);
  }
  return value;
}

function normalizeLimits(value, path, fallback = DEFAULT_BUDGET.global) {
  if (value === undefined) return { ...fallback };
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`);
  rejectUnknownKeys(value, BUDGET_LIMIT_KEYS, path);
  return {
    dailyUsd: Object.prototype.hasOwnProperty.call(value, "dailyUsd")
      ? normalizeLimit(value.dailyUsd, `${path}.dailyUsd`)
      : (fallback.dailyUsd ?? null),
    monthlyUsd: Object.prototype.hasOwnProperty.call(value, "monthlyUsd")
      ? normalizeLimit(value.monthlyUsd, `${path}.monthlyUsd`)
      : (fallback.monthlyUsd ?? null),
  };
}

/** Normalize the warning-only budget configuration stored in settings. */
export function normalizeBudgetSettings(value, fallback = DEFAULT_BUDGET) {
  if (!isPlainObject(value)) throw new TypeError("budget must be an object");
  rejectUnknownKeys(value, BUDGET_KEYS, "budget");

  const enabled = Object.prototype.hasOwnProperty.call(value, "enabled")
    ? value.enabled
    : fallback.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("budget.enabled must be a boolean");

  const projectsInput = value.projects === undefined ? (fallback.projects || {}) : value.projects;
  if (!isPlainObject(projectsInput)) throw new TypeError("budget.projects must be an object");
  if (Object.keys(projectsInput).length > 1000) throw new TypeError("budget.projects supports at most 1000 projects");
  const projects = {};
  for (const [projectId, limits] of Object.entries(projectsInput)) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new TypeError("budget.projects contains an invalid projectId");
    }
    projects[projectId] = normalizeLimits(limits, `budget.projects.${projectId}`);
  }

  const thresholdsInput = value.thresholds === undefined
    ? (fallback.thresholds || DEFAULT_BUDGET.thresholds)
    : value.thresholds;
  if (!Array.isArray(thresholdsInput) || thresholdsInput.length === 0 || thresholdsInput.length > 10) {
    throw new TypeError("budget.thresholds must contain 1-10 percentages");
  }
  const thresholds = [...new Set(thresholdsInput.map((threshold) => {
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new TypeError("budget.thresholds entries must be numbers greater than 0 and at most 1");
    }
    return threshold;
  }))].sort((a, b) => a - b);

  return {
    enabled,
    global: normalizeLimits(value.global, "budget.global", fallback.global),
    projects,
    thresholds,
  };
}

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  budget: DEFAULT_BUDGET,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
  providerOverrides: {},
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  try {
    merged.budget = normalizeBudgetSettings(
      isPlainObject(merged.budget) ? merged.budget : {},
      DEFAULT_BUDGET,
    );
  } catch {
    // Do not let stale malformed settings break startup. The PATCH endpoint rejects
    // invalid new values; legacy/corrupt persisted values fail closed to disabled.
    merged.budget = {
      enabled: false,
      global: { ...DEFAULT_BUDGET.global },
      projects: {},
      thresholds: [...DEFAULT_BUDGET.thresholds],
    };
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
