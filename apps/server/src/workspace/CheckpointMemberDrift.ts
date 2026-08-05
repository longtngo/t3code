import type { OrchestrationCheckpointMemberState } from "@t3tools/contracts";

/**
 * Whether restoring the staging checkpoint alone still produces the tree the
 * checkpoint describes.
 *
 * Checkpoints are staging-only by design, and dropping cross-repo capture does
 * not drop the hazard: a revert that restores staging while member repositories
 * have moved leaves an inconsistent tree behind a UI that implies a clean undo.
 * Completeness is therefore a property of what the turn actually touched, not of
 * whether the project happens to be a workspace.
 */
export interface CheckpointDrift {
  /** Member ids whose head moved or whose working tree changed state. */
  readonly driftedMemberIds: ReadonlyArray<string>;
  /**
   * False only when the checkpoint predates member recording, which cannot make
   * a claim either way and is treated as complete — matching the behavior it was
   * captured under.
   */
  readonly hasClaim: boolean;
}

export function resolveCheckpointDrift(
  recorded: ReadonlyArray<OrchestrationCheckpointMemberState> | undefined,
  current: ReadonlyArray<OrchestrationCheckpointMemberState>,
): CheckpointDrift {
  if (recorded === undefined) return { driftedMemberIds: [], hasClaim: false };

  const currentById = new Map(current.map((state) => [state.memberId, state] as const));
  const driftedMemberIds: Array<string> = [];
  for (const state of recorded) {
    const now = currentById.get(state.memberId);
    // A member that has since been detached, or whose path stopped being
    // readable, cannot be restored to what was recorded either. Treating it as
    // drift is the honest reading: the revert cannot deliver that state.
    if (now === undefined || now.headSha !== state.headSha || now.isDirty !== state.isDirty) {
      driftedMemberIds.push(state.memberId);
    }
  }
  return { driftedMemberIds, hasClaim: true };
}

/** True when a revert can restore everything the checkpoint claims. */
export function isCheckpointComplete(drift: CheckpointDrift): boolean {
  return drift.driftedMemberIds.length === 0;
}

/**
 * The message shown when a revert is refused, naming the repositories rather
 * than saying something went wrong — the user has to know which checkouts to
 * deal with by hand.
 */
export function describeCheckpointDrift(
  drift: CheckpointDrift,
  titleForMemberId: (memberId: string) => string,
): string {
  const names = drift.driftedMemberIds.map(titleForMemberId);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${list} has changed since this checkpoint, so reverting would leave it out of step with the rest of the workspace.`
    : `${list} have changed since this checkpoint, so reverting would leave them out of step with the rest of the workspace.`;
}
