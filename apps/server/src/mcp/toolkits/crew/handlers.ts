/**
 * Handlers for the crew toolkit: unwrap the tool input, call `CrewService`.
 *
 * @module mcp/toolkits/crew/handlers
 */
import * as Effect from "effect/Effect";

import { CrewService } from "../../../crew/CrewService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { CrewToolkit } from "./tools.ts";

/**
 * The calling thread comes from the invocation context, never from the tool
 * input.
 *
 * Every crew authority check keys on it — a crewmate may not dispatch, a bridge
 * may only tear down its own rows — so a thread id an agent could pass is a
 * thread id an agent could forge. `McpInvocationContext` is populated by the MCP
 * layer from the authenticated session.
 */
const caller = Effect.map(McpInvocationContext, (context) => context.threadId);

export const CrewToolkitLayer = CrewToolkit.toLayer(
  Effect.sync(() => {
    return {
      crew_dispatch: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return yield* crew.dispatch(
            { prompt: input.prompt, baseRef: input.baseRef, provider: input.provider },
            yield* caller,
          );
        }),

      crew_status: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return {
            tasks: yield* crew.status(
              { unreadOnly: input.unreadOnly, limit: input.limit },
              yield* caller,
            ),
          };
        }),

      crew_teardown: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          yield* crew.teardown({ taskId: input.taskId }, yield* caller);
          return {};
        }),

      crew_answer: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return {
            reportId: yield* crew.answer(
              { reportId: input.reportId, text: input.text },
              yield* caller,
            ),
          };
        }),

      crew_report: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return {
            reportId: yield* crew.report({ state: input.state, note: input.note }, yield* caller),
          };
        }),
    };
  }),
);
