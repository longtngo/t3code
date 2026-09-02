import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CrewTeardownHooksService } from "./CrewService.ts";
import { CrewTeardownHooksPartialLive } from "./CrewTeardownHooksLive.ts";

/**
 * These assert that the hooks reach the real services at all.
 *
 * The teardown flow is already covered in `CrewService.teardown.test.ts`, but it
 * ran green for the whole of Phase 1 against hooks that did nothing — a no-op
 * satisfies "teardown completed" exactly as well as a working one. What was
 * missing is any test that fails when a hook is not wired.
 */
const THREAD = ThreadId.make("crew-thread-1");

const withHooks = <E>(
  body: (calls: {
    readonly terminals: Array<string>;
    readonly stopped: Array<string>;
  }) => Effect.Effect<void, E, CrewTeardownHooksService>,
) =>
  Effect.suspend(() => {
    const terminals: Array<string> = [];
    const stopped: Array<string> = [];

    const terminalMock = Layer.succeed(TerminalManager, {
      close: (input: { readonly threadId: string; readonly terminalId?: string }) =>
        Effect.sync(() => {
          // `terminalId` omitted means "every session for this thread". If crew
          // ever starts passing one, this records it and the assertion below
          // fails rather than silently closing a single terminal.
          terminals.push(
            input.terminalId === undefined ? input.threadId : `one:${input.terminalId}`,
          );
        }),
    } as never);

    const providerMock = Layer.succeed(ProviderService, {
      stopSession: (input: { readonly threadId: string }) =>
        Effect.sync(() => void stopped.push(input.threadId)),
    } as never);

    return body({ terminals, stopped }).pipe(
      Effect.provide(
        CrewTeardownHooksPartialLive.pipe(
          Layer.provide(Layer.mergeAll(terminalMock, providerMock)),
        ),
      ),
    );
  });

describe("CrewTeardownHooksPartialLive", () => {
  it.effect("closeTerminals closes every terminal for the thread", () =>
    withHooks((calls) =>
      Effect.gen(function* () {
        const hooks = yield* CrewTeardownHooksService;
        yield* hooks.closeTerminals(THREAD);
        assert.deepStrictEqual(calls.terminals, [String(THREAD)]);
      }),
    ),
  );

  it.effect("stopSession stops the crewmate's provider session", () =>
    withHooks((calls) =>
      Effect.gen(function* () {
        const hooks = yield* CrewTeardownHooksService;
        yield* hooks.stopSession(THREAD);
        assert.deepStrictEqual(calls.stopped, [String(THREAD)]);
      }),
    ),
  );

  it.effect("a failing step surfaces as a failure, so the caller can record it", () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(ProviderService, {
        stopSession: () => Effect.fail({ _tag: "AdapterRefusedError" as const }),
      } as never);
      const terminals = Layer.succeed(TerminalManager, { close: () => Effect.void } as never);

      const exit = yield* Effect.gen(function* () {
        const hooks = yield* CrewTeardownHooksService;
        return yield* hooks.stopSession(THREAD);
      }).pipe(
        Effect.provide(
          CrewTeardownHooksPartialLive.pipe(Layer.provide(Layer.mergeAll(failing, terminals))),
        ),
        Effect.exit,
      );

      // If hooks swallowed their own errors, crew.teardown.step-failed.5 could
      // never fire and a failed stop would read as a clean teardown.
      assert.isTrue(exit._tag === "Failure");
    }),
  );
});
