// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 5;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
      // Project linkage (added in schema v3)
      projectId: "TEXT",
      projectLabel: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_project ON apiKeys(projectId)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      // NULL means pricing was unavailable. Explicit free usage is stored as 0.
      cost: "REAL",
      costStatus: "TEXT NOT NULL DEFAULT 'unknown'",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
      // Phase A: stable attribution and attempt-level billing dedup.
      apiKeyId: "TEXT",
      projectId: "TEXT",
      attemptId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey_id ON usageHistory(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_project ON usageHistory(projectId)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_attempt ON usageHistory(attemptId) WHERE attemptId IS NOT NULL",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  // Phase A: trace storage for smart routing
  traces: {
    columns: {
      requestId: "TEXT PRIMARY KEY",
      taskId: "TEXT",
      agentLabel: "TEXT",
      apiKeyId: "TEXT",
      projectId: "TEXT",
      requestedModel: "TEXT",
      endpoint: "TEXT",
      provider: "TEXT",
      comboName: "TEXT",
      accountId: "TEXT",
      startTime: "TEXT NOT NULL",
      endTime: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'pending'",
      httpStatus: "INTEGER",
      reason: "TEXT",
      // NULL means at least one attempt has unknown cost, or none were charged.
      cost: "REAL",
      costStatus: "TEXT NOT NULL DEFAULT 'unknown'",
      metricsJson: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(startTime DESC)",
      "CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(taskId)",
      "CREATE INDEX IF NOT EXISTS idx_traces_provider ON traces(provider)",
      "CREATE INDEX IF NOT EXISTS idx_traces_model ON traces(requestedModel)",
      "CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status)",
      "CREATE INDEX IF NOT EXISTS idx_traces_apikey ON traces(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_traces_project ON traces(projectId)",
    ],
  },
  traceAttempts: {
    columns: {
      attemptId: "TEXT PRIMARY KEY",
      requestId: "TEXT NOT NULL",
      provider: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      connectionId: "TEXT",
      startTime: "TEXT NOT NULL",
      endTime: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'running'",
      httpStatus: "INTEGER",
      ttftMs: "INTEGER",
      durationMs: "INTEGER",
      // No token counters here by design (v5). Numeric usage lives only in
      // usageHistory, joined by attemptId; attempts keep provenance metadata.
      tokenSource: "TEXT",
      cost: "REAL",
      costStatus: "TEXT NOT NULL DEFAULT 'unknown'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ta_request ON traceAttempts(requestId)",
      "CREATE INDEX IF NOT EXISTS idx_ta_provider ON traceAttempts(provider)",
      "CREATE INDEX IF NOT EXISTS idx_ta_model ON traceAttempts(model)",
      "CREATE INDEX IF NOT EXISTS idx_ta_conn ON traceAttempts(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_ta_status ON traceAttempts(status)",
    ],
  },
  // Phase A: budget alerts (unique per scope/period/threshold)
  budgetAlerts: {
    columns: {
      id: "TEXT PRIMARY KEY",
      scope: "TEXT NOT NULL",        // 'global' | 'project' | 'apiKey'
      scopeId: "TEXT NOT NULL",      // projectId or apiKeyId or 'global'
      periodType: "TEXT NOT NULL",   // 'daily' | 'monthly'
      periodKey: "TEXT NOT NULL",    // UTC date key: '2026-10-12' or '2026-10'
      threshold: "REAL NOT NULL",    // threshold ratio, e.g. 0.8 = 80%
      // Defaults keep ALTER TABLE upgrade-safe; inserts always provide snapshots.
      budgetUsd: "REAL NOT NULL DEFAULT 0",
      currentCost: "REAL NOT NULL DEFAULT 0",
      triggeredAt: "TEXT NOT NULL",
      notifiedAt: "TEXT",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ba_unique ON budgetAlerts(scope, scopeId, periodType, periodKey, threshold)",
      "CREATE INDEX IF NOT EXISTS idx_ba_triggered ON budgetAlerts(triggeredAt DESC)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
