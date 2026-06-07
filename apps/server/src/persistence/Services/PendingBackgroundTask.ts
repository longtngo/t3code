/**
 * PendingBackgroundTaskRepository - Repository for in-flight background tasks.
 *
 * Owns the durable record of background tasks (backgrounded shell watchers,
 * fire-and-forget `Agent`/Task subagents) that the recovery heartbeat
 * reconciles after a server restart. See migration 033 for the rationale.
 *
 * @module PendingBackgroundTaskRepository
 */
import { IsoDateTime, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const PendingBackgroundTask = Schema.Struct({
  taskId: RuntimeTaskId,
  threadId: ThreadId,
  /** Per-process UUID minted at startup; a row whose bootId differs from the
   * current process was written by a now-dead process (orphaned by restart). */
  bootId: Schema.String,
  startedAt: IsoDateTime,
  /** Refreshed on `task.progress`; drives the stale-timeout backstop trigger. */
  lastSeenAt: IsoDateTime,
  recoveryAttempts: Schema.Number,
});
export type PendingBackgroundTask = typeof PendingBackgroundTask.Type;

export const GetPendingBackgroundTaskInput = Schema.Struct({ taskId: RuntimeTaskId });
export type GetPendingBackgroundTaskInput = typeof GetPendingBackgroundTaskInput.Type;

export const DeletePendingBackgroundTaskInput = Schema.Struct({ taskId: RuntimeTaskId });
export type DeletePendingBackgroundTaskInput = typeof DeletePendingBackgroundTaskInput.Type;

export const TouchPendingBackgroundTaskInput = Schema.Struct({
  taskId: RuntimeTaskId,
  lastSeenAt: IsoDateTime,
});
export type TouchPendingBackgroundTaskInput = typeof TouchPendingBackgroundTaskInput.Type;

export type PendingBackgroundTaskRepositoryError = ProviderSessionRuntimeRepositoryError;

/**
 * PendingBackgroundTaskRepositoryShape - Service API for pending-task records.
 */
export interface PendingBackgroundTaskRepositoryShape {
  /**
   * Insert or replace a pending-task row. Upserts by `taskId`; an existing
   * row's `recoveryAttempts` is preserved (a re-observed `task.started` for
   * the same id must not reset the recovery cap).
   */
  readonly upsert: (
    task: PendingBackgroundTask,
  ) => Effect.Effect<void, PendingBackgroundTaskRepositoryError>;

  /**
   * Refresh `lastSeenAt` for an existing row (no-op if the row is gone).
   */
  readonly touch: (
    input: TouchPendingBackgroundTaskInput,
  ) => Effect.Effect<void, PendingBackgroundTaskRepositoryError>;

  /**
   * Bump `recoveryAttempts` by one for an existing row (no-op if gone).
   */
  readonly incrementAttempts: (
    input: GetPendingBackgroundTaskInput,
  ) => Effect.Effect<void, PendingBackgroundTaskRepositoryError>;

  readonly getByTaskId: (
    input: GetPendingBackgroundTaskInput,
  ) => Effect.Effect<
    Option.Option<PendingBackgroundTask>,
    PendingBackgroundTaskRepositoryError
  >;

  /**
   * List all pending-task rows (ascending started-at order).
   */
  readonly list: () => Effect.Effect<
    ReadonlyArray<PendingBackgroundTask>,
    PendingBackgroundTaskRepositoryError
  >;

  /**
   * List pending-task rows for a single thread (used by the reaper guard).
   */
  readonly listByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    ReadonlyArray<PendingBackgroundTask>,
    PendingBackgroundTaskRepositoryError
  >;

  readonly deleteByTaskId: (
    input: DeletePendingBackgroundTaskInput,
  ) => Effect.Effect<void, PendingBackgroundTaskRepositoryError>;
}

/**
 * PendingBackgroundTaskRepository - Service tag for pending-task persistence.
 */
export class PendingBackgroundTaskRepository extends Context.Service<
  PendingBackgroundTaskRepository,
  PendingBackgroundTaskRepositoryShape
>()("t3/persistence/Services/PendingBackgroundTask/PendingBackgroundTaskRepository") {}
