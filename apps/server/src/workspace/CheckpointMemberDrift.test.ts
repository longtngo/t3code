import { assert, describe, it } from "@effect/vitest";

import {
  describeCheckpointDrift,
  shouldCheckMemberDrift,
  isCheckpointComplete,
  resolveCheckpointDrift,
  resolveTurnZeroDrift,
} from "./CheckpointMemberDrift.ts";

const warehouse = { memberId: "m1", headSha: "aaa111", isDirty: false };
const api = { memberId: "m2", headSha: "bbb222", isDirty: false };
/** A member the server could not read: recorded, with no head observed. */
const unread = { memberId: "m3", isDirty: false };

describe("resolveCheckpointDrift", () => {
  // A checkpoint captured before members were recorded cannot claim anything.
  // Treating it as complete is what it was captured under, so a revert of old
  // history keeps working exactly as it did.
  it("is complete for a checkpoint captured before member recording", () => {
    const drift = resolveCheckpointDrift(undefined, [warehouse]);
    assert.isTrue(isCheckpointComplete(drift));
  });

  // An empty array means the turn genuinely ran with no members attached, which
  // is as complete as it gets.
  it("is complete for a record of no members", () => {
    const drift = resolveCheckpointDrift([], [warehouse]);
    assert.isTrue(isCheckpointComplete(drift));
  });

  it("is complete when nothing moved", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [warehouse, api]);
    assert.deepStrictEqual(drift.driftedMembers, []);
  });

  it("names a member whose head moved", () => {
    const drift = resolveCheckpointDrift(
      [warehouse, api],
      [{ ...warehouse, headSha: "ccc333" }, api],
    );
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m1", reason: "changed" }]);
  });

  it("names a member that became dirty", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [warehouse, { ...api, isDirty: true }]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m2", reason: "changed" }]);
  });

  // Uncommitted work that has since been committed leaves the head moved and
  // the tree clean; either half alone is enough to make the revert incomplete.
  it("names a member that became clean", () => {
    const drift = resolveCheckpointDrift([{ ...warehouse, isDirty: true }], [warehouse]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m1", reason: "changed" }]);
  });

  // A detached member cannot be restored to what was recorded either.
  it("names a member that is no longer attached", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [api]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m1", reason: "changed" }]);
  });

  it("ignores a member attached after the checkpoint", () => {
    const drift = resolveCheckpointDrift([warehouse], [warehouse, api]);
    assert.deepStrictEqual(drift.driftedMembers, []);
  });

  // The case the explicit clause exists for: two unobserved states compare EQUAL,
  // so without the clause they read as "nothing moved" — the same trap as
  // comparing two nulls. Every other unobserved row differs from a real sha and
  // would drift anyway.
  //
  // Measured, because an earlier version of this comment claimed this was the
  // only test that proved it: deleting the clause turns FIVE tests red, and three
  // of those catch the real missed drift (an empty `driftedMembers`) rather than
  // just a reason label — this one, "does not read an all-unobserved record as a
  // claim of no members", and a case in `WorkspaceMemberBranches.test.ts`. The
  // guarantee holds; the uniqueness claim did not.
  it("does not read two unobserved states as evidence nothing moved", () => {
    const drift = resolveCheckpointDrift([unread], [unread]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m3", reason: "unobserved" }]);
    assert.isFalse(isCheckpointComplete(drift));
  });

  it("reports a member that was unreadable at capture but readable now", () => {
    const drift = resolveCheckpointDrift([unread], [{ ...unread, headSha: "ddd444" }]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m3", reason: "unobserved" }]);
  });

  // An empty record is a positive claim of "no members". A record of nothing
  // but unobserved members must not collapse into it.
  it("does not read an all-unobserved record as a claim of no members", () => {
    const recorded = [unread, { ...unread, memberId: "m4" }];
    const drift = resolveCheckpointDrift(recorded, recorded);
    assert.deepStrictEqual(drift.driftedMembers, [
      { memberId: "m3", reason: "unobserved" },
      { memberId: "m4", reason: "unobserved" },
    ]);
  });
});

describe("resolveTurnZeroDrift", () => {
  it("waves through members that are not carrying this thread's work", () => {
    const drift = resolveTurnZeroDrift([
      { memberId: "m1", state: "idle" },
      { memberId: "m2", state: "owned-by-other" },
    ]);
    assert.deepStrictEqual(drift.driftedMembers, []);
    assert.isTrue(isCheckpointComplete(drift));
  });

  it("names a member still carrying this thread's work", () => {
    const drift = resolveTurnZeroDrift([
      { memberId: "m1", state: "cut-needed" },
      { memberId: "m2", state: "owned-by-self" },
    ]);
    assert.deepStrictEqual(drift.driftedMembers, [
      { memberId: "m1", reason: "changed" },
      { memberId: "m2", reason: "changed" },
    ]);
  });

  // `inspect` never fails, so an unreadable checkout answers exactly like a
  // clean one. Turn 0 is the deepest revert there is; waving it through here
  // would leave the same hole the recorded path was fixed to close.
  it("does not treat a member it could not read as an all-clear", () => {
    const drift = resolveTurnZeroDrift([
      { memberId: "m1", state: "idle" },
      { memberId: "m2", state: "unavailable" },
    ]);
    assert.deepStrictEqual(drift.driftedMembers, [{ memberId: "m2", reason: "unobserved" }]);
    assert.isFalse(isCheckpointComplete(drift));
  });
});

describe("describeCheckpointDrift", () => {
  const title = (memberId: string) => (memberId === "m1" ? "warehouse" : "uniuni_api_prm");

  it("names one repository", () => {
    const message = describeCheckpointDrift(
      { driftedMembers: [{ memberId: "m1", reason: "changed" }] },
      title,
    );
    assert.include(message, "warehouse has changed");
  });

  it("names several repositories", () => {
    const message = describeCheckpointDrift(
      {
        driftedMembers: [
          { memberId: "m1", reason: "changed" },
          { memberId: "m2", reason: "changed" },
        ],
      },
      title,
    );
    assert.include(message, "warehouse and uniuni_api_prm have changed");
  });

  // The refusal must not assert a change nobody observed. The server never read
  // this repository; it may well be byte-identical.
  it("does not claim an unreadable repository changed", () => {
    const message = describeCheckpointDrift(
      { driftedMembers: [{ memberId: "m1", reason: "unobserved" }] },
      title,
    );
    assert.include(message, "warehouse could not be read");
    assert.notInclude(message, "has changed");
  });

  it("separates what changed from what could not be read", () => {
    const message = describeCheckpointDrift(
      {
        driftedMembers: [
          { memberId: "m1", reason: "changed" },
          { memberId: "m2", reason: "unobserved" },
        ],
      },
      title,
    );
    assert.include(message, "warehouse has changed");
    assert.include(message, "uniuni_api_prm could not be read");
  });
});

describe("shouldCheckMemberDrift", () => {
  // The bug this exists for: the reactor keyed the whole comparison on the LIVE
  // member list, so detaching one repository refused the revert and detaching
  // every repository skipped the check and allowed it.
  it("still checks a recorded member that has since been detached", () => {
    assert.isTrue(
      shouldCheckMemberDrift({ isTurnZero: false, liveMemberCount: 0, recordedMemberCount: 2 }),
    );
  });

  it("checks while members are attached", () => {
    assert.isTrue(
      shouldCheckMemberDrift({ isTurnZero: false, liveMemberCount: 2, recordedMemberCount: 2 }),
    );
  });

  // A project that never had repositories has nothing to compare, and a
  // checkpoint predating member recording claims nothing either.
  it("does not check when neither side has members", () => {
    assert.isFalse(
      shouldCheckMemberDrift({ isTurnZero: false, liveMemberCount: 0, recordedMemberCount: 0 }),
    );
  });

  // Turn 0 asks a different question - whether a LIVE member still carries this
  // thread's work - so a recorded member that is gone cannot answer it.
  it("ignores the recorded side on a turn-0 revert", () => {
    assert.isFalse(
      shouldCheckMemberDrift({ isTurnZero: true, liveMemberCount: 0, recordedMemberCount: 3 }),
    );
    assert.isTrue(
      shouldCheckMemberDrift({ isTurnZero: true, liveMemberCount: 1, recordedMemberCount: 0 }),
    );
  });
});
