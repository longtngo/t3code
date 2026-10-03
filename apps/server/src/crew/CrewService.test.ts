import {
  CrewDispatchRefusedError,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CrewRepository } from "./CrewRepository.ts";
import { CrewService, CrewServiceLive } from "./CrewService.ts";
import { makeCrewTeardown } from "./CrewTeardown.ts";
import {
  BRIDGE,
  CREW_BRANCH,
  makeCrewHarness,
  makeTask,
  shellOf,
  withCrew,
} from "./crew.testkit.ts";

const bridgeShells = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  new Map([[BRIDGE as string, shellOf(BRIDGE, overrides)]]);

const service = (env: Record<string, string | undefined> = {}) =>
  Layer.build(CrewServiceLive({ env })).pipe(
    Effect.map((context) => Context.get(context, CrewService)),
  );

describe("crew_dispatch on orchestrator v2", () => {
  it.effect("launches the crewmate through ThreadLaunchService into its own worktree", () => {
    const harness = makeCrewHarness({ shells: bridgeShells() });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        const result = yield* crew.dispatch({ prompt: "fix the bug" }, BRIDGE);

        assert.strictEqual(harness.launches.length, 1);
        const launch = harness.launches[0]!;
        assert.strictEqual(launch.threadId, result.crewThreadId);
        assert.deepStrictEqual(launch.workspaceStrategy, {
          type: "worktree",
          baseRef: "HEAD",
          branch: `crew/${result.taskId}`,
          path: result.worktreePath,
        });
        assert.isTrue(result.worktreePath.endsWith(`/worktrees/crew/${result.taskId}`));
        assert.strictEqual(launch.initialMessage?.text, "fix the bug");
        assert.strictEqual(launch.initialMessage?.senderThreadId, BRIDGE);
        assert.deepStrictEqual(yield* crew.openSlots(), { open: 1, limit: 4 });
        // The reservation names the real path and branch before the launch runs.
        const row = yield* (yield* CrewRepository).getTaskByCrewThreadId({
          crewThreadId: result.crewThreadId,
        });
        assert.strictEqual(
          row._tag === "Some" ? row.value.worktreePath : null,
          result.worktreePath,
        );
      }),
    );
  });

  it.effect("a failed launch closes the row, frees the slot, and the next dispatch works", () => {
    // Multi-unit: the first unit fails, and the failure must not leak into the second.
    const outcomes: Array<"ok" | "fail"> = ["fail", "ok"];
    const harness = makeCrewHarness({ shells: bridgeShells(), launch: () => outcomes.shift()! });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        const refused = yield* Effect.flip(crew.dispatch({ prompt: "one" }, BRIDGE));
        assert.strictEqual(refused.reason, "thread");
        assert.include(harness.codes(), "crew.dispatch.compensate.skipped");
        assert.deepStrictEqual(yield* crew.openSlots(), { open: 0, limit: 4 });
        yield* crew.dispatch({ prompt: "two" }, BRIDGE);
        assert.deepStrictEqual(yield* crew.openSlots(), { open: 1, limit: 4 });
        // The failed task's row survives, closed: crew deletes nothing.
        const rows = yield* (yield* CrewRepository).listAllTasks();
        assert.deepStrictEqual(rows.map((row) => row.status).toSorted(), ["closed", "open"]);
      }),
    );
  });

  it.effect.each([
    ["disabled", { settings: { enableCrew: false } }, {}, "crew.dispatch.refused.disabled"],
    [
      "browser-access",
      { settings: { browserAccess: false } },
      {},
      "crew.dispatch.refused.browser-access",
    ],
    [
      "thread (archived)",
      {},
      { archivedAt: DateTime.makeUnsafe("2026-09-02T00:00:00Z") },
      "crew.dispatch.refused.thread",
    ],
    [
      "thread (deleted)",
      {},
      { deletedAt: DateTime.makeUnsafe("2026-09-02T00:00:00Z") },
      "crew.dispatch.refused.thread",
    ],
  ] as const)("refuses %s with a code and a non-empty message", ([, options, shell, code]) => {
    const harness = makeCrewHarness({ ...options, shells: bridgeShells(shell) });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        const refused = yield* Effect.flip(crew.dispatch({ prompt: "x" }, BRIDGE));
        assert.instanceOf(refused, CrewDispatchRefusedError);
        assert.isAbove(refused.message.length, 0);
        assert.include(harness.codes(), code);
        assert.strictEqual(harness.launches.length, 0);
      }),
    );
  });

  it.effect("refuses OpenCode, an oversized prompt, and a missing caller", () => {
    const harness = makeCrewHarness({ shells: bridgeShells() });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        yield* Effect.flip(crew.dispatch({ prompt: "x", provider: "opencode" }, BRIDGE));
        yield* Effect.flip(crew.dispatch({ prompt: "x".repeat(8 * 1024 + 1) }, BRIDGE));
        yield* Effect.flip(crew.dispatch({ prompt: "x" }, ThreadId.make("nobody")));
        assert.deepStrictEqual(
          harness.codes().filter((code) => code.startsWith("crew.dispatch.refused.")),
          [
            "crew.dispatch.refused.provider",
            "crew.dispatch.refused.payload",
            "crew.dispatch.refused.thread",
          ],
        );
      }),
    );
  });

  it.effect("the cap counts open rows; teardown frees the slot for the next dispatch", () => {
    const harness = makeCrewHarness({ shells: bridgeShells() });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service({ T3CODE_CREW_MAX_CONCURRENT_TASKS: "1" });
        const first = yield* crew.dispatch({ prompt: "one" }, BRIDGE);
        const refused = yield* Effect.flip(crew.dispatch({ prompt: "two" }, BRIDGE));
        assert.strictEqual(refused.reason, "cap");
        assert.include(refused.message, "cap of 1");
        yield* crew.teardown({ taskId: first.taskId }, BRIDGE);
        yield* crew.dispatch({ prompt: "three" }, BRIDGE);
        assert.strictEqual(harness.launches.length, 2);
      }),
    );
  });

  it.effect("a crewmate cannot dispatch, even after its task closed", () => {
    const harness = makeCrewHarness({ shells: bridgeShells() });
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        const first = yield* crew.dispatch({ prompt: "one" }, BRIDGE);
        yield* crew.teardown({ taskId: first.taskId }, BRIDGE);
        harness.shells.set(first.crewThreadId, shellOf(first.crewThreadId));
        const refused = yield* Effect.flip(crew.dispatch({ prompt: "x" }, first.crewThreadId));
        assert.strictEqual(refused.reason, "nested");
      }),
    );
  });
});

describe("crew_dispatch from inside a crewmate", () => {
  it.effect("a thread descended from a crewmate is refused as nested", () => {
    // Multi-unit: a delegated child (lineage only), a created thread (branch only, no
    // lineage), a grandchild of a crewmate, and an ordinary thread with a plain parent.
    const crewmate = ThreadId.make("crew-1");
    const lineage = (parent: string | null) => ({
      lineage: {
        parentThreadId: parent === null ? null : ThreadId.make(parent),
        relationshipToParent: parent === null ? null : "subagent",
        rootThreadId: ThreadId.make(parent ?? "root"),
      },
    });
    const harness = makeCrewHarness({
      shells: new Map<string, OrchestrationV2ThreadShell>([
        [BRIDGE as string, shellOf(BRIDGE, { ...lineage(null), branch: null } as never)],
        [crewmate as string, shellOf(crewmate, { ...lineage(null), branch: null } as never)],
        [
          "delegated",
          shellOf(ThreadId.make("delegated"), { ...lineage("crew-1"), branch: null } as never),
        ],
        [
          "grandchild",
          shellOf(ThreadId.make("grandchild"), { ...lineage("delegated"), branch: null } as never),
        ],
        [
          "created",
          shellOf(ThreadId.make("created"), { ...lineage(null), branch: CREW_BRANCH } as never),
        ],
        [
          "own-crew-branch",
          shellOf(ThreadId.make("own-crew-branch"), {
            ...lineage(null),
            branch: "crew/my-feature",
          } as never),
        ],
        [
          "unknown-crew-uuid",
          shellOf(ThreadId.make("unknown-crew-uuid"), {
            ...lineage(null),
            branch: "crew/00000000-0000-4000-8000-0000000000ff",
          } as never),
        ],
        [
          "plain-child",
          shellOf(ThreadId.make("plain-child"), { ...lineage("bridge-1"), branch: null } as never),
        ],
      ]),
    });
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const crew = yield* service();
        for (const caller of ["delegated", "grandchild", "created"]) {
          const refused = yield* Effect.flip(crew.dispatch({ prompt: "x" }, ThreadId.make(caller)));
          assert.strictEqual(refused.reason, "nested", caller);
        }
        // A user's own crew/ branch, and the exact shape with no crew row, are not crewmates.
        for (const caller of ["own-crew-branch", "unknown-crew-uuid", "plain-child"]) {
          const allowed = yield* crew.dispatch({ prompt: "x" }, ThreadId.make(caller));
          assert.isString(allowed.taskId, caller);
        }
      }),
    );
  });
});

describe("crew teardown on orchestrator v2", () => {
  it.effect("runs the seven steps, only live sessions released, the branch kept", () => {
    const crewmate = ThreadId.make("crew-1");
    const harness = makeCrewHarness({
      shells: new Map([
        [BRIDGE as string, shellOf(BRIDGE)],
        [crewmate as string, shellOf(crewmate, { status: "running" })],
      ]),
    });
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const crew = yield* service();
        yield* crew.teardown({ taskId: makeTask().taskId }, BRIDGE);
        assert.deepStrictEqual(harness.calls, [
          "2:interrupt:crew-1",
          "3:revoke:crew-1",
          "4:terminals:crew-1",
          // Only the live session; a stopped one has nothing to release.
          "5:detach:session-crew-1",
          "6:thread.metadata.update:crew-1",
          "7:thread.archive:crew-1",
        ]);
        // Step 6 forgets the worktree but keeps the `crew/` branch, the shell's crew marker.
        const forget = harness.commands.find(
          (command) => command.type === "thread.metadata.update",
        );
        assert.deepInclude(forget, { worktreePath: null });
        assert.notProperty(forget, "branch");
        assert.deepStrictEqual(yield* crew.openSlots(), { open: 0, limit: 4 });
      }),
    );
  });

  it.effect("every failing step is logged and the slot is still freed", () => {
    const crewmate = ThreadId.make("crew-1");
    const harness = makeCrewHarness({
      shells: new Map([
        [BRIDGE as string, shellOf(BRIDGE)],
        [crewmate as string, shellOf(crewmate)],
      ]),
      failSteps: new Set([2, 3, 4, 5, 6, 7]),
    });
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const crew = yield* service();
        yield* crew.teardown({ taskId: makeTask().taskId }, BRIDGE);
        assert.deepStrictEqual(
          harness.codes().filter((code) => code.startsWith("crew.teardown.")),
          [2, 3, 4, 5, 6, 7].map((step) => `crew.teardown.step-failed.${step}`),
        );
        assert.deepStrictEqual(yield* crew.openSlots(), { open: 0, limit: 4 });
      }),
    );
  });

  it.effect(
    "skips archive for an archived crewmate, and refuses a task the caller does not own",
    () => {
      const crewmate = ThreadId.make("crew-1");
      const harness = makeCrewHarness({
        shells: new Map([
          [BRIDGE as string, shellOf(BRIDGE)],
          [
            crewmate as string,
            shellOf(crewmate, { archivedAt: DateTime.makeUnsafe("2026-09-02T00:00:00Z") }),
          ],
        ]),
      });
      return withCrew(
        harness,
        Effect.gen(function* () {
          yield* (yield* CrewRepository).insertTask(makeTask());
          const crew = yield* service();
          const refused = yield* Effect.flip(
            crew.teardown({ taskId: makeTask().taskId }, ThreadId.make("someone-else")),
          );
          assert.strictEqual(refused._tag, "CrewTaskNotFoundError");
          assert.include(harness.codes(), "crew.tool.refused.crew_teardown.no-row");
          yield* crew.teardown({ taskId: makeTask().taskId }, BRIDGE);
          assert.notInclude(harness.calls.join(" "), "thread.archive");
        }),
      );
    },
  );
});

describe("crew teardown retries", () => {
  it.effect("a step rejected once completes when teardown is re-run", () => {
    // Multi-run: the first run's archive and metadata write are rejected, which leaves a
    // rejected receipt on their ids. A re-run must not replay those receipts.
    const crewmate = ThreadId.make("crew-1");
    let firstRun = true;
    const harness = makeCrewHarness({
      shells: new Map([
        [BRIDGE as string, shellOf(BRIDGE)],
        [crewmate as string, shellOf(crewmate)],
      ]),
      rejectStep: () => firstRun,
    });
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const runTeardown = yield* makeCrewTeardown;
        yield* runTeardown(makeTask());
        assert.notInclude(harness.calls.join(" "), "thread.archive");
        firstRun = false;
        yield* runTeardown(makeTask({ status: "closed" }));
        assert.includeMembers(harness.calls, [
          "6:thread.metadata.update:crew-1",
          "7:thread.archive:crew-1",
        ]);
      }),
    );
  });

  it.effect("crew_teardown acts on open rows only", () => {
    const harness = makeCrewHarness({ shells: bridgeShells() });
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const crew = yield* service();
        yield* crew.teardown({ taskId: makeTask().taskId }, BRIDGE);
        const again = yield* Effect.flip(crew.teardown({ taskId: makeTask().taskId }, BRIDGE));
        assert.strictEqual(again._tag, "CrewTaskNotFoundError");
        assert.strictEqual(harness.calls.filter((call) => call.startsWith("2:")).length, 1);
      }),
    );
  });
});

describe("crew_report and crew_answer authority", () => {
  it.effect("refuses a report from a thread with no open task, and a bad state", () => {
    const harness = makeCrewHarness();
    return withCrew(
      harness,
      Effect.gen(function* () {
        const crew = yield* service();
        const noRow = yield* Effect.flip(crew.report({ state: "done", note: "x" }, BRIDGE));
        assert.strictEqual(noRow._tag, "CrewTaskNotFoundError");
        yield* (yield* CrewRepository).insertTask(makeTask());
        const bad = yield* Effect.flip(
          crew.report({ state: "answer", note: "x" }, ThreadId.make("crew-1")),
        );
        assert.strictEqual(bad._tag, "CrewReportRefusedError");
        assert.deepStrictEqual(
          harness.codes().filter((code) => code.startsWith("crew.tool.refused.")),
          ["crew.tool.refused.crew_report.no-row", "crew.tool.refused.crew_report.bad-state"],
        );
      }),
    );
  });

  it.effect("a report is answered once, by the bridge only", () => {
    const harness = makeCrewHarness();
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* (yield* CrewRepository).insertTask(makeTask());
        const crew = yield* service();
        const reportId = yield* crew.report(
          { state: "needs-decision", note: "which way?" },
          ThreadId.make("crew-1"),
        );
        const stranger = yield* Effect.flip(
          crew.answer({ reportId, text: "left" }, ThreadId.make("crew-1")),
        );
        assert.strictEqual(stranger._tag, "CrewTaskNotFoundError");
        yield* crew.answer({ reportId, text: "left" }, BRIDGE);
        const twice = yield* Effect.flip(crew.answer({ reportId, text: "right" }, BRIDGE));
        assert.strictEqual(twice._tag, "CrewAlreadyAnsweredError");
        const answers = (yield* (yield* CrewRepository).listReports()).filter(
          (report) => report.replyTo === reportId,
        );
        assert.strictEqual(answers.length, 1);
        assert.strictEqual(answers[0]?.note, "left");
      }),
    );
  });
});
