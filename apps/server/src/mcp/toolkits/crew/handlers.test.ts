import {
  CrewReportId,
  CrewTaskId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CrewService } from "../../../crew/CrewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CrewToolkitLayer } from "./handlers.ts";
import { CrewToolkit } from "./tools.ts";

const CALLER = ThreadId.make("bridge-from-credential");

describe("crew toolkit handlers", () => {
  it.effect("every tool acts as the credential's thread, never one from the input", () =>
    Effect.gen(function* () {
      const callers: Array<string> = [];
      const record = (callerThreadId: ThreadId) =>
        Effect.sync(() => void callers.push(callerThreadId));
      const crew = Layer.mock(CrewService)({
        dispatch: (_input, caller) =>
          record(caller).pipe(
            Effect.as({
              taskId: CrewTaskId.make("task-1"),
              crewThreadId: ThreadId.make("crew-1"),
              branch: "crew/task-1",
              worktreePath: "/tmp/crew/task-1",
            }),
          ),
        status: (_input, caller) => record(caller).pipe(Effect.as([])),
        teardown: (_input, caller) => record(caller),
        report: (_input, caller) => record(caller).pipe(Effect.as(CrewReportId.make("r-1"))),
        answer: (_input, caller) => record(caller).pipe(Effect.as(CrewReportId.make("a-1"))),
      });
      const toolkit = yield* CrewToolkit.pipe(Effect.provide(CrewToolkitLayer));
      const call = (name: keyof typeof CrewToolkit.tools, params: unknown) =>
        toolkit.handle(name, params as never).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: CALLER,
            providerSessionId: "provider-session-1",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            capabilities: new Set<McpInvocationContext.McpCapability>(),
            issuedAt: 1,
          }),
          Effect.provide(crew),
        );

      // An extra `threadId` in the input is not part of any schema; it must not leak in.
      yield* call("crew_dispatch", { prompt: "go", threadId: "forged" });
      yield* call("crew_status", {});
      yield* call("crew_teardown", { taskId: "task-1" });
      yield* call("crew_report", { state: "done", note: "ok" });
      yield* call("crew_answer", { reportId: "r-1", text: "yes" });
      assert.deepStrictEqual(callers, [CALLER, CALLER, CALLER, CALLER, CALLER]);
    }),
  );
});
