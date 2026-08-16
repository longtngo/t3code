import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  behaviorInvariants,
  checkBehaviorInvariants,
  checkInvariant,
  checkInvariants,
  dependencyInvariants,
  formatFailure,
  type DependencyInvariant,
} from "./check-dependency-invariants.ts";

const invariant: DependencyInvariant = {
  id: "example",
  module: "effect/Stream",
  requires: "the fixed shape",
  forbids: "the broken shape",
  breaks: "everything falls over",
  restore: "re-derive the patch",
};

it("passes when the required shape is there and the broken one is not", () => {
  assert.strictEqual(checkInvariant(invariant, "before the fixed shape after"), undefined);
});

it("fails when the required shape is missing", () => {
  const failure = checkInvariant(invariant, "something else entirely");
  assert.deepStrictEqual(failure?.reason, "missing");
});

it("fails when the shape the patch replaced is back", () => {
  const failure = checkInvariant(invariant, "the fixed shape and the broken shape");
  assert.deepStrictEqual(failure?.reason, "reverted");
});

it("treats a missing `forbids` as nothing to check", () => {
  const { forbids: _forbids, ...withoutForbids } = invariant;
  assert.strictEqual(
    checkInvariant(withoutForbids, "the fixed shape and the broken shape"),
    undefined,
  );
});

it("names the invariant and says what to do", () => {
  const failure = checkInvariant(invariant, "");
  assert.ok(failure !== undefined);
  const message = formatFailure(failure);
  assert.ok(message.includes("example"));
  assert.ok(message.includes("everything falls over"));
  assert.ok(message.includes("re-derive the patch"));
});

it("reports a measurement against its budget when a behavior regresses", () => {
  const message = formatFailure({
    invariant: { id: "example", breaks: "the heap fills up", restore: "restore the shape" },
    reason: "regressed",
    detail: "measured 4 against a budget of 2 MB",
  });
  assert.ok(message.includes("example"));
  assert.ok(message.includes("measured 4 against a budget of 2 MB"));
  assert.ok(message.includes("the heap fills up"));
});

// The invariants are claims about the dependency tree that is installed right
// now, so the only way to check them is to read it. This is the test that an
// effect bump is meant to trip.
it.effect("the installed dependencies still hold every invariant", () =>
  Effect.gen(function* () {
    const failures = yield* checkInvariants(dependencyInvariants);
    assert.deepStrictEqual(failures.map(formatFailure), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Measured rather than read: beta.103 fixed the aggregate leak by refactoring,
// which left the old source marker intact and its verdict wrong. Calibration is
// ~3.8 MB on the leaking build against ~0.02 MB here.
it.effect(
  "the installed effect build does not leak on idle schedule ticks",
  () =>
    Effect.gen(function* () {
      const failures = yield* checkBehaviorInvariants(behaviorInvariants);
      assert.deepStrictEqual(failures.map(formatFailure), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
