import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  type ContextWindowSnapshot,
  deriveCompactionMarker,
  deriveLatestContextWindowSnapshot,
  describeMissingContextUsage,
  formatContextWindowTokens,
} from "./contextWindow";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("prefers current provider usage and preserves ACP cost", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: 10_000,
      remainingTokens: 7_500,
      usedPercentage: 25,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("carries the provider's auto-compaction source, and leaves it unset when omitted", () => {
    // FORK: the only field that says whether compaction is ARMED - the provider
    // reports "auto" for the windows it refuses to compact.
    const updatedAt = DateTime.makeUnsafe("2026-08-23T00:00:00.000Z");
    const armed = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 14_000, maxTokens: 258_000, autoCompactSource: "settings" },
      updatedAt,
    });
    expect(armed?.autoCompactSource).toBe("settings");
    const silent = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 14_000 },
      updatedAt,
    });
    expect(silent?.autoCompactSource).toBeNull();
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
  });

  it("handles a report without a known context window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.usedPercentage).toBeNull();
  });
});

describe("deriveCompactionMarker", () => {
  const snapshot = (overrides: Partial<ContextWindowSnapshot>): ContextWindowSnapshot =>
    ({
      usedTokens: 541_000,
      maxTokens: 1_000_000,
      usedPercentage: 54.1,
      remainingTokens: 459_000,
      remainingPercentage: 45.9,
      compactsAutomatically: true,
      autoCompactThreshold: 567_000,
      autoCompactSource: "settings",
      updatedAt: "2026-08-27T00:00:00.000Z",
      ...overrides,
    }) as ContextWindowSnapshot;

  it("places the marker at the threshold's share of the model window", () => {
    const marker = deriveCompactionMarker(snapshot({}));
    expect(marker?.pct).toBeCloseTo(56.7, 5);
    expect(marker?.label).toBe("compacts at 567k");
  });

  it("draws nothing when the provider omits the source", () => {
    // The gate is "present and not auto", NOT "!== auto". `autocompactSource`
    // is absent from the SDK's declared response type and missing from most
    // live snapshots, so a `!== "auto"` test degrades OPEN and would draw a
    // marker on a window that will never compact.
    expect(deriveCompactionMarker(snapshot({ autoCompactSource: null }))).toBeNull();
  });

  it("draws nothing when the window is one Claude refuses to compact", () => {
    // `autoCompactThreshold` is present and meaningless in this state — the CLI
    // computes it without consulting the source.
    expect(
      deriveCompactionMarker(
        snapshot({ autoCompactSource: "auto", autoCompactThreshold: 967_000 }),
      ),
    ).toBeNull();
  });

  it("draws nothing without a threshold or a window to measure it against", () => {
    expect(deriveCompactionMarker(snapshot({ autoCompactThreshold: null }))).toBeNull();
    expect(deriveCompactionMarker(snapshot({ maxTokens: null }))).toBeNull();
  });

  it("draws nothing when the threshold is not inside the window", () => {
    // Equal means the marker would sit on the bar's end cap, claiming a
    // boundary that carries no information.
    expect(deriveCompactionMarker(snapshot({ autoCompactThreshold: 1_000_000 }))).toBeNull();
  });
});

describe("describeMissingContextUsage", () => {
  // Which providers report usage is the server's knowledge now, advertised per
  // instance as `reportsContextUsage`. The driver list in this module survives
  // only as a fallback for a server too old to send it, so the precedence
  // between the two is the thing worth pinning - and none of it was tested.
  it("says nothing when the provider reports usage", () => {
    expect(describeMissingContextUsage("claudeAgent", true)).toBeNull();
  });

  it("explains the gap when the provider says it does not", () => {
    expect(describeMissingContextUsage("cursor", false)).toMatch(/does not report context usage/);
  });

  it("believes the provider over the built-in list", () => {
    // "cursor" is on the fallback list; an explicit `true` must still win, or a
    // provider that starts reporting usage stays mislabelled until a client ships.
    expect(describeMissingContextUsage("cursor", true)).toBeNull();
    // And the reverse, for a driver absent from the list.
    expect(describeMissingContextUsage("claudeAgent", false)).toMatch(
      /does not report context usage/,
    );
  });

  it("falls back to the driver list when the server is silent", () => {
    expect(describeMissingContextUsage("cursor", undefined)).toMatch(
      /does not report context usage/,
    );
    expect(describeMissingContextUsage("claudeAgent", undefined)).toBeNull();
  });

  it("says nothing without a provider, whatever the capability says", () => {
    expect(describeMissingContextUsage(null, false)).toBeNull();
    expect(describeMissingContextUsage(undefined, false)).toBeNull();
  });
});
