import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  hasCompatibleOrchestrationProtocol,
  refreshProvidersForRequest,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect("passes `fresh` through to every targeted provider refresh", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const registry = {
      refresh: () => Effect.sync(() => void calls.push(["all"])).pipe(Effect.as([])),
      refreshInstance: (instanceId: ProviderInstanceId, options?: { readonly fresh?: boolean }) =>
        Effect.sync(() => void calls.push(["instance", instanceId, options])).pipe(Effect.as([])),
      refreshWorkspaceSnapshot: (input: object) =>
        Effect.sync(() => void calls.push(["workspace", input])).pipe(Effect.as([])),
    };
    const instanceId = ProviderInstanceId.make("claudeAgent");
    yield* refreshProvidersForRequest(registry, { instanceId, fresh: true });
    yield* refreshProvidersForRequest(registry, { instanceId });
    yield* refreshProvidersForRequest(registry, { instanceId, cwd: "/repo", fresh: true });
    yield* refreshProvidersForRequest(registry, { fresh: true });
    assert.deepStrictEqual(calls, [
      ["instance", instanceId, { fresh: true }],
      ["instance", instanceId, { fresh: false }],
      ["workspace", { instanceId, cwd: "/repo", fresh: true }],
      ["all"],
    ]);
  }),
);
