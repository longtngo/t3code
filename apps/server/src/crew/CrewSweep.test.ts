import { CrewReportId, CrewTaskId, ThreadId, type CrewReport } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CrewRepository } from "./CrewRepository.ts";
import {
  CREW_DELIVERY_QUOTED_BYTE_LIMIT,
  CrewSweep,
  CrewSweepLive,
  renderDelivery,
} from "./CrewSweep.ts";
import {
  BRIDGE,
  makeCrewHarness,
  makeTask,
  shellOf,
  withCrew,
  type CrewHarnessOptions,
} from "./crew.testkit.ts";

const CREWMATE = ThreadId.make("crew-1");
const TASK = CrewTaskId.make("task-1");

const report = (id: string, overrides: Partial<CrewReport> = {}): CrewReport => ({
  reportId: CrewReportId.make(id),
  taskId: TASK,
  state: "done",
  note: `note ${id}`,
  createdAt: `2026-09-02T00:00:0${id.length % 10}.000Z`,
  notedAt: null,
  replyTo: null,
  ...overrides,
});

const liveShells = () =>
  new Map([
    [BRIDGE as string, shellOf(BRIDGE)],
    [CREWMATE as string, shellOf(CREWMATE)],
  ]);

const sweep = Layer.build(CrewSweepLive).pipe(
  Effect.map((context) => Context.get(context, CrewSweep)),
);

const setup = (options: CrewHarnessOptions, reports: ReadonlyArray<CrewReport>) => {
  const harness = makeCrewHarness({ shells: liveShells(), ...options });
  const seed = Effect.gen(function* () {
    const repository = yield* CrewRepository;
    yield* repository.insertTask(makeTask());
    yield* Effect.forEach(reports, (row) => repository.insertReport(row), { discard: true });
  });
  return { harness, seed };
};

const unnotedIds = Effect.gen(function* () {
  const rows = yield* (yield* CrewRepository).selectUnnoted();
  return rows.map((row) => row.reportId as string);
});

describe("crew delivery on orchestrator v2", () => {
  it.effect("a done report is one queued message to the bridge, and is not re-sent", () => {
    const { harness, seed } = setup({}, [report("r1")]);
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        const crewSweep = yield* sweep;
        yield* crewSweep.runOnce();
        yield* crewSweep.runOnce();
        assert.strictEqual(harness.sends.length, 1);
        const sent = harness.sends[0]!;
        assert.strictEqual(sent.threadId, BRIDGE);
        assert.strictEqual(sent.mode, "queue");
        assert.include(sent.text, "note r1");
        assert.strictEqual(sent.senderThreadId, CREWMATE);
        assert.deepStrictEqual(yield* unnotedIds, []);
      }),
    );
  });

  it.effect("progress steers into a running bridge with no new turn", () => {
    const { harness, seed } = setup({}, [report("p1", { state: "progress" })]);
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        yield* (yield* sweep).runOnce();
        assert.strictEqual(harness.sends[0]?.mode, "steer");
        assert.include(harness.codes(), "crew.deliver.no-turn");
        assert.deepStrictEqual(yield* unnotedIds, []);
      }),
    );
  });

  it.effect(
    "progress on an idle bridge waits, then rides the next message that must be read",
    () => {
      let idle = true;
      const { harness, seed } = setup(
        { send: (input) => (input.mode === "steer" && idle ? "no-steerable-run" : "ok") },
        [report("p1", { state: "progress" })],
      );
      return withCrew(
        harness,
        Effect.gen(function* () {
          yield* seed;
          const crewSweep = yield* sweep;
          yield* crewSweep.runOnce();
          // Not delivered and not a failure: no turn is started for progress.
          assert.strictEqual(harness.sends.length, 0);
          assert.deepStrictEqual(yield* unnotedIds, ["p1"]);
          assert.notInclude(harness.codes(), "crew.deliver.failed");

          yield* (yield* CrewRepository).insertReport(report("d1"));
          idle = false;
          yield* crewSweep.runOnce();
          assert.strictEqual(harness.sends.length, 1);
          assert.strictEqual(harness.sends[0]?.mode, "queue");
          assert.include(harness.sends[0]?.text ?? "", "note p1");
          assert.include(harness.sends[0]?.text ?? "", "note d1");
          assert.deepStrictEqual(yield* unnotedIds, []);
        }),
      );
    },
  );

  it.effect("an answer and a report on one task go to two different threads", () => {
    const { harness, seed } = setup({}, [
      report("q1", { state: "needs-decision" }),
      report("a1", { state: "answer", replyTo: CrewReportId.make("q0") }),
    ]);
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        yield* (yield* sweep).runOnce();
        assert.deepStrictEqual(
          harness.sends.map((sent) => [sent.threadId, sent.mode]).toSorted(),
          [
            [BRIDGE, "queue"],
            [CREWMATE, "queue"],
          ].toSorted(),
        );
        const toCrewmate = harness.sends.find((sent) => sent.threadId === CREWMATE)!;
        assert.include(toCrewmate.text, "Crew answer");
        assert.strictEqual(toCrewmate.senderThreadId, BRIDGE);
      }),
    );
  });

  it.effect("a report filed just before teardown is still delivered after the task closes", () => {
    const { harness, seed } = setup({}, [report("r1")]);
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        yield* (yield* CrewRepository).closeTask({
          taskId: TASK,
          updatedAt: "2026-09-02T00:00:09.000Z",
        });
        yield* (yield* sweep).runOnce();
        assert.deepStrictEqual(
          harness.sends.map((sent) => sent.threadId),
          [BRIDGE],
        );
        assert.deepStrictEqual(yield* unnotedIds, []);
      }),
    );
  });

  it.effect("an archived destination abandons the row on the first pass", () => {
    const { harness, seed } = setup({}, [report("r1")]);
    harness.shells.set(
      BRIDGE,
      shellOf(BRIDGE, { archivedAt: DateTime.makeUnsafe("2026-09-02T00:00:00Z") }),
    );
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        const crewSweep = yield* sweep;
        yield* crewSweep.runOnce();
        yield* crewSweep.runOnce();
        assert.strictEqual(harness.attempts.length, 0);
        assert.deepStrictEqual(
          harness.records.filter((record) => record.code === "crew.deliver.abandoned").length,
          1,
        );
        assert.deepStrictEqual(yield* unnotedIds, []);
      }),
    );
  });

  it.effect("with crew switched off only answers are delivered", () => {
    const { harness, seed } = setup({ settings: { enableCrew: false } }, [
      report("r1"),
      report("a1", { state: "answer", replyTo: CrewReportId.make("q0") }),
    ]);
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        yield* (yield* sweep).runOnce();
        assert.deepStrictEqual(
          harness.sends.map((sent) => sent.threadId),
          [CREWMATE],
        );
        assert.deepStrictEqual(yield* unnotedIds, ["r1"]);
      }),
    );
  });

  it.effect("a refusing destination keeps its rows, logs once, and does not block another", () => {
    // Multi-unit: two destinations in one pass, the first refuses.
    const { harness, seed } = setup(
      { send: (input) => (input.threadId === BRIDGE ? "fail" : "ok") },
      [report("r1"), report("a1", { state: "answer", replyTo: CrewReportId.make("q0") })],
    );
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        const crewSweep = yield* sweep;
        yield* crewSweep.runOnce();
        yield* crewSweep.runOnce();
        assert.deepStrictEqual(
          harness.sends.map((sent) => sent.threadId),
          [CREWMATE],
        );
        assert.deepStrictEqual(yield* unnotedIds, ["r1"]);
        assert.strictEqual(
          harness.records.filter((record) => record.code === "crew.deliver.failed").length,
          1,
        );
      }),
    );
  });

  it.effect("the same set of reports derives the same command id on a retry", () => {
    const { harness, seed } = setup(
      { send: () => (harness.attempts.length === 1 ? "fail" : "ok") },
      [report("r1"), report("r2")],
    );
    return withCrew(
      harness,
      Effect.gen(function* () {
        yield* seed;
        const crewSweep = yield* sweep;
        yield* crewSweep.runOnce();
        yield* crewSweep.runOnce();
        assert.strictEqual(harness.attempts.length, 2);
        assert.strictEqual(harness.attempts[0]?.commandId, harness.attempts[1]?.commandId);
        assert.strictEqual(harness.attempts[0]?.messageId, harness.attempts[1]?.messageId);
      }),
    );
  });

  it.effect(
    "the boot reap closes rows whose crew thread is gone, and only rows from before boot",
    () => {
      const harness = makeCrewHarness({ shells: new Map([[BRIDGE as string, shellOf(BRIDGE)]]) });
      return withCrew(
        harness,
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          // Before boot. The test clock starts at the epoch, so "before" is pre-1970.
          yield* repository.insertTask(makeTask({ createdAt: "1969-12-31T00:00:00.000Z" }));
          const crewSweep = yield* sweep;
          // Reserved after boot, before its launch created the thread: not an orphan.
          yield* repository.insertTask(
            makeTask({
              taskId: CrewTaskId.make("task-2"),
              crewThreadId: ThreadId.make("crew-2"),
              createdAt: "2999-01-01T00:00:00.000Z",
            }),
          );
          yield* crewSweep.reapOrphans();
          const statuses = (yield* repository.listAllTasks()).map((task) => [
            task.taskId,
            task.status,
          ]);
          assert.deepStrictEqual(statuses, [
            ["task-1", "closed"],
            ["task-2", "open"],
          ]);
          assert.deepStrictEqual(
            harness.codes().filter((code) => code === "crew.reap.orphan"),
            ["crew.reap.orphan"],
          );
        }),
      );
    },
  );
});

describe("renderDelivery", () => {
  it("quotes up to the byte budget and names the rest", () => {
    const task = makeTask();
    const rows = Array.from({ length: 12 }, (_, index) => ({
      report: report(`r${index}`, { note: "x".repeat(1000) }),
      task,
    }));
    const text = renderDelivery(rows);
    assert.isAtMost(new TextEncoder().encode(text).length, CREW_DELIVERY_QUOTED_BYTE_LIMIT + 200);
    assert.match(text, /…and \d+ more crew reports\. Read them with crew_status\./);
    assert.include(text, "report r0");
  });
});
