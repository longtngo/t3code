import type { WorkspaceMember } from "@t3tools/contracts";

export interface WorkspaceMemberDraft {
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

/**
 * Strips trailing separators so `~/src/uni/x` and `~/src/uni/x/` are one path.
 *
 * This is not cosmetic. The path picker browses by appending a separator to the
 * folder you click, so the field holds the trailing form every time a path is
 * chosen by clicking rather than typing. Storing that form unchanged would let
 * the same repository be attached twice — `validateMemberDraft`'s duplicate
 * check compares paths as strings — and would leave two members whose titles
 * and git state are identical.
 */
export function normalizeMemberPath(path: string): string {
  const trimmed = path.trim();
  const withoutTrailing = trimmed.replace(/[/\\]+$/, "");
  if (withoutTrailing.length > 0) return withoutTrailing;
  // Nothing but separators: the filesystem root, which keeps its separator.
  return trimmed.length > 0 ? "/" : "";
}

/**
 * The path to run git against, or null while the field cannot name a directory.
 *
 * Gating the branch query on this keeps it from firing for every character of a
 * half-typed path, and the branch picker uses null to explain itself ("choose a
 * repository first") instead of showing an empty list with no reason.
 */
export function resolveMemberCwd(path: string): string | null {
  const normalized = normalizeMemberPath(path);
  return normalized.length > 0 && isAbsoluteOrHomePath(normalized) ? normalized : null;
}

/** Final path segment, ignoring a trailing separator. Used as the display title. */
export function memberTitleFromPath(path: string): string {
  const segments = normalizeMemberPath(path)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Splits a path into the leading directories and the final segment so a column
 * of members can dim the shared prefix and show the repository name at full
 * contrast — in the motivating workspace every member sits under the same
 * parent, so the final segment carries all of the information.
 */
export function splitMemberPath(path: string): { readonly parent: string; readonly name: string } {
  const normalized = normalizeMemberPath(path);
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index < 0) return { parent: "", name: normalized };
  return { parent: normalized.slice(0, index + 1), name: normalized.slice(index + 1) };
}

/**
 * Null when the draft is attachable; otherwise a message to show the user.
 *
 * `editingId` excludes a member from the duplicate check so that re-saving an
 * existing entry without changing its path is not rejected as a duplicate of
 * itself.
 *
 * This is a fast convenience check, NOT the security boundary: the server
 * re-resolves every member path through the same normalization it applies to a
 * project's workspace root, and rejects anything that does not exist or is not
 * a directory. Home-relative paths are accepted here because the server expands
 * `~` — rejecting them client-side turned away the form the design doc's own
 * examples use.
 */
export function validateMemberDraft(
  draft: WorkspaceMemberDraft,
  existing: ReadonlyArray<WorkspaceMember>,
  editingId?: string,
): string | null {
  const path = normalizeMemberPath(draft.path);
  const branch = draft.integrationBranch.trim();
  if (path.length === 0) return "Enter a repository path.";
  if (!isAbsoluteOrHomePath(path)) {
    return "Enter an absolute path, or one starting with ~/.";
  }
  if (branch.length === 0) return "Enter the branch this repository integrates into.";
  if (
    existing.some((member) => member.id !== editingId && normalizeMemberPath(member.path) === path)
  ) {
    return "That repository is already attached.";
  }
  return null;
}

export function addMember(
  existing: ReadonlyArray<WorkspaceMember>,
  input: WorkspaceMemberDraft & { readonly id: string },
): ReadonlyArray<WorkspaceMember> {
  const path = normalizeMemberPath(input.path);
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

/**
 * Replaces one member's path and branch, re-deriving the title from the new
 * path so an edited entry cannot keep a title belonging to its old location.
 */
export function updateMember(
  existing: ReadonlyArray<WorkspaceMember>,
  id: string,
  draft: WorkspaceMemberDraft,
): ReadonlyArray<WorkspaceMember> {
  const path = normalizeMemberPath(draft.path);
  return existing.map((member) =>
    member.id === id
      ? {
          id: member.id,
          path,
          title: memberTitleFromPath(path),
          integrationBranch: draft.integrationBranch.trim(),
        }
      : member,
  );
}

export function removeMember(
  existing: ReadonlyArray<WorkspaceMember>,
  id: string,
): ReadonlyArray<WorkspaceMember> {
  return existing.some((member) => member.id === id)
    ? existing.filter((member) => member.id !== id)
    : existing;
}

/**
 * The branch names to offer for what is currently in the field.
 *
 * Filtering applies only to a partial name still being typed. Once the field
 * holds a real branch — which it does immediately after an autofill — reopening
 * the list must offer every branch, or the control could show you nothing but
 * the branch you already had and leave no way to change it.
 *
 * A name that matches nothing is still returned last, because an integration
 * branch does not have to exist yet.
 */
export function resolveBranchOptions(
  refNames: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || refNames.includes(trimmed)) return refNames;
  const lowered = trimmed.toLowerCase();
  const matches = refNames.filter((name) => name.toLowerCase().includes(lowered));
  return [...matches, trimmed];
}

/**
 * Whether picking a repository may overwrite the branch field with that
 * repository's checked-out branch.
 *
 * Across the six repositories this feature was built for, the checked-out
 * branch was the integration branch every time, so filling it turns the common
 * case into a confirmation instead of a second lookup. It stays safe by only
 * writing over a field the user has not typed into: either empty, or still
 * holding the value a previous autofill put there.
 */
export function canAutofillBranch(branchValue: string, autofilledValue: string | null): boolean {
  return branchValue.trim().length === 0 || branchValue === autofilledValue;
}

/**
 * The one-line explanation under the branch field.
 *
 * Every state answers, including "still reading". An earlier version returned
 * nothing while the branch query was in flight, which read as *no element* — and
 * since the dialog is vertically centred, losing that line moved the whole modal
 * by half its height and moved it back a frame later. Once per keystroke, that
 * is the flicker.
 *
 * The caller renders the returned value in a slot that reserves a line even when
 * this is null, so no state can collapse the layout.
 */
export function resolveBranchHint(input: {
  /** The resolved repository directory, or null while the path is unusable. */
  readonly branchCwd: string | null;
  /** False while the branch query has not answered for the current directory. */
  readonly hasRefsAnswer: boolean;
  readonly isRepository: boolean;
  readonly currentBranch: string | null;
  readonly branch: string;
}): string | null {
  if (input.branchCwd === null) return "Choose a repository to list its branches.";
  if (!input.hasRefsAnswer) return "Reading branches…";
  if (!input.isRepository) return "That folder is not a git repository.";
  if (input.currentBranch !== null && input.branch.trim() === input.currentBranch) {
    return `${input.currentBranch} is checked out in that repository.`;
  }
  return null;
}
