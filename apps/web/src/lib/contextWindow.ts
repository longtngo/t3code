import type { ThreadStructure, ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

/**
 * Fallback for servers that do not advertise `reportsContextUsage`: drivers measured to never
 * send usage (cursor-agent 2026.08.25 sends neither ACP usage field; Grok and OpenCode never emit
 * token usage). Keyed on the provider, not an absent snapshot: a new Claude thread has none yet.
 */
const PROVIDERS_WITHOUT_CONTEXT_USAGE = new Set(["cursor", "grok", "opencode"]);

/**
 * Why the context block is missing, or `null` when the provider reports usage. `provider` is the
 * driver the thread's SESSION ran on, not the picker's selection: the picker moves without the
 * thread, and gating on it would blame Cursor for a thread that ran on Claude.
 */
export function describeMissingContextUsage(
  provider: string | null | undefined,
  /** `ServerProvider.reportsContextUsage`; `undefined` (older server) falls back to the list. */
  reportsContextUsage?: boolean | undefined,
): string | null {
  if (!provider) return null;
  if (reportsContextUsage === true) return null;
  if (reportsContextUsage !== false && !PROVIDERS_WITHOUT_CONTEXT_USAGE.has(provider)) return null;
  return `${formatProviderDisplayName(provider)} does not report context usage.`;
}

function carriedCompactionFacts(
  usage: ThreadTokenUsageSnapshot | null | undefined,
  maxTokens: number | null,
): Pick<
  ContextWindowSnapshot,
  "compactsAutomatically" | "autoCompactThreshold" | "autoCompactSource"
> {
  if (usage == null || maxTokens === null || usage.maxTokens !== maxTokens) {
    return { compactsAutomatically: true, autoCompactThreshold: null, autoCompactSource: null };
  }
  return {
    compactsAutomatically: usage.compactsAutomatically ?? true,
    autoCompactThreshold: usage.autoCompactThreshold ?? null,
    autoCompactSource: usage.autoCompactSource ?? null,
  };
}

/** Newest report by timestamp; snapshots order turns by provider thread. */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
  projection?: Pick<ThreadStructure, "thread" | "contextTransfers"> | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage"> | null,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  if (latest !== null || projection == null || providerThread?.contextUsage != null) return latest;
  const forkedFrom = projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run") return null;
  return (
    projection.contextTransfers.find(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.targetThreadId === projection.thread.id &&
        transfer.sourceThreadId === forkedFrom.threadId &&
        transfer.sourcePoint.runId === forkedFrom.runId &&
        transfer.sourceProviderInstanceId === projection.thread.modelSelection.instanceId &&
        (transfer.status === "pending" || transfer.resolution?.strategy === "native_fork"),
    )?.sourceTokenUsage ?? null
  );
}

export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: ThreadStructureTurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
): ContextWindowSnapshot | null {
  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      // FORK (invariant 12): the live report carries no compaction facts beyond its own
      // threshold; the provider thread's last `getContextUsage` snapshot does. They describe
      // a window, so they are carried only onto a report of the same window, and the report's
      // own threshold, when it has one, wins.
      ...carriedCompactionFacts(providerThread?.contextUsage, maxTokens),
      ...(liveUsage.autoCompactThreshold != null
        ? { autoCompactThreshold: liveUsage.autoCompactThreshold }
        : {}),
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      // FORK: the threshold's provenance, carried for the Vitals gauge.
      autoCompactSource: providerUsage.autoCompactSource ?? null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.type !== "compaction") {
      continue;
    }
    const payload = entry.item;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      autoCompactSource: null,
      updatedAt: DateTime.formatIso(payload.startedAt ?? payload.updatedAt),
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * The auto-compaction marker on the context bar. Gated on a PRESENT non-`"auto"` source: the key is
 * undeclared in the SDK and missing from most snapshots, so `!== "auto"` would degrade open. The
 * threshold is an absolute count (window less a ~33k reserve), so it is labelled in tokens.
 */
export function deriveCompactionMarker(
  usage: ContextWindowSnapshot,
): { readonly pct: number; readonly label: string } | null {
  const { autoCompactThreshold, autoCompactSource, maxTokens } = usage;
  // `== null` covers both halves deliberately: the mapped type keeps each key
  // OPTIONAL as well as nullable, so every one of these is `T | null | undefined`.
  if (autoCompactSource == null || autoCompactSource === "auto") return null;
  if (autoCompactThreshold == null || autoCompactThreshold <= 0) return null;
  if (maxTokens == null || maxTokens <= 0) return null;
  if (autoCompactThreshold >= maxTokens) return null;
  return {
    pct: (autoCompactThreshold / maxTokens) * 100,
    label: `compacts at ${formatContextWindowTokens(autoCompactThreshold)}`,
  };
}
