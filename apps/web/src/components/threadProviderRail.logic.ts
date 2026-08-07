import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import { normalizeProviderAccentColor } from "../providerInstances";
import { formatProviderDriverKindLabel } from "../providerModels";
import { providerInstanceInitials } from "./chat/ProviderInstanceIcon";

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
  /**
   * Short monogram, present *only* when this instance's accent is shared with another configured
   * instance. Colour is the primary channel; the monogram is the fallback for exactly the rows
   * where colour cannot decide, so it stays absent on every unambiguous row.
   */
  readonly initials?: string;
}

/**
 * The fields the rail reads off a provider snapshot. Narrower than `ServerProvider` on purpose:
 * the resolver has no business knowing about auth, versions or probe state, and a structural
 * type keeps its tests to three fields instead of the full snapshot.
 */
export interface ThreadProviderAccentSource {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
}

/**
 * Instance names are user-chosen and routinely NOT unique: naming the Claude and Codex instances
 * of one subscription both "PersonalSub" is a reasonable thing to do, and it makes the bare name
 * useless as an identifier. Qualify with the driver only when the name is actually shared, so the
 * common case stays "UniSub" rather than the noisier "UniSub (Claude)" everywhere.
 */
function qualifyDisplayName(
  provider: ThreadProviderAccentSource,
  providers: ReadonlyArray<ThreadProviderAccentSource>,
): string {
  const name = provider.displayName;
  if (!name) return provider.instanceId;
  const isShared = providers.some(
    (other) => other.instanceId !== provider.instanceId && other.displayName === name,
  );
  if (!isShared) return name;
  const driverLabel =
    PROVIDER_DISPLAY_NAMES[provider.driver] ?? formatProviderDriverKindLabel(provider.driver);
  return `${name} (${driverLabel})`;
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
  const displayName = qualifyDisplayName(provider, providers);
  // Initials come from the RAW name, never the driver-qualified one: initialling
  // "PersonalSub (Codex)" yields "P(" — the parenthesis is a word to the initialler. The
  // qualified form stays the human-readable label on the tooltip and the rail's aria-label.
  const initials = accentIsShared(provider, accentColor, providers)
    ? providerInstanceInitials(provider.displayName ?? provider.instanceId)
    : undefined;
  return { accentColor, displayName, ...(initials ? { initials } : {}) };
}

/**
 * Whether another configured instance draws in the same colour, making the rail alone ambiguous.
 *
 * Compared on the *normalized* accent so two spellings of one colour (`#EA580C` / `#ea580c`) count
 * as the collision they visually are. Disabled instances are included deliberately: they still own
 * existing threads, so their rows still render a rail the user has to tell apart.
 */
function accentIsShared(
  provider: ThreadProviderAccentSource,
  accentColor: string,
  providers: ReadonlyArray<ThreadProviderAccentSource>,
): boolean {
  return providers.some(
    (other) =>
      other.instanceId !== provider.instanceId &&
      normalizeProviderAccentColor(other.accentColor)?.toLowerCase() === accentColor.toLowerCase(),
  );
}
