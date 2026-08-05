import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  CommandId,
  type ClientOrchestrationCommand,
  ProjectId,
  type WorkspaceMember,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-normalizer-members-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-normalizer-members-",
  });
});

const metaUpdateWithMembers = (
  members: ReadonlyArray<WorkspaceMember>,
): ClientOrchestrationCommand => ({
  type: "project.meta.update",
  commandId: CommandId.make("command-1"),
  projectId: ProjectId.make("project-1"),
  members,
});

const readMembers = (command: { readonly type: string }) => {
  if (command.type !== "project.meta.update") {
    throw new Error("Expected a project.meta.update command");
  }
  return (command as { readonly members?: ReadonlyArray<WorkspaceMember> }).members;
};

it.layer(TestLayer)("normalizeDispatchCommand workspace members", (it) => {
  describe("project.meta.update", () => {
    it.effect("resolves member paths to canonical absolute directories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* makeTempDir();
        const memberDir = path.join(baseDir, "warehouse");
        yield* fileSystem.makeDirectory(memberDir, { recursive: true });

        const normalized = yield* normalizeDispatchCommand(
          metaUpdateWithMembers([
            {
              id: "member-1",
              // Trailing separator plus a traversal hop: both are collapsed by
              // the same normalization the workspace root already goes through.
              path: `${memberDir}/../warehouse/`,
              title: "warehouse",
              integrationBranch: "pickup-v2",
            },
          ]),
        );

        expect(readMembers(normalized)).toEqual([
          {
            id: "member-1",
            path: memberDir,
            title: "warehouse",
            integrationBranch: "pickup-v2",
          },
        ]);
      }),
    );

    it.effect("expands a member path written with a home shorthand", () =>
      Effect.gen(function* () {
        // The client compares a member's path against the workspace root as
        // plain strings to drop a repository attached twice. That comparison is
        // only sound because a `~` spelling never reaches it: the two would
        // otherwise name one directory and render as two repositories, each
        // running every query a second time.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // `~` alone and `~/x` take different branches in the expansion, and a
        // real attach only ever produces the second.
        const home = NodeOS.homedir();
        const underHome = yield* fileSystem.makeTempDirectoryScoped({
          directory: home,
          prefix: "t3code-normalizer-home-",
        });
        const relativeToHome = path.relative(home, underHome);

        const normalized = yield* normalizeDispatchCommand(
          metaUpdateWithMembers([
            { id: "member-home", path: "~", title: "home", integrationBranch: "main" },
            {
              id: "member-under-home",
              path: `~/${relativeToHome}`,
              title: "under-home",
              integrationBranch: "main",
            },
          ]),
        );

        expect(readMembers(normalized)?.map((member) => member.path)).toEqual([home, underHome]);
      }),
    );

    it.effect("rejects a member path that does not exist", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* makeTempDir();

        const error = yield* normalizeDispatchCommand(
          metaUpdateWithMembers([
            {
              id: "member-1",
              path: path.join(baseDir, "missing"),
              title: "missing",
              integrationBranch: "pickup-v2",
            },
          ]),
        ).pipe(Effect.flip);

        expect(error.message).toContain("Workspace member 'missing'");
        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("rejects a member path that is a file rather than a directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* makeTempDir();
        const filePath = path.join(baseDir, "not-a-repo");
        yield* fileSystem.writeFileString(filePath, "");

        const error = yield* normalizeDispatchCommand(
          metaUpdateWithMembers([
            {
              id: "member-1",
              path: filePath,
              title: "not-a-repo",
              integrationBranch: "pickup-v2",
            },
          ]),
        ).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );

    // Two spellings of the same directory pass the client's exact-string
    // duplicate check; normalization collapses them, so the server is where
    // the duplicate has to be caught.
    it.effect("rejects two members that resolve to the same directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* makeTempDir();
        const memberDir = path.join(baseDir, "warehouse");
        yield* fileSystem.makeDirectory(memberDir, { recursive: true });

        const error = yield* normalizeDispatchCommand(
          metaUpdateWithMembers([
            {
              id: "member-1",
              path: memberDir,
              title: "warehouse",
              integrationBranch: "pickup-v2",
            },
            {
              id: "member-2",
              path: `${memberDir}/`,
              title: "warehouse",
              integrationBranch: "pickup-v2",
            },
          ]),
        ).pipe(Effect.flip);

        expect(error.message).toContain("is attached more than once");
      }),
    );

    it.effect("leaves a command without members untouched", () =>
      Effect.gen(function* () {
        const command: ClientOrchestrationCommand = {
          type: "project.meta.update",
          commandId: CommandId.make("command-2"),
          projectId: ProjectId.make("project-1"),
          title: "Renamed",
        };

        const normalized = yield* normalizeDispatchCommand(command);

        expect(readMembers(normalized)).toBeUndefined();
        expect(normalized).toEqual(command);
      }),
    );
  });
});
