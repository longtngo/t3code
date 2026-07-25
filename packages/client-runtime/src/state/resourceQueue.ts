import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Query-atom family for the local resource-broker queue (`resctl status`). The read is a
 * one-shot RPC; the sidebar drives its own polling cadence (slow in the background, faster
 * while the popover is open) by refreshing this atom, so the family only needs a short
 * stale window. The RPC never fails for an absent broker — it resolves `available:false`.
 */
export function createResourceQueueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:resource-queue:get",
      tag: WS_METHODS.getResourceQueue,
      staleTimeMs: 5_000,
    }),
  };
}
