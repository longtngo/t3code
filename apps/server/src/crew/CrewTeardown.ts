/**
 * The seven teardown steps, shared by `crew_teardown` (bridge authority) and the panel's
 * `crew.teardown` RPC (operator authority). Authority is the caller's job; this only runs
 * the steps.
 *
 * Close first, then clean up, every step best-effort. A step's failure is logged as
 * `crew.teardown.step-failed.<n>` and never latches: holding the slot on a deterministic
 * failure is what took the cap to zero in revision 11 of the design.
 *
 * On orchestrator v2 each step is an upstream operation, not a crew mechanism:
 *
 *  1. `crew_tasks.status = 'closed'` — frees the slot.
 *  2. `ThreadManagementService.interruptThread` — `run.interrupt` on the crewmate's active
 *     run, so the run ends as interrupted. V1's step 2 cleared the stall watchdog's
 *     record; v2 has no watchdog (dropped in the port).
 *  3. `McpSessionRegistry.revokeThread` — the crewmate's MCP credential.
 *  4. `TerminalManager.close` — every terminal of the thread.
 *  5. `ProviderSessionManagerV2.detach` for each live provider session of the thread.
 *  6. `thread.metadata.update` clearing `worktreePath`, so turn start never re-creates a
 *     worktree the operator deleted (`ProviderTurnStartService` re-creates a missing one
 *     only when both path and branch are set). The `crew/<taskId>` branch is kept: it is
 *     the shell's crew marker, which silences the crewmate's notifications.
 *  7. `thread.archive` when the thread exists and is not archived. Archive also cancels
 *     queued runs and detaches sessions through the outbox, which backs up steps 3-5.
 *
 * Step 1 runs first; nothing else is ordered. Step 2's interrupt is durable at once but
 * its provider effect runs from the outbox, usually after step 5's detach. Steps 2-7 are
 * individually idempotent.
 *
 * @module crew/CrewTeardown
 */
import { CommandId, type CrewTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";

/** Statuses a provider session can be released from; archive skips the same two. */
const isLiveSessionStatus = (status: string) => status !== "stopped" && status !== "error";

export const makeCrewTeardown = Effect.gen(function* () {
  const repository = yield* CrewRepository;
  const crewLog = yield* CrewLog;
  const threads = yield* ThreadManagementService;
  const mcpSessions = yield* McpSessionRegistry;
  const terminals = yield* TerminalManager;
  const sessions = yield* ProviderSessionManagerV2;

  return (task: CrewTask) =>
    Effect.gen(function* () {
      const step = <A, E>(index: number, effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause(() =>
            crewLog.record(`crew.teardown.step-failed.${index}` as never, {
              taskId: task.taskId,
              threadId: task.crewThreadId,
              step: index,
            }),
          ),
        );
      // Unique per teardown run. A fixed id would replay a REJECTED receipt forever, so
      // `Re-run teardown` could never complete a step that was refused once. Running a
      // step twice is harmless: step 6 writes the same nulls, and step 7 is skipped once
      // the thread is archived.
      const runId = yield* randomUuidV4;
      const commandId = (name: string) =>
        CommandId.make(`crew:teardown:${name}:${task.taskId}:${runId}`);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);

      yield* step(1, repository.closeTask({ taskId: task.taskId, updatedAt }));
      yield* step(
        2,
        threads.interruptThread({
          projectId: task.projectId,
          commandId: commandId("interrupt"),
          threadId: task.crewThreadId,
          reason: "Crew task torn down.",
        }),
      );
      yield* step(3, mcpSessions.revokeThread(task.crewThreadId));
      yield* step(4, terminals.close({ threadId: task.crewThreadId }));
      yield* step(
        5,
        threads.getThreadRecords(task.crewThreadId, ["providerSessions"]).pipe(
          Effect.flatMap((records) =>
            Effect.forEach(
              records.providerSessions.filter((session) => isLiveSessionStatus(session.status)),
              (session) =>
                sessions.detach({
                  providerSessionId: session.id,
                  threadId: task.crewThreadId,
                  detail: "Crew task torn down.",
                  revokeMcpCredential: true,
                }),
              { discard: true },
            ),
          ),
        ),
      );
      yield* step(
        6,
        threads.dispatch({
          type: "thread.metadata.update",
          commandId: commandId("forget-worktree"),
          threadId: task.crewThreadId,
          // The branch stays: turn start re-creates a worktree only when both are set,
          // and `crew/<taskId>` is how every client recognises a crewmate's shell.
          worktreePath: null,
        }),
      );
      const shell = yield* threads
        .getThreadShell(task.crewThreadId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (shell !== null && shell.deletedAt === null && shell.archivedAt === null) {
        yield* step(
          7,
          threads.dispatch({
            type: "thread.archive",
            commandId: commandId("archive"),
            threadId: task.crewThreadId,
          }),
        );
      }
    });
});
