import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// effect `Stream` combinators that lower to `aggregateWithin` → `stepToBuffer`
// (installed effect@4.0.0-beta.78 `dist/Stream.js:5868`/`:5887`), a schedule loop
// that is NOT stack-safe: on an idle source every scheduled tick self-recurses
// inside `flatMap(() => Effect.never)`, pinning +2 continuation frames on the
// consuming fiber's `_stack` FOREVER (growth tracks the timer, not the element
// rate). That was the confirmed t3code server OOM on `subscribeThread`
// (~1.9 GB/hr → crash every ~13-14 h). Replace with `batchWithinStackSafe`
// (apps/server/src/orchestration/Layers/batchWithinStackSafe.ts): a bounded Queue
// + backpressure-driven pull, no timer, stack-safe, memory-bounded.
const UNSAFE_STREAM_METHODS = new Set([
  "groupedWithin", //         Stream.js:5595 → aggregateWithin(Sink.take, Schedule.spaced)
  "aggregate", //             Stream.js:5838 → aggregateWithin(sink, Schedule.forever)
  "aggregateWithin", //       Stream.js:5868 — the stepToBuffer loop itself
  "aggregateWithinEither", // forward-defensive: not an export in this effect version yet
]);

// Detect `Stream.<unsafe>(...)`. `Stream` is imported namespace-style everywhere in
// this repo (`import * as Stream from "effect/Stream"` / `import { Stream }`), so an
// object-identifier check is sufficient and needs no type info. Covers both
// `Stream.groupedWithin(s, n, d)` and `s.pipe(Stream.groupedWithin(n, d))` — the
// callee MemberExpression is identical in both. A named-import alias
// (`import { groupedWithin } from "effect/Stream"`) would evade it; none exist.
const unsafeStreamMethod = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  if (!isIdentifier(object, "Stream")) return Option.none();

  return Option.filter(getPropertyName(expression.value.property), (method) =>
    UNSAFE_STREAM_METHODS.has(method),
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow effect Stream.groupedWithin/aggregate/aggregateWithin; they lower to a non-stack-safe schedule loop (stepToBuffer) that leaks continuation frames on idle ticks. Use batchWithinStackSafe.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const method = unsafeStreamMethod(node.callee);
        if (Option.isNone(method)) return;

        context.report({
          node: node.callee,
          message: `Stream.${method.value}(...) lowers to effect's non-stack-safe aggregateWithin/stepToBuffer schedule loop, which leaks continuation frames on idle ticks (the confirmed server OOM). Use batchWithinStackSafe for backpressure-driven coalescing instead.`,
        });
      },
    };
  },
});
