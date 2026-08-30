import { describe, expect, it } from "vite-plus/test";

import { summarizeOtlpTraceData } from "./otlpTraceSummary.ts";

/**
 * The summary replaces the full rejected body in the decode-failure warning, so
 * what it must NOT carry matters as much as what it counts.
 */
const bodyWithSecret = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              name: "GET /api/threads",
              attributes: [
                { key: "http.url", value: { stringValue: "https://host/x?token=hunter2secret" } },
              ],
            },
            { name: "second span" },
          ],
        },
        { spans: [{ name: "third span" }] },
      ],
    },
    { scopeSpans: [] },
  ],
};

describe("summarizeOtlpTraceData", () => {
  it("counts spans at each level", () => {
    expect(summarizeOtlpTraceData(bodyWithSecret as never)).toEqual({
      resourceSpanCount: 2,
      scopeSpanCount: 2,
      spanCount: 3,
    });
  });

  it("carries no payload content, only counts", () => {
    // The whole reason this function exists. Serialize the summary and assert the
    // body's own strings are absent - a future field that leaked an attribute or
    // a span name would fail here rather than quietly land in server.log.
    const serialized = JSON.stringify(summarizeOtlpTraceData(bodyWithSecret as never));

    expect(serialized).not.toContain("hunter2secret");
    expect(serialized).not.toContain("http.url");
    expect(serialized).not.toContain("GET /api/threads");
  });

  it("survives a malformed body, which is the only way it is ever called", () => {
    // It runs exclusively on payloads that already failed to decode, so every
    // level may be missing or the wrong type.
    expect(summarizeOtlpTraceData({} as never)).toEqual({
      resourceSpanCount: 0,
      scopeSpanCount: 0,
      spanCount: 0,
    });
    expect(summarizeOtlpTraceData({ resourceSpans: "nope" } as never)).toEqual({
      resourceSpanCount: 0,
      scopeSpanCount: 0,
      spanCount: 0,
    });
    expect(
      summarizeOtlpTraceData({ resourceSpans: [{ scopeSpans: [{ spans: null }] }] } as never),
    ).toEqual({ resourceSpanCount: 1, scopeSpanCount: 1, spanCount: 0 });
  });
});
