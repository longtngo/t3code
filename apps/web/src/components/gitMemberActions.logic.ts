import type { WorkspaceMemberBranchReport, WorkspaceMemberPrBaseSource } from "@t3tools/contracts";

/**
 * Whether a git action may run against an attached repository, and why not.
 *
 * Members are shared long-lived checkouts, so the answer is about the state of
 * someone else's work rather than about permissions: a repository another
 * thread has already moved onto its own branch is the one case where running
 * here would quietly mix two efforts together.
 */
export type MemberActionGate =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly reason: string };

const ALLOWED: MemberActionGate = { kind: "allowed" };

export function gateMemberAction(
  report: Pick<WorkspaceMemberBranchReport, "state" | "branch" | "detail">,
  repositoryTitle: string,
): MemberActionGate {
  if (report.state === "unavailable") {
    return {
      kind: "blocked",
      reason: report.detail ?? `${repositoryTitle} could not be read.`,
    };
  }
  if (report.state === "owned-by-other") {
    return {
      kind: "blocked",
      reason:
        report.branch === null
          ? `${repositoryTitle} is on another thread's branch.`
          : `${repositoryTitle} is on ${report.branch}, which another thread is working on. Committing here would mix the two efforts together.`,
    };
  }
  return ALLOWED;
}

/**
 * How the pull-request base was arrived at, in the words the confirmation shows.
 *
 * The wording carries the confidence: only `configured` is a record of
 * something the user or T3 Code established, and the other two are inferences
 * that the user is being given the chance to correct.
 */
export function describePrBaseSource(source: WorkspaceMemberPrBaseSource): string {
  switch (source) {
    case "configured":
      return "Recorded for this branch";
    case "reflog":
      return "Where this branch was cut from";
    case "integration":
      return "This repository's integration branch";
  }
}

/**
 * Whether the confirmation's base is worth writing back.
 *
 * A base already recorded for this branch is skipped: rewriting the same value
 * is a no-op on disk and would make the write look like it carried new intent.
 */
export function shouldWritePrBase(input: {
  readonly confirmedBase: string;
  readonly resolvedBase: string;
  readonly source: WorkspaceMemberPrBaseSource;
}): boolean {
  const confirmed = input.confirmedBase.trim();
  if (confirmed.length === 0) return false;
  if (input.source === "configured" && confirmed === input.resolvedBase) return false;
  return true;
}
