import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import type { QueuedTurn } from "../rpc/commandOutbox";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  createChatEscapeHandler,
  escapeRecallableQueuedCount,
  outboxTimelineMessages,
  recallLatestQueuedMessage,
  serverHeldMessageIds,
  type QueuedRecallOutcome,
} from "./ChatView.logic";

const base = makeThreadProjectionFixture();
const NOW = DateTime.makeUnsafe("2026-09-12T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("claude");

function run(ordinal: number, status: OrchestrationV2Run["status"], userMessageId: string) {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: base.thread.id,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: NOW,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

function message(
  id: string,
  runOrdinal: number,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId: base.thread.id,
    runId: RunId.make(`run-${runOrdinal}`),
    nodeId: null,
    role: "user",
    text: id,
    attachments: [],
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

// A background subagent finished while the root turn runs: the server queues an automatic
// delegated-completion delivery behind it. The queue strip does not list it.
const automaticDelivery = {
  runs: [run(1, "running", "user-1"), run(2, "queued", "auto-delivery")],
  messages: [
    message("user-1", 1),
    message("auto-delivery", 2, {
      createdBy: "agent",
      creationSource: "server",
      delegatedCompletion: { parentRunId: RunId.make("run-1"), generation: 1, taskIds: [] },
    } as Partial<OrchestrationV2ConversationMessage>),
  ],
};

function escapeEvent() {
  return {
    key: "Escape",
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    preventDefault: vi.fn(),
  };
}

function handler(input: { queued: number; running: boolean; recall: () => QueuedRecallOutcome }) {
  const stop = vi.fn();
  const press = createChatEscapeHandler({
    isChatSurfaceActive: () => true,
    hasRunningTurn: input.running,
    hasPendingQuestion: false,
    queuedMessageCount: input.queued,
    recallQueuedMessage: input.recall,
    stop,
  });
  return { press, stop };
}

describe("Escape over the server queue", () => {
  it("counts only messages the user queued, not automatic deliveries", () => {
    expect(escapeRecallableQueuedCount(automaticDelivery)).toBe(0);
    expect(
      escapeRecallableQueuedCount({
        ...automaticDelivery,
        runs: [...automaticDelivery.runs, run(3, "queued", "user-3")],
        messages: [...automaticDelivery.messages, message("user-3", 3)],
      }),
    ).toBe(1);
  });

  // Running turn throughout. Only "nothing to recall" may reach Stop.
  it.each([
    { queued: 1, outcome: "opened", stops: false, prevents: true },
    { queued: 1, outcome: "editOpen", stops: false, prevents: true },
    { queued: 1, outcome: "busy", stops: false, prevents: false },
    { queued: 1, outcome: "nothing", stops: true, prevents: true },
    { queued: 0, outcome: "nothing", stops: true, prevents: true },
  ] as const)(
    "queued $queued, recall $outcome: stops=$stops",
    ({ queued, outcome, stops, prevents }) => {
      const recall = vi.fn((): QueuedRecallOutcome => outcome);
      const { press, stop } = handler({ queued, running: true, recall });
      const event = escapeEvent();
      press(event);
      expect(stop).toHaveBeenCalledTimes(stops ? 1 : 0);
      expect(event.preventDefault).toHaveBeenCalledTimes(prevents ? 1 : 0);
      expect(recall).toHaveBeenCalledTimes(queued > 0 ? 1 : 0);
    },
  );

  it("stops a running turn when only an automatic delivery is queued", () => {
    const recall = vi.fn((): QueuedRecallOutcome => "nothing");
    const { press, stop } = handler({
      queued: escapeRecallableQueuedCount(automaticDelivery),
      running: true,
      recall,
    });
    press(escapeEvent());
    expect(recall).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves an idle thread alone when there is nothing to recall", () => {
    const { press, stop } = handler({ queued: 1, running: false, recall: () => "nothing" });
    const event = escapeEvent();
    press(event);
    expect(stop).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("recallLatestQueuedMessage", () => {
  it("cancels an open edit through the strip's own cancel path and opens nothing", () => {
    const cancelEdit = vi.fn();
    const editLatest = vi.fn(() => true);
    expect(
      recallLatestQueuedMessage({ editOpen: true, queuedMessageCount: 2, cancelEdit, editLatest }),
    ).toBe("editOpen");
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(editLatest).not.toHaveBeenCalled();
  });

  it("opens the newest queued message, or reports the strip busy when it declines", () => {
    const cancelEdit = vi.fn();
    expect(
      recallLatestQueuedMessage({
        editOpen: false,
        queuedMessageCount: 1,
        cancelEdit,
        editLatest: () => true,
      }),
    ).toBe("opened");
    expect(
      recallLatestQueuedMessage({
        editOpen: false,
        queuedMessageCount: 1,
        cancelEdit,
        editLatest: () => false,
      }),
    ).toBe("busy");
    expect(cancelEdit).not.toHaveBeenCalled();
  });

  it("reports nothing when the user has nothing queued", () => {
    const editLatest = vi.fn(() => true);
    expect(
      recallLatestQueuedMessage({
        editOpen: false,
        queuedMessageCount: 0,
        cancelEdit: () => {},
        editLatest,
      }),
    ).toBe("nothing");
    expect(editLatest).not.toHaveBeenCalled();
  });
});

describe("outbox bubbles", () => {
  const threadId = ThreadId.make("thread-test");
  const queued: QueuedTurn = {
    environmentId: EnvironmentId.make("env-1"),
    threadId,
    messageId: MessageId.make("m-outbox"),
    commandId: CommandId.make("c-outbox"),
    enqueuedAt: "2026-09-12T12:00:00.000Z",
    input: {
      threadId,
      commandId: CommandId.make("c-outbox"),
      message: {
        messageId: MessageId.make("m-outbox"),
        role: "user",
        text: "queued offline",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "queue",
    },
  };

  it("shows a turn the server does not hold yet as a pending bubble", () => {
    const bubbles = outboxTimelineMessages({
      threadId,
      queue: [queued],
      delivered: [],
      serverMessageIds: serverHeldMessageIds({ runs: [], messages: [] }, []),
    });
    expect(bubbles.map((bubble) => bubble.id)).toEqual(["m-outbox"]);
  });

  it("drops the bubble once the server queued the message behind a running turn", () => {
    // Queued server-side: a run and a message row, but no turn item. The queue strip lists it.
    const serverIds = serverHeldMessageIds(
      { runs: [run(2, "queued", "m-outbox")], messages: [] },
      [],
    );
    expect(
      outboxTimelineMessages({
        threadId,
        queue: [],
        delivered: [
          { threadId, messageId: MessageId.make("m-outbox"), text: "x", enqueuedAt: "t" },
        ],
        serverMessageIds: serverIds,
      }),
    ).toEqual([]);
    expect(
      outboxTimelineMessages({
        threadId,
        queue: [queued],
        delivered: [],
        serverMessageIds: serverHeldMessageIds(
          { runs: [], messages: [message("m-outbox", 2)] },
          [],
        ),
      }),
    ).toEqual([]);
  });
});
