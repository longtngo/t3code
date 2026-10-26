import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProject, useThreadShell } from "~/state/entities";
import { resolveWorkspaceRepos, type WorkspaceRepo } from "./useWorkspaceRepos.logic";

export {
  isWorkspaceProject,
  PRIMARY_REPO_ID,
  resolveActiveRepo,
  type WorkspaceRepo,
  type WorkspaceRepoKind,
} from "./useWorkspaceRepos.logic";

/**
 * The repositories a thread can read, primary first. The single home of the derivation six
 * panels used to inline as `thread.worktreePath ?? project.workspaceRoot`; `repos[0]` is that.
 */
export function useWorkspaceRepos(threadRef: ScopedThreadRef | null): ReadonlyArray<WorkspaceRepo> {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread?.projectId ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  return useMemo(
    () =>
      resolveWorkspaceRepos({
        project,
        threadWorktreePath: thread?.worktreePath ?? null,
      }),
    [project, thread?.worktreePath],
  );
}
