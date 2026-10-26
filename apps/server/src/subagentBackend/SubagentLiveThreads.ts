/**
 * Threads whose Claude process opened in this server process. Never shrinks: it is small and
 * read only by the reconciler on a settings change. Adapters sit below this service in the layer
 * graph, so the layer registers a module-level preparer; `undefined` (no live layer) means
 * "no offload", leaving the session prompt and environment byte-identical.
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
