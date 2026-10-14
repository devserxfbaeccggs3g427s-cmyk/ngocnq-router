/**
 * Phase A trace coverage manifest (TR-01, T06).
 *
 * Phase A traces exactly one family of `/v1/*` inference entrypoints: the
 * chat formats that all funnel through `src/sse/handlers/chat.js` →
 * `open-sse/handlers/chatCore.js`. Every other paid upstream entrypoint keeps
 * its pre-Phase-A behaviour (unchanged `/v1/*` response, legacy usage writer
 * where one existed) and is **explicitly reported here as untraced** rather
 * than silently counted as zero cost.
 *
 * This manifest is metadata only — no secrets, no URLs with credentials, no
 * request payloads. It exists so the analytics API and dashboard can state
 * "requests, not all paid attempts" instead of implying full coverage.
 */

/**
 * @typedef {Object} CoverageEntry
 * @property {string}  endpoint        Canonical `/v1/*` path (no query string).
 * @property {string}  handler         App-side handler module basename.
 * @property {boolean} traced          True only when a Phase A parent trace +
 *                                     per-dispatch attempts are written.
 * @property {boolean} upstreamPaid    True when the path can bill an upstream.
 * @property {string}  usageSource     Where usage/cost currently lands.
 * @property {string|null} note        Operator-facing gap description.
 */

/** @type {CoverageEntry[]} */
export const TRACE_COVERAGE = Object.freeze([
  // --- Traced: chat family (parent trace + per-dispatch attempts) ----------
  { endpoint: "/v1/chat/completions", handler: "chat.js", traced: true, upstreamPaid: true, usageSource: "trace+usageHistory", note: null },
  { endpoint: "/v1/messages", handler: "chat.js", traced: true, upstreamPaid: true, usageSource: "trace+usageHistory", note: null },
  { endpoint: "/v1/responses", handler: "chat.js", traced: true, upstreamPaid: true, usageSource: "trace+usageHistory", note: null },
  { endpoint: "/v1/api/chat", handler: "chat.js", traced: true, upstreamPaid: true, usageSource: "trace+usageHistory", note: null },
  { endpoint: "/v1/responses/compact", handler: "chat.js", traced: true, upstreamPaid: true, usageSource: "trace+usageHistory", note: null },

  // --- Untraced paid entrypoints (documented gap, response unchanged) -----
  {
    endpoint: "/v1/embeddings",
    handler: "embeddings.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "usageHistory (legacy saveRequestUsage, exact usage only)",
    note: "Records exact upstream usage but no parent trace/attempts, so it is absent from trace lists and cost coverage.",
  },
  {
    endpoint: "/v1/images/generations",
    handler: "imageGeneration.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "usageHistory (legacy saveRequestUsage when upstream reports counters)",
    note: "No Phase A trace; per-image jobs are absent from trace drill-down.",
  },
  {
    endpoint: "/v1/systemone",
    handler: "systemone.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "usageHistory (legacy saveRequestUsage when upstream reports usage)",
    note: "No Phase A trace.",
  },
  {
    endpoint: "/v1/search",
    handler: "search.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "Web-search upstream calls are not traced and not billed to Phase A cost; treat their cost as unknown, not free.",
  },
  {
    endpoint: "/v1/web/fetch",
    handler: "fetch.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "Web-fetch upstream calls are not traced and not billed to Phase A cost; treat their cost as unknown, not free.",
  },
  {
    endpoint: "/v1/audio/speech",
    handler: "tts.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "TTS upstream calls are not traced.",
  },
  {
    endpoint: "/v1/audio/transcriptions",
    handler: "stt.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "STT upstream calls are not traced.",
  },
  {
    endpoint: "/v1/videos/generations",
    handler: "videoGeneration.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "Video job creation proxies an upstream job; no Phase A trace.",
  },
  {
    endpoint: "/v1/videos/edits",
    handler: "videoGeneration.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "Video job creation proxies an upstream job; no Phase A trace.",
  },
  {
    endpoint: "/v1/videos/extensions",
    handler: "videoGeneration.js",
    traced: false,
    upstreamPaid: true,
    usageSource: "none (no usage writer on this path)",
    note: "Video job creation proxies an upstream job; no Phase A trace.",
  },
  {
    endpoint: "/v1/videos/{id}",
    handler: "videoGeneration.js",
    traced: false,
    upstreamPaid: false,
    usageSource: "none",
    note: "Job status poll against an already-created job; not a new billable dispatch.",
  },
]);

const TRACED = TRACE_COVERAGE.filter((e) => e.traced);
const UNTRACED_PAID = TRACE_COVERAGE.filter((e) => !e.traced && e.upstreamPaid);

/**
 * Coverage summary for analytics responses and the dashboard. Callers must
 * surface `totalCostUsd` as a subtotal over *traced* attempts only, and label
 * untraced paid paths as unknown-cost rather than zero-cost.
 */
export function getTraceCoverage() {
  return {
    tracedEndpoints: TRACED.map((e) => e.endpoint),
    untracedPaidEndpoints: UNTRACED_PAID.map((e) => e.endpoint),
    tracedEndpointCount: TRACED.length,
    untracedPaidEndpointCount: UNTRACED_PAID.length,
    scope: "chat-only",
    disclosure:
      "Phase A traces the chat endpoints only. Other paid /v1/* paths keep their pre-Phase-A response and usage behaviour and are reported as untraced; their cost is unknown, not zero.",
  };
}

/** Endpoints that can bill an upstream provider but are not traced yet. */
export function getUntracedPaidEndpoints() {
  return UNTRACED_PAID.map((e) => ({ ...e }));
}