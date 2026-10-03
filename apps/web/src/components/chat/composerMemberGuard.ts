import type { WorkspaceMemberBranchReport } from "@t3tools/contracts";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";

/**
 * A member repository sitting on a branch some other thread cut.
 *
 * See docs/design/2026-08-04-multi-repo-workspace-design.md, "The guard runs
 * pre-turn". One shared checkout per member means two threads writing to the
 * same repository cannot be isolated — this warning is the whole protection
 * available, so it has to reach the user *before* they send rather than in the
 * post-turn log where the damage is already done.
 */
export interface ContestedMember {
  readonly memberId: string;
  /** The repository's title as the project lists it. */
  readonly title: string;
  readonly branch: string;
}

/** Last path segment, for a report whose repository the list has dropped. */
function basenameOf(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const name = separator < 0 ? normalized : normalized.slice(separator + 1);
  return name.length > 0 ? name : path;
}

/**
 * The member repositories a turn would write into behind another thread's back.
 *
 * Only `owned-by-other` qualifies. `unmanaged` is a checkout the user pinned by
 * hand, `owned-by-self` is this thread's own branch, and `unavailable` is
 * already visible as an unplug icon on the repository bar — none of them are a
 * reason to interrupt someone who is typing.
 *
 * The server reports on every member the project lists, while the repository
 * list drops members whose path collides with the primary checkout or with an
 * earlier member. A report with no matching repository therefore falls back to
 * the path's last segment rather than being dropped: the two lists are built by
 * different rules, and a divergence between them has to fail loudly here rather
 * than turn into silence.
 */
export function selectContestedMembers(input: {
  readonly reports: ReadonlyArray<WorkspaceMemberBranchReport>;
  readonly repos: ReadonlyArray<WorkspaceRepo>;
  /** Paths by member id, so a dropped repository can still be named. */
  readonly pathsByMemberId?: ReadonlyMap<string, string>;
}): ReadonlyArray<ContestedMember> {
  const titlesById = new Map(input.repos.map((repo) => [repo.id, repo.title]));
  const contested: ContestedMember[] = [];
  for (const report of input.reports) {
    if (report.state !== "owned-by-other") continue;
    // `branch` is what makes the warning actionable, and a report without one
    // cannot be `owned-by-other` in the first place — the classifier reads
    // ownership off the branch it is on.
    if (report.branch === null) continue;
    const path = input.pathsByMemberId?.get(report.memberId);
    const title =
      titlesById.get(report.memberId) ?? (path === undefined ? report.memberId : basenameOf(path));
    contested.push({ memberId: report.memberId, title, branch: report.branch });
  }
  return contested;
}

/**
 * Identity of one repository's warning, for remembering that the user
 * dismissed *it*.
 *
 * Per member rather than per warning. Keying on the whole set means resolving
 * one repository re-raises a warning about the others the user dismissed a
 * moment ago, because the set — and so the key — changed.
 *
 * The branch is part of the key: a repository that later moves onto a
 * *different* thread's branch is a new fact the user has not seen. So is the
 * thread, because `owned-by-other` is a claim about some *other* thread, which
 * makes the same repository on the same branch a fresh warning to everyone but
 * its owner.
 */
export function contestedMemberKey(threadId: string, member: ContestedMember): string {
  return `${threadId}:${member.memberId}@${member.branch}`;
}

// Session-scoped and module-level so it survives ChatView remounts, matching
// the branch-mismatch banner next to it. Its own set rather than a shared one:
// these keys are built from different parts and must not be able to collide.
const sessionDismissedContestedKeys = new Set<string>();

export function dismissContestedMembersForSession(
  threadId: string,
  members: ReadonlyArray<ContestedMember>,
): void {
  for (const member of members) {
    sessionDismissedContestedKeys.add(contestedMemberKey(threadId, member));
  }
}

export function withoutDismissedContestedMembers(
  threadId: string | null,
  members: ReadonlyArray<ContestedMember>,
): ReadonlyArray<ContestedMember> {
  if (threadId === null) return [];
  return members.filter(
    (member) => !sessionDismissedContestedKeys.has(contestedMemberKey(threadId, member)),
  );
}

/** Stable identity for the banner, and for its reveal hysteresis. */
export function contestedMembersKey(
  threadId: string | null,
  members: ReadonlyArray<ContestedMember>,
): string | null {
  if (threadId === null || members.length === 0) return null;
  return members
    .map((member) => contestedMemberKey(threadId, member))
    .sort()
    .join(",");
}

/**
 * What the guard knows right now.
 *
 * `unknown` exists because the alternative is the exact failure this feature
 * was built around: a check that could not run reading as a check that came
 * back clean. An unanswered query, a disconnected environment and "nothing to
 * warn about" are three different facts, and only the last earns silence.
 */
export type MemberGuardUnknownReason = "checking" | "offline" | "failed";

export type MemberGuardState =
  | { readonly kind: "silent" }
  | { readonly kind: "unknown"; readonly reason: MemberGuardUnknownReason }
  | { readonly kind: "contested" };

export function resolveMemberGuardState(input: {
  readonly hasMembers: boolean;
  /** Whether the query has produced a result at least once. */
  readonly hasAnswer: boolean;
  readonly hasError: boolean;
  readonly isEnvironmentUnavailable: boolean;
  readonly contested: ReadonlyArray<ContestedMember>;
}): MemberGuardState {
  if (!input.hasMembers) return { kind: "silent" };
  // A stale answer naming a contested repository still beats saying nothing, so
  // a live warning outranks a failed refresh.
  if (input.contested.length > 0) return { kind: "contested" };
  if (input.hasError) return { kind: "unknown", reason: "failed" };
  if (input.hasAnswer) return { kind: "silent" };
  return { kind: "unknown", reason: input.isEnvironmentUnavailable ? "offline" : "checking" };
}

export function describeUnknownMemberGuard(reason: MemberGuardUnknownReason): string {
  if (reason === "checking") return "Checking the attached repositories...";
  if (reason === "offline") return "Can't check the attached repositories while disconnected.";
  return "Couldn't check the attached repositories.";
}

/**
 * What the banner says.
 *
 * The single-repository case comes back in parts so the branch name can be set
 * as code and truncated the way the branch-mismatch banner beside it sets its
 * own — `memberFeatureBranchName` builds these from the owning thread's title,
 * so they run long. Several repositories get named up to a point and then
 * counted: the composer is not the place to list seven of them, and the
 * repository bar in the Diff and Files panels marks every one.
 */
const MAX_NAMED_REPOS = 2;

export type ContestedMembersCopy =
  | {
      readonly kind: "one";
      readonly title: string;
      readonly beforeBranch: string;
      readonly branch: string;
      readonly afterBranch: string;
    }
  | { readonly kind: "many"; readonly title: string; readonly description: string };

export function describeContestedMembers(
  members: ReadonlyArray<ContestedMember>,
): ContestedMembersCopy | null {
  const first = members[0];
  if (first === undefined) return null;
  if (members.length === 1) {
    return {
      kind: "one",
      title: `${first.title} is on another thread's branch`,
      beforeBranch: "It is on ",
      branch: first.branch,
      afterBranch:
        ". Anything you send now is written there, on that branch, mixed in with the other thread's work.",
    };
  }
  const named = members.slice(0, MAX_NAMED_REPOS).map((member) => member.title);
  const remaining = members.length - named.length;
  const list = remaining > 0 ? `${named.join(", ")} and ${remaining} more` : named.join(" and ");
  return {
    kind: "many",
    title: `${members.length} repositories are on other threads' branches`,
    description: `${list} are on branches other threads are working in. Anything you send now is written there, mixed in with that work.`,
  };
}
