import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ApplicationProjectMetaUpdatedPayload } from "./applicationEvent.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import { OrchestrationV2Checkpoint } from "./orchestrationV2.ts";
import { Project } from "./project.ts";

const shellFields = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/tmp/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const warehouse = {
  id: "member-1",
  path: "/tmp/warehouse",
  title: "warehouse",
  integrationBranch: "main",
};
const api = { id: "member-2", path: "/tmp/api", title: "api", integrationBranch: "develop" };

describe("workspace members on project contracts", () => {
  it.effect("defaults members to an empty list for shells from servers without members", () =>
    Effect.gen(function* () {
      const shell = yield* Schema.decodeUnknownEffect(OrchestrationProjectShell)(shellFields);
      assert.deepStrictEqual(shell.members, []);
      const project = yield* Schema.decodeUnknownEffect(Project)({
        ...shellFields,
        deletedAt: null,
      });
      assert.deepStrictEqual(project.members, []);
    }),
  );

  it.effect("keeps every member of a multi-member project in order", () =>
    Effect.gen(function* () {
      const shell = yield* Schema.decodeUnknownEffect(OrchestrationProjectShell)({
        ...shellFields,
        members: [warehouse, api],
      });
      assert.deepStrictEqual(
        shell.members.map((member) => member.id),
        ["member-1", "member-2"],
      );
    }),
  );

  it.effect("tells an absent member list apart from a cleared one on meta updates", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(ApplicationProjectMetaUpdatedPayload);
      const untouched = yield* decode({
        projectId: "project-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(untouched.members, undefined);
      const cleared = yield* decode({
        projectId: "project-1",
        members: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.deepStrictEqual(cleared.members, []);
    }),
  );

  it.effect("decodes checkpoints with and without member states", () =>
    Effect.gen(function* () {
      const checkpoint = {
        id: "checkpoint-1",
        threadId: "thread-1",
        scopeId: "scope-1",
        runId: null,
        nodeId: "node-1",
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: "refs/t3/checkpoints/x",
        status: "ready",
        files: [],
        capturedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      };
      const decode = Schema.decodeUnknownEffect(OrchestrationV2Checkpoint);
      assert.strictEqual((yield* decode(checkpoint)).memberStates, undefined);
      const recorded = yield* decode({
        ...checkpoint,
        // An unread member is recorded without a head, not dropped.
        memberStates: [
          { memberId: "member-1", headSha: "abc", isDirty: false },
          { memberId: "member-2", isDirty: false },
        ],
      });
      assert.deepStrictEqual(
        recorded.memberStates?.map((state) => state.headSha),
        ["abc", undefined],
      );
    }),
  );
});
