import type { WorkspaceMember } from "@t3tools/contracts";

export interface NewWorkspaceMemberInput {
  readonly path: string;
  readonly integrationBranch: string;
}

/**
 * Rooted at `/` or at the user's home directory. `~` alone is the home
 * directory itself, which is never a sensible member, so only `~/…` passes.
 */
function isAbsoluteOrHomePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/");
}

/** Final path segment, ignoring a trailing separator. Used as the display title. */
export function memberTitleFromPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Null when the input is attachable; otherwise a message to show the user.
 *
 * This is a fast convenience check, NOT the security boundary: the server
 * re-resolves every member path through the same normalization it applies to a
 * project's workspace root, and rejects anything that does not exist or is not
 * a directory. Home-relative paths are accepted here because the server expands
 * `~` — rejecting them client-side turned away the form the design doc's own
 * examples use.
 */
export function validateNewMember(
  input: NewWorkspaceMemberInput,
  existing: ReadonlyArray<WorkspaceMember>,
): string | null {
  const path = input.path.trim();
  const branch = input.integrationBranch.trim();
  if (path.length === 0) return "Enter a repository path.";
  if (!isAbsoluteOrHomePath(path)) {
    return "Enter an absolute path, or one starting with ~/.";
  }
  if (branch.length === 0) return "Enter the branch this repository integrates into.";
  if (existing.some((member) => member.path === path)) {
    return "That repository is already attached.";
  }
  return null;
}

export function addMember(
  existing: ReadonlyArray<WorkspaceMember>,
  input: NewWorkspaceMemberInput & { readonly id: string },
): ReadonlyArray<WorkspaceMember> {
  const path = input.path.trim();
  return [
    ...existing,
    {
      id: input.id,
      path,
      title: memberTitleFromPath(path),
      integrationBranch: input.integrationBranch.trim(),
    },
  ];
}

export function removeMember(
  existing: ReadonlyArray<WorkspaceMember>,
  id: string,
): ReadonlyArray<WorkspaceMember> {
  return existing.some((member) => member.id === id)
    ? existing.filter((member) => member.id !== id)
    : existing;
}
