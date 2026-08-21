import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { it as itEffect } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { planBootReconciliation, reconcileInterruptedTurnsOnBoot } from "./BootTurnReconciler.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-06-23T12:00:00.000Z";
const LATER = "2026-06-23T18:30:00.000Z";

const shell = (
  id: string,
  sessionStatus: OrchestrationSessionStatus | null,
  activeTurnId: string | null = null,
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    session:
      sessionStatus === null
        ? null
        : {
            threadId: ThreadId.make(id),
            status: sessionStatus,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
            lastError: null,
            updatedAt: NOW,
          },
  }) as unknown as OrchestrationThreadShell;

describe("planBootReconciliation", () => {
  it("clears each live-status session to stopped with activeTurnId null", () => {
    const commands = planBootReconciliation([shell("t1", "running")], NOW);
    const setCmd = commands.find((c) => c.type === "thread.session.set");
    expect(setCmd).toBeDefined();
    if (setCmd?.type === "thread.session.set") {
      expect(setCmd.session.status).toBe("stopped");
      expect(setCmd.session.activeTurnId).toBeNull();
      expect(setCmd.session.providerName).toBe("claudeAgent");
      expect(setCmd.threadId).toBe("t1");
    }
  });

  it("interrupts the active turn when one was running", () => {
    const commands = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    const interrupt = commands.find((c) => c.type === "thread.turn.interrupt");
    expect(interrupt).toBeDefined();
    if (interrupt?.type === "thread.turn.interrupt") {
      expect(interrupt.turnId).toBe("turn-1");
      expect(interrupt.threadId).toBe("t1");
    }
  });

  it("emits no interrupt when there is no active turn", () => {
    const commands = planBootReconciliation([shell("t1", "ready", null)], NOW);
    expect(commands.some((c) => c.type === "thread.turn.interrupt")).toBe(false);
    expect(commands.some((c) => c.type === "thread.session.set")).toBe(true);
  });

  it("reconciles every live status (idle/starting/running/ready)", () => {
    const live: OrchestrationSessionStatus[] = ["idle", "starting", "running", "ready"];
    const commands = planBootReconciliation(
      live.map((s, i) => shell(`t${i}`, s)),
      NOW,
    );
    expect(commands.filter((c) => c.type === "thread.session.set")).toHaveLength(live.length);
  });

  it("ignores already-resting sessions (stopped/error/interrupted) and missing sessions", () => {
    const resting: Array<OrchestrationSessionStatus | null> = [
      "stopped",
      "error",
      "interrupted",
      null,
    ];
    const commands = planBootReconciliation(
      resting.map((s, i) => shell(`t${i}`, s)),
      NOW,
    );
    expect(commands).toHaveLength(0);
  });

  it("uses the provided timestamp for createdAt and updatedAt", () => {
    const commands = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    for (const command of commands) {
      expect(command.createdAt).toBe(NOW);
    }
  });

  // Command ids are keyed into a receipt table that is never pruned, and the
  // engine replays an accepted receipt instead of deciding. A thread-scoped id
  // therefore reconciles a thread once ever; every later boot silently no-ops.
  it("mints a fresh command id per boot so a later boot is not deduped away", () => {
    const first = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    const second = planBootReconciliation([shell("t1", "running", "turn-1")], LATER);
    expect(second).toHaveLength(first.length);
    for (const [index, command] of second.entries()) {
      expect(command.commandId).not.toBe(first[index]?.commandId);
    }
  });

  // The other half of the invariant: within one boot the ids must stay stable,
  // so a genuine retry of the same reconciliation still dedupes.
  it("keeps command ids stable within a single boot", () => {
    const a = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    const b = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    expect(b.map((command) => command.commandId)).toEqual(a.map((command) => command.commandId));
  });
});

/**
 * Ported from upstream's `serverRuntimeStartup.reconcile.test.ts` (#7719), whose
 * reconciler this fork retired in favour of `reconcileInterruptedTurnsOnBoot`
 * (see docs/fork/README.md invariant 5c). The subject still applies: the binding
 * cleanup is best-effort, so a missing, unreadable, or unwritable binding must
 * never stop the session projection from being settled — that projection is what
 * clears the client's "Working" spinner.
 */
describe("reconcileInterruptedTurnsOnBoot binding resilience", () => {
  const bindingFailure = (operation: string) =>
    new ProviderSessionDirectoryPersistenceError({ operation, detail: "boot-reconcile test" });

  const binding = (threadId: ThreadId): ProviderRuntimeBinding =>
    ({
      threadId,
      provider: "codex",
      providerInstanceId: "codex",
      status: "running",
      resumeCursor: "cursor-keep",
      runtimePayload: { activeTurnId: "stale", unrelated: "keep" },
    }) as unknown as ProviderRuntimeBinding;

  const directoryOf = (
    parts: Pick<ProviderSessionDirectoryShape, "getBinding" | "upsert">,
  ): ProviderSessionDirectoryShape => ({
    ...parts,
    getProvider: () => Effect.die("unused"),
    listThreadIds: () => Effect.die("unused"),
    listBindings: () => Effect.die("unused"),
  });

  const run = (directory: ProviderSessionDirectoryShape) => {
    const dispatched: OrchestrationCommand[] = [];
    const threads = [
      shell("thread-binding-absent", "starting"),
      shell("thread-binding-unreadable", "running"),
      shell("thread-binding-unwritable", "ready"),
    ];
    return reconcileInterruptedTurnsOnBoot().pipe(
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineService["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.succeed({ threads }),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderSessionDirectory, directory),
      Effect.map(() => dispatched),
      Effect.runPromise,
    );
  };

  it("settles every session even when bindings are absent, unreadable, or unwritable", async () => {
    const dispatched = await run(
      directoryOf({
        getBinding: (threadId) =>
          threadId === "thread-binding-absent"
            ? Effect.succeed(Option.none())
            : threadId === "thread-binding-unreadable"
              ? Effect.fail(bindingFailure("ProviderSessionDirectory.getBinding"))
              : Effect.succeed(Option.some(binding(threadId))),
        upsert: () => Effect.fail(bindingFailure("ProviderSessionDirectory.upsert")),
      }),
    );

    expect(
      dispatched
        .filter((command) => command.type === "thread.session.set")
        .map((command) => command.threadId),
    ).toEqual(["thread-binding-absent", "thread-binding-unreadable", "thread-binding-unwritable"]);
  });

  it("clears status and activeTurnId on a healthy binding", async () => {
    const upserts: ProviderRuntimeBinding[] = [];
    await run(
      directoryOf({
        getBinding: (threadId) => Effect.succeed(Option.some(binding(threadId))),
        upsert: (written) =>
          Effect.sync(() => {
            upserts.push(written);
          }),
      }),
    );

    expect(upserts).toHaveLength(3);
    for (const written of upserts) {
      expect(written.status).toBe("stopped");
      expect(written.runtimePayload).toEqual({ activeTurnId: null });
      // `upsert` merges runtimePayload and preserves resumeCursor, so the
      // reconciler deliberately does not restate them.
      expect(written.resumeCursor).toBe("cursor-keep");
    }
  });
});

/**
 * The stubbed engine above cannot catch a receipt collision — it has no receipt
 * table, so it can never dedupe and is green by construction. This exercises the
 * real engine over a real receipt repository across two boots, which is the only
 * arrangement in which the bug is visible: a thread reconciled on one boot and
 * orphaned again must still reconcile on the next.
 */
const PROJECT = ProjectId.make("project-boot-reconcile");
const THREAD = ThreadId.make("thread-boot-reconcile");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const bootReconcileLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boot-reconcile-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Put the thread back into the orphaned state a hard restart leaves behind. */
const orphan = (turnId: string, at: string): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: CommandId.make(`orphan-${turnId}`),
  threadId: THREAD,
  session: {
    threadId: THREAD,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: TurnId.make(turnId),
    lastError: null,
    updatedAt: at,
  },
  createdAt: at,
});

itEffect.layer(bootReconcileLayer)("reconcileInterruptedTurnsOnBoot across boots", (it) => {
  it.effect("clears the spinner again on a later boot of an already-reconciled thread", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;

      const currentSession = Effect.gen(function* () {
        const snapshot = yield* query.getShellSnapshot();
        return snapshot.threads.find((entry) => entry.id === THREAD)?.session ?? null;
      });

      /** One boot: plan from the live shell state and dispatch what it produces. */
      const reconcileAt = (at: string) =>
        Effect.gen(function* () {
          const session = yield* currentSession;
          const commands = planBootReconciliation(
            [{ id: THREAD, session } as OrchestrationThreadShell],
            at,
          );
          for (const command of commands) {
            yield* engine.dispatch(command);
          }
        });

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-boot-reconcile-project"),
        projectId: PROJECT,
        title: "Boot Reconcile",
        workspaceRoot: "/tmp/project-boot-reconcile",
        defaultModelSelection: MODEL,
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-boot-reconcile-thread"),
        threadId: THREAD,
        projectId: PROJECT,
        title: "Boot Reconcile",
        modelSelection: MODEL,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });

      // Boot 1: orphaned by a restart, then reconciled.
      yield* engine.dispatch(orphan("turn-1", NOW));
      expect((yield* currentSession)?.status).toBe("running");
      yield* reconcileAt(NOW);
      expect((yield* currentSession)?.status).toBe("stopped");
      expect((yield* currentSession)?.activeTurnId).toBeNull();

      // Boot 2: the same thread is orphaned again. A thread-scoped command id
      // already has an accepted receipt by now, so the engine would replay it
      // and leave the session running.
      yield* engine.dispatch(orphan("turn-2", LATER));
      expect((yield* currentSession)?.status).toBe("running");
      yield* reconcileAt(LATER);
      expect((yield* currentSession)?.status).toBe("stopped");
      expect((yield* currentSession)?.activeTurnId).toBeNull();
    }),
  );
});
