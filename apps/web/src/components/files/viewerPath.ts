/**
 * Pure path helpers for the standalone `/viewer/$` route. TanStack Router's
 * splat param (`_splat`) is the URL-decoded path *after* `/viewer/`, with the
 * leading slash consumed by the route prefix — so an absolute path like
 * `/Users/foo/x.md` arrives as `Users/foo/x.md`. These helpers convert between
 * that splat form and the absolute path the trusted-read RPC expects.
 */

/** Rebuild the absolute path from the router splat, or null when there is none. */
export function absolutePathFromViewerSplat(splat: string | undefined | null): string | null {
  if (!splat) return null;
  const trimmed = splat.replace(/^\/+/, "");
  if (trimmed.length === 0) return null;
  return `/${trimmed}`;
}

/**
 * Normalize a user-typed path into the splat form for `navigate({ params })`.
 * Trims whitespace, drops a `file://` scheme, and requires an absolute path
 * (the trusted read rejects anything not under an allowed root, and relative
 * paths cannot be resolved without a workspace cwd). Returns null when invalid.
 */
export function viewerSplatFromPath(rawPath: string): string | null {
  const cleaned = rawPath.trim().replace(/^file:\/\//, "");
  if (!cleaned.startsWith("/")) return null;
  return cleaned.replace(/^\/+/, "");
}

/**
 * What the address bar should do when an edit ends.
 *
 * Enter, focus loss and Escape all end an edit through the same blur, so this
 * is the single place that decides between them. Kept out of the component
 * because the decision is the part worth pinning: submitting an unchanged path
 * re-navigates to where the user already is, and submitting an emptied field
 * would ask the viewer to open nothing.
 */
export function resolveAddressBarCommit(input: {
  /** What the field currently holds. */
  readonly draft: string;
  /** The path actually loaded, which the field reverts to. */
  readonly value: string;
  /** Set by Escape, so the blur it triggers abandons the edit. */
  readonly reverting: boolean;
}): { readonly kind: "revert" } | { readonly kind: "submit"; readonly path: string } {
  const next = input.draft.trim();
  if (input.reverting || next.length === 0 || next === input.value) return { kind: "revert" };
  return { kind: "submit", path: next };
}

/**
 * Whether a submitted path should move the viewer, and to which splat.
 *
 * Null for a path the route cannot express and for the path already open —
 * navigating to the current location pushes a history entry that goes nowhere.
 */
export function resolveViewerNavigation(
  rawPath: string,
  currentSplat: string | undefined,
): string | null {
  const nextSplat = viewerSplatFromPath(rawPath);
  if (nextSplat === null || nextSplat === currentSplat) return null;
  return nextSplat;
}
