import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// These lower to `aggregateWithin` -> `stepToBuffer`, which is NOT stack-safe: on an idle source
// each tick pins 2 frames on the fiber's `_stack` forever (growth tracks the timer). That was the
// confirmed server OOM on `subscribeThread` (~1.9 GB/hr). Use `batchWithinStackSafe`
// (apps/server/src/orchestration/Layers/batchWithinStackSafe.ts) instead.
const UNSAFE_STREAM_METHODS = new Set([
  "groupedWithin", //         Stream.js:5595 → aggregateWithin(Sink.take, Schedule.spaced)
  "aggregate", //             Stream.js:5838 → aggregateWithin(sink, Schedule.forever)
  "aggregateWithin", //       Stream.js:5868 — the stepToBuffer loop itself
  "aggregateWithinEither", // forward-defensive: not an export in this effect version yet
]);

/** Modules whose `Stream` namespace these combinators live on. */
const STREAM_MODULE = "effect/Stream";
const EFFECT_MODULE = "effect";

const literalStringValue = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  if (!("type" in node) || node.type !== "Literal") return undefined;
  if (!("value" in node) || typeof node.value !== "string") return undefined;
  return node.value;
};

const identifierName = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  if (!("type" in node) || node.type !== "Identifier") return undefined;
  if (!("name" in node) || typeof node.name !== "string") return undefined;
  return node.name;
};

/** The imported (not local) name a specifier refers to. */
const importedName = (specifier: { readonly imported?: unknown }): string | undefined =>
  identifierName(specifier.imported) ??
  (typeof specifier.imported === "object" && specifier.imported !== null
    ? literalStringValue(specifier.imported)
    : undefined);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow effect Stream.groupedWithin/aggregate/aggregateWithin; they lower to a non-stack-safe schedule loop (stepToBuffer) that leaks continuation frames on idle ticks. Use batchWithinStackSafe.",
    },
  },
  create(context) {
    /**
     * Seeded with `Stream` so a namespace obtained another way (re-export, local rebinding) is still
     * covered, as it was before this rule read imports; import aliases are added on top.
     */
    const namespaceNames = new Set<string>(["Stream"]);
    /**
     * Local names bound directly to one of the unsafe combinators, e.g.
     * `import { groupedWithin as gw } from "effect/Stream"`. These call as bare
     * identifiers, with no member expression to match on, which is exactly how
     * the previous version of this rule could be walked past.
     */
    const directNames = new Map<string, string>();

    return {
      ImportDeclaration(node) {
        const source = literalStringValue(node.source);
        if (source !== STREAM_MODULE && source !== EFFECT_MODULE) return;

        for (const specifier of node.specifiers) {
          const local = identifierName(specifier.local);
          if (local === undefined) continue;

          if (specifier.type === "ImportNamespaceSpecifier") {
            // `import * as S from "effect/Stream"` — but `import * as E from
            // "effect"` puts the combinators on `E.Stream`, not on `E`, so the
            // member check below still sees the `Stream` hop and needs nothing.
            if (source === STREAM_MODULE) namespaceNames.add(local);
            continue;
          }
          if (specifier.type !== "ImportSpecifier") continue;

          const imported = importedName(specifier);
          if (imported === undefined) continue;
          // `import { Stream as S } from "effect"` — S is the namespace.
          if (source === EFFECT_MODULE && imported === "Stream") {
            namespaceNames.add(local);
            continue;
          }
          if (source === STREAM_MODULE && UNSAFE_STREAM_METHODS.has(imported)) {
            directNames.set(local, imported);
          }
        }
      },

      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;

        // Bare `groupedWithin(...)` through a named import or its alias.
        const bareName = identifierName(callee.value);
        if (bareName !== undefined) {
          const method = directNames.get(bareName);
          if (method === undefined) return;
          context.report({ node: node.callee, message: messageFor(method) });
          return;
        }

        // `Stream.groupedWithin(...)`, in both the direct-call and the
        // `s.pipe(Stream.groupedWithin(...))` form — the callee member
        // expression is identical in each.
        if (callee.value.type !== "MemberExpression") return;
        const object = unwrapExpression(callee.value.object);
        const objectName = Option.isSome(object) ? identifierName(object.value) : undefined;
        if (objectName === undefined || !namespaceNames.has(objectName)) return;
        if (!isIdentifier(object)) return;

        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || !UNSAFE_STREAM_METHODS.has(method.value)) return;

        context.report({ node: node.callee, message: messageFor(method.value) });
      },
    };
  },
});

const messageFor = (method: string) =>
  `Stream.${method}(...) lowers to effect's non-stack-safe aggregateWithin/stepToBuffer schedule loop, which leaks continuation frames on idle ticks (the confirmed server OOM). Use batchWithinStackSafe for backpressure-driven coalescing instead.`;
