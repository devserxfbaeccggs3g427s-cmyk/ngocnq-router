import { canonicalizeUsage, extractUsage, hasValidUsage } from "../../utils/usageTracking.js";

// The app owns persistence; the engine only emits bounded, non-content metadata.
export function createAttemptTracer({ trace, onTraceBegin, onTraceFinish, onTraceTerminal, provider, model, connectionId, log }) {
  if (!trace?.requestId || !onTraceBegin || !onTraceFinish) return null;

  const terminal = (status, reason) => {
    try { onTraceTerminal?.({ status, reason }); } catch { /* tracing must not affect routing */ }
  };

  const begin = async () => {
    const startedAt = Date.now();
    let attempt;
    try {
      attempt = await onTraceBegin({ requestId: trace.requestId, provider, model, connectionId });
    } catch (error) {
      log?.warn?.("TRACE", `begin attempt failed: ${error.message}`);
    }
    if (!attempt?.attemptId) return null;
    let completion = null;
    return {
      startedAt,
      finish({ status, httpStatus = null, ttftAt = null, usage = null, tokenSource = null, reason = null }) {
        if (completion) return completion;
        completion = (async () => {
        const extracted = usage && (extractUsage({ usage }) || extractUsage(usage) || usage);
        const tokens = hasValidUsage(extracted) ? canonicalizeUsage(extracted) : null;
        const source = tokens ? (tokenSource || (usage?.estimated ? "estimated" : "upstream")) : "unknown";
        try {
          await onTraceFinish({
            attemptId: attempt.attemptId, status, httpStatus,
            ttftMs: ttftAt == null ? null : Math.max(0, ttftAt - startedAt),
            durationMs: Math.max(0, Date.now() - startedAt),
            tokens, tokenSource: source,
          });
        } catch (error) {
          log?.warn?.("TRACE", `finish attempt failed: ${error.message}`);
        }
        })();
        return completion;
      },
    };
  };

  return { begin, terminal };
}
