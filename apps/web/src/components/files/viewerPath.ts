/**
 * Path helpers for the `/viewer/$` route. `_splat` is the decoded path after `/viewer/` with
 * the leading slash consumed, so `/Users/foo/x.md` arrives as `Users/foo/x.md`; these convert
 * between that form and the absolute path the trusted-read RPC expects.
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
 * Whether a router pathname is the standalone viewer route.
 *
 * Matches `/viewer` and `/viewer/<absolute path>` but NOT a route that merely
 * starts with those characters (`/viewerish`), so the prefix test cannot capture a
 * future sibling route.
 */
export function isViewerRoutePath(pathname: string): boolean {
  return pathname === "/viewer" || pathname.startsWith("/viewer/");
}

/**
 * URL of the server's raw `/viewer` route for an absolute path. Built on the ENVIRONMENT's base
 * url, never `window.location.origin` (the wrong machine for a remote environment; also breaks
 * packaged desktop and dev). Segments are encoded one by one. `raw=1` is load-bearing: an
 * `<iframe src>` is a navigate request, and without it the service worker serves the app shell.
 */
export function viewerHttpUrl(baseUrl: string | null, absolutePath: string | null): string | null {
  if (baseUrl === null || absolutePath === null || !absolutePath.startsWith("/")) return null;
  const encoded = absolutePath.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/viewer${encoded}?raw=1`;
}

/**
 * What the address bar should do when an edit ends. Enter, focus loss and Escape all end
 * through the same blur, so this decides between them: an unchanged path must not
 * re-navigate, and an emptied field must not ask the viewer to open nothing.
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
