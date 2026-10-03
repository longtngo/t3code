/**
 * The pure rendering ladder: a task plus its crew thread's shell in, one label out.
 * No clock, no IO, no storage.
 *
 * @module crew/derive
 */
import type {
  CrewRendering,
  CrewTaskStatus,
  OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";

/**
 * What the ladder needs from a task. Deliberately narrower than `CrewTask` so the
 * function stays callable from a projection row, a repository row, or a fixture.
 */
export interface CrewDeriveTask {
  readonly status: CrewTaskStatus;
}

/**
 * What the ladder needs from the crew thread's v2 shell.
 *
 * `status` is `null` when no shell exists yet: the moment between the crew row's
 * reservation and the launch creating the thread.
 */
export interface CrewDeriveThread {
  readonly status: OrchestrationV2ShellThreadStatus | null;
  /** An approval or user-input request is waiting on a human. */
  readonly hasPendingRuntimeRequest?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}

/**
 * Rules 2-5, exhaustive over `OrchestrationV2ShellThreadStatus`'s eleven members (`idle`
 * plus the ten run statuses).
 *
 * `preparing` is the launch's worktree and setup-script window, minutes long, so it is
 * `starting`, not `working`. `completed`, `rolled_back` and `idle` are all "the last run
 * finished and nothing is running", which is exactly what a crewmate that has not filed a
 * report looks like. `cancelled` is a user or teardown interrupt, not a fault.
 */
const BY_THREAD_STATUS = {
  failed: "errored",
  interrupted: "interrupted",
  cancelled: "interrupted",
  queued: "working",
  starting: "working",
  running: "working",
  waiting: "working",
  preparing: "starting",
  completed: "idle-no-report",
  rolled_back: "idle-no-report",
  idle: "idle-no-report",
} as const satisfies Record<OrchestrationV2ShellThreadStatus, CrewRendering>;

/**
 * Blocking outranks fault outranks liveness outranks the fallback.
 *
 * `unknown` is unreachable by construction: rules 2-5 name every shell status and rule 6
 * covers the absent shell. It exists so the return type is total, and a test asserts no
 * real status produces it.
 */
export function derive(task: CrewDeriveTask, thread: CrewDeriveThread): CrewRendering {
  if (task.status === "closed") {
    return "closed";
  }

  if (thread.hasPendingRuntimeRequest === true || thread.hasActionableProposedPlan === true) {
    return "blocked-on-human";
  }

  if (thread.status === null) {
    return "starting";
  }

  return BY_THREAD_STATUS[thread.status] ?? "unknown";
}
