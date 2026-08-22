/**
 * Boot-time reconciliation of turns/sessions orphaned by a backend restart.
 *
 * Each agent turn runs in-process; a hard restart (e.g. `launchctl kickstart -k`
 * at the tail of a rebuild) SIGKILLs the server mid-turn. No terminal event is
 * written, so the thread's session stays in a live status (`running`/`ready`/…)
 * and the client shows a "Working" spinner indefinitely — until
 * `ProviderTurnStallWatchdog` trips ~15 min later.
 *
 * At the point this runs (a startup phase before the reactors begin) the
 * freshly-booted process owns ZERO live sessions, so any thread still in a live
 * session status is by definition orphaned from the previous process —
 * archived and deleted ones included, which is why this reads the archive
 * snapshot too — and deciding *whether* to reconcile needs no boot-id
 * bookkeeping. The command ids do: they
 * are keyed into a receipt table that is never pruned, and the engine replays an
 * accepted receipt instead of deciding, so a thread-scoped id would reconcile a
 * given thread once ever and silently no-op every later boot. Hence the boot
 * timestamp in each id. We dispatch the same clean terminal state the
 * reactor's stop path produces (`status:"stopped", activeTurnId:null`) plus a
 * turn interrupt for history, synchronously (engine dispatch applies the
 * projection in-transaction) — no reactor, and no attempt to signal a dead
 * provider PID.
 */
import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

// Session statuses meaning "a process is/was actively driving this thread".
// Anything else (stopped/error/interrupted/null) is already a clean resting
// state and needs no reconciliation.
const LIVE_SESSION_STATUSES = new Set<OrchestrationSessionStatus>([
  "idle",
  "starting",
  "running",
  "ready",
]);

/** The two command variants this reconciler emits (both carry threadId + createdAt). */
type BootReconcileCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.session.set" | "thread.turn.interrupt" }
>;

/**
 * Pure planner: given the active thread shells and a timestamp, return the
 * commands needed to clear every orphaned live session. For each such thread:
 *   - a `thread.session.set` to the clean stopped state (clears the spinner),
 *   - a `thread.turn.interrupt` when a turn was active (clean turn history).
 * Exported for unit testing without an Effect runtime.
 */
export function planBootReconciliation(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  nowIso: string,
): BootReconcileCommand[] {
  const commands: BootReconcileCommand[] = [];
  for (const thread of threads) {
    const session = thread.session;
    if (!session || !LIVE_SESSION_STATUSES.has(session.status)) {
      continue;
    }
    commands.push({
      type: "thread.session.set",
      commandId: CommandId.make(`boot-reconcile:${nowIso}:${thread.id}:session`),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: session.providerName,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: session.lastError,
        updatedAt: nowIso,
      },
      createdAt: nowIso,
    });
    if (session.activeTurnId !== null) {
      commands.push({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`boot-reconcile:${nowIso}:${thread.id}:turn`),
        threadId: thread.id,
        turnId: session.activeTurnId,
        createdAt: nowIso,
      });
    }
  }
  return commands;
}

/**
 * Reconcile orphaned turns/sessions once, at boot. Returns the count of threads
 * reconciled. Safe to run before the orchestration reactors start: dispatch
 * applies the projection synchronously in-transaction. A query or dispatch
 * failure is logged and never blocks startup.
 */
export const reconcileInterruptedTurnsOnBoot = Effect.fn("reconcileInterruptedTurnsOnBoot")(
  function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    // Two reads, because the navigation snapshot filters archived and deleted
    // threads at the SQL level and an orphaned session does not care whether
    // its thread is still navigable. Without the second one an archived
    // thread's session is stuck in a live status for good: unarchiving it
    // brings the stale status back, and nothing else writes the projection.
    const [snapshot, archivedSnapshot] = yield* Effect.all([
      query.getShellSnapshot(),
      query.getArchivedShellSnapshot(),
    ]);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const commands = planBootReconciliation(
      [...snapshot.threads, ...archivedSnapshot.threads],
      nowIso,
    );
    const reconciledThreads = commands.filter((c) => c.type === "thread.session.set").length;
    if (reconciledThreads === 0) {
      return 0;
    }
    for (const command of commands) {
      yield* engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("boot.turns-reconcile.dispatch-failed", {
            commandType: command.type,
            threadId: command.threadId,
            cause,
          }),
        ),
      );
      if (command.type !== "thread.session.set") {
        continue;
      }
      // The projection above clears the spinner; this clears the *directory*
      // binding the next resume reads. Without it the binding keeps the dead
      // process's `status` and a stale `runtimePayload.activeTurnId`, so a
      // resume attaches to a turn that no longer exists. `upsert` merges
      // runtimePayload, so the rest of it (and `resumeCursor`, which is what
      // makes the resume possible at all) survives untouched.
      yield* Effect.gen(function* () {
        const binding = yield* directory.getBinding(command.threadId);
        if (Option.isNone(binding)) {
          return;
        }
        yield* directory.upsert({
          ...binding.value,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("boot.turns-reconcile.binding-failed", {
            threadId: command.threadId,
            cause,
          }),
        ),
      );
    }
    yield* Effect.logInfo("boot.turns-reconciled", { reconciledThreads });
    return reconciledThreads;
  },
);
