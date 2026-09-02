/**
 * The teardown hooks that reach outside the crew tables.
 *
 * Steps 3, 4 and 5 are live here. Step 2, `clearRecoveryRecord`, is not, and the
 * reason is structural rather than an oversight.
 *
 * `server.ts` composes with `A.pipe(Layer.provideMerge(B))`, where B provides
 * into A — so a consumer must sit EARLIER in the pipe than its providers. Crew
 * composes inside `ProviderRuntimeLayerLive`, which puts `ProviderService`
 * (same group) and `TerminalManager` (`TerminalLayerLive`, a later stage) on the
 * provider side of crew, where crew can consume them. `ProviderTurnStallWatchdog`
 * is produced by `ReactorLayerLive`, which is the HEAD of the runtime pipe, so
 * nothing composed after it can see it.
 *
 * Both obvious ways out were tried and measured, not reasoned about:
 *
 * - Requiring the watchdog from here leaks `ProviderService |
 *   ProviderTurnStallWatchdog` out of the server layer entirely — 88 typecheck
 *   errors, every caller of the server layer suddenly owing two services.
 * - Re-seating the crew layer at the head of the runtime pipe, ahead of
 *   `ReactorLayerLive`, makes the graph circular: inference collapses to `any`
 *   in the requirements channel.
 *
 * So step 2 stays a no-op until someone moves the watchdog, and the code says so
 * rather than implying all four hooks are wired. Its hazard has a backstop:
 * teardown's step 7 archives the thread, and the watchdog's resume branch now
 * refuses archived threads, which was the specific failure clearing the record
 * existed to prevent.
 *
 * `revokeActiveMcpThread` is a module-level function on the MCP session
 * registry, not a service, so it carries no layer requirement at all.
 *
 * Nothing here catches. Each hook's failure travels to the caller's
 * `crew.teardown.step-failed.<n>` record; swallowing it would make a failed step
 * indistinguishable from a successful one.
 *
 * @module crew/CrewTeardownHooksLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ThreadId } from "@t3tools/contracts";

import { revokeActiveMcpThread } from "../mcp/McpSessionRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import {
  CrewTeardownHookError,
  CrewTeardownHooksService,
  type CrewTeardownHooks,
} from "./CrewService.ts";

export const CrewTeardownHooksPartialLive = Layer.effect(CrewTeardownHooksService)(
  Effect.gen(function* () {
    const terminals = yield* TerminalManager;
    const providers = yield* ProviderService;

    // Each hook's own error type is discarded and replaced with the step it
    // failed at, which is all the caller records. The cause is not swallowed
    // silently: the failure still propagates, so `crew.teardown.step-failed.<n>`
    // fires.
    const asStep = (step: number, threadId: ThreadId) =>
      Effect.mapError(() => new CrewTeardownHookError({ step, threadId: String(threadId) }));

    return {
      // Step 2. See the module doc: the stall watchdog sits on the consumer side
      // of crew in the layer graph and cannot be reached from here.
      clearRecoveryRecord: () => Effect.void,
      // Step 3.
      revokeActiveMcpThread: (threadId) => revokeActiveMcpThread(threadId),
      // Step 4. `terminalId` omitted closes every session for the thread.
      closeTerminals: (threadId) => terminals.close({ threadId }).pipe(asStep(4, threadId)),
      // Step 5. Without this a torn-down crewmate's provider session keeps
      // running until the session reaper notices `crewRole` has become
      // `crewmate-closed`.
      stopSession: (threadId) => providers.stopSession({ threadId }).pipe(asStep(5, threadId)),
    } satisfies CrewTeardownHooks;
  }),
);
