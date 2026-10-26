/**
 * Path arithmetic for the directory listing shown when a file read names a folder: which root
 * the listing hangs off, and whether a file picked from it keeps a workspace-relative path.
 *
 * @module directoryListing.logic
 */

import { isAbsolutePath } from "@t3tools/shared/path";

/**
 * Whether a `filesystem.browse` success is actually a folder listing. A server older than
 * `includeFiles` drops the flag and answers with the legacy directories-only listing, which is
 * well-formed but wrong, so the server has to say it understood the ask.
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
 * The separator this path is already written with. Joining `C:\Users\me\proj` with "/" breaks
 * the containment test below; a path carrying "/" anywhere keeps "/" (as `C:/Users/...` wants).
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
 * Absolute path of the folder a failed read was aimed at: absolute as given, relative joined
 * under `cwd`. Never built from a server-resolved path: the server realpaths, so a project
 * under a symlinked root would lose every listed file's workspace-relative path.
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
 * Where a file picked out of a listing should open: inside the workspace in the editable panel,
 * outside it in the read-only absolute viewer. A listing rooted outside can still contain
 * workspace files, so this is a containment test, not a property of the root.
 */
export function listedFileTarget(cwd: string, absolutePath: string): ListedFileTarget {
  // Compared with separators folded, sliced from the original so the platform's separator
  // survives. Case is NOT folded: the server echoes the case of the `cwd`-built request, and
  // folding could merge two different paths on a case-sensitive filesystem.
  const root = `${withForwardSlashes(trimTrailingSeparators(cwd))}/`;
  return withForwardSlashes(absolutePath).startsWith(root)
    ? { kind: "workspace", relativePath: absolutePath.slice(root.length) }
    : { kind: "absolute", absolutePath };
}
