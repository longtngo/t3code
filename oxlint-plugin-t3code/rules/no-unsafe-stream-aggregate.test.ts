import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-unsafe-stream-aggregate");

describe("t3code/no-unsafe-stream-aggregate", () => {
  rule.valid(
    "allows unrelated Stream combinators",
    `
      import * as Stream from "effect/Stream";

      export const pipeline = (source: Stream.Stream<number>) =>
        source.pipe(
          Stream.filter((n) => n > 0),
          Stream.map((n) => n + 1),
          Stream.runDrain,
        );
    `,
  );

  rule.valid(
    "allows Stream.debounce and Stream.throttle (they do not use the stepToBuffer loop)",
    `
      import * as Stream from "effect/Stream";

      export const debounced = (source: Stream.Stream<number>) =>
        source.pipe(Stream.debounce("50 millis"));

      export const throttled = (source: Stream.Stream<number>) =>
        Stream.throttle(source, { cost: () => 1, duration: "1 second", units: 1 });
    `,
  );

  rule.valid(
    "ignores a same-named method on a non-Stream object",
    `
      const Batcher = { groupedWithin: (n: number) => n };
      export const x = Batcher.groupedWithin(64);
    `,
  );

  rule.invalid(
    "reports Stream.groupedWithin (direct call form)",
    `
      import * as Stream from "effect/Stream";

      export const batched = (source: Stream.Stream<number>) =>
        Stream.groupedWithin(source, 64, "20 millis");
    `,
  );

  rule.invalid(
    "reports Stream.groupedWithin (piped call form)",
    `
      import * as Stream from "effect/Stream";

      export const batched = (source: Stream.Stream<number>) =>
        source.pipe(Stream.groupedWithin(64, "20 millis"));
    `,
  );

  rule.invalid(
    "reports Stream.aggregate",
    `
      import * as Stream from "effect/Stream";
      import * as Sink from "effect/Sink";

      export const aggregated = (source: Stream.Stream<number>) =>
        Stream.aggregate(source, Sink.collectAll());
    `,
  );

  rule.invalid(
    "reports Stream.aggregateWithin",
    `
      import * as Stream from "effect/Stream";
      import * as Sink from "effect/Sink";
      import * as Schedule from "effect/Schedule";

      export const aggregated = (source: Stream.Stream<number>) =>
        source.pipe(Stream.aggregateWithin(Sink.collectAll(), Schedule.spaced("1 second")));
    `,
  );

  rule.invalid(
    "reports Stream.aggregateWithinEither (forward-defensive ban entry)",
    `
      import * as Stream from "effect/Stream";
      import * as Sink from "effect/Sink";
      import * as Schedule from "effect/Schedule";

      export const aggregated = (source: Stream.Stream<number>) =>
        source.pipe(Stream.aggregateWithinEither(Sink.collectAll(), Schedule.spaced("1 second")));
    `,
  );
});
