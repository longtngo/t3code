import type {
  EnvironmentId,
  ScopedThreadRef,
  WorkspaceMemberBranchReport,
} from "@t3tools/contracts";
import { GitBranchIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";
import { cn } from "~/lib/utils";
import { useEnvironmentSupportsLocalOnlyStatus, useThread } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

interface WorkspaceRepoBarProps {
  readonly environmentId: EnvironmentId;
  readonly repos: ReadonlyArray<WorkspaceRepo>;
  readonly selectedId: string;
  readonly onSelect: (repoId: string) => void;
  readonly threadRef: ScopedThreadRef;
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
  threadRef,
}: WorkspaceRepoBarProps) {
  const thread = useThread(threadRef);
  const projectId = thread?.projectId ?? null;
  const hasMembers = repos.some((repo) => repo.kind === "member");
  const branchesQuery = useEnvironmentQuery(
    hasMembers && projectId !== null
      ? vcsEnvironment.memberBranches({
          environmentId,
          input: { projectId, threadId: threadRef.threadId },
        })
      : null,
  );
  const reportsByMemberId = useMemo(() => {
    const entries = new Map<string, WorkspaceMemberBranchReport>();
    for (const report of branchesQuery.data?.reports ?? []) entries.set(report.memberId, report);
    return entries;
  }, [branchesQuery.data]);

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
          report={reportsByMemberId.get(repo.id) ?? null}
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
  report,
}: {
  readonly environmentId: EnvironmentId;
  readonly isSelected: boolean;
  readonly onSelect: (repoId: string) => void;
  readonly repo: WorkspaceRepo;
  readonly report: WorkspaceMemberBranchReport | null;
}) {
  // A server that does not honour `localOnly` drops the flag and starts a
  // remote poller for this subscription instead. Seven attached repositories
  // would then fetch seven remotes on a timer, which is the shape of the fetch
  // storm that once made this backend read as unresponsive — so against such a
  // server this tab shows no status rather than quietly paying for it.
  const supportsLocalOnlyStatus = useEnvironmentSupportsLocalOnlyStatus(environmentId);
  const statusQuery = useEnvironmentQuery(
    supportsLocalOnlyStatus
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: repo.cwd, localOnly: true },
        })
      : null,
  );
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshLocalStatus, {
    reportFailure: false,
  });
  // Nothing else recomputes a member's status: the file watchers and the
  // post-turn reactors all run against the thread's own working directory, and
  // the server's status cache has no expiry. Without this the first reading a
  // member ever produced would be the only one.
  useEffect(() => {
    if (!supportsLocalOnlyStatus) return;
    void refreshLocalStatus({ environmentId, input: { cwd: repo.cwd } });
  }, [environmentId, refreshLocalStatus, repo.cwd, supportsLocalOnlyStatus]);

  const status = statusQuery.data;
  const changedFileCount = status?.workingTree.files.length ?? 0;
  // A member parked on a branch other than the one it integrates into is
  // carrying work even when its working tree is clean, because that work is
  // already committed.
  const isOffIntegrationBranch =
    repo.integrationBranch !== null &&
    status?.refName != null &&
    status.refName !== repo.integrationBranch;
  const isUnavailable = report?.state === "unavailable";
  // One shared checkout per member means two threads writing to it cannot be
  // isolated. Showing whose branch it is on is the whole protection available.
  const isOwnedByOther = report?.state === "owned-by-other";

  return (
    <button
      aria-selected={isSelected}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        isSelected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        isUnavailable && "opacity-60",
      )}
      onClick={() => onSelect(repo.id)}
      role="tab"
      title={
        isUnavailable
          ? `${repo.cwd} — ${report?.detail ?? "unavailable"}`
          : isOwnedByOther
            ? `${repo.cwd} — on a branch another thread is working in`
            : repo.cwd
      }
      type="button"
    >
      <span className="min-w-0 max-w-40 truncate font-medium">{repo.title}</span>
      {isUnavailable ? <UnplugIcon aria-label="Unavailable" className="size-3 shrink-0" /> : null}
      {isOwnedByOther ? (
        <TriangleAlertIcon
          aria-label="Another thread is working in this repository"
          className="size-3 shrink-0 text-amber-500"
        />
      ) : null}
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
