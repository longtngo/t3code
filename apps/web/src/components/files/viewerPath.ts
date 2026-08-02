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
