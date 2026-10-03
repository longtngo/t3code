/**
 * SubagentLiveThreads — the threads whose Claude process opened in this server process,
 * and the bridge that lets a Claude adapter prepare a thread's offload state.
 *
 * On `personal` the reconciler enumerated live sessions through the V1 adapter registry's
 * `listSessions()`. V2 sessions live in `ProviderSessionManagerV2`, and the only processes
 * that read a thread flag file are Claude processes spawned with `SUBAGENT_BACKEND_STATE`,
 * so the set that matters is exactly the threads `prepareThreadBackend` ran for. It lives
 * for the process; a thread whose process later closed stays listed, and rewriting its
 * file is harmless.
 *
 * Adapters are built below the runtime services in the layer graph, so they cannot require
 * this service. The bridge follows `McpSessionRegistry`'s module-level active-instance
 * precedent: the layer registers a preparer on build and clears it on release, and
 * `prepareActiveSubagentThreadBackend` returns `undefined` when no layer is live, which a
 * Claude adapter reads as "no offload" — the session prompt and environment stay
 * byte-identical to a build without this feature.
 *
 * @module subagentBackend/SubagentLiveThreads
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { PreparedThreadBackend } from "./SubagentBackend.ts";

export interface SubagentLiveThreadsShape {
  readonly register: (threadId: ThreadId) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<ThreadId>>;
}

export class SubagentLiveThreads extends Context.Service<
  SubagentLiveThreads,
  SubagentLiveThreadsShape
>()("t3/subagentBackend/SubagentLiveThreads") {}

export const makeSubagentLiveThreads = Effect.gen(function* () {
  const threads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  return {
    register: (threadId) =>
      Ref.update(threads, (current) =>
        current.has(threadId) ? current : new Set([...current, threadId]),
      ),
    list: Ref.get(threads).pipe(Effect.map((current) => [...current])),
  } satisfies SubagentLiveThreadsShape;
});

export const layer = Layer.effect(SubagentLiveThreads, makeSubagentLiveThreads);

type Preparer = (threadId: ThreadId) => Effect.Effect<PreparedThreadBackend>;

let activePreparer: Preparer | undefined;

/**
 * Registers `prepare` as the preparer Claude adapters call, for the life of the enclosing
 * scope. `prepare` must already carry its own context: the adapter calls it with none.
 */
export const registerActiveSubagentThreadBackend = (prepare: Preparer) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      activePreparer = prepare;
    }),
    () =>
      Effect.sync(() => {
        if (activePreparer === prepare) {
          activePreparer = undefined;
        }
      }),
  );

/** What a Claude adapter calls before it spawns a process; `undefined` = no offload. */
export const prepareActiveSubagentThreadBackend = (
  threadId: ThreadId,
): Effect.Effect<PreparedThreadBackend | undefined> =>
  activePreparer === undefined ? Effect.undefined : activePreparer(threadId);
