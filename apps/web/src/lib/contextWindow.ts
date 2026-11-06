// FORK: upstream moved the snapshot derivation to client-runtime's
// state/contextWindow.ts (the fork's carried compaction facts moved with it); the
// fork's display helpers for the Vitals gauge stay here.
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

export type { ContextWindowSnapshot };

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
