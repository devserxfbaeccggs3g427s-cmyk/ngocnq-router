// Finish the parent trace when the response actually terminates, not when its
// streaming headers are returned. Only status metadata crosses this boundary.
export function wrapResponseWithTrace(response, request, finish, traceContext = null) {
  let settled = false;
  const complete = async (status, reason = null) => {
    if (settled) return;
    settled = true;
    request?.signal?.removeEventListener?.("abort", onAbort);
    await finish({ status, httpStatus: status === "cancelled" ? 499 : response.status, reason });
  };
  const responseStatus = response.ok ? "success" : "error";
  const errorReason = response.status === 429 ? "rate_limit"
    : response.status === 401 || response.status === 403 ? "auth_failed"
      : response.status >= 500 ? "upstream_error" : "invalid_request";
  let cancelled = false;
  let reader;
  const onAbort = () => {
    cancelled = true;
    if (reader) {
      Promise.resolve(reader.cancel()).catch(() => {}).finally(() => complete("cancelled", "cancelled"));
    } else {
      void complete("cancelled", "cancelled");
    }
  };

  if (!response.body) {
    void complete(responseStatus, response.ok ? null : errorReason);
    return response;
  }

  reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Use traceContext.terminal if available (set by onTraceTerminal callback),
          // otherwise fall back to response.ok
          const terminal = traceContext?.terminal;
          await complete(cancelled ? "cancelled" : terminal?.status || responseStatus,
            cancelled ? "cancelled" : terminal?.reason || (response.ok ? null : errorReason));
          controller.close();
        } else if (!cancelled) {
          controller.enqueue(value);
        }
      } catch (error) {
        await complete(cancelled ? "cancelled" : "error", cancelled ? "cancelled" : "upstream_error");
        controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      try {
        await reader.cancel();
      } finally {
        await complete("cancelled", "cancelled");
      }
    },
  });

  if (request?.signal) {
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
