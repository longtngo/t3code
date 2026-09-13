import { WS_METHODS, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** Same bound as the Task list history read. */
const THREAD_BACKGROUND_TASKS_TIMEOUT = "6 seconds";

/**
 * Query-atom family for the Background panel's read.
 *
 * Keyed on `(threadId, refreshKey)` although the payload carries only `threadId`: the caller
 * derives `refreshKey` from what changes when a task starts, ends, or its session dies, so each
 * transition refetches.
 */
export function createThreadBackgroundTasksEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:thread-background-tasks:list",
      execute: (input: { readonly threadId: ThreadId; readonly refreshKey: string }) =>
        request(WS_METHODS.threadBackgroundTasksList, { threadId: input.threadId }).pipe(
          Effect.timeout(THREAD_BACKGROUND_TASKS_TIMEOUT),
        ),
    }),
  };
}
