import {
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

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
