import type { OtlpTracer } from "effect/observability";

/**
 * Enough of a rejected OTLP body to debug the decode, without the body itself: span
 * attributes carry URLs, paths and sometimes credentials, which must not land in server.log.
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
