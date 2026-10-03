/**
 * Which crew role a thread holds, read from `crew_tasks`.
 *
 * V1 carried this as `crewRole` on the thread shell. V2's shell has no crew field, and
 * crew stays a sidecar (its own tables, no projection changes), so server-side readers ask
 * here instead. The web reads the same rows through `crew.list` (`crewRoleByThread` in
 * client-runtime).
 *
 * @module crew/CrewRoles
 */
import type { CrewRole, CrewTask, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CrewRepository } from "./CrewRepository.ts";

/**
 * `crewmate` while its task is open, `crewmate-closed` after, `bridge` while it parents an
 * open task. A crewmate row wins over a bridge row: `nested` refuses a crewmate's dispatch,
 * so a thread is never both.
 */
export function resolveCrewRole(
  asCrewmate: Option.Option<CrewTask>,
  asParent: ReadonlyArray<CrewTask>,
): CrewRole | null {
  if (Option.isSome(asCrewmate)) {
    return asCrewmate.value.status === "open" ? "crewmate" : "crewmate-closed";
  }
  return asParent.some((task) => task.status === "open") ? "bridge" : null;
}

export interface CrewRolesShape {
  /** Never fails: an unreadable table reads as "not crew", which notifies as before. */
  readonly roleOf: (threadId: ThreadId) => Effect.Effect<CrewRole | null>;
}

export class CrewRoles extends Context.Service<CrewRoles, CrewRolesShape>()("t3/crew/CrewRoles") {}

export const CrewRolesLive = Layer.effect(CrewRoles)(
  Effect.gen(function* () {
    const repository = yield* CrewRepository;
    return {
      roleOf: (threadId) =>
        Effect.all([
          repository.getTaskByCrewThreadId({ crewThreadId: threadId }),
          repository.getTasksByParentThreadId({ parentThreadId: threadId }),
        ]).pipe(
          Effect.map(([asCrewmate, asParent]) => resolveCrewRole(asCrewmate, asParent)),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    } satisfies CrewRolesShape;
  }),
);
