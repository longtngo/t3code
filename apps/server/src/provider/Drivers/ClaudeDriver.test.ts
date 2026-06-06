import { describe, expect, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { getCachedCapabilitiesDroppingMisses } from "./ClaudeDriver.ts";

describe("getCachedCapabilitiesDroppingMisses", () => {
  const makeCountingCache = (results: ReadonlyArray<string | undefined>) =>
    Effect.gen(function* () {
      let lookups = 0;
      const cache = yield* Cache.make({
        capacity: 1,
        timeToLive: Duration.minutes(5),
        lookup: () =>
          Effect.sync(() => {
            const result = results[Math.min(lookups, results.length - 1)];
            lookups += 1;
            return result;
          }),
      });
      return { cache, lookupCount: () => lookups };
    });

  it.effect("re-probes on the next read after a failed probe (undefined)", () =>
    Effect.gen(function* () {
      const { cache, lookupCount } = yield* makeCountingCache([undefined, "capabilities"]);

      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBeUndefined();
      expect(lookupCount()).toBe(1);

      // The miss must not be pinned for the TTL: the next read re-probes.
      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(lookupCount()).toBe(2);
    }),
  );

  it.effect("serves successful probes from the cache without re-probing", () =>
    Effect.gen(function* () {
      const { cache, lookupCount } = yield* makeCountingCache(["capabilities"]);

      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(lookupCount()).toBe(1);
    }),
  );
});
