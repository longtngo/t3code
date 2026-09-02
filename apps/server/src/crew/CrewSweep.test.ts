import {
  CrewReportId,
  CrewTaskId,
  ProjectId,
  ThreadId,
  type CrewReport,
  type CrewReportState,
  type CrewTask,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CrewLog, type CrewLogCode, type CrewLogFields } from "./CrewLog.ts";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";
import { CrewSweep, CrewSweepLive } from "./CrewSweep.ts";

const BRIDGE = ThreadId.make("bridge-1");
const CREWMATE = ThreadId.make("crew-1");
const TASK = CrewTaskId.make("task-1");

const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: TASK,
  parentThreadId: BRIDGE,
  crewThreadId: CREWMATE,
  projectId: ProjectId.make("project-1"),
  baseRef: null,
  branch: "crew/task-1",
  worktreePath: "/tmp/crew-task-1",
  provider: "claudeAgent" as CrewTask["provider"],
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

let reportTick = 0;
const makeReport = (state: CrewReportState, overrides: Partial<CrewReport> = {}): CrewReport => {
  reportTick += 1;
  return {
    reportId: CrewReportId.make(`report-${reportTick}`),
    taskId: TASK,
    state,
    note: `note ${reportTick}`,
    createdAt: `2026-09-02T00:00:${String(reportTick).padStart(2, "0")}.000Z`,
    notedAt: null,
    replyTo: null,
    ...overrides,
  };
};

interface HarnessOptions {
  /** Threads whose `appendSessionNote` lands. A non-Claude bridge lands none. */
  readonly appendsFor?: ReadonlyArray<ThreadId>;
  /** Threads that cannot start a turn right now. */
  readonly busy?: ReadonlyArray<ThreadId>;
  /** Threads with no shell at all. */
  readonly missing?: ReadonlyArray<ThreadId>;
  /** Threads whose shell is archived. */
  readonly archived?: ReadonlyArray<ThreadId>;
}

const harness = (options: HarnessOptions = {}) => {
  const appendsFor = new Set(options.appendsFor ?? []);
  const busy = new Set(options.busy ?? []);
  const missing = new Set(options.missing ?? []);
  const archived = new Set(options.archived ?? []);

  const appends: Array<{ threadId: string; text: string }> = [];
  const turns: Array<{ threadId: string; text: string }> = [];
  const records: Array<{ code: CrewLogCode; fields: CrewLogFields }> = [];
  const stopped: Array<string> = [];

  const shellFor = (threadId: ThreadId) =>
    missing.has(threadId)
      ? Option.none()
      : Option.some({
          id: threadId,
          archivedAt: archived.has(threadId) ? "2026-09-02T02:00:00.000Z" : null,
          session: { activeTurnId: null },
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        });

  const layer = CrewSweepLive.pipe(
    Layer.provideMerge(CrewRepositoryLive),
    Layer.provideMerge(
      Layer.succeed(CrewLog, {
        record: (code, fields) =>
          Effect.sync(() => void records.push({ code, fields: fields ?? {} })),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        appendSessionNote: ({ threadId, text }: { threadId: ThreadId; text: string }) =>
          Effect.sync(() => {
            const landed = appendsFor.has(threadId);
            if (landed) {
              appends.push({ threadId, text });
            }
            return landed;
          }),
        listSessions: () => Effect.succeed([]),
        stopSession: ({ threadId }: { threadId: ThreadId }) =>
          Effect.sync(() => void stopped.push(threadId)),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            if (command.type === "thread.turn.start") {
              turns.push({ threadId: command.threadId, text: command.message.text });
            }
            return { sequence: turns.length };
          }),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) => Effect.succeed(shellFor(threadId)),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionTurnRepository, {
        getPendingTurnStartByThreadId: ({ threadId }: { threadId: ThreadId }) =>
          Effect.succeed(busy.has(threadId) ? Option.some({ threadId } as never) : Option.none()),
      } as never),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  );

  const run = <E>(body: Effect.Effect<void, E, CrewSweep | CrewRepository | SqlClient.SqlClient>) =>
    Effect.gen(function* () {
      yield* runMigrations({});
      yield* body;
    }).pipe(Effect.provide(layer));

  return { run, appends, turns, records, stopped };
};

const codes = (records: ReadonlyArray<{ code: CrewLogCode }>) => records.map((r) => r.code);

describe("crew delivery sweep", () => {
  it.effect("a progress report on a live Claude bridge is noted with no turn started", () => {
    const h = harness({ appendsFor: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("progress"));

        yield* sweep.runOnce();

        assert.strictEqual(h.appends.length, 1);
        assert.deepStrictEqual(h.turns, []);
        assert.include(codes(h.records), "crew.deliver.no-turn");

        // Verbatim the failure that retired `deliveredAt`: a report appended but
        // never stamped re-selects and re-appends every 60s forever. The second
        // sweep is the assertion that matters.
        const remaining = yield* repository.selectUnnoted();
        assert.deepStrictEqual(remaining, []);

        h.records.length = 0;
        yield* sweep.runOnce();
        assert.strictEqual(h.appends.length, 1);
        assert.notInclude(codes(h.records), "crew.deliver.no-turn");
      }),
    );
  });

  it.effect("the note reaches the destination by exactly one channel", () => {
    const h = harness({ appendsFor: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("done"));

        yield* sweep.runOnce();

        // A wake carries a payload only for a report the append did not place.
        // Attaching one to text already in the transcript makes the bridge read
        // the same report twice in one turn, unable to tell that from two.
        assert.strictEqual(h.appends.length, 1);
        assert.strictEqual(h.turns.length, 1);
        assert.notInclude(h.turns[0]?.text ?? "", h.appends[0]?.text ?? "\0");
      }),
    );
  });

  it.effect("four done reports in one sweep are all appended and start one turn", () => {
    const h = harness({ appendsFor: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        for (let index = 0; index < 4; index += 1) {
          yield* repository.insertReport(makeReport("done"));
        }

        yield* sweep.runOnce();

        // A second dispatch would destroy the first: `replacePendingTurnStart`
        // clears every pending row for the thread before inserting.
        assert.strictEqual(h.turns.length, 1);
        assert.strictEqual(h.appends.length, 4);
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });

  it.effect("a non-Claude bridge with three progress plus one decision delivers all four", () => {
    const h = harness({ appendsFor: [] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        for (let index = 0; index < 3; index += 1) {
          yield* repository.insertReport(makeReport("progress"));
        }
        yield* repository.insertReport(makeReport("needs-decision"));

        yield* sweep.runOnce();

        // One turn for the destination, and the rest ride it. Without the
        // ride-along the later rows defer unappended, which is the revision-14
        // behaviour under a different cause.
        assert.strictEqual(h.turns.length, 1);
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });

  it.effect("a needs-decision report defers while the bridge is busy", () => {
    const h = harness({ appendsFor: [BRIDGE], busy: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("needs-decision"));

        yield* sweep.runOnce();

        // Deferred without appending and without stamping: a note is read on the
        // next turn or not at all, so appending before you can wake buys nothing.
        assert.include(codes(h.records), "crew.deliver.deferred.busy");
        assert.strictEqual(h.appends.length, 0);
        const stillPending = yield* repository.selectUnnoted();
        assert.strictEqual(stillPending.length, 1);
      }),
    );
  });

  it.effect("two consecutive sweeps with a fresh report each start two turns", () => {
    const h = harness({ appendsFor: [] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());

        yield* repository.insertReport(makeReport("done"));
        yield* sweep.runOnce();
        assert.strictEqual(h.turns.length, 1);

        // The ride-along set is per pass, not per boot.
        yield* repository.insertReport(makeReport("done"));
        yield* sweep.runOnce();
        assert.strictEqual(h.turns.length, 2);
      }),
    );
  });

  it.effect("an answer and a report in one pass wake two different threads", () => {
    const h = harness({ appendsFor: [] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        const decision = makeReport("needs-decision");
        yield* repository.insertReport(decision);
        yield* repository.insertReport(makeReport("answer", { replyTo: decision.reportId }));

        yield* sweep.runOnce();

        // Keyed on the bridge, the answer would ride the turn the report just
        // dispatched to a different thread, append false on a non-Claude
        // crewmate, and be stamped handled — the operator's answer silently lost
        // while the crewmate stays blocked holding a slot.
        const woken = h.turns.map((turn) => turn.threadId).sort();
        assert.deepStrictEqual(woken, ["bridge-1", "crew-1"]);
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });

  it.effect("a report whose destination is missing terminates on the first sweep", () => {
    const h = harness({ missing: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("progress"));

        yield* sweep.runOnce();

        // No grace period. Nothing in the schema can count sweeps, and both
        // implementable substitutes are wrong in a named way.
        assert.include(codes(h.records), "crew.deliver.abandoned");
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });

  it.effect("a report whose destination is archived terminates on the first sweep", () => {
    const h = harness({ archived: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("progress"));

        yield* sweep.runOnce();

        assert.include(codes(h.records), "crew.deliver.abandoned");
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });

  it.effect("a report on a closed task is still delivered", () => {
    const h = harness({ appendsFor: [BRIDGE] });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const sweep = yield* CrewSweep;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport("progress"));
        yield* repository.closeTask({ taskId: TASK, updatedAt: "2026-09-02T01:00:00.000Z" });

        yield* sweep.runOnce();

        // Dropping the `task.status = 'open'` conjunct is what makes teardown safe
        // without a drain step: a report filed one tick before the row closes is
        // still selected, and so is one on a task closed by the orphan reap.
        assert.strictEqual(h.appends.length, 1);
        assert.deepStrictEqual(yield* repository.selectUnnoted(), []);
      }),
    );
  });
});
