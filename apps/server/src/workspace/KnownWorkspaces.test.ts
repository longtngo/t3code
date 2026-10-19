import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

// FORK: workspace member repositories are writable workspaces of their project (invariant 6).
const makeLayer = (project: { readonly workspaceRoot: string; readonly memberPath: string }) =>
  KnownWorkspaces.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: "project-1",
              workspaceRoot: project.workspaceRoot,
              members: [
                {
                  id: "member-1",
                  path: project.memberPath,
                  title: "api",
                  integrationBranch: "main",
                },
              ],
            },
          ] as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          worktreesDirectory: "",
          previousWorktreesDirectories: [],
        } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-known-workspaces-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("KnownWorkspaces members", () => {
  it.effect("accepts a workspace member's folder and refuses an unrelated one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-known-workspaces-" }),
      );
      const workspaceRoot = path.join(base, "project");
      const memberPath = path.join(base, "member");
      const unrelated = path.join(base, "unrelated");
      for (const dir of [workspaceRoot, path.join(memberPath, "src"), unrelated]) {
        yield* fileSystem.makeDirectory(dir, { recursive: true });
      }

      const check = Effect.gen(function* () {
        const known = yield* KnownWorkspaces.KnownWorkspaces;
        return {
          member: yield* known.contains(path.join(memberPath, "src")),
          unrelated: yield* known.contains(unrelated),
        };
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, memberPath })));

      expect(yield* check).toEqual({ member: true, unrelated: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
