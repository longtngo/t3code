import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Subscription-atom family for the live host CPU/GPU/memory stream
 * (`subscribeHostMetrics`). The atom holds the latest sample and replaces it on
 * each server push; the server samples only while a subscriber is attached, so
 * mounting the atom starts sampling and disposing it (the client pausing/hiding
 * the tab) stops it. `idleTtlMs: 0` disposes promptly on unmount so a paused or
 * backgrounded tab stops the server-side sampling right away instead of lingering.
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
