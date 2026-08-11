/**
 * Short-lived capability tokens that let a SANDBOXED viewer document load its own
 * relative assets.
 *
 * The problem this exists for: `/viewer` serves `.html` under a CSP `sandbox`
 * directive, which gives the document an **opaque origin**. An opaque-origin
 * document has a null "site for cookies", so the `SameSite=Lax` session cookie is
 * not sent on any subresource it requests — every relative `<script>`, `<link>`
 * and `<img>` 401s and a multi-file prototype renders blank. The document's own
 * navigation still authenticates (it inherits the top-level site), which is why an
 * inline script runs but an external one does not.
 *
 * Cookies cannot be recovered without giving up the sandbox, and giving up the
 * sandbox means untrusted HTML runs at the app's origin — it could read the
 * session from storage and act as the user. So the credential moves into the URL
 * **path**: a document served from `/viewer-asset/<token>/<dir>/index.html`
 * resolves `app.js` to `/viewer-asset/<token>/<dir>/app.js`, carrying the token
 * without the document doing anything. A query string would not survive relative
 * resolution; a path segment does.
 *
 * Deliberately NOT the session token. A token here grants read-only access to one
 * directory subtree for a few minutes, and the sandboxed document can read it out
 * of `document.location` — so it must be worth as little as possible. The document
 * can already read its own directory by fetching those files itself, so the token
 * mainly bounds what leaks if the document is hostile and exfiltrates it.
 *
 * @module viewerAssetTokens
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
