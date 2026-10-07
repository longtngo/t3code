import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    // Fork: workspace members live in `members_json` (migration id 39). A fork
    // database's existing members must read back after the v2 cut-over, a meta
    // update without `members` must leave them alone, and one with them must
    // replace the whole list.
    it.effect("reads, keeps and replaces a project's workspace members", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-members");
        const base = {
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        yield* projects.apply({
          ...base,
          sequence: 1,
          eventId: EventId.make("event-members-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Workspace",
            workspaceRoot: "/tmp/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        const membersOf = () =>
          projects.get(projectId).pipe(Effect.map((row) => Option.getOrThrow(row).members));
        assert.deepStrictEqual(yield* membersOf(), []);

        // What a pre-cut-over fork database already holds.
        const warehouse = {
          id: "m-warehouse",
          path: "/tmp/warehouse",
          title: "warehouse",
          integrationBranch: "main",
        };
        const api = { id: "m-api", path: "/tmp/api", title: "api", integrationBranch: "develop" };
        const legacyJson = JSON.stringify([warehouse, api]);
        yield* sql`UPDATE projection_projects SET members_json = ${legacyJson} WHERE project_id = ${projectId}`;
        assert.deepStrictEqual(yield* membersOf(), [warehouse, api]);
        assert.deepStrictEqual(
          (yield* projects.listShells()).find((shell) => shell.id === projectId)?.members,
          [warehouse, api],
        );

        yield* projects.apply({
          ...base,
          sequence: 2,
          eventId: EventId.make("event-members-title"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: "2026-03-24T00:00:01.000Z" },
        });
        assert.deepStrictEqual(yield* membersOf(), [warehouse, api]);

        yield* projects.apply({
          ...base,
          sequence: 3,
          eventId: EventId.make("event-members-replaced"),
          type: "project.meta-updated",
          payload: { projectId, members: [api], updatedAt: "2026-03-24T00:00:02.000Z" },
        });
        assert.deepStrictEqual(yield* membersOf(), [api]);
      }),
    );
  },
);

// Fork: a pre-cut-over fork database already holds members in
// `projection_projects.members_json` (id 39). The v2 migrations (64, 65) run on
// a copy of that database and v2 reads the same table, so the members must come
// through the cut-over untouched.
it.effect("keeps a fork database's workspace members across the v2 cut-over", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 63 });
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, members_json, created_at, updated_at, deleted_at
      ) VALUES (
        'project:fork-members',
        'Fork workspace',
        '/work/fork',
        '[]',
        '[{"id":"m-1","path":"/work/warehouse","title":"warehouse","integrationBranch":"main"},{"id":"m-2","path":"/work/api","title":"api","integrationBranch":"develop"}]',
        '2026-06-19T00:00:00.000Z',
        '2026-06-20T00:00:00.000Z',
        NULL
      )
    `;
    yield* runMigrations();

    const projects = yield* ProjectStore.make;
    const project = Option.getOrThrow(yield* projects.get(ProjectId.make("project:fork-members")));
    assert.deepStrictEqual(
      project.members.map((member) => [member.id, member.path]),
      [
        ["m-1", "/work/warehouse"],
        ["m-2", "/work/api"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
