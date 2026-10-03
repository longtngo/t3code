import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Query + command atoms for the machine-level subagent-dispatch-backend toggle.
 *
 * `get` and `usage` are one-shot RPC reads, mirroring `createResourceQueueEnvironmentAtoms`.
 * `set` is a command, mirroring `createAccountUsageEnvironmentAtoms`: its response IS the
 * committed `SubagentBackendState` (the flag-file write is atomic and completes before the
 * response returns), so callers commit UI state directly from the `set` result rather than
 * flipping optimistically or waiting on a follow-up `get`.
 */
export function createSubagentBackendEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:subagent-backend:get",
      tag: WS_METHODS.subagentBackendGet,
      staleTimeMs: 30_000,
    }),
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:subagent-backend:usage",
      tag: WS_METHODS.subagentBackendUsage,
      staleTimeMs: 30_000,
      // The sidebar footer badge shows this while the panel is closed; the server caches the
      // Cursor read for 60s, so polling faster would only re-read the same snapshot.
      refreshIntervalMs: 60_000,
    }),
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:subagent-backend:set",
      tag: WS_METHODS.subagentBackendSet,
    }),
  };
}
