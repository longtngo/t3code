import type { EnvironmentId } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useEffect } from "react";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

interface WorkspaceRepoBarProps {
  readonly environmentId: EnvironmentId;
  readonly repos: ReadonlyArray<WorkspaceRepo>;
  readonly selectedId: string;
  readonly onSelect: (repoId: string) => void;
  readonly className?: string;
}

/**
 * Picks which of a project's repositories a panel is looking at.
 *
 * Renders nothing for an ordinary project: with only the workspace root there
 * is nothing to choose between, and a one-entry selector is noise.
 */
export default function WorkspaceRepoBar({
  className,
  environmentId,
  onSelect,
  repos,
  selectedId,
}: WorkspaceRepoBarProps) {
  if (repos.length < 2) return null;
  return (
    <div
      aria-label="Workspace repositories"
      className={cn(
        "flex shrink-0 items-center gap-1 overflow-x-auto border-border/70 border-b px-2 py-1.5",
        className,
      )}
      role="tablist"
    >
      {repos.map((repo) => (
        <WorkspaceRepoTab
          environmentId={environmentId}
          isSelected={repo.id === selectedId}
          key={repo.id}
          onSelect={onSelect}
          repo={repo}
        />
      ))}
    </div>
  );
}

/**
 * One repository's tab, which owns its own status subscription.
 *
 * Subscribing per tab rather than lifting every repository's status into the
 * bar keeps this a fixed number of hooks per component — React forbids the
 * loop the lifted version would need — and means a repository stops being
 * watched the moment it leaves the list.
 *
 * The subscription is local-only. Ahead/behind counts and pull request state
 * reach the network, and the panel already subscribes to the full status of
 * whichever repository is selected.
 */
function WorkspaceRepoTab({
  environmentId,
  isSelected,
  onSelect,
  repo,
}: {
  readonly environmentId: EnvironmentId;
  readonly isSelected: boolean;
  readonly onSelect: (repoId: string) => void;
  readonly repo: WorkspaceRepo;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd: repo.cwd, localOnly: true },
    }),
  );
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshLocalStatus, {
    reportFailure: false,
  });
  // Nothing else recomputes a member's status: the file watchers and the
  // post-turn reactors all run against the thread's own working directory, and
  // the server's status cache has no expiry. Without this the first reading a
  // member ever produced would be the only one.
  useEffect(() => {
    void refreshLocalStatus({ environmentId, input: { cwd: repo.cwd } });
  }, [environmentId, refreshLocalStatus, repo.cwd]);
  const status = statusQuery.data;
  const changedFileCount = status?.workingTree.files.length ?? 0;
  // A member parked on a branch other than the one it integrates into is
  // carrying work even when its working tree is clean, because that work is
  // already committed. Local status is the only thing read here, so this is
  // the one signal available for it.
  const isOffIntegrationBranch =
    repo.integrationBranch !== null &&
    status?.refName != null &&
    status.refName !== repo.integrationBranch;

  return (
    <button
      aria-selected={isSelected}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        isSelected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={() => onSelect(repo.id)}
      role="tab"
      title={repo.cwd}
      type="button"
    >
      <span className="min-w-0 max-w-40 truncate font-medium">{repo.title}</span>
      {isOffIntegrationBranch && status?.refName ? (
        <span className="flex min-w-0 items-center gap-0.5 text-[11px] opacity-70">
          <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 max-w-28 truncate">{status.refName}</span>
        </span>
      ) : null}
      {changedFileCount > 0 ? (
        <span
          aria-label={`${changedFileCount} changed ${changedFileCount === 1 ? "file" : "files"}`}
          className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums"
        >
          {changedFileCount}
        </span>
      ) : null}
    </button>
  );
}
