import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type WorkspaceMember } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as WorkspaceMemberBranches from "./WorkspaceMemberBranches.ts";
import { makeWorkspaceMemberRpc } from "./WorkspaceMemberRpc.ts";

const projectId = ProjectId.make("project-members");
const threadId = ThreadId.make("thread-members");
const members: ReadonlyArray<WorkspaceMember> = ["api", "web", "worker", "docs"].map((name) => ({
  id: `member-${name}`,
  path: `/tmp/members/${name}`,
  title: name,
  integrationBranch: "main",
}));
const api = members[0]!;

const unusedBranches: WorkspaceMemberBranches.WorkspaceMemberBranches["Service"] = {
  inspect: () => Effect.die("inspect not expected"),
  ensureFeatureBranch: () => Effect.die("ensureFeatureBranch not expected"),
  resolvePrBase: () => Effect.die("resolvePrBase not expected"),
  readCheckpointStates: () => Effect.die("readCheckpointStates not expected"),
  writePrBase: () => Effect.die("writePrBase not expected"),
};

const makeRpc = (overrides: {
  readonly members?: ReadonlyArray<WorkspaceMember> | "unreadable";
  readonly threadProjectId?: ProjectId;
  readonly branches?: Partial<WorkspaceMemberBranches.WorkspaceMemberBranches["Service"]>;
  readonly refreshed?: Array<string>;
}) =>
  makeWorkspaceMemberRpc({
    readMembers: () =>
      overrides.members === "unreadable"
        ? Effect.fail("database locked")
        : Effect.succeed(overrides.members ?? members),
    readThread: () =>
      Effect.succeed({
        projectId: overrides.threadProjectId ?? projectId,
        title: "Members Thread",
      }),
    branches: { ...unusedBranches, ...overrides.branches },
    refreshLocalStatus: (cwd) => Effect.sync(() => overrides.refreshed?.push(cwd)),
  });

describe("WorkspaceMemberRpc", () => {
  it.effect("inspects members concurrently and answers in member order", () =>
    Effect.gen(function* () {
      let inFlight = 0;
      let peakInFlight = 0;
      const rpc = makeRpc({
        branches: {
          inspect: (input) =>
            Effect.gen(function* () {
              inFlight += 1;
              peakInFlight = Math.max(peakInFlight, inFlight);
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              inFlight -= 1;
              return { state: "idle" as const, branch: input.cwd, ownerThreadId: null };
            }),
        },
      });

      const result = yield* rpc.branches({ projectId, threadId });

      assert.isAbove(peakInFlight, 1);
      assert.deepEqual(
        result.reports.map((report) => [report.memberId, report.branch]),
        members.map((member) => [member.id, member.path]),
      );
    }),
  );

  it.effect("prepares a member in the project's directory and reports the branch it cut", () =>
    Effect.gen(function* () {
      const ensureCalls: Array<{ readonly cwd: string; readonly cutOn: string | undefined }> = [];
      const refreshed: Array<string> = [];
      const rpc = makeRpc({
        refreshed,
        branches: {
          ensureFeatureBranch: (input) =>
            Effect.sync(() => {
              ensureCalls.push({ cwd: input.cwd, cutOn: input.cutOn });
              return {
                state: "owned-by-self" as const,
                branch: "t3code/members-thread-abcd1234",
                ownerThreadId: threadId,
              };
            }),
          resolvePrBase: () =>
            Effect.succeed({
              branch: "t3code/members-thread-abcd1234",
              base: "pickup-v2",
              source: "configured" as const,
            }),
        },
      });

      const result = yield* rpc.actionPrepare({ projectId, threadId, memberId: api.id });

      assert.equal(result.report.memberId, api.id);
      assert.equal(result.report.branch, "t3code/members-thread-abcd1234");
      assert.equal(result.prBase?.base, "pickup-v2");
      // The directory comes from the project, never from the caller, and the git
      // panel's threshold counts untracked files where the sweep does not.
      assert.deepEqual(ensureCalls, [{ cwd: api.path, cutOn: "any" }]);
      assert.deepEqual(refreshed, [api.path]);
    }),
  );

  it.effect(
    "refuses to prepare a member for another project's thread, a detached one, or an unreadable project",
    () =>
      Effect.gen(function* () {
        const otherThread = yield* makeRpc({
          threadProjectId: ProjectId.make("project-elsewhere"),
        }).actionPrepare({ projectId, threadId, memberId: api.id });
        assert.equal(otherThread.report.state, "unavailable");
        assert.equal(otherThread.prBase, null);

        const detached = yield* makeRpc({ members: [] }).actionPrepare({
          projectId,
          threadId,
          memberId: api.id,
        });
        assert.include(detached.report.detail ?? "", "no longer attached");

        const unreadable = yield* makeRpc({ members: "unreadable" }).actionPrepare({
          projectId,
          threadId,
          memberId: api.id,
        });
        assert.include(unreadable.report.detail ?? "", "could not be read");
      }),
  );

  it.effect("writes a pull-request base only for the branch still checked out", () =>
    Effect.gen(function* () {
      const writes: Array<string> = [];
      const rpc = makeRpc({
        branches: {
          inspect: () =>
            Effect.succeed({
              state: "owned-by-self" as const,
              branch: "feature",
              ownerThreadId: null,
            }),
          writePrBase: (input) =>
            Effect.sync(() => {
              writes.push(`${input.cwd}:${input.branch}->${input.base}`);
              return true;
            }),
        },
      });
      const write = (branch: string, base: string) =>
        rpc.prBaseWrite({ projectId, memberId: api.id, branch, base });

      assert.deepEqual(yield* write("feature", "pickup-v2"), { written: true });
      assert.deepEqual(yield* write("moved-on", "pickup-v2"), { written: false });
      assert.deepEqual(yield* write("feature", "--upload-pack=x"), { written: false });
      assert.deepEqual(writes, [`${api.path}:feature->pickup-v2`]);
    }),
  );
});
