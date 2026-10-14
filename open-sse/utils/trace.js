/**
 * Phase A: Per-attempt tracing for open-sse engine
 * 
 * This module handles tracing at the executor/handler level within open-sse.
 * It provides the integration contract for the app caller (src/sse/handlers/chat.js)
 * to call beginAttempt/finishAttempt via callbacks.
 * 
 * Privacy: No prompt, output, token, or header leakage. Only metadata.
 * 
 * Contract for app caller:
 * - onTraceBegin({ requestId, provider, model, connectionId }) → { attemptId, ... }
 * - onTraceFinish({ attemptId, status, httpStatus, ttftMs, durationMs, tokens, tokenSource })
 * 
 * The app caller owns traceRepo and provides these callbacks. open-sse calls them
 * at the right lifecycle points: initial attempt, refresh retry, and terminal states.
 */

import crypto from "node:crypto";

const VALID_ATTEMPT_STATUSES = new Set(["success", "error", "cancelled"]);

function genId() {
  return crypto.randomUUID();
}

/**
 * Begin an attempt trace from open-sse.
 * Called once per upstream call (initial + each refresh retry).
 * 
 * @param {object} params
 * @param {string} params.requestId - Parent trace requestId (from app)
 * @param {string} params.provider - Upstream provider name
 * @param {string} params.model - Model sent to upstream
 * @param {string} [params.connectionId] - Provider connection ID
 * @returns {object} { attemptId, startTime }
 */
export function beginAttemptTrace({ requestId, provider, model, connectionId = null }) {
  if (!requestId || !provider || !model) {
    throw new Error("requestId, provider, and model are required for beginAttemptTrace");
  }
  const attemptId = genId();
  const startTime = new Date().toISOString();
  return { attemptId, requestId, provider, model, connectionId, startTime, status: "running" };
}

/**
 * Finish an attempt trace from open-sse.
 * Called when the upstream call reaches a terminal state.
 * 
 * @param {object} params
 * @param {string} params.attemptId - From beginAttemptTrace
 * @param {string} params.status - 'success' | 'error' | 'cancelled'
 * @param {number} [params.httpStatus] - Upstream HTTP status
 * @param {number} [params.ttftMs] - Time to first token (ms)
 * @param {number} [params.durationMs] - Total duration (ms)
 * @param {object} [params.tokens] - { prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cache_creation_input_tokens }
 * @param {string} [params.tokenSource] - 'upstream' | 'estimated' | 'unknown'
 * @returns {object} finished attempt summary
 */
export function finishAttemptTrace({ attemptId, status, httpStatus = null, ttftMs = null, durationMs = null, tokens = null, tokenSource = "unknown" }) {
  if (!attemptId || !VALID_ATTEMPT_STATUSES.has(status)) {
    throw new Error("attemptId and valid terminal status required for finishAttemptTrace");
  }
  const endTime = new Date().toISOString();
  return {
    attemptId,
    endTime,
    status,
    httpStatus,
    ttftMs,
    durationMs,
    tokens,
    tokenSource,
  };
}

/**
 * Determine token source from response.
 * 'upstream' = provider returned usage in response
 * 'estimated' = we estimated from known patterns
 * 'unknown' = no usage data available
 */
export function inferTokenSource(responseBody, provider) {
  if (!responseBody || typeof responseBody !== "object") return "unknown";
  
  // Check for standard usage fields
  if (responseBody.usage) {
    if (responseBody.usage.prompt_tokens !== undefined || 
        responseBody.usage.input_tokens !== undefined ||
        responseBody.usage.promptTokenCount !== undefined) {
      return "upstream";
    }
  }
  
  // Check for provider-specific usage shapes
  if (provider === "ollama-local" && responseBody.done === true) {
    if (responseBody.prompt_eval_count !== undefined || responseBody.eval_count !== undefined) {
      return "upstream";
    }
  }
  
  // Check for Responses API usage
  if (responseBody.usage?.input_tokens !== undefined) {
    return "upstream";
  }
  
  // Check for usageMetadata (Gemini/Antigravity)
  if (responseBody.usageMetadata || responseBody.response?.usageMetadata) {
    return "upstream";
  }
  
  return "unknown";
}

/**
 * Extract tokens from response body for tracing.
 * Returns normalized token object or null if unavailable.
 * 
 * Privacy: This only extracts token COUNT metadata, never prompt/output content.
 */
export function extractTokensForTrace(responseBody, provider) {
  if (!responseBody || typeof responseBody !== "object") return null;
  
  // OpenAI / standard format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens,
    };
  }
  
  // Responses API format (input_tokens = cache-inclusive)
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens,
    };
  }
  
  // Gemini / Antigravity format
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0,
    };
  }
  
  // Ollama format
  if (responseBody.done === true && (responseBody.prompt_eval_count !== undefined || responseBody.eval_count !== undefined)) {
    return {
      prompt_tokens: responseBody.prompt_eval_count || 0,
      completion_tokens: responseBody.eval_count || 0,
      cached_tokens: responseBody.prompt_eval_cached_count || 0,
    };
  }
  
  return null;
}

/**
 * Calculate TTFT for streaming responses.
 * @param {number} requestStartTime - Timestamp when request started
 * @param {number} firstChunkTime - Timestamp when first chunk received
 * @returns {number} TTFT in ms, or null if not available
 */
export function calculateTtft(requestStartTime, firstChunkTime) {
  if (!firstChunkTime || !requestStartTime) return null;
  const ttft = firstChunkTime - requestStartTime;
  return ttft >= 0 ? ttft : null;
}

/**
 * Calculate total duration.
 */
export function calculateDuration(requestStartTime, endTime = Date.now()) {
  if (!requestStartTime) return null;
  const duration = endTime - requestStartTime;
  return duration >= 0 ? duration : null;
}