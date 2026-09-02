/**
 * Handlers for the crew toolkit: unwrap the tool input, call `CrewService`.
 *
 * @module mcp/toolkits/crew/handlers
 */
import * as Effect from "effect/Effect";

import { CrewService } from "../../../crew/CrewService.ts";
import { CrewToolkit } from "./tools.ts";

export const CrewToolkitLayer = CrewToolkit.toLayer(
  Effect.sync(() => {
    return {
      crew_dispatch: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return yield* crew.dispatch({
            prompt: input.prompt,
            baseRef: input.baseRef,
            provider: input.provider,
          });
        }),

      crew_status: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return {
            tasks: yield* crew.status({ unreadOnly: input.unreadOnly, limit: input.limit }),
          };
        }),

      crew_teardown: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          yield* crew.teardown({ taskId: input.taskId });
          return {};
        }),

      crew_answer: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return { reportId: yield* crew.answer({ reportId: input.reportId, text: input.text }) };
        }),

      crew_report: (input) =>
        Effect.gen(function* () {
          const crew = yield* CrewService;
          return { reportId: yield* crew.report({ state: input.state, note: input.note }) };
        }),
    };
  }),
);
