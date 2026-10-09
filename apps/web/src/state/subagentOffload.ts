import { Atom } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";

import { offloadedThreadCount } from "~/components/sidebar/sidebarSubagentBackend.logic";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

type OffloadInputs = Parameters<typeof offloadedThreadCount>;

/** Derives the count from a settings atom and a thread-index atom. A number, so subscribers are
 *  only re-notified when the count changes, not on every thread shell update. */
export function makeOffloadedThreadCountAtom(
  settingsAtom: Atom.Atom<OffloadInputs[0]>,
  threadIndexAtom: Atom.Atom<OffloadInputs[1]>,
): Atom.Atom<number> {
  return Atom.make((get) => offloadedThreadCount(get(settingsAtom), get(threadIndexAtom)));
}

/** Threads on one environment set to Cursor, for the always-mounted sidebar footer icon. */
export const offloadedThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  makeOffloadedThreadCountAtom(
    serverEnvironment.settingsValueAtom(environmentId),
    environmentThreadShells.environmentThreadIndexAtom(environmentId),
  ).pipe(Atom.withLabel(`subagent-offloaded-thread-count:${environmentId}`)),
);
