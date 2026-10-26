import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Holds the latest host CPU/GPU/memory sample. The server samples only while subscribed, so
 * `idleTtlMs: 0` disposes promptly on unmount and a paused or hidden tab stops sampling at once.
 */
export function createHostMetricsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    samples: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:host-metrics:samples",
      tag: WS_METHODS.subscribeHostMetrics,
      idleTtlMs: 0,
    }),
  };
}
