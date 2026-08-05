import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProject, useThread } from "~/state/entities";
import { resolveWorkspaceRepos, type WorkspaceRepo } from "./useWorkspaceRepos.logic";

export {
  isWorkspaceProject,
  PRIMARY_REPO_ID,
  resolveActiveRepo,
  resolveVisibleFilePath,
  type WorkspaceRepo,
  type WorkspaceRepoKind,
} from "./useWorkspaceRepos.logic";

/**
 * The repositories a thread can read, primary first.
 *
 * Panels derived their working directory from
 * `thread.worktreePath ?? project.workspaceRoot` in six separate places, each
 * of which would have needed the members list bolted on independently. This is
 * the one place that derivation lives now; `repos[0]` is exactly what those
 * expressions produced.
 */
export function useWorkspaceRepos(threadRef: ScopedThreadRef | null): ReadonlyArray<WorkspaceRepo> {
  const thread = useThread(threadRef);
  const project = useProject(
    thread?.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
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
