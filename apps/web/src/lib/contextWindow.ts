import type {
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
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
 * Driver kinds that never report context-window usage, so their popover shows
 * a reason instead of an empty space where the context block would be.
 *
 * Measured against `cursor-agent 2026.08.25-3e8eec8`: a raw ACP client saw no
 * `usage_update` notification and a `session/prompt` result with no `usage`
 * member, and the ACP schema defines both — the agent simply does not send
 * them. Grok and OpenCode reach the UI the same way: `context-window.updated`
 * is projected only from `thread.token-usage.updated`, which only the Claude
 * and Codex adapters emit.
 *
 * This is deliberately keyed on the PROVIDER, not on the snapshot being
 * absent. A started Claude thread can have zero context activities too, and
 * telling that user their provider does not report usage would be false.
 */
/** Fallback only; the server now advertises this per instance. */
const PROVIDERS_WITHOUT_CONTEXT_USAGE = new Set(["cursor", "grok", "opencode"]);

/**
 * The one-line explanation for a missing context block, or `null` when the
 * provider does report usage (in which case an absent snapshot just means the
 * thread has not produced one yet, and the popover shows nothing).
 *
 * `provider` must be the driver the thread's SESSION ran on, not the model
 * picker's current selection — the picker moves without the thread following
 * it, and gating on it would blame Cursor for a thread that ran on Claude.
 */
export function describeMissingContextUsage(
  provider: string | null | undefined,
  /**
   * The provider's own answer, from `ServerProvider.reportsContextUsage`.
   * `undefined` means an older server that does not advertise the capability,
   * in which case the driver list below is the fallback.
   */
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

/** Prefers the provider's live usage report (#8144); falls back to the last compaction item. */
export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
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
      // FORK (invariant 12): the live report carries no compaction facts; the
      // provider thread's last `getContextUsage` snapshot does. They describe
      // a window, so they are carried only onto a report of the same window.
      ...carriedCompactionFacts(providerThread?.contextUsage, maxTokens),
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
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Where the auto-compaction marker sits on the context bar, and what to call it.
 *
 * Gated on the source being PRESENT and not `"auto"`, not merely `!== "auto"`.
 * Claude Code reports `"auto"` for the windows it refuses to compact, but
 * `autocompactSource` is absent from the SDK's declared response type and
 * survives only because the CLI's object carries an extra key — in live data
 * only 18 of 49 threshold-bearing snapshots have it. A `!== "auto"` test
 * therefore degrades OPEN, drawing "compacts at 967k" on a window that will
 * never compact. Absent means unknown, and unknown draws nothing.
 *
 * The threshold is an absolute count (the compaction window less a fixed
 * ~33,000-token reserve), not a fraction of anything, so it is labelled with
 * the token figure rather than a percentage that would not move proportionally.
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
