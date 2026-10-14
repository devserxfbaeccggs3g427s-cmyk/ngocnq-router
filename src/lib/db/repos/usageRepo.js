import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { calculateCost } from "./pricingRepo.js";
import { getSettings } from "./settingsRepo.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return key.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return key.slice(0, 8) + "***" + key.slice(-4);
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getUtcPeriodStart(periodType, timestamp = new Date()) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (periodType === "daily") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

async function sumKnownCostSince({ startTime, endTime, projectId = null }) {
  const db = await getAdapter();
  const params = [startTime, endTime];
  let projectFilter = "";
  if (projectId) {
    projectFilter = "AND projectId = ?";
    params.push(projectId);
  }
  const row = db.get(
    `SELECT COALESCE(SUM(cost), 0) AS total
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp <= ?
       AND costStatus IN ('known', 'estimated')
       ${projectFilter}`,
    params,
  );
  return Number(row?.total) || 0;
}

async function evaluateBudgetAlerts(entry) {
  if (entry.costStatus === "unknown") return;
  const settings = await getSettings();
  const budget = settings.budget;
  if (!budget?.enabled) return;

  const { checkBudgetAlert } = await import("./traceRepo.js");
  const now = new Date(entry.timestamp || Date.now());
  const thresholds = Array.isArray(budget.thresholds) ? budget.thresholds : [];
  const scopes = [
    { scope: "global", scopeId: "global", limits: budget.global || {}, projectId: null },
  ];
  if (entry.projectId && Object.hasOwn(budget.projects || {}, entry.projectId)) {
    scopes.push({
      scope: "project",
      scopeId: entry.projectId,
      limits: budget.projects[entry.projectId],
      projectId: entry.projectId,
    });
  }

  for (const target of scopes) {
    for (const periodType of ["daily", "monthly"]) {
      const budgetUsd = target.limits?.[periodType === "daily" ? "dailyUsd" : "monthlyUsd"];
      if (!(Number(budgetUsd) > 0)) continue;
      const currentCost = await sumKnownCostSince({
        startTime: getUtcPeriodStart(periodType, now),
        endTime: now.toISOString(),
        projectId: target.projectId,
      });
      for (const threshold of thresholds) {
        await checkBudgetAlert({
          scope: target.scope,
          scopeId: target.scopeId,
          periodType,
          threshold,
          budgetUsd,
          currentCost,
          now,
        });
      }
    }
  }
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost == null ? 0 : Number(entry.cost) || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;
  if (entry.cost == null) day.unknownCostRequests = (day.unknownCostRequests || 0) + 1;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKeyId || (entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key");
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKeyId: entry.apiKeyId || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, cost, costStatus, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, apiKeyId: r.apiKeyId, endpoint: r.endpoint, cost: r.cost, costStatus: r.costStatus, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();

    // Use canonical calculateCost from pricingRepo (cache-inclusive prompt_tokens).
    const tokens = entry.tokens || {};
    const canonicalTokens = {
      prompt_tokens: Number(tokens.prompt_tokens ?? tokens.input_tokens) || 0,
      completion_tokens: Number(tokens.completion_tokens ?? tokens.output_tokens) || 0,
      cached_tokens: Number(tokens.cached_tokens ?? tokens.cache_read_input_tokens) || 0,
      reasoning_tokens: Number(tokens.reasoning_tokens) || 0,
      cache_creation_input_tokens: Number(tokens.cache_creation_input_tokens) || 0,
    };
    const { getPricingForModel } = await import("./pricingRepo.js");
    if (entry.attemptId) {
      const existing = db.get(`SELECT id FROM usageHistory WHERE attemptId = ?`, [entry.attemptId]);
      if (existing) return false;
    }
    entry.cost = entry.tokens && entry.tokenSource !== "unknown"
      ? calculateCost(canonicalTokens, await getPricingForModel(entry.provider, entry.model))
      : null;
    entry.tokens = entry.tokens ? canonicalTokens : null;
    entry.costStatus = entry.cost == null
      ? "unknown"
      : entry.tokenSource === "estimated" ? "estimated" : "known";

    const promptTokens = canonicalTokens.prompt_tokens;
    const completionTokens = canonicalTokens.completion_tokens;
    let inserted = false;

    db.transaction(() => {
      if (entry.attemptId) {
        const existing = db.get(`SELECT id FROM usageHistory WHERE attemptId = ?`, [entry.attemptId]);
        if (existing) return;
      } else {
        const existing = db.get(
          `SELECT id, endpoint FROM usageHistory
           WHERE timestamp = ?
             AND COALESCE(provider, '') = COALESCE(?, '')
             AND COALESCE(model, '') = COALESCE(?, '')
             AND COALESCE(connectionId, '') = COALESCE(?, '')
             AND COALESCE(apiKeyId, apiKey, '') = COALESCE(?, '')
             AND promptTokens = ?
             AND completionTokens = ?
           ORDER BY id DESC LIMIT 1`,
          [
            entry.timestamp, entry.provider || null, entry.model || null,
            entry.connectionId || null, entry.apiKeyId || entry.apiKey || null,
            promptTokens, completionTokens,
          ]
        );
        if (existing) {
          if (!existing.endpoint && entry.endpoint) {
            db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
          }
          return;
        }
      }

      const write = db.run(
        `INSERT OR IGNORE INTO usageHistory(
           timestamp, provider, model, connectionId, apiKey, apiKeyId, projectId,
           endpoint, promptTokens, completionTokens, cost, costStatus, status,
           tokens, meta, attemptId
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp,
          entry.provider || null,
          entry.model || null,
          entry.connectionId || null,
          entry.apiKeyId ? null : entry.apiKey || null,
          entry.apiKeyId || null,
          entry.projectId || null,
          entry.endpoint || null,
          promptTokens,
          completionTokens,
          entry.cost,
          entry.costStatus,
          entry.status || "ok",
          stringifyJson(tokens),
          stringifyJson({ tokenSource: entry.tokenSource || "upstream" }),
          entry.attemptId || null,
        ]
      );
      if (!write.changes) return;

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        unknownCostRequests: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
      try {
        await evaluateBudgetAlerts(entry);
      } catch (error) {
        console.error("Failed to evaluate budget alerts:", error);
      }
    }
    return inserted;
  } catch (e) {
    console.error("Failed to save usage stats:", e);
    return false;
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, apiKeyId, projectId, endpoint, cost, costStatus, status, tokens, attemptId FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), apiKeyId: r.apiKeyId,
    projectId: r.projectId, endpoint: r.endpoint,
    cost: r.cost, costStatus: r.costStatus, status: r.status, tokens: parseJson(r.tokens, {}), attemptId: r.attemptId,
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) {
    const meta = { name: k.name, id: k.id, createdAt: k.createdAt };
    apiKeyMap[k.id] = meta;
    // Legacy usage rows may still contain raw keys until migrated.
    apiKeyMap[k.key] = meta;
  }

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(`SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalRequests += day.requests || 0;
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
      }

      for (const [akModelKey, a] of Object.entries(day.byApiKey || {})) {
        const parts = akModelKey.split("|");
        const apiKeyId = parts[0];
        const rawModel = parts[1] || "";
        const provider = parts[2] || "";
        const apiKeyMeta = apiKeyMap[apiKeyId];
        const displayName = apiKeyMeta?.name ? `${apiKeyMeta.name} (${apiKeyId.slice(0, 8)}...)` : apiKeyId;
        const statsKey = `${rawModel} (${provider} - ${displayName})`;
        if (!stats.byApiKey[statsKey]) {
          stats.byApiKey[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider, apiKeyId, apiKeyName: apiKeyMeta?.name, lastUsed: dateKey };
        }
        stats.byApiKey[statsKey].requests += a.requests || 0;
        stats.byApiKey[statsKey].promptTokens += a.promptTokens || 0;
        stats.byApiKey[statsKey].completionTokens += a.completionTokens || 0;
        stats.byApiKey[statsKey].cachedTokens += a.cachedTokens || 0;
        stats.byApiKey[statsKey].cost += a.cost || 0;
        if (dateKey > (stats.byApiKey[statsKey].lastUsed || "")) stats.byApiKey[statsKey].lastUsed = dateKey;
      }

      for (const [epKey, e] of Object.entries(day.byEndpoint || {})) {
        const parts = epKey.split("|");
        const endpoint = parts[0] || "Unknown";
        const rawModel = parts[1] || "";
        const provider = parts[2] || "";
        const statsKey = `${rawModel} (${provider} - ${endpoint})`;
        if (!stats.byEndpoint[statsKey]) {
          stats.byEndpoint[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider, endpoint, lastUsed: dateKey };
        }
        stats.byEndpoint[statsKey].requests += e.requests || 0;
        stats.byEndpoint[statsKey].promptTokens += e.promptTokens || 0;
        stats.byEndpoint[statsKey].completionTokens += e.completionTokens || 0;
        stats.byEndpoint[statsKey].cachedTokens += e.cachedTokens || 0;
        stats.byEndpoint[statsKey].cost += e.cost || 0;
        if (dateKey > (stats.byEndpoint[statsKey].lastUsed || "")) stats.byEndpoint[statsKey].lastUsed = dateKey;
      }
    }
  } else {
    // 24h/today: read from usageHistory directly
    const today = new Date();
    const todayKey = getLocalDateKey(today);
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, cost, status, tokens FROM usageHistory
       WHERE timestamp >= ? ORDER BY id ASC`,
      [todayKey]
    );
    for (const r of rows) {
      stats.totalRequests++;
      const t = parseJson(r.tokens, {}) || {};
      const pt = t.prompt_tokens || t.input_tokens || 0;
      const ct = t.completion_tokens || t.output_tokens || 0;
      const cached = t.cached_tokens || t.cache_read_input_tokens || 0;
      const cost = r.cost || 0;
      stats.totalPromptTokens += pt;
      stats.totalCompletionTokens += ct;
      stats.totalCachedTokens += cached;
      stats.totalCost += cost;

      if (r.provider) addToCounter(stats.byProvider, r.provider, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost });
      const modelKey = r.provider ? `${r.model}|${r.provider}` : r.model;
      addToCounter(stats.byModel, modelKey, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost, meta: { rawModel: r.model, provider: r.provider } });
      if (r.connectionId) addToCounter(stats.byAccount, r.connectionId, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost, meta: { rawModel: r.model, provider: r.provider } });
      const apiKeyVal = r.apiKeyId || (typeof r.apiKey === "string" ? r.apiKey : null) || "local-no-key";
      const akModelKey = `${apiKeyVal}|${r.model}|${r.provider || "unknown"}`;
      addToCounter(stats.byApiKey, akModelKey, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost, meta: { rawModel: r.model, provider: r.provider, apiKeyId: r.apiKeyId || null } });
      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      addToCounter(stats.byEndpoint, epKey, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost, meta: { endpoint, rawModel: r.model, provider: r.provider } });
    }
  }

  // Convert cost to numbers (stored as string in some cases)
  stats.totalCost = Number(stats.totalCost.toFixed(6));
  for (const obj of [stats.byProvider, stats.byModel, stats.byAccount, stats.byApiKey, stats.byEndpoint]) {
    for (const v of Object.values(obj)) v.cost = Number(v.cost.toFixed(6));
  }

  return stats;
}

export async function getApiKeyUsage(apiKey, period = "30d") {
  const db = await getAdapter();
  const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
  const ms = PERIOD_MS[period] || PERIOD_MS["30d"];
  const cutoff = new Date(Date.now() - ms).toISOString();

  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, endpoint, cost, costStatus, status, tokens
     FROM usageHistory
     WHERE (apiKeyId = ? OR apiKey = ?) AND timestamp >= ?
     ORDER BY timestamp ASC`,
    [apiKey, apiKey, cutoff]
  );

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, endpoint: r.endpoint,
    cost: r.cost, costStatus: r.costStatus, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

export async function getProjectUsage(projectId, period = "30d") {
  const db = await getAdapter();
  const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
  const ms = PERIOD_MS[period] || PERIOD_MS["30d"];
  const cutoff = new Date(Date.now() - ms).toISOString();

  // New rows carry projectId directly. The API-key join keeps pre-attribution rows
  // visible without ever exposing or returning the raw key value.
  const rows = db.all(
    `SELECT uh.timestamp, uh.provider, uh.model, uh.connectionId, uh.endpoint,
            uh.cost, uh.costStatus, uh.status, uh.tokens
     FROM usageHistory uh
     LEFT JOIN apiKeys ak
       ON (uh.apiKeyId IS NOT NULL AND ak.id = uh.apiKeyId)
       OR (uh.apiKeyId IS NULL AND uh.apiKey IS NOT NULL AND ak.key = uh.apiKey)
     WHERE COALESCE(uh.projectId, ak.projectId) = ? AND uh.timestamp >= ?
     ORDER BY uh.timestamp ASC`,
    [projectId, cutoff]
  );

  let totalPrompt = 0, totalCompletion = 0, totalCached = 0, totalCost = 0;
  const byProvider = {}, byModel = {};

  for (const r of rows) {
    const t = parseJson(r.tokens, {}) || {};
    const pt = t.prompt_tokens || t.input_tokens || 0;
    const ct = t.completion_tokens || t.output_tokens || 0;
    const cached = t.cached_tokens || t.cache_read_input_tokens || 0;
    const cost = r.cost || 0;
    totalPrompt += pt;
    totalCompletion += ct;
    totalCached += cached;
    totalCost += cost;

    if (r.provider) addToCounter(byProvider, r.provider, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost });
    const modelKey = r.provider ? `${r.model}|${r.provider}` : r.model;
    addToCounter(byModel, modelKey, { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost, meta: { rawModel: r.model, provider: r.provider } });
  }

  return {
    requests: rows.length,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    cachedTokens: totalCached,
    cost: Number(totalCost.toFixed(6)),
    byProvider, byModel,
  };
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
        buckets[idx].requests += 1;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
      buckets[idx].requests += 1;
    }
    return buckets;
  }

  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  if (period === "all") {
    const dayRows = loadDaysInRange(db, null);
    if (!dayRows.length) return [];
    const dayMap = {};
    for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

    const earliest = new Date(dayRows[0].dateKey + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.max(1, Math.round((today - earliest) / 86400000) + 1);

    return Array.from({ length: diffDays }, (_, i) => {
      const d = new Date(earliest);
      d.setDate(d.getDate() + i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = dayMap[dateKey];
      return {
        label: labelFn(d),
        tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
        cost: dayData ? (dayData.cost || 0) : 0,
        requests: dayData ? (dayData.requests || 0) : 0,
      };
    });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      requests: dayData ? (dayData.requests || 0) : 0,
    };
  });
}