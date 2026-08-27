import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-withdraw");
const THREAD_ID = ThreadId.make("thread-withdraw");

let sequence = 0;
const nextSequence = () => {
  sequence += 1;
  return sequence;
};

const seedReadModel = (messages: ReadonlyArray<{ id: string; role: "user" | "assistant" }>) =>
  Effect.gen(function* () {
    sequence = 0;
    let model: OrchestrationReadModel = createEmptyReadModel(NOW);
    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: EventId.make("evt-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-project"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Withdraw Project",
        workspaceRoot: "/tmp/withdraw",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: EventId.make("evt-thread"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-thread"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "auto-accept-edits",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    for (const message of messages) {
      model = yield* projectEvent(model, {
        sequence: nextSequence(),
        eventId: EventId.make(`evt-msg-${message.id}`),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.message-sent",
        occurredAt: NOW,
        commandId: CommandId.make(`cmd-msg-${message.id}`),
        causationEventId: null,
        correlationId: CommandId.make(`cmd-msg-${message.id}`),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.make(message.id),
          role: message.role,
          text: message.id,
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
    }
    return model;
  });

const withdrawCommand = (messageId: string) =>
  ({
    type: "thread.message.withdraw",
    commandId: CommandId.make("cmd-withdraw"),
    threadId: THREAD_ID,
    messageId: MessageId.make(messageId),
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("decider thread.message.withdraw", (it) => {
  it.effect("emits a withdrawn event naming the message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel([{ id: "m1", role: "user" }]);
      const decided = (yield* decideOrchestrationCommand({
        command: withdrawCommand("m1"),
        readModel,
      })) as Extract<OrchestrationEvent, { type: "thread.message-withdrawn" }>;

      expect(decided.type).toBe("thread.message-withdrawn");
      expect(decided.payload.threadId).toBe(THREAD_ID);
      expect(decided.payload.messageId).toBe("m1");
      expect(decided.payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("emits nothing for a message that is already gone", () =>
    Effect.gen(function* () {
      // The withdraw RPC releases the adapter's queued turn before dispatching
      // this, so a retry after a partial failure must land as a no-op rather
      // than report the whole recall as rejected.
      const readModel = yield* seedReadModel([{ id: "m1", role: "user" }]);
      const decided = yield* decideOrchestrationCommand({
        command: withdrawCommand("m-absent"),
        readModel,
      });

      expect(decided).toEqual([]);
    }),
  );

  it.effect("refuses to withdraw an assistant message", () =>
    Effect.gen(function* () {
      // Withdrawing one would delete the agent's own reply out of the
      // transcript, which no queue state can justify.
      const readModel = yield* seedReadModel([{ id: "m1", role: "assistant" }]);
      const error = yield* decideOrchestrationCommand({
        command: withdrawCommand("m1"),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
