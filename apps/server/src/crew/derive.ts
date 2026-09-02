/**
 * The pure rendering ladder: a task plus its crew thread's live session in, one
 * label out. No clock, no IO, no storage.
 *
 * @module crew/derive
 */
import type {
  CrewRendering,
  CrewTaskStatus,
  OrchestrationSession,
  OrchestrationSessionStatus,
} from "@t3tools/contracts";

/**
 * What the ladder needs from a task. Deliberately narrower than `CrewTask` so the
 * function stays callable from a projection row, a repository row, or a fixture.
 */
export interface CrewDeriveTask {
  readonly status: CrewTaskStatus;
}

/**
 * What the ladder needs from the crew thread's shell.
 *
 * `session` is `null` when no session record exists yet — the whole
 * `runSetupProgram()` window, which is minutes long, and the only thing rule 6
 * keys on.
 */
export interface CrewDeriveThread {
  readonly session: Pick<OrchestrationSession, "status"> | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}

/**
 * Rules 2-5, exhaustive over `OrchestrationSessionStatus`'s seven members.
 *
 * Keyed on `OrchestrationSessionStatus` and **not** `ProviderSessionStatus`, a
 * different five-member enum that shares three member names — `running`, `ready`,
 * and the one that matters, `error`. Keyed on the wrong enum, rule 2 mis-fires
 * silently.
 *
 * `stopped` is not a fault. It is what boot reconciliation rewrites live sessions
 * to, so treating it as one renders the whole fleet `interrupted` after every
 * restart. It belongs with the other liveness cases, and the delivery sweep treats
 * it as exactly the situation a wake turn exists for.
 */
const BY_SESSION_STATUS = {
  error: "errored",
  interrupted: "interrupted",
  running: "working",
  starting: "working",
  ready: "idle-no-report",
  idle: "idle-no-report",
  stopped: "idle-no-report",
} as const satisfies Record<OrchestrationSessionStatus, CrewRendering>;

/**
 * Blocking outranks fault outranks liveness outranks the fallback.
 *
 * `unknown` is unreachable by construction: rules 2-5 name all seven session
 * statuses and rule 6 covers the absent record. It exists so the return type is
 * total, and a test asserts no real status produces it.
 */
export function derive(task: CrewDeriveTask, thread: CrewDeriveThread): CrewRendering {
  if (task.status === "closed") {
    return "closed";
  }

  if (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    thread.hasActionableProposedPlan === true
  ) {
    return "blocked-on-human";
  }

  if (thread.session === null) {
    return "starting";
  }

  return BY_SESSION_STATUS[thread.session.status] ?? "unknown";
}
