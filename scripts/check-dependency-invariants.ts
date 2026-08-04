#!/usr/bin/env node

/**
 * Guards the behavior we depend on inside third-party code.
 *
 * Two bugs here are fatal in production and invisible in development: a stack
 * leak that exhausts the heap after hours, and a missing socket listener that
 * ends the process outright. Both live in `effect` packages that are bumped
 * wholesale, and a bump silently drops any hunk upstream does not carry - the
 * install still succeeds, the tests still pass, and the server dies days later.
 *
 * So these are written as claims about the *installed* dependency, not about
 * our patch files: whether the behavior arrives via our patch or because
 * upstream fixed it makes no difference. A failure here means read the entry,
 * decide which it is, and either re-derive the patch or drop it.
 *
 * The beta.103 bump exercised both endings at once. Upstream fixed the leak by
 * refactoring, so that patch is gone and only the measurement remains; the
 * socket listener merged upstream 95 minutes too late for the release, so its
 * patch stays until the next one.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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

/**
 * An invariant checked by running the dependency instead of reading it.
 *
 * Source markers are a proxy for a behavior, and a proxy can drift from the
 * thing it stands for: beta.103 fixed the aggregate leak by moving the
 * recursion out of the wrapping pipe, which left the marker text intact and
 * the marker check wrong in both directions. Where the behavior can be
 * measured directly, measure it.
 */
export interface BehaviorInvariant {
  readonly id: string;
  /** Script run in its own process, printing a single number. */
  readonly probe: string;
  /** Largest measurement that still counts as healthy. */
  readonly budget: number;
  /** Units, for the failure message. */
  readonly unit: string;
  readonly breaks: string;
  readonly restore: string;
}

export interface InvariantFailure {
  readonly invariant: {
    readonly id: string;
    readonly breaks: string;
    readonly restore: string;
    readonly module?: string;
  };
  readonly reason: "missing" | "reverted" | "regressed";
  readonly detail?: string;
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
    id: "upgrade-socket-error-listener",
    module: "@effect/platform-node/NodeHttpServer",
    // Node hands the raw socket to the app on `upgrade` and takes its own
    // listeners off; `ws` only attaches its own once `handleUpgrade` runs.
    requires: 'socket.on("error"',
    breaks:
      "Any peer that resets a websocket - a tab closing, a phone leaving the network - raises an unhandled 'error' event and kills the whole server process.",
    restore:
      "Effect-TS/effect#6927 is merged but missed the beta.103 cut by 95 minutes. On the first release that contains it, delete patches/@effect__platform-node@<version>.patch and its pnpm-workspace.yaml entry - this check keeps passing on upstream's own code.",
  },
];

export const behaviorInvariants: ReadonlyArray<BehaviorInvariant> = [
  {
    id: "stack-safe-aggregateWithin",
    probe: "idle-aggregate-probe.ts",
    // beta.102 measures ~3.8, beta.103 ~0.02, so anything in between is a
    // clear verdict rather than a threshold to tune.
    budget: 2,
    unit: "MB of heap growth over 4s of idle schedule ticks",
    breaks:
      "Stream.aggregateWithin/groupedWithin leak roughly 1.9 GB/hour on an idle source, and the server is OOM-killed overnight.",
    restore:
      "Upstream fixed this in beta.103 by hoisting the recursive loop out of the `Effect.never` wrapper; a bump that regresses it needs that shape restored in patches/effect@<version>.patch. See the OOM post-mortem.",
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
  const { invariant, reason, detail } = failure;
  const headline = reason === "missing"
    ? `${invariant.id}: ${invariant.module} no longer contains the patched code`
    : reason === "reverted"
    ? `${invariant.id}: ${invariant.module} is back to the unpatched code`
    : `${invariant.id}: ${detail}`;
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

export class DependencyProbeError extends Schema.TaggedErrorClass<DependencyProbeError>()(
  "DependencyProbeError",
  {
    id: Schema.String,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.id} probe produced no measurement: ${this.output}`;
  }
}

// Its own process: the probe forces a GC to separate retained frames from
// ordinary garbage, and `--expose-gc` has to be set at startup.
const runProbe = Effect.fn("runProbe")(function* (invariant: BehaviorInvariant) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const probePath = yield* path.fromFileUrl(new URL(invariant.probe, import.meta.url));
  const output = yield* spawner.string(
    ChildProcess.make(process.execPath, ["--expose-gc", probePath]),
  );
  const measured = Number.parseFloat(output.trim());
  if (Number.isNaN(measured)) {
    return yield* new DependencyProbeError({ id: invariant.id, output: output.trim() });
  }
  return measured;
});

export const checkBehaviorInvariants = Effect.fn("checkBehaviorInvariants")(function* (
  invariants: ReadonlyArray<BehaviorInvariant>,
) {
  const failures: Array<InvariantFailure> = [];
  for (const invariant of invariants) {
    const measured = yield* runProbe(invariant);
    if (measured > invariant.budget) {
      failures.push({
        invariant,
        reason: "regressed",
        detail: `measured ${measured} against a budget of ${invariant.budget} ${invariant.unit}`,
      });
    }
  }
  return failures;
});

const command = Command.make("check-dependency-invariants", {}, () =>
  Effect.gen(function* () {
    const failures = [
      ...yield* checkInvariants(dependencyInvariants),
      ...yield* checkBehaviorInvariants(behaviorInvariants),
    ];
    if (failures.length === 0) {
      yield* Console.log(
        `All ${dependencyInvariants.length + behaviorInvariants.length} dependency invariants hold.`,
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
