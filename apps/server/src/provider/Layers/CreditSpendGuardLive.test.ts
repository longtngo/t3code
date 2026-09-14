import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ProviderInstanceId, type ServerProvider, ThreadId } from "@t3tools/contracts";

import {
  type CreditSpendGuardMemo,
  emptyCreditSpendGuardMemo,
  runCreditSpendGuardTick,
} from "./CreditSpendGuardLive.ts";

const instanceA = ProviderInstanceId.make("claude-a");
const instanceB = ProviderInstanceId.make("claude-b");

const provider = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: String(instanceId),
    enabled: true,
    installed: true,
    checkedAt: "2026-09-14T00:00:00.000Z",
    usageLimits: {
      checkedAt: "2026-09-14T00:00:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
    },
  }) as unknown as ServerProvider;

const shell = (
  threadId: string,
  instanceId: ProviderInstanceId,
  activeTurnId: string | null,
  status = "running",
) =>
  ({
    id: ThreadId.make(threadId),
    session: { status, providerInstanceId: instanceId, activeTurnId },
  }) as never;

/** Records every command the tick dispatches, and can be told to fail for one thread. */
const makeHarness = (options?: {
  readonly failInterruptFor?: ReadonlySet<string>;
  readonly failShellSnapshot?: boolean;
  readonly failSettings?: boolean;
}) => {
  const dispatched: { type: string; threadId: string }[] = [];
  let reconciles = 0;
  return {
    dispatched,
    reconciles: () => reconciles,
    deps: {
      getSettings:
        options?.failSettings === true
          ? Effect.fail(new Error("settings unavailable") as never)
          : Effect.succeed({ allowSpendingCredits: false }),
      getProviders: Effect.succeed([provider(instanceA, 100), provider(instanceB, 10)]),
      getShellSnapshot:
        options?.failShellSnapshot === true
          ? Effect.fail(new Error("projection unavailable") as never)
          : Effect.succeed({
              threads: [
                shell("t-a1", instanceA, "turn-1"),
                shell("t-a2", instanceA, "turn-2"),
                shell("t-a-idle", instanceA, null),
                shell("t-a-stale", instanceA, "turn-stale", "stopped"),
                shell("t-b", instanceB, "turn-3"),
              ],
            }),
      dispatch: (command: { type: string; threadId: string }) =>
        options?.failInterruptFor?.has(command.threadId) === true &&
        command.type === "thread.turn.interrupt"
          ? Effect.fail(new Error("dispatch failed") as never)
          : Effect.sync(() => {
              dispatched.push({ type: command.type, threadId: command.threadId });
            }),
      readCursorUsedPercent: Effect.succeed(null),
      reconcileAllBackends: Effect.sync(() => {
        reconciles += 1;
      }),
    },
  };
};

const interruptsFor = (harness: ReturnType<typeof makeHarness>) =>
  harness.dispatched.filter((entry) => entry.type === "thread.turn.interrupt");
const appendsFor = (harness: ReturnType<typeof makeHarness>) =>
  harness.dispatched.filter((entry) => entry.type === "thread.activity.append");

describe("credit spend guard tick", () => {
  it.effect("interrupts only running turns on a newly blocked instance", () =>
    Effect.gen(function* () {
      // I7. Four-way fixture on purpose: running turns on the blocked instance, an idle
      // thread (no activeTurnId), a stale stopped thread (activeTurnId but not live status),
      // and a running turn on a DIFFERENT instance. A single-thread fixture passes for every
      // broken version of this filter.
      const harness = makeHarness();
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      const interrupted = interruptsFor(harness).map((entry) => entry.threadId);
      expect(interrupted.sort()).toEqual(["t-a1", "t-a2"]);
      expect(interrupted).not.toContain("t-a-stale");
    }),
  );

  it.effect("announces each interrupted turn exactly once, however many ticks retry", () =>
    Effect.gen(function* () {
      // I13. t-a1's interrupt keeps failing, so instanceA stays owed and every tick
      // re-sweeps its threads. t-a2 must not collect a fresh timeline entry each time.
      const harness = makeHarness({ failInterruptFor: new Set(["t-a1"]) });
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      expect(appendsFor(harness).filter((entry) => entry.threadId === "t-a2")).toHaveLength(1);
      expect(appendsFor(harness).filter((entry) => entry.threadId === "t-a1")).toHaveLength(1);
    }),
  );

  it.effect("retries the sweep when the projection read failed on the first tick", () =>
    Effect.gen(function* () {
      // I12. Without the pending-debt set, instanceA is already in the blocked memo on
      // tick 2, so it never re-enters "newly blocked" and its turns are NEVER interrupted.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const failing = makeHarness({ failShellSnapshot: true });
      yield* runCreditSpendGuardTick({ ...failing.deps, memo });
      expect(interruptsFor(failing)).toHaveLength(0);

      const recovered = makeHarness();
      yield* runCreditSpendGuardTick({ ...recovered.deps, memo });
      expect(
        interruptsFor(recovered)
          .map((entry) => entry.threadId)
          .sort(),
      ).toEqual(["t-a1", "t-a2"]);
    }),
  );

  it.effect("skips the tick without touching the memo when settings cannot be read", () =>
    Effect.gen(function* () {
      // I8. A failed read must not clear the memo: it cannot admit spend (the gates never
      // read the memo) but it must not lose an owed interrupt either.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const working = makeHarness();
      yield* runCreditSpendGuardTick({ ...working.deps, memo });
      const snapshot = yield* Ref.get(memo);

      const broken = makeHarness({ failSettings: true });
      yield* runCreditSpendGuardTick({ ...broken.deps, memo });
      expect(broken.dispatched).toHaveLength(0);
      expect(yield* Ref.get(memo)).toEqual(snapshot);
      expect(interruptsFor(working)).toHaveLength(2);
    }),
  );

  it.effect("does not re-interrupt on a later tick while the instance stays blocked", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      expect(interruptsFor(harness)).toHaveLength(2);
    }),
  );

  it.effect("interrupts nothing once spending is allowed again", () =>
    Effect.gen(function* () {
      // I5.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const blocked = makeHarness();
      yield* runCreditSpendGuardTick({ ...blocked.deps, memo });
      const allowed = makeHarness();
      yield* runCreditSpendGuardTick({
        ...allowed.deps,
        getSettings: Effect.succeed({ allowSpendingCredits: true }),
        memo,
      });
      expect(interruptsFor(allowed)).toHaveLength(0);
    }),
  );

  it.effect("reconciles subagent flag files only when the Cursor block state changes", () =>
    Effect.gen(function* () {
      // I5's Cursor half. An edge, not a level: rewriting every thread's flag file on
      // every provider tick is O(threads) of pointless disk writes.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const harness = makeHarness();
      const blockedCursor = { ...harness.deps, readCursorUsedPercent: Effect.succeed(100) };
      yield* runCreditSpendGuardTick({ ...blockedCursor, memo });
      expect(harness.reconciles()).toBe(1);
      yield* runCreditSpendGuardTick({ ...blockedCursor, memo });
      expect(harness.reconciles()).toBe(1);
      yield* runCreditSpendGuardTick({
        ...harness.deps,
        readCursorUsedPercent: Effect.succeed(40),
        memo,
      });
      expect(harness.reconciles()).toBe(2);
    }),
  );
});
