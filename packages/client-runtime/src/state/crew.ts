import { WS_METHODS, type CrewRole, type CrewTaskView } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Crew state changes on the server's 60s sweep, so the shared list refreshes at that rate. */
export const CREW_LIST_REFRESH_MS = 60_000;

/** The crew list query's options, shared by its atom family and its test. */
export const CREW_LIST_QUERY_OPTIONS = {
  label: "environment-data:crew:list",
  tag: WS_METHODS.crewList,
  staleTimeMs: 5_000,
  refreshIntervalMs: CREW_LIST_REFRESH_MS,
} as const;

/**
 * Query-atom family for crew.
 *
 * A one-shot RPC on the `resourceQueue.get` precedent, not a stream. Every reader of one
 * environment's list shares one atom, and the atom refreshes itself every
 * `CREW_LIST_REFRESH_MS` while anything is subscribed, hidden tab included — one poller
 * per environment however many surfaces read it. An open panel refreshes faster on top.
 */
export function createCrewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, CREW_LIST_QUERY_OPTIONS),
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

/**
 * Each thread's crew role, derived from a `crew.list` result. The same rule as the
 * server's `resolveCrewRole`: a crewmate is `crewmate` while its task is open and
 * `crewmate-closed` after, and a thread parenting an open task is `bridge`.
 * Threads with no role are absent.
 */
export function crewRolesByThread(
  tasks: ReadonlyArray<Pick<CrewTaskView, "parentThreadId" | "crewThreadId" | "status">>,
): ReadonlyMap<string, CrewRole> {
  const roles = new Map<string, CrewRole>();
  for (const task of tasks) {
    if (task.status === "open" && !roles.has(task.parentThreadId)) {
      roles.set(task.parentThreadId, "bridge");
    }
  }
  // Crewmate wins over bridge: the server checks the crewmate row first.
  for (const task of tasks) {
    roles.set(task.crewThreadId, task.status === "open" ? "crewmate" : "crewmate-closed");
  }
  return roles;
}
