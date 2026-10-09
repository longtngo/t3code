import { Atom } from "effect/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  cursorOffloadReadiness,
  offloadedThreadCount,
  threadCursorOffload,
} from "~/components/sidebar/sidebarSubagentBackend.logic";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

type OffloadInputs = Parameters<typeof offloadedThreadCount>;

/** Derives the count from a server-config atom (settings and providers) and a thread-index atom.
 *  A number, so subscribers are only re-notified when the count changes, not on every thread
 *  shell or provider update. */
export function makeOffloadedThreadCountAtom(
  configAtom: Atom.Atom<OffloadInputs[0]>,
  threadIndexAtom: Atom.Atom<OffloadInputs[1]>,
): Atom.Atom<number> {
  // `offloadedThreadCount` reads the clock for the credit window only when an input changes, so a
  // window reset shows at the next provider push, not the moment it passes.
  return Atom.make((get) => offloadedThreadCount(get(configAtom), get(threadIndexAtom)));
}

/** Threads on one environment set to Cursor, for the always-mounted sidebar footer icon. */
export const offloadedThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  makeOffloadedThreadCountAtom(
    serverEnvironment.configValueAtom(environmentId),
    environmentThreadShells.environmentThreadIndexAtom(environmentId),
  ).pipe(Atom.withLabel(`subagent-offloaded-thread-count:${environmentId}`)),
);

/** Per environment, the work every row shares (usage window, Cursor config decode), done once
 *  per config push. The clock is read only then; see `makeOffloadedThreadCountAtom`. */
const cursorOffloadReadinessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    cursorOffloadReadiness(get(serverEnvironment.configValueAtom(environmentId))),
  ).pipe(Atom.withLabel(`subagent-offload-readiness:${environmentId}`)),
);

/** Whether one thread offloads to Cursor, for its sidebar row's indicator. A boolean, so a row
 *  re-renders only when its own answer changes; the per-row work is the thread's mode lookup. */
export const threadOffloadedToCursorAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((threadId: ThreadId) =>
    Atom.make(
      (get) =>
        threadCursorOffload(
          get(serverEnvironment.configValueAtom(environmentId)),
          threadId,
          get(cursorOffloadReadinessAtom(environmentId)),
        ) === "on",
    ).pipe(Atom.withLabel(`subagent-thread-offloaded:${environmentId}:${threadId}`)),
  ),
);
