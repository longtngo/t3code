import { type ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * Resolve which configured instance the composer is currently targeting.
 * Priority:
 *   1. The composer draft's `activeProvider` — the user's unsaved pick
 *      from the model picker (must win, otherwise the UI appears to
 *      ignore picker selections).
 *   2. The session's instance id (the thread's live provider binding).
 *   3. Thread's persisted model-selection instance id.
 *   4. Project default's instance id.
 *   5. First enabled entry matching the current driver kind.
 *   6. First enabled entry overall / default instance for the kind.
 *
 * A persisted id that is known but filtered out (disabled, wrong driver kind
 * under a provider lock, or outside the locked continuation group) is
 * skipped — targeting it would dispatch to an instance the composer can't
 * use. An id with no matching entry is kept verbatim: entries may simply not
 * have hydrated yet, and dropping the id there would discard a valid
 * persisted selection during startup.
 */
export function resolveSelectedComposerInstanceId(input: {
  readonly draftActiveProvider: string | null | undefined;
  readonly sessionInstanceId: string | null | undefined;
  readonly threadSelectionInstanceId: string | null | undefined;
  readonly projectDefaultInstanceId: string | null | undefined;
  readonly selectedProvider: ProviderDriverKind;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}): ProviderInstanceId {
  const candidates: Array<string | null | undefined> = [
    input.draftActiveProvider,
    input.sessionInstanceId,
    input.threadSelectionInstanceId,
    input.projectDefaultInstanceId,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = input.instanceEntries.find(
      (entry) => entry.instanceId === candidate && entry.enabled,
    );
    if (match) {
      // When locked to a specific driver kind, ignore persisted instance
      // ids from a different kind or continuation group.
      if (input.lockedProvider && match.driverKind !== input.lockedProvider) continue;
      if (
        input.lockedContinuationGroupKey &&
        match.continuationGroupKey !== input.lockedContinuationGroupKey
      ) {
        continue;
      }
      return match.instanceId;
    }
  }
  // Keep an id with no matching entry verbatim — entries may not have
  // hydrated yet. A *known* id only reaches this point because the loop above
  // filtered it (disabled, wrong kind, or wrong continuation group), so it
  // must fall through to the enabled fallbacks below instead.
  const explicitSelectedInstanceId = candidates.find((candidate) => candidate) ?? null;
  if (
    explicitSelectedInstanceId &&
    !input.instanceEntries.some((entry) => entry.instanceId === explicitSelectedInstanceId)
  ) {
    return ProviderInstanceId.make(explicitSelectedInstanceId);
  }
  const byKind = input.instanceEntries.find(
    (entry) =>
      entry.enabled &&
      entry.driverKind === input.selectedProvider &&
      (!input.lockedContinuationGroupKey ||
        entry.continuationGroupKey === input.lockedContinuationGroupKey),
  );
  if (byKind) return byKind.instanceId;
  // Under a provider lock, never auto-jump to anyEnabled: keep the explicit
  // selection so its disabled state surfaces loudly instead of silently
  // retargeting the thread's continuation at a different provider or account.
  if (input.lockedProvider && explicitSelectedInstanceId) {
    return ProviderInstanceId.make(explicitSelectedInstanceId);
  }
  const anyEnabled = input.instanceEntries.find((entry) => entry.enabled);
  const persisted = input.threadSelectionInstanceId ?? input.projectDefaultInstanceId;
  return (
    anyEnabled?.instanceId ??
    input.instanceEntries[0]?.instanceId ??
    ProviderInstanceId.make(persisted || "codex")
  );
}
