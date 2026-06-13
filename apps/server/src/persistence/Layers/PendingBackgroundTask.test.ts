import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PendingBackgroundTaskRepository } from "../Services/PendingBackgroundTask.ts";
import { PendingBackgroundTaskRepositoryLive } from "./PendingBackgroundTask.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  PendingBackgroundTaskRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const baseRow = (taskId: string, threadId: string) => ({
  taskId: RuntimeTaskId.make(taskId),
  threadId: ThreadId.make(threadId),
  bootId: "boot-a",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  recoveryAttempts: 0,
});

layer("PendingBackgroundTaskRepository", (it) => {
  it.effect("round-trips upsert / getByTaskId / list / delete", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      const row = baseRow("task-rt", "thread-rt");

      yield* repository.upsert(row);
      const got = yield* repository.getByTaskId({ taskId: row.taskId });
      assert.deepStrictEqual(Option.getOrNull(got), row);

      const all = yield* repository.list();
      assert.strictEqual(all.length, 1);

      yield* repository.deleteByTaskId({ taskId: row.taskId });
      assert.strictEqual((yield* repository.list()).length, 0);
    }),
  );

  it.effect("upsert on conflict refreshes last_seen_at but preserves recovery_attempts + started_at", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      const row = baseRow("task-conflict", "thread-conflict");
      yield* repository.upsert(row);
      yield* repository.incrementAttempts({ taskId: row.taskId });

      // Re-observe the same task with a fresh started/last-seen + zero attempts.
      yield* repository.upsert({
        ...row,
        startedAt: "2026-02-02T00:00:00.000Z",
        lastSeenAt: "2026-02-02T00:00:00.000Z",
        recoveryAttempts: 0,
      });

      const got = Option.getOrNull(yield* repository.getByTaskId({ taskId: row.taskId }));
      assert.strictEqual(got?.recoveryAttempts, 1, "attempts preserved");
      assert.strictEqual(got?.startedAt, "2026-01-01T00:00:00.000Z", "started_at preserved");
      assert.strictEqual(got?.lastSeenAt, "2026-02-02T00:00:00.000Z", "last_seen_at refreshed");
    }),
  );

  it.effect("touch refreshes last_seen_at; incrementAttempts bumps the counter", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      const row = baseRow("task-touch", "thread-touch");
      yield* repository.upsert(row);

      yield* repository.touch({ taskId: row.taskId, lastSeenAt: "2026-03-03T00:00:00.000Z" });
      yield* repository.incrementAttempts({ taskId: row.taskId });
      yield* repository.incrementAttempts({ taskId: row.taskId });

      const got = Option.getOrNull(yield* repository.getByTaskId({ taskId: row.taskId }));
      assert.strictEqual(got?.lastSeenAt, "2026-03-03T00:00:00.000Z");
      assert.strictEqual(got?.recoveryAttempts, 2);
    }),
  );

  it.effect("listByThreadId scopes rows to a single thread", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      yield* repository.upsert(baseRow("task-a", "thread-x"));
      yield* repository.upsert(baseRow("task-b", "thread-x"));
      yield* repository.upsert(baseRow("task-c", "thread-y"));

      const x = yield* repository.listByThreadId({ threadId: ThreadId.make("thread-x") });
      const y = yield* repository.listByThreadId({ threadId: ThreadId.make("thread-y") });
      assert.strictEqual(x.length, 2);
      assert.strictEqual(y.length, 1);
    }),
  );

  it.effect("deleteByThreadId removes only the target thread's rows", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      yield* repository.upsert(baseRow("task-a", "thread-x"));
      yield* repository.upsert(baseRow("task-b", "thread-x"));
      yield* repository.upsert(baseRow("task-c", "thread-y"));

      yield* repository.deleteByThreadId({ threadId: ThreadId.make("thread-x") });

      assert.strictEqual(
        (yield* repository.listByThreadId({ threadId: ThreadId.make("thread-x") })).length,
        0,
      );
      assert.strictEqual(
        (yield* repository.listByThreadId({ threadId: ThreadId.make("thread-y") })).length,
        1,
      );
    }),
  );

  it.effect("deleteByThreadId leaves other threads' rows intact when the target has none", () =>
    Effect.gen(function* () {
      const repository = yield* PendingBackgroundTaskRepository;
      yield* repository.upsert(baseRow("task-keep", "thread-keep"));

      yield* repository.deleteByThreadId({ threadId: ThreadId.make("thread-absent") });

      assert.strictEqual(
        (yield* repository.listByThreadId({ threadId: ThreadId.make("thread-keep") })).length,
        1,
      );
    }),
  );
});
