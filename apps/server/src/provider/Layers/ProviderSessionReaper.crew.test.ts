import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationCommand, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PendingBackgroundTaskRepository } from "../../persistence/Services/PendingBackgroundTask.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

/**
 * Every thread here is seeded into the real projection tables and read back
 * through the real `ProjectionSnapshotQuery` shell mapping.
 *
 * A hand-built shell that sets `crewRole` itself would pass on exactly the state
 * that loses a crewmate's note: "the exemption is missing" and "`crewRole` is
 * never populated" are behaviourally identical, and only the real producer can
 * tell them apart.
 */
const IDLE_AT = "2026-01-01T00:00:00.000Z";

const THREADS = [
  "bridge-open",
  "crewmate-open",
  "crewmate-closed",
  "bridge-closed",
  "plain",
] as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      'project-reaper-crew', 'Crew Reaper', '/tmp/crew-reaper',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      ${IDLE_AT}, ${IDLE_AT}, NULL
    )
  `;

  for (const threadId of THREADS) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, branch, worktree_path, latest_turn_id,
        latest_user_message_at, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, 'project-reaper-crew', ${`Thread ${threadId}`},
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        NULL, NULL, NULL, NULL, 0, 0, 0, ${IDLE_AT}, ${IDLE_AT}, NULL, NULL
      )
    `;
    // A ready session with no active turn: idle, and nothing but the crew guard
    // can spare it.
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, runtime_mode,
        active_turn_id, last_error, updated_at
      ) VALUES (
        ${threadId}, 'ready', 'claudeAgent', 'claudeAgent', 'full-access',
        NULL, NULL, ${IDLE_AT}
      )
    `;
  }

  const task = (
    taskId: string,
    parentThreadId: string,
    crewThreadId: string,
    status: "open" | "closed",
  ) => sql`
    INSERT INTO crew_tasks (
      task_id, parent_thread_id, crew_thread_id, project_id, base_ref,
      branch, worktree_path, provider, status, created_at, updated_at
    ) VALUES (
      ${taskId}, ${parentThreadId}, ${crewThreadId}, 'project-reaper-crew', NULL,
      ${`crew/${taskId}`}, ${`/tmp/${taskId}`}, 'claudeAgent', ${status},
      ${IDLE_AT}, ${IDLE_AT}
    )
  `;

  yield* task("task-open", "bridge-open", "crewmate-open", "open");
  yield* task("task-closed", "bridge-closed", "crewmate-closed", "closed");
});
/**
 * Builds the whole stack fresh per run so `stopped` cannot carry across tests.
 *
 * `it.live` rather than `it.effect`: the reaper compares `Clock.currentTimeMillis`
 * against `Date.parse(binding.lastSeenAt)`, and TestClock starts at epoch 0, so
 * every binding would read as idle for a negative duration and nothing would be
 * reaped — a green run that never exercised the guard.
 */
const runSweep = Effect.suspend(() => {
  const stopped: Array<ThreadId> = [];
  const orchestrationEngine = {
    readEvents: () => Effect.die("unused"),
    dispatch: (command: OrchestrationCommand) => {
      if (command.type === "thread.session.stop") {
        stopped.push(command.threadId);
      }
      return Effect.succeed({ sequence: 0 });
    },
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.die("unused"),
    subscribeDomainEventsLossless: Effect.die("unused"),
    latestSequence: Effect.succeed(0),
  } as unknown as OrchestrationEngineShape;

  const pendingBackgroundTaskRepositoryMock = Layer.succeed(PendingBackgroundTaskRepository, {
    upsert: () => Effect.void,
    touch: () => Effect.void,
    incrementAttempts: () => Effect.void,
    getByTaskId: () => Effect.succeed(Option.none()),
    list: () => Effect.succeed([]),
    listByThreadId: () => Effect.succeed([]),
    deleteByTaskId: () => Effect.void,
    deleteByThreadId: () => Effect.void,
  });

  const persistence = SqlitePersistenceMemory;
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(Layer.provide(persistence));
  const projectionQueryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
  );

  const layer = makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provideMerge(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
    Layer.provideMerge(runtimeRepositoryLayer),
    Layer.provideMerge(pendingBackgroundTaskRepositoryMock),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    Layer.provideMerge(projectionQueryLayer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* seed;
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    for (const threadId of THREADS) {
      yield* repository.upsert({
        threadId: ThreadId.make(threadId),
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: IDLE_AT,
        resumeCursor: { opaque: `resume-${threadId}` },
        runtimePayload: null,
      });
    }

    const reaper = yield* ProviderSessionReaper;
    yield* reaper.start();
    yield* Effect.sleep("250 millis");

    return stopped.map((threadId) => String(threadId)).sort();
  }).pipe(Effect.provide(layer), Effect.scoped);
});

describe("ProviderSessionReaper crew exemption", () => {
  it.live("exempts the two live crew roles and reaps everything else", () =>
    Effect.gen(function* () {
      const stopped = yield* runSweep;

      // Positive on both sides. Asserting only "the bridge survived" would pass on
      // a reaper that never ran at all — the two reaped arms are what prove the
      // sweep reached these bindings.
      expect(stopped).toEqual(["bridge-closed", "crewmate-closed", "plain"]);
    }),
  );

  it.live("a crewmate whose task closed is reapable again", () =>
    Effect.gen(function* () {
      const stopped = yield* runSweep;

      // Teardown's stated residual: after the zombie-stop attempts, the reaper is
      // the last thing that can stop a crewmate whose `stopSession` failed. An
      // exemption scoped to any non-null crewRole would make that leak permanent.
      expect(stopped).toContain("crewmate-closed");
      expect(stopped).not.toContain("crewmate-open");
    }),
  );

  it.live("a bridge stops being exempt once its last task closes", () =>
    Effect.gen(function* () {
      const stopped = yield* runSweep;

      // Otherwise a thread is exempt forever after its first dispatch.
      expect(stopped).toContain("bridge-closed");
      expect(stopped).not.toContain("bridge-open");
    }),
  );
});
