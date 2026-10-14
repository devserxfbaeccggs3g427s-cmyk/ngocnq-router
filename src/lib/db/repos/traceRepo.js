/**
 * Trace Repository — Phase A persistence for smart routing observability
 * Traces: one per request (parent). Attempts: one per upstream call (child).
 * Budget alerts: UTC daily/monthly per scope, unique on (scope,scopeId,periodType,periodKey,threshold).
 */

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getPricingForModel, calculateCost } from "./pricingRepo.js";
import { saveRequestUsage } from "./usageRepo.js";
import { getProviderConnections } from "./connectionsRepo.js";

const VALID_AGENT_LABEL = /^[A-Za-z0-9._:-]{1,64}$/;
const VALID_REASONS = new Set([
  "timeout",
  "rate_limit",
  "auth_failed",
  "context_length",
  "model_not_found",
  "provider_error",
  "upstream_error",
  "invalid_request",
  "content_filter",
  "cancelled",
  "unknown",
]);
const VALID_ATTEMPT_STATUSES = new Set(["success", "error", "cancelled"]);
const VALID_BUDGET_SCOPES = new Set(["global", "project", "apiKey"]);
const VALID_BUDGET_PERIODS = new Set(["daily", "monthly"]);

async function ensureAttemptUsage(db, attempt) {
  if (db.get(`SELECT id FROM usageHistory WHERE attemptId = ?`, [attempt.attemptId])) return;
  const parent = db.get(`SELECT apiKeyId, projectId, endpoint FROM traces WHERE requestId = ?`, [attempt.requestId]);
  const recorded = await saveRequestUsage({
    attemptId: attempt.attemptId,
    // Billing is attributed to when the upstream call ENDED, not when it was
    // dispatched: a 20:59 request that finishes at 21:01 belongs to the later
    // period, and budget periods are UTC keys derived from this timestamp.
    timestamp: attempt.endTime || attempt.startTime,
    provider: attempt.provider,
    model: attempt.model,
    connectionId: attempt.connectionId || null,
    apiKeyId: parent?.apiKeyId || null,
    projectId: parent?.projectId || null,
    endpoint: parent?.endpoint || null,
    status: attempt.status === "success" ? "ok" : attempt.status,
    tokens: null, // tokensJson removed in v5 for privacy; tokens live in usageHistory
    tokenSource: attempt.tokenSource || "unknown",
  });
  if (!recorded && !db.get(`SELECT id FROM usageHistory WHERE attemptId = ?`, [attempt.attemptId])) {
    throw new Error("Could not persist attempt usage");
  }
}

/**
 * Repair a terminal attempt whose usage write failed after its status transition.
 * The unique attempt ID prevents duplicate billing on concurrent repairs.
 */
export async function repairAttemptUsage(attemptId) {
  const db = await getAdapter();
  const attempt = db.get(`SELECT * FROM traceAttempts WHERE attemptId = ?`, [attemptId]);
  if (!attempt || attempt.status === "running") return false;
  await ensureAttemptUsage(db, attempt);
  return true;
}

/**
 * Repair terminal usage records interrupted between attempt finalization and
 * aggregation (e.g. a transient disk error or process restart).
 */
export async function repairTerminalAttemptUsage() {
  const db = await getAdapter();
  const missing = db.all(`SELECT a.* FROM traceAttempts a
    LEFT JOIN usageHistory u ON u.attemptId = a.attemptId
    WHERE a.status != 'running' AND u.id IS NULL`);
  for (const attempt of missing) await ensureAttemptUsage(db, attempt);
  return missing.length;
}

/**
 * Mark abandoned in-flight attempts as cancelled on startup. No pricing is
 * invented for missing tokens; their usage remains explicitly unknown.
 */
export async function closeAbandonedAttempts() {
  const db = await getAdapter();
  const rows = db.all(`SELECT attemptId, requestId FROM traceAttempts WHERE status = 'running'`);
  for (const row of rows) {
    await finishAttempt({ attemptId: row.attemptId, status: "cancelled", tokenSource: "unknown" });
    await finishTrace({ requestId: row.requestId, status: "cancelled", httpStatus: 499, reason: "cancelled" });
  }
  await repairTerminalAttemptUsage();
  return rows.length;
}


function validateAgentLabel(label) {
  if (!label) return true;
  return VALID_AGENT_LABEL.test(label);
}

function sanitizeReason(reason) {
  if (!reason) return null;
  const r = String(reason).toLowerCase().trim();
  return VALID_REASONS.has(r) ? r : "unknown";
}

function getUtcDateKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getUtcMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Begin a trace (parent request).
 * @param {object} opts
 * @param {string} opts.requestId - UUID
 * @param {string} [opts.taskId] - x-9router-task-id header
 * @param {string} [opts.agentLabel] - x-9router-agent-label header (validated ASCII)
 * @param {string} [opts.apiKeyId] - stable API key ID (not raw key)
 * @param {string} [opts.projectId] - project ID from apiKeys.projectId
 * @param {string} opts.requestedModel - model requested by client
 * @param {string} opts.endpoint - API endpoint path
 * @param {string} [opts.provider] - resolved provider (after combo expansion)
 * @param {string} [opts.comboName] - combo name if applicable
 * @param {string} [opts.accountId] - connectionId of selected account
 * @returns {object} trace object
 */
export async function beginTrace({
  requestId,
  taskId = null,
  agentLabel = null,
  apiKeyId = null,
  projectId = null,
  requestedModel,
  endpoint,
  provider = null,
  comboName = null,
  accountId = null,
}) {
  if (!requestId || !requestedModel || !endpoint) {
    throw new Error("requestId, requestedModel, and endpoint are required");
  }
  if (!validateAgentLabel(agentLabel)) {
    throw new Error("Invalid agentLabel: must match ^[A-Za-z0-9._:-]{1,64}$");
  }

  const db = await getAdapter();
  const startTime = new Date().toISOString();

  db.run(
    `INSERT INTO traces(requestId, taskId, agentLabel, apiKeyId, projectId, requestedModel, endpoint, provider, comboName, accountId, startTime, status, costStatus)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unknown')
     ON CONFLICT(requestId) DO NOTHING`,
    [requestId, taskId, agentLabel, apiKeyId, projectId, requestedModel, endpoint, provider, comboName, accountId, startTime]
  );

  return {
    requestId,
    taskId,
    agentLabel,
    apiKeyId,
    projectId,
    requestedModel,
    endpoint,
    provider,
    comboName,
    accountId,
    startTime,
    endTime: null,
    status: "pending",
    httpStatus: null,
    reason: null,
    cost: 0,
    metrics: null,
    attempts: [],
  };
}

/**
 * Begin an attempt (child upstream call).
 * @param {object} opts
 * @param {string} opts.attemptId - UUID
 * @param {string} opts.requestId - parent trace requestId
 * @param {string} opts.provider - upstream provider
 * @param {string} opts.model - model sent to upstream
 * @param {string} [opts.connectionId] - provider connection ID
 * @returns {object} attempt object
 */
export async function beginAttempt({ attemptId, requestId, provider, model, connectionId = null }) {
  if (!attemptId || !requestId || !provider || !model) {
    throw new Error("attemptId, requestId, provider, and model are required");
  }
  const db = await getAdapter();
  const startTime = new Date().toISOString();

  db.run(
    `INSERT INTO traceAttempts(attemptId, requestId, provider, model, connectionId, startTime, status, costStatus)
     VALUES(?, ?, ?, ?, ?, ?, 'running', 'unknown')
     ON CONFLICT(attemptId) DO NOTHING`,
    [attemptId, requestId, provider, model, connectionId, startTime]
  );

  return {
    attemptId,
    requestId,
    provider,
    model,
    connectionId,
    startTime,
    endTime: null,
    status: "running",
    httpStatus: null,
    ttftMs: null,
    durationMs: null,
    tokens: null,
    tokenSource: null,
    cost: 0,
  };
}

/**
 * Finish an attempt and write usageHistory once with attemptId for billing dedup.
 * @param {object} opts
 * @param {string} opts.attemptId
 * @param {string} opts.status - 'success' | 'error' | 'cancelled'
 * @param {number} [opts.httpStatus]
 * @param {number} [opts.ttftMs] - time to first token
 * @param {number} [opts.durationMs] - total duration
 * @param {object} [opts.tokens] - { prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cache_creation_input_tokens }
 * @param {string} [opts.tokenSource] - 'upstream' | 'estimated' | 'unknown'
 * @returns {object} updated attempt
 */
export async function finishAttempt({ attemptId, status, httpStatus = null, ttftMs = null, durationMs = null, tokens = null, tokenSource = "unknown" }) {
  if (!attemptId || !VALID_ATTEMPT_STATUSES.has(status)) {
    throw new Error("attemptId and a valid terminal status are required");
  }

  const db = await getAdapter();
  const endTime = new Date().toISOString();
  const attemptRow = db.get(
    `SELECT ta.*, t.apiKeyId, t.projectId, t.endpoint
     FROM traceAttempts ta
     LEFT JOIN traces t ON t.requestId = ta.requestId
     WHERE ta.attemptId = ?`,
    [attemptId]
  );
  if (!attemptRow) return null;

  // A retry after a failed usage write must repair the aggregate without
  // replacing the original terminal attempt status or charging twice.
  if (attemptRow.status !== "running") {
    const recorded = db.get(`SELECT id FROM usageHistory WHERE attemptId = ?`, [attemptId]);
    // tokensJson removed in v5 for privacy; tokens live in usageHistory
    if (!recorded) {
      await saveRequestUsage({
        attemptId,
        timestamp: attemptRow.endTime || attemptRow.startTime,
        provider: attemptRow.provider,
        model: attemptRow.model,
        connectionId: attemptRow.connectionId || null,
        apiKeyId: attemptRow.apiKeyId || null,
        projectId: attemptRow.projectId || null,
        endpoint: attemptRow.endpoint || null,
        status: attemptRow.status === "success" ? "ok" : attemptRow.status,
        tokens: null,
        tokenSource: attemptRow.tokenSource || "unknown",
      });
    }
    return { ...attemptRow, tokens: null };
  }

  let cost = null;
  let costStatus = "unknown";
  if (tokens && tokenSource !== "unknown") {
    const pricing = await getPricingForModel(attemptRow.provider, attemptRow.model);
    cost = calculateCost(tokens, pricing);
    if (cost !== null) costStatus = tokenSource === "estimated" ? "estimated" : "known";
  }

  const changed = db.run(
    `UPDATE traceAttempts
       SET endTime = ?, status = ?, httpStatus = ?, ttftMs = ?, durationMs = ?,
           tokenSource = ?, cost = ?, costStatus = ?
     WHERE attemptId = ? AND status = 'running'`,
    [endTime, status, httpStatus, ttftMs, durationMs,
      tokenSource, cost, costStatus, attemptId]
  );
  if (!changed.changes) return db.get(`SELECT * FROM traceAttempts WHERE attemptId = ?`, [attemptId]);

  // The normal usage writer owns the history row, daily/lifetime counters, recent
  // ring, stats events and warning-only budgets. attemptId makes retries of this
  // write idempotent even if a stream invokes multiple terminal callbacks.
  await saveRequestUsage({
    attemptId,
    // Terminal time, so the usage row and its UTC budget period agree with when
    // the request actually consumed the upstream budget.
    timestamp: endTime,
    provider: attemptRow.provider,
    model: attemptRow.model,
    connectionId: attemptRow.connectionId || null,
    apiKeyId: attemptRow.apiKeyId || null,
    projectId: attemptRow.projectId || null,
    endpoint: attemptRow.endpoint || null,
    status: status === "success" ? "ok" : status,
    tokens,
    tokenSource,
  });

  return {
    attemptId,
    requestId: attemptRow.requestId,
    provider: attemptRow.provider,
    model: attemptRow.model,
    connectionId: attemptRow.connectionId || null,
    startTime: attemptRow.startTime,
    endTime,
    status,
    httpStatus,
    ttftMs,
    durationMs,
    tokens,
    tokenSource,
    cost,
    costStatus,
  };
}

/**
 * Finish a trace (parent request). Called once parent response selected.
 * Stream defers until body consumed/abort — no premature success.
 * @param {object} opts
 * @param {string} opts.requestId
 * @param {string} opts.status - 'success' | 'error' | 'cancelled'
 * @param {number} [opts.httpStatus]
 * @param {string} [opts.reason] - short allowlisted reason (sanitized)
 * @param {object} [opts.metrics] - { cost, p95, failureRate }
 * @returns {object} final trace
 */
export async function finishTrace({ requestId, status, httpStatus = null, reason = null, metrics = null }) {
  if (!requestId || !VALID_ATTEMPT_STATUSES.has(status)) {
    throw new Error("requestId and a valid terminal status are required");
  }

  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM traces WHERE requestId = ?`, [requestId]);
  if (!existing) return null;
  if (existing.status !== "pending") return getTrace(requestId);

  const endTime = new Date().toISOString();
  const sanitizedReason = sanitizeReason(reason);
  const attempts = db.all(
    `SELECT cost, costStatus, durationMs, ttftMs, status FROM traceAttempts WHERE requestId = ? ORDER BY startTime ASC`,
    [requestId]
  );
  const knownCosts = attempts
    .filter((attempt) => attempt.costStatus === "known" || attempt.costStatus === "estimated")
    .map((attempt) => Number(attempt.cost) || 0);
  const hasUnknownCost = attempts.some((attempt) => attempt.costStatus === "unknown");
  const aggregateCost = hasUnknownCost || attempts.length === 0
    ? null
    : knownCosts.reduce((sum, cost) => sum + cost, 0);
  const aggregateCostStatus = hasUnknownCost
    ? "unknown"
    : attempts.some((attempt) => attempt.costStatus === "estimated")
      ? "estimated"
      : attempts.length > 0 ? "known" : "unknown";
  const mergedMetrics = {
    // Preserve whatever routing already explained itself (policy version, whether
    // ranking applied, why not). Overwriting it here would erase the decision
    // record at the exact moment the trace becomes readable.
    ...(parseJson(existing.metricsJson, {}) || {}),
    ...(metrics || {}),
    attempts: attempts.length,
    successfulAttempts: attempts.filter((attempt) => attempt.status === "success").length,
    totalDurationMs: attempts.reduce((sum, attempt) => sum + (Number(attempt.durationMs) || 0), 0),
  };

  db.run(
    `UPDATE traces
     SET endTime = ?, status = ?, httpStatus = ?, reason = ?, cost = ?, costStatus = ?, metricsJson = ?
     WHERE requestId = ? AND status = 'pending'`,
    [endTime, status, httpStatus, sanitizedReason, aggregateCost, aggregateCostStatus, stringifyJson(mergedMetrics), requestId]
  );

  return getTrace(requestId);
}

/**
 * Update a pending trace with the routing it actually resolved to.
 *
 * The parent is created before combo expansion and account selection, so the
 * resolved provider/combo/account are only known later. Only non-null fields are
 * written, and only while the trace is still pending — a finished trace is never
 * rewritten, so terminal aggregates stay stable.
 *
 * `metrics` is merged into the existing JSON blob and must stay small: routing
 * explanation only (policy version, whether ranking applied, why not, the
 * eligible model ids). No payload, no credentials, no token counters.
 */
export async function updateTraceRouting({ requestId, provider = null, comboName = null, accountId = null, metrics = null }) {
  if (!requestId) return null;
  const db = await getAdapter();
  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries({ provider, comboName, accountId })) {
    if (value) { sets.push(`${column} = ?`); params.push(value); }
  }
  if (sets.length === 0 && !metrics) return null;

  if (metrics) {
    const row = db.get(`SELECT metricsJson FROM traces WHERE requestId = ? AND status = 'pending'`, [requestId]);
    if (!row) return null;
    const current = parseJson(row.metricsJson, {}) || {};
    sets.push("metricsJson = ?");
    params.push(stringifyJson({ ...current, ...metrics }));
  }
  if (sets.length === 0) return null;

  params.push(requestId);
  db.run(`UPDATE traces SET ${sets.join(", ")} WHERE requestId = ? AND status = 'pending'`, params);
  return getTrace(requestId);
}

/**
 * List traces with filters and pagination.
 * @param {object} opts
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.taskId]
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.status]
 * @param {string} [opts.from] - ISO timestamp
 * @param {string} [opts.to] - ISO timestamp
 * @returns {object} { items: [...], total: number }
 *
 * Each item also carries `pricedUsd`: the sum of the costs that COULD be priced
 * for the request's dispatches, or null when none of them could. `cost` alone
 * is null as soon as one dispatch is unpriced — which, once any unpriced traffic
 * exists, is every request — so the UI needs the partial figure to stay
 * informative, and null to keep saying "unknown" where it truly is.
 */
export async function listTraces({ limit = 50, offset = 0, taskId = null, agentLabel = null, provider = null, model = null, status = null, projectId = null, apiKeyId = null, from = null, to = null }) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  for (const [column, value] of Object.entries({ taskId, agentLabel, requestedModel: model, status, projectId, apiKeyId })) {
    if (value !== null) { conds.push(`t.${column} = ?`); params.push(value); }
  }
  if (provider) {
    conds.push("EXISTS (SELECT 1 FROM traceAttempts a WHERE a.requestId = t.requestId AND a.provider = ?)");
    params.push(provider);
  }
  if (from) { conds.push("t.startTime >= ?"); params.push(from); }
  if (to) { conds.push("t.startTime <= ?"); params.push(to); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const totalRow = db.get(`SELECT COUNT(*) as c FROM traces t ${where}`, params);
  const total = totalRow?.c || 0;

  params.push(limit, offset);
  const rows = db.all(
    `SELECT t.requestId, t.taskId, t.agentLabel, t.apiKeyId, t.projectId,
      t.requestedModel, t.endpoint, t.provider, t.comboName, t.accountId,
      t.startTime, t.endTime, t.status, t.httpStatus, t.reason, t.cost, t.costStatus,
      (SELECT SUM(u.cost) FROM usageHistory u
         JOIN traceAttempts a ON a.attemptId = u.attemptId
        WHERE a.requestId = t.requestId AND u.cost IS NOT NULL) AS pricedUsd
      FROM traces t ${where} ORDER BY t.startTime DESC, t.requestId DESC LIMIT ? OFFSET ?`,
    params
  );
  return { items: rows, total, limit, offset };
}

/**
 * Get trace stats for a period.
 * @param {object} opts
 * @param {string} opts.period - '24h' | '7d' | '30d' | '60d'
 * @returns {object} { requests, successRate, avgLatencyMs, totalCost, byProvider, byModel }
 */
export async function getTraceStats({ period }) {
  const db = await getAdapter();
  const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
  const ms = PERIOD_MS[period] || PERIOD_MS["24h"];
  const cutoff = new Date(Date.now() - ms).toISOString();

  const rows = db.all(
    `SELECT provider, requestedModel, status, httpStatus, cost, metricsJson, startTime, endTime
     FROM traces
     WHERE startTime >= ?`,
    [cutoff]
  );

  const stats = {
    requests: rows.length,
    success: 0,
    totalCost: 0,
    knownCostRequests: 0,
    unknownCostRequests: 0,
    totalLatencyMs: 0,
    latencyCount: 0,
    latencies: [],
    byProvider: {},
    byModel: {},
  };

  for (const r of rows) {
    if (r.status === "success") stats.success++;

    if (r.cost == null) stats.unknownCostRequests++;
    else {
      stats.knownCostRequests++;
      stats.totalCost += Number(r.cost) || 0;
    }

    if (r.startTime && r.endTime) {
      const latency = new Date(r.endTime).getTime() - new Date(r.startTime).getTime();
      if (latency >= 0) {
        stats.totalLatencyMs += latency;
        stats.latencyCount++;
        stats.latencies.push(latency);
      }
    }

    const prov = r.provider || "unknown";
    if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, success: 0, cost: 0 };
    stats.byProvider[prov].requests++;
    if (r.status === "success") stats.byProvider[prov].success++;
    stats.byProvider[prov].cost += r.cost || 0;

    const model = r.requestedModel || "unknown";
    if (!stats.byModel[model]) stats.byModel[model] = { requests: 0, success: 0, cost: 0 };
    stats.byModel[model].requests++;
    if (r.status === "success") stats.byModel[model].success++;
    stats.byModel[model].cost += r.cost || 0;
  }

  const percentile = (values, p) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  };

  return {
    requests: stats.requests,
    successRate: stats.requests > 0 ? stats.success / stats.requests : 0,
    errorRate: stats.requests > 0 ? (stats.requests - stats.success) / stats.requests : 0,
    avgLatencyMs: stats.latencyCount > 0 ? Math.round(stats.totalLatencyMs / stats.latencyCount) : 0,
    p50LatencyMs: percentile(stats.latencies, 50),
    p95LatencyMs: percentile(stats.latencies, 95),
    totalCost: stats.totalCost,
    knownCostRequests: stats.knownCostRequests,
    unknownCostRequests: stats.unknownCostRequests,
    unknownCostRatio: stats.requests > 0 ? stats.unknownCostRequests / stats.requests : 0,
    byProvider: stats.byProvider,
    byModel: stats.byModel,
  };
}

const ANALYTICS_PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

function analyticsBucket() {
  return { requests: 0, successes: 0, errors: 0, pending: 0,
    knownCostRequests: 0, estimatedCostRequests: 0, unknownCostRequests: 0,
    knownCostUsd: 0, cost: null, latencies: [] };
}

function addAnalyticsSample(bucket, row) {
  bucket.requests++;
  if (row.status === "success") bucket.successes++;
  else if (row.status === "pending" || row.status === "running") bucket.pending++;
  else bucket.errors++;
  if (row.costStatus === "known" && row.cost != null) bucket.knownCostRequests++;
  else if (row.costStatus === "estimated" && row.cost != null) bucket.estimatedCostRequests++;
  else bucket.unknownCostRequests++;
  if (row.cost != null && (row.costStatus === "known" || row.costStatus === "estimated")) {
    bucket.knownCostUsd += Number(row.cost);
  }
  const duration = row.durationMs ?? (row.endTime && row.startTime
    ? new Date(row.endTime).getTime() - new Date(row.startTime).getTime() : null);
  if (duration != null && Number.isFinite(Number(duration)) && Number(duration) >= 0) {
    bucket.latencies.push(Number(duration));
  }
}

function finalizeAnalyticsBucket(bucket) {
  const { latencies, ...data } = bucket;
  const sorted = latencies.sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    ...data,
    errorRate: data.requests - data.pending ? data.errors / (data.requests - data.pending) : 0,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    // A partial sum cannot be presented as the complete cost of a task.
    cost: data.unknownCostRequests ? null : data.knownCostUsd,
  };
}

/**
 * Request-level analytics; provider/model dimensions count actual upstream attempts
 * so retries, account fallbacks, fusion panels and judge costs are included.
 * Only stable key/project IDs and validated observational labels are exposed.
 */
export async function getTraceAnalytics({ period = "30d", apiKeyId = null, projectId = null, taskId = null, agentLabel = null } = {}) {
  if (!Object.hasOwn(ANALYTICS_PERIOD_MS, period)) throw new Error("Invalid analytics period");
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - ANALYTICS_PERIOD_MS[period]).toISOString();
  const where = ["t.startTime >= ?"];
  const params = [cutoff];
  for (const [name, value] of Object.entries({ apiKeyId, projectId, taskId, agentLabel })) {
    if (value != null) {
      where.push(`t.${name} = ?`);
      params.push(value);
    }
  }
  const traces = db.all(`SELECT t.requestId, t.startTime, t.endTime, t.status, t.cost, t.costStatus,
    t.apiKeyId, t.projectId, t.taskId, t.agentLabel
    FROM traces t WHERE ${where.join(" AND ")}`, params);
  const attempts = db.all(`SELECT a.provider, a.model, a.startTime, a.endTime, a.durationMs,
    a.status, a.cost, a.costStatus FROM traceAttempts a
    JOIN traces t ON t.requestId = a.requestId WHERE ${where.join(" AND ")}`, params);
  const dimensions = {
    byTime: {}, byProvider: {}, byModel: {}, byApiKey: {}, byProject: {}, byTask: {}, byAgent: {},
  };
  const total = analyticsBucket();
  const add = (dimension, key, row) => {
    dimensions[dimension][key] ||= analyticsBucket();
    addAnalyticsSample(dimensions[dimension][key], row);
  };
  for (const row of traces) {
    addAnalyticsSample(total, row);
    const timeKey = period === "24h" ? row.startTime.slice(0, 13) : row.startTime.slice(0, 10);
    add("byTime", timeKey, row);
    add("byApiKey", row.apiKeyId || "unattributed", row);
    add("byProject", row.projectId || "unattributed", row);
    add("byTask", row.taskId || "unattributed", row);
    add("byAgent", row.agentLabel || "unattributed", row);
  }
  for (const row of attempts) {
    add("byProvider", row.provider, row);
    add("byModel", `${row.provider}/${row.model}`, row);
  }
  for (const values of Object.values(dimensions)) {
    for (const [key, bucket] of Object.entries(values)) values[key] = finalizeAnalyticsBucket(bucket);
  }
  return { period, total: finalizeAnalyticsBucket(total), attempts: attempts.length, ...dimensions };
}

/**
 * Analytics dimensions. `provider`/`model` live on the attempt (a single request
 * can hit several providers through combo and account fallback); `apiKeyId`,
 * `projectId`, `taskId` and `agentLabel` are request-level attribution.
 */
export const ANALYTICS_GROUP_BYS = Object.freeze({
  provider: { source: "attempt", column: "provider" },
  model: { source: "attempt", column: "model", composed: true },
  apiKey: { source: "trace", column: "apiKeyId" },
  project: { source: "trace", column: "projectId" },
  task: { source: "trace", column: "taskId" },
  agent: { source: "trace", column: "agentLabel" },
});

export const ANALYTICS_BUCKETS = Object.freeze(["hour", "day"]);
export const ANALYTICS_MAX_GROUPS = 8;

const UNATTRIBUTED = "unattributed";
const LEGACY_GROUP_KEY = "legacy/unattributed";

/** `2026-10-14T07:23:11Z` → `2026-10-14T07` (hour) or `2026-10-14` (day), always UTC. */
function bucketKey(iso, bucket) {
  return bucket === "hour" ? String(iso).slice(0, 13) : String(iso).slice(0, 10);
}

/** Inclusive-lower/exclusive-upper instant bounds for a bucket key. */
function bucketBounds(key, bucket) {
  // An hour key is already `YYYY-MM-DDTHH`; a day key is `YYYY-MM-DD`. Only the
  // day key needs the `T` separator, and both need the full time+zone suffix to
  // parse as a real instant.
  const start = new Date(key.includes("T") ? `${key}:00:00.000Z` : `${key}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return { from: null, to: null };
  const end = new Date(start);
  if (bucket === "hour") end.setUTCHours(end.getUTCHours() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function newAnalyticsTally() {
  return {
    requests: 0, success: 0, error: 0, pending: 0,
    attempts: 0, attemptSuccess: 0, attemptError: 0, attemptPending: 0,
    pricedAttempts: 0, estimatedAttempts: 0, unknownAttempts: 0,
    pricedUsd: 0,
    promptTokens: 0, completionTokens: 0,
    legacyLedgerRows: 0,
    latencies: [],
  };
}

/** Fold one billable attempt (traced or legacy ledger row) into a tally. */
function tallyAttempt(tally, row) {
  tally.attempts++;
  if (row.status === "success") tally.attemptSuccess++;
  else if (row.status === "pending" || row.status === "running") tally.attemptPending++;
  else tally.attemptError++;

  const status = row.costStatus;
  if (status === "known" && row.cost != null) {
    tally.pricedAttempts++;
    tally.pricedUsd += Number(row.cost) || 0;
  } else if (status === "estimated" && row.cost != null) {
    tally.estimatedAttempts++;
    tally.pricedUsd += Number(row.cost) || 0;
  } else {
    // Missing price is unknown, never free.
    tally.unknownAttempts++;
  }

  tally.promptTokens += Number(row.promptTokens) || 0;
  tally.completionTokens += Number(row.completionTokens) || 0;

  const duration = Number(row.durationMs);
  if (Number.isFinite(duration) && duration >= 0) tally.latencies.push(duration);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Public shape of one tally.
 *
 * `pricedUsd` is the honest subtotal over attempts we could actually price;
 * `totalCostUsd` is null whenever anything is unknown, so a partial sum can
 * never be presented as the complete cost.
 */
function finalizeTally(tally) {
  const sorted = tally.latencies.slice().sort((a, b) => a - b);
  return {
    requests: tally.requests,
    success: tally.success,
    error: tally.error,
    pending: tally.pending,
    attempts: tally.attempts,
    attemptSuccess: tally.attemptSuccess,
    attemptError: tally.attemptError,
    attemptPending: tally.attemptPending,
    pricedAttempts: tally.pricedAttempts,
    estimatedAttempts: tally.estimatedAttempts,
    // tallyAttempt classifies every attempt into exactly one of these three,
    // so they already sum to `attempts` — no extra "unpriced" term here.
    unknownAttempts: tally.unknownAttempts,
    pricedUsd: roundUsd(tally.pricedUsd),
    totalCostUsd: tally.unknownAttempts === 0 ? roundUsd(tally.pricedUsd) : null,
    promptTokens: tally.promptTokens,
    completionTokens: tally.completionTokens,
    totalTokens: tally.promptTokens + tally.completionTokens,
    legacyLedgerRows: tally.legacyLedgerRows,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

// Keep USD sums free of float dust so a repeated read is byte-stable.
function roundUsd(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

/**
 * Phase A analytics over an explicit UTC range.
 *
 * Two populations are combined:
 *  - traced requests, whose per-dispatch attempts are joined to `usageHistory`;
 *  - legacy ledger rows written before Phase A tracing existed, which carry
 *    their own (usually NULL) attribution and are surfaced under
 *    `legacy/unattributed` instead of silently vanishing from the global total.
 *
 * Legacy rows are matched against the same filters using their own columns, so a
 * NULL `projectId` simply never satisfies a project filter — nothing is faked.
 *
 * @param {object} opts
 * @param {string} opts.from - ISO UTC, inclusive
 * @param {string} opts.to - ISO UTC, inclusive
 * @param {"hour"|"day"} [opts.bucket]
 * @param {string} [opts.groupBy] - one key of ANALYTICS_GROUP_BYS, or null
 */
export async function getUsageAnalytics({
  from, to, bucket = "day", groupBy = null,
  apiKeyId = null, projectId = null, taskId = null, agentLabel = null,
  provider = null, model = null,
} = {}) {
  if (!ANALYTICS_BUCKETS.includes(bucket)) throw new TypeError("Invalid analytics bucket");
  if (groupBy != null && !Object.hasOwn(ANALYTICS_GROUP_BYS, groupBy)) throw new TypeError("Invalid analytics groupBy");
  if (!from || !to || Date.parse(from) > Date.parse(to)) throw new TypeError("Invalid analytics range");

  const db = await getAdapter();
  // Trace-level filters. Provider/model resolve against a CHILD attempt, because
  // a combo request's parent `provider` is only the last one tried.
  const traceFilters = { apiKeyId, projectId, taskId, agentLabel };
  const traceWhere = ["t.startTime >= ?", "t.startTime <= ?"];
  const traceParams = [from, to];
  for (const [column, value] of Object.entries(traceFilters)) {
    if (value != null) { traceWhere.push(`t.${column} = ?`); traceParams.push(value); }
  }
  if (provider) {
    traceWhere.push("EXISTS (SELECT 1 FROM traceAttempts a WHERE a.requestId = t.requestId AND a.provider = ?)");
    traceParams.push(provider);
  }
  if (model) {
    traceWhere.push("t.requestedModel = ?");
    traceParams.push(model);
  }

  const traces = db.all(
    `SELECT t.requestId, t.startTime, t.status FROM traces t WHERE ${traceWhere.join(" AND ")}`,
    traceParams
  );

  const attempts = db.all(
    `SELECT a.requestId, a.provider, a.model, a.connectionId,
            COALESCE(a.endTime, a.startTime) AS at,
            a.durationMs, a.status AS attemptStatus,
            COALESCE(u.cost, a.cost) AS cost,
            COALESCE(u.costStatus, a.costStatus) AS costStatus,
            u.promptTokens, u.completionTokens,
            t.apiKeyId, t.projectId, t.taskId, t.agentLabel
     FROM traceAttempts a
     JOIN traces t ON t.requestId = a.requestId
     LEFT JOIN usageHistory u ON u.attemptId = a.attemptId
     WHERE ${traceWhere.join(" AND ")}`,
    traceParams
  );

  // Legacy ledger: rows with no Phase A attempt behind them. `NOT EXISTS` also
  // covers rows whose attempt was pruned by trace retention — their usage stays.
  const legacyWhere = ["u.timestamp >= ?", "u.timestamp <= ?",
    "NOT EXISTS (SELECT 1 FROM traceAttempts a WHERE a.attemptId = u.attemptId)"];
  const legacyParams = [from, to];
  for (const [column, value] of Object.entries(traceFilters)) {
    if (value != null) { legacyWhere.push(`u.${column} = ?`); legacyParams.push(value); }
  }
  if (provider) { legacyWhere.push("u.provider = ?"); legacyParams.push(provider); }
  if (model) { legacyWhere.push("u.model = ?"); legacyParams.push(model); }
  const legacy = db.all(
    `SELECT u.timestamp, u.provider, u.model, u.cost, u.costStatus, u.status,
            u.promptTokens, u.completionTokens,
            u.apiKeyId, u.projectId, NULL AS taskId, NULL AS agentLabel
     FROM usageHistory u WHERE ${legacyWhere.join(" AND ")}`,
    legacyParams
  );

  const total = newAnalyticsTally();
  const series = new Map();
  const groups = new Map();
  const groupSpec = groupBy ? ANALYTICS_GROUP_BYS[groupBy] : null;

  const seriesTally = (key) => {
    if (!series.has(key)) series.set(key, newAnalyticsTally());
    return series.get(key);
  };
  const groupTally = (key) => {
    if (!groups.has(key)) groups.set(key, newAnalyticsTally());
    return groups.get(key);
  };

  // A request's cost belongs to the period its attempts actually billed in, so
  // both signals are bucketed on the attempt's terminal instant.
  const requestTime = new Map(traces.map((t) => [t.requestId, t.startTime]));

  for (const row of traces) {
    total.requests++;
    const tally = seriesTally(bucketKey(row.startTime, bucket));
    tally.requests++;
    if (row.status === "success") { total.success++; tally.success++; }
    else if (row.status === "pending") { total.pending++; tally.pending++; }
    else { total.error++; tally.error++; }
  }

  const attemptRows = attempts.map((a) => ({
    ...a, status: a.attemptStatus, at: a.at || requestTime.get(a.requestId) || from,
  }));

  for (const row of attemptRows) {
    tallyAttempt(total, row);
    tallyAttempt(seriesTally(bucketKey(row.at, bucket)), row);
    if (groupSpec) {
      let key;
      if (groupSpec.source === "attempt") {
        key = groupSpec.composed ? `${row.provider}/${row.model}` : row[groupSpec.column];
      } else {
        key = row[groupSpec.column];
      }
      tallyAttempt(groupTally(key || UNATTRIBUTED), row);
    }
  }

  for (const row of legacy) {
    const { timestamp, ...rest } = row;
    const shaped = { ...rest, status: rest.status, durationMs: null };
    tallyAttempt(total, shaped);
    total.legacyLedgerRows++;
    const tally = seriesTally(bucketKey(timestamp, bucket));
    tallyAttempt(tally, shaped);
    tally.legacyLedgerRows++;
    if (groupSpec) {
      let key;
      if (groupSpec.source === "attempt") {
        key = groupSpec.composed ? `${rest.provider}/${rest.model}` : rest[groupSpec.column];
      } else {
        // A legacy row has no trace to attribute a task/agent to.
        key = groupSpec.source === "trace" ? LEGACY_GROUP_KEY : rest[groupSpec.column];
      }
      const bucketTally = groupTally(key || UNATTRIBUTED);
      tallyAttempt(bucketTally, shaped);
      bucketTally.legacyLedgerRows++;
    }
  }

  const seriesList = [...series.entries()]
    .map(([key, tally]) => ({ key, ...bucketBounds(key, bucket), ...finalizeTally(tally) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const groupList = [...groups.entries()]
    .map(([key, tally]) => ({ key, ...finalizeTally(tally) }))
    // Deterministic order: cost desc, then key asc, so a tie never reshuffles.
    .sort((a, b) => (b.pricedUsd - a.pricedUsd) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const head = groupList.slice(0, ANALYTICS_MAX_GROUPS);
  const tail = groupList.slice(ANALYTICS_MAX_GROUPS);
  const groupsOut = tail.length ? [
    ...head,
    {
      key: "other",
      rolledUp: true,
      ...finalizeTally(tail.reduce((acc, g) => {
        for (const field of ["requests", "success", "error", "pending", "attempts", "attemptSuccess",
          "attemptError", "attemptPending", "pricedAttempts", "estimatedAttempts", "unknownAttempts",
          "promptTokens", "completionTokens", "legacyLedgerRows"]) acc[field] += g[field];
        acc.pricedUsd += g.pricedUsd;
        return acc;
      }, newAnalyticsTally())),
    },
  ] : head;

  const finalizedTotal = finalizeTally(total);
  return {
    range: { from, to, timezone: "UTC", bucket },
    groupBy,
    totals: finalizedTotal,
    coverage: {
      requests: finalizedTotal.requests,
      attempts: finalizedTotal.attempts,
      priced: finalizedTotal.pricedAttempts,
      estimated: finalizedTotal.estimatedAttempts,
      unknown: finalizedTotal.unknownAttempts,
      unknownRatio: finalizedTotal.attempts > 0 ? finalizedTotal.unknownAttempts / finalizedTotal.attempts : 0,
      legacyLedgerRows: finalizedTotal.legacyLedgerRows,
    },
    series: seriesList,
    groups: groupsOut,
    groupsTruncated: tail.length,
  };
}

/**
 * Check and record budget alerts. Called from usage aggregation.
 * @param {object} opts
 * @param {string} opts.scope - 'global' | 'project' | 'apiKey'
 * @param {string} opts.scopeId - projectId or apiKeyId or 'global'
 * @param {string} opts.periodType - 'daily' | 'monthly'
 * @param {number} opts.threshold - cost threshold in USD
 * @param {number} opts.currentCost - current period cost
 * @returns {object|null} alert if triggered
 */
export async function checkBudgetAlert({ scope, scopeId, periodType, threshold, budgetUsd, currentCost, now = new Date() }) {
  if (!VALID_BUDGET_SCOPES.has(scope) || !VALID_BUDGET_PERIODS.has(periodType)) {
    throw new Error("Invalid budget alert scope or periodType");
  }
  const normalizedScopeId = scope === "global" ? "global" : String(scopeId || "").trim();
  const ratio = Number(threshold);
  const budget = Number(budgetUsd);
  const cost = Number(currentCost);
  if (!normalizedScopeId || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1 ||
      !Number.isFinite(budget) || budget <= 0 || !Number.isFinite(cost) || cost < 0) {
    throw new Error("Invalid budget alert values");
  }
  if (cost < budget * ratio) return null;

  const db = await getAdapter();
  const periodKey = periodType === "daily" ? getUtcDateKey(now) : getUtcMonthKey(now);
  const id = `${scope}|${normalizedScopeId}|${periodType}|${periodKey}|${ratio}`;
  const triggeredAt = now.toISOString();

  db.run(
    `INSERT INTO budgetAlerts(
       id, scope, scopeId, periodType, periodKey, threshold, budgetUsd, currentCost, triggeredAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scopeId, periodType, periodKey, threshold) DO NOTHING`,
    [id, scope, normalizedScopeId, periodType, periodKey, ratio, budget, cost, triggeredAt]
  );
  const row = db.get(`SELECT * FROM budgetAlerts WHERE id = ?`, [id]);
  return row ? { ...row } : null;
}

/**
 * List budget alerts.
 * @param {object} opts
 * @param {string} [opts.scope]
 * @param {string} [opts.period] - '24h' | '7d' | '30d' | '60d'
 * @param {number} [opts.threshold]
 * @returns {object[]} alerts
 */
export async function listBudgetAlerts({ scope = null, scopeId = null, period = null, threshold = null, limit = 50, offset = 0 }) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (scope) { conds.push("scope = ?"); params.push(scope); }
  if (scopeId) { conds.push("scopeId = ?"); params.push(scopeId); }
  if (threshold != null) { conds.push("threshold = ?"); params.push(threshold); }

  // Period filter on triggeredAt
  if (period) {
    const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
    const ms = PERIOD_MS[period] || PERIOD_MS["24h"];
    const cutoff = new Date(Date.now() - ms).toISOString();
    conds.push("triggeredAt >= ?");
    params.push(cutoff);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT scope, scopeId, periodType, periodKey, threshold, budgetUsd,
    currentCost, triggeredAt, notifiedAt FROM budgetAlerts ${where}
    ORDER BY triggeredAt DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows;
}

const ROUTING_WINDOW_MS = 2592000000;        // 30 days of terminal attempts
const HEALTH_MAX_AGE_MS = 1800000;           // 30 minutes — health is a *cached* signal

const HEALTH_BY_STATE = { healthy: 1, degraded: 0.5, error: 0, cooldown: 0 };

/**
 * Lock state for ONE model on one account.
 *
 * buildProviderConnectionStatus() folds every `modelLock_*` key together, which
 * would let an unrelated model's cooldown disqualify this model. Read the two
 * keys that actually apply: the model-specific lock and the account-wide one.
 */
function lockedUntilForModel(connection, model) {
  const values = [connection?.[`modelLock_${model}`], connection?.modelLock___all];
  let latest = null;
  for (const value of values) {
    const time = value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(time) || time <= Date.now()) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Health of the best still-fresh enabled account that can serve `provider/model`.
 *
 * This is deliberately an INDEPENDENT signal: it reads cached account test
 * status, never the success rate (which would double-count the same failures).
 * A provider with no fresh reading is `null` (unknown), never 0 — unknown must
 * not be scored as "broken".
 */
async function getProviderHealth(provider, model) {
  let connections;
  try {
    connections = await getProviderConnections({ provider });
  } catch {
    return null;
  }
  let best = null;
  for (const conn of connections || []) {
    if (conn.isActive === false) continue;
    const state = lockedUntilForModel(conn, model)
      ? "cooldown"
      : ["error", "expired", "unavailable"].includes(conn.testStatus) ? "error"
        : ["active", "success"].includes(conn.testStatus) ? (conn.lastError ? "degraded" : "healthy")
          : "unknown";
    const checkedAt = conn.lastTested ? new Date(conn.lastTested).getTime() : NaN;
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > HEALTH_MAX_AGE_MS) continue;
    const score = HEALTH_BY_STATE[state];
    if (score === undefined) continue;
    if (best === null || score > best) best = score;
  }
  return best;
}

/**
 * Get routing metrics for smart routing decisions.
 *
 * Spec (SR-02/SR-03): 30-day window, terminal attempts only; `p95` over
 * SUCCESSFUL attempts with a valid duration; `costPer1k` over priced attempts
 * that actually have a token counter; `health` from cached account status, not
 * successRate. Coverage (`pricedCoverage`) is returned so the caller can refuse
 * to rank on a mostly-unpriced candidate set instead of rewarding "free".
 *
 * @param {object} opts
 * @param {string[]} [opts.models] - filter to specific models
 * @returns {object} { model: { provider, p50, p95, p99, successRate, health, costPer1k, sampleCount, pricedSampleCount, pricedCoverage, lastSeenAt } }
 */
export async function getRoutingMetrics({ models = null } = {}) {
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - ROUTING_WINDOW_MS).toISOString();
  const requested = Array.isArray(models) ? new Set(models.filter(Boolean)) : null;
  const rows = db.all(
    `SELECT a.provider, a.model, a.status, a.durationMs, a.endTime,
            u.cost AS usageCost, u.costStatus AS usageCostStatus,
            u.promptTokens, u.completionTokens
     FROM traceAttempts a
     LEFT JOIN usageHistory u ON u.attemptId = a.attemptId
     WHERE COALESCE(a.endTime, a.startTime) >= ? AND a.status != 'running'
     ORDER BY COALESCE(a.endTime, a.startTime) ASC`,
    [cutoff]
  );

  const buckets = {};
  for (const row of rows) {
    const modelId = `${row.provider}/${row.model}`;
    if (requested && !requested.has(modelId) && !requested.has(row.model)) continue;
    if (!buckets[modelId]) {
      buckets[modelId] = {
        provider: row.provider, model: row.model,
        latencies: [], success: 0, terminal: 0,
        pricedTokens: 0, pricedCost: 0, pricedSamples: 0,
        lastSeenAt: null,
      };
    }
    const bucket = buckets[modelId];
    bucket.terminal++;
    if (row.status === "success") {
      bucket.success++;
      const duration = Number(row.durationMs);
      if (Number.isFinite(duration) && duration > 0) bucket.latencies.push(duration);
    }
    const seen = row.endTime || null;
    if (seen && (!bucket.lastSeenAt || seen > bucket.lastSeenAt)) bucket.lastSeenAt = seen;

    const tokens = (Number(row.promptTokens) || 0) + (Number(row.completionTokens) || 0);
    const cost = Number(row.usageCost);
    // "Priced" means we have BOTH a real price and a counter to divide it by.
    // An attempt with a known cost but zero tokens cannot yield a per-1k rate.
    if (tokens > 0 && Number.isFinite(cost)) {
      bucket.pricedTokens += tokens;
      bucket.pricedCost += cost;
      bucket.pricedSamples++;
    }
  }

  const percentile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  };

  // One provider-health lookup per distinct provider, not per model row.
  const healthByModel = new Map();
  for (const [modelId, bucket] of Object.entries(buckets)) {
    healthByModel.set(modelId, await getProviderHealth(bucket.provider, bucket.model));
  }

  const result = {};
  for (const [modelId, bucket] of Object.entries(buckets)) {
    result[modelId] = {
      provider: bucket.provider,
      model: bucket.model,
      health: healthByModel.get(modelId) ?? null,
      p50: percentile(bucket.latencies, 50),
      p95: percentile(bucket.latencies, 95),
      p99: percentile(bucket.latencies, 99),
      successRate: bucket.terminal > 0 ? bucket.success / bucket.terminal : null,
      // Unknown pricing stays null; it is never treated as free.
      costPer1k: bucket.pricedSamples > 0 ? (bucket.pricedCost / bucket.pricedTokens) * 1000 : null,
      sampleCount: bucket.terminal,
      pricedSampleCount: bucket.pricedSamples,
      pricedCoverage: bucket.terminal > 0 ? bucket.pricedSamples / bucket.terminal : 0,
      lastSeenAt: bucket.lastSeenAt,
    };
  }

  return result;
}

/**
 * Get single trace with attempts.
 *
 * Privacy: both queries name their columns explicitly instead of `SELECT *`, so a
 * column added to either table later cannot silently start leaking through this
 * API. Attempts carry provenance metadata only — token counters and cost are
 * joined from usageHistory and returned under a nested `usage` key, which is the
 * one place numeric usage lives.
 *
 * @param {string} requestId
 * @returns {object|null}
 */
export async function getTrace(requestId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT requestId, taskId, agentLabel, apiKeyId, projectId, requestedModel,
            endpoint, provider, comboName, accountId,
            startTime, endTime, status, httpStatus, reason, cost, costStatus, metricsJson
     FROM traces WHERE requestId = ?`,
    [requestId]
  );
  if (!row) return null;

  const attempts = db.all(
    `SELECT a.attemptId, a.requestId, a.provider, a.model, a.connectionId,
            a.startTime, a.endTime, a.status, a.httpStatus, a.ttftMs, a.durationMs,
            a.tokenSource, a.cost, a.costStatus,
            u.promptTokens, u.completionTokens, u.cost AS usageCost, u.costStatus AS usageCostStatus
     FROM traceAttempts a
     LEFT JOIN usageHistory u ON u.attemptId = a.attemptId
     WHERE a.requestId = ? ORDER BY a.startTime ASC`,
    [requestId]
  );

  return {
    ...row,
    metrics: row.metricsJson ? parseJson(row.metricsJson, null) : null,
    attempts: attempts.map(({ metricsJson: _drop, promptTokens, completionTokens, usageCost, usageCostStatus, ...attempt }) => ({
      ...attempt,
      // Numeric usage only, and only when the ledger actually recorded it. An
      // attempt with no usage row is unknown-cost, never zero-cost.
      usage: promptTokens == null && completionTokens == null
        ? null
        : {
            promptTokens: promptTokens ?? null,
            completionTokens: completionTokens ?? null,
            totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            cost: usageCost ?? null,
            costStatus: usageCostStatus ?? "unknown",
          },
    })),
  };
}

/**
 * Migrate raw apiKey usageHistory to apiKeyId or legacy bucket.
 * Called once during migration. Preserves aggregates.
 * @param {object} apiKeyMap - { rawApiKey: apiKeyId }
 */
export async function migrateUsageHistoryApiKeys(apiKeyMap) {
  const db = await getAdapter();
  const LEGACY_BUCKET = "legacy-unknown";

  db.transaction(() => {
    // Update rows with known apiKey to apiKeyId
    for (const [rawKey, apiKeyId] of Object.entries(apiKeyMap)) {
      if (!rawKey) continue;
      db.run(`UPDATE usageHistory SET apiKey = ? WHERE apiKey = ?`, [apiKeyId, rawKey]);
    }

    // Remaining non-null apiKey that aren't in map -> legacy bucket
    db.run(`UPDATE usageHistory SET apiKey = ? WHERE apiKey IS NOT NULL AND apiKey != ?`, [LEGACY_BUCKET, LEGACY_BUCKET]);
  });

  // Update usageDaily aggregates
  const dailyRows = db.all(`SELECT dateKey, data FROM usageDaily`);
  for (const row of dailyRows) {
    const day = parseJson(row.data, {});
    let changed = false;

    if (day.byApiKey) {
      const newByApiKey = {};
      for (const [akModelKey, agg] of Object.entries(day.byApiKey)) {
        // akModelKey format: "apiKey|model|provider"
        const parts = akModelKey.split("|");
        const rawKey = parts[0];
        if (apiKeyMap[rawKey]) {
          parts[0] = apiKeyMap[rawKey];
          changed = true;
        } else if (rawKey !== "local-no-key" && rawKey !== LEGACY_BUCKET) {
          parts[0] = LEGACY_BUCKET;
          changed = true;
        }
        const newKey = parts.join("|");
        newByApiKey[newKey] = agg;
      }
      if (changed) {
        day.byApiKey = newByApiKey;
        db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [stringifyJson(day), row.dateKey]);
      }
    }
  }
}

export { getUtcDateKey, getUtcMonthKey };