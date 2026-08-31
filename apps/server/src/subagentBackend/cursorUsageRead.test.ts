import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { AccountUsageUpdatedPayload } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { readCursorUsage } from "./cursorUsageRead.ts";

const payload = (utilization: number): AccountUsageUpdatedPayload => ({
  fiveHour: null,
  sevenDay: null,
  extra: null,
  cursor: {
    auto: null,
    api: null,
    total: { utilization, resetsAt: "2026-09-01T00:00:00.000Z" },
    onDemand: null,
  },
  fetchedAt: "2026-08-30T00:00:00.000Z",
});

const poll = vi.fn<() => Effect.Effect<AccountUsageUpdatedPayload | null>>(() =>
  Effect.succeed(payload(10)),
);

// vi.mock is hoisted above every import, so the `readCursorUsage` import above
// already resolves against this mock, letting the test control what
// `makeAccountUsagePoll` returns and count how many times it actually ran.
vi.mock("../provider/Layers/CursorUsage.ts", () => ({
  makeAccountUsagePoll: () => poll(),
}));

describe("readCursorUsage", () => {
  // One sequential test rather than several: `readCursorUsage`'s cache is
  // module-level (one Cursor account per server, see cursorUsageRead.ts), so
  // separate tests would race a fresh TestClock against a cache entry left
  // behind by an earlier test. Sequencing every case on one clock is what
  // SubagentBackend and PairingGrantStore's own TTL tests do for the same reason.
  it.effect(
    "caches inside the 60s TTL, refetches after it elapses, and stays null-safe on a signal-less payload",
    () =>
      Effect.gen(function* () {
        const first = yield* readCursorUsage();
        expect(first?.usedPercent).toBe(10);
        expect(poll).toHaveBeenCalledTimes(1);

        // Still inside the TTL: a second call must not refetch.
        yield* TestClock.adjust(Duration.seconds(30));
        const second = yield* readCursorUsage();
        expect(second?.usedPercent).toBe(10);
        expect(poll).toHaveBeenCalledTimes(1);

        // Past the 60s TTL: the next read refetches.
        poll.mockReturnValueOnce(Effect.succeed(payload(42)));
        yield* TestClock.adjust(Duration.seconds(31));
        const third = yield* readCursorUsage();
        expect(third?.usedPercent).toBe(42);
        expect(poll).toHaveBeenCalledTimes(2);

        // A payload with no total window reduces to null, not an error.
        poll.mockReturnValueOnce(
          Effect.succeed({ fiveHour: null, sevenDay: null, extra: null, cursor: undefined }),
        );
        yield* TestClock.adjust(Duration.seconds(61));
        const fourth = yield* readCursorUsage();
        expect(fourth).toBeNull();
        expect(poll).toHaveBeenCalledTimes(3);

        // A failed/unauthenticated poll (already reduced to null upstream) stays null.
        poll.mockReturnValueOnce(Effect.succeed(null));
        yield* TestClock.adjust(Duration.seconds(61));
        const fifth = yield* readCursorUsage();
        expect(fifth).toBeNull();
        expect(poll).toHaveBeenCalledTimes(4);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
