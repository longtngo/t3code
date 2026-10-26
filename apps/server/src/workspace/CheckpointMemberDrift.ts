import type { CheckpointMemberState } from "@t3tools/contracts";

import type { MemberBranchState } from "./MemberBranches.ts";

/**
 * `changed` means both reads differ; `unobserved` means the server never read it, so the refusal
 * must not claim a change. Unobserved at capture is DURABLE: that checkpoint can never be restored
 * (fail-safe; fix by re-observing, not softening). Detaching a member does not clear it, but with
 * no live members the caller skips the check entirely.
 */
export type CheckpointDriftReason = "changed" | "unobserved";

export interface CheckpointDriftMember {
  readonly memberId: string;
  readonly reason: CheckpointDriftReason;
}

/**
 * Whether restoring the staging checkpoint alone still produces the tree it describes. A revert
 * restoring staging while member repositories moved leaves an inconsistent tree behind a UI that
 * implies a clean undo, so completeness depends on what the turn touched.
 */
export interface CheckpointDrift {
  /** Members whose head moved, whose tree changed state, or that were unreadable. */
  readonly driftedMembers: ReadonlyArray<CheckpointDriftMember>;
}

export function resolveCheckpointDrift(
  recorded: ReadonlyArray<CheckpointMemberState> | undefined,
  current: ReadonlyArray<CheckpointMemberState>,
): CheckpointDrift {
  // A checkpoint captured before members were recorded, and one that recorded an
  // empty list, both read as complete - each matching the behaviour it was
  // captured under. They used to be told apart by a flag this returned and
  // nothing ever read.
  if (recorded === undefined) return { driftedMembers: [] };

  const currentById = new Map(current.map((state) => [state.memberId, state] as const));
  const driftedMembers: Array<CheckpointDriftMember> = [];
  for (const state of recorded) {
    const now = currentById.get(state.memberId);
    // Detachment is a real observation, not a failure to make one: the member
    // is no longer in the workspace, so the revert cannot deliver that state.
    if (now === undefined) {
      driftedMembers.push({ memberId: state.memberId, reason: "changed" });
      continue;
    }
    // An unobserved head on either side is checked BEFORE the equality below: two unobserved states
    // are not evidence of sameness, so reaching the equality means both sides were really read.
    if (state.headSha === undefined || now.headSha === undefined) {
      driftedMembers.push({ memberId: state.memberId, reason: "unobserved" });
      continue;
    }
    if (now.headSha !== state.headSha || now.isDirty !== state.isDirty) {
      driftedMembers.push({ memberId: state.memberId, reason: "changed" });
    }
  }
  return { driftedMembers };
}

/**
 * Drift for a revert to turn 0. No checkpoint exists for turn 0, so this asks instead whether any
 * member still carries this thread's work. `unavailable` is not an all-clear: `inspect` never
 * fails, so an unreadable member would otherwise answer like a clean one.
 */
export function resolveTurnZeroDrift(
  reports: ReadonlyArray<{
    readonly memberId: string;
    readonly state: MemberBranchState | "unavailable";
  }>,
): CheckpointDrift {
  const driftedMembers: Array<CheckpointDriftMember> = [];
  for (const report of reports) {
    if (report.state === "cut-needed" || report.state === "owned-by-self") {
      driftedMembers.push({ memberId: report.memberId, reason: "changed" });
    } else if (report.state === "unavailable") {
      driftedMembers.push({ memberId: report.memberId, reason: "unobserved" });
    }
  }
  return { driftedMembers };
}

/**
 * Whether a revert must consult the member comparison. Turn 0 needs a live member; other turns
 * compare against the RECORDED members, where a detached one counts as drift. Keying on live
 * members alone refused the revert after detaching one member and allowed it after detaching all.
 */
export function shouldCheckMemberDrift(input: {
  readonly isTurnZero: boolean;
  readonly liveMemberCount: number;
  readonly recordedMemberCount: number;
}): boolean {
  if (input.isTurnZero) return input.liveMemberCount > 0;
  return input.liveMemberCount > 0 || input.recordedMemberCount > 0;
}

/** True when a revert can restore everything the checkpoint claims. */
export function isCheckpointComplete(drift: CheckpointDrift): boolean {
  return drift.driftedMembers.length === 0;
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
  const join = (names: ReadonlyArray<string>): string =>
    names.length === 1
      ? `${names[0]}`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const named = (reason: CheckpointDriftReason) =>
    drift.driftedMembers
      .filter((member) => member.reason === reason)
      .map((member) => titleForMemberId(member.memberId));

  const changed = named("changed");
  const unobserved = named("unobserved");
  const sentences: Array<string> = [];
  if (changed.length > 0) {
    sentences.push(
      changed.length === 1
        ? `${join(changed)} has changed since this checkpoint, so reverting would leave it out of step with the rest of the workspace.`
        : `${join(changed)} have changed since this checkpoint, so reverting would leave them out of step with the rest of the workspace.`,
    );
  }
  // Deliberately not phrased as a change. The server never read these, so it
  // cannot claim they moved — only that it cannot promise the revert is clean.
  if (unobserved.length > 0) {
    sentences.push(
      unobserved.length === 1
        ? `${join(unobserved)} could not be read, so reverting cannot be checked against it.`
        : `${join(unobserved)} could not be read, so reverting cannot be checked against them.`,
    );
  }
  return sentences.join(" ");
}
