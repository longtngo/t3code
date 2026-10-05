import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

describe("startup auto-pull budget", () => {
  const captureLogs = () => {
    const logs: Array<{ readonly message: unknown }> = [];
    const logger = Logger.make(({ message }) => {
      logs.push({ message });
    });
    return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
  };

  /** The `{ totalRoots, completedRoots }` payload of the budget warning, if it was logged. */
  const budgetWarning = (logs: ReadonlyArray<{ readonly message: unknown }>) => {
    const parts = logs.flatMap((entry) =>
      Array.isArray(entry.message) ? entry.message : [entry.message],
    );
    if (!parts.some((part) => typeof part === "string" && part.includes("startup budget"))) {
      return undefined;
    }
    return parts.find(
      (part): part is { budgetMs: number; totalRoots: number; completedRoots: number } =>
        typeof part === "object" && part !== null && "completedRoots" in part,
    );
  };

  it.effect("counts every root it finished, including skipped and failed ones", () =>
    Effect.gen(function* () {
      const git = {
        statusDetails: (cwd: string) =>
          Effect.succeed({
            isRepo: true,
            isDefaultBranch: true,
            hasUpstream: true,
            hasWorkingTreeChanges: false,
            aheadCount: 0,
            // `/current` is already up to date, so its body returns before pulling.
            behindCount: cwd === "/current" ? 0 : 1,
          } as never),
        pullCurrentBranch: (cwd: string) =>
          cwd === "/broken"
            ? Effect.fail(new Error("remote exploded") as never)
            : Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"];
      const project = (workspaceRoot: string) =>
        ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
      // Auto-pull moved off the project aggregate onto scoped server settings
      // (upstream #10636), so the opt-in has to come from the overrides record -
      // a legacy `autoPull: true` on the project is read by nothing and the phase
      // silently finds zero roots.
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          "/clean": { defaultAutoPull: true },
          "/current": { defaultAutoPull: true },
          "/broken": { defaultAutoPull: true },
        },
      };

      const progress = yield* Ref.make<ServerRuntimeStartup.AutoPullProgress>({
        total: 0,
        completed: 0,
      });
      yield* ServerRuntimeStartup.autoPullProjects(
        [project("/clean"), project("/current"), project("/broken")],
        settings,
        progress,
      ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

      // A failed root and a skipped root are both roots the phase is done with, so
      // the count answers "how far did it get", not "how many pulls succeeded".
      assert.deepStrictEqual(yield* Ref.get(progress), { total: 3, completed: 3 });
    }),
  );

  it.effect("a phase that finishes inside its budget logs nothing", () =>
    Effect.gen(function* () {
      const capture = captureLogs();
      const progress = yield* Ref.make<ServerRuntimeStartup.AutoPullProgress>({
        total: 2,
        completed: 2,
      });

      yield* ServerRuntimeStartup.runBoundedAutoPull(
        Effect.void,
        progress,
        Duration.seconds(20),
      ).pipe(Effect.provide(capture.layer));

      assert.strictEqual(budgetWarning(capture.logs), undefined);
    }),
  );

  it.effect("a phase that exceeds its budget warns with how far it got", () =>
    Effect.gen(function* () {
      const capture = captureLogs();
      const progress = yield* Ref.make<ServerRuntimeStartup.AutoPullProgress>({
        total: 0,
        completed: 0,
      });
      // Set once the roots are known, exactly as `autoPullProjects` does, so the
      // warning reports a partially-finished phase rather than an empty one.
      const phase = Ref.set(progress, { total: 7, completed: 3 }).pipe(
        Effect.andThen(Effect.never),
      );

      const fiber = yield* ServerRuntimeStartup.runBoundedAutoPull(
        phase,
        progress,
        Duration.seconds(20),
      ).pipe(Effect.provide(capture.layer), Effect.forkChild);
      yield* TestClock.adjust("21 seconds");
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(budgetWarning(capture.logs), {
        budgetMs: 20_000,
        totalRoots: 7,
        completedRoots: 3,
      });
    }),
  );

  it.effect("exceeding the budget interrupts the phase rather than leaving it running", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false);
      const progress = yield* Ref.make<ServerRuntimeStartup.AutoPullProgress>({
        total: 1,
        completed: 0,
      });
      // Standing in for a live `git` child: if the bound merely stopped waiting, this
      // would never run and the process would keep writing past the activation fence.
      const phase = Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)));

      const fiber = yield* ServerRuntimeStartup.runBoundedAutoPull(
        phase,
        progress,
        Duration.seconds(20),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("21 seconds");
      // Joining rather than awaiting: a timeout must not turn startup into a failure.
      yield* Fiber.join(fiber);

      assert.isTrue(yield* Ref.get(interrupted));
    }),
  );
});
