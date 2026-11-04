import { assert, describe, expect, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  mutateProjectWithClone,
  projectMutationErrorMessage,
  projectMutationOperation,
} from "./ProjectMutation.ts";
import {
  ProjectMemberInvalidError,
  ProjectNotEmptyError,
  ProjectOperationError,
  type ProjectService,
} from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  members: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

const member = {
  id: "m-warehouse",
  path: "/work/warehouse",
  title: "warehouse",
  integrationBranch: "main",
};

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/updated",
      defaultModelSelection: null,
      autoPull: false,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
      scripts: [],
      members: [member],
      pinned: true,
      archived: false,
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
        members: [member],
        pinned: true,
        archived: false,
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);

it.effect("tells the client which workspace member was refused, and nothing else", () =>
  Effect.gen(function* () {
    const detail = "warehouse is attached twice.";
    const failWith = (error: ProjectMemberInvalidError | ProjectOperationError) => ({
      create: () => Effect.fail(error),
      update: () => Effect.fail(error),
      delete: () => Effect.fail(error),
    });
    const update = {
      type: "project.update",
      commandId: CommandId.make("command:update-members"),
      projectId,
      members: [member, { ...member, id: "m-warehouse-2" }],
    } as const;

    const refused = yield* projectMutationOperation(
      failWith(new ProjectMemberInvalidError({ projectId, detail })),
      update,
    ).pipe(Effect.flip);
    assert.equal(projectMutationErrorMessage(refused), detail);

    const internal = yield* projectMutationOperation(
      failWith(new ProjectOperationError({ operation: "read-project", projectId, cause: "disk" })),
      update,
    ).pipe(Effect.flip);
    assert.equal(projectMutationErrorMessage(internal), "Failed to mutate project.");
  }),
);

const cloneProjectId = ProjectId.make("project-1");
const deletedProject: Project = {
  id: cloneProjectId,
  title: "kh-frontend",
  workspaceRoot: "/workspace/kh-frontend",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  members: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
};

describe("mutateProjectWithClone", () => {
  it.effect("keeps the clone when deletion is rejected", () =>
    Effect.gen(function* () {
      const rejected = new ProjectNotEmptyError({ projectId: cloneProjectId });
      const result = yield* mutateProjectWithClone(
        {
          create: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          delete: () => Effect.fail(rejected),
        },
        { discard: () => Effect.die("must not discard a project that still exists") },
        {
          type: "project.delete",
          commandId: CommandId.make("rejected-delete"),
          projectId: cloneProjectId,
        },
      ).pipe(Effect.flip);

      expect(result).toBe(rejected);
    }),
  );

  it.effect("discards the clone record even when the caller disconnects mid-delete", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>();
      const finishDelete = yield* Deferred.make<void>();
      const discarded: Array<ProjectId> = [];
      const projects = {
        create: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        // The delete event is already durable while its post-commit cleanup runs.
        delete: () =>
          Deferred.succeed(committed, undefined).pipe(
            Effect.andThen(Deferred.await(finishDelete)),
            Effect.as(deletedProject),
          ),
      };
      const clones = {
        discard: (id: ProjectId) => Effect.sync(() => void discarded.push(id)),
      };

      const request = yield* mutateProjectWithClone(projects, clones, {
        type: "project.delete",
        commandId: CommandId.make("command-1"),
        projectId: cloneProjectId,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      // Delivered synchronously so it lands before the delete can finish.
      request.interruptUnsafe();
      yield* Deferred.succeed(finishDelete, undefined);
      yield* Fiber.await(request);

      expect(discarded).toEqual([cloneProjectId]);
    }),
  );
});
