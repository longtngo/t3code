/**
 * Path arithmetic for the directory listing shown when a file read turns out to
 * name a folder.
 *
 * Split out from the panels because the interesting part is not the rendering:
 * it is which root the listing hangs off, and whether a file picked out of it
 * still has a workspace-relative path.
 *
 * @module directoryListing.logic
 */

import { isAbsolutePath } from "@t3tools/shared/path";

/**
 * Whether a `filesystem.browse` success is actually a folder listing.
 *
 * A server older than `includeFiles` drops the unknown flag on decode and
 * answers with the legacy directories-only, kind-less listing — a well-formed
 * success that is indistinguishable from a real listing by shape alone. Taken
 * at face value it renders every subdirectory as a file and calls a folder
 * holding only files empty, so the server has to say it understood the ask.
 */
export function isDirectoryListing(
  result: { readonly listedFiles?: boolean | undefined } | null,
): boolean {
  return result?.listedFiles === true;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/**
 * The separator this path is already written with.
 *
 * A Windows cwd is `C:\Users\me\proj`; joining it with "/" builds
 * `C:\Users\me\proj/src`, which the containment test below then fails to
 * recognise as its own root. A path carrying "/" anywhere keeps "/", which is
 * also what a Windows path written `C:/Users/me/proj` wants.
 */
function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/**
 * Both separators folded to "/" so two paths can be compared.
 *
 * Character-for-character, so an offset into the normalized string is the same
 * offset into the original — which is how the relative path below keeps the
 * separators the platform actually gave it.
 */
function withForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Absolute path of the folder a failed read was aimed at: an absolute path as
 * given, a relative one joined under the panel's `cwd`.
 *
 * Never built from a path the server resolved: the
 * server realpaths, so a project under a symlinked root (`/tmp`, `/var`, a
 * linked home) would come back with a prefix that no longer matches `cwd`, and
 * every file picked out of the listing would lose its workspace-relative path.
 */
export function workspaceListingPath(cwd: string, relativePath: string): string {
  // The server reads an absolute path as one (a chat chip outside the project), so
  // the listing must name that same folder.
  if (isAbsolutePath(relativePath)) return relativePath;
  const root = trimTrailingSeparators(cwd);
  return `${root}${separatorOf(cwd)}${relativePath.replace(/^[/\\]+/, "")}`;
}

export type ListedFileTarget =
  | { readonly kind: "workspace"; readonly relativePath: string }
  | { readonly kind: "absolute"; readonly absolutePath: string };

/**
 * Where a file picked out of a listing should open.
 *
 * Inside the workspace it keeps its relative path and opens in the editable
 * panel; outside it there is no relative path and no write RPC, so it opens in
 * the read-only absolute viewer. A listing rooted outside the workspace can
 * still contain workspace files — a folder above the project — so this is a
 * containment test, not a property of the root.
 */
export function listedFileTarget(cwd: string, absolutePath: string): ListedFileTarget {
  // Compared with separators folded, sliced from the original: the relative
  // path that comes back out keeps whichever separator the platform uses.
  //
  // Case is NOT folded, even though Windows filesystems ignore it. The listing
  // this reads was requested with a path built from this same `cwd`, so the
  // server echoes the case it was given; folding here would instead risk
  // merging two genuinely different paths on a case-sensitive filesystem.
  const root = `${withForwardSlashes(trimTrailingSeparators(cwd))}/`;
  return withForwardSlashes(absolutePath).startsWith(root)
    ? { kind: "workspace", relativePath: absolutePath.slice(root.length) }
    : { kind: "absolute", absolutePath };
}
