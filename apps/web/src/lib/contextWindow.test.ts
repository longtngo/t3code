import { describe, expect, it } from "vite-plus/test";
import { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  ContextTransferId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { shouldOfferResumeCompaction } from "../components/chat/ContextWindowMeter.logic";
import {
  type ContextWindowSnapshot,
  deriveCompactionMarker,
  deriveLatestContextWindowSnapshot,
  describeMissingContextUsage,
  latestProviderTurnTokenUsage,
} from "./contextWindow";

const decodeTokenUsage = Schema.decodeSync(OrchestrationV2ProviderTurnTokenUsage);

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
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const usage = decodeTokenUsage({
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      autoCompactThreshold: 150_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
    expect(snapshot?.autoCompactThreshold).toBe(150_000);
  });

  it("carries the thread's compaction facts onto a live report of the same window", () => {
    // FORK (invariant 12): Claude's live report has no compaction facts; the
    // turn-end getContextUsage snapshot on the provider thread does.
    const providerThread = {
      contextUsage: {
        usedTokens: 500_000,
        maxTokens: 1_000_000,
        compactsAutomatically: true,
        autoCompactThreshold: 967_000,
        autoCompactSource: "settings",
      },
      updatedAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
    };
    const sameWindow = deriveLatestContextWindowSnapshot(
      [],
      { usedTokens: 541_000, maxTokens: 1_000_000, updatedAt: "2026-08-27T00:01:00.000Z" },
      providerThread,
    );
    expect(sameWindow).toMatchObject({
      usedTokens: 541_000,
      autoCompactThreshold: 967_000,
      autoCompactSource: "settings",
    });
    // A report that names its own threshold wins over the carried one.
    const ownThreshold = deriveLatestContextWindowSnapshot(
      [],
      decodeTokenUsage({
        usedTokens: 541_000,
        maxTokens: 1_000_000,
        autoCompactThreshold: 900_000,
        updatedAt: "2026-08-27T00:01:00.000Z",
      }),
      providerThread,
    );
    expect(ownThreshold).toMatchObject({
      autoCompactThreshold: 900_000,
      autoCompactSource: "settings",
    });
    // A threshold is an absolute count for its window: after a model switch it
    // would draw the marker for the wrong model, so it is dropped.
    const otherWindow = deriveLatestContextWindowSnapshot(
      [],
      { usedTokens: 41_000, maxTokens: 200_000, updatedAt: "2026-08-27T00:02:00.000Z" },
      providerThread,
    );
    expect(otherWindow).toMatchObject({ autoCompactThreshold: null, autoCompactSource: null });
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

describe("latestProviderTurnTokenUsage", () => {
  it("picks the newest report, not the last turn in snapshot order", () => {
    const usage = (usedTokens: number, updatedAt: string) => ({
      tokenUsage: { usedTokens, updatedAt },
    });
    const latest = latestProviderTurnTokenUsage([
      usage(300_000, "2026-06-20T12:00:00.000Z"),
      {},
      usage(90_000, "2026-06-20T09:00:00.000Z"),
    ]);
    expect(latest?.usedTokens).toBe(300_000);
  });

  const sourceUsage = {
    usedTokens: 513_000,
    maxTokens: 1_000_000,
    promptCacheTtlMs: 5 * 60_000,
    updatedAt: "2026-10-19T12:00:00.000Z",
  };
  function forkProjection() {
    const projection = makeThreadProjectionFixture();
    const sourceThreadId = ThreadId.make("parent");
    const runId = RunId.make("fork-point");
    return {
      thread: {
        ...projection.thread,
        forkedFrom: { type: "run" as const, threadId: sourceThreadId, runId },
      },
      contextTransfers: [
        {
          id: ContextTransferId.make("fork-transfer"),
          type: "fork" as const,
          sourceThreadId,
          targetThreadId: projection.thread.id,
          sourcePoint: { threadId: sourceThreadId, runId },
          basePoint: null,
          sourceProviderInstanceId: projection.thread.modelSelection.instanceId,
          sourceTokenUsage: sourceUsage,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending" as const,
          resolution: null,
          createdBy: "user" as const,
          error: null,
          createdAt: projection.updatedAt,
          updatedAt: projection.updatedAt,
          consumedAt: null,
        },
      ],
    };
  }

  it("keeps fork-point context and its cache expiry before the fork reports usage", () => {
    const usage = latestProviderTurnTokenUsage([], forkProjection());
    expect(usage).toEqual(sourceUsage);
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot?.usedTokens).toBe(513_000);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: snapshot?.usedTokens,
        updatedAt: snapshot?.updatedAt,
        promptCacheTtlMs: usage?.promptCacheTtlMs,
        now: "2026-10-19T12:06:00.000Z",
      }),
    ).toBe(true);
  });

  it("replaces inherited usage with the fork's own report", () => {
    const tokenUsage = { usedTokens: 42_000, updatedAt: "2026-10-19T12:10:00.000Z" };
    expect(latestProviderTurnTokenUsage([{ tokenUsage }], forkProjection())).toEqual(tokenUsage);
  });

  it.each([0, 42_000])(
    "prefers target provider-thread usage of %d tokens over inherited usage",
    (usedTokens) => {
      const providerThread = {
        contextUsage: {
          usedTokens,
          maxTokens: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        },
        updatedAt: DateTime.makeUnsafe("2026-10-19T12:10:00.000Z"),
      };
      const usage = latestProviderTurnTokenUsage([], forkProjection(), providerThread);
      const snapshot = deriveLatestContextWindowSnapshot([], usage, providerThread);

      expect(snapshot).toMatchObject({
        usedTokens,
        maxTokens: 200_000,
        cost: { amount: 0.42, currency: "USD" },
        updatedAt: "2026-10-19T12:10:00.000Z",
      });
    },
  );

  it("keeps the fallback after a native fork is consumed", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    expect(
      latestProviderTurnTokenUsage([], {
        ...projection,
        contextTransfers: [
          {
            ...transfer,
            status: "consumed",
            resolution: {
              strategy: "native_fork",
              providerThreadRef: {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: "fork",
                strength: "strong",
              },
            },
          },
        ],
      }),
    ).toEqual(sourceUsage);
  });

  it("does not reuse usage for portable handoffs, different providers, or missing history", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    for (const contextTransfers of [
      [],
      [{ ...transfer, sourceTokenUsage: undefined }],
      [{ ...transfer, status: "resolved_portable" as const }],
      [{ ...transfer, sourceProviderInstanceId: ProviderInstanceId.make("other") }],
      [{ ...transfer, sourcePoint: { ...transfer.sourcePoint, runId: RunId.make("later") } }],
    ]) {
      expect(latestProviderTurnTokenUsage([], { ...projection, contextTransfers })).toBeNull();
    }
  });
});
