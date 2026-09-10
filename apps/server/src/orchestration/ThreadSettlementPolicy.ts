import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
// Re-exported, not redefined. The fork made `@t3tools/shared/queuedTurnStart`
// the single owner of this rule so the decider and the clients cannot drift;
// upstream's copy of the literal here is exactly that drift.
export { QUEUED_TURN_START_GRACE_MS } from "@t3tools/shared/queuedTurnStart";
import { QUEUED_TURN_START_GRACE_MS } from "@t3tools/shared/queuedTurnStart";

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value == null) continue;
    const valueMs = Date.parse(value);
    if (valueMs > latestMs) {
      latest = value;
      latestMs = valueMs;
    }
  }
  return latest;
}

/** A recent user message stays queued until a turn adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. */
export function threadHasQueuedTurnStart(
  thread: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const age = Date.parse(now) - messageAt;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((value) => value == null || Date.parse(value) < messageAt);
}

function pullRequestSettles(
  thread: Pick<OrchestrationThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchor = latestTimestamp([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
  ]);
  if (userAnchor === null) return false;
  const pullRequestAt = Date.parse(terminalAt);
  const userAnchorAt = Date.parse(userAnchor);
  if (Number.isNaN(pullRequestAt) || Number.isNaN(userAnchorAt)) return false;
  return pullRequestAt >= userAnchorAt;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationThreadShell;
  readonly pullRequest: SettlementPullRequest | null;
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): string | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = visibleThreadPullRequests(thread.pullRequests);
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return null;
  if (links.length > 0) {
    const terminalTimestamp = (link: (typeof links)[number]) => {
      const snapshot = link.snapshot;
      const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
      const timestamp = Date.parse(value ?? "");
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const latest = links.reduce((current, candidate) =>
      terminalTimestamp(candidate) > terminalTimestamp(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.now)) return null;
  const activityAt = latestTimestamp([
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]);
  if (pullRequest !== null) {
    if (pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
      return activityAt ?? thread.createdAt;
    }
  }
  if (input.autoSettleAfterDays === null || activityAt === null) return null;
  return Date.parse(activityAt) < Date.parse(input.now) - input.autoSettleAfterDays * DAY_MS
    ? activityAt
    : null;
}

/**
 * Whether anything is, or is about to be, working on this thread's behalf.
 *
 * `latestTurn.state === "running"` alone is not it: a thread whose last turn
 * completed can still have a background task writing into its checkout
 * (`backgroundLiveness`), a queued turn about to start, or a session starting.
 * Auto-settlement and the auto-pull guard both need the whole set, so it lives
 * here once rather than as two lists that drift apart.
 */
export function isThreadActive(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return true;
  if (thread.backgroundLiveness != null) return true;
  return threadHasQueuedTurnStart(thread, now);
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (isThreadActive(thread, now)) return false;
  if (thread.snoozedUntil == null || Date.parse(thread.snoozedUntil) <= Date.parse(now))
    return true;
  const wokeOnError =
    thread.session?.status === "error" &&
    (thread.snoozedAt == null ||
      Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt));
  const wokeOnCompletion =
    thread.snoozedAt != null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt != null &&
    Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt);
  return wokeOnError || wokeOnCompletion;
}
