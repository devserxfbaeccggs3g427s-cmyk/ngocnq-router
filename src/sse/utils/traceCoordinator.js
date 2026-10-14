/**
 * Phase A parent-trace coordinator (T05).
 *
 * Exactly one parent trace per accepted /v1 chat request, plus one child attempt
 * per upstream dispatch. This module owns the parent; `open-sse` owns the children
 * through the `onTraceBegin` / `onTraceFinish` callbacks it already accepts.
 *
 * Privacy (TR-04): nothing here records a prompt, an output, a header value, a
 * credential, or a raw token string. Only the client-supplied task id / agent
 * label (both validated against fixed patterns), stable key/project ids, and
 * routing metadata cross this boundary.
 *
 * Security: a rejected request (bad key, key not allowed to call the model) must
 * leave NO trace. That is why `createTraceCoordinator` is called after the auth
 * and allow-list checks, not before. The endpoint is resolved against a fixed
 * allow-list rather than echoed from the request line, so an attacker cannot
 * smuggle arbitrary path or query text into stored rows.
 */
import crypto from "node:crypto";

import { beginTrace, beginAttempt, finishAttempt, finishTrace, updateTraceRouting } from "@/lib/db/repos/traceRepo.js";
import { wrapResponseWithTrace } from "@/sse/utils/traceResponse.js";

// Canonical, allow-listed chat endpoints. Anything else is recorded as
// "unknown" — never the raw request path, which may contain user-controlled text.
const TRACE_ENDPOINTS = Object.freeze([
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
  "/v1/api/chat",
  "/v1/responses/compact",
]);

const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const AGENT_LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Bounded label so a hostile header cannot grow a row without limit. */
function readHeader(request, name, pattern) {
  let raw;
  try { raw = request?.headers?.get(name); } catch { return null; }
  if (typeof raw !== "string") return null;
  const value = raw.trim().slice(0, 128);
  return pattern.test(value) ? value : null;
}

export function canonicalTraceEndpoint(request) {
  let pathname;
  try { pathname = new URL(request.url).pathname; } catch { return "unknown"; }
  return TRACE_ENDPOINTS.includes(pathname) ? pathname : "unknown";
}

/**
 * Create the parent trace for one request.
 *
 * @returns {Promise<TraceCoordinator>} always returns an object — `enabled:false`
 *   when tracing could not start, in which case every method is a no-op and the
 *   request proceeds exactly as it did before Phase A.
 */
export async function createTraceCoordinator({ request, requestedModel, keyAccess = null, comboName = null }) {
  const requestId = crypto.randomUUID();
  const endpoint = canonicalTraceEndpoint(request);
  const taskId = readHeader(request, "x-9router-task-id", TASK_ID_PATTERN);
  const agentLabel = readHeader(request, "x-9router-agent-label", AGENT_LABEL_PATTERN);

  let trace = null;
  try {
    trace = await beginTrace({
      requestId,
      taskId,
      agentLabel,
      // Attribution comes from the key record the allow-list check already
      // validated — never from a header the client could assert about itself.
      apiKeyId: keyAccess?.keyId || null,
      projectId: keyAccess?.projectId || null,
      requestedModel,
      endpoint,
      comboName,
    });
  } catch (error) {
    // Tracing is observability, not the request's contract. A failed parent must
    // never fail the caller's request.
    console.warn("[TRACE] beginTrace failed:", error.message);
    return noopCoordinator();
  }

  let settled = false;
  const coordinator = {
    enabled: true,
    requestId,
    trace,
    terminal: null,

    /** Attempt hook handed to open-sse; one child attempt per dispatch. */
    onTraceBegin: async ({ requestId: rid, provider, model, connectionId }) =>
      beginAttempt({
        attemptId: crypto.randomUUID(),
        requestId: rid,
        provider,
        model,
        connectionId: connectionId ?? null,
      }),

    onTraceFinish: async ({ attemptId, status, httpStatus, ttftMs, durationMs, tokens, tokenSource }) => {
      try {
        await finishAttempt({ attemptId, status, httpStatus, ttftMs, durationMs, tokens, tokenSource });
      } catch (error) {
        console.warn("[TRACE] finishAttempt failed:", error.message);
      }
    },

    /** open-sse reports the worst thing that happened to the whole request. */
    onTraceTerminal: ({ status, reason }) => {
      if (!coordinator.terminal) coordinator.terminal = { status, reason: reason ?? null };
    },

    /** Record what the request actually resolved to (once known). */
    async noteRouting(details) {
      try {
        await updateTraceRouting({ requestId, ...details });
      } catch (error) {
        console.warn("[TRACE] updateTraceRouting failed:", error.message);
      }
    },

    async finish(status, httpStatus = null, reason = null) {
      if (settled) return;
      settled = true;
      try {
        await finishTrace({ requestId, status, httpStatus, reason });
      } catch (error) {
        console.warn("[TRACE] finishTrace failed:", error.message);
      }
    },

    /**
     * Terminalize the parent when the response actually ends — after the last
     * chunk is delivered or the client disconnects — not when headers are ready.
     * A successful terminal from open-sse wins over the HTTP status alone.
     *
     * `wrapResponseWithTrace` reports its outcome as a single object, so adapt it
     * to this coordinator's positional signature here rather than letting the two
     * disagree — otherwise every streaming trace would stay `pending` forever.
     */
    wrap(response) {
      if (!response) return response;
      return wrapResponseWithTrace(
        response,
        request,
        (outcome = {}) => coordinator.finish(outcome.status, outcome.httpStatus, outcome.reason),
        coordinator
      );
    },
  };

  return coordinator;
}

function noopCoordinator() {
  return {
    enabled: false,
    requestId: null,
    trace: null,
    terminal: null,
    onTraceBegin: null,
    onTraceFinish: null,
    onTraceTerminal: () => {},
    noteRouting: async () => {},
    finish: async () => {},
    wrap: (response) => response,
  };
}