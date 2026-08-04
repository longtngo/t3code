#!/usr/bin/env node

/**
 * Guards the behavior we depend on inside third-party code.
 *
 * Two of our dependency patches fix bugs that are fatal in production and
 * invisible in development: a stack leak that exhausts the heap after hours,
 * and a missing socket listener that ends the process outright. Both live in
 * `effect` packages that are bumped wholesale, and a bump silently drops a
 * hunk that upstream does not carry - the install still succeeds, the tests
 * still pass, and the server dies days later.
 *
 * So these are written as claims about the *installed* dependency, not about
 * our patch files: whether the behavior arrives via our patch or because
 * upstream fixed it makes no difference. A failure here means read the entry,
 * decide which it is, and either re-derive the patch or drop it.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";

export interface DependencyInvariant {
  /** Short name, used in failure output. */
  readonly id: string;
  /** Module specifier, resolved the way an import from this package would be. */
  readonly module: string;
  /** Source text the built module must contain. */
  readonly requires: string;
  /** Source text that must be gone: the shape the patch replaced. */
  readonly forbids?: string;
  /** What goes wrong in production without it. */
  readonly breaks: string;
  /** What to do when this fails. */
  readonly restore: string;
}

export interface InvariantFailure {
  readonly invariant: DependencyInvariant;
  readonly reason: "missing" | "reverted";
}

export class DependencyInvariantsViolatedError extends Schema.TaggedErrorClass<DependencyInvariantsViolatedError>()(
  "DependencyInvariantsViolatedError",
  {
    ids: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `${this.ids.length} dependency invariant(s) no longer hold: ${this.ids.join(", ")}.`;
  }
}

export class DependencyInvariantResolutionError extends Schema.TaggedErrorClass<DependencyInvariantResolutionError>()(
  "DependencyInvariantResolutionError",
  {
    id: Schema.String,
    module: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve '${this.module}' for the ${this.id} invariant.`;
  }
}

export const dependencyInvariants: ReadonlyArray<DependencyInvariant> = [
  {
    id: "stack-safe-aggregateWithin",
    module: "effect/Stream",
    // The recursive `loop()` has to sit in tail position. Upstream wraps it in
    // `.flatMap(() => Effect.never)` first, which leaves two continuation
    // frames on the fiber stack per idle schedule tick, forever.
    requires: "step(lastOutput).pipe(Pull.catchDone(() => Cause.done()), Effect.flatMap(",
    forbids: "Effect.flatMap(() => Effect.never), Pull.catchDone(() => Cause.done())",
    breaks:
      "Stream.aggregateWithin/groupedWithin leak roughly 1.9 GB/hour on an idle source, and the server is OOM-killed overnight.",
    restore:
      "Re-derive the hunk in patches/effect@<version>.patch against the freshly installed dist/Stream.js. See docs and the OOM post-mortem before assuming upstream fixed it.",
  },
  {
    id: "upgrade-socket-error-listener",
    module: "@effect/platform-node/NodeHttpServer",
    // Node hands the raw socket to the app on `upgrade` and takes its own
    // listeners off; `ws` only attaches its own once `handleUpgrade` runs.
    requires: 'socket.on("error"',
    breaks:
      "Any peer that resets a websocket - a tab closing, a phone leaving the network - raises an unhandled 'error' event and kills the whole server process.",
    restore:
      "Re-derive the hunk in patches/@effect__platform-node@<version>.patch, unless upstream has landed https://github.com/Effect-TS/effect/pull/6927, in which case drop it.",
  },
];

export const checkInvariant = (
  invariant: DependencyInvariant,
  source: string,
): InvariantFailure | undefined => {
  // Seeing the shape the patch replaced is the more specific finding, so it
  // wins: it says the patch came off rather than that the code moved.
  if (invariant.forbids !== undefined && source.includes(invariant.forbids)) {
    return { invariant, reason: "reverted" };
  }
  if (!source.includes(invariant.requires)) {
    return { invariant, reason: "missing" };
  }
  return undefined;
};

export const formatFailure = (failure: InvariantFailure): string => {
  const { invariant, reason } = failure;
  const headline = reason === "missing"
    ? `${invariant.id}: ${invariant.module} no longer contains the patched code`
    : `${invariant.id}: ${invariant.module} is back to the unpatched code`;
  return [
    headline,
    `  breaks:  ${invariant.breaks}`,
    `  restore: ${invariant.restore}`,
  ].join("\n");
};

// Resolved the way an import from this package resolves, so it finds whatever
// the current install actually linked - store path, patch hash and all.
const resolveInvariantModule = (invariant: DependencyInvariant) =>
  Effect.try({
    try: () => import.meta.resolve(invariant.module),
    catch: (cause) =>
      new DependencyInvariantResolutionError({
        id: invariant.id,
        module: invariant.module,
        cause,
      }),
  });

export const checkInvariants = Effect.fn("checkInvariants")(function* (
  invariants: ReadonlyArray<DependencyInvariant>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failures: Array<InvariantFailure> = [];
  for (const invariant of invariants) {
    const moduleUrl = yield* resolveInvariantModule(invariant);
    const modulePath = yield* path.fromFileUrl(new URL(moduleUrl));
    const source = yield* fs.readFileString(modulePath);
    const failure = checkInvariant(invariant, source);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
});

const command = Command.make("check-dependency-invariants", {}, () =>
  Effect.gen(function* () {
    const failures = yield* checkInvariants(dependencyInvariants);
    if (failures.length === 0) {
      yield* Console.log(
        `All ${dependencyInvariants.length} dependency invariants hold.`,
      );
      return;
    }
    for (const failure of failures) {
      yield* Console.error(formatFailure(failure));
    }
    return yield* new DependencyInvariantsViolatedError({
      ids: failures.map((failure) => failure.invariant.id),
    });
  })).pipe(
    Command.withDescription(
      "Check that patched dependencies still carry the behavior we rely on.",
    ),
  );

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
