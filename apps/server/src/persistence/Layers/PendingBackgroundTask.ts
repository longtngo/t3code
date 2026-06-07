import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  PendingBackgroundTask,
  PendingBackgroundTaskRepository,
  type PendingBackgroundTaskRepositoryShape,
} from "../Services/PendingBackgroundTask.ts";

const TaskIdRequestSchema = Schema.Struct({ taskId: RuntimeTaskId });
const ThreadIdRequestSchema = Schema.Struct({ threadId: ThreadId });
const TouchRequestSchema = Schema.Struct({ taskId: RuntimeTaskId, lastSeenAt: Schema.String });

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makePendingBackgroundTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Insert a new pending-task row. On conflict (task re-observed) we only
  // refresh last_seen_at; started_at, boot_id and recovery_attempts are
  // preserved so a re-emitted task.started never resets the boot fence or the
  // recovery cap.
  const upsertTaskRow = SqlSchema.void({
    Request: PendingBackgroundTask,
    execute: (task) =>
      sql`
        INSERT INTO pending_background_tasks (
          task_id,
          thread_id,
          boot_id,
          started_at,
          last_seen_at,
          recovery_attempts
        )
        VALUES (
          ${task.taskId},
          ${task.threadId},
          ${task.bootId},
          ${task.startedAt},
          ${task.lastSeenAt},
          ${task.recoveryAttempts}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          last_seen_at = excluded.last_seen_at
      `,
  });

  const touchTaskRow = SqlSchema.void({
    Request: TouchRequestSchema,
    execute: ({ taskId, lastSeenAt }) =>
      sql`
        UPDATE pending_background_tasks
        SET last_seen_at = ${lastSeenAt}
        WHERE task_id = ${taskId}
      `,
  });

  const incrementAttemptsRow = SqlSchema.void({
    Request: TaskIdRequestSchema,
    execute: ({ taskId }) =>
      sql`
        UPDATE pending_background_tasks
        SET recovery_attempts = recovery_attempts + 1
        WHERE task_id = ${taskId}
      `,
  });

  const getTaskRowByTaskId = SqlSchema.findOneOption({
    Request: TaskIdRequestSchema,
    Result: PendingBackgroundTask,
    execute: ({ taskId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          thread_id AS "threadId",
          boot_id AS "bootId",
          started_at AS "startedAt",
          last_seen_at AS "lastSeenAt",
          recovery_attempts AS "recoveryAttempts"
        FROM pending_background_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingBackgroundTask,
    execute: () =>
      sql`
        SELECT
          task_id AS "taskId",
          thread_id AS "threadId",
          boot_id AS "bootId",
          started_at AS "startedAt",
          last_seen_at AS "lastSeenAt",
          recovery_attempts AS "recoveryAttempts"
        FROM pending_background_tasks
        ORDER BY started_at ASC, task_id ASC
      `,
  });

  const listTaskRowsByThreadId = SqlSchema.findAll({
    Request: ThreadIdRequestSchema,
    Result: PendingBackgroundTask,
    execute: ({ threadId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          thread_id AS "threadId",
          boot_id AS "bootId",
          started_at AS "startedAt",
          last_seen_at AS "lastSeenAt",
          recovery_attempts AS "recoveryAttempts"
        FROM pending_background_tasks
        WHERE thread_id = ${threadId}
        ORDER BY started_at ASC, task_id ASC
      `,
  });

  const deleteTaskByTaskId = SqlSchema.void({
    Request: TaskIdRequestSchema,
    execute: ({ taskId }) =>
      sql`
        DELETE FROM pending_background_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const upsert: PendingBackgroundTaskRepositoryShape["upsert"] = (task) =>
    upsertTaskRow(task).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.upsert:query",
          "PendingBackgroundTaskRepository.upsert:encodeRequest",
        ),
      ),
    );

  const touch: PendingBackgroundTaskRepositoryShape["touch"] = (input) =>
    touchTaskRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.touch:query",
          "PendingBackgroundTaskRepository.touch:encodeRequest",
        ),
      ),
    );

  const incrementAttempts: PendingBackgroundTaskRepositoryShape["incrementAttempts"] = (input) =>
    incrementAttemptsRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.incrementAttempts:query",
          "PendingBackgroundTaskRepository.incrementAttempts:encodeRequest",
        ),
      ),
    );

  const getByTaskId: PendingBackgroundTaskRepositoryShape["getByTaskId"] = (input) =>
    getTaskRowByTaskId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.getByTaskId:query",
          "PendingBackgroundTaskRepository.getByTaskId:decodeRow",
        ),
      ),
    );

  const list: PendingBackgroundTaskRepositoryShape["list"] = () =>
    listTaskRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.list:query",
          "PendingBackgroundTaskRepository.list:decodeRows",
        ),
      ),
    );

  const listByThreadId: PendingBackgroundTaskRepositoryShape["listByThreadId"] = (input) =>
    listTaskRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingBackgroundTaskRepository.listByThreadId:query",
          "PendingBackgroundTaskRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteByTaskId: PendingBackgroundTaskRepositoryShape["deleteByTaskId"] = (input) =>
    deleteTaskByTaskId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("PendingBackgroundTaskRepository.deleteByTaskId:query"),
      ),
    );

  return {
    upsert,
    touch,
    incrementAttempts,
    getByTaskId,
    list,
    listByThreadId,
    deleteByTaskId,
  } satisfies PendingBackgroundTaskRepositoryShape;
});

export const PendingBackgroundTaskRepositoryLive = Layer.effect(
  PendingBackgroundTaskRepository,
  makePendingBackgroundTaskRepository,
);
