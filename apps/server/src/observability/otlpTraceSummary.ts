import type { OtlpTracer } from "effect/unstable/observability";

/**
 * Enough of a rejected OTLP body to debug the decode, without the body itself.
 *
 * Browser span attributes carry request URLs, file paths and occasionally
 * credentials in query strings. The whole payload used to go into the warning,
 * which put it in server.log for anyone who can read the file - a durable copy
 * of data the trace pipeline itself never accepted.
 */
export function summarizeOtlpTraceData(bodyJson: OtlpTracer.TraceData): {
  readonly resourceSpanCount: number;
  readonly scopeSpanCount: number;
  readonly spanCount: number;
} {
  const resourceSpans = Array.isArray(bodyJson?.resourceSpans) ? bodyJson.resourceSpans : [];
  let scopeSpanCount = 0;
  let spanCount = 0;
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];
    scopeSpanCount += scopeSpans.length;
    for (const scopeSpan of scopeSpans) {
      spanCount += Array.isArray(scopeSpan?.spans) ? scopeSpan.spans.length : 0;
    }
  }
  return { resourceSpanCount: resourceSpans.length, scopeSpanCount, spanCount };
}
