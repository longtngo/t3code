import type { WorkspaceMember } from "@t3tools/contracts";

export interface NewWorkspaceMemberInput {
  readonly path: string;
  readonly integrationBranch: string;
}

/** Final path segment, ignoring a trailing separator. Used as the display title. */
export function memberTitleFromPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Null when the input is attachable; otherwise a message to show the user. */
export function validateNewMember(
  input: NewWorkspaceMemberInput,
  existing: ReadonlyArray<WorkspaceMember>,
): string | null {
  const path = input.path.trim();
  const branch = input.integrationBranch.trim();
  if (path.length === 0) return "Enter a repository path.";
  if (!path.startsWith("/")) return "Enter an absolute path.";
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
