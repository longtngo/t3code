import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectMutationErrorMessage, projectMutationOperation } from "./ProjectMutation.ts";
import {
  ProjectMemberInvalidError,
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
