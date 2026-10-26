// @effect-diagnostics nodeBuiltinImport:off - token minting is synchronous on the request path.
/**
 * Short-lived tokens letting a sandboxed `/viewer` document load relative assets: its opaque origin
 * gets no session cookie, so they 401. The token rides in the URL PATH, which relative resolution
 * preserves (a query string would not). Never the session token: the document can read it, so it
 * grants only read access to one directory subtree for a few minutes.
 */
import * as NodeCrypto from "node:crypto";

/** Long enough that guessing is hopeless; short enough to keep URLs readable. */
const TOKEN_BYTES = 16;
/**
 * Minutes, not hours. The token only has to outlive one document's asset loads,
 * and a page left open re-mints on reload.
 */
export const VIEWER_ASSET_TOKEN_TTL_MS = 10 * 60 * 1000;
/**
 * Bounds the store against a caller that opens many documents. Tokens are tiny and
 * expire on their own; this only stops unbounded growth between prunes.
 */
const MAX_TOKENS = 512;

interface ViewerAssetGrant {
  /** Absolute directory the token authorizes, subtree included. */
  readonly directory: string;
  readonly expiresAtMs: number;
}

const grants = new Map<string, ViewerAssetGrant>();

function prune(nowMs: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAtMs <= nowMs) grants.delete(token);
  }
  // Insertion-ordered, so the oldest survivors go first if still over budget.
  while (grants.size > MAX_TOKENS) {
    const oldest = grants.keys().next();
    if (oldest.done) break;
    grants.delete(oldest.value);
  }
}

/** Mint a token authorizing reads under `directory`. */
export function mintViewerAssetToken(directory: string, nowMs: number): string {
  prune(nowMs);
  const token = NodeCrypto.randomBytes(TOKEN_BYTES).toString("hex");
  grants.set(token, { directory, expiresAtMs: nowMs + VIEWER_ASSET_TOKEN_TTL_MS });
  return token;
}

/** The directory a token authorizes, or null when unknown or expired. */
export function resolveViewerAssetGrant(token: string, nowMs: number): string | null {
  const grant = grants.get(token);
  if (!grant) return null;
  if (grant.expiresAtMs <= nowMs) {
    grants.delete(token);
    return null;
  }
  return grant.directory;
}

/**
 * Split `/viewer-asset/<token>/<absolute path>` into its parts.
 *
 * Pure string logic so the route's containment decision is unit-testable without a
 * filesystem. Returns null for a malformed suffix, a relative target, or a NUL
 * byte (which makes Node's path APIs throw rather than fail).
 */
export function parseViewerAssetSuffix(
  encodedSuffix: string,
): { readonly token: string; readonly absolutePath: string } | null {
  const withoutLeadingSlash = encodedSuffix.replace(/^\/+/, "");
  const separatorIndex = withoutLeadingSlash.indexOf("/");
  if (separatorIndex <= 0) return null;
  const token = withoutLeadingSlash.slice(0, separatorIndex);
  if (!/^[a-f0-9]+$/.test(token)) return null;

  let absolutePath: string;
  try {
    absolutePath = decodeURIComponent(withoutLeadingSlash.slice(separatorIndex));
  } catch {
    return null;
  }
  if (!absolutePath.startsWith("/") || absolutePath.includes("\0")) return null;
  return { token, absolutePath };
}

/**
 * Whether a resolved path lies inside the granted directory.
 *
 * Callers MUST pass realpath-resolved values: comparing unresolved paths would let
 * a symlink inside the directory point anywhere on disk. The trailing separator
 * matters — without it `/a/bees` would count as inside `/a/bee`.
 */
export function isWithinGrantedDirectory(directory: string, resolvedPath: string): boolean {
  if (resolvedPath === directory) return true;
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return resolvedPath.startsWith(prefix);
}

/** Test seam: drop all grants. */
export function resetViewerAssetTokens(): void {
  grants.clear();
}
