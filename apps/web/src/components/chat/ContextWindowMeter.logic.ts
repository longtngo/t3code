// FORK: the ContextWindowMeter component itself is deleted here — the composer's
// Vitals gauge replaced it (see docs/fork/README.md invariant 4). Only the Claude
// resume-compaction helpers survive, because ChatView's compaction banner uses them
// and is independent of the meter. The filename is kept so upstream edits to these
// helpers keep merging instead of arriving as a modify/delete every reconcile.
// resolveContextWindowModelDisplayName / formatContextWindowCompactionMessage are
// deliberately absent: the first is reimplemented inline in ChatComposer.tsx, the
// second only ever served the deleted component.
import type { ProviderInstanceId } from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export const CLAUDE_RESUME_COMPACTION_MINUTES = 70;
export const CLAUDE_RESUME_COMPACTION_TOKENS = 100_000;

export function hasAvailableClaudeCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const claudeProviders = input.providers.filter(
    (provider) => provider.driverKind === "claudeAgent",
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? claudeProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? claudeProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : claudeProviders;

  return (
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined) !==
    undefined
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < CLAUDE_RESUME_COMPACTION_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= CLAUDE_RESUME_COMPACTION_MINUTES * 60_000
  );
}
