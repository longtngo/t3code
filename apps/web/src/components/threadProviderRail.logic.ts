import type { ProviderInstanceId } from "@t3tools/contracts";

import { normalizeProviderAccentColor } from "../providerInstances";

/**
 * Resolution for the per-thread provider indicator: which provider instance a thread is on, and
 * how that instance is presented. Kept pure so the rail component stays a thin renderer and the
 * precedence is unit-tested rather than inferred from the JSX.
 */

/** The minimum a thread must expose for its provider to be resolved. */
export interface ThreadProviderSource {
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly session: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
}

/**
 * The provider instance a thread is currently on.
 *
 * A live session's provider outranks the thread's stored selection: when a session is running,
 * the provider actually serving the thread is the truthful answer, and the two can differ (a
 * locked continuation keeps its original instance after the stored selection moves on). This
 * mirrors the composer's precedence so the rail and the composer never disagree.
 *
 * Total by construction — `modelSelection` is non-nullable on a thread shell and its `instanceId`
 * is required — so there is no "unknown provider" case to render.
 */
export function resolveThreadProviderInstanceId(thread: ThreadProviderSource): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

/** How a provider instance is drawn in the list: its accent, and the name that announces it. */
export interface ThreadProviderPresentation {
  readonly accentColor: string;
  readonly displayName: string;
}

/**
 * The fields the rail reads off a provider snapshot. Narrower than `ServerProvider` on purpose:
 * the resolver has no business knowing about auth, versions or probe state, and a structural
 * type keeps its tests to three fields instead of the full snapshot.
 */
export interface ThreadProviderAccentSource {
  readonly instanceId: ProviderInstanceId;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
}

/**
 * Presentation for a thread's provider, or `undefined` when the rail should not render.
 *
 * Absent whenever the instance is unknown to this environment or carries no valid accent: a
 * neutral bar on such rows would be visual weight conveying nothing. `normalizeProviderAccentColor`
 * rejects anything that is not a `#rrggbb` literal, so a malformed accent is treated as absent
 * rather than reaching the DOM as an invalid style.
 */
export function resolveThreadProviderPresentation(
  instanceId: ProviderInstanceId,
  providers: ReadonlyArray<ThreadProviderAccentSource>,
): ThreadProviderPresentation | undefined {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider) return undefined;
  const accentColor = normalizeProviderAccentColor(provider.accentColor);
  if (!accentColor) return undefined;
  return { accentColor, displayName: provider.displayName ?? instanceId };
}
