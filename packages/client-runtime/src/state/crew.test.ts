import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { CREW_LIST_QUERY_OPTIONS, CREW_LIST_REFRESH_MS, crewRolesByThread } from "./crew.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const task = (parent: string, crew: string, status: "open" | "closed") => ({
  parentThreadId: ThreadId.make(parent),
  crewThreadId: ThreadId.make(crew),
  status,
});

describe("crewRolesByThread", () => {
  it("names bridges of open tasks and crewmates of open and closed tasks", () => {
    const roles = crewRolesByThread([
      task("bridge-a", "crew-1", "open"),
      task("bridge-b", "crew-2", "closed"),
      task("crew-1", "crew-3", "open"),
    ]);
    expect(Object.fromEntries(roles)).toEqual({
      "bridge-a": "bridge",
      "crew-1": "crewmate",
      "crew-2": "crewmate-closed",
      "crew-3": "crewmate",
    });
    // A bridge whose only task closed is an ordinary thread again.
    expect(roles.has("bridge-b")).toBe(false);
  });
});

describe("crew list query", () => {
  it.effect("refreshes itself every 60s while anything reads it, with no caller driving it", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const environment = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("crew-environment"),
        label: "Crew environment",
        httpBaseUrl: "https://crew.example.test",
        wsBaseUrl: "wss://crew.example.test",
      });
      let executions = 0;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: environment,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            run,
            followStream,
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      );
      // The production options, with only the transport replaced.
      const family = createEnvironmentRpcQueryAtomFamily(runtime, {
        ...CREW_LIST_QUERY_OPTIONS,
        execute: () =>
          Effect.sync(() => {
            executions += 1;
            return { tasks: [] };
          }),
      });
      const atom = family({ environmentId: environment.environmentId, input: {} });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(atom);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmount();
          registry.dispose();
        }),
      );
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10));
      const first = executions;
      expect(first).toBeGreaterThan(0);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(CREW_LIST_REFRESH_MS * 3 + 10));
      expect(executions - first).toBe(3);
    }).pipe(Effect.scoped),
  );
});
