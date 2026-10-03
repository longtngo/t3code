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
 *     run, so it stops at a turn boundary before its process is released. V1's step 2
 *     cleared the stall watchdog's record; v2 has no watchdog (dropped in the port).
 *  3. `McpSessionRegistry.revokeThread` — the crewmate's MCP credential.
 *  4. `TerminalManager.close` — every terminal of the thread.
 *  5. `ProviderSessionManagerV2.detach` for each live provider session of the thread.
 *  6. `thread.metadata.update` clearing `branch` and `worktreePath`, so turn start never
 *     re-creates a worktree the operator deleted (`ProviderTurnStartService` prunes and
 *     re-creates a missing one).
 *  7. `thread.archive` when the thread exists and is not archived. Archive also cancels
 *     queued runs and detaches sessions through the outbox, which backs up steps 3-5.
 *
 * Step 1 runs first and step 2 precedes step 5 (interrupt, then release); steps 3-7 are
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
      // Stable per task and step, whichever caller runs it: a re-run teardown replays the
      // same receipts instead of issuing a second archive or metadata write.
      const commandId = (name: string) => CommandId.make(`crew:teardown:${name}:${task.taskId}`);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);

      yield* step(1, repository.closeTask({ taskId: task.taskId, updatedAt }));
      yield* step(
        2,
        threads.interruptThread({
          projectId: task.projectId,
          // Unique, unlike the two below: an interrupt must act on whatever run is
          // active now, not replay a receipt from an earlier teardown.
          commandId: commandId(`interrupt:${yield* randomUuidV4}`),
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
          branch: null,
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
