import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  type ContextWindowSnapshot,
  deriveCompactionMarker,
  deriveLatestContextWindowSnapshot,
  describeMissingContextUsage,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
        // Carried because it is the only field that says whether compaction is
        // ARMED - the provider reports "auto" for the windows it refuses to
        // compact, while the two fields above read the same either way.
        autoCompactSource: "settings",
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
    expect(snapshot?.autoCompactSource).toBe("settings");
  });

  it("leaves the auto-compaction source unset when the provider omits it", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 14_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.autoCompactSource).toBeNull();
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
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
