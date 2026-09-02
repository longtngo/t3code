import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Query-atom family for the crew panel.
 *
 * A one-shot RPC on the `resourceQueue.get` precedent, not a stream: crew state
 * changes on a 60s sweep and on operator actions, so the panel drives its own
 * cadence — slow while collapsed, faster while open — by refreshing this atom.
 * A short stale window is all the family needs.
 */
export function createCrewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:crew:list",
      tag: WS_METHODS.crewList,
      staleTimeMs: 5_000,
    }),
    teardown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:teardown",
      tag: WS_METHODS.crewTeardown,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:answer",
      tag: WS_METHODS.crewAnswer,
    }),
    forgetWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:forget-worktree",
      tag: WS_METHODS.crewForgetWorktree,
    }),
  };
}
