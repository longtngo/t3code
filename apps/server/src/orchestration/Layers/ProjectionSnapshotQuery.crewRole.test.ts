import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const insertThread = (sql: SqlClient.SqlClient, threadId: string) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, branch, worktree_path, latest_turn_id,
    latest_user_message_at, pending_approval_count, pending_user_input_count,
    has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
  ) VALUES (
    ${threadId}, 'project-1', ${`Thread ${threadId}`},
    '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
    NULL, NULL, NULL, NULL, 0, 0, 0,
    '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL, NULL
  )
`;

const insertCrewTask = (
  sql: SqlClient.SqlClient,
  input: {
    readonly taskId: string;
    readonly parentThreadId: string;
    readonly crewThreadId: string;
    readonly status: "open" | "closed";
  },
) => sql`
  INSERT INTO crew_tasks (
    task_id, parent_thread_id, crew_thread_id, project_id, base_ref,
    branch, worktree_path, provider, status, created_at, updated_at
  ) VALUES (
    ${input.taskId}, ${input.parentThreadId}, ${input.crewThreadId}, 'project-1', NULL,
    ${`crew/${input.taskId}`}, ${`/tmp/${input.taskId}`}, 'claudeAgent', ${input.status},
    '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
  )
`;

/**
 * One fixture serving every arm at once, so a passing arm cannot be an artefact of
 * a fixture built to produce it:
 *
 *   bridge-open   parents an open task owned by crewmate-open
 *   bridge-closed parents a closed task owned by crewmate-closed
 *   plain         has no crew row at all
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`DELETE FROM crew_tasks`;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      'project-1', 'Project 1', '/tmp/project-1',
      '{"provider":"codex","model":"gpt-5-codex"}', '[]',
      '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL
    )
  `;

  for (const threadId of [
    "bridge-open",
    "crewmate-open",
    "bridge-closed",
    "crewmate-closed",
    "plain",
  ]) {
    yield* insertThread(sql, threadId);
  }

  yield* insertCrewTask(sql, {
    taskId: "task-open",
    parentThreadId: "bridge-open",
    crewThreadId: "crewmate-open",
    status: "open",
  });
  yield* insertCrewTask(sql, {
    taskId: "task-closed",
    parentThreadId: "bridge-closed",
    crewThreadId: "crewmate-closed",
    status: "closed",
  });
});

const roleOf = (threadId: string) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const shell = yield* snapshotQuery.getThreadShellById(ThreadId.make(threadId));
    return Option.getOrThrow(shell).crewRole;
  });

const ARMS = [
  ["bridge-open", "bridge"],
  ["crewmate-open", "crewmate"],
  ["crewmate-closed", "crewmate-closed"],
  ["bridge-closed", undefined],
  ["plain", undefined],
] as const;

projectionSnapshotLayer("ProjectionSnapshotQuery crewRole", (it) => {
  for (const [threadId, expected] of ARMS) {
    it.effect(`${threadId} -> ${expected ?? "absent"}`, () =>
      Effect.gen(function* () {
        yield* seed;
        assert.strictEqual(yield* roleOf(threadId), expected);
      }),
    );
  }

  it.effect("absent means the key is absent, not present-and-null", () =>
    Effect.gen(function* () {
      yield* seed;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const shell = Option.getOrThrow(
        yield* snapshotQuery.getThreadShellById(ThreadId.make("plain")),
      );
      // `crewRole: null` on an ordinary thread turns the existing deepEqual
      // assertions in ProjectionSnapshotQuery.test.ts red. Assert the shape the
      // spread produces, not merely that the value is falsy.
      assert.ok(!Object.hasOwn(shell, "crewRole"));
    }),
  );

  it.effect("a bridge whose task closed loses the role, but its crewmate does not", () =>
    Effect.gen(function* () {
      yield* seed;
      // The teardown window this asymmetry exists for: the row is closed, so the
      // reaper may stop the crewmate again, while notification suppression still
      // has a non-null role to match on.
      assert.strictEqual(yield* roleOf("bridge-closed"), undefined);
      assert.strictEqual(yield* roleOf("crewmate-closed"), "crewmate-closed");
    }),
  );

  it.effect("bridge outranks crewmate-closed on a thread that is both", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // bridge-closed now also parents an open task. Its own task is still closed,
      // so an implementation that checked `crew_thread_id` first without ranking
      // would report `crewmate-closed` and let the reaper stop a dispatcher whose
      // children are still alive.
      yield* insertCrewTask(sql, {
        taskId: "task-second",
        parentThreadId: "crewmate-closed",
        crewThreadId: "grandchild",
        status: "open",
      });
      assert.strictEqual(yield* roleOf("crewmate-closed"), "bridge");
    }),
  );

  it.effect("the role travels on the list snapshots, not only the by-id read", () =>
    Effect.gen(function* () {
      yield* seed;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread.crewRole]));
      assert.strictEqual(byId.get(ThreadId.make("bridge-open")), "bridge");
      assert.strictEqual(byId.get(ThreadId.make("crewmate-open")), "crewmate");
      assert.strictEqual(byId.get(ThreadId.make("plain")), undefined);
    }),
  );

  it.effect("the role survives archiving, which is where teardown leaves a crewmate", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_threads
        SET archived_at = '2026-09-02T01:00:00.000Z'
        WHERE thread_id = 'crewmate-closed'
      `;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const archived = yield* snapshotQuery.getArchivedShellSnapshot();
      const row = archived.threads.find((thread) => thread.id === ThreadId.make("crewmate-closed"));
      assert.strictEqual(row?.crewRole, "crewmate-closed");
    }),
  );
});
