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
 * URL of the server's raw `/viewer` route for an absolute path — the byte source
 * behind `<img>` and the rendered-HTML `<iframe>`.
 *
 * Built against the ENVIRONMENT's http base url, never `window.location.origin`.
 * An origin-relative URL always points at whichever server served the app, which
 * for a remote environment is the wrong machine: it would 404, or silently serve a
 * same-named local file. It is also what makes this work on packaged desktop
 * (renderer origin is `t3code://app`) and in dev (Vite does not proxy `/viewer`).
 *
 * Each segment is encoded separately so a path containing a space, `#` or `%`
 * survives, while the separators stay real separators.
 *
 * The `raw=1` marker is load-bearing, not decoration. `/viewer` is deliberately
 * absent from the PWA's `navigateFallbackDenylist` so a top-level "Open in new tab"
 * gets the app shell — but an `<iframe src>` is *also* a `mode: "navigate"` request,
 * so without a marker the service worker would answer the frame with `index.html`
 * and render the app inside the viewer. The denylist matches `pathname + search`
 * (workbox `NavigationRoute._match`), so this marker sends the frame to the network.
 * An `<img>` is `mode: "no-cors"` and was never at risk; it carries the marker only
 * so both raw reads look the same on the wire. The server classifies on `pathname`
 * alone, so the query is inert there.
 */
export function viewerHttpUrl(baseUrl: string | null, absolutePath: string | null): string | null {
  if (baseUrl === null || absolutePath === null || !absolutePath.startsWith("/")) return null;
  const encoded = absolutePath.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/viewer${encoded}?raw=1`;
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
