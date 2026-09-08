import type { OrchestrationCheckpointMemberState } from "@t3tools/contracts";

import type { MemberBranchState } from "./MemberBranches.ts";

/**
 * Why a member blocks the revert.
 *
 * `changed` is a positive observation: the server read the repository both
 * times and the answers differ. `unobserved` is the absence of one: the server
 * never managed to read it, so it cannot say whether anything moved. They are
 * different things to tell the user, and collapsing them makes the refusal
 * assert a change nobody saw.
 *
 * `unobserved` recorded at capture time is DURABLE, and deliberately so: a
 * checkpoint whose member was never read can never be shown to be restorable, so
 * it blocks that revert permanently. One transient git timeout during one capture
 * therefore costs that checkpoint, with no override. That is the fail-safe
 * direction, but it is a real cost - if it proves too sharp, the fix is a way to
 * re-observe a checkpoint, not a softer reading of absence.
 *
 * Detaching that member does not clear the record, and detaching it does not have
 * to: this comparison walks the RECORDED list, so a member that is gone from the
 * live workspace is still drift. But the caller only consults this at all while
 * the live workspace still has at least one member (`CheckpointReactor`), so
 * detaching every member skips the check rather than passing it.
 */
export type CheckpointDriftReason = "changed" | "unobserved";

export interface CheckpointDriftMember {
  readonly memberId: string;
  readonly reason: CheckpointDriftReason;
}

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
  /** Members whose head moved, whose tree changed state, or that were unreadable. */
  readonly driftedMembers: ReadonlyArray<CheckpointDriftMember>;
}

export function resolveCheckpointDrift(
  recorded: ReadonlyArray<OrchestrationCheckpointMemberState> | undefined,
  current: ReadonlyArray<OrchestrationCheckpointMemberState>,
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
    // An unobserved head on either side is checked on its own, BEFORE the
    // equality below. Two unobserved states are not evidence of sameness —
    // `undefined === undefined` would read as "nothing moved", which is this
    // very defect reintroduced one level down. Reaching the equality at all
    // therefore means both sides were really read.
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
 * Drift for a revert to turn 0, which asks a different question.
 *
 * No checkpoint is ever projected for turn count 0, so there is no recorded
 * baseline to compare against — comparing state would report "no claim" and wave
 * through the deepest revert of all. This asks instead: is any member still
 * carrying this thread's work?
 *
 * `unavailable` is not an all-clear. `inspect` never fails, so a member that
 * could not be read answers exactly like a clean one, and treating that as fine
 * is the same defect this module exists to prevent on the recorded path.
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
 * Whether a revert has to consult the member comparison at all.
 *
 * Turn 0 asks whether any LIVE member still carries this thread's work, so with
 * none attached there is nothing to carry it and nothing to check.
 *
 * Every other turn compares against what the checkpoint RECORDED, and
 * `resolveCheckpointDrift` deliberately treats a member that has since been
 * detached as drift - the revert cannot deliver a state the workspace no longer
 * has. Keying the decision on the live members alone contradicted that: detaching
 * ONE member refused the revert, and detaching them ALL skipped the check and
 * allowed it. The recorded side has to count too.
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
