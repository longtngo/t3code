import type { WorkspaceMember } from "@t3tools/contracts";

/**
 * The staging repository a thread runs in, or one of the project's attached
 * members. `primary` is whatever `thread.worktreePath ?? project.workspaceRoot`
 * resolved to before this existed, so single-repository projects are unchanged.
 */
export type WorkspaceRepoKind = "primary" | "member";

export interface WorkspaceRepo {
  /** `PRIMARY_REPO_ID` for the staging repository, the member id otherwise. */
  readonly id: string;
  readonly kind: WorkspaceRepoKind;
  readonly cwd: string;
  readonly title: string;
  /** Null for the primary repository, which has no declared integration branch. */
  readonly integrationBranch: string | null;
}

/**
 * Not a uuid, so it cannot collide with a member id, and stable across threads
 * so a stored selection survives switching between them.
 */
export const PRIMARY_REPO_ID = "primary";

export interface WorkspaceReposInput {
  readonly project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly members?: ReadonlyArray<WorkspaceMember>;
  } | null;
  readonly threadWorktreePath?: string | null;
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  const withoutTrailing = trimmed.replace(/[/\\]+$/, "");
  return withoutTrailing.length > 0 ? withoutTrailing : trimmed;
}

/**
 * The repositories a thread can read, primary first.
 *
 * Members whose path repeats one already in the list are dropped: the same
 * checkout appearing twice would run every query twice and render two groups
 * that can never disagree. Comparison is by trailing-separator-insensitive
 * string, which catches the spellings the attach UI can produce but not a
 * member written as `~/x` against a workspace root stored as `/Users/me/x` —
 * the server resolves those to the same directory, the client cannot.
 */
export function resolveWorkspaceRepos(input: WorkspaceReposInput): ReadonlyArray<WorkspaceRepo> {
  const { project } = input;
  if (project === null) return [];
  const primaryCwd = input.threadWorktreePath ?? project.workspaceRoot;
  const repos: Array<WorkspaceRepo> = [
    {
      id: PRIMARY_REPO_ID,
      kind: "primary",
      cwd: primaryCwd,
      title: project.title,
      integrationBranch: null,
    },
  ];
  const seen = new Set([normalizeCwd(primaryCwd)]);
  for (const member of project.members ?? []) {
    const normalized = normalizeCwd(member.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    repos.push({
      id: member.id,
      kind: "member",
      cwd: member.path,
      title: member.title,
      integrationBranch: member.integrationBranch,
    });
  }
  return repos;
}

/**
 * The repository a panel should show for a stored selection.
 *
 * Falling back to the primary repository rather than holding the stale id is
 * what lets a panel keep the selection in plain `useState`: switching threads
 * or detaching a member simply stops matching, and the panel lands on the
 * staging repository instead of rendering an empty view for a repository that
 * is no longer attached.
 */
export function resolveActiveRepo(
  repos: ReadonlyArray<WorkspaceRepo>,
  selectedId: string | null,
): WorkspaceRepo | null {
  if (repos.length === 0) return null;
  const selected = selectedId === null ? undefined : repos.find((repo) => repo.id === selectedId);
  return selected ?? repos[0] ?? null;
}

/** True once the project has at least one attached member worth showing UI for. */
export function isWorkspaceProject(repos: ReadonlyArray<WorkspaceRepo>): boolean {
  return repos.some((repo) => repo.kind === "member");
}

/**
 * The open file a panel should still show after the root changed under it.
 *
 * A path is relative to the repository it was opened from, so re-resolving
 * `app/Http/Kernel.php` under a different root usually finds nothing and reads
 * as an error the user did not cause. Switching roots parks the open path
 * instead; opening anything afterwards clears the park, which is why the
 * comparison is against the path itself rather than a boolean — a file opened
 * from elsewhere while a path is parked is a different path, and shows.
 */
export function resolveVisibleFilePath(
  openRelativePath: string | null,
  parkedPath: string | null,
): string | null {
  return openRelativePath !== null && openRelativePath === parkedPath ? null : openRelativePath;
}
