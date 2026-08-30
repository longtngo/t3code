/**
 * The failure details that mean "this pending request is gone".
 *
 * A provider answers `respond.failed` when the approval or user-input request it
 * was asked about no longer exists on its side. Orchestration must then clear the
 * request, or the thread keeps a blocking request that nothing can resolve: the
 * decider refuses to settle it and the shell shows an approval the user can never
 * answer.
 *
 * Three places decide this independently, and the decider's own comment requires
 * them to agree. They did not: Codex names itself in its message
 * (`Unknown pending Codex approval request: ...`, CodexSessionRuntime.ts), which
 * ProviderCommandReactor matched and the decider and projector did not - so a
 * Codex approval that went stale left the thread unsettleable. Its user-input
 * twin was covered everywhere, which is what made the gap an oversight rather
 * than a decision.
 *
 * Kept as substring patterns because they are matched against detail strings
 * already persisted in the event log; a structured marker could only cover new
 * events. For the same reason a phrasing stays on this list after the code that
 * emitted it is gone.
 */

/**
 * What a provider says when it is asked about a request it has never heard of.
 * ProviderCommandReactor matches these to rewrite the cause into the stale
 * detail below, so a phrasing added here reaches every consumer at once.
 */
const UNKNOWN_PENDING_APPROVAL_DETAILS = [
  "unknown pending approval request",
  "unknown pending permission request",
  // Codex names itself in the message, so the generic phrasings miss it.
  "unknown pending codex approval request",
] as const;

const UNKNOWN_PENDING_USER_INPUT_DETAILS = [
  "unknown pending user-input request",
  // No adapter emits the unhyphenated form today: it was thrown by the
  // pre-app-server Codex runtime and renamed when that landed. Events from
  // before then are still in the log and still have to be recognised.
  "unknown pending user input request",
  "unknown pending codex user input request",
] as const;

const STALE_PENDING_APPROVAL_DETAILS = [
  "stale pending approval request",
  ...UNKNOWN_PENDING_APPROVAL_DETAILS,
] as const;

/**
 * ProjectionSnapshotQuery duplicates these as SQL `LIKE` literals - the pinning
 * query is a tagged template whose clause count has to stay fixed. A test in
 * staleRequestDetail.test.ts fails if the two ever drift apart.
 */
export const STALE_PENDING_USER_INPUT_DETAILS = [
  "stale pending user-input request",
  ...UNKNOWN_PENDING_USER_INPUT_DETAILS,
] as const;

const includesAny = (detail: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => detail.includes(pattern));

/** Whether a failed approval response means the request no longer exists. */
export function isStalePendingApprovalDetail(detail: string | null): boolean {
  return detail !== null && includesAny(detail.toLowerCase(), STALE_PENDING_APPROVAL_DETAILS);
}

/** Whether a failed user-input response means the request no longer exists. */
export function isStalePendingUserInputDetail(detail: string | null): boolean {
  return detail !== null && includesAny(detail.toLowerCase(), STALE_PENDING_USER_INPUT_DETAILS);
}

/** Whether a provider reported an approval request it no longer knows about. */
export function isUnknownPendingApprovalDetail(detail: string): boolean {
  return includesAny(detail.toLowerCase(), UNKNOWN_PENDING_APPROVAL_DETAILS);
}

/** Whether a provider reported a user-input request it no longer knows about. */
export function isUnknownPendingUserInputDetail(detail: string): boolean {
  return includesAny(detail.toLowerCase(), UNKNOWN_PENDING_USER_INPUT_DETAILS);
}

/** Either kind, for callers that do not know which request failed. */
export function isStaleRequestDetail(detail: string | null): boolean {
  return isStalePendingApprovalDetail(detail) || isStalePendingUserInputDetail(detail);
}
